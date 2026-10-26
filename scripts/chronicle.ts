// Drafts a fork chronicle with Muse Spark (structured output), validated against the shared schema.
// Usage: node scripts/chronicle.ts <fork-id>   (writes forks/drafts/<fork-id>.json for hand-editing)
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { CURRENT_YEAR, ChronicleEra } from "../src/shared/eras.ts";

const SPARK_MODEL = "muse-spark-1.3";

const FORKS: Record<string, { title: string; divergenceYear: number; premise: string }> = {
  "no-printing-press": {
    title: "The printing press was never invented",
    divergenceYear: 1440,
    premise:
      "In 1440 Gutenberg's workshop fails and movable type never spreads. Knowledge stays handwritten, " +
      "costly and guarded: guilds of scribes and memorizers become the great institutions, ideas travel " +
      "by recitation, images and seals, and the slow, spoken culture shapes everything from architecture " +
      "to how cities look today.",
  },
  "library-of-alexandria": {
    title: "The Library of Alexandria never burned",
    divergenceYear: -48,
    premise:
      "In 48 BCE the fire in Alexandria is put out and the Library survives. Its scholars keep copying, " +
      "testing and connecting ideas; mechanical and medical knowledge compounds for centuries. A " +
      "Hellenistic culture of observation, steam and geometry reaches the modern era a thousand years " +
      "early, and the world looks classical, mechanical and luminous.",
  },
};

const MEDIA: Record<number, string> = {
  [-2000]: "a carved stone relief",
  [-500]: "a painted mural or a hanging painted sign",
  [-100]: "a printed or painted poster (or this world's equivalent)",
  [0]: "a large illustrated public panel or billboard",
  [100]: "a softly glowing illuminated panel",
};

const STATES: Record<number, string> = {
  [-2000]: "predecessor",
  [-500]: "predecessor",
  [-100]: "predecessor",
  [0]: "alternate",
  [100]: "alternate",
  [1000]: "overgrown",
};

const CultureEra = ChronicleEra.options[0];
const Draft = z.object({
  premise: z.string(),
  chain: z.array(z.object({ year: z.number(), event: z.string(), consequence: z.string() })).min(5).max(7),
  eras: z.array(CultureEra),
});

const STYLE = `You write chronicles for Elsewhen, an app that repaints a user's photo of a real place as it looks in
an alternate history. Each era's visualPrompt is an image-edit instruction applied to the user's photo.

Rules:
- visualPrompt starts with "Transform this scene to <calendar year or period>." then describes what the
  buildings are and do in this world (halls, workshops, signs, street furniture, light), always "on the same
  footprints" and "in the region's own building tradition". Never name region-specific materials or styles
  (no "timber-framed", "thatched", "half-timbered"): the photo can be anywhere on Earth. 2-3 sentences.
- visualPromptIndoor: same era as an interior, 1-2 sentences.
- caption: max 60 characters, format "<year or period> · <short evocative phrase>".
- Everything is calm and peaceful. Never describe war, violence, ruins, destruction, collapse, decay,
  abandonment, disaster, death or people leaving (an image content filter blocks those). Futures are serene.
- Ideologies and institutions are fictional and benign (no real political movements, parties, leaders,
  flags or religious symbols). Persuasion can be grand, but never hateful.
- fossil = the "idea fossil" of the era: the artifact through which the winning idea of that world persuades.
  medium: one word (relief, mural, sign, poster, billboard, panel...).
  brief: a front-facing image description of the artifact with 3-4 clearly separate visual elements,
  and it MUST end with "No letters, no words, no text of any kind." (image models garble text).
  slogan: a short line (max 6 words) that the app sets as real typography.
  elements: 3 items; each name is a plain, concrete, common noun of 1-2 words for one visual element in the
  brief, the kind an object detector finds (e.g. "old man", "children", "tram", "border", "trees"; never
  abstract or literary words like "elder", "wisdom", "seal stamps"). It is used to segment the image.
  technique = a persuasion technique, explanation = one sentence.
- The 1000-years-ahead era has no fossil; it shows nature gently reclaiming this world's buildings.
- chain: 5-7 events from the divergence to ${CURRENT_YEAR}, each with a calendar year (negative = BCE),
  what happened, and its consequence. Plausible and causally linked.`;

async function draft(forkId: string): Promise<void> {
  const fork = FORKS[forkId];
  if (!fork) throw new Error(`unknown fork ${forkId}; known: ${Object.keys(FORKS).join(", ")}`);
  const env = Object.fromEntries(
    readFileSync(".env", "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
  );
  const rel = fork.divergenceYear - CURRENT_YEAR;
  const years = Object.keys(STATES)
    .map(Number)
    .filter((y) => y >= rel)
    .sort((a, b) => a - b);
  const spec = years
    .map((y) => {
      const cal = CURRENT_YEAR + y;
      const when = cal < 0 ? `${-cal} BCE` : `${cal}`;
      return `- year ${y} (calendar ${when}): structures "${STATES[y]}"${MEDIA[y] ? `; fossil medium: ${MEDIA[y]}` : "; no fossil"}`;
    })
    .join("\n");

  const res = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.MODEL_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: SPARK_MODEL,
      messages: [
        { role: "system", content: STYLE },
        {
          role: "user",
          content: `Fork: "${fork.title}" (diverges in ${fork.divergenceYear < 0 ? `${-fork.divergenceYear} BCE` : fork.divergenceYear}).
Premise: ${fork.premise}

Write the premise (2-3 vivid sentences), the chain, and exactly these eras (driver "culture", year = the
relative year given, structures as given):
${spec}`,
        },
      ],
      response_format: { type: "json_schema", json_schema: { name: "ForkChronicle", schema: z.toJSONSchema(Draft) } },
    }),
  });
  if (!res.ok) throw new Error(`Spark ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsed = Draft.parse(JSON.parse(body.choices[0].message.content));
  const chronicle = { forkId, title: fork.title, divergenceYear: fork.divergenceYear, ...parsed };
  writeFileSync(`forks/drafts/${forkId}.json`, JSON.stringify(chronicle, null, 2) + "\n");
  console.log(`forks/drafts/${forkId}.json: ${parsed.eras.length} eras, ${parsed.chain.length} chain events`);
}

for (const id of process.argv.slice(2)) await draft(id);
