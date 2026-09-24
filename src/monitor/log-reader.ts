// 内存日志分页：不导入 fs、不打开 fullOutputPath、不创建或读取临时日志。
import type { ToolActivity } from "./store";
export const LOG_PAGE_CHARS = 64 * 1024;
export interface LogPage {
  text: string;
  start: number;
  end: number;
  total: number;
  warning?: string;
}

/** offset 是当前保留快照的 UTF-16 偏移；省略时查看最新一页。 */
export async function readToolLog(activity: ToolActivity, offset?: number, pageChars = LOG_PAGE_CHARS): Promise<LogPage> {
  const text = `输入\n${activity.input}\n\n输出\n${activity.output || "[尚无输出]"}`;
  const size = Number.isFinite(pageChars) ? Math.max(2, Math.min(LOG_PAGE_CHARS, Math.floor(pageChars))) : LOG_PAGE_CHARS;
  const requested = offset !== undefined && Number.isFinite(offset) ? Math.floor(offset) : text.length - size;
  let start = Math.min(text.length, Math.max(0, requested));
  let end = Math.min(text.length, start + size);
  const low = (index: number) => text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
  if (start > 0 && low(start)) start--;
  if (end < text.length && low(end)) end--;
  return {
    text: text.slice(start, end), start, end, total: text.length,
    ...(activity.truncated ? { warning: "已达到内存保留上限，最早的输出已丢弃；没有日志文件。" } : {}),
  };
}
