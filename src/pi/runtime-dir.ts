// 让 pi 的运行时资源在「编译成单文件可执行程序」后依然能被找到。
//
// pi 的 getPackageDir() 在 Bun 编译产物里会退化成「可执行文件所在目录」，
// 于是 getReadmePath()/getDocsPath()/getExamplesPath() 以及 VERSION 都会指向 dist/ 根下，
// 打包脚本又不好把 pi 的 README.md 放在那里（会和 pi-mcp 自己的 README 打架）。
//
// 所以打包时把 pi 的运行时资源放到 dist/pi-runtime/，这里在 pi 模块被加载之前
// 把 PI_PACKAGE_DIR 指过去。pi 的 getPackageDir() 会优先读取这个环境变量。
//
// 注意：必须早于任何 @earendil-works/pi-coding-agent 的导入求值，
// 因此 index.ts 在加载环境配置后、其它业务模块前引入（ESM 按 import 声明顺序求值）。

import { existsSync } from "node:fs";
import path from "node:path";

/** 打包脚本使用的运行时资源目录名（与可执行文件同级） */
export const PI_RUNTIME_DIR_NAME = "pi-runtime";

function activate(): void {
  // 用户显式指定时不要覆盖
  if (process.env.PI_PACKAGE_DIR) return;

  const candidate = path.join(path.dirname(process.execPath), PI_RUNTIME_DIR_NAME);
  // 开发模式（bun run）下 execPath 是 bun 本身，不会误命中
  if (!existsSync(path.join(candidate, "package.json"))) return;

  process.env.PI_PACKAGE_DIR = candidate;
}

activate();
