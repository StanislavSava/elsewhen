// Pre-generated demo scenes (public/demo/<name>/, exported by scripts/make-demo.ts). They play on the
// landing page and load entirely from static files: no camera, no wait, no API calls.
import type { EraResult } from "./shared/api";
import type { Biome, Fossil } from "./shared/eras";

type DemoEra = {
  image: string;
  target?: { phrase: string; sam: string };
  fossil?: string;
  fossilSpec?: Fossil;
  elements?: (string | null)[];
};

export type DemoManifest = {
  name: string;
  credit: string;
  biome: Biome;
  width: number;
  height: number;
  photo: string;
  masks: Record<string, string | null>;
  forks: Record<string, Record<string, DemoEra>>;
};

export type Demo = { base: string; manifest: DemoManifest };

export type DemoIndexEntry = { name: string; biome: Biome; credit: string };

export async function loadDemoIndex(): Promise<DemoIndexEntry[]> {
  const res = await fetch("/demo/index.json");
  return res.ok ? ((await res.json()) as DemoIndexEntry[]) : [];
}

export async function loadDemo(name: string): Promise<Demo | null> {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const base = `/demo/${name}/`;
  const res = await fetch(`${base}manifest.json`);
  return res.ok ? { base, manifest: (await res.json()) as DemoManifest } : null;
}

/** The demo's eras for one history, in the same shape the live API returns. */
export function demoEras(demo: Demo, forkId: string): Map<number, EraResult> {
  const out = new Map<number, EraResult>();
  for (const [year, e] of Object.entries(demo.manifest.forks[forkId] ?? {})) {
    out.set(Number(year), {
      year: Number(year),
      imageUrl: demo.base + e.image,
      target: e.target ? { phrase: e.target.phrase, samUrl: demo.base + e.target.sam } : null,
      fossilUrl: e.fossil ? demo.base + e.fossil : null,
      fossil: e.fossilSpec,
    });
  }
  return out;
}

export function demoElementUrls(demo: Demo, forkId: string, year: number): (string | null)[] {
  return (demo.manifest.forks[forkId]?.[String(year)]?.elements ?? []).map((f) => (f ? demo.base + f : null));
}

export function demoMaskUrls(demo: Demo): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(demo.manifest.masks).map(([k, f]) => [k, f ? demo.base + f : null]),
  );
}
