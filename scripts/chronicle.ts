// Drafts a fork chronicle with Muse Spark (structured output), validated against the shared schema.
// Usage: node scripts/chronicle.ts <fork-id>   (writes forks/drafts/<fork-id>.json for hand-editing)
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { CURRENT_YEAR, ChronicleEra } from "../src/shared/eras.ts";

const SPARK_MODEL = "muse-spark-1.3";

const FORKS: Record<string, { title: string; divergenceYear: number; premise: string }> = {
  "rome-never-fell": {
    title: "The Roman Empire never fell",
    divergenceYear: 476,
    premise:
      "In 476 the Western Roman Empire weathers its crisis: the legions are reformed, the borders hold, and " +
      "Rome remains one state from Britain to Mesopotamia. Latin law, roads, aqueducts, concrete and a single " +
      "currency carry on unbroken, and Europe never fragments into feudal kingdoms.",
  },
  "no-printing-press": {
    title: "The printing press was never invented",
    divergenceYear: 1440,
    premise:
      "In 1440 Gutenberg's workshop fails and movable type never spreads. Books stay handwritten and costly, " +
      "literacy stays rare, and knowledge moves slowly through scribes, images and the spoken word.",
  },
  "no-electricity": {
    title: "Electricity was never harnessed",
    divergenceYear: 1831,
    premise:
      "In 1831 Faraday's induction experiments fail and no practical way to generate electricity is ever found. " +
      "The world keeps industrializing on coal, steam, gas, compressed air and clockwork.",
  },
  "tamed-mammoth": {
    title: "Humans tamed the mammoth",
    divergenceYear: -12000,
    premise:
      "Around 12,000 BCE herders on the cold steppe domesticate the woolly mammoth before it dies out. Mammoths " +
      "become draft animals and wool herds, survive the warming climate under human care, and shape how people " +
      "farm, travel and build.",
  },
  "library-of-alexandria": {
    title: "The Library of Alexandria never burned",
    divergenceYear: -48,
    premise:
      "In 48 BCE the fire in Alexandria is put out and the Library survives. Its scholars keep copying, testing " +
      "and connecting ideas, and technology runs about 800 years ahead of ours: practical steam engines by 900 CE, " +
      "railways and gaslight by about 1150, electricity by about 1350. Its 1526 looks like our 1900, its 1926 " +
      "like our 2026, and its 2026 is a century beyond ours.",
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

const STYLE = `You write alternate histories for Elsewhen, an app that repaints a user's photo of a real place
(anywhere on Earth) as it would look at the same spot in another history. Reason like a serious historian of
counterfactuals: causes, technology, trade, money, population and geography, not themes or moods.

Rules:
- chain: 5-7 events from the divergence to ${CURRENT_YEAR}, each with a calendar year (negative = BCE): what
  happened and its consequence, concrete and causally linked, grounded in real historical mechanisms. No invented
  societies, leagues or movements with cute names.
- For every era, world = how the built world at that date differs from ours at the same date, as a camera in a
  street would see it:
  - differences: 4-6 items, each "X instead of Y (because ...)", physical and visible: building height and
    density, materials, how big towns are, transport and vehicles, street surface, lighting and power, signage,
    farming and land use. Include at least one about building height or density and one about transport.
  - absent: 4-8 concrete things our world has at that date that this one does not, and that must not appear
    (e.g. "cars", "overhead power lines", "glass office towers").
  - kept: 2-4 things this history leaves as in ours (terrain, climate, trees, the region's traditional style...).
- visualPrompt: "Transform this scene to <calendar year> in a world where <the fork, lowercased>." then 1-2
  sentences naming the most visible consequences. Never name region-specific materials or styles (the photo can
  be anywhere); say "in the region's own building tradition" when it matters. No invented institutions.
- visualPromptIndoor: the same era as an interior, 1-2 sentences.
- caption: max 60 characters, "<calendar year> · <the most visible consequence, plainly>".
- Keep wording calm and physical. Never write war, violence, ruins, destruction, collapse, decay, abandonment,
  disaster or death (an image content filter blocks those). No real political movements, leaders, flags or
  religious symbols.
- The 1000-years-ahead era: this world's buildings, cared for and grown over with gardens and trees.`;

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

Write the premise (2-3 plain sentences), the chain, and exactly these eras (driver "culture", year = the
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
