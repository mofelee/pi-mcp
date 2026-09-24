// 把 pi 的内置经典工具包装成 MCP 可调用的形式。
//
// 工具实现直接复用 @earendil-works/pi-coding-agent：read / bash / edit / write / grep
//（以及可选的 find / ls）。每个工具在启动时用工作目录创建一次，之后所有调用都相对该目录解析路径。

import {
  createBashToolDefinition,
  createEditTool,
  createEditToolDefinition,
  createFindTool,
  createFindToolDefinition,
  createGrepTool,
  createGrepToolDefinition,
  createLsTool,
  createLsToolDefinition,
  createReadTool,
  createReadToolDefinition,
  createWriteTool,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SCHEMA_DIALECT } from "../json-schema";
import { log } from "../log";
import { serviceShutdown } from "../lifecycle";
import { createMemoryBashTool, MEMORY_BASH_DESCRIPTION, shellResponseText } from "./memory-bash";
import { CWD } from "./environment";

/** pi 内置工具名 */
export type PiToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

/** 这里的泛型对 MCP 层没有意义，用 any 抹平各工具不同的 schema */
type AnyAgentTool = AgentTool<any, any>;
type AnyToolDefinition = ToolDefinition<any, any>;

interface PiToolFactory {
  create: (cwd: string) => AnyAgentTool;
  definition: (cwd: string) => AnyToolDefinition;
}

const FACTORIES = {
  read: { create: createReadTool, definition: createReadToolDefinition },
  bash: { create: createMemoryBashTool, definition: createBashToolDefinition },
  edit: { create: createEditTool, definition: createEditToolDefinition },
  write: { create: createWriteTool, definition: createWriteToolDefinition },
  grep: { create: createGrepTool, definition: createGrepToolDefinition },
  find: { create: createFindTool, definition: createFindToolDefinition },
  ls: { create: createLsTool, definition: createLsToolDefinition },
} satisfies Record<PiToolName, PiToolFactory>;

/** 全部可暴露的内置工具 */
export const ALL_TOOL_NAMES = Object.keys(FACTORIES) as PiToolName[];

/** 默认暴露 pi 的 5 个经典工具 */
export const DEFAULT_TOOL_NAMES: PiToolName[] = ["read", "bash", "edit", "write", "grep"];

/** 解析 PI_MCP_TOOLS；未知名字会被忽略，全部无效时回退到默认集合 */
export function parseToolNames(value: string | undefined): PiToolName[] {
  if (!value?.trim()) return [...DEFAULT_TOOL_NAMES];

  const names: PiToolName[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (!(name in FACTORIES)) {
      log.warn("pi", `忽略未知工具 ${name}（可选：${ALL_TOOL_NAMES.join(", ")}）`);
      continue;
    }
    const typed = name as PiToolName;
    if (!names.includes(typed)) names.push(typed);
  }
  return names.length > 0 ? names : [...DEFAULT_TOOL_NAMES];
}

export interface PiTool {
  name: PiToolName;
  label: string;
  description: string;
  /** 一行摘要，用于初始提示词的 Available tools 段落 */
  snippet: string;
  /** pi 官方给该工具的建议，放进初始提示词的 rules 段落 */
  guidelines: string[];
  /** 工具的 JSON Schema 参数定义，直接透传给 MCP */
  inputSchema: Record<string, unknown>;
  /** 工具的 JSON Schema 输出定义，与 runPiTool 返回的 structuredContent 对应 */
  outputSchema: Record<string, unknown>;
  tool: AnyAgentTool;
}

/**
 * pi 工具的输出 schema。
 *
 * pi 的这几个工具本身就是「自由文本 + 可选细节」的形状（bash 输出、文件内容、目录列表……），
 * 所以统一用这个信封，而不是每个工具编一个容易和服务端实际返回对不上的严格 schema：
 *   - output  ：主要文本结果（必填，客户端可以直接用）
 *   - details ：工具附带的结构化细节；不同工具字段不同（例如 edit 的 diff/patch、截断信息）
 *
 * 图片例外：read 读到的图片以 image content block 返回，base64 不会写进 structuredContent，
 * 否则一份图片会被重复成两倍大小（对模型而言还是无法阅读的 base64 文本）。
 */
