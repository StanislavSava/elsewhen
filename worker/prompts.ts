// Every prompt is built here, server-side, from the committed chronicles. The client never sends prompt text.
import type { Biome, ChronicleEra, Fossil, Setting, StructureState } from "../src/shared/eras";

const PRESERVE: Record<StructureState, Record<Setting, string>> = {
  unbuilt: {
    outdoor:
      "The buildings and roads in this photo do not exist yet. Show the open land at this exact spot, from the same viewpoint, height and direction, keeping the horizon line and terrain. Remove any people. Photorealistic photograph.",
    indoor:
      "This room and its building do not exist yet. Show the open land at this exact spot, from the same viewpoint, eye height and direction as the camera. Remove any people. Photorealistic photograph.",
  },
  predecessor: {
    outdoor:
      "Replace the modern buildings with earlier, era-appropriate structures on the same footprints. Keep the same viewpoint, framing and horizon line. Remove any people. Photorealistic photograph.",
    indoor:
      "Turn this room into an era-appropriate interior on the same footprint, with the same viewpoint and framing. Remove any people. Photorealistic photograph.",
  },
  alternate: {
    outdoor:
      "Replace the buildings with this world's own architecture on the same footprints, as described. Keep the same viewpoint, framing, horizon line and terrain. Remove any people. Photorealistic photograph.",
    indoor:
      "Turn this room into this world's own interior on the same footprint, as described, with the same viewpoint and framing. Remove any people. Photorealistic photograph.",
  },
  intact: {
    outdoor:
      "Keep the exact same camera position, framing, horizon line and perspective. Keep the large structures in the same places. Remove any people. Photorealistic photograph.",
    indoor: "Keep the exact same camera position, framing and room layout. Remove any people. Photorealistic photograph.",
  },
  weathered: {
    outdoor:
      "Keep the exact same camera position, framing, horizon line and perspective. Keep the large structures in the same places, transformed by time. Photorealistic photograph.",
    indoor: "Keep the exact same camera position, framing and room layout, transformed by time. Photorealistic photograph.",
  },
  overgrown: {
    outdoor:
      "Keep the exact same camera position, framing, horizon line and perspective. Keep the large structures in the same places, transformed by time. Photorealistic photograph.",
    indoor: "Keep the exact same camera position, framing and room layout. Photorealistic photograph.",
  },
  buried: {
    outdoor:
      "Keep the same camera viewpoint, height, direction, horizon line and terrain. Photorealistic photograph.",
    indoor: "Keep the same viewpoint, eye height and direction as the camera. Photorealistic photograph.",
  },
  gone: {
    outdoor:
      "Every human structure has vanished without a trace. Keep the same camera viewpoint, height, direction, horizon line and terrain. Photorealistic photograph.",
    indoor:
      "The room and its building have vanished without a trace. Keep the same viewpoint, eye height and direction as the camera. Photorealistic photograph.",
  },
};

/** Culture eras must look like this place, not like the chronicle author's Europe (spike: 1526 Tunisia came out half-timbered). */
const REGIONAL =
  "Use the building materials, architectural traditions, plants and climate of this place's own region, as seen in the photo.";

export function eraPrompt(era: ChronicleEra, biome: Biome, setting: Setting): string {
  const text =
    era.driver === "biology"
      ? era.biomes[biome].visualPrompt
      : setting === "indoor" && era.visualPromptIndoor
        ? era.visualPromptIndoor
        : era.visualPrompt;
  const regional = era.driver === "culture" && era.structures !== "overgrown" ? ` ${REGIONAL}` : "";
  return `${text}${regional} ${PRESERVE[era.structures][setting]}`;
}

/** Short hash of everything that shapes an era's image, so editing a chronicle regenerates only what changed. */
export async function promptVersion(era: ChronicleEra, biome: Biome, setting: Setting): Promise<string> {
  const fossil = era.driver === "culture" && era.fossil ? `${fossilPrompt(era.fossil)}|${fossilPlacement(era.fossil)}` : "";
  const bytes = new TextEncoder().encode(`${eraPrompt(era, biome, setting)}|${fossil}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fossilPrompt(fossil: Fossil): string {
  return `${fossil.brief} Flat, front-facing, filling the whole frame.`;
}

export function fossilPlacement(fossil: Fossil): string {
  return `Place the ${fossil.medium} from the second image into the first image where it fits naturally (on a wall or facade facing the camera), large enough to be clearly seen, with correct perspective and lighting, looking like it belongs to this era. Keep the ${fossil.medium} itself unchanged.`;
}

/** The noun phrase SAM uses to find the tappable subject of an era. */
export function targetPhrase(era: ChronicleEra): string | null {
  if (era.driver === "biology") return "animal";
  return era.fossil ? era.fossil.medium : null;
}
