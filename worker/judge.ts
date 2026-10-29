// Muse Spark as critic: compares an edited era with the original photo and, when there is one, with its
// neighbouring era toward now, so the eras agree with each other and not only with the photo. Each criterion
// is kept separate and weighted: losing the camera or the geometry is worse than a slightly painterly look.
import type { Env } from "./config";
import { sparkJson } from "./meta/client";

export type Verdict = {
  sameViewpoint: boolean;
  sameScale: boolean;
  photographic: boolean;
  plausibleForEra: boolean;
  sameLight: boolean;
  continuity: boolean;
  issues: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    sameViewpoint: { type: "boolean" },
    sameScale: { type: "boolean" },
    photographic: { type: "boolean" },
    plausibleForEra: { type: "boolean" },
    sameLight: { type: "boolean" },
    continuity: { type: "boolean" },
    issues: { type: "string" },
  },
  required: ["sameViewpoint", "sameScale", "photographic", "plausibleForEra", "sameLight", "continuity", "issues"],
};

const SYSTEM = `You are a strict photo editor checking an AI time-travel edit of a real photo. Image 1 is the
original photo. Image 2 must show the SAME place, from the SAME camera position, focal length and framing, at
another time. Judge: sameViewpoint (camera position, direction and horizon height unchanged), sameScale (no zoom
in or out: distant landforms keep the same apparent size and position; if image 2 looks taken from closer, lower
or with a longer lens, e.g. a high view over a city that became a close view of a clearing so an animal can be
seen, sameScale is false; buildings on the skyline may change with the era), photographic (looks like a real,
unretouched photograph, not a painting, illustration or CGI render; a painted sign or poster inside the scene is
fine), plausibleForEra (matches the era description: buildings only where it says they stood, no modern objects
in the past, nothing the description says must not be shown; plants belong to this region and climate, e.g. no
cacti outside the Americas, no palms in a cold climate), sameLight (the same kind of day as image 1: weather, sky
brightness, time of day and direction of light; false only for a clear mismatch such as a golden sunset or blue
sky over an overcast photo, or night for day; for recorded history also the season, e.g. bare winter trees or
snow in a summer photo; in deep time a different season or climate is fine), continuity (only when an image 3 is
given, the same view in a neighbouring era: whatever stands in both eras keeps its position, footprint and
identity, roads keep their line, the ground level and big landforms agree, and the differences are the kind the
time between them explains; if there is no image 3, true). Judge the foreground and middle ground: ignore small
details on the far horizon. When the era belongs to an alternate history, judge against that history, not ours
(its own animals, buildings and technology are correct there). issues: one short sentence of concrete problems,
empty if none.`;

export type Neighbour = { image: string; label: string };

export async function judge(
  env: Env,
  photo: string,
  edited: string,
  era: string,
  note: string,
  neighbour: Neighbour | null = null,
): Promise<Verdict> {
  const v = await sparkJson<Verdict>(env.MODEL_API_KEY, {
    system: SYSTEM,
    name: "Verdict",
    schema: SCHEMA,
    content: [
      {
        type: "text",
        text: `Era of image 2: ${era}. What should be there: ${note}${neighbour ? ` Image 3 is the same view in ${neighbour.label}.` : ""}`,
      },
      { type: "image_url", image_url: { url: photo } },
      { type: "image_url", image_url: { url: edited } },
      ...(neighbour ? [{ type: "image_url" as const, image_url: { url: neighbour.image } }] : []),
    ],
  });
  return neighbour ? v : { ...v, continuity: true };
}

/** How badly a verdict fails: the camera and the eras' agreement weigh most, since they break the illusion. */
const WEIGHTS: Record<Exclude<keyof Verdict, "issues">, number> = {
  sameViewpoint: 3,
  sameScale: 3,
  continuity: 2,
  plausibleForEra: 1,
  photographic: 1,
  sameLight: 1,
};

export function penalty(v: Verdict): number {
  return (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((sum, k) => sum + (v[k] === false ? WEIGHTS[k] : 0), 0);
}
