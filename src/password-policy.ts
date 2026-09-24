// 登录密码强度策略。
//
// pi-mcp 用「一个共享密码换一个 session」，而 session 能调用 bash / read /
// write / edit，等价于把 shell 暴露到网上。弱密码 = 任何人都能拿到 RCE，
// 因此默认在「构建」和「启动」两处硬性阻止，只有显式设置
// PI_MCP_ALLOW_WEAK_PASSWORD=1 才放行（仅供本地开发/测试）。
//
// 本模块不读取环境变量、不产生副作用，方便单测。

/** 密码最短长度。 */
export const MIN_PASSWORD_LENGTH = 12;

/** 至少需要覆盖的字符类别数（小写 / 大写 / 数字 / 符号或其它字符）。 */
export const MIN_CHARACTER_CLASSES = 3;

/** 已知弱密码清单（比较前统一转小写）。 */
const COMMON_WEAK_PASSWORDS: ReadonlySet<string> = new Set([
  "pi-mcp",
  "pi_mcp",
  "pimcp",
  "password",
  "passwd",
  "pass",
  "p@ssword",
  "p@ssw0rd",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "111111",
  "000000",
  "654321",
  "abcdef",
  "abc123",
  "qwerty",
  "qwertyuiop",
  "admin",
  "administrator",
  "root",
  "toor",
  "letmein",
  "welcome",
  "changeme",
  "secret",
  "default",
  "guest",
  "user",
  "test",
  "demo",
  "example",
  "iloveyou",
  "monkey",
  "dragon",
  "master",
  "login",
  "token",
  "mcp",
]);

/** 单个字符所属的类别。 */
export type CharacterClass = "lower" | "upper" | "digit" | "symbol" | "other";

/** 统计密码实际用到的字符类别。 */
export function characterClasses(password: string): Set<CharacterClass> {
  const classes = new Set<CharacterClass>();
  for (const char of password) {
    if (/\p{Ll}/u.test(char)) classes.add("lower");
    else if (/\p{Lu}/u.test(char)) classes.add("upper");
    else if (/\p{Nd}/u.test(char)) classes.add("digit");
    // 非拉丁字母（中文、日文、西里尔等）也算一类“其它字母”。
    else if (/\p{L}/u.test(char)) classes.add("other");
    else classes.add("symbol");
  }
  return classes;
}

/**
 * 返回命中的全部弱密码原因；空数组表示通过。
 *
 * 判定标准：不可为空、不在常见弱密码清单、长度达标、字符类别足够、
 * 不是所有字符都相同。
 */
export function passwordWeaknesses(password: string): string[] {
  const value = password ?? "";
  if (value.length === 0) return ["密码为空"];

  const issues: string[] = [];
  if (COMMON_WEAK_PASSWORDS.has(value.toLowerCase())) {
    issues.push("命中常见弱密码清单");
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    issues.push(`长度 ${value.length}，少于要求的 ${MIN_PASSWORD_LENGTH} 位`);
  }
  const classes = characterClasses(value);
  if (classes.size < MIN_CHARACTER_CLASSES) {
    issues.push(
      `只用到 ${classes.size} 类字符，至少需要 ${MIN_CHARACTER_CLASSES} 类（小写 / 大写 / 数字 / 符号）`,
    );
  }
  if (new Set(value).size === 1) {
    issues.push("所有字符都相同");
  }
  return issues;
}

/** 是否属于策略定义的弱密码。 */
export function isWeakPassword(password: string): boolean {
  return passwordWeaknesses(password).length > 0;
}

/** 面向用户的操作提示（不包含密码本身）。 */
export function strongPasswordHint(): string {
  return `要求：至少 ${MIN_PASSWORD_LENGTH} 位，且覆盖至少 ${MIN_CHARACTER_CLASSES} 类字符（小写 / 大写 / 数字 / 符号）。生成：openssl rand -base64 24`;
}
