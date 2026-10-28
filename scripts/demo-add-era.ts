// Dev-only: paints one new era of our timeline into existing demos through the LOCAL pipeline (npm run dev),
// without regenerating the rest (e.g. when an era is added to forks/our-timeline.json). The demo's photo goes
// through a fresh scene; the new era's image, cell labels, building mask and note are merged into the manifest.
//
// Usage: node scripts/demo-add-era.ts <year> [demo-name ...]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.ELSEWHEN_DEV_URL ?? "http://localhost:5181";
const FORK = "our-timeline";

type EraResult = { imageUrl: string; cells?: string[] | null; structuresUrl?: string | null };
type Manifest = {
  biome: string;
  setting?: string;
  width: number;
  height: number;
  photo: string;
  forks: Record<string, Record<string, { image: string; cells?: string[] | null; structures?: string }>>;
  notes?: Record<string, { eras: Record<string, string> }>;
};

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`${res.url} → ${res.status} ${await res.text()}`);
  return res;
}

const year = Number(process.argv[2]);
if (!Number.isInteger(year) || year === 0) throw new Error("usage: node scripts/demo-add-era.ts <year> [demo-name ...]");
const names = process.argv.slice(3).length
  ? process.argv.slice(3)
  : readdirSync("public/demo").filter((d) => existsSync(join("public/demo", d, "manifest.json")));

await Promise.all(
  names.map(async (name) => {
    const dir = join("public/demo", name);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const scene = (await (
      await ok(
        await fetch(`${BASE}/api/scenes`, {
          method: "POST",
          headers: {
            "content-type": "image/jpeg",
            "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX", // local dev uses Turnstile's always-pass keys
            "x-photo-width": String(manifest.width),
            "x-photo-height": String(manifest.height),
          },
          body: readFileSync(join(dir, manifest.photo)),
        }),
      )
    ).json()) as { token: string };
    const post = (path: string, body: object) =>
      fetch(`${BASE}/api/scenes/${scene.token}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(ok);
    const [, notesRes] = await Promise.all([post("/masks", {}), post("/notes", { forkId: FORK })]);
    const notes = (await notesRes.json()) as { eras: Record<string, string> };
    const params = { forkId: FORK, biome: manifest.biome, setting: manifest.setting ?? "outdoor" };
    const era = (await (await post(`/eras/${year}`, params)).json()) as EraResult;

    const image = `base_${year}.webp`;
    writeFileSync(join(dir, image), Buffer.from(await (await ok(await fetch(BASE + era.imageUrl))).arrayBuffer()));
    const entry: { image: string; cells: string[] | null; structures?: string } = { image, cells: era.cells ?? null };
    if (era.structuresUrl) {
      entry.structures = `base_${year}.structures.txt`;
      writeFileSync(join(dir, entry.structures), await (await ok(await fetch(BASE + era.structuresUrl))).text());
    }
    manifest.forks[FORK][String(year)] = entry;
    const ours = manifest.notes?.[FORK];
    if (ours && notes.eras[String(year)]) ours.eras[String(year)] = notes.eras[String(year)];
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`${name}: ${year} added`);
  }),
);
