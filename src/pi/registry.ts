// 启动时创建一次 pi 工具集合，供 mcp.ts 使用。

import { existsSync } from "node:fs";
import { PI_MCP_TOOLS } from "../config";
import { log } from "../log";
import { CWD } from "./environment";
import { createPiTools, parseToolNames } from "./tools";

/** 通过 MCP 暴露的 pi 内置工具名 */
export const PI_TOOL_NAMES = parseToolNames(PI_MCP_TOOLS);

/** 用启动时的工作目录创建好的工具集合 */
export const PI_TOOLS = createPiTools(PI_TOOL_NAMES, CWD);

if (!existsSync(CWD)) log.warn("pi", `工作目录不存在: ${CWD}（PI_MCP_CWD 是否写错？）`);

log.info("pi", `暴露 ${PI_TOOLS.length} 个内置工具`, {
  tools: PI_TOOLS.map((tool) => tool.name),
  cwd: CWD,
});
