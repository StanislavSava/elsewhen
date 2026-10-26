// Re-encodes an already exported demo scene in place (same sizes as make-demo.ts).
// Usage: node scripts/compress-demo.ts <name>
import { readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const dir = join("public", "demo", process.argv[2]);
for (const f of readdirSync(dir)) {
  if (!/\.(webp|jpg)$/.test(f)) continue;
  const maxEdge = f.endsWith(".fossil.webp") ? 768 : 1280;
  const img = sharp(readFileSync(join(dir, f))).resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
  writeFileSync(join(dir, f), await (f.endsWith(".jpg") ? img.jpeg({ quality: 82 }) : img.webp({ quality: 72 })).toBuffer());
}
