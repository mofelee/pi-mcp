// 演示用的密码登录页。
//
// 这里只做「一个密码换一个 session」：任何输入正确密码的人都视为同一个用户。
// 生产环境请替换成真实 IdP / 账号体系。

import { DEMO_USER_ID, DEMO_USER_NAME, LOGIN_PASSWORD } from "./config";
import { escapeHtml, htmlPage } from "./html";
import { clientIp, log } from "./log";
import { clearSessionCookie, createSessionCookie, readSession, type Session } from "./session";

/** 登录后允许跳转的路径，必须是本站相对路径，防止 open redirect */
function safeNext(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.startsWith("/login")) return "/";
  return value;
}

function loginPage(next: string, error?: string): Response {
  const body = `
<h1>登录 pi-mcp</h1>
${error ? `<p style="color:#c00">${escapeHtml(error)}</p>` : ""}
<p>请先登录，再继续授权。</p>
<form method="post" action="/login">
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  <p><input type="password" name="password" placeholder="密码" autofocus autocomplete="current-password"
      style="padding:.6rem;width:100%;max-width:20rem;font-size:1rem" /></p>
  <p><button type="submit" style="padding:.6rem 1.4rem;font-size:1rem">登录</button></p>
</form>`;
  return htmlPage("登录 pi-mcp", body, error ? 401 : 200);
}

export async function handleLoginGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));

  const session = await readSession(req);
  if (session) {
    return Response.redirect(new URL(next, url.origin).toString(), 302);
  }
  return loginPage(next);
}

export async function handleLoginPost(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  const params = contentType.includes("application/json")
    ? ((await req.json()) as Record<string, string>)
    : Object.fromEntries(new URLSearchParams(await req.text()));

  const next = safeNext(params.next ?? null);
  const password = params.password ?? "";

  if (!password || !timingSafeEqualString(password, LOGIN_PASSWORD)) {
    log.warn("login", "登录失败：密码错误", { ip: clientIp(req) });
    return loginPage(next, "密码错误");
  }

  const session: Session = { userId: DEMO_USER_ID, name: DEMO_USER_NAME };
  const cookie = await createSessionCookie(session);
  log.info("login", "登录成功", { user: session.userId, ip: clientIp(req) });

  return new Response(null, {
    status: 302,
    headers: {
      location: new URL(next, new URL(req.url).origin).toString(),
      "set-cookie": cookie,
      "cache-control": "no-store",
    },
  });
}

export async function handleLogout(req: Request): Promise<Response> {
  const session = await readSession(req);
  log.info("login", "退出登录", { user: session?.userId ?? "anonymous" });
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": clearSessionCookie(), "cache-control": "no-store" },
  });
}

/** 定时安全比较，避免泄露长度/前缀信息 */
function timingSafeEqualString(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // 先比较长度（长度本身不是秘密），再逐字节异或
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}
