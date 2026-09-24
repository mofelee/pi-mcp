import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ToolActivityStore, safeText, type ToolUpdate } from "../src/monitor/store";
import { readToolLog } from "../src/monitor/log-reader";
import { shouldUseTui } from "../src/monitor/start";
import { createPiTools, runPiTool } from "../src/pi/tools";
import { MemoryBashError } from "../src/pi/memory-bash";
import { MEMORY_OUTPUT_CHARS } from "../src/log-policy";

const result = (output: string, details?: Record<string, unknown>): ToolUpdate => ({
  content: [{ type: "text", text: output }], structuredContent: { output, ...(details ? { details } : {}) },
});
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

describe("可信内存工具历史", () => {
  test("并发 ID 独立，累计输出替换而非拼接，完成后的迟到更新不覆盖", () => {
    const store = new ToolActivityStore();
    const first = store.start("bash", { command: "echo one" }, "test");
    const second = store.start("read", { path: "test.ts" }, "test");
    expect(first.id).not.toBe(second.id);
    store.update(first.id, result("one"));
    store.update(first.id, result("one\ntwo"));
    expect(first.output).toBe("one\ntwo");
    store.finish(second.id, result("file content"));
    expect(store.running.map((item) => item.id)).toEqual([first.id]);
    store.finish(first.id, { ...result("failed"), isError: true });
    expect(first.status).toBe("error");
    expect(first.finishedAt).toBeGreaterThanOrEqual(first.startedAt);
    store.update(first.id, result("late"));
    expect(first.output).toBe("failed");
  });

  test("不隐藏敏感文件、私钥或 token；只在内存保存原始参数与正文", () => {
    const store = new ToolActivityStore();
    const body = "TOKEN=test-secret\n-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----";
    for (const path of [".env", ".oauth-jwk.json", ".oauth-store.json", "auth.json", "credentials", "key.pem"]) {
      const task = store.start("write", { path, content: body }, "test");
      store.finish(task.id, result(body, { fullOutputPath: "/does/not/exist.log" }));
      expect(task.input).toContain("test-secret");
      expect(task.output).toBe(body);
      expect(task).not.toHaveProperty("fullOutputPath");
      expect(task.args).not.toHaveProperty("inputPreview");
    }
    const prompt = store.start("pi_initial_prompt", {}, "test");
    store.finish(prompt.id, { content: [], structuredContent: { prompt: "PROMPT BODY\nTOKEN=visible" } });
    expect(prompt.output).toBe("PROMPT BODY\nTOKEN=visible");
  });

  test("历史和输出有上限，内存满丢弃最早内容，运行中任务不淘汰", () => {
    const store = new ToolActivityStore({ historyLimit: 2, outputLimit: 20 });
    const active = store.start("bash", {}, "test");
    for (let i = 0; i < 5; i++) {
      const item = store.start("read", { path: `${i}.txt` }, "test");
      store.finish(item.id, result("a".repeat(100)));
    }
    expect(store.items).toHaveLength(3);
    expect(store.get(active.id)).toBe(active);
    expect(store.items.at(-1)!.output).toBe("a".repeat(20));
    expect(store.items.at(-1)!.truncated).toBe(true);
    store.clear();
    expect(store.items).toHaveLength(0);
    expect(new ToolActivityStore().items).toHaveLength(0);
  });

  test("图片独立缓存，不变成 base64 文本；历史淘汰会释放", () => {
    const store = new ToolActivityStore({ historyLimit: 1 });
    const task = store.start("read", { path: "secret-image.png" }, "test");
    const response: ToolUpdate = { content: [{ type: "image", mimeType: "image/png", data: PNG }] };
    store.finish(task.id, response);
    expect(store.getImages(task.id)[0]?.data).toBe(PNG);
    expect(JSON.stringify(task)).not.toContain(PNG);
    expect(response.content[0]).toEqual({ type: "image", mimeType: "image/png", data: PNG });
    const next = store.start("read", {}, "test");
    store.finish(next.id, result("next"));
    expect(store.getImages(task.id)).toHaveLength(0);
  });

  test("图片超限不进入缓存", () => {
    const store = new ToolActivityStore();
    const task = store.start("read", {}, "test");
    store.finish(task.id, { content: [{ type: "image", mimeType: "image/png", data: "A".repeat(8 * 1024 * 1024 + 4) }] });
    expect(task.images).toBe(1);
    expect(store.getImages(task.id)).toHaveLength(0);
  });

  test("只移除终端控制序列，不脱敏可见文本", () => {
    expect(safeText("TOKEN=secret\n\x1b]52;c;BASE64\x07ok\x1b[31m")).toBe("TOKEN=secret\nok");
    expect(safeText("\x1bPignored\x1b\\visible")).toBe("visible");
  });

  test("坏监听器不影响工具，支持取消和取消订阅", () => {
    const store = new ToolActivityStore();
    store.subscribe(() => { throw new Error("bad observer"); });
    let count = 0;
    const unsubscribe = store.subscribe(() => count++);
    const task = store.start("bash", {}, "test");
    unsubscribe();
    store.finish(task.id, result("cancelled"), true);
    expect(count).toBe(1);
    expect(task.status).toBe("cancelled");
  });
});

