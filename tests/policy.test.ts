import { describe, expect, test } from "bun:test";
import { characterClasses, isWeakPassword, passwordWeaknesses } from "../src/password-policy";
import { baseUrlProblem, isLoopbackHost, parseBaseUrl } from "../src/url-policy";

describe("弱密码策略", () => {
  test("内置默认值与常见弱密码被拒绝", () => {
    for (const weak of ["pi-mcp", "password", "123456", "qwerty", "admin", "changeme", "PI-MCP"]) {
      expect(isWeakPassword(weak)).toBe(true);
    }
  });

  test("空密码被拒绝", () => {
    expect(passwordWeaknesses("")).toEqual(["密码为空"]);
    expect(isWeakPassword(" ")).toBe(true);
  });

  test("长度不足或字符类别不足被拒绝", () => {
    expect(isWeakPassword("Abc123!")).toBe(true); // 7 位
    expect(isWeakPassword("abcd1234efgh")).toBe(true); // 只有小写+数字两类
  });

  test("足够长且多类别的密码通过", () => {
    for (const strong of ["8HjPvFsOI3c5S0EBsTDh9y+9Iw6CoRNl", "correct-horse-Battery-9", "中文密码-Abc-123456"]) {
      expect(passwordWeaknesses(strong)).toEqual([]);
      expect(isWeakPassword(strong)).toBe(false);
    }
  });

  test("字符类别统计包含非拉丁字母", () => {
    expect([...characterClasses("中文Abc1!")].sort()).toEqual(["digit", "lower", "other", "symbol", "upper"]);
  });
});

describe("BASE_URL https 策略", () => {
  test("回环地址识别", () => {
    for (const host of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["example.com", "public.example.com", "10.0.0.1", "192.168.1.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test("公网 http 默认被拒绝", () => {
    expect(baseUrlProblem("http://public.example.com", false)).toContain("https");
    expect(baseUrlProblem("http://example.com:8080", false)).toContain("https");
  });

  test("公网 https 与本地回环 http 通过", () => {
    expect(baseUrlProblem("https://mcp.example.com", false)).toBeUndefined();
    expect(baseUrlProblem("http://localhost:3000", false)).toBeUndefined();
    expect(baseUrlProblem("http://127.0.0.1:3000", false)).toBeUndefined();
  });

  test("显式放行后才允许公网 http", () => {
    expect(baseUrlProblem("http://10.0.0.5:3000", true)).toBeUndefined();
  });

  test("非法 URL / 协议被拒绝", () => {
    expect(baseUrlProblem("", false)).toContain("为空");
    expect(baseUrlProblem("not a url", false)).toBeDefined();
    expect(baseUrlProblem("ftp://example.com", false)).toContain("http/https");
    expect(parseBaseUrl("https://mcp.example.com").ok).toBe(true);
  });
});
