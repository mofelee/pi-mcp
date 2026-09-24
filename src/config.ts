// 全局配置：所有环境变量都在这里读取一次，方便其它模块直接引用。
//
// BASE_URL 必须是对外稳定的公网地址；ChatGPT 会把它当作 OAuth issuer 和
// resource 标识。本地开发时允许 http://localhost:xxxx。

import "./env";
import { passwordWeaknesses } from "./password-policy";
import { resolveStatePaths } from "./state-paths";
import { baseUrlProblem, parseBaseUrl } from "./url-policy";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * 没有任何配置时的默认对外地址。
 *
 * 故意保留本地地址：公网部署必须通过内嵌配置、启动目录 `.env` 或环境变量
 * BASE_URL 显式声明自己的域名，避免把某台机器的真实地址写死在源码里。
 */
export const DEFAULT_BASE_URL = "http://localhost:3000";

const rawBaseUrl = process.env.BASE_URL?.trim() || DEFAULT_BASE_URL;

/** 服务对外地址，例如 https://mcp.example.com */
export const BASE_URL = trimTrailingSlash(rawBaseUrl);

/** 显式放行明文 http 的公网地址（仅供内网/隧道调试；公网部署不要设置） */
export const ALLOW_INSECURE_BASE_URL = process.env.PI_MCP_ALLOW_INSECURE_BASE_URL === "1";

/** BASE_URL 的解析结果（语法 / 协议 / 明文 https 要求） */
const parsedBaseUrl = parseBaseUrl(BASE_URL);

/** BASE_URL 是否为本机回环地址 */
export const BASE_URL_IS_LOOPBACK = parsedBaseUrl.ok ? parsedBaseUrl.loopback : false;

/**
 * BASE_URL 的问题描述；undefined 表示通过。
 *
 * 除 localhost / 127.0.0.1 / ::1 外必须使用 https，否则启动与构建都会被拒绝。
 */
export const BASE_URL_PROBLEM = baseUrlProblem(BASE_URL, ALLOW_INSECURE_BASE_URL);

/** OAuth 2.1 Authorization Server 的 issuer（本服务既是 AS 也是 Resource Server） */
export const ISSUER = BASE_URL;

/** 受保护的 MCP 端点路径（规范地址） */
export const MCP_PATH = "/mcp";

/**
 * 同时接受在根路径上提供 MCP。
 *
 * ChatGPT 连接器如果把地址填成裸域名（https://example.com 而不是
 * https://example.com/mcp），它会直接向 `/` 发 JSON-RPC。
 * 两边都服务，避免因漏写 /mcp 而出现 “No app tools available yet”。
 */
export const MCP_PATHS = new Set([MCP_PATH, "/"]);

/** RFC 8707 resource 标识，也就是 access token 的 aud */
export const RESOURCE = `${BASE_URL}${MCP_PATH}`;

/**
 * 可接受的 resource / audience 取值。
 *
 * 除了规范地址，还接受裸域名：客户端在裸域名上发现资源时
 * （RFC 9728 的 well-known 位于 `.well-known/oauth-protected-resource`），
 * 它可能带着 `resource=https://example.com` 过来。
 */
export const ACCEPTED_RESOURCES = [RESOURCE, BASE_URL] as const;

/** 判断 resource 参数 / audience 是否可接受 */
export function isAcceptedResource(value: string | undefined | null): boolean {
  return typeof value === "string" && (ACCEPTED_RESOURCES as readonly string[]).includes(value);
}

export const PORT = Number(process.env.PORT ?? 3000);

/** 本服务只暴露一个 scope，主要用来向 ChatGPT 声明需要授权 */
export const SCOPES = ["mcp"] as const;

/** access token 有效期（秒） */
export const ACCESS_TOKEN_TTL = Number(process.env.ACCESS_TOKEN_TTL ?? 3600);

/** authorization code 有效期（秒） */
export const AUTH_CODE_TTL = Number(process.env.AUTH_CODE_TTL ?? 300);

/** refresh token 有效期（秒），默认 30 天 */
export const REFRESH_TOKEN_TTL = Number(process.env.REFRESH_TOKEN_TTL ?? 60 * 60 * 24 * 30);

/** 授权时是否跳过 consent 页面（仅建议本地调试） */
export const AUTO_APPROVE = process.env.OAUTH_AUTO_APPROVE === "1";

/** 本地开发允许 http issuer 的开关，SDK 默认要求 HTTPS / localhost */
export const ALLOW_INSECURE_ISSUER = !BASE_URL.startsWith("https://");

/** 用户级 OAuth 状态：跨项目/软链接/安装目录共享；仍可显式覆盖。 */
const statePaths = resolveStatePaths();
export const STATE_DIR = statePaths.dir;
export const JWK_FILE = statePaths.jwkFile;
export const STORE_FILE = statePaths.storeFile;

/** 固定用来演示的登录用户；生产环境应替换成真实登录/session */
export const DEMO_USER_ID = process.env.OAUTH_DEMO_USER_ID ?? "user_123";
export const DEMO_USER_NAME = process.env.OAUTH_DEMO_USER_NAME ?? "Demo User";

// ---------------------------------------------------------------------------
// 登录（演示用的单密码保护）
// ---------------------------------------------------------------------------

/**
 * 登录密码。
 *
 * 未设置时回落到 `pi-mcp`——它属于弱密码，会被下面的策略拦下，因此没有任何
 * 配置时服务不会启动，避免“默认密码直接上线”。
 */
export const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD?.trim() || "pi-mcp";

/** 是否使用了内置默认密码 */
export const USING_DEFAULT_PASSWORD = !process.env.LOGIN_PASSWORD?.trim();

/** 显式放行弱密码（仅供本地开发/测试；公网部署不要设置） */
export const ALLOW_WEAK_PASSWORD = process.env.PI_MCP_ALLOW_WEAK_PASSWORD === "1";

/** 当前登录密码命中的弱密码原因；空数组表示通过策略 */
export const PASSWORD_WEAKNESSES = passwordWeaknesses(LOGIN_PASSWORD);

/** 当前登录密码是否为弱密码 */
export const PASSWORD_IS_WEAK = PASSWORD_WEAKNESSES.length > 0;

/** 登录 session 有效期（秒），默认 7 天 */
export const SESSION_TTL = Number(process.env.SESSION_TTL ?? 60 * 60 * 24 * 7);

/** 登录 session cookie 名 */
export const SESSION_COOKIE = "mcp_session";

/** HTTPS 部署时给 cookie 加 Secure */
export const SECURE_COOKIES = BASE_URL.startsWith("https://");

/** 允许明文 http 的 base URL（回环或显式放行） */
export const INSECURE_BASE_URL_ALLOWED = BASE_URL_IS_LOOPBACK || ALLOW_INSECURE_BASE_URL;

// ---------------------------------------------------------------------------
// pi coding agent
// ---------------------------------------------------------------------------

/**
 * 覆盖工作目录。
 *
 * 默认使用进程启动时的 cwd，也就是“在哪个目录启动，就在哪个目录干活”。
 * 也可以显式指定，支持 `~`。
 */
export const PI_MCP_CWD = process.env.PI_MCP_CWD?.trim() || undefined;

/**
 * 通过 MCP 暴露哪些 pi 内置工具（逗号分隔）。
 *
 * 默认暴露 pi 的 5 个经典工具：read、bash、edit、write、grep。
 * 可选项还包括 find、ls。
 */
export const PI_MCP_TOOLS = process.env.PI_MCP_TOOLS?.trim() || undefined;
