// 可信本地运维界面：原始输入/输出仅驻留有界内存，默认折叠；不按内容或文件名脱敏。
import type { CallToolResult } from "@modelcontextprotocol/server";
import { nextEventSequence } from "../event-sequence";
import { toolLogFields } from "../tool-log";
import { boundedInteger, MEMORY_OUTPUT_CHARS, memoryTail, terminalText } from "../log-policy";
export { boundedInteger } from "../log-policy";

export type ToolStatus = "running" | "success" | "error" | "cancelled";
export type ToolUpdate = Pick<CallToolResult, "content" | "structuredContent" | "isError">;
export interface ToolActivity {
  id: string;
  sequence: number;
  name: string;
  user: string;
  /** 折叠卡片展示元数据与有界 bash 命令预览；完整参数见 input。 */
  args: Record<string, unknown>;
  input: string;
  startedAt: number;
  finishedAt?: number;
  status: ToolStatus;
  output: string;
  outputChars: number;
  images: number;
  revision: number;
  truncated: boolean;
}
export type ActivityEvent = { type: "start" | "update" | "finish"; activity: ToolActivity };
export type ActivityImage = { type: "image"; data: string; mimeType: string };
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
const IMAGE_CACHE_CHARS = 32 * 1024 * 1024;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** 只过滤终端控制序列，不改变密码、token、私钥等可见文本。 */
export const safeText = terminalText;

export class ToolActivityStore {
  private activities = new Map<string, ToolActivity>();
  private imageCache = new Map<string, { blocks: ActivityImage[]; size: number }>();
  private imageCacheSize = 0;
  private listeners = new Set<(event: ActivityEvent) => void>();
  readonly historyLimit: number;
  readonly outputLimit: number;
  constructor(options: { historyLimit?: number; outputLimit?: number } = {}) {
    this.historyLimit = options.historyLimit ?? boundedInteger(process.env.LOG_TUI_HISTORY, 200, 1, 2000);
    this.outputLimit = options.outputLimit ?? MEMORY_OUTPUT_CHARS;
  }

  clear(): void {
    this.activities.clear();
    this.imageCache.clear();
    this.imageCacheSize = 0;
  }

  get items(): ToolActivity[] { return [...this.activities.values()]; }
  get running(): ToolActivity[] { return this.items.filter((item) => item.status === "running"); }
  get(id: string): ToolActivity | undefined { return this.activities.get(id); }
  getImages(id: string): readonly ActivityImage[] { return this.imageCache.get(id)?.blocks ?? []; }

  private releaseImages(id: string): void {
    const cached = this.imageCache.get(id);
    if (!cached) return;
    this.imageCacheSize -= cached.size;
    this.imageCache.delete(id);
  }

  private cacheImages(activity: ToolActivity, content: ToolUpdate["content"]): void {
    this.releaseImages(activity.id);
    if (process.env.LOG_TUI_IMAGES === "0") return;
    const blocks: ActivityImage[] = [];
    let size = 0;
    for (const block of content) {
      if (block.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") continue;
      if (!/^image\/(?:png|jpeg|gif|webp|bmp)$/.test(block.mimeType)
        || !block.data.length || block.data.length > MAX_IMAGE_CHARS
        || size + block.data.length > MAX_IMAGE_CHARS
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) continue;
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
      size += block.data.length;
    }
    while (this.imageCacheSize + size > IMAGE_CACHE_CHARS) {
      const oldest = this.imageCache.keys().next().value;
      if (!oldest) break;
      this.releaseImages(oldest);
      const evicted = this.activities.get(oldest);
      if (evicted) { evicted.revision++; this.emit("update", evicted); }
    }
    if (blocks.length) {
      this.imageCache.set(activity.id, { blocks, size });
      this.imageCacheSize += size;
    }
  }

  subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(type: ActivityEvent["type"], activity: ToolActivity): void {
    // 可视化故障不能改变 MCP 的返回结果，更不能中断 shell 子进程。
    for (const listener of this.listeners) {
      try { listener({ type, activity }); } catch { /* isolation boundary */ }
    }
  }

  private prune(): void {
    const completed = this.items.filter((item) => item.status !== "running");
    for (const item of completed.slice(0, Math.max(0, completed.length - this.historyLimit))) {
      this.activities.delete(item.id);
      this.releaseImages(item.id);
    }
  }

  start(name: string, args: Record<string, unknown>, user: string): ToolActivity {
    const fields = toolLogFields(name, args, undefined, 0);
    const rawInput = safeText(JSON.stringify(args, null, 2));
    const input = rawInput.length > this.outputLimit
      ? `[输入超出内存上限，仅保留尾部]\n${memoryTail(rawInput, this.outputLimit)}` : rawInput;
    const safeArgs = Object.fromEntries(Object.entries(fields).map(([key, value]) => [
      key, typeof value === "string" ? safeText(value).slice(0, 4096) : value,
    ]));
    const activity: ToolActivity = {
      id: crypto.randomUUID(), sequence: nextEventSequence(), name: safeText(name).slice(0, 100), user: safeText(user).slice(0, 200),
      args: safeArgs, input, startedAt: Date.now(), status: "running", output: "", outputChars: 0,
      images: 0, revision: 0, truncated: false,
    };
    this.activities.set(activity.id, activity);
    this.emit("start", activity);
    return activity;
  }

  /** Pi 的 onUpdate 是累计快照（不是增量），必须替换而非拼接，以免重复输出。 */
  update(id: string, result: ToolUpdate): void {
    const activity = this.activities.get(id);
    if (!activity || activity.status !== "running") return;
    const structured = record(result.structuredContent);
    const details = record(structured?.details);
    const output = activity.name === "pi_initial_prompt" && typeof structured?.prompt === "string" ? structured.prompt
      : typeof structured?.output === "string" ? structured.output
      : result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    activity.outputChars = typeof details?.totalChars === "number" ? details.totalChars : output.length;
    activity.images = result.content.filter((block) => block.type === "image").length;
    this.cacheImages(activity, result.content);
    const text = safeText(output);
    activity.truncated = text.length > this.outputLimit || (typeof details?.droppedChars === "number" && details.droppedChars > 0);
    activity.output = memoryTail(text, this.outputLimit);
    // 不保存、不读取 fullOutputPath；所有历史和长任务输出都只存在内存中。
    if (activity.images && !activity.output) activity.output = `[${activity.images} 张图片]`;
    activity.revision++;
    this.emit("update", activity);
  }

  finish(id: string, result: ToolUpdate, cancelled = false): void {
    const activity = this.activities.get(id);
    if (!activity || activity.status !== "running") return;
    this.update(id, result);
    activity.status = cancelled ? "cancelled" : result.isError ? "error" : "success";
    activity.finishedAt = Date.now();
    activity.revision++;
    this.prune();
    this.emit("finish", activity);
  }
}

export const toolActivities = new ToolActivityStore();
