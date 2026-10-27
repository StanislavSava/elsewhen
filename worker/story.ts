// Muse Spark as narrator: for every spot of the scene (the 3×3 cells the time core labels) and every era, one
// short line on what changed there since the era before and why. Text only, from the historian's notes and the
// cell labels, so it never repaints anything. Cached per history by a hash of its inputs.
import { CELL_GRID } from "./cells";
import type { Env } from "./config";
import { sparkJson } from "./meta/client";

export type StoryEra = { year: number; label: string; note: string; cells: string[] | null };

const SCHEMA = {
  type: "object",
  properties: {
    eras: {
      type: "array",
      items: {
        type: "object",
        properties: { year: { type: "number" }, cells: { type: "array", items: { type: "string" } } },
        required: ["year", "cells"],
      },
    },
  },
  required: ["eras"],
};

const SYSTEM = `You narrate how one real place changed through time, for a time-travel app. You get the eras in order,
each with what stood in the whole view and labels for the ${CELL_GRID * CELL_GRID} parts of the picture (a ${CELL_GRID}×${CELL_GRID}
grid in reading order). For every era after the first and every part, write one line of at most 16 words: what changed
in that part since the era before, and why, as a cause a curious visitor would find interesting (a railway arrived,
the river was tamed, the ice retreated, the city went underground). Be concrete and specific to this place and
history. If nothing changed there, say what kept it the same. Plain, calm words; never mention people dying or war.
Return exactly ${CELL_GRID * CELL_GRID} lines per era, for every era after the first.`;

/** year → nine "why" lines, or null when Spark couldn't produce them (the time core simply omits the line). */
export async function writeStory(env: Env, history: string, eras: StoryEra[]): Promise<Record<string, string[]> | null> {
  const table = eras
    .map((e) => `- year ${e.year} (${e.label}): ${e.note || "no description"}\n  parts: ${e.cells ? e.cells.map((c, i) => `${i + 1}. ${c}`).join("; ") : "unknown"}`)
    .join("\n");
  try {
    const r = await sparkJson<{ eras: { year: number; cells: string[] }[] }>(env.MODEL_API_KEY, {
      system: SYSTEM,
      name: "PlaceStory",
      schema: SCHEMA,
      content: [{ type: "text", text: `${history}\nEras, oldest first:\n${table}` }],
    });
    const n = CELL_GRID * CELL_GRID;
    return Object.fromEntries(r.eras.filter((e) => e.cells.length === n).map((e) => [String(e.year), e.cells.map((c) => c.trim())]));
  } catch (err) {
    console.error("story:", String(err).slice(0, 300));
    return null;
  }
}
