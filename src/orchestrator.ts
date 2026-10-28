// Requests every era for a scene: at most N in flight, nearest-to-now first, resuming from what the
// Worker already stored (a phone that suspended the tab never pays twice). An era waits for its neighbour
// toward now (see anchorYear), which the Worker paints in as a continuity reference.
import { api, HttpError } from "./api";
import type { EraResult } from "./shared/api";
import { anchorYear } from "./shared/chronicles";
import { GENERATED_YEARS, yearToPosition, type Biome, type Setting } from "./shared/eras";

export type EraStatus = "pending" | "loading" | "ready" | "failed";

export type OrchestratorEvents = {
  onStatus: (year: number, status: EraStatus, result?: EraResult) => void;
  onResting: () => void;
};

// Every era of a history at once: a scene then takes about as long as its slowest era (timed: 380 s → 232 s
// for nine eras), and Meta's API took it without rate limiting.
const CONCURRENCY = 10;
const POLL_MS = 3000;
const POLL_LIMIT_MS = 150_000;

export function nearestFirst(years: readonly number[]): number[] {
  return [...years].sort((a, b) => Math.abs(yearToPosition(a)) - Math.abs(yearToPosition(b)));
}

export async function generateAll(
  token: string,
  params: { forkId: string; biome: Biome; setting: Setting },
  events: OrchestratorEvents,
  years: readonly number[] = GENERATED_YEARS,
): Promise<void> {
  const queue = nearestFirst(years);
  let resting = false;

  async function one(year: number): Promise<void> {
    events.onStatus(year, "loading");
    try {
      const existing = await api.getEra(token, year, params).catch(() => null);
      if (existing) return events.onStatus(year, "ready", existing);
      for (let attempt = 0; ; attempt++) {
        try {
          return events.onStatus(year, "ready", await api.createEra(token, year, params));
        } catch (err) {
          if (!(err instanceof HttpError)) {
            if (attempt === 0) continue; // network blip: one retry
            throw err;
          }
          if (err.status === 503) {
            resting = true;
            events.onResting();
            return events.onStatus(year, "failed");
          }
          if (err.status === 409) return events.onStatus(year, "ready", await poll(year));
          if (err.status === 502 && attempt === 0) continue;
          throw err;
        }
      }
    } catch {
      events.onStatus(year, "failed");
    }
  }

  async function poll(year: number): Promise<EraResult> {
    const deadline = Date.now() + POLL_LIMIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const result = await api.getEra(token, year, params).catch(() => null);
      if (result) return result;
    }
    throw new Error("timed out waiting for another request");
  }

  let slots = CONCURRENCY;
  const waiting: (() => void)[] = [];
  const acquire = () => (slots > 0 ? (slots--, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else slots++;
  };

  queue.forEach((y) => events.onStatus(y, "pending"));
  // Nearest first, so an era's neighbour toward now is always already scheduled; one painted earlier isn't waited on.
  const finished = new Map<number, Promise<void>>();
  for (const year of queue) {
    const anchor = anchorYear(params.forkId, year);
    const before = anchor === null ? undefined : finished.get(anchor);
    finished.set(
      year,
      (async () => {
        await before;
        await acquire();
        try {
          if (!resting) await one(year);
        } finally {
          release();
        }
      })(),
    );
  }
  await Promise.all(finished.values());
}
