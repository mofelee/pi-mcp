// 极简持久化存储：动态注册的 client 和 refresh token 会写进一个 JSON 文件，
// 默认位于 ~/.pi-mcp/，同一用户换项目或重启后继续使用同一套授权状态。
// 此 JSON 后端供单个服务进程使用；并行部署应使用独立状态目录或数据库。
//
// 生产环境请替换成数据库或 Redis。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STORE_FILE } from "./config";
import { ensureStateParent } from "./state-paths";

export type OAuthClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
};

export type RefreshTokenRecord = {
  token: string;
  clientId: string;
  userId: string;
  userName?: string;
  scope: string;
  resource: string;
  expiresAt: number;
};

type StoreData = {
  clients: Record<string, OAuthClient>;
  refreshTokens: Record<string, RefreshTokenRecord>;
};

function emptyStore(): StoreData {
  return { clients: {}, refreshTokens: {} };
}

function readStore(): StoreData {
  if (!existsSync(STORE_FILE)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, "utf8")) as Partial<StoreData>;
    return {
      clients: parsed.clients ?? {},
      refreshTokens: parsed.refreshTokens ?? {},
    };
  } catch (error) {
    console.warn(`[oauth] 读取 ${STORE_FILE} 失败，使用空存储：`, error);
    return emptyStore();
  }
}

let data = readStore();

function persist(): void {
  try {
    ensureStateParent(STORE_FILE);
    writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (error) {
    console.warn(`[oauth] 写入 ${STORE_FILE} 失败：`, error);
  }
}

export function getClient(clientId: string): OAuthClient | undefined {
  return data.clients[clientId];
}

export function saveClient(client: OAuthClient): void {
  data.clients[client.clientId] = client;
  persist();
}

export function getRefreshToken(token: string): RefreshTokenRecord | undefined {
  const record = data.refreshTokens[token];
  if (!record) return undefined;
  if (record.expiresAt < Math.floor(Date.now() / 1000)) {
    delete data.refreshTokens[token];
    persist();
    return undefined;
  }
  return record;
}

export function saveRefreshToken(record: RefreshTokenRecord): void {
  data.refreshTokens[record.token] = record;
  persist();
}

export function deleteRefreshToken(token: string): void {
  if (data.refreshTokens[token]) {
    delete data.refreshTokens[token];
    persist();
  }
}
