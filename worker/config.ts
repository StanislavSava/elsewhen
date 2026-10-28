// Pinned model IDs: change deliberately, never implicitly.
export const META_BASE_URL = "https://api.meta.ai/v1";
export const IMAGE_MODEL = "muse-image-1.0";
export const SAM_MODEL = "sam-3.1";
export const SPARK_MODEL = "muse-spark-1.3";

export const IMAGE_PRICE_CENTS = 1;
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
export const LOCK_TTL_SECONDS = 120;

/** Base masks drive transitions (sky changes first, structures last) and indoor detection. */
export const BASE_PHRASES = ["sky", "building", "tree", "grass", "street", "wall", "ceiling", "floor"] as const;

export type Env = {
  ASSETS: Fetcher;
  BUCKET: R2Bucket;
  KV: KVNamespace;
  MODEL_API_KEY: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  SCENE_HMAC_KEY: string;
  DAILY_BUDGET_CENTS: string;
  MAX_REPAINTS?: string;
  KILL_SWITCH: string;
  /** Shared password for the whole site; unset leaves it open. */
  APP_PASSWORD?: string;
};
