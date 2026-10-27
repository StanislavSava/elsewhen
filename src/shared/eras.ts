// Shared by the client and the Worker: era stops, time mapping and the chronicle schema.
import { z } from "zod";

export const BIOMES = ["temperate", "arid", "tropical", "cold"] as const;
export type Biome = (typeof BIOMES)[number];

export const SETTINGS = ["outdoor", "indoor"] as const;
export type Setting = (typeof SETTINGS)[number];

/** Calendar year that "now" (relative year 0) stands for. */
export const CURRENT_YEAR = 2026;

/** Years relative to now. In our timeline 0 is the captured photo; a fork generates its own alternate now. */
export const ERA_YEARS = [-1_000_000, -10_000, -2_000, -500, -100, 0, 100, 1_000, 10_000, 1_000_000] as const;
export type EraYear = (typeof ERA_YEARS)[number];
export const GENERATED_YEARS = ERA_YEARS.filter((y) => y !== 0);

export function isEraYear(n: number): n is EraYear {
  return (ERA_YEARS as readonly number[]).includes(n);
}

const DECADES = Math.log10(1_000_000 + 1); // so ±1 lands exactly on ±1,000,000 years

/** Slider position p ∈ [-1, 1] → years (symmetric log). */
export function positionToYear(p: number): number {
  const c = Math.max(-1, Math.min(1, p));
  return Math.sign(c) * (10 ** (Math.abs(c) * DECADES) - 1);
}

/** Years → slider position p ∈ [-1, 1]. */
export function yearToPosition(year: number): number {
  return (Math.sign(year) * Math.log10(Math.abs(year) + 1)) / DECADES;
}

/**
 * Which two keyframes surround slider position p, and how far between them (t ∈ [0, 1]).
 * Blending is computed in slider space, so −37,000 sits exactly where the slider puts it.
 * `available` must be sorted ascending; years missing from it are skipped.
 */
export function blendAt(p: number, available: readonly number[]): { a: number; b: number; t: number } {
  if (available.length === 0) throw new Error("no keyframes");
  const pos = available.map(yearToPosition);
  if (p <= pos[0]) return { a: available[0], b: available[0], t: 0 };
  const last = available.length - 1;
  if (p >= pos[last]) return { a: available[last], b: available[last], t: 0 };
  for (let i = 0; i < last; i++) {
    if (p >= pos[i] && p <= pos[i + 1]) {
      const span = pos[i + 1] - pos[i];
      return { a: available[i], b: available[i + 1], t: span === 0 ? 0 : (p - pos[i]) / span };
    }
  }
  return { a: available[last], b: available[last], t: 0 };
}

export function formatYear(year: number): string {
  if (year === 0) return "now";
  const abs = Math.abs(year);
  const n = abs >= 1_000_000 ? `${abs / 1_000_000}M` : abs >= 10_000 ? `${abs / 1_000}k` : abs.toLocaleString("en-US");
  return year < 0 ? `${n} years ago` : `in ${n} years`;
}

// ---------------------------------------------------------------- chronicle schema

const StructureState = z.enum(["unbuilt", "predecessor", "alternate", "intact", "weathered", "overgrown", "remains", "buried", "gone"]);
export type StructureState = z.infer<typeof StructureState>;

const Fauna = z.object({
  kind: z.enum(["extinct", "speculative"]),
  name: z.string(),
  binomial: z.string(),
  ancestor: z.string(),
  niche: z.string(),
  adaptations: z.array(z.object({ trait: z.string(), because: z.string() })).min(1),
  where: z.string().optional(),
  sources: z.array(z.string().url()).optional(),
});
export type Fauna = z.infer<typeof Fauna>;

const BiologyVariant = z.object({
  caption: z.string().max(70),
  environment: z.string(),
  visualPrompt: z.string(),
  fauna: z.array(Fauna).min(1),
});
export type BiologyVariant = z.infer<typeof BiologyVariant>;

/**
 * How an alternate history's era differs from ours at the same date, as things a camera would see. This is what
 * makes a history change the place credibly, instead of dressing it up in themed buildings.
 */
const World = z.object({
  /** "X instead of Y (because …)": 4–6 concrete physical differences. */
  differences: z.array(z.string()).min(3),
  /** Things our world has at this date that this one doesn't, and that must not appear. */
  absent: z.array(z.string()),
  /** What this history leaves as it is in ours (keeps the edit anchored to the photo). */
  kept: z.array(z.string()),
});
export type World = z.infer<typeof World>;

const CultureEra = z.object({
  year: z.number(),
  driver: z.literal("culture"),
  structures: StructureState,
  caption: z.string().max(70),
  visualPrompt: z.string(),
  visualPromptIndoor: z.string().optional(),
  world: World.optional(),
});

const BiologyEra = z.object({
  year: z.number(),
  driver: z.literal("biology"),
  structures: StructureState,
  biomes: z.object({ temperate: BiologyVariant, arid: BiologyVariant, tropical: BiologyVariant, cold: BiologyVariant }),
});

export const ChronicleEra = z.discriminatedUnion("driver", [CultureEra, BiologyEra]);
export type ChronicleEra = z.infer<typeof ChronicleEra>;

export const Chronicle = z.object({
  forkId: z.string(),
  title: z.string(),
  /** Calendar year where this history splits from ours (null for our timeline). */
  divergenceYear: z.number().nullable(),
  premise: z.string(),
  chain: z.array(z.object({ year: z.number(), event: z.string(), consequence: z.string() })),
  eras: z.array(ChronicleEra),
});
export type Chronicle = z.infer<typeof Chronicle>;

export function eraCaption(era: ChronicleEra, biome: Biome): string {
  return era.driver === "biology" ? era.biomes[biome].caption : era.caption;
}

/** Divergence as a year relative to now (e.g. 1440 → −586), or null for our timeline. */
export function relativeDivergence(c: Chronicle): number | null {
  return c.divergenceYear === null ? null : c.divergenceYear - CURRENT_YEAR;
}
