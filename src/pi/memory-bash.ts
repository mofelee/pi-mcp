// 保留 Pi 的 shell 启动、超时和进程树取消实现，替换会将长输出写入临时文件的收集器。
import { createBashTool, createLocalBashOperations, truncateTail } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { MEMORY_OUTPUT_CHARS, memoryTail } from "../log-policy";

export const MEMORY_BASH_DESCRIPTION = "Execute a bash command in the current working directory. Returns stdout and stderr. "
  + "The MCP response is limited to the last 2000 lines or 50KB. Longer output is retained only in bounded process memory "
  + "for the local TUI; no output log files are created. Optionally provide a timeout in seconds.";

export type MemoryShellDetails = { memoryOnly: true; totalChars: number; droppedChars: number };
export type MemoryShellResult = AgentToolResult<MemoryShellDetails>;

/** 展示用快照与模型侧响应分开；异常也保留已输出的内容而非只有一行报错。 */
export class MemoryBashError extends Error {
  constructor(message: string, readonly monitorResult: MemoryShellResult) {
    super(message);
    this.name = "MemoryBashError";
  }
}

export function shellResponseText(output: string): string {
  const shortened = truncateTail(output);
  return shortened.content + (shortened.truncated
    ? "\n\n[Response truncated; retained output is available in the local TUI memory log. No log file was created.]" : "");
}

export function createMemoryBashTool(cwd: string): ReturnType<typeof createBashTool> {
  const base = createBashTool(cwd); // 仅复用声明和参数 schema，不调用它的 OutputAccumulator。
  const operations = createLocalBashOperations();
  return {
    ...base,
    description: MEMORY_BASH_DESCRIPTION,
    async execute(_id, args, signal, onUpdate) {
      if (typeof args.command !== "string") throw new Error("command must be a string");
      const decoder = new TextDecoder();
      let output = "";
      let totalChars = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let dirty = false;
      let lastUpdate = 0;
      let acceptingOutput = true;
      const snapshot = (): MemoryShellResult => ({
        content: [{ type: "text", text: output }],
        details: { memoryOnly: true, totalChars, droppedChars: Math.max(0, totalChars - output.length) },
      });
      const emit = () => {
        if (!dirty) return;
        dirty = false;
        lastUpdate = Date.now();
        try { onUpdate?.(snapshot()); } catch { /* 观察器失败不影响 shell */ }
      };
      const append = (text: string) => {
        totalChars += text.length;
        output = memoryTail(output + text, MEMORY_OUTPUT_CHARS);
        dirty = true;
      };
      const flush = () => {
        acceptingOutput = false;
        if (timer) { clearTimeout(timer); timer = undefined; }
        append(decoder.decode());
        emit();
      };
      try {
        const { exitCode } = await operations.exec(args.command, cwd, {
          signal, timeout: args.timeout,
          onData: (data) => {
            if (!acceptingOutput) return;
            append(decoder.decode(data, { stream: true }));
            if (Date.now() - lastUpdate >= 100) emit();
            else timer ??= setTimeout(() => { timer = undefined; emit(); }, 100);
          },
        });
        flush();
        if (exitCode !== 0) throw new Error(`Command exited with code ${exitCode ?? "unknown"}`);
        if (!output) append("(no output)");
        return snapshot();
      } catch (error) {
        flush();
        const reason = error instanceof Error ? error.message : String(error);
        const status = reason === "aborted" ? "Command aborted"
          : reason.startsWith("timeout:") ? `Command timed out after ${reason.slice(8)} seconds` : reason;
        append(`${output ? "\n\n" : ""}${status}`);
        emit();
        throw new MemoryBashError(shellResponseText(output), snapshot());
      } finally {
        acceptingOutput = false;
        if (timer) clearTimeout(timer);
      }
    },
  };
}
