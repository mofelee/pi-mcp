import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Terminal, visibleWidth, getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { ToolMonitorUI } from "../src/monitor/ui";
import { ToolActivityStore } from "../src/monitor/store";
import { log, logRequest } from "../src/log";
import { styleToolName } from "../src/tool-style";

// 从编译版 Pi 的 shell 启动测试时可能继承 PI_PACKAGE_DIR；测试应使用依赖自身的主题。
const previousPackageDir = process.env.PI_PACKAGE_DIR;
const previousTheme = process.env.LOG_TUI_THEME;
beforeAll(() => {
  process.env.PI_PACKAGE_DIR = resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent");
  process.env.LOG_TUI_THEME = "dark";
});
afterAll(() => {
  if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = previousPackageDir;
  if (previousTheme === undefined) delete process.env.LOG_TUI_THEME; else process.env.LOG_TUI_THEME = previousTheme;
});

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  active = false;
  cursorVisible = true;
  output = "";
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  start(onInput: (data: string) => void, onResize: () => void): void { this.input = onInput; this.resize = onResize; this.active = true; }
  stop(): void { this.active = false; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void { this.cursorVisible = false; }
  showCursor(): void { this.cursorVisible = true; }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function setup(captureConsole = false) {
  const store = new ToolActivityStore();
  const terminal = new FakeTerminal();
  let exits = 0;
  const ui = new ToolMonitorUI({ store, terminal, cwd: process.cwd(), endpoint: "http://localhost:3000/mcp", captureConsole, onExit: () => exits++ });
  ui.start();
  const task = store.start("read", { path: "src/中文-long-file.ts", offset: 10, limit: 20 }, "test");
  store.finish(task.id, { content: [{ type: "text", text: "first\nsecond\nthird\nNEEDLE-hidden-on-fourth-line" }] });
  ui.tui.renderNow();
  return { store, terminal, ui, task, exits: () => exits };
}

describe("Pi TUI 工具界面", () => {
  test("使用原生工具组件渲染，默认收起，Enter/Ctrl+O 可展开", () => {
    const { ui, terminal, task } = setup();
    try {
      const collapsed = ui.tui.render(100).join("\n");
      expect(collapsed).toContain("src/中文-long-file.ts");
      expect(collapsed).not.toContain("NEEDLE-hidden");
      expect(collapsed).not.toContain("first");
      expect(collapsed).toContain("已折叠");
      terminal.input("\r");
      expect(ui.expanded.has(task.id)).toBe(true);
      expect(ui.tui.render(100).join("\n")).toContain("NEEDLE-hidden");
      terminal.input("\x0f");
      expect(ui.expanded.size).toBe(0);
    } finally { ui.stop(); }
    expect(terminal.active).toBe(false);
    expect(terminal.cursorVisible).toBe(true);
  });

  test("Ctrl+F 打开 Pi 原生搜索，临时展开隐藏内容，Esc 恢复", () => {
    const { ui, terminal } = setup();
    try {
      terminal.input("\x06");
      ui.tui.renderNow();
      expect(ui.tui.hasOverlay()).toBe(true);
      expect(ui.tui.render(100).join("\n")).toContain("NEEDLE-hidden");
      for (const char of "NEEDLE") terminal.input(char);
      ui.tui.renderNow();
      terminal.input("\r");
      expect(ui.expanded.size).toBe(0); // Enter 被搜索面板接收，而非展开当前卡片。
      terminal.input("\x1b");
      ui.tui.renderNow();
      expect(ui.tui.hasOverlay()).toBe(false);
      expect(ui.tui.render(100).join("\n")).not.toContain("NEEDLE-hidden");
    } finally { ui.stop(); }
  });

  test("运行中也可打开日志；新输出实时更新；Ctrl+R 跳转并发任务", async () => {
    const { ui, terminal, store } = setup();
    try {
      const first = store.start("bash", { command: "long-task-one" }, "test");
      const second = store.start("bash", { command: "long-task-two" }, "test");
      ui.selectedId = first.id;
      terminal.input("\x0c");
      await Bun.sleep(5);
      expect(ui.mode).toBe("task-log");
      store.update(first.id, { content: [{ type: "text", text: "LIVE-PROGRESS" }] });
      await Bun.sleep(5);
      expect(ui.tui.render(100).join("\n")).toContain("LIVE-PROGRESS");
      terminal.input("\x12");
      await Bun.sleep(5);
      expect(ui.selectedId).toBe(second.id);
      expect(ui.mode).toBe("task-log");
      terminal.input("\x1b");
      expect(ui.mode).toBe("tools");
    } finally { ui.stop(); }
  });

  test("HTTP 日志穿插展示，其他系统日志仍可 Ctrl+G 查看；退出恢复 console", () => {
    const original = console.warn;
    const { ui, terminal } = setup(true);
    try {
      log.error("http", "HTTP-ONLY-MARKER");
      console.warn("DIRECT-CONSOLE-MARKER");
      expect(ui.tui.render(100).join("\n")).toContain("HTTP-ONLY-MARKER");
      expect(ui.tui.render(100).join("\n")).not.toContain("DIRECT-CONSOLE-MARKER");
      terminal.input("\x07");
      expect(ui.mode).toBe("server-log");
      const text = ui.tui.render(100).join("\n");
      expect(text).toContain("HTTP-ONLY-MARKER");
      expect(text).toContain("DIRECT-CONSOLE-MARKER");
    } finally { ui.stop(); }
    expect(console.warn).toBe(original);
  });

  test("同一毫秒的 HTTP 和工具稳定排序，日志不会变成工具卡片", () => {
    const { ui, store } = setup();
    try {
      const first = store.start("read", { path: "TIMELINE-FIRST.txt" }, "test");
      logRequest({ req: new Request("http://localhost/TIMELINE-MIDDLE?token=never-log-me"), res: new Response("ok"), durationMs: 5 });
      const last = store.start("write", { path: "TIMELINE-LAST.txt", content: "ok" }, "test");
      const text = ui.tui.render(160).join("\n");
      expect(text.indexOf("TIMELINE-FIRST")).toBeLessThan(text.indexOf("TIMELINE-MIDDLE"));
      expect(text.indexOf("TIMELINE-MIDDLE")).toBeLessThan(text.indexOf("TIMELINE-LAST"));
      expect(text).toContain("never-log-me");
      expect(ui.networkLogs.at(-1)!.sequence).toBeGreaterThan(first.sequence);
      expect(ui.networkLogs.at(-1)!.sequence).toBeLessThan(last.sequence);
      expect(ui.selectedId).toBe(last.id);
    } finally { ui.stop(); }
  });

  test("write/edit/bash 有不同颜色和文字标识，不改变任务状态", () => {
    expect(styleToolName("write", true)).toContain("\x1b[36mwrite [写入]");
    expect(styleToolName("edit", true)).toContain("\x1b[33medit [编辑]");
    expect(styleToolName("bash", true)).toContain("\x1b[35mbash [命令]");
    expect(styleToolName("write", false)).toBe("write [写入]");
    const { ui, store } = setup();
    try {
      for (const name of ["write", "edit", "bash"]) {
        const task = store.start(name, { path: "example.txt" }, "test");
        expect(task.status).toBe("running");
      }
      const text = ui.tui.render(100).join("\n");
      for (const tag of ["[写入]", "[编辑]", "[命令]"]) expect(text).toContain(tag);
    } finally { ui.stop(); }
  });

  test("初始提示词能够展开和搜索，不显示旧占位文字", () => {
    const { ui, terminal, store } = setup();
    try {
      const task = store.start("pi_initial_prompt", {}, "test");
      store.finish(task.id, { content: [{ type: "text", text: "Pi prompt\nline2\nline3\nPROMPT-SEARCH-TARGET" }] });
      ui.selectedId = task.id;
      terminal.input("\r");
      expect(ui.tui.render(100).join("\n")).toContain("PROMPT-SEARCH-TARGET");
      expect(ui.tui.render(100).join("\n")).not.toContain("不记录初始提示词正文");
      terminal.input("\x06");
      expect(ui.tui.hasOverlay()).toBe(true);
    } finally { ui.stop(); }
  });

  test("Kitty 图像协议输出真实 PNG，文本元数据不含 base64", () => {
    const previous = getCapabilities();
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const { ui, terminal, store } = setup();
    try {
      const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const task = store.start("read", { path: "test-image.png" }, "test");
      store.finish(task.id, { content: [{ type: "image", mimeType: "image/png", data }] });
      ui.tui.renderNow();
      expect(terminal.output).not.toContain(data);
      ui.selectedId = task.id;
      terminal.input("\r");
      ui.tui.renderNow();
      expect(terminal.output).toContain("\x1b_G");
      expect(terminal.output).toContain(data);
      expect(task.output).not.toContain(data);
      terminal.columns = 60;
      terminal.resize();
      ui.tui.renderNow();
      expect(ui.tui.render(60).every((line) => visibleWidth(line) <= 60)).toBe(true);
    } finally { ui.stop(); setCapabilities(previous); }
  });

  test("缩放、宽字符和长行不会超过终端列宽", () => {
    const { ui, terminal, store } = setup();
    try {
      const task = store.start("bash", { command: "界".repeat(100) }, "test");
      store.update(task.id, { content: [{ type: "text", text: "🙂中文".repeat(200) }] });
      for (const width of [16, 24, 60, 120]) {
        terminal.columns = width;
        terminal.resize();
        ui.tui.renderNow();
        expect(ui.tui.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    } finally { ui.stop(); }
  });

  test("敏感文件默认折叠，鼠标点击展开原文，再点收起；运行更新不自动展开", () => {
    const { ui, terminal, store } = setup();
    try {
      store.clear();
      ui.networkLogs.length = 0;
      const task = store.start("read", { path: ".env" }, "test");
      store.update(task.id, { content: [{ type: "text", text: "TOKEN=test-visible-value" }] });
      ui.tui.renderNow();
      expect(ui.tui.render(100).join("\n")).toContain(".env");
      expect(ui.tui.render(100).join("\n")).not.toContain("test-visible-value");
      terminal.input("\x1b[<0;10;6M");
      terminal.input("\x1b[<0;10;6m");
      ui.tui.renderNow();
      expect(ui.expanded.has(task.id)).toBe(true);
      expect(ui.tui.render(100).join("\n")).toContain("TOKEN=test-visible-value");
      terminal.input("\r");
      store.update(task.id, { content: [{ type: "text", text: "TOKEN=next-visible-value" }] });
      expect(ui.tui.render(100).join("\n")).not.toContain("next-visible-value");
      expect(task.output).toBe("TOKEN=next-visible-value");
    } finally { ui.stop(); }
  });

  test("write/edit 参数正文默认折叠，展开才显示", () => {
    const { ui, terminal, store } = setup();
    try {
      for (const [name, args] of [
        ["write", { path: ".env", content: "TOKEN=write-value" }],
        ["edit", { path: ".env", edits: [{ oldText: "TOKEN=old-value", newText: "TOKEN=edit-value" }] }],
      ] as const) {
        const task = store.start(name, args, "test");
        store.finish(task.id, { content: [{ type: "text", text: "done" }] });
        expect(ui.tui.render(100).join("\n")).not.toContain(`${name}-value`);
        ui.selectedId = task.id;
        terminal.input("\r");
        expect(ui.tui.render(100).join("\n")).toContain(`${name}-value`);
        terminal.input("\r");
      }
    } finally { ui.stop(); }
  });

  test("bash 折叠卡片立即显示命令内容和长度，输出仍须展开", () => {
    const { ui, terminal, store } = setup();
    try {
      const command = "printf 'TOKEN=bash-value'";
      const task = store.start("bash", { command, timeout: 30 }, "test");
      const collapsed = ui.tui.render(100).join("\n");
      expect(collapsed).toContain("command=printf 'TOKEN=bash-value'");
      expect(collapsed).toContain(`commandChars=${command.length}`);
      expect(collapsed).toContain("timeout=30");
      store.finish(task.id, { content: [{ type: "text", text: "BASH-OUTPUT-HIDDEN" }] });
      expect(ui.expanded.has(task.id)).toBe(false);
      expect(ui.tui.render(100).join("\n")).not.toContain("BASH-OUTPUT-HIDDEN");
      ui.selectedId = task.id;
      terminal.input("\r");
      expect(ui.tui.render(100).join("\n")).toContain("BASH-OUTPUT-HIDDEN");
    } finally { ui.stop(); }
  });

  test("bash 长命令预览有省略号，展开后保留完整命令尾部", () => {
    const { ui, terminal, store } = setup();
    try {
      store.clear();
      ui.networkLogs.length = 0;
      const command = `printf '${"🙂中文".repeat(100)}'\nprintf COMMAND-TAIL`;
      const task = store.start("bash", { command }, "test");
      const collapsed = ui.tui.render(100).join("\n");
      expect(collapsed).toContain("command=printf '");
      expect(collapsed).toContain("…");
      expect(collapsed).not.toContain("COMMAND-TAIL");
      expect(collapsed).not.toContain("\uFFFD");
      expect(task.args.commandChars).toBe(command.length);
      expect(JSON.parse(task.input).command).toBe(command);
      ui.selectedId = task.id;
      terminal.input("\r");
      expect(ui.tui.render(100).join("\n")).toContain("COMMAND-TAIL");
      terminal.input("\r");
      expect(ui.tui.render(100).join("\n")).not.toContain("COMMAND-TAIL");
    } finally { ui.stop(); }
  });

  test("运行中 Ctrl+C 需要再次确认，按键释放不会重复执行动作", () => {
    const { ui, terminal, store, exits } = setup();
    try {
      store.start("bash", {}, "test");
      terminal.input("\x03");
      expect(exits()).toBe(0);
      terminal.input("\x03");
      expect(exits()).toBe(1);
      ui.handleInput("\x1b[99;5:3u");
      expect(exits()).toBe(1);
    } finally { ui.stop(); }
  });
});
