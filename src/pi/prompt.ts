// 构建 pi 风格的初始提示词。
//
// 这就是 pi coding agent 的 system prompt 的 MCP 版本：告诉模型自己是谁、能用哪些工具、
// 有哪些可用 skill（只给名称/描述/路径，不加载正文）、当前运行环境（系统、时间、工作目录），
// 以及项目自带的 AGENTS.md 上下文。

import {
  formatSkillsForPrompt,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
} from "@earendil-works/pi-coding-agent";
import { systemInfo, type SystemInfo } from "./environment";
import { RESOURCES } from "./resources";
import type { PiTool, PiToolName } from "./tools";

export interface InitialPromptSkill {
  name: string;
  description: string;
  path: string;
  /** true 表示只能通过显式命令调用，未列入提示词 */
  disableModelInvocation: boolean;
}

export interface InitialPromptPayload {
  /** 完整的初始提示词文本 */
  prompt: string;
  /** 运行环境（含实时时间） */
  environment: SystemInfo;
  /** 启动时发现的 skill 目录（未加载正文） */
  skills: InitialPromptSkill[];
  /** 已暴露的工具名 */
  tools: PiToolName[];
  /** 启动时加载的项目上下文文件路径 */
  contextFiles: string[];
}

function renderEnvironment(info: SystemInfo): string {
  return [
    "<environment>",
    `- Operating system: ${info.os} (${info.platform}, ${info.arch})`,
    `- Hostname: ${info.hostname}`,
    `- User: ${info.username}`,
    `- Working directory: ${info.cwd}`,
    `- Current time: ${info.time} (${info.timezone}; UTC ${info.timeUtc})`,
    `- Server started at: ${info.startedAt}`,
    `- Shell: ${info.shell}`,
    `- Runtime: ${info.runtime}`,
    `- Pi version: ${info.piVersion}`,
    "</environment>",
  ].join("\n");
}

function collectRules(tools: PiTool[]): string[] {
  const rules = new Set<string>();
  for (const tool of tools) {
    for (const guideline of tool.guidelines) rules.add(guideline.trim());
  }
  rules.add("Be concise in your responses");
  rules.add("Show file paths clearly when working with files");
  rules.add("Inspect files with the read tool before editing them.");
  return [...rules].filter(Boolean);
}

function renderProjectContext(): string | undefined {
  if (RESOURCES.contextFiles.length === 0) return undefined;
  const files = RESOURCES.contextFiles
    .map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`)
    .join("\n\n");
  return `<project_context>\nProject-specific instructions and guidelines:\n\n${files}\n</project_context>`;
}

function renderSkills(): string | undefined {
  const formatted = formatSkillsForPrompt(RESOURCES.skills, "read").trim();
  if (!formatted) return undefined;
  return `<skills>\n${formatted}\n</skills>`;
}

function renderDocs(): string {
  return [
    "<pi_docs>",
    `- Main documentation: ${getReadmePath()}`,
    `- Additional docs: ${getDocsPath()}`,
    `- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)`,
    "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
    "</pi_docs>",
  ].join("\n");
}

/** 构建完整的初始提示词文本 */
export function buildInitialPrompt(tools: PiTool[]): string {
  const sections: string[] = [];

  sections.push(
    [
      "You are Pi, an expert coding assistant exposed over the Model Context Protocol (MCP) by pi-mcp.",
      "You help users by reading files, executing commands, editing code, and writing new files directly in the working directory shown below.",
      "Use the provided tools instead of guessing file contents, and explain what you are doing briefly.",
    ].join(" "),
  );

  sections.push(
    [
      "<tools>",
      ...tools.map((tool) => `- ${tool.name}: ${tool.snippet}`),
      "</tools>",
      "In addition to the tools above, you may have access to other tools provided by the client.",
    ].join("\n"),
  );

  sections.push(
    ["<rules>", ...collectRules(tools).map((rule) => `- ${rule}`), "</rules>"].join("\n"),
  );

  const skills = renderSkills();
  if (skills) sections.push(skills);

  sections.push(renderEnvironment(systemInfo()));

  const projectContext = renderProjectContext();
  if (projectContext) sections.push(projectContext);

  sections.push(renderDocs());

  return sections.join("\n\n");
}

/** 初始提示词工具返回的结构化内容 */
export function initialPromptPayload(tools: PiTool[]): InitialPromptPayload {
  return {
    prompt: buildInitialPrompt(tools),
    environment: systemInfo(),
    skills: RESOURCES.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
    })),
    tools: tools.map((tool) => tool.name),
    contextFiles: RESOURCES.contextFiles.map((file) => file.path),
  };
}