export const PI_TOOL_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: SCHEMA_DIALECT,
  type: "object",
  properties: {
    output: {
      type: "string",
      description:
        "工具的主要文本输出（文件内容、命令输出、搜索结果等）。read 读图片时这里是说明文字，图片本体在 image content block 里。",
    },
    details: {
      type: "object",
      description:
        "工具附带的结构化细节，不同工具字段不同：edit 有 diff/patch/firstChangedLine，被截断的工具会带 truncation 等。没有细节时该字段省略。",
      additionalProperties: true,
    },
  },
  required: ["output"],
  additionalProperties: false,
};

/** 用给定工作目录创建一组 pi 工具 */
export function createPiTools(names: PiToolName[], cwd: string = CWD): PiTool[] {
  return names.map((name) => {
    const factory = FACTORIES[name];
    const definition = factory.definition(cwd);
    return {
      name,
      label: definition.label,
      description: name === "bash" ? MEMORY_BASH_DESCRIPTION : definition.description,
      snippet: definition.promptSnippet ?? definition.description.split("\n")[0] ?? name,
      guidelines: definition.promptGuidelines ?? [],
      inputSchema: definition.parameters as unknown as Record<string, unknown>,
      outputSchema: PI_TOOL_OUTPUT_SCHEMA,
      tool: factory.create(cwd),
    };
  });
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function toMcpContent(block: unknown): McpContent | undefined {
  if (!block || typeof block !== "object") return undefined;
  const value = block as Record<string, unknown>;
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
    return { type: "image", data: value.data, mimeType: value.mimeType };
  }
  return undefined;
}

export interface PiToolRunResult {
  content: McpContent[];
  /** 本地内存监控快照；绝不作为 MCP 额外字段发出。 */
  monitorResult?: { content: McpContent[]; structuredContent: Record<string, unknown> };
  /** 与 PI_TOOL_OUTPUT_SCHEMA 对应的结构化结果 */
  structuredContent: Record<string, unknown>;
  details?: unknown;
}

/** 把文本 content block 拼成 output 字段 */
function textOutput(content: McpContent[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** details 只在是普通对象时透传（数组/原始值对客户端没意义） */
function detailsField(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const entries = Object.entries(details).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * 执行一个 pi 工具。
 *
 * 注意：错误直接抛出，由 mcp.ts 统一转成 isError 结果。
 */
export async function runPiTool(
  tool: PiTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: (result: PiToolRunResult) => void,
): Promise<PiToolRunResult> {
  // pi 的工具可能带 prepareArguments（例如 edit 支持单个对象写法），先归一化再做类型转换。
  const params = tool.tool.prepareArguments ? tool.tool.prepareArguments(args) : args;
  const executionSignal = signal ? AbortSignal.any([signal, serviceShutdown.signal]) : serviceShutdown.signal;
  const result = await tool.tool.execute(crypto.randomUUID(), params, executionSignal, onUpdate ? (partial) => {
    const content = (partial.content ?? []).map(toMcpContent).filter((block): block is McpContent => !!block);
    const details = detailsField(partial.details);
    // Pi 返回累计快照；监控端只替换当前输出，不把它误当作增量追加。
    try {
      onUpdate({ content, structuredContent: { output: textOutput(content), ...(details ? { details } : {}) }, details });
    } catch { /* 监控失败不影响工具执行 */ }
  } : undefined);
  const content = (result.content ?? []).map(toMcpContent).filter((block): block is McpContent => !!block);

  const structuredContent: Record<string, unknown> = { output: textOutput(content) };
  const details = detailsField(result.details);
  if (details) structuredContent.details = details;

  if (tool.name === "bash") {
    const responseText = shellResponseText(textOutput(content));
    return {
      content: [{ type: "text", text: responseText }],
      structuredContent: { output: responseText, ...(details ? { details } : {}) },
      details: result.details,
      monitorResult: { content, structuredContent },
    };
  }
  return { content, structuredContent, details: result.details };
}
