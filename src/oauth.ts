// 本文件实现了一个最小但完整的 OAuth 2.1 Authorization Server（DCR + PKCE S256）。
//
// 端点：
//   GET  /oauth/authorize        发起授权，登录/同意
//   POST /oauth/consent          同意页面提交
//   POST /oauth/token            code / refresh_token 换 access_token
//   POST /oauth/register         RFC 7591 动态客户端注册
//   POST /oauth/revoke           RFC 7009 token 撤销（可选）

import {
  OAuthError,
  OAuthErrorCode,
  type AuthorizationServerMetadata,
  type OpenIdProviderMetadata,
} from "@modelcontextprotocol/server";
import {
  ACCEPTED_RESOURCES,
  AUTH_CODE_TTL,
  AUTO_APPROVE,
  isAcceptedResource,
  ISSUER,
  REFRESH_TOKEN_TTL,
  RESOURCE,
  SCOPES,
} from "./config";
import { escapeHtml, htmlPage } from "./html";
import { log } from "./log";
import { signAccessToken } from "./jwt";
import { readSession, type Session } from "./session";
import {
  deleteRefreshToken,
  getClient,
  getRefreshToken,
  saveClient,
  saveRefreshToken,
  type OAuthClient,
} from "./store";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "cache-control": "no-store", pragma: "no-cache" };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function oauthError(error: OAuthErrorCode, description: string, status = 400): Response {
  log.warn("oauth", `拒绝: ${description}`, { error });
  return json(new OAuthError(error, description).toResponseObject(), status);
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function base64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(value: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

// ---------------------------------------------------------------------------
// Authorization Server Metadata（RFC 8414）
// ---------------------------------------------------------------------------

export function authorizationServerMetadata(): AuthorizationServerMetadata {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    revocation_endpoint: `${ISSUER}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES],
    // 声明 authorize 会在 redirect 里带 iss，便于客户端做 mix-up 防护
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * OpenID Connect Discovery 1.0 元数据。
 *
 * ChatGPT 会同时探测 RFC 8414 和 OIDC 两个文档，提供后者可减少一次 404。
 * 注意：这里 **不** 声明 `openid` scope，因此不会签发 ID token、也不提供 UserInfo，
 * 只在 scopes_supported 里保留 `mcp`。
 *
 * 若要让 ChatGPT Enterprise 把插件限制到已验证的邮箱域名，需要真正实现
 * OIDC（`openid` + `email` scope、UserInfo 返回 `email_verified`），
 * 见 https://developers.openai.com/plugins/build/auth
 */
export function openIdProviderMetadata(): OpenIdProviderMetadata {
  return {
    ...authorizationServerMetadata(),
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

// ---------------------------------------------------------------------------
// 动态客户端注册
// ---------------------------------------------------------------------------

export async function handleRegister(req: Request): Promise<Response> {
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return oauthError(OAuthErrorCode.InvalidClientMetadata, "invalid JSON body");
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError(OAuthErrorCode.InvalidClientMetadata, "redirect_uris is required");
  }

  for (const uri of redirectUris) {
    if (typeof uri !== "string") {
      return oauthError(OAuthErrorCode.InvalidRedirectUri, "redirect_uris must be strings");
    }
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return oauthError(OAuthErrorCode.InvalidRedirectUri, `invalid redirect_uri: ${uri}`);
    }
    // 允许 https；本地回环地址允许 http（便于本地调试）
    const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
      return oauthError(OAuthErrorCode.InvalidRedirectUri, `redirect_uri must use https: ${uri}`);
    }
  }

  const client: OAuthClient = {
    clientId: crypto.randomUUID(),
    redirectUris: redirectUris as string[],
    clientName: typeof body.client_name === "string" ? body.client_name : undefined,
    createdAt: Math.floor(Date.now() / 1000),
  };
  saveClient(client);

  log.info("oauth", "动态注册新客户端", {
    client_id: client.clientId,
    name: client.clientName,
    redirects: client.redirectUris.length,
  });
  log.debug("oauth", "redirect_uris", { uris: client.redirectUris });

  return json(
    {
      client_id: client.clientId,
      client_id_issued_at: client.createdAt,
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

/**
 * ChatGPT 官方文档列出的两个 redirect URI：
 *   - 满足 issuer identification 要求时用稳定地址
 *   - 否则用 callback-id 专用地址
 * 放在这里作为保险：即使注册/使用不一致也能完成授权。
 * @see https://developers.openai.com/plugins/build/auth
 */
const CHATGPT_STABLE_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_CALLBACK_REDIRECT_PREFIX = "https://chatgpt.com/connector/oauth/";

function isTrustedRedirectUri(client: OAuthClient, redirectUri: string): boolean {
  if (client.redirectUris.includes(redirectUri)) return true;
  if (redirectUri === CHATGPT_STABLE_REDIRECT) return true;
  if (redirectUri.startsWith(CHATGPT_CALLBACK_REDIRECT_PREFIX)) {
    const id = redirectUri.slice(CHATGPT_CALLBACK_REDIRECT_PREFIX.length);
    // 只允许单段 callback id，防止前缀被滥用
    return id.length > 0 && !id.includes("/") && !id.includes("?") && !id.includes("#");
  }
  return false;
}

// ---------------------------------------------------------------------------
// /oauth/authorize
// ---------------------------------------------------------------------------

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string | null;
};

/** 待用户确认的授权请求，key 是 consent id */
const pendingAuthorizations = new Map<string, AuthorizeParams & { expiresAt: number; session: Session }>();

function htmlError(message: string, status = 400): Response {
  return htmlPage("授权失败", `<h1>授权失败</h1><p>${escapeHtml(message)}</p>`, status);
}

function redirectWithError(redirectUri: string, state: string | null, error: string, description: string): Response {
  log.warn("oauth", `授权失败: ${error} - ${description}`);
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", ISSUER);
  return Response.redirect(url.toString(), 302);
}

function consentPage(id: string, params: AuthorizeParams, session: Session, client: OAuthClient | undefined): Response {
  const clientName = client?.clientName ?? params.clientId;
  const scopes = params.scope.split(" ").filter(Boolean);
  const body = `
  <h1>授权请求</h1>
  <p><strong>${escapeHtml(clientName)}</strong> 请求访问你的 MCP Server。</p>
  <p>登录用户：<strong>${escapeHtml(session.name)}</strong>（${escapeHtml(session.userId)}）</p>
  <p>请求的权限：</p>
  <ul>${scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("")}</ul>
  <p>资源：<code>${escapeHtml(params.resource)}</code></p>
  <form method="post" action="/oauth/consent">
    <input type="hidden" name="id" value="${escapeHtml(id)}" />
    <button name="decision" value="allow" style="padding:.6rem 1.2rem">允许</button>
    <button name="decision" value="deny" style="padding:.6rem 1.2rem;margin-left:.5rem">拒绝</button>
  </form>
  <p style="color:#666;font-size:.9rem">不是你的账号？<a href="/logout">退出登录</a></p>`;
  return htmlPage("授权请求", body);
}

export async function handleAuthorize(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams;

  const responseType = q.get("response_type");
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");
  const state = q.get("state");
  const codeChallenge = q.get("code_challenge");
  const codeChallengeMethod = q.get("code_challenge_method");
  const resourceParam = q.get("resource");
  // 允许缺失 resource（按 RFC 8707，AS 已声明时客户端应当发送；缺失时回退到默认资源）
  const resource = resourceParam ?? RESOURCE;
  const scopeParam = q.get("scope") ?? "";

  if (responseType !== "code") {
    return htmlError("response_type 必须为 code");
  }
  if (!clientId || !redirectUri) {
    return htmlError("缺少 client_id 或 redirect_uri");
  }

  const client = getClient(clientId);
  if (!client) {
    return htmlError("未知的 client_id");
  }
  if (!isTrustedRedirectUri(client, redirectUri)) {
    return htmlError("redirect_uri 未在注册信息中登记");
  }

  // 从这里开始 redirect_uri 已可信，错误可以按 OAuth 规范重定向回客户端
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return redirectWithError(redirectUri, state, "invalid_request", "PKCE with S256 is required");
  }
  if (!isAcceptedResource(resource)) {
    return redirectWithError(
      redirectUri,
      state,
      "invalid_target",
      `resource must be one of: ${ACCEPTED_RESOURCES.join(", ")}`,
    );
  }
  const requestedScopes = scopeParam.split(" ").filter(Boolean);
  const scope = requestedScopes.length > 0 ? requestedScopes.join(" ") : SCOPES.join(" ");
  for (const s of requestedScopes) {
    if (!SCOPES.includes(s as (typeof SCOPES)[number])) {
      return redirectWithError(redirectUri, state, "invalid_scope", `unsupported scope: ${s}`);
    }
  }

  // 先要求登录；未登录时跳转到登录页，登录后再回到当前 authorize 请求
  const session = await readSession(req);
  if (!session) {
    log.info("oauth", "authorize 未登录，跳转登录页", { client_id: clientId, ip: req.headers.get("x-forwarded-for") ?? undefined });
    const next = `${url.pathname}${url.search}`;
    return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(next)}`, 302);
  }

  log.info("oauth", "收到授权请求", {
    client: client.clientName ?? clientId.slice(0, 8),
    user: session.userId,
    scope,
    resource,
    pkce: "S256",
  });

  const params: AuthorizeParams = {
    clientId,
    redirectUri,
    codeChallenge,
    resource,
    scope,
    state,
  };

  if (AUTO_APPROVE) {
    return issueAuthorizationCode(params, session);
  }

  const id = randomToken();
  pendingAuthorizations.set(id, {
    ...params,
    session,
    expiresAt: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL,
  });
  return consentPage(id, params, session, client);
}

