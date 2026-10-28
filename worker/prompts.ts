// Every prompt is built here, server-side, from the committed chronicles and the historian's notes for this
// place. The client never sends prompt text.
import type { Biome, ChronicleEra, Setting, StructureState, World } from "../src/shared/eras";

/** What happens to the human-made parts of the scene. Never "same footprints" for the past: most places had none. */
const STRUCTURES: Record<StructureState, Record<Setting, string>> = {
  unbuilt: {
    outdoor: "No buildings, roads or human structures exist yet: show only the land described above.",
    indoor: "This room and its building do not exist yet: show the open land at this spot, from the camera's eye height.",
  },
  predecessor: {
    outdoor:
      "Show buildings only where the description above says they stood, at their true size for that era; everywhere else show the fields, woods, water or open ground of that time. No modern buildings, roads, vehicles or objects.",
    indoor: "Turn this room into the interior described above, with the same layout and viewpoint.",
  },
  alternate: {
    outdoor:
      "Show this world's buildings only where the description above says they stand; everywhere else show the land as described. Nothing from our modern world.",
    indoor: "Turn this room into this world's own interior as described, with the same layout and viewpoint.",
  },
  intact: {
    outdoor: "Keep the large structures in the same places and at the same size, changed as described.",
    indoor: "Keep the room layout, changed as described.",
  },
  weathered: {
    outdoor: "Keep the large structures in the same places and at the same size, transformed by time.",
    indoor: "Keep the room layout, transformed by time.",
  },
  overgrown: {
    outdoor: "Keep the large structures in the same places and at the same size, gently overgrown.",
    indoor: "Keep the room layout, gently overgrown.",
  },
  remains: {
    outdoor:
      "Where the buildings stood, only their lower walls remain, in the same places and at the same width, roofless and open to the sky, with plants and trees growing inside them.",
    indoor: "Only the lower walls of this room remain, roofless and open to the sky, with plants growing inside.",
  },
  buried: {
    outdoor: "Only low mounds and stones remain where structures stood.",
    indoor: "Nothing of the room remains: show the land at this spot from the camera's eye height.",
  },
  gone: {
    outdoor: "Every human structure has vanished without a trace.",
    indoor: "The room and its building have vanished without a trace: show the land at this spot.",
  },
};

/** Scale drift was the most visible failure: the model zooms or reframes unless told very precisely not to. */
const CAMERA_LOCK =
  "Same camera, same position, same lens and framing: do not zoom in or out, do not crop, do not change the perspective or camera height. The horizon line, distant hills, mountains and skyline keep exactly the same height, size and position in the frame.";

/** Painted/CGI drift was the other one. */
const PHOTOREAL =
  "The result is a real, unretouched documentary photograph with natural light, true-to-life colours and textures and the same photographic quality as the original: not a painting, illustration, render or concept art. Remove any people.";

const REGIONAL =
  "Use the building materials, architectural traditions, plants and climate of this place's own region, as seen in the photo.";

/** Deep-time eras have an animal in them; asking for it to be "clearly visible" made the model zoom in to show it. */
const WILDLIFE_SCALE =
  "Any animal appears at its true size for its distance from this camera, even if small; never move the camera closer to show it.";

/**
 * Invented roads were the most visible error of the past eras: a road across a courtyard. Roads keep their line.
 * road: where the photo shows one ("" for none, from the historian); null when we don't know.
 */
function roadsClause(road: string | null): string {
  if (road === "")
    return "This view has no road or street and never gets one: no road, track, rails, cars, carts or trams anywhere; at most a narrow footpath.";
  const where = road ? `The only road in this view is ${road}: any road, track or vehicle stays there, on the same line (narrower and unpaved in the past)` : "Roads and tracks run only where the photo shows a street, along the same line (narrower and unpaved in the past)";
  return `${where}; never add a road, track, rails or vehicles anywhere else.`;
}

/** An alternate era is painted as a set of consequences, relative to what the photo shows of our world. */
export function worldClause(w: World): string {
  return `What is different from our world: ${w.differences.join("; ")}. Keep what this history would not change: ${w.kept.join("; ")}. None of these exist here: ${w.absent.join(", ")}.`;
}

export function eraPrompt(
  era: ChronicleEra,
  biome: Biome,
  setting: Setting,
  note: string,
  road: string | null,
  fixes = "",
): string {
  const theme =
    era.driver === "biology"
      ? era.biomes[biome].visualPrompt
      : setting === "indoor" && era.visualPromptIndoor
        ? era.visualPromptIndoor
        : era.visualPrompt;
  const here = note ? ` At this exact place in this era: ${note}` : "";
  const world = era.driver === "culture" && era.world ? ` ${worldClause(era.world)}` : "";
  const regional = era.driver === "culture" ? ` ${REGIONAL}` : ` ${WILDLIFE_SCALE}`;
  const roads = era.driver === "culture" && setting === "outdoor" ? ` ${roadsClause(road)}` : "";
  const fix = fixes ? ` A previous attempt had these problems, avoid them: ${fixes}` : "";
  return `${theme}${world}${here}${regional} ${STRUCTURES[era.structures][setting]}${roads} ${CAMERA_LOCK} ${PHOTOREAL}${fix}`;
}

/** The smallest prompt that still keeps the photo: for eras the content filter keeps blocking. */
export function bareEraPrompt(era: ChronicleEra, biome: Biome, setting: Setting, road: string | null): string {
  const theme = era.driver === "biology" ? era.biomes[biome].visualPrompt : era.visualPrompt;
  const roads = era.driver === "culture" && setting === "outdoor" ? ` ${roadsClause(road)}` : "";
  return `${theme} ${STRUCTURES[era.structures][setting]}${roads} ${CAMERA_LOCK} ${PHOTOREAL}`;
}

/** Bump when how an era is painted or checked changes (not just its prompt), so old results aren't served. */
const PIPELINE_VERSION = 6; // 2: critic + SAM building overlap; 3: no idea fossils, cell labels; 4: repaints re-checked; 5: alternate worlds as consequences; 6: roads keep their line

/** Short hash of everything that shapes an era's image, so editing a chronicle regenerates only what changed. */
export async function promptVersion(
  era: ChronicleEra,
  biome: Biome,
  setting: Setting,
  note: string,
  road: string | null,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${PIPELINE_VERSION}|${eraPrompt(era, biome, setting, note, road)}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deep-time eras have a creature to tap; SAM finds it by this phrase. */
export const CREATURE_PHRASE = "animal";
