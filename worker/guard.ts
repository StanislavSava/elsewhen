// Abuse and cost controls: Turnstile, signed scene tokens, daily budget, kill switch.
import { LOCK_TTL_SECONDS, type Env } from "./config";

export async function verifyTurnstile(env: Env, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  return ((await res.json()) as { success: boolean }).success;
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hmac(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.SCENE_HMAC_KEY), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data))).slice(0, 22);
}

/** A scene token is `<uuid>.<hmac>`: only scenes this Worker created can generate eras. */
export async function signScene(env: Env, id: string): Promise<string> {
  return `${id}.${await hmac(env, id)}`;
}

export async function verifySceneToken(env: Env, token: string): Promise<string | null> {
  const [id, sig] = token.split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const expected = await hmac(env, id);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? id : null;
}

function budgetKey(): string {
  return `budget:${new Date().toISOString().slice(0, 10)}`;
}

export async function budgetLeftCents(env: Env): Promise<number> {
  const spent = Number((await env.KV.get(budgetKey())) ?? "0");
  return Number(env.DAILY_BUDGET_CENTS || "500") - spent;
}

export async function spend(env: Env, cents: number): Promise<void> {
  // KV is eventually consistent, so the cap is approximate; it bounds the worst case, not the exact cent.
  const key = budgetKey();
  const spent = Number((await env.KV.get(key)) ?? "0") + cents;
  await env.KV.put(key, String(spent), { expirationTtl: 60 * 60 * 48 });
}

export async function isLive(env: Env): Promise<boolean> {
  return env.KILL_SWITCH !== "1" && (await budgetLeftCents(env)) > 0;
}

/** Best-effort lock so two identical era requests don't both pay. */
export async function takeLock(env: Env, key: string): Promise<boolean> {
  const lockKey = `lock:${key}`;
  if (await env.KV.get(lockKey)) return false;
  await env.KV.put(lockKey, "1", { expirationTtl: LOCK_TTL_SECONDS });
  return true;
}

export async function releaseLock(env: Env, key: string): Promise<void> {
  await env.KV.delete(`lock:${key}`);
}
