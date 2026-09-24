#!/usr/bin/env bun
/**
 * 把 pi-mcp 打包成单文件可执行程序。
 *
 *   bun run build                              # 当前平台
 *   bun run build -- --target=bun-linux-x64     # 交叉编译
 *   bun run build -- --tar                      # 额外产出 .tar.gz
 *   bun run build -- --outdir=/tmp/pi-mcp-build  # 指定独立输出目录
 *   bun run build -- --embed-env=/path/to/.env   # 指定要内嵌的配置
 *   bun run build -- --no-embed-env             # 不内嵌配置（用于分发）
 *
 * 产物目录 dist/：
 *   pi-mcp                 可执行程序（Windows 下为 pi-mcp.exe）
 *   pi-runtime/            pi 的 package.json / README / docs / examples
 *                          由 src/pi/runtime-dir.ts 通过 PI_PACKAGE_DIR 指向，
 *                          保证初始提示词里的文档路径与版本号在编译后依然正确
 *   photon_rs_bg.wasm      图片缩放所需 wasm，必须与可执行文件同目录
 *   .env                   不再生成；已有文件仍保留，可覆盖内嵌配置
 *   .env.example           配置模板
 *   README.md              pi-mcp 说明
 *
 * 运行时从「哪个目录启动」决定工作目录，所以建议：
 *   1. 把 dist/ 里的可执行文件与 photon_rs_bg.wasm、pi-runtime/ 放在一起部署；
 *   2. 直接在目标工作目录启动；默认内嵌仓库根目录 .env，无需复制配置。
 *      启动目录的 .env 和显式环境变量仍可覆盖内嵌值。
 *
 * 注意：内嵌配置不是加密；含凭据的二进制应按凭据文件保管。
 */

import { $ } from "bun";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { readEmbeddedEnv } from "./build-env";
import { MIN_CHARACTER_CLASSES, MIN_PASSWORD_LENGTH, passwordWeaknesses } from "../src/password-policy";
import { baseUrlProblem, parseBaseUrl } from "../src/url-policy";

