// A shared password in front of the whole site (app, demos, API), for showing Elsewhen to people we pick.
// The cookie is an HMAC of the password, so changing APP_PASSWORD signs everyone out. Unset = no gate (local dev).
// A link with ?key=<password> signs in on the spot and drops the key from the address bar.
import type { Context, Next } from "hono";
import type { Env } from "./config";
import { hmac } from "./guard";

const COOKIE = "ew_pass";
const MAX_AGE = 60 * 60 * 24 * 30;

const pass = (env: Env) => hmac(env, `pass:${env.APP_PASSWORD}`);

function cookieOf(c: Context<{ Bindings: Env }>): string | undefined {
  const raw = c.req.header("cookie") ?? "";
  return raw.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const safeNext = (next: string | null | undefined) => (next && next.startsWith("/") && !next.startsWith("//") ? next : "/");

function signedIn(value: string, to: string, secure: boolean): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: to,
      "set-cookie": `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    },
  });
}

export async function gate(c: Context<{ Bindings: Env }>, next: Next) {
  if (!c.env.APP_PASSWORD) return next();
  const expected = await pass(c.env);
  const url = new URL(c.req.url);
  const secure = url.protocol === "https:";

  if (url.pathname === "/login" && c.req.method === "POST") {
    const form = await c.req.formData();
    const to = safeNext(String(form.get("next") ?? "/"));
    if (same(String(form.get("password") ?? ""), c.env.APP_PASSWORD)) return signedIn(expected, to, secure);
    return c.html(page(to, true), 401);
  }

  const key = url.searchParams.get("key");
  if (key !== null) {
    url.searchParams.delete("key");
    const to = url.pathname + url.search;
    if (same(key, c.env.APP_PASSWORD)) return signedIn(expected, to, secure);
    return c.html(page(to, true), 401);
  }

  const cookie = cookieOf(c);
  if (cookie && same(cookie, expected)) return next();
  if (url.pathname.startsWith("/api/")) return c.json({ error: "locked" }, 401);
  return c.html(page(url.pathname + url.search, false), 401);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const page = (next: string, wrong: boolean) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Elsewhen</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px;
    background: radial-gradient(120% 90% at 50% 10%, #1c2333 0%, #07080c 70%); color: #eef1f6;
    font: 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { width: min(340px, 100%); display: grid; gap: 14px; text-align: center; }
  h1 { margin: 0; font-size: 34px; font-weight: 600; letter-spacing: 0.02em; }
  p { margin: 0 0 6px; color: #9aa3b5; font-size: 15px; }
  input { width: 100%; padding: 13px 14px; border-radius: 12px; border: 1px solid #333b4d; background: #0f131c;
    color: inherit; font: inherit; outline: none; }
  input:focus { border-color: #8fb3ff; }
  button { padding: 13px; border: 0; border-radius: 12px; background: #eef1f6; color: #07080c; font: inherit;
    font-weight: 600; cursor: pointer; }
  .wrong { color: #ff9a8a; font-size: 14px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Elsewhen</h1>
  <p>Any place, any time. Private preview.</p>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required />
  <input type="hidden" name="next" value="${esc(next)}" />
  ${wrong ? `<div class="wrong">That's not it. Try again.</div>` : ""}
  <button type="submit">Enter</button>
</form>
</body>
</html>`;
