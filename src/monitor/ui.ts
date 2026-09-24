// 复用 Pi 的终端、布局、搜索和 ToolExecutionComponent；不创建模型会话或聊天输入框。
import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  type Component, type Terminal, type TuiMouseEvent, type TuiInputListenerResult,
  getKeybindings, KeybindingsManager, matchesKey, isKeyRelease,
  ScrollView, setKeybindings, Text, truncateToWidth, TUI_KEYBINDINGS, TuiAltScreen, VStack,
} from "@earendil-works/pi-tui";
import { format } from "node:util";
import { getRecentLogEntries, setLogSink, type LogEntry } from "../log";
import { styleToolName } from "../tool-style";
import { LOG_PAGE_CHARS, readToolLog, type LogPage } from "./log-reader";
import { MemoryLogTerminal } from "./terminal";
import { safeText, toolActivities, type ToolActivity, type ToolActivityStore } from "./store";

type View = "tools" | "task-log" | "server-log";
const STATUS = { running: "运行中", success: "完成", error: "失败", cancelled: "已取消" } as const;

class DynamicText implements Component {
  constructor(private value: () => string) {}
  render(width: number): string[] { return this.value().split("\n").map((line) => truncateToWidth(line, width)); }
  invalidate(): void {}
}

class ToolCard implements Component {
  private component: ToolExecutionComponent;
  private revision = -1;
  private expanded = false;
  constructor(readonly activity: ToolActivity, private owner: ToolMonitorUI) {
    this.component = new ToolExecutionComponent(activity.name, activity.id, activity.args, { showImages: false }, {
      renderCall: (args: Record<string, unknown>, _theme: Theme, context: { expanded: boolean }) => new Text(
        styleToolName(activity.name) + " "
          + Object.entries(args).map(([key, value]) => `${key}=${String(value)}`).join(" ")
          + (context.expanded ? `\n输入\n${activity.input}` : ""), 0, 0,
      ),
      renderResult: (result: AgentToolResult<unknown>, options: { expanded: boolean; isPartial?: boolean }, theme: Theme) => {
        const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
        const summary = `[已折叠 · ${activity.outputChars} 字符${activity.images ? ` · ${activity.images} 张图片` : ""} · 点击 / Enter 展开]`;
        const shown = options.expanded
          ? `${activity.truncated ? "[内存上限已达到，仅保留最近输出]\n" : ""}输出\n${text || "[尚无输出]"}` : summary;
        return new Text(theme.fg("toolOutput", shown), 0, 0);
      },
    }, owner.tui, owner.cwd);
    this.component.markExecutionStarted();
    this.component.setArgsComplete();
  }

  render(width: number): string[] {
    // 原生搜索打开时自动展开所有卡片，使收起的内容也可检索；关闭后恢复原状态。
    const expanded = this.owner.expanded.has(this.activity.id) || this.owner.tui.hasOverlay();
    if (this.revision !== this.activity.revision || this.expanded !== expanded) {
      this.component.setExpanded(expanded);
      this.component.setShowImages(expanded);
      this.component.updateResult({
        content: [
          { type: "text", text: this.activity.output || "[等待工具输出…]" },
          ...(expanded ? this.owner.store.getImages(this.activity.id) : []),
        ],
        isError: this.activity.status === "error" || this.activity.status === "cancelled",
      }, this.activity.status === "running");
      this.revision = this.activity.revision;
      this.expanded = expanded;
    }
    const item = this.activity;
    const elapsed = ((item.finishedAt ?? Date.now()) - item.startedAt) / 1000;
    const time = new Date(item.startedAt).toLocaleTimeString("en-GB", { hour12: false });
    const prefix = this.owner.selectedId === item.id ? "▶" : " ";
    const status = `${prefix} ${time}  ${STATUS[item.status]}  ${elapsed.toFixed(1)}s  #${item.id.slice(0, 8)}  ${item.user}`;
    // Pi 图片行包含专用图形控制序列，不当作普通字符串截断或清洗。
    return [status, ...this.component.render(Math.max(12, width))].map((line) =>
      line.includes("\x1b_G") || line.includes("\x1b]1337;File=") ? line : truncateToWidth(line, width));
  }
  invalidate(): void { this.component.invalidate(); }
  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
    if (event.type === "click" && event.button === "left") {
      this.owner.selectedId = this.activity.id;
      this.owner.toggleSelected();
      return { handled: true };
    }
    return undefined;
  }
}

