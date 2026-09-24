// 运行环境快照。
//
// 工作目录（cwd）取进程启动时的目录，也可以用 PI_MCP_CWD 覆盖；启动后保持不变。
// 时间则是在每次构建提示词时实时计算，避免服务长时间运行后提示词里的时间过期。

import os from "node:os";
import path from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { PI_MCP_CWD } from "../config";

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** 进程启动时确定的工作目录（可用 PI_MCP_CWD 覆盖） */
export const CWD = PI_MCP_CWD ? path.resolve(expandHome(PI_MCP_CWD)) : process.cwd();

/** 服务启动时间 */
export const STARTED_AT = new Date();

function runtimeName(): string {
  if (typeof Bun !== "undefined") return `Bun ${Bun.version}`;
  return `Node.js ${process.version}`;
}

function shellName(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === "win32") return process.env.COMSPEC ?? "powershell";
  return "/bin/sh";
}

function osName(): string {
  switch (process.platform) {
    case "darwin":
      return `macOS (${os.release()})`;
    case "linux":
      return `Linux (${os.release()})`;
    case "win32":
      return `Windows (${os.release()})`;
    default:
      return `${process.platform} (${os.release()})`;
  }
}

/** 带本地时区偏移的 ISO 时间，例如 2025-09-24T18:00:00.000+08:00 */
export function localIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const local = new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, -1);
  return `${local}${offset}`;
}

export interface SystemInfo {
  /** 工作目录（启动时确定） */
  cwd: string;
  /** process.platform，例如 darwin / linux / win32 */
  platform: string;
  /** 人类可读的系统名，例如 macOS (25.0.0) */
  os: string;
  arch: string;
  hostname: string;
  username: string;
  shell: string;
  runtime: string;
  piVersion: string;
  timezone: string;
  /** 实时计算的本地时间（带时区偏移） */
  time: string;
  /** 同一时刻的 UTC 时间 */
  timeUtc: string;
  /** 服务启动时间 */
  startedAt: string;
}

/** 采集当前系统信息；time 每次调用都会重新计算 */
export function systemInfo(): SystemInfo {
  const now = new Date();

  let username = "-";
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER ?? process.env.USERNAME ?? "-";
  }

  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // 忽略：拿不到就是 UTC
  }

  return {
    cwd: CWD,
    platform: process.platform,
    os: osName(),
    arch: process.arch,
    hostname: os.hostname(),
    username,
    shell: shellName(),
    runtime: runtimeName(),
    piVersion: PI_VERSION,
    timezone,
    time: localIso(now),
    timeUtc: now.toISOString(),
    startedAt: localIso(STARTED_AT),
  };
}
