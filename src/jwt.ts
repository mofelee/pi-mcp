// access token 的签发与校验。
//
// access token 使用 RS256 签名的 JWT：
//   iss = ISSUER
//   aud = RESOURCE（RFC 8707，OpenAI 要求 resource 必须反映到 token 里）
//   sub = 用户 ID
//   scope = 已授权的 scope
//   exp = 过期时间

import { SignJWT, jwtVerify } from "jose";
import { ACCEPTED_RESOURCES, ACCESS_TOKEN_TTL, ISSUER, RESOURCE } from "./config";
import { getSigningKey } from "./keys";

export type AccessTokenClaims = {
  sub: string;
  name?: string;
  clientId: string;
  scope: string;
  expiresAt: number;
};

export async function signAccessToken(input: {
  userId: string;
  userName?: string;
  clientId: string;
  scope: string;
  resource: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const { privateKey, kid } = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);

  const accessToken = await new SignJWT({
    scope: input.scope,
    client_id: input.clientId,
    ...(input.userName ? { name: input.userName } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setSubject(input.userId)
    // 关键：把 resource 写进 aud
    .setAudience(input.resource)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL)
    .sign(privateKey);

  return { accessToken, expiresIn: ACCESS_TOKEN_TTL };
}

/** 校验 access token，失败时抛错 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { publicKey } = await getSigningKey();

  const { payload } = await jwtVerify(token, publicKey, {
    issuer: ISSUER,
    // 接受规范地址与裸域名两种 audience，见 config.ts 的 ACCEPTED_RESOURCES
    audience: [...ACCEPTED_RESOURCES],
  });

  if (!payload.sub) throw new Error("token missing sub");
  if (typeof payload.exp !== "number") throw new Error("token missing exp");

  return {
    sub: payload.sub,
    name: typeof payload.name === "string" ? payload.name : undefined,
    clientId: typeof payload.client_id === "string" ? payload.client_id : "",
    scope: typeof payload.scope === "string" ? payload.scope : "",
    expiresAt: payload.exp,
  };
}
