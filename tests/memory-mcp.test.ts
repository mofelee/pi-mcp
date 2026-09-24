import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { mcpHandler } from "../src/mcp";
import { toolActivities } from "../src/monitor/store";

// 仅调用本进程 handler，以虚构 AuthInfo 测试响应边界；不访问线上服务或真实凭据。
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await mcpHandler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), { authInfo: { token: "test-only", clientId: "memory-test", scopes: ["mcp"], extra: { subject: "memory-test" } } });
  expect(response.status).toBe(200);
  const text = await response.text();
  const payload = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
  return JSON.parse(payload).result;
}

const call = (command: string) => callTool("bash", { command });

describe("MCP 与本地内存快照分离", () => {
  test("read 图片返回独立 image 块，structuredContent 不重复 base64", async () => {
    const path = resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/docs/images/interactive-mode.png");
    const response = await callTool("read", { path });
    expect(response.isError).not.toBe(true);
    const content = response.content as Array<Record<string, unknown>>;
    const image = content.find((block) => block.type === "image")!;
    expect(image).toBeDefined();
    expect(image.mimeType).toBe("image/png");
    expect(typeof image.data).toBe("string");
    expect(Buffer.from(image.data as string, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(content.find((block) => block.type === "text")?.text).toBe("Read image file [image/png]");
    expect(response.structuredContent).toEqual({ output: "Read image file [image/png]" });
    expect(JSON.stringify(response.structuredContent)).not.toContain(image.data as string);
    expect(response).not.toHaveProperty("monitorResult");
  });
  test("最终响应不携带 monitorResult，TUI 仍保留超出响应长度的输出", async () => {
    const response = await call("for i in {1..2500}; do printf 'memory-mcp-line-%06d\\n' \"$i\"; done");
    expect(response).not.toHaveProperty("monitorResult");
    expect(JSON.stringify(response)).not.toContain("fullOutputPath");
    expect(JSON.stringify(response)).toContain("2500");
    const task = toolActivities.items.findLast((item) => item.user === "memory-test")!;
    expect(task.status).toBe("success");
    expect(task.output).toContain("memory-mcp-line-000001");
    expect(task.output).toContain("memory-mcp-line-002500");
  });

  test("失败响应格式仍正确，内存查看不会丢掉原始错误前输出", async () => {
    const response = await call("printf 'TOKEN=fake-memory-mcp'; exit 4");
    expect(response.isError).toBe(true);
    expect(response).not.toHaveProperty("monitorResult");
    expect(response).toHaveProperty("structuredContent");
    const task = toolActivities.items.findLast((item) => item.user === "memory-test")!;
    expect(task.status).toBe("error");
    expect(task.output).toContain("TOKEN=fake-memory-mcp");
    expect(task.output).toContain("code 4");
  });
});
