import type { ApiError, ConfigResponse, CreateSceneResponse, EraResult, MasksResponse, NotesResponse, StoryResponse } from "./shared/api";
import type { Biome, Setting } from "./shared/eras";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(`HTTP ${status}${body ? ` ${body.error}` : ""}`);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => null)) as ApiError | null;
  throw new HttpError(res.status, body);
}

export const api = {
  config: () => fetch("/api/config").then(json<ConfigResponse>),

  createScene: (photo: Blob, width: number, height: number, turnstileToken: string) =>
    fetch("/api/scenes", {
      method: "POST",
      headers: {
        "content-type": "image/jpeg",
        "cf-turnstile-response": turnstileToken,
        "x-photo-width": String(width),
        "x-photo-height": String(height),
      },
      body: photo,
    }).then(json<CreateSceneResponse>),

  masks: (token: string) => fetch(`/api/scenes/${token}/masks`, { method: "POST" }).then(json<MasksResponse>),

  notes: (token: string, forkId: string) =>
    fetch(`/api/scenes/${token}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ forkId }),
    }).then(json<NotesResponse>),

  story: (token: string, p: { forkId: string; biome: Biome; setting: Setting }) =>
    fetch(`/api/scenes/${token}/story`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }).then(json<StoryResponse>),

  getEra: (token: string, year: number, p: { forkId: string; biome: Biome; setting: Setting }) =>
    fetch(`/api/scenes/${token}/eras/${year}?${new URLSearchParams(p)}`).then(json<EraResult>),

  createEra: (token: string, year: number, p: { forkId: string; biome: Biome; setting: Setting }) =>
    fetch(`/api/scenes/${token}/eras/${year}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }).then(json<EraResult>),

  /** The critic's pass over a draft era; returns the era as it stands after it (maybe a better image). */
  refineEra: (token: string, year: number, p: { forkId: string; biome: Biome; setting: Setting }) =>
    fetch(`/api/scenes/${token}/eras/${year}/refine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }).then(json<EraResult>),
};
