// OAuth 身份属于当前操作系统用户，不属于某个项目或可执行文件安装目录。
// 这里只解析路径；需要持久化时再创建父目录，导入配置本身不会写磁盘。

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface StatePaths {
  dir: string;
  jwkFile: string;
  storeFile: string;
}

/** 显式相对路径仍按启动 cwd 解析；配置里的 ~/ 在运行机器上展开。 */
function resolveUserPath(value: string, cwd: string, home: string): string {
  const expanded = value === "~" ? home
    : value.startsWith("~/") || value.startsWith("~\\") ? join(home, value.slice(2))
    : value;
  return resolve(cwd, expanded);
}

/** 文件级覆盖 > PI_MCP_STATE_DIR > 当前用户 ~/.pi-mcp；不使用 PI_MCP_CWD。 */
export function resolveStatePaths(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  home = homedir(),
): StatePaths {
  const dir = resolveUserPath(env.PI_MCP_STATE_DIR?.trim() || join(home, ".pi-mcp"), cwd, home);
  return {
    dir,
    jwkFile: resolveUserPath(env.OAUTH_JWK_FILE?.trim() || join(dir, ".oauth-jwk.json"), cwd, home),
    storeFile: resolveUserPath(env.OAUTH_STORE_FILE?.trim() || join(dir, ".oauth-store.json"), cwd, home),
  };
}

/** 新建私有状态目录（POSIX 0700）；不修改已存在的用户目录权限。 */
export function ensureStateParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
}
