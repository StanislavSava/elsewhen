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
  "no-electricity": {
    title: "Electricity was never harnessed",
    divergenceYear: 1831,
    premise:
      "In 1831 Faraday's induction experiments fail and are set aside; no one finds a practical way to make " +
      "electricity. The world modernizes anyway, on steam, clockwork, compressed air, gaslight, wind and water: " +
      "cities of brass, glass and pneumatic tubes, mechanical calculators, and slow, luminous gaslit evenings.",
  },
  "treasure-fleets": {
    title: "The treasure fleets never turned back",
    divergenceYear: 1433,
    premise:
      "In 1433 the Ming court keeps funding Zheng He's treasure fleets instead of burning the ships. Great junks " +
      "keep sailing the Indian Ocean and the Pacific, and a maritime trading world of harbors, silk, porcelain, " +
      "printed charts and civil examinations spreads its tastes and ideas to every coast.",
  },
  "tamed-mammoth": {
    title: "Humans tamed the mammoth",
    divergenceYear: -12000,
    premise:
      "Around 12,000 BCE herders on the cold steppe tame the woolly mammoth before it vanishes. Mammoths become " +
      "draft animals, wool flocks and companions; they survive the warming climate under human care, and a " +
      "herding culture of wide trails, big gates, wool and patient giants shapes how the world farms, travels and builds.",
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
  buildings are and do in this world (halls, workshops, signs, street furniture, light), always "in the
  region's own building tradition" (never "on the same footprints": a place may have had no buildings yet). Never name region-specific materials or styles
  (no "timber-framed", "thatched", "half-timbered"): the photo can be anywhere on Earth. 2-3 sentences.
- visualPromptIndoor: same era as an interior, 1-2 sentences.
- caption: max 60 characters, format "<year or period> · <short evocative phrase>".
- Everything is calm and peaceful. Never describe war, violence, ruins, destruction, collapse, decay,
  abandonment, disaster, death or people leaving (an image content filter blocks those). Futures are serene.
- Ideologies and institutions are fictional and benign (no real political movements, parties, leaders,
  flags or religious symbols). Persuasion can be grand, but never hateful.
- The 1000-years-ahead era shows nature gently reclaiming this world's buildings.
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
      return `- year ${y} (calendar ${when}): structures "${STATES[y]}"`;
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