export async function handleConsent(req: Request): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const id = form.get("id") ?? "";
  const decision = form.get("decision");

  const pending = pendingAuthorizations.get(id);
  pendingAuthorizations.delete(id);

  if (!pending) {
    return htmlError("授权请求不存在或已过期");
  }
  if (pending.expiresAt < Math.floor(Date.now() / 1000)) {
    return htmlError("授权请求已过期");
  }
  if (decision !== "allow") {
    log.info("oauth", "用户拒绝了授权", { user: pending.session.userId });
    return redirectWithError(pending.redirectUri, pending.state, "access_denied", "user denied the request");
  }
  log.info("oauth", "用户同意授权", { user: pending.session.userId, scope: pending.scope });
  return issueAuthorizationCode(pending, pending.session);
}

// ---------------------------------------------------------------------------
// authorization code
// ---------------------------------------------------------------------------

type AuthCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  userId: string;
  userName: string;
  expiresAt: number;
};

const authCodes = new Map<string, AuthCodeRecord>();

function issueAuthorizationCode(params: AuthorizeParams, session: Session): Response {
  const code = randomToken();
  authCodes.set(code, {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    resource: params.resource,
    scope: params.scope,
    userId: session.userId,
    userName: session.name,
    expiresAt: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL,
  });

  const callback = new URL(params.redirectUri);
  callback.searchParams.set("code", code);
  if (params.state) callback.searchParams.set("state", params.state);
  // 与 authorizationServerMetadata().issuer 完全一致
  callback.searchParams.set("iss", ISSUER);
  log.debug("oauth", "已签发 authorization code", { user: session.userId, redirect: params.redirectUri });
  return Response.redirect(callback.toString(), 302);
}

