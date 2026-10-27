// Muse Spark as critic: compares an edited era with the original photo. Failing edits are regenerated once
// with the critic's issues added (spike + review: zoom drift, painted look, towns that didn't exist yet).
import type { Env } from "./config";
import { sparkJson } from "./meta/client";

export type Verdict = {
  sameViewpoint: boolean;
  sameScale: boolean;
  photographic: boolean;
  plausibleForEra: boolean;
  issues: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    sameViewpoint: { type: "boolean" },
    sameScale: { type: "boolean" },
    photographic: { type: "boolean" },
    plausibleForEra: { type: "boolean" },
    issues: { type: "string" },
  },
  required: ["sameViewpoint", "sameScale", "photographic", "plausibleForEra", "issues"],
};

const SYSTEM = `You are a strict photo editor checking an AI time-travel edit of a real photo. Image 1 is the
original photo. Image 2 must show the SAME place, from the SAME camera position, focal length and framing, at
another time. Judge: sameViewpoint (camera position, direction and horizon height unchanged), sameScale (no zoom
in or out: distant landmarks, hills and the skyline keep the same apparent size and position; if image 2 looks
taken from closer, lower or with a longer lens, e.g. a high view over a city that became a close view of a
clearing so an animal can be seen, sameScale is false), photographic
(looks like a real, unretouched photograph, not a painting, illustration or CGI render; a painted sign or poster
inside the scene is fine), plausibleForEra (matches the era description: buildings only where it says they stood,
no modern objects in the past, nothing the description says must not be shown; plants belong to this region and
climate, e.g. no cacti outside the Americas, no palms in a cold climate). Judge the foreground and middle ground: ignore small details on the far horizon. When the era belongs to an
alternate history, judge against that history, not ours (its own animals, buildings and technology are correct
there). issues: one short sentence of concrete problems, empty if none.`;

export async function judge(env: Env, photo: string, edited: string, era: string, note: string): Promise<Verdict> {
  return sparkJson<Verdict>(env.MODEL_API_KEY, {
    system: SYSTEM,
    name: "Verdict",
    schema: SCHEMA,
    content: [
      { type: "text", text: `Era of image 2: ${era}. What should be there: ${note}` },
      { type: "image_url", image_url: { url: photo } },
      { type: "image_url", image_url: { url: edited } },
    ],
  });
}

export const passes = (v: Verdict) => v.sameViewpoint && v.sameScale && v.photographic && v.plausibleForEra;
