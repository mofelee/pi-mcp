// 极简结构化日志。
//
// 输出到 stdout/stderr，一行一条，方便在 tmux 里直接看。
//   LOG_LEVEL=debug|info|warn|error   默认 info
//   LOG_REQUESTS=0                    关闭每个 HTTP 请求的一行日志
//   NO_COLOR=1                        关闭颜色
//
// 本地运维日志只保留在内存；工具正文由 TUI 点击展开，不做敏感文件分类。

import { nextEventSequence } from "./event-sequence";
import { styleToolName } from "./tool-style";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false;

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

function paint(color: keyof typeof COLOR, value: string): string {
  return useColor ? `${COLOR[color]}${value}${COLOR.reset}` : value;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const configuredLevel: LogLevel = (() => {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : "info";
})();

export const logRequests = process.env.LOG_REQUESTS !== "0";

// TUI 接管日志输出，避免普通 console 输出破坏界面；启动前保留一个有界缓冲。
export interface LogEntry {
  sequence: number;
  timestamp: number;
  level: LogLevel;
  scope: string;
  line: string;
}
type LogSink = (line: string, entry: LogEntry) => void;
let logSink: LogSink | undefined;
const recentLogs: LogEntry[] = [];
export function getRecentLogs(): string[] { return recentLogs.map((entry) => entry.line); }
export function getRecentLogEntries(): LogEntry[] { return [...recentLogs]; }
export function setLogSink(sink: LogSink): () => void {
  const previous = logSink;
  logSink = sink;
  return () => { if (logSink === sink) logSink = previous; };
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function emit(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[configuredLevel]) return;

  const levelColor: keyof typeof COLOR =
    level === "error" ? "red" : level === "warn" ? "yellow" : level === "debug" ? "gray" : "blue";

  const parts = [
    paint("gray", timestamp()),
    paint(levelColor, level.toUpperCase().padEnd(5)),
    paint("magenta", scope.padEnd(6)),
    scope === "mcp" ? message.replace(/\btools\/call (write|edit|bash)\b/, (_, name: string) => `tools/call ${styleToolName(name, useColor)}`) : message,
  ];

  const rendered = formatFields(fields);
  if (rendered) parts.push(rendered);

  const line = parts.join(" ");
  const entry: LogEntry = { sequence: nextEventSequence(), timestamp: Date.now(), level, scope, line: line.slice(0, 4096) };
  recentLogs.push(entry);
  if (recentLogs.length > 500) recentLogs.shift();
  if (logSink) {
    try { logSink(line, entry); return; } catch { /* 回退到原始日志，不让日志故障影响请求 */ }
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) return "";
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${paint("gray", `${k}=`)}${formatValue(v)}`).join(" ");
}

function formatValue(value: unknown): string {
  // 路径/工具输出可能包含换行、引号或控制字符，转义后确保一条事件只占一行。
  if (typeof value === "string") return /[\s"\\\u0000-\u001f\u007f-\u009f]/.test(value) ? JSON.stringify(value) : value;
  if (Array.isArray(value)) return value.length === 0 ? "-" : value.map(formatValue).join(",");
  return String(value);
}

export const log = {
  debug: (scope: string, message: string, fields?: Record<string, unknown>) => emit("debug", scope, message, fields),
  info: (scope: string, message: string, fields?: Record<string, unknown>) => emit("info", scope, message, fields),
  warn: (scope: string, message: string, fields?: Record<string, unknown>) => emit("warn", scope, message, fields),
  error: (scope: string, message: string, fields?: Record<string, unknown>) => emit("error", scope, message, fields),
};

// ---------------------------------------------------------------------------
// HTTP 请求日志
// ---------------------------------------------------------------------------

function statusColor(status: number): keyof typeof COLOR {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  if (status >= 300) return "cyan";
  return "green";
}

function methodColor(method: string): keyof typeof COLOR {
  switch (method) {
    case "GET":
      return "cyan";
    case "POST":
      return "green";
    case "OPTIONS":
      return "gray";
    default:
      return "blue";
  }
}

/** 取真实客户端 IP（部署在 Caddy 后面，优先看 X-Forwarded-For） */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "-";
}

/** 精简 User-Agent，避免刷屏 */
function shortUserAgent(req: Request): string | undefined {
  const ua = req.headers.get("user-agent");
  if (!ua) return undefined;
  if (ua.length <= 60) return ua;
  return `${ua.slice(0, 57)}...`;
}

const MAX_PATH_LENGTH = 64;

/** 路径 + 截断的 query，避免长参数把一行撞成好几行 */
function displayPath(req: Request): string {
  const url = new URL(req.url);
  const full = url.pathname + (url.search || "");
  if (full.length <= MAX_PATH_LENGTH) return full;

  // 保留前缀，后接省略号（query 里的参数对排查而言前缀通常已够用）
  return `${full.slice(0, MAX_PATH_LENGTH - 3)}...`;
}

export function logRequest(input: {
  req: Request;
  res: Response;
  durationMs: number;
  /** 额外信息，例如 mcp=tools/call echo、user=user_123 */
  notes?: string[];
  level?: LogLevel;
}): void {
  if (!logRequests) return;

  const { req, res, durationMs, notes } = input;

  const line = [
    paint(methodColor(req.method), req.method.padEnd(6)),
    paint(statusColor(res.status), String(res.status)),
    paint("gray", `${durationMs.toFixed(0)}ms`.padStart(6)),
    displayPath(req),
  ].join(" ");

  const rendered = formatFields({
    ip: clientIp(req),
    ua: shortUserAgent(req),
  });

  emit(input.level ?? "info", "http", `${line}${rendered ? ` ${rendered}` : ""}${formatNotes(notes)}`);
}

function formatNotes(notes?: string[]): string {
  const items = (notes ?? []).filter(Boolean);
  if (items.length === 0) return "";
  return ` ${items.map((n) => paint("gray", n)).join(" ")}`;
}

// ---------------------------------------------------------------------------
// MCP 请求摘要
// ---------------------------------------------------------------------------

type JsonRpcLike = {
  method?: unknown;
  params?: unknown;
  id?: unknown;
};

/** 把 MCP 请求体压成一行摘要，例如 `tools/call echo`（批量请求会列出全部方法） */
export function summarizeMcpBody(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? (body as JsonRpcLike[]) : [body as JsonRpcLike];
  const parts: string[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (!method) continue;

    const params = (message.params ?? {}) as Record<string, unknown>;
    const detail =
      method === "tools/call" && typeof params.name === "string"
        ? params.name
        : method === "prompts/get" && typeof params.name === "string"
          ? params.name
          : method === "resources/read" && typeof params.uri === "string"
            ? params.uri
            : undefined;

    parts.push(detail ? `${method} ${detail}` : method);
  }

  if (parts.length === 0) return undefined;
  return `mcp=${parts.join(",")}`;
}

/** 从 MCP 请求体里挑出工具名，便于单独统计 */
export function mcpToolName(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? (body as JsonRpcLike[]) : [body as JsonRpcLike];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.method !== "tools/call") continue;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (typeof params.name === "string") return params.name;
  }
  return undefined;
}
