# Elsewhen

A window through time: point your phone at any place and scrub from a million years ago to a million years ahead, in our history or one that went differently.

The slider spans two kinds of evolution. Near now, **ideas** evolve: the architecture changes, and each era leaves an *idea fossil* (a carved relief, a guild sign, a poster) that you can tap and take apart into its persuasion techniques. In deep time, **life** evolves: real extinct animals in the past, speculative descendants in the future, matched to your region, each with a field-guide card. *History and biology are the same process at different speeds.*

Built for the Meta Global AI Developer Hackathon (indie track).

## How Meta's models are used

| Model | Role |
|---|---|
| **Muse Image** (`muse-image-1.0`) | Repaints the captured photo for each era (instruction edits that keep the viewpoint, horizon and footprints), generates text-free idea fossils, and blends each fossil into its scene with multi-image edits. |
| **SAM 3.1** (`sam-3.1`) | Segments the photo (sky, trees, buildings, ground) into a delay map, so transitions change the sky first and buildings last; finds the creature or fossil in each era to make it tappable; cuts fossils into elements for the exploded view. |
| **Muse Spark** (`muse-spark-1.3`) | Drafts the alternate-history chronicles (chain of events, era prompts, fossils and their persuasion techniques) with structured output against the app's schema (`scripts/chronicle.ts`), which are then hand-edited. |

## Architecture

- **Client:** Vite + TypeScript + three.js. A full-screen shader blends keyframes with a per-pixel schedule from the SAM delay map, adds a symlog time slider (±1M years), look-around (mouse, drag or gyro), and the field-guide and exploded-fossil sheets. The scene token lives in the URL, so reloads and shared links resume from storage.
- **Worker:** Hono on Cloudflare Workers (same Vite project via `@cloudflare/vite-plugin`), with R2 for images and SAM output and KV for the daily budget. It builds every prompt server-side from the committed chronicles (the client never sends prompt text), checks Turnstile on scene creation, signs scene tokens, caps daily spend, and stores each era once per scene/history/biome.
- **Content:** `forks/*.json`: our timeline (cited extinct fauna, four biomes) and alternate histories. Eras before a divergence, and all of deep time, are shared between histories.

## Run locally

Requires Node 22+ and a Meta Model API key.

```bash
cp .env.example .env   # add MODEL_API_KEY
npm install
npm run dev
```

Local dev uses Cloudflare's test Turnstile keys and simulated R2/KV. `npm test` runs the unit tests; `npm run typecheck` checks client and Worker.

Draft a new alternate history with Muse Spark:

```bash
node scripts/chronicle.ts no-printing-press
```

## Docs

- [Implementation plan](docs/implementation-plan.md): design, decisions and spike results
- [Execution plan](docs/execution-plan.md): task-by-task build plan
