// 端到端自测：注册 -> 授权 -> 换 token -> 调用 MCP。
//
// 用法（先启动服务）：
//   OAUTH_AUTO_APPROVE=1 bun run index.ts
//   bun run scripts/oauth-flow-test.ts
//
// 可通过 BASE 环境变量覆盖被测地址（默认 http://localhost:3000）。

import { RESOURCE } from "../src/config";

const BASE = process.env.BASE ?? "http://localhost:3000";
const REDIRECT_URI = "http://localhost:9999/callback";
// 不再内置弱密码默认值；必须与服务端 LOGIN_PASSWORD 一致。
const PASSWORD = process.env.LOGIN_PASSWORD?.trim() ?? "";
if (!PASSWORD) {
  console.error("oauth-flow-test：请用 LOGIN_PASSWORD 指定与服务端一致的登录密码。");
  process.exit(1);
}

function b64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`, detail ?? "");
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  // 1. 未认证访问 /mcp 应返回 401 + WWW-Authenticate
  // 1. 匿名访问：ChatGPT 必须先能匿名 initialize / tools/list，
  //    才能看到 securitySchemes 并触发授权 UI。
  console.log("1) 匿名访问 /mcp");
  const mcpCall = async (payload: unknown, token?: string, path = "/mcp"): Promise<{ status: number; text: string; headers: Headers }> => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };

  const anonList = await mcpCall({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  ok("匿名 tools/list 返回 200", anonList.status === 200, anonList.status);
  ok("tools 声明 securitySchemes", anonList.text.includes("securitySchemes"), anonList.text.slice(0, 200));
  ok("oauth2 scheme 带 scopes", /"oauth2","scopes":\["mcp"\]/.test(anonList.text.replace(/\s/g, "")) || anonList.text.includes("\"oauth2\""));
  ok(
    "匿名 tools/list 已包含 pi 工具",
    anonList.text.includes("pi_initial_prompt") && anonList.text.includes("\"name\":\"bash\""),
    anonList.text.slice(0, 200),
  );
  ok("whoami 作为 OpenAI profile tool 暴露", anonList.text.includes("openai/profile"));
  ok("不再暴露 echo", !anonList.text.includes("\"echo\""));

  const anonCall = await mcpCall({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pi_initial_prompt", arguments: {} } });
  ok("匿名 tools/call 返回 200（结果内报错）", anonCall.status === 200, anonCall.status);
  ok("携带 mcp/www_authenticate", anonCall.text.includes("mcp/www_authenticate"), anonCall.text.slice(0, 300));
  ok("challenge 含 resource_metadata + error_description",
    anonCall.text.includes("resource_metadata=") && anonCall.text.includes("error_description="), anonCall.text.slice(0, 300));
  ok("结果标记 isError", anonCall.text.includes("\"isError\":true"));

  const badToken = await mcpCall({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, "definitely-not-a-token");
  ok("无效 token 返回 401", badToken.status === 401, badToken.status);
  ok("401 带 WWW-Authenticate resource_metadata",
    (badToken.headers.get("www-authenticate") ?? "").includes("resource_metadata"),
    badToken.headers.get("www-authenticate") ?? "");

  // 连接器 URL 漏写 /mcp 时，ChatGPT 会直接向根路径发 JSON-RPC
  const rootList = await mcpCall({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }, undefined, "/");
  ok("根路径 POST / 也能列工具", rootList.status === 200 && rootList.text.includes("pi_initial_prompt"), `${rootList.status}`);
  const home = await fetch(`${BASE}/`);
  ok("GET / 仍返回首页", (await home.text()).includes("<!doctype html"), home.status);

  // 2. 发现文档
  console.log("2) OAuth 发现文档");
  const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  const prmJson = (await prm.json()) as { resource?: string; authorization_servers?: string[] };
  ok("protected-resource metadata 200", prm.status === 200);
  ok("resource 正确", prmJson.resource === RESOURCE, prmJson.resource);
  ok("authorization_servers 非空", (prmJson.authorization_servers?.length ?? 0) > 0);

  const prmRoot = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  ok("根路径 protected-resource 也可用（无 /mcp 兼容）", prmRoot.status === 200, prmRoot.status);
  await prmRoot.text();

  const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  const asmJson = (await asm.json()) as { issuer?: string; code_challenge_methods_supported?: string[] };
  ok("authorization-server metadata 200", asm.status === 200);
  ok("PKCE S256 已声明", asmJson.code_challenge_methods_supported?.includes("S256") === true);
  const issuer = asmJson.issuer!;

  // 3. 动态客户端注册
  console.log("3) 动态客户端注册");
  const reg = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "flow-test", token_endpoint_auth_method: "none" }),
  });
  const regJson = (await reg.json()) as { client_id?: string };
  ok("注册返回 201", reg.status === 201, reg.status);
  ok("拿到 client_id", Boolean(regJson.client_id));
  const clientId = regJson.client_id!;

  // 3.5 登录（拿 session cookie）
  console.log("3.5) 密码登录");
  const badLogin = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "wrong-password", next: "/" }),
  });
  ok("错误密码被拒绝", badLogin.status === 401, badLogin.status);
  await badLogin.text();

  const login = await fetch(`${BASE}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD, next: "/" }),
  });
  const setCookie = login.headers.get("set-cookie") ?? "";
  ok("正确密码登录成功", login.status === 302, login.status);
  ok("下发 session cookie", setCookie.includes("mcp_session="), setCookie);
  ok("cookie 为 HttpOnly", /HttpOnly/i.test(setCookie));
  await login.text();
  const sessionCookie = setCookie.split(";")[0]!;

  // 4. 授权（PKCE）
  console.log("4) 授权码 + PKCE");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(8)).buffer);

  const authUrl = new URL(`${BASE}/oauth/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "mcp");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", RESOURCE);

  const noLogin = await fetch(authUrl, { redirect: "manual" });
  ok("未登录 authorize 跳转 /login", (noLogin.headers.get("location") ?? "").includes("/login"), noLogin.headers.get("location"));

  const authRes = await fetch(authUrl, { redirect: "manual", headers: { cookie: sessionCookie } });

  // 正常模式下会先返回 consent 页面，需要提交「允许」；AUTO_APPROVE 时直接 302
  let redirectResponse: Response = authRes;
  if (authRes.status === 200) {
    const consentHtml = await authRes.text();
    ok("返回 consent 页面", consentHtml.includes("授权请求"), authRes.status);
    const consentId = consentHtml.match(/name="id" value="([^"]+)"/)?.[1];
    ok("consent 页面含 id 与登录用户", Boolean(consentId) && consentHtml.includes("Demo User"));
    redirectResponse = await fetch(`${BASE}/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie },
      body: new URLSearchParams({ id: consentId!, decision: "allow" }),
    });
  }

  ok("authorize 最终返回 302", redirectResponse.status === 302, redirectResponse.status);
  const location = new URL(redirectResponse.headers.get("location") ?? "");
  ok("回调带 state", location.searchParams.get("state") === state);
  ok("回调带 iss 且与 issuer 一致", location.searchParams.get("iss") === issuer, location.searchParams.get("iss"));
  const code = location.searchParams.get("code");
  ok("回调带 code", Boolean(code));

  // 拒绝授权应带 error=access_denied
  if (authRes.status === 200) {
    const denyAuth = await fetch(authUrl, { redirect: "manual", headers: { cookie: sessionCookie } });
    const denyId = (await denyAuth.text()).match(/name="id" value="([^"]+)"/)?.[1];
    const denied = await fetch(`${BASE}/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie },
      body: new URLSearchParams({ id: denyId!, decision: "deny" }),
    });
    const denyLoc = new URL(denied.headers.get("location") ?? "");
    ok("拒绝授权返回 access_denied", denyLoc.searchParams.get("error") === "access_denied", denyLoc.search);
  }

  // 5. 换 token
  console.log("5) code 换 access_token");
  const tokenRes = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; token_type?: string };
  ok("token 200", tokenRes.status === 200, JSON.stringify(tokenJson));
  ok("token_type=Bearer", tokenJson.token_type === "Bearer");
  const accessToken = tokenJson.access_token!;
  const refreshToken = tokenJson.refresh_token!;
  ok("拿到 access_token", Boolean(accessToken));

  // 6. 用错误的 verifier 应失败
  console.log("6) 错误 PKCE verifier 应被拒绝");
  const bad = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: "wrong-verifier",
      resource: RESOURCE,
    }),
  });
  ok("重放/错误 verifier 被拒绝", bad.status === 400, bad.status);
  await bad.text();

  // 7. MCP 调用
  console.log("7) 调用 MCP（tools/list + tools/call）");
  const callMcp = async (payload: unknown, method = "POST"): Promise<{ status: number; body: string }> => {
    const res = await fetch(`${BASE}/mcp`, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.text() };
  };

  const init = await callMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "flow-test", version: "1.0.0" },
    },
  });
  ok("initialize 成功", init.status === 200, `${init.status} ${init.body.slice(0, 200)}`);

  const list = await callMcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  ok("tools/list 成功", list.status === 200, `${list.status} ${list.body.slice(0, 200)}`);
  ok(
    "包含 pi 经典工具",
    ["pi_initial_prompt", "read", "bash", "edit", "write", "grep"].every((name) => list.body.includes(`"name":"${name}"`)),
    list.body.slice(0, 300),
  );

  // 客户端（例如 ChatGPT）会对缺 outputSchema 的工具提示 “Output schema recommended”
  const toolsPayload = (() => {
    const line = list.body.split("\n").find((l) => l.startsWith("data: "));
    if (!line) return undefined;
    try {
      return JSON.parse(line.slice("data: ".length)) as { result?: { tools?: Array<Record<string, unknown>> } };
    } catch {
      return undefined;
    }
  })();
  const listedTools = toolsPayload?.result?.tools ?? [];
  const withoutOutputSchema = listedTools.filter((tool) => !tool.outputSchema).map((tool) => tool.name);
  ok(
    `所有工具都声明了 outputSchema（共 ${listedTools.length} 个）`,
    listedTools.length > 0 && withoutOutputSchema.length === 0,
    `缺少: ${withoutOutputSchema.join(", ")}`,
  );

  const initialPrompt = await callMcp({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "pi_initial_prompt", arguments: {} },
  });
  ok(
    "pi_initial_prompt 返回环境与 skill 目录",
    initialPrompt.status === 200 &&
      initialPrompt.body.includes("<environment>") &&
      initialPrompt.body.includes("Working directory") &&
      initialPrompt.body.includes("<skills>"),
    `${initialPrompt.status} ${initialPrompt.body.slice(0, 200)}`,
  );

  const readResult = await callMcp({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "read", arguments: { path: "package.json", limit: 3 } },
  });
  ok(
    "tools/call read 成功",
    readResult.status === 200 && readResult.body.includes("pi-mcp"),
    `${readResult.status} ${readResult.body.slice(0, 200)}`,
  );
  ok(
    "read 返回符合 outputSchema 的 structuredContent",
    readResult.body.includes("\"structuredContent\":{\"output\""),
    readResult.body.slice(0, 300),
  );

  const badRead = await callMcp({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "read", arguments: { path: "definitely-missing-file.txt" } },
  });
  ok(
    "read 失败时仍返回 structuredContent",
    badRead.status === 200 && badRead.body.includes("\"isError\":true") && badRead.body.includes("\"structuredContent\":{\"output\""),
    `${badRead.status} ${badRead.body.slice(0, 300)}`,
  );

  // 已授权调用的冒烟测试：bash 与 grep
  const bashCall = await callMcp({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "bash", arguments: { command: "echo hello oauth" } },
  });
  ok(
    "tools/call bash 成功",
    bashCall.status === 200 && bashCall.body.includes("hello oauth"),
    `${bashCall.status} ${bashCall.body.slice(0, 200)}`,
  );

  const grepCall = await callMcp({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "pi-mcp", path: "package.json" } },
  });
  ok(
    "tools/call grep 成功",
    grepCall.status === 200 && grepCall.body.includes("pi-mcp"),
    `${grepCall.status} ${grepCall.body.slice(0, 200)}`,
  );

  const whoami = await callMcp({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "whoami", arguments: {} },
  });
  ok(
    "tools/call whoami 成功（返回稳定 profile id）",
    whoami.status === 200 && whoami.body.includes("user_123"),
    `${whoami.status} ${whoami.body.slice(0, 200)}`,
  );

  // 8. refresh token
  console.log("8) refresh_token 换新 access_token");
  const refresh = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  });
  const refreshJson = (await refresh.json()) as { access_token?: string };
  ok("refresh 成功", refresh.status === 200 && Boolean(refreshJson.access_token), JSON.stringify(refreshJson));

  console.log(process.exitCode ? "\n存在失败用例" : "\n全部通过 ✅");
}

await main();
