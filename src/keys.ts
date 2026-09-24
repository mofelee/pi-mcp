// RS256 签名密钥的加载与生成。
//
// 优先级：
//   1. 环境变量 OAUTH_JWK（JSON 字符串，私钥 JWK，含 kid）
//   2. 用户级 ~/.pi-mcp/.oauth-jwk.json（可用 OAUTH_JWK_FILE 覆盖）
//   3. 首次需要密钥时生成并写入用户状态目录（仅适合开发/单机部署）
//
// 生产环境请把密钥放到 KMS / Secret Manager，并通过 OAUTH_JWK 注入。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { JWK_FILE } from "./config";
import { ensureStateParent } from "./state-paths";

/**
 * 从私钥 JWK 里挑出公钥字段。
 *
 * 注意：RSA 私钥 JWK 除 `d` 外还有 `p` / `q` / `dp` / `dq` / `qi` / `oth`，
 * 只删 `d` 会把私钥分量泄漏出去。这里用白名单，只保留公钥字段。
 */
function toPublicJwk(jwk: JWK): JWK {
  const publicJwk: JWK = { kty: jwk.kty, n: jwk.n, e: jwk.e };
  if (jwk.use) publicJwk.use = jwk.use;
  if (jwk.alg) publicJwk.alg = jwk.alg;
  if (jwk.kid) publicJwk.kid = jwk.kid;
  return publicJwk;
}

type SigningKey = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** 公钥 JWK，用于 /oauth/jwks 和对外验证 */
  publicJwk: JWK;
  kid: string;
};

let cached: SigningKey | null = null;
let loading: Promise<SigningKey> | null = null;

async function loadFromJwk(jwk: JWK): Promise<SigningKey> {
  const privateKey = (await importJWK(jwk, "RS256")) as CryptoKey;
  const publicJwk = toPublicJwk(jwk);
  const publicKey = (await importJWK(publicJwk, "RS256")) as CryptoKey;
  return {
    privateKey,
    publicKey,
    publicJwk,
    kid: typeof jwk.kid === "string" ? jwk.kid : "default",
  };
}

async function createAndPersist(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  privateJwk.kid = crypto.randomUUID();

  try {
    ensureStateParent(JWK_FILE);
    writeFileSync(JWK_FILE, JSON.stringify(privateJwk, null, 2), { mode: 0o600 });
    console.warn(`[oauth] 已生成新的签名密钥并写入 ${JWK_FILE}（仅建议用于开发环境）`);
  } catch (error) {
    console.warn(`[oauth] 无法写入密钥文件 ${JWK_FILE}，本次密钥仅存在于内存中：`, error);
  }

  return {
    privateKey,
    publicKey,
    publicJwk: toPublicJwk(privateJwk),
    kid: privateJwk.kid as string,
  };
}

async function load(): Promise<SigningKey> {
  const fromEnv = process.env.OAUTH_JWK?.trim();
  if (fromEnv) {
    return loadFromJwk(JSON.parse(fromEnv) as JWK);
  }

  if (existsSync(JWK_FILE)) {
    const jwk = JSON.parse(readFileSync(JWK_FILE, "utf8")) as JWK;
    return loadFromJwk(jwk);
  }

  return createAndPersist();
}

/** 获取（并缓存）签名密钥 */
export function getSigningKey(): Promise<SigningKey> {
  if (cached) return Promise.resolve(cached);
  loading ??= load().then((key) => {
    cached = key;
    return key;
  });
  return loading;
}

/** 对外发布的公开 JWKS */
export async function getPublicJwks(): Promise<{ keys: JWK[] }> {
  const { publicJwk } = await getSigningKey();
  // 双重保险：再走一次白名单，确保任何情况下都不会带出私钥分量
  return { keys: [{ ...toPublicJwk(publicJwk), use: "sig", alg: "RS256" }] };
}
