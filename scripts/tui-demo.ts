#!/usr/bin/env bun
// 只生成演示事件，不启动 HTTP 服务、不执行 shell 命令、不读取项目文件。
import { ToolMonitorUI } from "../src/monitor/ui";
import { ToolActivityStore } from "../src/monitor/store";
import { shouldUseTui } from "../src/monitor/start";
import { log, logRequest } from "../src/log";

if (!shouldUseTui("tui")) {
  console.error("请在交互终端中运行 bun run tui:demo");
  process.exit(1);
}
const store = new ToolActivityStore();
let timer: ReturnType<typeof setInterval> | undefined;
const close = () => { if (timer) clearInterval(timer); ui.stop(); process.exit(0); };
const ui = new ToolMonitorUI({ store, cwd: process.cwd(), endpoint: "DEMO · 未启动 MCP 服务", onExit: close });
ui.start();
process.once("SIGINT", close);
process.once("SIGTERM", close);
process.once("exit", () => ui.stop());

const prompt = store.start("pi_initial_prompt", {}, "demo");
store.finish(prompt.id, { content: [{ type: "text", text: "You are Pi. This is a demo prompt.\n<environment>\nWorking directory: /demo/workspace\n</environment>\nPROMPT-SEARCH-MARKER: 提示词可以展开、搜索。" }] });
logRequest({ req: new Request("https://mcp.example.com/mcp", { method: "POST" }), res: new Response(""), durationMs: 12, notes: ["mcp=tools/call pi_initial_prompt", "demo=true"] });
const read = store.start("read", { path: "src/example.ts", offset: 1, limit: 20 }, "demo");
store.finish(read.id, { content: [{ type: "text", text: "export const answer = 42;\n\n// Demo tool result\n// SEARCH-MARKER: Ctrl+F also searches collapsed content\nexport function greet() { return 'Hello Pi TUI'; }" }] });
const hidden = store.start("read", { path: ".env" }, "demo");
store.finish(hidden.id, { content: [{ type: "text", text: "DEMO_ONLY=hidden" }] });
const write = store.start("write", { path: "src/new-file.ts", content: "export const value = 1;" }, "demo");
store.finish(write.id, { content: [{ type: "text", text: "演示：写入文件，不实际修改磁盘" }] });
logRequest({ req: new Request("https://mcp.example.com/health"), res: new Response("ok"), durationMs: 1, notes: ["demo=true"] });
const edit = store.start("edit", { path: "src/new-file.ts", edits: [{ oldText: "1", newText: "2" }] }, "demo");
store.finish(edit.id, { content: [{ type: "text", text: "演示：精确编辑，不实际修改磁盘" }] });
const build = store.start("bash", { command: "bun run typecheck (demo)" }, "demo");
const check = store.start("grep", { path: "src", pattern: "TODO" }, "demo");
store.finish(check.id, { content: [{ type: "text", text: "src/example.ts:10: TODO: add test cases" }] });
log.info("demo", "这是服务日志，只在 Ctrl+G 视图中展示");
let tick = 0;
let output = "Starting simulated long task…\n";
timer = setInterval(() => {
  tick++;
  output += `step ${String(tick).padStart(2, "0")}: checking module-${tick}.ts\n`;
  store.update(build.id, { content: [{ type: "text", text: output }] });
  if (tick === 20) {
    store.finish(build.id, { content: [{ type: "text", text: `${output}\nTypecheck passed (demo).` }] });
    clearInterval(timer);
  }
}, 1000);
