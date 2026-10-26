// Request/response shapes shared by the client and the Worker.
import type { Biome } from "./eras";

export type ConfigResponse = { turnstileSiteKey: string; live: boolean; biome: Biome };

export type CreateSceneResponse = { token: string; id: string; width: number; height: number; photoUrl: string };

export type MasksResponse = { masks: Record<string, string | null> };

export type EraResult = {
  year: number;
  imageUrl: string;
  /** Raw SAM text for the tappable subject (creature or idea fossil), decoded on the client. */
  target: { phrase: string; samUrl: string } | null;
  fossilUrl: string | null;
};

export type ApiError = {
  error: "turnstile_failed" | "resting" | "bad_request" | "not_found" | "content_filtered" | "pending" | "upstream";
  detail?: string;
};