const ROOT = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const outputArg = args.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length);
const DIST = outputArg ? path.resolve(outputArg) : path.join(ROOT, "dist");
if (DIST === ROOT) throw new Error("构建目录不能是项目根目录");
const ENTRY = path.join(ROOT, "index.ts");
const PI_PACKAGE = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const PHOTON_WASM = path.join(ROOT, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm");

/** 复制到 pi-runtime/ 的 pi 资源 */
const PI_RUNTIME_ENTRIES = ["package.json", "README.md", "CHANGELOG.md", "docs", "examples"];

const embedEnvArg = args.find((arg) => arg.startsWith("--embed-env="))?.slice("--embed-env=".length);
const noEmbedEnv = args.includes("--no-embed-env");
if (embedEnvArg === "") throw new Error("--embed-env 需要指定文件路径");
if (noEmbedEnv && embedEnvArg !== undefined) throw new Error("--embed-env 与 --no-embed-env 不能同时使用");
const embedEnvPath = embedEnvArg === undefined ? path.join(ROOT, ".env") : path.resolve(embedEnvArg);

const targetArg = args.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
const buildTar = args.includes("--tar");

/** 交叉编译目标；未指定则用当前平台 */
const platform = targetArg?.replace(/^bun-/, "") ?? `${process.platform}-${process.arch}`;
const binaryName = platform.startsWith("windows") ? "pi-mcp.exe" : "pi-mcp";
const binaryPath = path.join(DIST, binaryName);

function step(message: string): void {
  console.log(`\n\x1b[36m▸\x1b[0m ${message}`);
}

function note(message: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${message}`);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 检查打包所需的前置文件是否齐全 */
function assertSources(): void {
  const missing = [
    [ENTRY, "入口 index.ts"],
    [path.join(PI_PACKAGE, "package.json"), "pi-coding-agent 依赖（先运行 bun install）"],
    [PHOTON_WASM, "photon-node wasm（先运行 bun install）"],
    [path.join(ROOT, ".env.example"), ".env.example"],
  ].filter(([file]) => !existsSync(file as string));

  if (missing.length > 0) {
    for (const [file, label] of missing) console.error(`  \x1b[31m✗\x1b[0m 缺少 ${label}: ${file}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  assertSources();

  step("读取内嵌配置");
  const embeddedEnv = noEmbedEnv ? {} : await readEmbeddedEnv(embedEnvPath, embedEnvArg === undefined);
  const embeddedKeys = Object.keys(embeddedEnv).length;
  if (embeddedKeys) {
    note(`将 ${embedEnvPath} 的 ${embeddedKeys} 项配置内嵌为默认值（运行时仍可覆盖）`);
    console.warn("  注意：内嵌配置不是加密；请勿公开分发含密码或 token 的二进制。");
  } else {
    note(noEmbedEnv ? "已禁用配置内嵌" : "没有可内嵌的配置，使用运行时配置或程序默认值");
  }

  step("检查登录密码强度");
  // 内嵌的密码会随二进制一起分发；弱密码等于把 shell 公开发布，直接停止构建。
  const embeddedPassword = embeddedEnv.LOGIN_PASSWORD?.trim();
  const allowWeakPassword = process.env.PI_MCP_ALLOW_WEAK_PASSWORD === "1";
  if (!embeddedPassword) {
    note("未内嵌 LOGIN_PASSWORD，跳过构建期检查（运行时仍会校验）");
  } else if (allowWeakPassword) {
    console.warn("  \x1b[33m!\x1b[0m 已通过 PI_MCP_ALLOW_WEAK_PASSWORD=1 跳过弱密码检查，切勿用于公网。");
  } else {
    const weaknesses = passwordWeaknesses(embeddedPassword);
    if (weaknesses.length > 0) {
      console.error("\n\x1b[31m✗ 构建已停止：内嵌的 LOGIN_PASSWORD 过弱\x1b[0m");
      for (const reason of weaknesses) console.error(`  · ${reason}`);
      console.error(`  要求：至少 ${MIN_PASSWORD_LENGTH} 位，且覆盖至少 ${MIN_CHARACTER_CLASSES} 类字符。`);
      console.error("  生成强密码：openssl rand -base64 24");
      console.error(`  或改用 ${embedEnvPath} 之外的运行时配置；本地开发确需弱密码时设置 PI_MCP_ALLOW_WEAK_PASSWORD=1。`);
      process.exit(1);
    }
    note("LOGIN_PASSWORD 强度检查通过");
  }

  step("检查 BASE_URL");
  // 内嵌的 BASE_URL 会成为 OAuth issuer；公网明文 http 直接停止构建。
  const embeddedBaseUrl = embeddedEnv.BASE_URL?.trim();
  const allowInsecureBaseUrl = process.env.PI_MCP_ALLOW_INSECURE_BASE_URL === "1";
  if (!embeddedBaseUrl) {
    note("未内嵌 BASE_URL，跳过构建期检查（运行时仍会校验）");
  } else {
    const problem = baseUrlProblem(embeddedBaseUrl, allowInsecureBaseUrl);
    if (problem) {
      console.error("\n\x1b[31m✗ 构建已停止：内嵌的 BASE_URL 不可用\x1b[0m");
      console.error(`  · ${problem}`);
      if (!allowInsecureBaseUrl) {
        console.error("  公网地址必须是 https（需要 TLS 终止）；仅内网/隧道调试可用 PI_MCP_ALLOW_INSECURE_BASE_URL=1。");
      }
      process.exit(1);
    }
    const parsed = parseBaseUrl(embeddedBaseUrl);
    if (parsed.ok && parsed.insecure) {
      console.warn("  \x1b[33m!\x1b[0m 已放行明文 http 的 BASE_URL，切勿用于公网。");
    } else {
      note("BASE_URL 检查通过");
    }
  }

  step(`编译 ${binaryName}（${platform}）`);
  // 保留已有 .env 和 OAuth 状态，不再清空整个部署目录。
  await mkdir(DIST, { recursive: true });

  // 使用 API 在内存中注入默认值，不写含密钥的生成源码，也不通过命令行参数传递。
  // 不 define process.env.KEY，否则会把运行时覆盖也常量折叠掉。
  const result = await Bun.build({
    entrypoints: [ENTRY],
    root: ROOT,
    target: "bun",
    compile: {
      ...(targetArg ? { target: targetArg as Bun.Build.CompileTarget } : {}),
      outfile: binaryPath,
      autoloadDotenv: true,
      autoloadBunfig: false,
    },
    define: { __PI_MCP_EMBEDDED_ENV__: JSON.stringify(embeddedEnv) },
  });
  if (!result.success) throw new AggregateError(result.logs, "二进制编译失败");
  note(`${binaryName} ${megabytes((await stat(binaryPath)).size)}`);

  step("复制 pi 运行时资源与图片 wasm");
  await cp(PHOTON_WASM, path.join(DIST, "photon_rs_bg.wasm"));
  note("photon_rs_bg.wasm");

  const runtimeDir = path.join(DIST, "pi-runtime");
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  for (const entry of PI_RUNTIME_ENTRIES) {
    const from = path.join(PI_PACKAGE, entry);
    if (!existsSync(from)) continue;
    await cp(from, path.join(runtimeDir, entry), { recursive: true });
  }
  // 编译版 getThemesDir() 指向 PI_PACKAGE_DIR/theme，工具卡片需要内置主题。
  const themeDir = path.join(runtimeDir, "theme");
  await mkdir(themeDir, { recursive: true });
  for (const name of ["dark.json", "light.json"]) {
    await cp(path.join(PI_PACKAGE, "dist", "modes", "interactive", "theme", name), path.join(themeDir, name));
  }
  note(`pi-runtime/（${PI_RUNTIME_ENTRIES.join(", ")}、theme/）`);

  step("写入配置与说明");
  // 只复制模板；实际配置已经内嵌，不额外输出明文 .env。
  await cp(path.join(ROOT, ".env.example"), path.join(DIST, ".env.example"));
  note(".env.example");

  const envPath = path.join(DIST, ".env");
  if (existsSync(envPath)) {
    note(".env 已存在，保持不变");
  } else {
    note("无需生成 .env，二进制已携带默认配置");
  }

  await cp(path.join(ROOT, "README.md"), path.join(DIST, "README.md"));
  note("README.md");

  if (buildTar) {
    step("打包 tar.gz");
    const archiveName = `pi-mcp-${platform}.tar.gz`;
    // 不把部署目录已有的明文 .env 或 OAuth 状态意外收入发布包。
    const entries = [binaryName, "pi-runtime", "photon_rs_bg.wasm", ".env.example", "README.md"];
    await $`tar -czf ${path.join(DIST, archiveName)} -C ${DIST} ${entries}`.cwd(ROOT);
    note(`${archiveName} ${megabytes((await stat(path.join(DIST, archiveName))).size)}`);
  }

  console.log(`\n\x1b[32m打包完成\x1b[0m → ${path.relative(process.cwd(), DIST) || "."}/${binaryName}`);

  if (targetArg && platform !== `${process.platform}-${process.arch}`) {
    console.log(
      `\x1b[33m注意\x1b[0m：这是 ${platform} 的交叉编译产物，当前机器（${process.platform}-${process.arch}）无法直接运行。`,
    );
  } else {
    console.log(`\n启动：cd /path/to/workspace && ${JSON.stringify(binaryPath)}`);
    console.log("提示：工作目录取启动时的 cwd；无需复制 .env，也可设置 PI_MCP_CWD 显式覆盖。");
    console.log("配置优先级：显式环境变量 > 启动目录 .env > 内嵌配置 > 程序默认值。");
  }
}

await main();
