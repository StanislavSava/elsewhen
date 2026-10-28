// Dev-only: gives the static demos what live eras get from the Worker, a SAM "building" mask per era, so their
// transitions bring each era's own buildings down or up (see EraResult.structuresUrl). Skips eras with no
// structures and masks already written. Reads MODEL_API_KEY from the root .env.
//
// Usage: node scripts/demo-structures.ts [demo-name ...]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const META = "https://api.meta.ai/v1";
const SAM_MODEL = "sam-3.1"; // worker/config.ts
const CONCURRENCY = 6;

const key = readFileSync(".env", "utf8").match(/^MODEL_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!key) throw new Error("MODEL_API_KEY missing from .env");

type Era = { year: number; structures: string };
const structuresOf = new Map<string, Map<number, string>>();
for (const f of readdirSync("forks").filter((f) => f.endsWith(".json"))) {
  const c = JSON.parse(readFileSync(join("forks", f), "utf8")) as { forkId: string; eras: Era[] };
  structuresOf.set(c.forkId, new Map(c.eras.map((e) => [e.year, e.structures])));
}
const base = structuresOf.get("our-timeline")!;

async function segment(image: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${META}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: SAM_MODEL,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "building" }, { type: "input_image", image_url: image }] }],
        metadata: { mask_encoding: "one_bit", include_confidence: "true" },
      }),
    });
    if (res.ok) {
      const r = (await res.json()) as { output_text?: string; output?: { content?: { type: string; text?: string }[] }[] };
      if (typeof r.output_text === "string") return r.output_text;
      return (r.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
    }
    if (attempt >= 3 || ![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`SAM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
  }
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync("public/demo").filter((d) => existsSync(join("public/demo", d, "manifest.json")));
for (const name of names) {
  const dir = join("public/demo", name);
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    setting?: string;
    forks: Record<string, Record<string, { image: string; structures?: string }>>;
  };
  if (manifest.setting === "indoor") continue;
  // One mask per image file: shared eras appear under every history but are the same file.
  const jobs = new Map<string, { file: string; entries: { structures?: string }[] }>();
  for (const [forkId, eras] of Object.entries(manifest.forks)) {
    for (const [year, era] of Object.entries(eras)) {
      const s = structuresOf.get(forkId)?.get(Number(year)) ?? base.get(Number(year));
      if (s === "unbuilt" || s === "gone") continue;
      const file = era.image.replace(/\.webp$/, ".structures.txt");
      const job = jobs.get(era.image) ?? { file, entries: [] };
      job.entries.push(era);
      jobs.set(era.image, job);
    }
  }
  const queue = [...jobs.entries()];
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [image, job] = next;
        if (!existsSync(join(dir, job.file))) {
          const bytes = readFileSync(join(dir, image)).toString("base64");
          writeFileSync(join(dir, job.file), await segment(`data:image/webp;base64,${bytes}`));
        }
        for (const e of job.entries) e.structures = job.file;
        console.log(`${name}: ${++done}/${jobs.size} ${job.file}`);
      }
    }),
  );
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
