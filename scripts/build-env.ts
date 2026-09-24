import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

/** 只读取指定文件，不把构建机器的 process.env 或其它 .env.* 意外打进二进制。 */
export async function readEmbeddedEnv(
  file: string,
  optional = false,
): Promise<Record<string, string | undefined>> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return parseEnv(content);
}