// ---------------------------------------------------------------------------
// /oauth/token
// ---------------------------------------------------------------------------

async function tokenResponse(input: {
  userId: string;
  userName?: string;
  clientId: string;
  scope: string;
  resource: string;
}): Promise<Response> {
  const { accessToken, expiresIn } = await signAccessToken(input);
  const refreshToken = randomToken();
  saveRefreshToken({
    token: refreshToken,
    clientId: input.clientId,
    userId: input.userId,
    userName: input.userName,
    scope: input.scope,
    resource: input.resource,
    expiresAt: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL,
  });

  log.info("oauth", "签发 access token", {
    user: input.userId,
    scope: input.scope,
    ttl: `${expiresIn}s`,
    refresh: "yes",
  });

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: input.scope,
  });
}

export async function handleToken(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return oauthError(OAuthErrorCode.InvalidRequest, "expected application/x-www-form-urlencoded");
  }

  const body = new URLSearchParams(await req.text());
  const grantType = body.get("grant_type");
  log.debug("oauth", `token 请求 grant_type=${grantType}`, { client_id: body.get("client_id") ?? undefined });

  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(body);
  }
  if (grantType === "refresh_token") {
    return handleRefreshTokenGrant(body);
  }
  return oauthError(OAuthErrorCode.UnsupportedGrantType, `unsupported grant_type: ${grantType}`);
}

