import { defineConfig } from "vitest/config";

// Unit tests only: plain Node, no Cloudflare plugin.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
