// Bun 入口：把 OAuth 端点、发现文档和 MCP handler 串成一个 fetch 服务。
//
// 路由总览：
//   GET  /.well-known/oauth-protected-resource/mcp   RFC 9728 受保护资源元数据
//   GET  /.well-known/oauth-authorization-server     RFC 8414 授权服务器元数据
//   GET  /oauth/authorize                            授权（PKCE）
//   POST /oauth/consent                              consent 提交
//   POST /oauth/token                                code / refresh_token 换 token
//   POST /oauth/register                             DCR
//   POST /oauth/revoke                               撤销
//   POST /mcp                                        受 bearer 保护的 MCP 端点

import {
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  verifyBearerToken,
  type AuthInfo,
  type AuthMetadataOptions,
} from "@modelcontextprotocol/server";
import {
  ALLOW_INSECURE_ISSUER,
  ALLOW_WEAK_PASSWORD,
  ALLOW_INSECURE_BASE_URL,
  BASE_URL,
  BASE_URL_IS_LOOPBACK,
  BASE_URL_PROBLEM,
  ISSUER,
  LOGIN_PASSWORD,
  MCP_PATH,
  MCP_PATHS,
  PASSWORD_IS_WEAK,
  PASSWORD_WEAKNESSES,
  PORT,
  RESOURCE,
  SCOPES,
  USING_DEFAULT_PASSWORD,
} from "./config";
import { strongPasswordHint } from "./password-policy";
import { handleLoginGet, handleLoginPost, handleLogout } from "./login";
import { getPublicJwks } from "./keys";
import { clientIp, log, logRequest, summarizeMcpBody } from "./log";
import { mcpHandler } from "./mcp";
import {
  authorizationServerMetadata,
  handleAuthorize,
  handleConsent,
  handleRegister,
  handleRevoke,
  handleToken,
  json,
  openIdProviderMetadata,
} from "./oauth";
import { verifier } from "./verifier";

const resourceServerUrl = new URL(RESOURCE);

const authMetadataOptions: AuthMetadataOptions = {
  oauthMetadata: authorizationServerMetadata(),
  resourceServerUrl,
  scopesSupported: [...SCOPES],
  resourceName: "pi-mcp",
  dangerouslyAllowInsecureIssuerUrl: ALLOW_INSECURE_ISSUER,
};

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

const bearerOptions = {
  verifier,
  requiredScopes: [...SCOPES],
  resourceMetadataUrl,
};

/**
 * 可选认证：
 *   - 没有 Authorization 头 → 匿名放行（tools/list 必须能匿名访问，
 *     否则 ChatGPT 看不到 securitySchemes，也就不会弹出授权 UI）
 *   - 带了 token 但无效/过期/缺 scope → 返回 401/403 challenge，让客户端重新授权
 *   - token 有效 → 把 authInfo 传给 MCP handler
 */
async function optionalAuth(req: Request): Promise<AuthInfo | Response | undefined> {
  const header = req.headers.get("authorization");
  if (!header) return undefined;
  try {
    return await verifyBearerToken(header, bearerOptions);
  } catch (error) {
    return bearerAuthChallengeResponse(error, bearerOptions);
  }
}

/** 无路径的 protected-resource well-known，兼容只探测根路径的客户端 */
const PROTECTED_RESOURCE_BASE_PATH = "/.well-known/oauth-protected-resource";

/**
 * 这个请求是否应该交给 MCP handler。
 *
 * `/mcp` 上的请求一律是 MCP；根路径只在“不像浏览器访问”时当作 MCP
 * （POST，或客户端显式要求 text/event-stream），这样首页仍可正常打开。
 */
function wantsMcp(req: Request, path: string): boolean {
  if (!MCP_PATHS.has(path)) return false;
  if (path === MCP_PATH) return true;
  if (req.method !== "GET") return true;
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/event-stream");
}

