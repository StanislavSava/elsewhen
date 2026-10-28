// Muse Spark as historian: looks at the photo and writes what physically stood at THIS spot in each era,
// so a town founded in 1667 isn't painted into 1526, and a 26 CE Polish field isn't a stone town.
// Written once per scene and history, stored in R2; concurrent requests wait for the first one.
import { CHRONICLES, DEFAULT_FORK, findEra, isShared, yearsFor } from "../src/shared/chronicles";
import { BIOMES, CURRENT_YEAR, formatYear, type Biome } from "../src/shared/eras";
import { describeCells } from "./cells";
import { LOCK_TTL_SECONDS, type Env } from "./config";
import { sparkJson } from "./meta/client";

/** Bump when the historian's instructions change, so scenes get fresh notes instead of stale ones. */
const NOTES_VERSION = 6; // 3–4: one continuous story, photo cells; 5: forks reasoned item by item; 6: biome and street
const notesKey = (sceneId: string, forkId: string) =>
  `scenes/${sceneId}/${forkId === DEFAULT_FORK ? "base" : forkId}/notes.v${NOTES_VERSION}.json`;

/**
 * cells: labels for the photo itself (our timeline only), see cells.ts. biome: the place's own climate, read from
 * the photo (the IP-based guess can be a VPN, or a demo's biome left over). road: where in the frame the photo shows
 * a road or street ("" when none); eras keep any road there and nowhere else.
 */
export type Notes = { place: string; eras: Record<string, string>; cells?: string[] | null; biome?: Biome; road?: string };

const SCHEMA = {
  type: "object",
  properties: {
    place: { type: "string" },
    biome: { type: "string", enum: [...BIOMES] },
    road: { type: "string" },
    eras: {
      type: "array",
      items: {
        type: "object",
        properties: {
          year: { type: "number" },
          here: { type: "string" },
        },
        required: ["year", "here"],
      },
    },
  },
  required: ["place", "biome", "road", "eras"],
};

const SYSTEM = `You are a careful historian and landscape scientist helping an app repaint a real photo as the same
spot looked at other times. Study the photo: identify the place as precisely as you can (city, region, landmark,
terrain, climate). Then, for each requested era, write "here": 1-2 concrete sentences describing what physically
stood in THIS camera view at that time: whether there was any settlement at all (most places had none before
recent centuries), and if so how large, which buildings, materials and street surfaces; otherwise the vegetation,
fields, water and terrain. Keep the permanent terrain (hills, coast, rivers, mountains) consistent with the photo.
Be historically and ecologically plausible; prefer "open land / forest / village edge" over inventing a town.
Also give "biome", the natural climate of this place (${BIOMES.join(", ")}), and "road": where in the frame the
photo shows a road, street, parking or vehicle track at ground level, by its position and size (e.g. "a small
parking lane in the bottom-right corner", "a wide street across the lower third"), or "none".

Roads stay where they are: streets and tracks in the past run only where the photo shows one, on the same line,
narrower and unpaved. No era adds a road, track, rails or vehicles anywhere else; at most a narrow footpath.

The eras are one continuous story seen from one fixed camera: the viewer slides between them, so nothing may
appear from nothing. Buildings are preceded by their beginnings: in the last era before buildings stand in this
view MUST show their beginnings: a camp of a few tents, a hut, a cleared plot, a timber frame, stacked building
material, a fence or a footpath, where the buildings will later stand. This is the first sign of the place to come,
even if it is somewhat earlier than the real founding. Big buildings are preceded by smaller, older ones on roughly
the same spots. Say briefly what is new since the previous era.

For future eras up to a thousand years, describe a calm, cared-for, inhabited place where nature and buildings
live together (gardens, planted terraces, meadows); never an empty or deserted one. Never mention people. Plain,
physical description only. Never use words of destruction or decay (collapsed, ruined, ruins, cracked, crumbling,
abandoned, fallen, destroyed, derelict): say that structures still stand, weathered and gently overgrown, or that
nature has grown over them.`;

/** What deep time keeps of the place, so the notes agree with how those eras are painted. */
const DEEP_TIME: Partial<Record<string, string>> = {
  unbuilt: "no structures yet; keep the terrain",
  remains:
    "the lower walls of today's buildings still stand in the same places, roofless, overgrown, trees growing inside them",
  buried: "only low mounds and stones remain where the buildings stood",
  gone: "every trace of the buildings has gone; keep the terrain",
};

export function eraLabel(year: number): string {
  if (year === 0) return `${CURRENT_YEAR} (now)`;
  const cal = CURRENT_YEAR + year;
  const when = Math.abs(year) >= 10_000 ? formatYear(year) : cal < 0 ? `${-cal} BCE` : `${cal} CE`;
  return `${when} (${formatYear(year)})`;
}