class Transcript implements Component {
  private cards = new Map<string, ToolCard>();
  readonly offsets = new Map<string, number>();
  private cardRanges: Array<{ id: string; start: number; end: number }> = [];
  constructor(private owner: ToolMonitorUI) {}
  render(width: number): string[] {
    const items = this.owner.store.items;
    const activeIds = new Set(items.map((item) => item.id));
    for (const id of this.cards.keys()) if (!activeIds.has(id)) { this.cards.delete(id); this.owner.expanded.delete(id); }
    this.offsets.clear();
    this.cardRanges = [];
    const timeline: Array<{ sequence: number; activity?: ToolActivity; log?: LogEntry }> = [
      ...items.map((activity) => ({ sequence: activity.sequence, activity })),
      ...this.owner.networkLogs.map((log) => ({ sequence: log.sequence, log })),
    ];
    timeline.sort((a, b) => a.sequence - b.sequence);
    if (!timeline.length) return new Text("等待工具调用或网络请求…", 1, 1).render(width);
    const lines: string[] = [];
    for (const entry of timeline) {
      if (entry.log) {
        lines.push(...new Text(entry.log.line, 1, 0).render(width));
        continue;
      }
      const activity = entry.activity!;
      let card = this.cards.get(activity.id);
      if (!card) { card = new ToolCard(activity, this.owner); this.cards.set(activity.id, card); }
      const start = lines.length;
      this.offsets.set(activity.id, start);
      lines.push(...card.render(width));
      this.cardRanges.push({ id: activity.id, start, end: lines.length });
    }
    return lines;
  }
  invalidate(): void { for (const card of this.cards.values()) card.invalidate(); }
  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
    const entry = this.cardRanges.find((range) => event.y >= range.start && event.y < range.end);
    return entry ? this.cards.get(entry.id)?.handleMouse(event) : undefined;
  }
}

export interface MonitorOptions {
  store?: ToolActivityStore;
  terminal?: Terminal;
  cwd: string;
  endpoint: string;
  onExit: () => void;
  captureConsole?: boolean;
}

export class ToolMonitorUI {
  readonly tui: TuiAltScreen;
  readonly store: ToolActivityStore;
  readonly cwd: string;
  readonly expanded = new Set<string>();
  readonly networkLogs: LogEntry[] = [];
  selectedId?: string;
  mode: View = "tools";
  private transcript: Transcript;
  private toolScroll: ScrollView;
  private logText = new Text("", 1, 0);
  private logScroll: ScrollView;
  private serverText = new Text("", 1, 0);
  private serverScroll: ScrollView;
  private header: DynamicText;
  private footer: DynamicText;
  private systemLines: string[] = [];
  private logActivity?: ToolActivity;
  private logPage?: LogPage;
  private logOffset?: number;
  private logGeneration = 0;
  private loadingLog = false;
  private refreshQueued = false;
  private timer?: ReturnType<typeof setInterval>;
  private restore: Array<() => void> = [];
  private pinned = false;
  private started = false;
  private exitArmedAt = 0;
  private previousKeybindings = getKeybindings();

  constructor(private options: MonitorOptions) {
    initTheme(process.env.LOG_TUI_THEME || "dark", false);
    this.store = options.store ?? toolActivities;
    this.cwd = options.cwd;
    this.tui = new TuiAltScreen(options.terminal ?? new MemoryLogTerminal(), false, undefined, {
      copyOnSelect: false,
      scrollToEndIndicator: () => " ↓ 返回最新输出 ",
    });
    this.transcript = new Transcript(this);
    this.toolScroll = new ScrollView(this.transcript, { primary: true, follow: "end" });
    this.logScroll = new ScrollView(this.logText, { primary: true, follow: "end" });
    this.serverScroll = new ScrollView(this.serverText, { primary: true, follow: "end" });
    this.header = new DynamicText(() => this.headerText());
    this.footer = new DynamicText(() => this.mode === "tools"
      ? "↑↓ 选择  Enter 展开当前  Ctrl+O 全部展开/收起  Ctrl+F 搜索\nCtrl+L 任务日志  Ctrl+R 运行中任务  Ctrl+G 服务日志  Ctrl+C 退出"
      : "Ctrl+F 搜索  PgUp/PgDn 滚动  Esc 返回工具  Ctrl+C 退出\n[ / ] 内存日志翻页  Ctrl+End 跟随最新  Ctrl+R 运行中任务");
    this.tui.addInputListener((data) => this.handleInput(data));
    this.mount();
  }

