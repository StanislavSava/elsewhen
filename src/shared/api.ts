// Request/response shapes shared by the client and the Worker.
import type { Biome } from "./eras";

export type ConfigResponse = { turnstileSiteKey: string; live: boolean; biome: Biome };

export type CreateSceneResponse = { token: string; id: string; width: number; height: number; photoUrl: string };

export type MasksResponse = { masks: Record<string, string | null> };

export type EraResult = {
  year: number;
  imageUrl: string;
  /** Raw SAM text for deep time's tappable creature, decoded on the client. */
  target: { phrase: string; samUrl: string } | null;
  /** What is in each cell of a 3×3 grid over the image, in reading order (labels for the time core). */
  cells?: string[] | null;
  /** Raw SAM text: where this era's own buildings stand, for transitions. Missing in older eras and demos. */
  structuresUrl?: string | null;
  /** True for the first, unchecked paint: the client asks for its refinement (POST …/refine) and swaps it in. */
  draft?: boolean;
  /** Which prompt level got past the content filter (0 = full); the refinement starts there. */
  level?: number;
  /** Image of the neighbouring era this one was painted against, if any (which version: draft or refined). */
  referenceUrl?: string | null;
  /** False when the critic couldn't give a verdict (kept as painted, not passed). */
  verified?: boolean;
  /** Creature, cell labels and building mask are filled in (they follow the image by a few seconds). */
  enriched?: boolean;
};

export type ApiError = {
  error: "turnstile_failed" | "resting" | "bad_request" | "not_found" | "content_filtered" | "pending" | "upstream";
  detail?: string;
};

/**
 * What Muse Spark found about the place: what it is (for the loading screen), what stood here in each era of
 * this history, and labels for the photo's own cells (our timeline only).
 */
/** year → one "what changed here and why" line per 3×3 cell, or null when it couldn't be written. */
export type StoryResponse = { story: Record<string, string[]> | null };

export type NotesResponse = {
  place: string;
  /** Short name for titles ("Kraków"); missing in older demo files. */
  town?: string | null;
  eras: Record<string, string>;
  cells: string[] | null;
  /** The place's own climate, read from the photo; missing in older demo files. */
  biome?: Biome | null;
};
