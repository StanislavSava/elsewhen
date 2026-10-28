import ourTimeline from "../../forks/our-timeline.json";
import printingPress from "../../forks/no-printing-press.json";
import alexandria from "../../forks/library-of-alexandria.json";
import noElectricity from "../../forks/no-electricity.json";
import tamedMammoth from "../../forks/tamed-mammoth.json";
import romeNeverFell from "../../forks/rome-never-fell.json";
import { Chronicle, relativeDivergence, type ChronicleEra } from "./eras";

// Parsed at import, so a malformed chronicle fails the build/tests instead of a live request.
export const CHRONICLES: Record<string, Chronicle> = Object.fromEntries(
  // Ordered by divergence, oldest first, for the history picker.
  [ourTimeline, tamedMammoth, alexandria, romeNeverFell, printingPress, noElectricity].map((raw) => {
    const c = Chronicle.parse(raw);
    return [c.forkId, c];
  }),
);

export const DEFAULT_FORK = "our-timeline";

/**
 * Is this era identical in every history? Everything before a fork's divergence is, and so is deep
 * time (biology eras): a million years washes out which ideas won.
 */
export function isShared(forkId: string, year: number): boolean {
  if (forkId === DEFAULT_FORK) return true;
  const base = CHRONICLES[DEFAULT_FORK].eras.find((e) => e.year === year);
  if (base?.driver === "biology") return true;
  const div = relativeDivergence(CHRONICLES[forkId]);
  return div !== null && year < div;
}

/** The era a fork shows at `year`: its own after the divergence, ours before it and in deep time. */
export function findEra(forkId: string, year: number): ChronicleEra | undefined {
  const fork = CHRONICLES[forkId];
  if (!fork) return undefined;
  if (forkId !== DEFAULT_FORK && !isShared(forkId, year)) return fork.eras.find((e) => e.year === year);
  return CHRONICLES[DEFAULT_FORK].eras.find((e) => e.year === year);
}

/**
 * Years a history needs keyframes for. Our timeline shows the photo at 0; a fork generates its own now, and skips
 * our eras it doesn't define (1976's construction belongs to our buildings).
 */
export function yearsFor(forkId: string): number[] {
  const base = CHRONICLES[DEFAULT_FORK].eras.map((e) => e.year);
  if (forkId === DEFAULT_FORK) return base;
  const fork = CHRONICLES[forkId];
  const own = (y: number) => isShared(forkId, y) || fork.eras.some((e) => e.year === y);
  return [...base.filter(own), 0].sort((a, b) => a - b);
}

/**
 * The era painted alongside this one as a continuity reference: its neighbour toward now, so a 1526 cottage
 * stands where 1926's brick house will, and 3026's garden city grows from 2126's. None for our timeline's
 * eras next to now (the photo is already the first image) or for deep time without structures. Shared eras
 * are stored once for every history, so they always take their reference from our timeline.
 */
export function anchorYear(forkId: string, year: number): number | null {
  const history = isShared(forkId, year) ? DEFAULT_FORK : forkId;
  const era = findEra(history, year);
  if (!era || year === 0) return null;
  if (era.driver === "biology" && era.structures !== "remains") return null;
  const years = [...new Set([...yearsFor(history), 0])].sort((a, b) => a - b); // our timeline's now is the photo
  const i = years.indexOf(year);
  const next = year < 0 ? years[i + 1] : years[i - 1];
  if (next === undefined || (next === 0 && history === DEFAULT_FORK)) return null;
  return next;
}