async function handleAuthorizationCodeGrant(body: URLSearchParams): Promise<Response> {
  const code = body.get("code");
  const clientId = body.get("client_id");
  const redirectUri = body.get("redirect_uri");
  const codeVerifier = body.get("code_verifier");
  const resource = body.get("resource");

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return oauthError(OAuthErrorCode.InvalidRequest, "code, client_id, redirect_uri, code_verifier are required");
  }

  const record = authCodes.get(code);
  // authorization code 一次性使用
  if (record) authCodes.delete(code);

  if (!record) {
    return oauthError(OAuthErrorCode.InvalidGrant, "unknown authorization code");
  }
  if (record.expiresAt < Math.floor(Date.now() / 1000)) {
    return oauthError(OAuthErrorCode.InvalidGrant, "authorization code expired");
  }
  if (record.clientId !== clientId) {
    return oauthError(OAuthErrorCode.InvalidGrant, "client_id mismatch");
  }
  if (record.redirectUri !== redirectUri) {
    return oauthError(OAuthErrorCode.InvalidGrant, "redirect_uri mismatch");
  }
  if (resource && resource !== record.resource) {
    return oauthError(OAuthErrorCode.InvalidTarget, "invalid resource");
  }

  const computed = await s256(codeVerifier);
  if (computed !== record.codeChallenge) {
    return oauthError(OAuthErrorCode.InvalidGrant, "PKCE verification failed");
  }

  return tokenResponse({
    userId: record.userId,
    userName: record.userName,
    clientId: record.clientId,
    scope: record.scope,
    resource: record.resource,
  });
}

async function handleRefreshTokenGrant(body: URLSearchParams): Promise<Response> {
  const refreshToken = body.get("refresh_token");
  const clientId = body.get("client_id");
  const resource = body.get("resource");

  if (!refreshToken || !clientId) {
    return oauthError(OAuthErrorCode.InvalidRequest, "refresh_token and client_id are required");
  }

  const record = getRefreshToken(refreshToken);
  if (!record || record.clientId !== clientId) {
    return oauthError(OAuthErrorCode.InvalidGrant, "invalid refresh token");
  }
  if (resource && resource !== record.resource) {
    return oauthError(OAuthErrorCode.InvalidTarget, "invalid resource");
  }

  // 轮换 refresh token
  deleteRefreshToken(refreshToken);
  log.info("oauth", "refresh token 换新 token", { user: record.userId });

  return tokenResponse({
    userId: record.userId,
    userName: record.userName,
    clientId: record.clientId,
    scope: record.scope,
    resource: record.resource,
  });
}

// ---------------------------------------------------------------------------
// /oauth/revoke
// ---------------------------------------------------------------------------

export async function handleRevoke(req: Request): Promise<Response> {
  const body = new URLSearchParams(await req.text());
  const token = body.get("token");
  if (token) {
    deleteRefreshToken(token);
    log.info("oauth", "已撤销 refresh token");
  }
  // RFC 7009：无论 token 是否存在，都返回 200
  return new Response(null, { status: 200, headers: JSON_HEADERS });
}

export {};
