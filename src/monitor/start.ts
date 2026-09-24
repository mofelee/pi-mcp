import { log } from "../log";
import type { MonitorOptions, ToolMonitorUI } from "./ui";

/** 强制 TUI 也必须有可交互终端；管道/systemd 不应进入 raw mode 或输出控制字符。 */
export function shouldUseTui(
  mode = process.env.LOG_UI ?? "auto",
  stdinTty = process.stdin.isTTY === true,
  stdoutTty = process.stdout.isTTY === true,
  term = process.env.TERM,
): boolean {
  if (["plain", "0", "false"].includes(mode.toLowerCase())) return false;
  return stdinTty && stdoutTty && term !== "dumb";
}

export async function startToolMonitor(options: MonitorOptions): Promise<ToolMonitorUI | undefined> {
  const mode = process.argv.includes("--no-tui") ? "plain"
    : process.argv.includes("--tui") ? "tui" : process.env.LOG_UI ?? "auto";
  if (!shouldUseTui(mode)) {
    if (mode === "tui") log.warn("tui", "当前不是可交互终端，回退到普通日志");
    return undefined;
  }
  try {
    // 不在非交互进程中初始化终端或主题。
    const { ToolMonitorUI } = await import("./ui");
    const monitor = new ToolMonitorUI(options);
    monitor.start();
    return monitor;
  } catch (error) {
    log.warn("tui", "终端界面启动失败，服务继续使用普通日志", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
