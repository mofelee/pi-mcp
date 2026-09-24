import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PASSWORD = "embedded # password = 测试";

// 子进程输出只保留有界内存，不生成测试日志文件。
async function capture(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) output = (output + decoder.decode(chunk, { stream: true })).slice(-256 * 1024);
  return output + decoder.decode();
}

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function build(outdir: string, env: Record<string, string>, args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(ROOT, "scripts/build.ts"), `--outdir=${outdir}`, ...args], {
    cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, capture(child.stdout), capture(child.stderr)]);
    if (code !== 0) throw new Error(`构建失败 (${code}): ${stdout}\n${stderr}`);
    expect(stdout + stderr).not.toContain(PASSWORD);
  } finally {
    clearTimeout(deadline);
  }
}

async function startServer(binary: string, cwd: string, port: number, env: Record<string, string>) {
  const child = Bun.spawn([binary, "--no-tui"], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = capture(child.stdout), stderr = capture(child.stderr);
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    return (await stdout) + (await stderr);
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(200) });
        if (response.ok) { await response.text(); return { url, stop }; }
      } catch { /* 等待本地服务启动 */ }
      await Bun.sleep(50);
    }
    throw new Error("编译产物没有在预期端口启动");
  } catch (error) {
    throw new Error(`${error}\n${await stop()}`);
  }
}

async function login(url: string, password: string): Promise<Response> {
  return fetch(`${url}/login`, {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ password, next: "/" }),
  });
}

interface Authorization {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  cookie: string;
}