async function write(env: Env, forkId: string, photo: string): Promise<Notes> {
  const chronicle = CHRONICLES[forkId];
  const years = yearsFor(forkId).filter((y) => (forkId === DEFAULT_FORK ? y !== 0 : !isShared(forkId, y)));
  const lines = years.map((y) => {
    const era = findEra(forkId, y)!;
    const theme = era.driver === "biology" ? `deep time, no people; ${DEEP_TIME[era.structures] ?? "keep the terrain"}` : era.caption;
    const world =
      era.driver === "culture" && era.world
        ? `; differs from our world: ${era.world.differences.join("; ")}; does not exist: ${era.world.absent.join(", ")}`
        : "";
    return `- year ${y}: ${eraLabel(y)}; theme: ${theme}${world}`;
  });
  const fork =
    forkId === DEFAULT_FORK
      ? "This is our real history."
      : `This is an ALTERNATE history: "${chronicle.title}". ${chronicle.premise} Everything before ${chronicle.divergenceYear} happened as in our history. How it got here: ${chronicle.chain.map((e) => `${e.year}: ${e.event} ${e.consequence}`).join(" ")}
Reason like a historian about THIS place, which may be far from where the change began. For each era, go through what the photo shows (the buildings and their height and density, the street, vehicles, wires, lights, shopfronts, greenery) and say concretely what this history changes here and why, and what it leaves alone. Would this place be bigger, smaller, poorer, richer, or not there at all? The differences listed per era are the world's; apply the ones that would reach this place.`;
  const [r, cells] = await Promise.all([
    sparkJson<{ place: string; biome: Biome; road: string; eras: { year: number; here: string }[] }>(env.MODEL_API_KEY, {
      system: SYSTEM,
      name: "PlaceHistory",
      schema: SCHEMA,
      content: [
        { type: "text", text: `${fork}\nEras:\n${lines.join("\n")}` },
        { type: "image_url", image_url: { url: photo } },
      ],
    }),
    // Our timeline's present is the photo itself, so its labels come from here rather than from a painted era.
    forkId === DEFAULT_FORK ? describeCells(env, photo, eraLabel(0), "") : Promise.resolve(null),
  ]);
  return {
    place: r.place,
    eras: Object.fromEntries(r.eras.map((e) => [String(e.year), e.here])),
    cells,
    biome: BIOMES.includes(r.biome) ? r.biome : undefined,
    road: /^\s*(none|no road|n\/a)?\s*\.?\s*$/i.test(r.road ?? "") ? "" : r.road.trim(),
  };
}

export async function getNotes(env: Env, sceneId: string, forkId: string, photo: () => Promise<string>): Promise<Notes> {
  const key = notesKey(sceneId, forkId);
  const lockKey = `lock:${key}`;
  for (let waited = 0; waited < 120_000; waited += 3000) {
    const existing = await env.BUCKET.get(key);
    if (existing) return (await existing.json()) as Notes;
    if (!(await env.KV.get(lockKey))) {
      await env.KV.put(lockKey, "1", { expirationTtl: LOCK_TTL_SECONDS });
      try {
        const notes = await write(env, forkId, await photo());
        // The KV lock isn't atomic, so two writers can race. The first notes stored win: eras already painted
        // from them are keyed by their text, and replacing them would orphan those eras.
        const raced = await env.BUCKET.get(key);
        if (raced) return (await raced.json()) as Notes;
        await env.BUCKET.put(key, JSON.stringify(notes), { httpMetadata: { contentType: "application/json" } });
        return notes;
      } finally {
        await env.KV.delete(lockKey);
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("timed out waiting for place notes");
}

/**
 * A short name for the place ("Kraków", "Tozeur") for postcards and titles: the historian's place is a free-text
 * description. Asked once per scene and stored on its own, so the notes (and the eras keyed by them) don't change.
 */
export async function townOf(env: Env, sceneId: string, place: string): Promise<string> {
  const key = `scenes/${sceneId}/town.txt`;
  const stored = await env.BUCKET.get(key);
  if (stored) return stored.text();
  const r = await sparkJson<{ town: string }>(env.MODEL_API_KEY, {
    system: "Give the short, commonly used name of the town, city or area this place is in (1-3 words, its usual spelling).",
    name: "Town",
    schema: { type: "object", properties: { town: { type: "string" } }, required: ["town"] },
    content: [{ type: "text", text: place }],
  });
  const town = r.town.trim();
  if (town) await env.BUCKET.put(key, town, { httpMetadata: { contentType: "text/plain" } });
  return town;
}

/** Read-only: the stored notes of one history, or null before research has run. */
export async function readNotes(env: Env, sceneId: string, forkId: string): Promise<Notes | null> {
  const obj = await env.BUCKET.get(notesKey(sceneId, forkId));
  return obj ? ((await obj.json()) as Notes) : null;
}

/** Which history's notes describe an era: shared eras use our timeline's, a fork's own eras use the fork's. */
const notesSource = (forkId: string, year: number) => (isShared(forkId, year) ? DEFAULT_FORK : forkId);

/** The note for one era. */
export async function noteFor(env: Env, sceneId: string, forkId: string, year: number, photo: () => Promise<string>): Promise<string> {
  const notes = await getNotes(env, sceneId, notesSource(forkId, year), photo);
  return notes.eras[String(year)] ?? "";
}

/** Read-only variant for resumes: never triggers a Spark call. Null when the notes don't exist yet. */
export async function readNoteFor(env: Env, sceneId: string, forkId: string, year: number): Promise<string | null> {
  const obj = await env.BUCKET.get(notesKey(sceneId, notesSource(forkId, year)));
  if (!obj) return null;
  const notes = (await obj.json()) as Notes;
  return notes.eras[String(year)] ?? "";
}