/** 在不消费原请求的前提下，读一份克隆体提取 MCP 方法摘要 */
async function peekMcpBody(req: Request): Promise<string | undefined> {
  if (req.method !== "POST") return undefined;
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined;
  try {
    return summarizeMcpBody(await req.clone().json());
  } catch {
    return undefined;
  }
}

function homePage(): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>pi-mcp</title>
<body style="font-family:system-ui;padding:2rem;max-width:46rem;margin:auto">
<h1>pi-mcp</h1>
<p>MCP endpoint: <code>${RESOURCE}</code>（根路径 <code>${BASE_URL}</code> 也可用）</p>
<p>Issuer: <code>${ISSUER}</code></p>
<h2>Discovery</h2>
<ul>
  <li><a href="${resourceMetadataUrl}">${resourceMetadataUrl}</a></li>
  <li><a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a></li>
</ul>
<h2>OAuth</h2>
<ul>
  <li><code>GET  /oauth/authorize</code></li>
  <li><code>POST /oauth/consent</code></li>
  <li><code>POST /oauth/token</code></li>
  <li><code>POST /oauth/register</code></li>
  <li><code>POST /oauth/revoke</code></li>
</ul>
</body>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function fetchHandler(req: Request): Promise<Response> {
  const started = performance.now();
  const notes: string[] = [];

  let res: Response;
  try {
    res = await route(req, notes);
  } catch (error) {
    log.error("http", `unhandled error ${req.method} ${new URL(req.url).pathname}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error && error.stack) log.debug("http", error.stack.split("\n").slice(1, 4).join(" | "));
    res = json({ error: "server_error", error_description: "internal server error" }, 500);
  }

  logRequest({ req, res, durationMs: performance.now() - started, notes });
  return res;
}

async function route(req: Request, notes: string[]): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // ---- OAuth 发现文档 -----------------------------------------------------
  // SDK 会处理 /.well-known/oauth-protected-resource/mcp 和
  // /.well-known/oauth-authorization-server，并带 CORS 与 405 处理。
  const discovery = oauthMetadataResponse(req, authMetadataOptions);
  if (discovery) return discovery;

  // OIDC Discovery（ChatGPT 会探测；不提供会多一次 404）
  if (path === "/.well-known/openid-configuration") {
    return json(openIdProviderMetadata(), 200, { "Access-Control-Allow-Origin": "*" });
  }

  // 签名公钥
  if (path === "/.well-known/jwks.json") {
    return json(await getPublicJwks(), 200, { "Access-Control-Allow-Origin": "*", "cache-control": "public, max-age=300" });
  }

  // 兼容无路径版本（部分客户端只探测 /.well-known/oauth-protected-resource）
  if (path === PROTECTED_RESOURCE_BASE_PATH) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" },
      });
    }
    return json(buildOAuthProtectedResourceMetadata(authMetadataOptions), 200, {
      "Access-Control-Allow-Origin": "*",
    });
  }

  // ---- OAuth 端点 ---------------------------------------------------------
  if (path === "/oauth/register" && req.method === "POST") return handleRegister(req);
  if (path === "/oauth/authorize" && req.method === "GET") return handleAuthorize(req);
  if (path === "/oauth/consent" && req.method === "POST") return handleConsent(req);
  if (path === "/oauth/token" && req.method === "POST") return handleToken(req);
  if (path === "/oauth/revoke" && req.method === "POST") return handleRevoke(req);

  // ---- 登录 ---------------------------------------------------------------
  if (path === "/login" && req.method === "GET") return handleLoginGet(req);
  if (path === "/login" && req.method === "POST") return handleLoginPost(req);
  if (path === "/logout") return handleLogout(req);

  // ---- MCP ----------------------------------------------------------------
  if (wantsMcp(req, path)) {
    const auth = await optionalAuth(req);
    if (auth instanceof Response) return auth;
    if (auth) notes.push(`user=${auth.extra?.subject ?? auth.clientId}`, `scopes=${auth.scopes}`);

    // 克隆一份请求体做日志，不消费原请求
    const summary = await peekMcpBody(req);
    if (summary) notes.push(summary);

    if (path !== MCP_PATH) {
      log.debug("http", `在根路径上收到 MCP 请求（连接器 URL 可能没带 ${MCP_PATH}）`);
    }

    return mcpHandler.fetch(req, auth ? { authInfo: auth } : undefined);
  }

  // ---- 其它 ---------------------------------------------------------------
  if (path === "/" && req.method === "GET") return homePage();
  if (path === "/health") return json({ ok: true });

  log.debug("http", `未知路径 ${req.method} ${path}`);
  return new Response("Not found", { status: 404 });
}

// 对外地址必须 https：BASE_URL 是 OAuth issuer，明文 http 会让授权码、token
// 和登录 cookie 在公网裸奔。回环地址（本地开发）或显式放行时才允许 http。
if (BASE_URL_PROBLEM) {
  log.error("boot", `拒绝启动：${BASE_URL_PROBLEM}`);
  log.error("boot", "  公网部署请在 .env 或环境变量中设置 BASE_URL=https://你的域名（需要 TLS 终止）。");
  if (!ALLOW_INSECURE_BASE_URL) {
    log.error("boot", "  仅内网/隧道调试确需明文 http 时，设置 PI_MCP_ALLOW_INSECURE_BASE_URL=1。");
  }
  process.exit(1);
}

// 弱密码 = 把 bash/read/write 直接暴露到公网。默认拒绝启动，只有显式设置
// PI_MCP_ALLOW_WEAK_PASSWORD=1（本地开发）才放行。
if (PASSWORD_IS_WEAK && !ALLOW_WEAK_PASSWORD) {
  log.error("auth", "拒绝启动：登录密码过弱，公开部署等同于开放 shell。");
  for (const reason of PASSWORD_WEAKNESSES) log.error("auth", `  · ${reason}`);
  log.error("auth", `  ${strongPasswordHint()}`);
  log.error("auth", "  在 .env 或环境变量中设置 LOGIN_PASSWORD；本地开发确需弱密码时设置 PI_MCP_ALLOW_WEAK_PASSWORD=1。");
  process.exit(1);
}

export const server = Bun.serve({
  port: PORT,
  fetch: fetchHandler,
});

log.info("boot", `MCP server  : ${RESOURCE}`);
log.info("boot", `Discovery   : ${resourceMetadataUrl}`);
log.info("boot", `Issuer      : ${ISSUER}`);
log.info("boot", `Listening   : ${BASE_URL} (local port ${server.port})`);
if (USING_DEFAULT_PASSWORD) {
  log.warn("auth", `正在使用默认登录密码 "${LOGIN_PASSWORD}"，请通过环境变量 LOGIN_PASSWORD 修改`);
} else if (PASSWORD_IS_WEAK && ALLOW_WEAK_PASSWORD) {
  log.warn("auth", "已通过 PI_MCP_ALLOW_WEAK_PASSWORD=1 放行弱登录密码，切勿用于公网。");
} else {
  log.info("auth", "登录密码已通过 LOGIN_PASSWORD 设置");
}
log.info("boot", `LOG_LEVEL=${process.env.LOG_LEVEL ?? "info"} LOG_REQUESTS=${process.env.LOG_REQUESTS ?? "1"}`);
if (!BASE_URL.startsWith("https://") && !BASE_URL_IS_LOOPBACK) {
  log.warn("boot", "已放行明文 http 的对外地址，仅限内网/隧道调试，切勿长期用于公网。");
}

// 进程级异常也要留下痕迹
process.on("uncaughtException", (error) => {
  log.error("proc", `uncaughtException: ${error.message}`);
  if (error.stack) log.error("proc", error.stack.split("\n").slice(1, 5).join(" | "));
});
process.on("unhandledRejection", (reason) => {
  log.error("proc", `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
