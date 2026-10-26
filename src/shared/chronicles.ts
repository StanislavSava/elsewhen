import ourTimeline from "../../forks/our-timeline.json";
import { Chronicle, type ChronicleEra } from "./eras";

// Parsed at import, so a malformed chronicle fails the build/tests instead of a live request.
export const CHRONICLES: Record<string, Chronicle> = Object.fromEntries(
  [ourTimeline].map((raw) => {
    const c = Chronicle.parse(raw);
    return [c.forkId, c];
  }),
);

export const DEFAULT_FORK = "our-timeline";

export function findEra(forkId: string, year: number): ChronicleEra | undefined {
  return CHRONICLES[forkId]?.eras.find((e) => e.year === year);
}
