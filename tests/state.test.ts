import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureStateParent, resolveStatePaths } from "../src/state-paths";

const ROOT = resolve(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-state-test-")));
  dirs.push(dir);
  const home = join(dir, "home"), a = join(dir, "workspace-a"), b = join(dir, "workspace-b");
  for (const path of [home, a, b]) mkdirSync(path);
  return { dir, home, a, b };
}

// 显式隔离 HOME / USERPROFILE / 环境变量；不访问真实 OAuth 凭据或项目 dotenv。
function run(home: string, cwd: string, code: string, env: Record<string, string> = {}): Record<string, any> {
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code], {
    cwd, env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, NO_COLOR: "1", ...env },
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  if (child.exitCode !== 0) throw new Error(`状态测试子进程失败：${child.stderr.toString().slice(-16_384)}`);
  return JSON.parse(child.stdout.toString());
}
const imports = `
  import { getSigningKey } from ${JSON.stringify(join(ROOT, "src/keys.ts"))};
  import { getClient, saveClient, getRefreshToken, saveRefreshToken } from ${JSON.stringify(join(ROOT, "src/store.ts"))};
  import { JWK_FILE, STORE_FILE } from ${JSON.stringify(join(ROOT, "src/config.ts"))};
`;

describe("用户级 OAuth 状态路径", () => {
  test("默认路径只与运行用户有关，不随 cwd 或 PI_MCP_CWD 改变", () => {
    const { home, a, b } = fixture();
    const expected = { dir: join(home, ".pi-mcp"), jwkFile: join(home, ".pi-mcp/.oauth-jwk.json"), storeFile: join(home, ".pi-mcp/.oauth-store.json") };
    expect(resolveStatePaths({}, a, home)).toEqual(expected);
    expect(resolveStatePaths({ PI_MCP_CWD: a }, b, home)).toEqual(expected);
    expect(existsSync(expected.dir)).toBe(false);
  });

  test("支持状态目录、文件级覆盖和 ~，显式相对文件路径仍相对启动目录", () => {
    const { home, a } = fixture();
    expect(resolveStatePaths({ PI_MCP_STATE_DIR: "~/shared" }, a, home)).toEqual({
      dir: join(home, "shared"), jwkFile: join(home, "shared/.oauth-jwk.json"), storeFile: join(home, "shared/.oauth-store.json"),
    });
    expect(resolveStatePaths({ PI_MCP_STATE_DIR: "~/shared", OAUTH_JWK_FILE: "~/keys/jwk.json", OAUTH_STORE_FILE: "local/store.json" }, a, home)).toEqual({
      dir: join(home, "shared"), jwkFile: join(home, "keys/jwk.json"), storeFile: join(a, "local/store.json"),
    });
    expect(resolveStatePaths({ PI_MCP_STATE_DIR: " ", OAUTH_JWK_FILE: "", OAUTH_STORE_FILE: "  " }, a, home)).toEqual(resolveStatePaths({}, a, home));
  });

  test("需要写入时才建父目录，新建目录限制权限且不生成项目文件", () => {
    const { home, a } = fixture();
    const file = join(home, ".pi-mcp/nested/.oauth-jwk.json");
    ensureStateParent(file);
    expect(existsSync(join(home, ".pi-mcp/nested"))).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(a, ".oauth-jwk.json"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(join(home, ".pi-mcp")).mode & 0o077).toBe(0);
  });
});

