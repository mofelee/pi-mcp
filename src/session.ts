// 登录 session：把已登录用户签成 JWT 放进 HttpOnly cookie。
//
// 复用 keys.ts 的 RS256 密钥，无需额外的 session 存储。

import { SignJWT, jwtVerify } from "jose";
import { ISSUER, SECURE_COOKIES, SESSION_COOKIE, SESSION_TTL } from "./config";
import { getSigningKey } from "./keys";

const SESSION_AUDIENCE = "mcp-login-session";

export type Session = {
  userId: string;
  name: string;
};

export async function createSessionCookie(session: Session): Promise<string> {
  const { privateKey, kid } = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ name: session.name })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(session.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL)
    .sign(privateKey);

  return serializeCookie(SESSION_COOKIE, token, SESSION_TTL);
}

export function clearSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, "", 0);
}

function serializeCookie(name: string, value: string, maxAge: number): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (SECURE_COOKIES) parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

/** 从请求里读取并校验登录 session；未登录/失效返回 null */
export async function readSession(req: Request): Promise<Session | null> {
  const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (!token) return null;

  try {
    const { publicKey } = await getSigningKey();
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: ISSUER,
      audience: SESSION_AUDIENCE,
    });
    if (!payload.sub) return null;
    return {
      userId: payload.sub,
      name: typeof payload.name === "string" ? payload.name : payload.sub,
    };
  } catch {
    return null;
  }
}
