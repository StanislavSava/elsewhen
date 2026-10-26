// Muse Spark as historian: looks at the photo and writes what physically stood at THIS spot in each era,
// so a town founded in 1667 isn't painted into 1526, and a 26 CE Polish field isn't a stone town.
// Written once per scene and history, stored in R2; concurrent requests wait for the first one.
import { CHRONICLES, DEFAULT_FORK, findEra, isShared, yearsFor } from "../src/shared/chronicles";
import { CURRENT_YEAR, formatYear, type Fossil } from "../src/shared/eras";
import { LOCK_TTL_SECONDS, type Env } from "./config";
import { sparkJson } from "./meta/client";

/** Bump when the historian's instructions change, so scenes get fresh notes instead of stale ones. */
const NOTES_VERSION = 2;
const notesKey = (sceneId: string, forkId: string) =>
  `scenes/${sceneId}/${forkId === DEFAULT_FORK ? "base" : forkId}/notes.v${NOTES_VERSION}.json`;

export type Notes = { place: string; eras: Record<string, string>; fossils?: Record<string, Fossil> };

const SCHEMA = {
  type: "object",
  properties: {
    place: { type: "string" },
    eras: {
      type: "array",
      items: {
        type: "object",
        properties: {
          year: { type: "number" },
          here: { type: "string" },
          fossil: {
            type: "object",
            description: "Only when the default idea fossil could not plausibly exist at this place in this era.",
            properties: {
              medium: { type: "string" },
              brief: { type: "string" },
              slogan: { type: "string" },
              elements: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, technique: { type: "string" }, explanation: { type: "string" } },
                  required: ["name", "technique", "explanation"],
                },
              },
            },
            required: ["medium", "brief", "slogan", "elements"],
          },
        },
        required: ["year", "here"],
      },
    },
  },
  required: ["place", "eras"],
};

const SYSTEM = `You are a careful historian and landscape scientist helping an app repaint a real photo as the same
spot looked at other times. Study the photo: identify the place as precisely as you can (city, region, landmark,
terrain, climate). Then, for each requested era, write "here": 1-2 concrete sentences describing what physically
stood in THIS camera view at that time: whether there was any settlement at all (most places had none before
recent centuries), and if so how large, which buildings, materials and street surfaces; otherwise the vegetation,
fields, water and terrain. Keep the permanent terrain (hills, coast, rivers, mountains) consistent with the photo.
Be historically and ecologically plausible; prefer "open land / forest / village edge" over inventing a town.
For future eras up to a thousand years, describe a calm, cared-for, inhabited place where nature and buildings
live together (gardens, planted terraces, meadows); never an empty or deserted one. Never mention people. Plain, physical description only.
Never use words of destruction or decay (collapsed, ruined, ruins, cracked, crumbling, abandoned, fallen, destroyed,
derelict): say that structures still stand, weathered and gently overgrown, or that nature has grown over them.

Some eras have a default "idea fossil": an artifact through which that era's winning idea persuades, placed in the
scene. If it could not plausibly exist at THIS place in that era (e.g. a European bakery sign in a pre-colonial
forest village), add "fossil" with a replacement that would: medium (one word: post, carving, mural, poster, sign,
banner, panel...), brief (front-facing image description with 3 clearly separate visual elements, ending with
"No letters, no words, no text of any kind."), slogan (max 6 words, the idea it carries), and 3 elements (name: a
plain concrete 1-2 word noun naming one element exactly as in the brief, e.g. "bird", "sun", "woman"; technique: a
persuasion technique; explanation: one sentence). Omit "fossil" when the default fits.`;

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
    const theme = era.driver === "biology" ? "deep time (no humans; keep the terrain)" : era.caption;
    const fossil = era.driver === "culture" && era.fossil ? `; default idea fossil: ${era.fossil.medium}: ${era.fossil.brief}` : "";
    return `- year ${y}: ${eraLabel(y)}; theme: ${theme}${fossil}`;
  });
  const fork =
    forkId === DEFAULT_FORK
      ? "This is our real history."
      : `This is an ALTERNATE history: "${chronicle.title}". ${chronicle.premise} Everything before ${chronicle.divergenceYear} happened as in our history. Show how this world's ideas would plausibly show up at THIS place (which may be remote from where the change began); if no settlement would plausibly stand here, say so.`;
  const r = await sparkJson<{ place: string; eras: { year: number; here: string; fossil?: Fossil }[] }>(env.MODEL_API_KEY, {
    system: SYSTEM,
    name: "PlaceHistory",
    schema: SCHEMA,
    content: [
      { type: "text", text: `${fork}\nEras:\n${lines.join("\n")}` },
      { type: "image_url", image_url: { url: photo } },
    ],
  });
  return {
    place: r.place,
    eras: Object.fromEntries(r.eras.map((e) => [String(e.year), e.here])),
    fossils: Object.fromEntries(r.eras.filter((e) => e.fossil?.brief).map((e) => [String(e.year), e.fossil!])),
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

export type PlaceNote = { note: string; fossil?: Fossil };

/** The note for one era: shared eras use our timeline's notes, a fork's own eras use the fork's. */
export async function noteFor(env: Env, sceneId: string, forkId: string, year: number, photo: () => Promise<string>): Promise<PlaceNote> {
  const source = isShared(forkId, year) ? DEFAULT_FORK : forkId;
  const notes = await getNotes(env, sceneId, source, photo);
  return { note: notes.eras[String(year)] ?? "", fossil: notes.fossils?.[String(year)] };
}

/** Read-only variant for resumes: never triggers a Spark call. Null when the notes don't exist yet. */
export async function readNoteFor(env: Env, sceneId: string, forkId: string, year: number): Promise<PlaceNote | null> {
  const source = isShared(forkId, year) ? DEFAULT_FORK : forkId;
  const obj = await env.BUCKET.get(notesKey(sceneId, source));
  if (!obj) return null;
  const notes = (await obj.json()) as Notes;
  return { note: notes.eras[String(year)] ?? "", fossil: notes.fossils?.[String(year)] };
}
