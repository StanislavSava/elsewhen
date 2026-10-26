import { cloudflare } from "@cloudflare/vite-plugin";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

// public/_dev holds local test photos (git-ignored); make sure they never ship.
const stripDevFixtures = (): Plugin => {
  let outDir = "dist";
  return {
    name: "strip-dev-fixtures",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      rmSync(join(outDir, "_dev"), { recursive: true, force: true });
    },
  };
};

export default defineConfig({
  plugins: [cloudflare(), stripDevFixtures()],
  // Pre-bundle up front: discovering these lazily re-optimizes deps mid-session and strands open tabs.
  optimizeDeps: { include: ["three", "zod", "@meta-sam/parser"] },
});
