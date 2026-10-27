// Muse Spark names what is in each part of an era's image (a 3×3 grid), so the time core can label the
// tapped spot in every era: "timber granary" in 1526, "brick warehouse" in 1926, "roofless walls" in 12026.
import type { Env } from "./config";
import { sparkJson } from "./meta/client";

export const CELL_GRID = 3;

const SCHEMA = {
  type: "object",
  properties: { cells: { type: "array", items: { type: "string" } } },
  required: ["cells"],
};

const SYSTEM = `You label parts of a photo for a time-travel app. The photo is divided into a ${CELL_GRID}×${CELL_GRID}
grid: rows from top to bottom, columns from left to right, ${CELL_GRID * CELL_GRID} cells in reading order. For each
cell, name the main thing visible in it in 2 to 6 plain words, concrete and specific to what is actually there
(e.g. "timber granary with thatched roof", "birch woodland edge", "cobbled market street", "clear evening sky").
Never mention people. Return exactly ${CELL_GRID * CELL_GRID} labels.`;

/** Nine labels in reading order, or null if Spark didn't return a usable grid (the time core then shows the era only). */
export async function describeCells(env: Env, image: string, era: string, note: string): Promise<string[] | null> {
  try {
    const r = await sparkJson<{ cells: string[] }>(env.MODEL_API_KEY, {
      system: SYSTEM,
      name: "Cells",
      schema: SCHEMA,
      content: [
        { type: "text", text: `Era: ${era}.${note ? ` What stands here: ${note}` : ""}` },
        { type: "image_url", image_url: { url: image } },
      ],
    });
    return r.cells.length === CELL_GRID * CELL_GRID ? r.cells.map((c) => c.trim()) : null;
  } catch (err) {
    console.error(`cells ${era}:`, String(err).slice(0, 200));
    return null;
  }
}
