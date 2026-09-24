// MCP Server（Streamable HTTP）。
//
// 关键：OpenAI 的 ChatGPT 连接器要求「tool 级 OAuth 信号」才会弹出授权 UI：
//   1. 每个需要授权的 tool 在 tools/list 里声明 securitySchemes
//      （OpenAI 扩展字段，MCP 规范和当前 SDK 都没有，所以这里用底层 Server 手写）
//   2. 未授权时 tools/call 返回 isError + _meta["mcp/www_authenticate"]
//
// 因此 /mcp 允许匿名 initialize / tools/list，只有真正调用 tool 时才要求 token。
// 参考 https://developers.openai.com/plugins/build/auth

import {
  Server,
  createMcpHandler,
  type AuthInfo,
  type CallToolResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { RESOURCE, SCOPES } from "./config";
import { SCHEMA_DIALECT } from "./json-schema";
import { log } from "./log";
import { toolLogFields } from "./tool-log";
import { toolActivities } from "./monitor/store";
import { initialPromptPayload } from "./pi/prompt";
import { PI_TOOLS } from "./pi/registry";
import { runPiTool } from "./pi/tools";
import { MemoryBashError } from "./pi/memory-bash";
import { serviceShutdown } from "./lifecycle";
import { SERVER_NAME, SERVER_VERSION } from "./version";

// ---------------------------------------------------------------------------
// OpenAI 扩展：securitySchemes / mcp/www_authenticate
// ---------------------------------------------------------------------------

type SecurityScheme =
  | { type: "noauth" }
  | { type: "oauth2"; scopes: string[] };

/** 未授权时返回的 WWW-Authenticate challenge，ChatGPT 靠它触发授权 UI */
const WWW_AUTHENTICATE = [
  `Bearer resource_metadata="${RESOURCE.replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource/mcp"`,
  `error="insufficient_scope"`,
  `error_description="You need to login to continue"`,
].join(", ");

const OAUTH_SCHEME: SecurityScheme = { type: "oauth2", scopes: [...SCOPES] };

function unauthenticatedResult(reason: string): CallToolResult {
  log.warn("mcp", "拒绝未授权调用", { reason });
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "Authentication required: no valid access token was provided.",
      },
    ],
    _meta: {
      // 这一半 + tools/list 里的 securitySchemes，共同触发 ChatGPT 的授权 UI
      "mcp/www_authenticate": [WWW_AUTHENTICATE],
    },
  };
}

// ---------------------------------------------------------------------------
// JSON Schema 辅助
// ---------------------------------------------------------------------------

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return { $schema: SCHEMA_DIALECT, ...rest };
}

// ---------------------------------------------------------------------------
// Tool 定义
// ---------------------------------------------------------------------------

// monitorResult 仅供本地内存界面使用，在返回 MCP 前显式移除。
type MonitoredToolResult = CallToolResult & { monitorResult?: CallToolResult };

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: Record<string, boolean>;
  /** OpenAI 扩展：告诉 ChatGPT 这个 tool 需要什么认证 */
  securitySchemes: SecurityScheme[];
  /** OpenAI 扩展：标记为账号 profile tool（ChatGPT 用它显示“已连接的账号”） */
  openaiProfile?: boolean;
  /**
   * 是否需要登录。为 false 时匿名也能调用（对应 securitySchemes: [{type:'noauth'}]）。
   */
  requiresAuth: boolean;
  /**
   * 声明了 outputSchema 的工具，在抛错时也要给出匹配 schema 的 structuredContent，
   * 否则严格校验的客户端会报格式错误。
   */
  errorStructuredContent?: (message: string) => Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ServerContext, onUpdate?: (result: CallToolResult) => void) => MonitoredToolResult | Promise<MonitoredToolResult>;
};

function currentAuth(ctx: ServerContext): AuthInfo | undefined {
  return ctx.http?.authInfo;
}

/**
 * OpenAI profile tool 要求的响应结构（additionalProperties: false）。
 *
 * ChatGPT 只有看到这种形状的 tool（再配合 _meta["openai/profile"]: true）
 * 才会把它当成“账号 profile”并在连接器里显示当前登录的账号。
 */
