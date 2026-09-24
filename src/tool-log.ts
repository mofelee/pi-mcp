// 普通日志打印元数据与有界 bash 命令预览；完整输入/输出在内存 TUI 中点击展开，不按内容脱敏。
import type { CallToolResult } from "@modelcontextprotocol/server";
import { terminalText } from "./log-policy";

/** 兼容旧的通用摘要配置；0 不生成正文片段，不影响独立的 bash 命令预览或 TUI 展开。 */
export function parsePreviewChars(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const number = Number(raw);
  return Number.isFinite(number) ? Math.min(number, 1000) : 0;
}
export const TOOL_PREVIEW_CHARS = parsePreviewChars(process.env.LOG_TOOL_PREVIEW_CHARS);
/** 普通日志与折叠卡片均显示命令；默认最多 160 个 Unicode 码点（包含省略号）。 */
export const BASH_COMMAND_PREVIEW_CHARS = 160;

export function textPreview(text: string, maxChars = TOOL_PREVIEW_CHARS): string | undefined {
  if (maxChars <= 0 || !text) return undefined;
  const lines = terminalText(text).trim().split("\n");
  const chars = Array.from(lines.slice(0, 3).join(" ↵ ").replace(/[\t ]+/g, " "));
  const truncated = lines.length > 3 || chars.length > maxChars;
  return truncated ? `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…` : chars.join("") || undefined;
}

/** previewChars 控制正文片段；即使为 0，bash 也保留独立的有界命令预览。 */
export function toolLogFields(
  name: string,
  args: Record<string, unknown>,
  result?: CallToolResult,
  previewChars = 0,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof args.path === "string") fields.path = terminalText(args.path);
  if (name === "read") {
    fields.offset = typeof args.offset === "number" ? args.offset : 1;
    if (typeof args.limit === "number") fields.limit = args.limit;
  } else if (name === "write" && typeof args.content === "string") {
    fields.inputChars = args.content.length;
    fields.inputPreview = textPreview(args.content, previewChars);
  } else if (name === "edit") {
    fields.edits = Array.isArray(args.edits) ? args.edits.length : 1;
  } else if (name === "bash") {
    if (typeof args.command === "string") {
      fields.command = textPreview(args.command, previewChars > 0 ? previewChars : BASH_COMMAND_PREVIEW_CHARS);
      fields.commandChars = args.command.length;
    }
    if (typeof args.timeout === "number") fields.timeout = args.timeout;
  } else if (["grep", "find", "ls"].includes(name)) {
    fields.path ??= ".";
    if (typeof args.pattern === "string") fields.pattern = textPreview(args.pattern, previewChars);
    if (typeof args.glob === "string") fields.glob = textPreview(args.glob, previewChars);
    if (typeof args.limit === "number") fields.limit = args.limit;
  }
  if (result) {
    const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    fields.outputChars = output.length;
    fields.preview = textPreview(output, previewChars);
    const images = result.content.filter((block) => block.type === "image").length;
    if (images) fields.images = images;
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
