import { describe, expect, spyOn, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { log } from "../src/log";
import { BASH_COMMAND_PREVIEW_CHARS, parsePreviewChars, textPreview, toolLogFields } from "../src/tool-log";
import { terminalText } from "../src/log-policy";

const result = (output: string): CallToolResult => ({
  content: [{ type: "text", text: output }],
  structuredContent: { output },
});

// 全部使用虚构测试内容，不读取本机真实凭据，也不连接正在运行的服务。
describe("预览配置与截断", () => {
  test("默认值、关闭开关、上限和非法配置", () => {
    expect(parsePreviewChars(undefined)).toBe(0);
    expect(parsePreviewChars("0")).toBe(0);
    expect(parsePreviewChars(" 80 ")).toBe(80);
    expect(parsePreviewChars("99999")).toBe(1000);
    for (const value of ["", "-1", "NaN", "abc", "1.5", "Infinity"]) {
      expect(parsePreviewChars(value)).toBe(0);
    }
  });

  test("字符限制包含省略号，不截断 Unicode 码点", () => {
    const preview = textPreview("😀中文".repeat(100), 20)!;
    expect(Array.from(preview)).toHaveLength(20);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toContain("\uFFFD");
    expect(textPreview("abc", 1)).toBe("…");
  });

  test("最多前三行，压成单行，不输出后续行", () => {
    expect(textPreview("一\r\n二\n三\r四", 160)).toBe("一 ↵ 二 ↵ 三…");
    expect(textPreview("\x1b[31mhello\x1b[0m\tworld\u0000", 160)).toBe("hello world");
    expect(textPreview("", 160)).toBeUndefined();
    expect(textPreview("hello", 0)).toBeUndefined();
  });
});

describe("不按敏感内容脱敏", () => {
  test("配置、JSON、请求头和命令行凭据保持原始可见文字", () => {
    const cases = [
      "LOGIN_PASSWORD=test-only-password",
      '"access_token": "test-only-token"',
      '"apiKey":"test-only-key"',
      "Authorization: Bearer test-only-bearer",
      "--password 'test-only password with spaces'",
      "https://user:test-only-password@example.test/path",
    ];
    for (const text of cases) {
      expect(terminalText(text)).toBe(text);
    }
    expect(textPreview(`token=${"x".repeat(300)}`, 20)).toContain("xxxx");
  });

  test("文件路径不触发隐藏规则", () => {
    for (const path of [".env", ".env.local", ".oauth-jwk.json", ".oauth-store.json", "credentials", "cert.pem", "src/config.ts"]) {
      expect(toolLogFields("read", { path }, result("TOKEN=test-only"), 160).preview).toBe("TOKEN=test-only");
    }
  });

  test("显式请求摘要时保留敏感正文；默认文件日志只含元数据", () => {
    const read = toolLogFields("read", { path: ".env" }, result("arbitrary-unlabelled-secret"), 160);
    expect(read.path).toBe(".env");
    expect(read.preview).toBe("arbitrary-unlabelled-secret");
    expect(toolLogFields("read", { path: ".env" }, result("arbitrary-unlabelled-secret"))).not.toHaveProperty("preview");
    const write = toolLogFields("write", { path: ".oauth-store.json", content: "hidden-input" }, result("hidden-output"), 160);
    expect(write.inputPreview).toBe("hidden-input");
    expect(write.preview).toBe("hidden-output");
    const bash = toolLogFields("bash", { command: "cat .env" }, result("hidden-output"), 160);
    expect(bash.command).toBe("cat .env");
    expect(bash.preview).toBe("hidden-output");
  });
});

describe("工具字段", () => {
  test("读取日志含文件名、起始行、读取上限、输出长度和内容片段", () => {
    const output = "const answer = 42;\nexport { answer };";
    const args = { path: "src/example.ts", offset: 10, limit: 20 };
    const response = result(output);
    const original = JSON.stringify({ args, response });
    expect(toolLogFields("read", args, response, 160)).toEqual({
      path: "src/example.ts", offset: 10, limit: 20,
      outputChars: output.length, preview: "const answer = 42; ↵ export { answer };",
    });
    expect(JSON.stringify({ args, response })).toBe(original);
    expect(toolLogFields("read", { path: "README.md" }, result(""), 160)).toEqual({ path: "README.md", offset: 1, outputChars: 0 });
  });

  test("写文件显示短输入；编辑只显示修改数量和结果，不转储 diff", () => {
    const write = toolLogFields("write", { path: "a.ts", content: "export const a = 1;" }, result("written"), 160);
    expect(write.inputChars).toBe(19);
    expect(write.inputPreview).toBe("export const a = 1;");
    const edit = toolLogFields("edit", { path: "a.ts", edits: [{ oldText: "old-full-body", newText: "new-full-body" }] }, { ...result("replaced"), structuredContent: { output: "replaced", details: { diff: "large-diff-body" } } }, 160);
    expect(edit.edits).toBe(1);
    expect(edit.preview).toBe("replaced");
    expect(JSON.stringify(edit)).not.toMatch(/old-full-body|new-full-body|large-diff-body/);
  });

  test("命令和搜索日志带上有用的参数", () => {
    const bash = toolLogFields("bash", { command: "bun run typecheck", timeout: 30 }, result("ok"), 160);
    expect(bash.command).toBe("bun run typecheck");
    expect(bash.timeout).toBe(30);
    const grep = toolLogFields("grep", { pattern: "createServer", glob: "*.ts", limit: 5 }, result("src/server.ts:1"), 160);
    expect(grep).toMatchObject({ path: ".", pattern: "createServer", glob: "*.ts", limit: 5 });
  });

  test("bash 默认显示命令及长度，运行中、完成和失败均不展开输出", () => {
    const args = { command: "printf 'TOKEN=test-visible'", timeout: 30 };
    for (const response of [undefined, result("hidden-output"), { ...result("hidden-error"), isError: true }]) {
      const fields = toolLogFields("bash", args, response);
      expect(fields.command).toBe(args.command);
      expect(fields.commandChars).toBe(args.command.length);
      expect(fields.timeout).toBe(30);
      expect(fields).not.toHaveProperty("preview");
      expect(Object.keys(fields)[0]).toBe("command");
    }
  });

  test("bash 长命令截断、多行压缩、Unicode 与控制字符处理不改变原参数", () => {
    const args = { command: `printf '${"🙂中文".repeat(100)}'\nprintf COMMAND-TAIL` };
    const original = args.command;
    const fields = toolLogFields("bash", args);
    const preview = fields.command as string;
    expect(Array.from(preview)).toHaveLength(BASH_COMMAND_PREVIEW_CHARS);
    expect(preview).toStartWith("printf '");
    expect(preview).toEndWith("…");
    expect(preview).not.toContain("COMMAND-TAIL");
    expect(preview).not.toContain("\uFFFD");
    expect(fields.commandChars).toBe(original.length);
    expect(args.command).toBe(original);
    expect(toolLogFields("bash", { command: "echo one\necho two\necho three\necho four" }).command)
      .toBe("echo one ↵ echo two ↵ echo three…");
    expect(toolLogFields("bash", { command: "\x1b[31mecho\x1b[0m\t你好\u0000" }).command).toBe("echo 你好");
    expect(toolLogFields("bash", { command: "" })).toEqual({ commandChars: 0 });
    expect(toolLogFields("bash", {})).toEqual({});
  });

  test("失败结果同样保留路径并截断错误内容", () => {
    const fields = toolLogFields("read", { path: "missing.ts" }, { isError: true, content: [{ type: "text", text: "ENOENT: ".repeat(100) }] }, 40);
    expect(fields.path).toBe("missing.ts");
    expect(Array.from(fields.preview as string)).toHaveLength(40);
    expect(fields.preview).toContain("ENOENT");
  });

  test("图片只记录数量，绝不序列化 base64", () => {
    const fields = toolLogFields("read", { path: "photo.png" }, {
      content: [{ type: "image", data: "fake-base64-image-data", mimeType: "image/png" }],
      structuredContent: { output: "" },
    }, 160);
    expect(fields.images).toBe(1);
    expect(JSON.stringify(fields)).not.toContain("fake-base64");
  });

  test("普通日志中初始提示词只输出长度，正文留在 TUI 内存", () => {
    const fields = toolLogFields("pi_initial_prompt", {}, {
      content: [{ type: "text", text: "private-full-prompt" }],
      structuredContent: { prompt: "private-full-prompt", skills: [{ name: "a" }], contextFiles: ["AGENTS.md"] },
    });
    expect(fields).toEqual({ outputChars: "private-full-prompt".length });
  });

  test("关闭正文预览仍保留 bash 命令摘要，其他正文继续折叠", () => {
    const read = toolLogFields("read", { path: "a.ts" }, result("file-body"), 0);
    expect(read).toEqual({ path: "a.ts", offset: 1, outputChars: 9 });
    const write = toolLogFields("write", { path: "a.ts", content: "write-body" }, result("written"), 0);
    expect(write).not.toHaveProperty("inputPreview");
    expect(write).not.toHaveProperty("preview");
    const bash = toolLogFields("bash", { command: "echo command-body" }, result("output-body"), 0);
    expect(bash.command).toBe("echo command-body");
    expect(bash.commandChars).toBe("echo command-body".length);
    expect(bash).not.toHaveProperty("preview");
  });

  test("日志字段中的换行、引号和控制字符不会变成额外日志行", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      log.error("test", "tools/call read", { path: "a\nb\t\"c\"\u0000", list: ["d\ne"] });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = (spy.mock.calls[0]![0] as string).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\u0000");
      expect(line).toContain('path="a\\nb\\t\\"c\\"\\u0000"');
    } finally {
      spy.mockRestore();
    }
  });
});