  private headerText(): string {
    const running = this.store.running.length;
    const title = this.mode === "tools" ? "工具调用与网络请求" : this.mode === "task-log" ? "任务日志" : "服务日志";
    let detail = `保留 ${this.store.items.length} 条 · ${running} 个运行中 · ${safeText(this.options.endpoint)}`;
    if (this.mode === "task-log" && this.logActivity) {
      const item = this.logActivity;
      detail = `${item.name} #${item.id.slice(0, 8)} · ${STATUS[item.status]} · ${this.logOffset === undefined ? "实时跟随" : "历史分页"}`;
      if (this.logPage) detail += ` · 内存字符 ${this.logPage.start}–${this.logPage.end} / ${this.logPage.total}`;
    }
    return `pi-mcp · ${title}\n${detail}`;
  }

  private mount(): void {
    const scroll = this.mode === "tools" ? this.toolScroll : this.mode === "task-log" ? this.logScroll : this.serverScroll;
    this.tui.setLayoutRoot(new VStack([
      { component: this.header, basis: 2, shrink: 1, minSize: 1 },
      { component: scroll, basis: "auto", grow: 1, shrink: 1, minSize: 1 },
      { component: this.footer, basis: 2, shrink: 1, minSize: 1 },
    ]));
    this.tui.requestRender();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      ...this.previousKeybindings.getUserBindings(),
      "tui.altScreen.search": ["ctrl+f", "ctrl+shift+f"],
      "tui.altScreen.lineUp": ["alt+up"], "tui.altScreen.lineDown": ["alt+down"],
    });
    setKeybindings(bindings);
    this.restore.push(() => setKeybindings(this.previousKeybindings));
    const recent = getRecentLogEntries();
    this.systemLines = recent.map((entry) => safeText(entry.line));
    this.networkLogs.splice(0, this.networkLogs.length, ...recent
      .filter((entry) => entry.scope === "http")
      .map((entry) => ({ ...entry, line: safeText(entry.line) })));
    this.restore.push(setLogSink((line, entry) => this.pushSystemLog(line, entry)));
    if (this.options.captureConsole !== false) {
      for (const key of ["log", "info", "warn", "error", "debug"] as const) {
        const original = console[key];
        const replacement = (...args: unknown[]) => this.pushSystemLog(`${key.toUpperCase()} ${format(...args)}`);
        console[key] = replacement;
        this.restore.push(() => { if (console[key] === replacement) console[key] = original; });
      }
    }
    this.selectedId = this.store.items.at(-1)?.id;
    this.restore.push(this.store.subscribe((event) => {
      if (event.type === "start" && !this.pinned && this.mode === "tools" && this.toolScroll.isFollowingEnd) this.selectedId = event.activity.id;
      if (!this.selectedId || !this.store.get(this.selectedId)) this.selectedId = this.store.items.at(-1)?.id;
      this.tui.requestRender();
      if (this.mode === "task-log" && event.activity.id === this.logActivity?.id) void this.refreshLog();
    }));
    try {
      this.tui.start();
      this.timer = setInterval(() => {
        if (this.store.running.length) this.tui.requestRender();
        if (this.mode === "task-log" && this.logOffset === undefined) void this.refreshLog();
      }, 500);
      this.timer.unref();
    } catch (error) { this.stop(); throw error; }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.logGeneration++;
    if (this.timer) clearInterval(this.timer);
    // 不在退出时将展开过的完整日志再转储到主屏幕。
    this.tui.setLayoutRoot(new Text("pi-mcp 工具监控已关闭", 0, 0));
    try { this.tui.renderNow(); this.tui.stop(); }
    finally { for (const restore of this.restore.splice(0).reverse()) restore(); }
  }

  private pushSystemLog(line: string, entry?: LogEntry): void {
    const text = safeText(line).slice(0, 4096);
    this.systemLines.push(text);
    if (entry?.scope === "http") {
      this.networkLogs.push({ ...entry, line: text });
      if (this.networkLogs.length > 500) this.networkLogs.shift();
      this.tui.requestRender();
    }
    if (this.systemLines.length > 500) this.systemLines.shift();
    if (this.mode === "server-log") {
      this.serverText.setText(this.systemLines.join("\n"));
      this.tui.requestRender();
    }
  }

  toggleSelected(): void {
    if (!this.selectedId) return;
    if (!this.expanded.delete(this.selectedId)) this.expanded.add(this.selectedId);
    this.pinned = true;
    this.tui.requestRender();
  }

  private select(delta: number): void {
    const items = this.store.items;
    const current = items.findIndex((item) => item.id === this.selectedId);
    const next = items[Math.max(0, Math.min(items.length - 1, current + delta))];
    if (!next) return;
    this.pinned = true;
    this.selectedId = next.id;
    this.toolScroll.scrollTo(this.transcript.offsets.get(next.id) ?? 0, { disableFollow: true });
    this.tui.requestRender();
  }

  async openToolLog(activity = this.selectedId ? this.store.get(this.selectedId) : this.store.items.at(-1)): Promise<void> {
    if (!activity) { this.tui.flash("还没有工具调用"); return; }
    this.logGeneration++;
    this.logActivity = activity;
    this.selectedId = activity.id;
    this.pinned = true;
    this.mode = "task-log";
    this.logOffset = undefined;
    this.logPage = undefined;
    this.logText.setText(activity.output || "[等待工具输出…]");
    this.mount();
    this.logScroll.scrollToEnd();
    await this.refreshLog();
  }

  private async refreshLog(): Promise<void> {
    if (!this.started || !this.logActivity || this.mode !== "task-log") return;
    if (this.loadingLog) { this.refreshQueued = true; return; }
    this.loadingLog = true;
    const generation = this.logGeneration;
    try {
      const page = await readToolLog(this.logActivity, this.logOffset);
      if (generation !== this.logGeneration || this.mode !== "task-log") return;
      this.logPage = page;
      this.logText.setText(`${page.warning ? `[${page.warning}]\n` : ""}${page.text}`);
      this.tui.requestRender();
    } finally {
      this.loadingLog = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshLog();
      }
    }
  }

  handleInput(data: string): TuiInputListenerResult {
    if (isKeyRelease(data)) return { consume: true };
    if (matchesKey(data, "ctrl+c")) {
      if (this.tui.hasActiveSelection()) { void this.tui.copyActiveSelectionToClipboard(); return { consume: true }; }
      if (this.store.running.length && Date.now() - this.exitArmedAt > 2000) {
        this.exitArmedAt = Date.now();
        this.tui.flash("有任务运行中；再次按 Ctrl+C 退出服务", 2000);
      } else this.options.onExit();
      return { consume: true };
    }
    // 原生搜索面板负责文本编辑、Enter/Shift+Enter 跳转和 Escape，不能抢它的键。
    if (this.tui.hasOverlay()) return undefined;
    if (matchesKey(data, "ctrl+l")) { void this.openToolLog(); return { consume: true }; }
    if (matchesKey(data, "ctrl+r")) {
      const active = this.store.running;
      const index = active.findIndex((item) => item.id === this.selectedId);
      const next = active[(index + 1) % active.length];
      if (next) void this.openToolLog(next); else this.tui.flash("没有运行中的任务");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+g")) {
      this.logGeneration++;
      this.mode = "server-log";
      this.serverText.setText(this.systemLines.join("\n") || "[暂无服务日志]");
      this.mount();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.logGeneration++;
      this.mode = "tools";
      this.mount();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+end")) {
      if (this.mode === "task-log") { this.logOffset = undefined; void this.refreshLog(); this.logScroll.scrollToEnd(); }
      else if (this.mode === "tools") { this.pinned = false; this.selectedId = this.store.items.at(-1)?.id; this.toolScroll.scrollToEnd(); }
      else this.serverScroll.scrollToEnd();
      this.tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const delta = matchesKey(data, "up") ? -1 : 1;
      if (this.mode === "tools") this.select(delta);
      else { (this.mode === "task-log" ? this.logScroll : this.serverScroll).scrollBy(delta); this.tui.requestRender(); }
      return { consume: true };
    }
    if (this.mode === "tools" && matchesKey(data, "enter")) { this.toggleSelected(); return { consume: true }; }
    if (this.mode === "tools" && matchesKey(data, "ctrl+o")) {
      const allExpanded = this.store.items.every((item) => this.expanded.has(item.id));
      this.expanded.clear();
      if (!allExpanded) for (const item of this.store.items) this.expanded.add(item.id);
      this.tui.requestRender();
      return { consume: true };
    }
    if (this.mode === "task-log" && (data === "[" || data === "]") && this.logPage) {
      this.logOffset = Math.max(0, Math.min(Math.max(0, this.logPage.total - LOG_PAGE_CHARS), this.logPage.start + (data === "[" ? -LOG_PAGE_CHARS : LOG_PAGE_CHARS)));
      this.logGeneration++;
      void this.refreshLog();
      this.logScroll.scrollToStart();
      return { consume: true };
    }
    return undefined;
  }
}
