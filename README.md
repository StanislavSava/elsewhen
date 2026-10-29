# Elsewhen

A window through time: point your phone at any place and scrub from a million years ago to a million years ahead, in our history or one that went differently.

Take a photo and a slider opens eleven moments of that exact view: a mammoth floodplain, the end of the ice age, the first huts, a village in 1526, the town in 1926, its buildings going up in 1976, today, green roofs in 2126, a garden city in 3026, roofless walls in a forest 10,000 years on, and a new ecosystem a million years ahead. Eras flow into each other: buildings rise from the ground and wear away from the roofline, clouds drift and days pass as you scrub. Tap any spot to see it across every era at once, with a line on what changed there and why; tap a creature for its field-guide card. Switch to an alternate history (the Roman Empire never fell, humans tamed the mammoth, the Library of Alexandria never burned, electricity was never harnessed…) and the same place becomes what that world would have made of it.

Built for the Meta Global AI Developer Hackathon (indie track).

## How Meta's models are used

| Model | Role |
|---|---|
| **Muse Image** (`muse-image-1.0`) | Repaints the photo for every era. Each era is painted with the photo plus its already-painted neighbour toward now as a second image, so a 1526 cottage stands where the 1926 house will. |
| **SAM 3.1** (`sam-3.1`) | Segments the photo into a transition schedule (sky first, buildings last), finds each era's own buildings so they rise and fall individually, measures whether kept buildings stayed put, and finds deep time's creature to make it tappable. |
| **Muse Spark** (`muse-spark-1.3`) | The historian (identifies the place, its climate, the camera's viewpoint and where any road runs, then writes what physically stood in view in every era as one continuous story), the critic (checks every era against the photo and its neighbouring era: camera, scale, continuity, light, plausibility, realism), the labels and "why" lines of the time core, and the first drafts of the alternate-history chronicles. |

## How an era is made

1. **Research.** The historian's notes, plus facts every era must keep: biome, viewpoint, road position.
2. **Draft.** One paint, published at once, so the scene fills in fast and the next era outward has its reference. Eras paint outward from now on both sides.
3. **Refine.** The critic scores the draft (losing the camera or the continuity with the neighbour weighs most). If it fails, up to two repaints with the critic's complaints; a repaint replaces the draft only if it scores strictly better. An era's refinement waits for its neighbour's, so it is checked against the neighbour's final image. A critic that can't answer leaves the era unverified, never passed.
4. **Content filter.** Four prompt levels, from the full prompt down to one sentence; an era's repaints start at the level that got through.

## Architecture

- **Client:** Vite + TypeScript + three.js. A full-screen shader blends keyframes with a per-pixel schedule from the SAM masks, a symlog time slider (±1M years), look-around (mouse, drag or gyro), the time core, and procedural ambient sound per era (WebAudio, no recordings). The scene token lives in the URL, so reloads and shared links resume from storage.
- **Worker:** Hono on Cloudflare Workers (same Vite project via `@cloudflare/vite-plugin`), with R2 for images and masks and KV for the daily budget and locks. It builds every prompt server-side from the committed chronicles (the client never sends prompt text), checks Turnstile on scene creation, signs scene tokens, caps daily spend, and stores each era once per scene, history and biome. An optional shared password (`APP_PASSWORD`) gates the whole site; `?key=<password>` links sign in directly.
- **Content:** `forks/*.json`: our timeline (cited extinct fauna, four biomes) and alternate histories, each era described as concrete consequences. Eras before a divergence, and all of deep time, are shared between histories.
- **Demos:** four pre-generated places in `public/demo/` play on the landing page with no API calls.

## Run locally

Requires Node 22+ and a Meta Model API key.

```bash
cp .env.example .env   # add MODEL_API_KEY
npm install
npm run dev
```

Local dev uses Cloudflare's test Turnstile keys and simulated R2/KV, and stays open (set `DEV_APP_PASSWORD` in `.env` to try the password gate). `npm test` runs the unit tests; `npm run typecheck` checks client and Worker.

Draft a new alternate history with Muse Spark:

```bash
node scripts/chronicle.ts no-printing-press
```

Demo tooling (against the local dev server): `scripts/make-demo.ts` builds a demo from a photo, `scripts/demo-add-era.ts` paints a newly added era into existing demos, `scripts/demo-structures.ts` adds per-era building masks.

## Docs

- [Implementation plan](docs/implementation-plan.md): design, decisions and spike results
- [Execution plan](docs/execution-plan.md): task-by-task build plan
