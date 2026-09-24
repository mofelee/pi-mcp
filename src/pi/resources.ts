// 启动时在运行机器上发现 pi 资源：skill 与项目上下文文件（AGENTS.md）。
//
// 复用 pi 自己的 DefaultResourceLoader，所以发现规则和 pi 完全一致，包括：
//   - 用户目录：~/.pi/agent/skills、settings.json 里的 skills、pi packages 自带的 skill
//   - Agent Skills 约定目录：~/.agents/skills、~/.claude/skills（通过 settings.skills 引入）
//   - 项目目录：<cwd>/.pi/skills、<cwd>/.agents/skills，并向上递归直到仓库根
//
// 这里只保存 skill 的名称/描述/路径，不读取 SKILL.md 正文——正文留给模型按需用 read 工具加载。

import {
  DefaultResourceLoader,
  getAgentDir,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { log } from "../log";
import { CWD } from "./environment";

export interface PiContextFile {
  path: string;
  content: string;
}

export interface PiResources {
  skills: Skill[];
  contextFiles: PiContextFile[];
  diagnostics: string[];
}

function formatDiagnostic(diagnostic: ResourceDiagnostic): string {
  const where = diagnostic.path ? ` (${diagnostic.path})` : "";
  return `${diagnostic.type}: ${diagnostic.message}${where}`;
}

async function discover(): Promise<PiResources> {
  const loader = new DefaultResourceLoader({
    cwd: CWD,
    agentDir: getAgentDir(),
    // 只发现 skill 和上下文文件；不加载扩展 / prompt 模板 / 主题，
    // 避免在一个 MCP server 里执行扩展代码。
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const { skills, diagnostics } = loader.getSkills();
  const contextFiles = loader.getAgentsFiles().agentsFiles.map((file) => ({
    path: file.path,
    content: file.content,
  }));

  return { skills, contextFiles, diagnostics: diagnostics.map(formatDiagnostic) };
}

async function discoverSafely(): Promise<PiResources> {
  try {
    return await discover();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("pi", `skill 发现失败，将只提供基础提示词: ${message}`);
    return { skills: [], contextFiles: [], diagnostics: [`error: ${message}`] };
  }
}

/** 启动时发现一次，之后所有请求共用 */
export const RESOURCES: PiResources = await discoverSafely();

log.info("pi", `发现 ${RESOURCES.skills.length} 个 skill、${RESOURCES.contextFiles.length} 个上下文文件`, {
  cwd: CWD,
  skills: RESOURCES.skills.map((skill) => skill.name),
});
for (const diagnostic of RESOURCES.diagnostics) log.warn("pi", `资源诊断: ${diagnostic}`);