const PROFILE_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: SCHEMA_DIALECT,
  type: "object",
  properties: {
    id: {
      type: "string",
      minLength: 1,
      pattern: "\\S",
      description:
        "Opaque profile identifier, unique within this app and unchanged across token refresh, reconnection, and display-metadata changes.",
    },
    name: { type: "string", description: "Display name for the authenticated profile." },
    email: { type: "string", description: "Email address for display; not used as the profile identity." },
    nickname: { type: "string", description: "A useful label that helps users distinguish connected profiles." },
  },
  required: ["id"],
  additionalProperties: false,
};

// 除 pi 自带工具（下面按 PI_TOOLS 追回）之外，只额外暴露一个 whoami（OpenAI profile tool）。
const tools: ToolDefinition[] = [
  {
    name: "whoami",
    title: "Who am I",
    description:
      "Use this when the user wants to know which account the MCP connection is authenticated as. " +
      "Returns the stable profile id for the current credentials.",
    inputSchema: jsonSchema(z.object({})),
    outputSchema: PROFILE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [OAUTH_SCHEME],
    openaiProfile: true,
    requiresAuth: true,
    handler: (_args, ctx) => {
      const auth = currentAuth(ctx);
      // id 必须稳定：同一用户在不同 token / 重连后都要一致，这里用 token 的 sub
      const profile = {
        id: String(auth?.extra?.subject ?? auth?.clientId ?? "unknown"),
        name: String(auth?.extra?.name ?? auth?.extra?.subject ?? "Authenticated user"),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(profile) }],
        structuredContent: profile,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// pi coding agent：初始提示词 + 内置工具
// ---------------------------------------------------------------------------

// 只读工具，用于给 ChatGPT 之类的客户端标注 annotations
const READ_ONLY_PI_TOOLS = new Set(["read", "grep", "find", "ls"]);

const INITIAL_PROMPT_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: SCHEMA_DIALECT,
  type: "object",
  properties: {
    prompt: { type: "string", description: "完整的初始提示词文本。" },
    environment: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        platform: { type: "string" },
        os: { type: "string" },
        arch: { type: "string" },
        hostname: { type: "string" },
        username: { type: "string" },
        shell: { type: "string" },
        runtime: { type: "string" },
        piVersion: { type: "string" },
        timezone: { type: "string" },
        time: { type: "string" },
        timeUtc: { type: "string" },
        startedAt: { type: "string" },
      },
      required: ["cwd", "platform", "os", "arch", "time", "timezone"],
      additionalProperties: false,
    },
    skills: {
      type: "array",
      description: "启动时发现的 skill 目录；只包含名称/描述/路径，不包含正文。",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          path: { type: "string" },
          disableModelInvocation: { type: "boolean" },
        },
        required: ["name", "description", "path", "disableModelInvocation"],
        additionalProperties: false,
      },
    },
    tools: { type: "array", items: { type: "string" } },
    contextFiles: { type: "array", items: { type: "string" } },
  },
  required: ["prompt", "environment", "skills", "tools", "contextFiles"],
  additionalProperties: false,
};

const initialPromptTool: ToolDefinition = {
  name: "pi_initial_prompt",
  title: "Pi initial prompt",
  description:
    "Call this tool first, before any other tool, to load Pi's initial system prompt. " +
    "It returns the working directory, operating system, current time, the available pi tools, " +
    "and the catalog of skills discovered on this machine (name, description, and SKILL.md path only — " +
    "skill contents are NOT loaded; use the read tool to load a SKILL.md when a task matches its description). " +
    "Call it again whenever you need the current time or the skill catalog.",
  inputSchema: jsonSchema(z.object({})),
  outputSchema: INITIAL_PROMPT_OUTPUT_SCHEMA,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: [OAUTH_SCHEME],
  requiresAuth: true,
  handler: () => {
    const payload = initialPromptPayload(PI_TOOLS);
    return {
      content: [{ type: "text", text: payload.prompt }],
      structuredContent: payload as unknown as Record<string, unknown>,
    };
  },
};

const piToolDefinitions: ToolDefinition[] = PI_TOOLS.map((piTool) => ({
  name: piTool.name,
  title: piTool.label,
  description: piTool.description,
  inputSchema: piTool.inputSchema,
  outputSchema: piTool.outputSchema,
  annotations: {
    readOnlyHint: READ_ONLY_PI_TOOLS.has(piTool.name),
    destructiveHint: !READ_ONLY_PI_TOOLS.has(piTool.name),
    openWorldHint: piTool.name === "bash",
  },
  securitySchemes: [OAUTH_SCHEME],
  requiresAuth: true,
  // 输出 schema 是 { output: string }，错误文本同样能放进去
  errorStructuredContent: (message) => ({ output: message }),
  async handler(args, ctx, onUpdate) {
    const result = await runPiTool(piTool, args, ctx.http?.req?.signal, (partial) => onUpdate?.({
      content: partial.content as CallToolResult["content"], structuredContent: partial.structuredContent,
    }));
    // 声明了 outputSchema 就必须返回 structuredContent，否则客户端会报格式错误
    return {
      content: result.content as CallToolResult["content"],
      structuredContent: result.structuredContent,
      monitorResult: result.monitorResult,
    };
  },
}));

