// 构建时由 Bun.build 的 define 注入；源码运行时没有内嵌配置。
// 必须在读取配置、初始化 Pi 和日志模块之前执行。
// Bun 已加载启动目录的 .env，因此这里只补齐未设置的变量，绝不改变 cwd。

declare const __PI_MCP_EMBEDDED_ENV__: Record<string, string | undefined>;

/** shell / 启动目录 .env > 构建时内嵌 .env > 各模块自己的默认值。 */
export function applyEmbeddedEnv(
  defaults: Readonly<Record<string, string | undefined>>,
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [key, value] of Object.entries(defaults)) {
    // 空字符串也是用户显式设置的值，不能用 || 或 truthy 判断。
    if (env[key] === undefined && value !== undefined) env[key] = value;
  }
}

applyEmbeddedEnv(typeof __PI_MCP_EMBEDDED_ENV__ === "undefined" ? {} : __PI_MCP_EMBEDDED_ENV__);
