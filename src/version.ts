// 服务版本号。
//
// 直接取 package.json 的 version（打包时由 Bun 内联进可执行文件）。
// 版本号会出现在 MCP initialize 的 serverInfo.version 里：
// 客户端（例如 ChatGPT 连接器）会用它判断服务端是否发生了变化，
// 所以每次改动工具集/认证方式时都应该升 version，否则客户端可能继续用缓存里的旧工具列表。

import pkg from "../package.json";

export const SERVER_NAME = "pi-mcp";

export const SERVER_VERSION: string =
  typeof pkg?.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