tools.push(initialPromptTool, ...piToolDefinitions);

// 对外暴露的 tools/list 描述符（含 OpenAI 扩展字段）
function toolDescriptors(): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: tool.annotations,
    securitySchemes: tool.securitySchemes,
    ...(tool.openaiProfile ? { _meta: { "openai/profile": true } } : {}),
  }));
}

// ---------------------------------------------------------------------------
// 构建 Server
// ---------------------------------------------------------------------------

function buildServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Pi coding agent exposed over MCP. Call the `pi_initial_prompt` tool first to load the initial " +
        "system prompt (working directory, environment, available tools and skills), then use the " +
        "read/bash/edit/write/grep tools to work inside that working directory. " +
        "Tools require an OAuth 2.1 access token.",
    },
  );

  server.setRequestHandler("tools/list", () => {
    log.debug("mcp", "tools/list", { tools: tools.map((t) => t.name).join(",") });
    return { tools: toolDescriptors() } as never;
  });

  server.setRequestHandler("tools/call", async (request, ctx: ServerContext) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      log.warn("mcp", `未知工具 ${request.params.name}`);
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      } satisfies CallToolResult;
    }

    const auth = currentAuth(ctx);

    if (tool.requiresAuth && !auth) {
      const result = unauthenticatedResult(`${tool.name}: 缺少 access token`);
      return result;
    }

    const scopes = auth?.scopes ?? [];
    const missing = tool.securitySchemes
      .filter((s): s is { type: "oauth2"; scopes: string[] } => s.type === "oauth2")
      .flatMap((s) => s.scopes)
      .filter((scope) => !scopes.includes(scope));
    if (tool.requiresAuth && missing.length > 0) {
      log.warn("mcp", `拒绝 ${tool.name}：缺 scope`, { user: auth?.extra?.subject, missing });
      return {
        ...unauthenticatedResult(`${tool.name}: 缺少 scope ${missing.join(",")}`),
        content: [
          { type: "text", text: `Authentication required: missing scope(s) ${missing.join(", ")}.` },
        ],
      } satisfies CallToolResult;
    }

    const started = performance.now();
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const activity = toolActivities.start(tool.name, args, String(auth?.extra?.subject ?? "anonymous"));
    try {
      const { monitorResult, ...result } = await tool.handler(args, ctx, (partial) => toolActivities.update(activity.id, partial));
      toolActivities.finish(activity.id, monitorResult ?? result, ctx.http?.req?.signal.aborted || serviceShutdown.signal.aborted);
      log.info("mcp", `tools/call ${tool.name}`, {
        user: auth?.extra?.subject ?? "anonymous",
        ms: (performance.now() - started).toFixed(0),
        error: result.isError ? "yes" : undefined,
        ...toolLogFields(tool.name, args, result),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toolActivities.finish(activity.id, {
        isError: true,
        content: error instanceof MemoryBashError ? error.monitorResult.content as CallToolResult["content"] : [{ type: "text", text: message }],
        ...(error instanceof MemoryBashError ? { structuredContent: { details: error.monitorResult.details } } : {}),
      }, ctx.http?.req?.signal.aborted || serviceShutdown.signal.aborted);
      log.error("mcp", `tools/call ${tool.name}`, {
        user: auth?.extra?.subject ?? "anonymous",
        ms: (performance.now() - started).toFixed(0),
        error: "yes",
        ...toolLogFields(tool.name, args, {
          isError: true,
          content: [{ type: "text", text: message }],
        }),
      });
      const structured = tool.errorStructuredContent?.(message);
      return {
        isError: true,
        content: [{ type: "text", text: `Tool execution failed: ${message}` }],
        ...(structured ? { structuredContent: structured } : {}),
      } satisfies CallToolResult;
    }
  });

  return server;
}

export const mcpHandler = createMcpHandler(buildServer);

export const mcpEndpoint = RESOURCE;