describe("真实子进程共享和隔离", () => {
  test("换项目复用密钥、客户端和 refresh token；不自动导入另一项目的旧状态", () => {
    const { home, a, b } = fixture();
    const first = run(home, a, `${imports}
      const key = await getSigningKey();
      saveClient({ clientId: 'shared-client', redirectUris: ['http://localhost/cb'], createdAt: Date.now() });
      saveRefreshToken({ token: 'fake-refresh', clientId: 'shared-client', userId: 'test-user', scope: 'mcp', resource: 'https://test.invalid/mcp', expiresAt: Math.floor(Date.now()/1000)+3600 });
      console.log(JSON.stringify({ kid: key.kid, jwk: JWK_FILE, store: STORE_FILE }));
    `);
    const keyBefore = readFileSync(first.jwk, "utf8");
    // 旧项目遗留文件不能暗中覆盖用户级身份。
    for (const name of [".oauth-jwk.json", ".oauth-store.json"]) writeFileSync(join(b, name), "legacy-project-state");
    const second = run(home, b, `${imports}
      const key = await getSigningKey();
      console.log(JSON.stringify({ kid: key.kid, client: getClient('shared-client')?.clientId,
        refresh: getRefreshToken('fake-refresh')?.clientId, cwd: process.cwd() }));
    `);
    expect(second).toEqual({ kid: first.kid, client: "shared-client", refresh: "shared-client", cwd: b });
    expect(readFileSync(first.jwk, "utf8")).toBe(keyBefore);
    expect(first.jwk).toBe(join(home, ".pi-mcp/.oauth-jwk.json"));
    expect(first.store).toBe(join(home, ".pi-mcp/.oauth-store.json"));
    for (const name of [".oauth-jwk.json", ".oauth-store.json"]) {
      expect(existsSync(join(a, name))).toBe(false);
      expect(readFileSync(join(b, name), "utf8")).toBe("legacy-project-state");
      if (process.platform !== "win32") expect(statSync(join(home, ".pi-mcp", name)).mode & 0o077).toBe(0);
    }
  });

  test("显式路径仍生效，并自动创建各自的父目录", () => {
    const { home, a } = fixture();
    const result = run(home, a, `${imports}
      await getSigningKey();
      saveClient({ clientId: 'override', redirectUris: [], createdAt: Date.now() });
      console.log(JSON.stringify({ jwk: JWK_FILE, store: STORE_FILE }));
    `, { PI_MCP_STATE_DIR: "~/unused", OAUTH_JWK_FILE: "~/custom/keys/jwk.json", OAUTH_STORE_FILE: "./custom/state/store.json" });
    expect(result).toEqual({ jwk: join(home, "custom/keys/jwk.json"), store: join(a, "custom/state/store.json") });
    expect(existsSync(result.jwk)).toBe(true);
    expect(existsSync(result.store)).toBe(true);
    expect(existsSync(join(home, ".pi-mcp"))).toBe(false);
    expect(existsSync(join(home, "unused"))).toBe(false);
  });

  test("同一用户可用 PI_MCP_STATE_DIR 隔离独立服务", () => {
    const { home, a } = fixture();
    const code = `${imports} console.log(JSON.stringify({ kid: (await getSigningKey()).kid, jwk: JWK_FILE }));`;
    const first = run(home, a, code, { PI_MCP_STATE_DIR: "~/service-a" });
    const second = run(home, a, code, { PI_MCP_STATE_DIR: "~/service-b" });
    expect(first.kid).not.toBe(second.kid);
    expect(first.jwk).toBe(join(home, "service-a/.oauth-jwk.json"));
    expect(second.jwk).toBe(join(home, "service-b/.oauth-jwk.json"));
    expect(existsSync(join(home, ".pi-mcp"))).toBe(false);
  });

  test("OAUTH_JWK 仍优先于文件，不额外写出环境变量中的私钥", () => {
    const { home, a } = fixture();
    const first = run(home, a, `${imports} console.log(JSON.stringify({ kid: (await getSigningKey()).kid, jwk: JWK_FILE }));`);
    const jwk = readFileSync(first.jwk, "utf8");
    const result = run(home, a, `${imports} console.log(JSON.stringify({ kid: (await getSigningKey()).kid }));`, {
      OAUTH_JWK: jwk, PI_MCP_STATE_DIR: "~/env-only",
    });
    expect(result.kid).toBe(first.kid);
    expect(existsSync(join(home, "env-only"))).toBe(false);
  });
});
