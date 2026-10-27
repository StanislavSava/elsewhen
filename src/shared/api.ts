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
};

export type ApiError = {
  error: "turnstile_failed" | "resting" | "bad_request" | "not_found" | "content_filtered" | "pending" | "upstream";
  detail?: string;
};

/**
 * What Muse Spark found about the place: what it is (for the loading screen), what stood here in each era of
 * this history, and labels for the photo's own cells (our timeline only).
 */
export type NotesResponse = { place: string; eras: Record<string, string>; cells: string[] | null };
