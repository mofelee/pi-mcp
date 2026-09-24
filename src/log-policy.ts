// 运行日志仅在内存中保留；这些上限不涉及文件落盘或权限控制。
export function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value?.trim() || !/^\d+$/.test(value.trim())) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export const MEMORY_OUTPUT_CHARS = boundedInteger(process.env.LOG_TUI_OUTPUT_CHARS, 1024 * 1024, 4096, 4 * 1024 * 1024);

/** 只剥离终端控制序列，不按文件名、键名、token 或密码脱敏。 */
export function terminalText(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P_X^][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r\n?/g, "\n");
}

/** 保留尾部且不从 UTF-16 代理对中间切开；内存满时丢弃最早内容，绝不溢写文件。 */
export function memoryTail(text: string, limit = MEMORY_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  let start = text.length - limit;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start++;
  return text.slice(start);
}
