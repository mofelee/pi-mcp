// 对外地址（BASE_URL）策略。
//
// BASE_URL 同时充当 OAuth issuer 和 access token 的 audience；用明文 http
// 暴露到公网意味着授权码、access token、refresh token 和登录 cookie 都可以
// 被中间人读取或篡改。因此除本机回环地址（本地开发）外，一律要求 https。
//
// 本模块不读取环境变量、无副作用，构建脚本和运行时共用同一份判定。

export interface ParsedBaseUrl {
  url: URL;
  /** 是否为本机回环地址（localhost / 127.0.0.0/8 / ::1） */
  loopback: boolean;
  /** 是否使用了明文 http */
  insecure: boolean;
}

export type BaseUrlParseResult = ({ ok: true } & ParsedBaseUrl) | { ok: false; reason: string };

/** 判断主机名是否为本机回环地址。 */
export function isLoopbackHost(hostname: string): boolean {
  // URL.hostname 对 IPv6 会带方括号。
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  if (host.startsWith("127.")) return true;
  return false;
}

/** 解析 BASE_URL，只做语法与协议校验，不判断是否允许明文。 */
export function parseBaseUrl(value: string): BaseUrlParseResult {
  const raw = value.trim();
  if (!raw) return { ok: false, reason: "BASE_URL 为空" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `不是合法的 URL：${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `只支持 http/https，收到 ${url.protocol}//` };
  }
  return { ok: true, url, loopback: isLoopbackHost(url.hostname), insecure: url.protocol !== "https:" };
}

/**
 * 返回 BASE_URL 的问题描述；undefined 表示通过。
 *
 * 明文 http 仅对本机回环地址放行；`allowInsecure` 为 true 时（由
 * PI_MCP_ALLOW_INSECURE_BASE_URL=1 显式开启）也放行，供内网/隧道调试。
 */
export function baseUrlProblem(value: string, allowInsecure: boolean): string | undefined {
  const parsed = parseBaseUrl(value);
  if (!parsed.ok) return parsed.reason;
  if (parsed.insecure && !parsed.loopback && !allowInsecure) {
    return `公网地址必须使用 https，收到 ${value}`;
  }
  return undefined;
}