async function authorize(url: string, issuer: string, password: string): Promise<Authorization> {
  const loggedIn = await login(url, password);
  expect(loggedIn.status).toBe(302);
  const cookie = loggedIn.headers.get("set-cookie")!.split(";")[0]!;
  await loggedIn.text();
  const redirectUri = "http://localhost:9999/callback";
  const registration = await fetch(`${url}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "portable-test", token_endpoint_auth_method: "none" }),
  });
  expect(registration.status).toBe(201);
  const { client_id } = await registration.json() as { client_id: string };
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const resource = `${issuer}/mcp`;
  const params = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirectUri, state: "portable-test",
    scope: "mcp", code_challenge: challenge, code_challenge_method: "S256", resource });
  const authorization = await fetch(`${url}/oauth/authorize?${params}`, { redirect: "manual", headers: { cookie } });
  expect(authorization.status).toBe(302);
  const code = new URL(authorization.headers.get("location")!).searchParams.get("code")!;
  await authorization.text();
  const response = await fetch(`${url}/oauth/token`, { method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: redirectUri, code_verifier: verifier, resource }) });
  expect(response.status).toBe(200);
  const tokens = await response.json() as { access_token: string; refresh_token: string };
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId: client_id, cookie };
}

async function authenticate(url: string, issuer: string, password: string): Promise<string> {
  return (await authorize(url, issuer, password)).accessToken;
}

interface ToolResult {
  isError?: boolean;
  structuredContent: Record<string, unknown>;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}
async function callTool(url: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const response = await fetch(`${url}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const payload = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
  const result = (JSON.parse(payload) as { result: ToolResult }).result;
  expect(result.isError).not.toBe(true);
  return result;
}

test("编译产物在其它目录使用内嵌配置，且 cwd / 本地配置 / shell 覆盖保持独立", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-mcp-build-test-")));
  const outdir = join(dir, "release with spaces");
  const binary = join(outdir, process.platform === "win32" ? "pi-mcp.exe" : "pi-mcp");
  const home = join(dir, "home");
  // 不继承真实密码、PI_PACKAGE_DIR、PI_MCP_CWD 或用户 Pi 配置。
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, SHELL: process.env.SHELL ?? "/bin/sh",
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), NO_COLOR: "1" };
  const port = freePort();
  const issuer = `http://localhost:${port}`;
  try {
    await mkdir(home, { recursive: true });
    const sourceEnv = join(dir, "build.env");
    await writeFile(sourceEnv, `BASE_URL=${issuer}\nPORT=${port}\nLOGIN_PASSWORD='${PASSWORD}'\nLOG_UI=plain\nLOG_LEVEL=error\nLOG_REQUESTS=0\nOAUTH_AUTO_APPROVE=1\n`);
    await build(outdir, env, [`--embed-env=${sourceEnv}`]);
    expect(existsSync(join(outdir, ".env"))).toBe(false);
    // 删掉构建时的配置文件，证明运行时不再访问原路径。
    await rm(sourceEnv);

    // A 项目只授权一次；B 项目必须复用原 token、cookie 和客户端，不能重新注册掩盖问题。
    let sharedAuthorization: Authorization | undefined;
    let originalJwk: string | undefined;
    const stateDir = join(home, ".pi-mcp");
    for (const name of ["workspace-a", "workspace-b"]) {
      const cwd = join(dir, name);
      await mkdir(join(cwd, ".pi", "skills", "workspace-skill"), { recursive: true });
      await writeFile(join(cwd, "note.txt"), name);
      await writeFile(join(cwd, "AGENTS.md"), `Project context: ${name}`);
      await writeFile(join(cwd, ".pi", "skills", "workspace-skill", "SKILL.md"), `---\nname: workspace-skill\ndescription: ${name} test skill\n---\nTest only.\n`);
      await cp(join(outdir, "pi-runtime/docs/images/interactive-mode.png"), join(cwd, "image.png"));
      const server = await startServer(binary, cwd, port, env);
      try {
        const metadata = await fetch(`${server.url}/.well-known/oauth-authorization-server`).then((r) => r.json()) as { issuer: string };
        expect(metadata.issuer).toBe(issuer);
        if (!sharedAuthorization) {
          // health / 启动本身不生成签名密钥；首次实际认证时才创建。
          expect(existsSync(join(stateDir, ".oauth-jwk.json"))).toBe(false);
          sharedAuthorization = await authorize(server.url, issuer, PASSWORD);
          originalJwk = await readFile(join(stateDir, ".oauth-jwk.json"), "utf8");
        } else {
          const resumed = await fetch(`${server.url}/oauth/token`, { method: "POST",
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: sharedAuthorization.refreshToken,
              client_id: sharedAuthorization.clientId, resource: `${issuer}/mcp` }) });
          expect(resumed.status).toBe(200);
          expect((await resumed.json() as { access_token?: string }).access_token).toBeString();
          const query = new URLSearchParams({ response_type: "code", client_id: sharedAuthorization.clientId,
            redirect_uri: "http://localhost:9999/callback", scope: "mcp", resource: `${issuer}/mcp`,
            state: "reuse-cookie", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
          const session = await fetch(`${server.url}/oauth/authorize?${query}`, {
            redirect: "manual", headers: { cookie: sharedAuthorization.cookie } });
          expect(session.status).toBe(302);
          expect(new URL(session.headers.get("location")!).searchParams.has("code")).toBe(true);
          await session.text();
          expect(await readFile(join(stateDir, ".oauth-jwk.json"), "utf8")).toBe(originalJwk!);
        }
        const token = sharedAuthorization.accessToken;
        const prompt = (await callTool(server.url, token, "pi_initial_prompt")).structuredContent;
        expect((prompt.environment as { cwd: string }).cwd).toBe(cwd);
        expect(prompt.prompt).toContain(`Project context: ${name}`);
        expect(prompt.prompt).toContain(join(outdir, "pi-runtime", "docs"));
        expect((prompt.skills as Array<{ name: string }>).some((skill) => skill.name === "workspace-skill")).toBe(true);
        expect((await callTool(server.url, token, "read", { path: "note.txt" })).structuredContent.output).toBe(name);
        expect(String((await callTool(server.url, token, "bash", { command: "pwd -P" })).structuredContent.output).trim()).toBe(cwd);
        await callTool(server.url, token, "write", { path: "written.txt", content: name });
        expect(await readFile(join(cwd, "written.txt"), "utf8")).toBe(name);
        const image = await callTool(server.url, token, "read", { path: "image.png" });
        expect(image.content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
        expect(existsSync(join(cwd, ".oauth-jwk.json"))).toBe(false);
        expect(existsSync(join(cwd, ".oauth-store.json"))).toBe(false);
        expect(existsSync(join(stateDir, ".oauth-store.json"))).toBe(true);
        expect(existsSync(join(outdir, ".oauth-jwk.json"))).toBe(false);
        expect(existsSync(join(outdir, ".oauth-store.json"))).toBe(false);
      } finally { await server.stop(); }
    }

    const localCwd = join(dir, "local-config");
    await mkdir(localCwd);
    const localPort = freePort();
    const localIssuer = `http://localhost:${localPort}`;
    await writeFile(join(localCwd, ".env"), `PORT=${localPort}\nBASE_URL=${localIssuer}\nLOGIN_PASSWORD=Local-Config-Pass-9x\n`);
    const local = await startServer(binary, localCwd, localPort, env);
    try {
      const metadata = await fetch(`${local.url}/.well-known/oauth-authorization-server`).then((r) => r.json()) as { issuer: string };
      expect(metadata.issuer).toBe(localIssuer);
      const accepted = await login(local.url, "Local-Config-Pass-9x");
      expect(accepted.status).toBe(302); await accepted.text();
      const rejected = await login(local.url, PASSWORD);
      expect(rejected.status).toBe(401); await rejected.text();
    } finally { await local.stop(); }

    const shellPort = freePort();
    const shellIssuer = `http://localhost:${shellPort}`;
    const overrideCwd = join(dir, "workspace-a");
    const shell = await startServer(binary, localCwd, shellPort, { ...env,
      PORT: String(shellPort), BASE_URL: shellIssuer, LOGIN_PASSWORD: "Shell-Override-Pass-9x", PI_MCP_CWD: overrideCwd });
    try {
      const token = await authenticate(shell.url, shellIssuer, "Shell-Override-Pass-9x");
      const prompt = (await callTool(shell.url, token, "pi_initial_prompt")).structuredContent;
      expect((prompt.environment as { cwd: string }).cwd).toBe(overrideCwd);
      expect((await callTool(shell.url, token, "read", { path: "note.txt" })).structuredContent.output).toBe("workspace-a");
    } finally { await shell.stop(); }

    // 通过符号链接启动仍应从真实可执行文件旁定位 Pi 资源。
    if (process.platform !== "win32") {
      const link = join(dir, "pi-mcp-link");
      await symlink(binary, link);
      const linked = await startServer(link, join(dir, "workspace-b"), port, env);
      try {
        const token = sharedAuthorization!.accessToken;
        const prompt = (await callTool(linked.url, token, "pi_initial_prompt")).structuredContent;
        expect(prompt.prompt).toContain(join(outdir, "pi-runtime", "docs"));
      } finally { await linked.stop(); }
    }

    // 不内嵌模式保留部署状态，tar 不包含已有明文 .env / OAuth 状态。
    await writeFile(join(outdir, ".env"), "LOGIN_PASSWORD=deployment-only\n");
    await writeFile(join(outdir, ".oauth-store.json"), "test-state");
    await build(outdir, env, ["--no-embed-env", "--tar"]);
    expect(await readFile(join(outdir, ".env"), "utf8")).toBe("LOGIN_PASSWORD=deployment-only\n");
    expect(await readFile(join(outdir, ".oauth-store.json"), "utf8")).toBe("test-state");
    const archive = join(outdir, `pi-mcp-${process.platform}-${process.arch}.tar.gz`);
    const listing = Bun.spawnSync(["tar", "-tzf", archive]);
    expect(listing.exitCode).toBe(0);
    const entries = listing.stdout.toString().split("\n");
    expect(entries).not.toContain(".env");
    expect(entries).not.toContain(".oauth-store.json");
    // 不内嵌模式 + 无 LOGIN_PASSWORD → 内置弱密码，必须拒绝启动。
    const refused = Bun.spawn([binary, "--no-tui"], { cwd: join(dir, "workspace-b"),
      env: { ...env, PORT: String(port), LOG_LEVEL: "error" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const refusedOut = await Promise.all([capture(refused.stdout), capture(refused.stderr)]);
    expect(await refused.exited).not.toBe(0);
    expect(refusedOut.join("\n")).toContain("弱密码");

    // 仅当显式放行弱密码时，内置默认密码才可登录（本地开发场景）。
    const plain = await startServer(binary, join(dir, "workspace-b"), port,
      { ...env, PORT: String(port), LOG_LEVEL: "error", PI_MCP_ALLOW_WEAK_PASSWORD: "1" });
    try {
      const accepted = await login(plain.url, "pi-mcp");
      expect(accepted.status).toBe(302); await accepted.text();
      const rejected = await login(plain.url, PASSWORD);
      expect(rejected.status).toBe(401); await rejected.text();
    } finally { await plain.stop(); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
