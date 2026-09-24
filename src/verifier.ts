// MCP Resource Server 侧的 token 校验器。
//
// requireBearerAuth 会调用这里；校验失败必须抛 OAuthError(InvalidToken)，
// SDK 会据此生成 401 + WWW-Authenticate challenge。

import { OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { RESOURCE } from "./config";
import { verifyAccessToken } from "./jwt";

export const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string) {
    try {
      const claims = await verifyAccessToken(token);
      return {
        token,
        clientId: claims.clientId || claims.sub,
        scopes: claims.scope.split(" ").filter(Boolean),
        expiresAt: claims.expiresAt,
        // RFC 8707：token 绑定的资源
        resource: new URL(RESOURCE),
        extra: {
          subject: claims.sub,
          name: claims.name,
          clientId: claims.clientId,
        },
      };
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid access token");
    }
  },
};