describe("纯内存长日志", () => {
  test("分页、追随新输出、原始凭据文本，无文件路径依赖", async () => {
    const store = new ToolActivityStore();
    const task = store.start("bash", { command: "example" }, "test");
    store.update(task.id, result("HEAD\nTOKEN=test-secret\n" + "middle\n".repeat(100), { fullOutputPath: "/must/not/read" }));
    const head = await readToolLog(task, 0, 100);
    expect(head.text).toContain("TOKEN=test-secret");
    expect(head.total).toBeGreaterThan(head.end);
    expect(head).not.toHaveProperty("source");
    store.update(task.id, result(task.output + "FINAL\n"));
    const tail = await readToolLog(task, undefined, 40);
    expect(tail.text).toContain("FINAL");
    expect(tail.end).toBe(tail.total);
  });

  test("分页和内存截断不会切开 emoji 代理对", async () => {
    const store = new ToolActivityStore({ outputLimit: 20 });
    const task = store.start("read", {}, "test");
    store.finish(task.id, result("🙂".repeat(20) + "a"));
    expect(task.output.length).toBeLessThanOrEqual(20);
    expect(task.output).not.toMatch(/^[\udc00-\udfff]/);
    const text = (await readToolLog(task)).text;
    for (let i = 0; i < text.length; i++) {
      const page = await readToolLog(task, i, 5);
      expect(page.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    }
  });

  test("实际 7000 行命令输出仅在内存中；MCP 响应仍保持长度限制", async () => {
    const tool = createPiTools(["bash"], tmpdir())[0]!;
    const store = new ToolActivityStore();
    const command = "for i in {1..7000}; do printf 'line-%08d: sample output for memory pagination testing\\n' \"$i\"; done";
    const task = store.start("bash", { command }, "test");
    const output = await runPiTool(tool, { command }, undefined, (partial) => store.update(task.id, partial));
    expect(output.monitorResult).toBeDefined();
    store.finish(task.id, output.monitorResult!);
    expect(task.output).toContain("line-00000001");
    expect(task.output).toContain("line-00007000");
    expect((await readToolLog(task, 0)).text).toContain("line-00000001");
    expect((await readToolLog(task)).text).toContain("line-00007000");
    expect(JSON.stringify(output)).not.toContain("fullOutputPath");
    expect(String(output.structuredContent.output).length).toBeLessThan(52 * 1024);
    expect(task.output.length).toBeLessThanOrEqual(MEMORY_OUTPUT_CHARS);
  });

  test("隔离 TMPDIR：超长输出和 PI_TUI_WRITE_LOG 均不产生任何日志文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
    const toolPath = resolve(import.meta.dir, "../src/pi/tools.ts");
    const terminalPath = resolve(import.meta.dir, "../src/monitor/terminal.ts");
    const code = `import {createPiTools,runPiTool} from ${JSON.stringify(toolPath)};
      import {MemoryLogTerminal} from ${JSON.stringify(terminalPath)};
      const tool=createPiTools(['bash'],process.cwd())[0];
      const result=await runPiTool(tool,{command:"for i in {1..9000}; do printf 'memory-only-output-%08d-test-data\\\\n' \\\"$i\\\"; done"});
      if (!result.monitorResult) throw Error('missing monitor result');
      new MemoryLogTerminal().write('memory-terminal-check');
      console.log('PASS');`;
    try {
      const child = Bun.spawn([process.execPath, "-e", code], {
        cwd: dir,
        env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir, LOG_LEVEL: "error", PI_TUI_WRITE_LOG: join(dir, "forbidden.log") },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      expect(stdout).toContain("PASS");
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("终端与执行生命周期", () => {
  test("交互终端自动 TUI，管道和显式关闭保持普通模式", () => {
    expect(shouldUseTui("auto", true, true, "xterm")).toBe(true);
    expect(shouldUseTui("plain", true, true, "xterm")).toBe(false);
    expect(shouldUseTui("tui", false, true, "xterm")).toBe(false);
    expect(shouldUseTui("auto", true, false, "xterm")).toBe(false);
    expect(shouldUseTui("auto", true, true, "dumb")).toBe(false);
  });

  test("命令完成前产生累计快照", async () => {
    let sawPartial = false;
    const tool = createPiTools(["bash"], tmpdir())[0]!;
    const output = await runPiTool(tool, { command: "printf first; sleep 0.2; printf last" }, undefined, (partial) => {
      if (partial.structuredContent.output === "first") sawPartial = true;
    });
    expect(sawPartial).toBe(true);
    expect(output.structuredContent.output).toBe("firstlast");
  });

  test("异常观察器不会破坏命令；失败与取消仍保存已输出的内存快照", async () => {
    const tool = createPiTools(["bash"], tmpdir())[0]!;
    expect((await runPiTool(tool, { command: "printf ok" }, undefined, () => { throw Error("observer"); })).structuredContent.output).toBe("ok");
    try {
      await runPiTool(tool, { command: "printf 'TOKEN=failed-test'; exit 3" });
      throw Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryBashError);
      expect(JSON.stringify((error as MemoryBashError).monitorResult)).toContain("TOKEN=failed-test");
      expect((error as Error).message).toContain("code 3");
    }
    const controller = new AbortController();
    await expect(runPiTool(tool, { command: "printf started; sleep 5" }, controller.signal, () => controller.abort())).rejects.toThrow("Command aborted");
  });

  test("超时、非法超时和空输出", async () => {
    const tool = createPiTools(["bash"], tmpdir())[0]!;
    await expect(runPiTool(tool, { command: "sleep 5", timeout: 0.05 })).rejects.toThrow("timed out");
    await expect(runPiTool(tool, { command: "true", timeout: -1 })).rejects.toThrow("Invalid timeout");
    expect((await runPiTool(tool, { command: "true" })).structuredContent.output).toBe("(no output)");
  });
});
