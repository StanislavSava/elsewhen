// Writes .dev.vars (local Worker secrets) from the root .env. Turnstile uses Cloudflare's published
// always-pass test keys locally; the HMAC key is generated once and kept across runs.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const parse = (path) =>
  existsSync(path)
    ? Object.fromEntries(
        readFileSync(path, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#") && l.includes("="))
          .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
          }),
      )
    : {};

const env = parse(".env");
const previous = parse(".dev.vars");
if (!env.MODEL_API_KEY) console.warn("dev-vars: MODEL_API_KEY missing from .env, so generation calls will fail");

const vars = {
  MODEL_API_KEY: env.MODEL_API_KEY ?? "",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  SCENE_HMAC_KEY: previous.SCENE_HMAC_KEY ?? randomBytes(32).toString("hex"),
  // Local dev only (overrides wrangler.jsonc vars); production keeps its own cap. Set DEV_DAILY_BUDGET_CENTS to change.
  DAILY_BUDGET_CENTS: env.DEV_DAILY_BUDGET_CENTS ?? "2000",
};
writeFileSync(".dev.vars", Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
