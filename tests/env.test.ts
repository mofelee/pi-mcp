import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEmbeddedEnv } from "../scripts/build-env";
import { applyEmbeddedEnv } from "../src/env";

const dirs: string[] = [];
async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-env-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("内嵌配置只补齐运行时缺失值", () => {
  test("已有环境变量、空值和 0 都优先于内嵌值", () => {
    const env: Record<string, string | undefined> = { PORT: "4000", EMPTY: "", FLAG: "0" };
    applyEmbeddedEnv({ PORT: "3000", EMPTY: "fallback", FLAG: "1", LOGIN_PASSWORD: "embedded", MISSING: undefined }, env);
    expect(env).toEqual({ PORT: "4000", EMPTY: "", FLAG: "0", LOGIN_PASSWORD: "embedded" });
  });

  test("重复加载不覆盖运行时修改，也不改变工作目录", () => {
    const cwd = process.cwd();
    const env: Record<string, string | undefined> = {};
    const defaults = Object.freeze({ LOGIN_PASSWORD: "first", PI_MCP_TOOLS: "read,bash" });
    applyEmbeddedEnv(defaults, env);
    env.LOGIN_PASSWORD = "later";
    applyEmbeddedEnv(defaults, env);
    expect(env.LOGIN_PASSWORD).toBe("later");
    expect(env.PI_MCP_TOOLS).toBe("read,bash");
    expect(process.cwd()).toBe(cwd);
  });
});

describe("构建时读取指定 .env", () => {
  test("支持注释、export、引号、等号、空值和多行；不展开 shell 变量", async () => {
    const file = join(await temporaryDir(), ".env");
    await writeFile(file, [
      "\uFEFF# test-only values",
      "export PORT=4123 # comment",
      "LOGIN_PASSWORD='literal # $HOME = 密码'",
      "EMPTY=",
      'MULTILINE="first\nsecond"',
      'JWK=\'{"kty":"test","n":"value=with=equals"}\'',
    ].join("\n"));
    expect(await readEmbeddedEnv(file)).toEqual({
      PORT: "4123", LOGIN_PASSWORD: "literal # $HOME = 密码", EMPTY: "",
      MULTILINE: "first\nsecond", JWK: '{"kty":"test","n":"value=with=equals"}',
    });
  });

  test("只读取指定文件，不合并同目录 .env.local 或构建进程的环境变量", async () => {
    const dir = await temporaryDir();
    await writeFile(join(dir, ".env"), "ONLY_THIS_FILE=fixture\n");
    await writeFile(join(dir, ".env.local"), "ONLY_THIS_FILE=wrong\nEXTRA=unexpected\n");
    expect(await readEmbeddedEnv(join(dir, ".env"))).toEqual({ ONLY_THIS_FILE: "fixture" });
  });

  test("默认 .env 不存在可继续；显式路径不存在必须报错", async () => {
    const file = join(await temporaryDir(), "missing.env");
    expect(await readEmbeddedEnv(file, true)).toEqual({});
    await expect(readEmbeddedEnv(file)).rejects.toHaveProperty("code", "ENOENT");
  });

  test("optional 不吞掉目录误用等非 ENOENT 错误", async () => {
    await expect(readEmbeddedEnv(await temporaryDir(), true)).rejects.toHaveProperty("code", "EISDIR");
  });
});
