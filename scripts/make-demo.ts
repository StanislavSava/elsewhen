// Dev-only: runs a prepared photo through the LOCAL pipeline (npm run dev) for every history, then exports
// the scene as static files under public/demo/<name>/ so the landing page can play it with zero API calls.
//
// Usage: node scripts/make-demo.ts <name> <prepared.jpg> <biome> "<credit html>"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const BASE = process.env.ELSEWHEN_DEV_URL ?? "http://localhost:5181";
const CURRENT_YEAR = 2026;
const CONCURRENCY = 4;

type Era = { year: number; driver: "culture" | "biology"; fossil?: { elements: { name: string }[] } };
type Chronicle = { forkId: string; divergenceYear: number | null; eras: Era[] };
type EraResult = { year: number; imageUrl: string; target: { phrase: string; samUrl: string } | null; fossilUrl: string | null; fossil?: object };

// Same sharing rules as src/shared/chronicles.ts (Node can't import its JSON without import attributes).
const chronicles: Chronicle[] = readdirSync("forks")
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join("forks", f), "utf8")));
const base = chronicles.find((c) => c.forkId === "our-timeline")!;
const isShared = (c: Chronicle, year: number) =>
  c === base ||
  base.eras.find((e) => e.year === year)?.driver === "biology" ||
  (c.divergenceYear !== null && year < c.divergenceYear - CURRENT_YEAR);
const yearsFor = (c: Chronicle) => (c === base ? base.eras.map((e) => e.year) : [...base.eras.map((e) => e.year), 0]);
const eraOf = (c: Chronicle, year: number) =>
  (c !== base && !isShared(c, year) ? c.eras : base.eras).find((e) => e.year === year);

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function generateEra(token: string, year: number, params: object): Promise<EraResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}/api/scenes/${token}/eras/${year}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (res.ok) return res.json() as Promise<EraResult>;
    if (res.status === 409) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    console.warn(`  era ${year} attempt ${attempt + 1}: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  throw new Error(`era ${year} failed`);
}

async function pool<T>(items: T[], fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

/** Images are re-encoded smaller (eras 1280 px, fossils 768 px): a demo scene must load fast on a phone. */
async function download(url: string, out: string): Promise<string> {
  const res = await fetch(`${BASE}${url}`);
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (/\.(webp|jpg)$/.test(out)) {
    const maxEdge = out.endsWith(".fossil.webp") ? 768 : 1280;
    const img = sharp(bytes).resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
    writeFileSync(out, await (out.endsWith(".jpg") ? img.jpeg({ quality: 82 }) : img.webp({ quality: 72 })).toBuffer());
  } else {
    writeFileSync(out, bytes);
  }
  return out;
}

async function main(): Promise<void> {
  const [name, photoPath, biome, credit, existingToken] = process.argv.slice(2);
  if (!name || !photoPath || !biome) throw new Error("usage: make-demo.ts <name> <prepared.jpg> <biome> <credit> [scene token]");
  const photo = readFileSync(photoPath); // already cropped to 1536×1152 (4:3)

  // Reusing a scene regenerates only eras whose prompts changed (the cache key includes a prompt hash).
  // Local dev uses Cloudflare's always-pass Turnstile secret, which accepts this dummy token.
  const scene = existingToken
    ? { token: existingToken, id: existingToken.split(".")[0], width: 1536, height: 1152, photoUrl: `/api/files/scenes/${existingToken.split(".")[0]}/photo.jpg` }
    : await json<{ token: string; id: string; width: number; height: number; photoUrl: string }>(
    await fetch(`${BASE}/api/scenes`, {
      method: "POST",
      headers: {
        "content-type": "image/jpeg",
        "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX",
        "x-photo-width": "1536",
        "x-photo-height": "1152",
      },
      body: photo,
    }),
  );
  console.log(`${name}: scene token ${scene.token}`);
  const { masks } = await json<{ masks: Record<string, string | null> }>(
    await fetch(`${BASE}/api/scenes/${scene.token}/masks`, { method: "POST" }),
  );

  const out = join("public", "demo", name);
  mkdirSync(out, { recursive: true });
  await download(scene.photoUrl, join(out, "photo.jpg"));
  const maskFiles: Record<string, string | null> = {};
  for (const [phrase, url] of Object.entries(masks)) {
    maskFiles[phrase] = url ? (await download(url, join(out, `mask-${phrase}.txt`)), `mask-${phrase}.txt`) : null;
  }

  const forks: Record<string, Record<number, object>> = {};
  for (const c of [base, ...chronicles.filter((x) => x !== base)]) {
    const params = { forkId: c.forkId, biome, setting: "outdoor" };
    // Research first (Muse Spark, once per history), so parallel eras all read the same notes.
    const { place } = await json<{ place: string }>(
      await fetch(`${BASE}/api/scenes/${scene.token}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forkId: c.forkId }),
      }),
    );
    console.log(`  ${c.forkId}: ${place}`);
    const years = yearsFor(c).filter((y) => !(c === base && y === 0));
    const eras: Record<number, object> = {};
    await pool(years, async (year) => {
      let r: EraResult;
      try {
        r = await generateEra(scene.token, year, params);
      } catch (err) {
        // The viewer skips missing eras; one stubborn content-filter block shouldn't sink the whole demo.
        console.warn(`  ${c.forkId} ${year} skipped: ${(err as Error).message}`);
        return;
      }
      const key = `${isShared(c, year) ? "base" : c.forkId}_${year}`;
      const entry: Record<string, unknown> = { image: `${key}.webp` };
      await download(r.imageUrl, join(out, `${key}.webp`));
      if (r.target) entry.target = { phrase: r.target.phrase, sam: (await download(r.target.samUrl, join(out, `${key}.target.txt`)), `${key}.target.txt`) };
      if (r.fossilUrl) {
        entry.fossil = (await download(r.fossilUrl, join(out, `${key}.fossil.webp`)), `${key}.fossil.webp`);
        if (r.fossil) entry.fossilSpec = r.fossil;
        const era = eraOf(c, year);
        if (era?.fossil) {
          const { elements } = await json<{ elements: { name: string; samUrl: string | null }[] }>(
            await fetch(`${BASE}/api/scenes/${scene.token}/eras/${year}/elements`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(params),
            }),
          );
          entry.elements = await Promise.all(
            elements.map(async (e, i) => (e.samUrl ? (await download(e.samUrl, join(out, `${key}.el${i}.txt`)), `${key}.el${i}.txt`) : null)),
          );
        }
      }
      eras[year] = entry;
      console.log(`  ${c.forkId} ${year} ✓`);
    });
    forks[c.forkId] = eras;
  }

  const manifest = { name, credit, biome, setting: "outdoor", width: scene.width, height: scene.height, photo: "photo.jpg", masks: maskFiles, forks };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const indexPath = join("public", "demo", "index.json");
  let index: { name: string; biome: string; credit: string }[] = [];
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    /* first demo */
  }
  index = [...index.filter((d) => d.name !== name), { name, biome, credit }];
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  console.log(`${name}: exported to ${out}`);
}

await main();
