# Elsewhen — Implementation Plan

Meta Global AI Developer Hackathon · Indie track · Oct 26 – Nov 4, 2026 (EST)
Solo, ~4 h/day ≈ 40 build hours. Goal: a project worth continuing after the hackathon; winning is a bonus.

---

## 1. The product in one paragraph

A web app (phone-first, but just as good on a laptop, where judges and classrooms will see it) that turns your screen into a window through time. Capture where you stand, drag a slider from one million years ago to one million years ahead, and choose the history your world had ("Rome never fell", "the printing press was never invented"). The near end of the slider shows **cultural evolution**: ideologies compete, the winners reshape architecture, and the inscriptions, murals and posters they leave behind are fossils of the winning ideas (tap one to explode it into its persuasion layers). The far end shows **biological evolution**: creatures adapted to your exact spot appear in the scene, each with a field-guide card. Thesis: *history and biology are the same process at different speeds.*

## 2. Scope

### MVP (must ship by Nov 4)
1. **The landing page is a demo scene, already playing:** a 6-second auto-scrub (now → +1M → −1M → now), then the controls appear. No permissions or choices before the first "wow". 3–4 pre-generated demo scenes.
2. "Try it where you are": capture a single photo in the browser (or pick a file on desktop).
3. **Our timeline is the default.** A "Change history" button inside the viewer offers 2 curated forks (a third is the first stretch item).
4. Generate ~11 era keyframes of the scene, with progressive loading, and **the wait is content**: the photo shimmers, the chronicle's era captions stream in, and eras pop in as they arrive.
5. A symlog time slider (−1M … now … +1M) with smooth, mask-aware transitions between eras.
6. **Look-around on every device:** gyro tilt on phones (permission asked only when the user taps a "Tilt to look around" chip); mouse/trackpad look, scroll wheel and arrow keys on desktop. Single layer over a slightly overscanned image.
7. **Branch story:** tap the branch marker to read the chain of events from the divergence point to now.
8. Deep-time creatures **grounded in the user's region** (biome from Cloudflare's coarse request location): tap one to open its field-guide card.
9. Near-time **idea fossil** (an inscription, mural, poster or hologram, whichever fits the era): tap it to see the exploded view with persuasion-technique labels.
10. A shareable scene URL.

### Stretch (only if MVP is solid by day 8)
- A third curated fork.
- "Type your own fork" (live chronicle generation).
- A 10-second pan capture instead of a single photo.
- An animated ideology-creature ecosystem inside the poster (MVP: static "species of ideas" cards).
- Multi-layer depth parallax and creature sway (needs inpainting to fill disocclusion holes; see §8).
- Spark vision pass that re-checks poster technique labels.
- Ambient sound per era.

### Explicitly out of scope
- Live video re-rendering / true AR (Muse Image is stills; iOS Safari has no WebXR AR).
- Native apps, user accounts, payments.

## 3. Verified model facts (re-check against Meta docs on day 1)

| Model | What it gives us | Notes |
|---|---|---|
| **Muse Spark** (1.1+, Meta Model API) | Text/image/video/PDF in → text out; ~1M context; adjustable reasoning; structured outputs; tool calls; web search with citations | OpenAI-compatible API → use the `openai` SDK with a custom `baseURL` |
| **Muse Image** (Meta Model API since 2026-08-25) | Text-to-image; instruction-based **edit** (changes limited to the request); multi-image blending | $0.01/image; also on fal |
| **SAM 3.1** (Meta Model API) | One call → detections, pixel masks, identity-preserving video tracks; text/point/box prompts | Exact limits, mask format and latency unknown → spike |

Unknowns to resolve on day 1: Muse Image latency, max resolution, aspect ratios, edit fidelity at extreme prompts, safety-filter behavior on political imagery; SAM 3.1 mask encoding (RLE? PNG?) and per-call latency; rate limits for all three.

## 4. Architecture

```
 Browser (Vite + TS + three.js)                          Worker (Hono, same Vite project)                  Meta Model API
 ┌──────────────────────────────────────┐               ┌───────────────────────────────────────┐          ┌──────────────┐
 │ Capture → photo + Turnstile token ───┼──────────────▶│ POST /api/scenes   → signed sceneId   │          │              │
 │ Change-history sheet, biome          │               │ POST /api/scenes/:id/masks  ──────────┼─────────▶│ SAM 3.1      │
 │ Orchestrator (≤4 in flight) ─────────┼──────────────▶│ POST /api/scenes/:id/eras/:year ──────┼─────────▶│ Muse Image   │
 │   {forkId, biome} only, never prompts│               │   (prompt built server-side)          │          │ (+SAM target)│
 │ Slider + renderer (shaders)          │◀──────────────┼ GET  …/eras/:year  (resume from R2)   │          │              │
 │ Look-around, hit-testing             │               │ PUT/GET /api/scenes/:id (share JSON)  │          │ Muse Spark:  │
 │ Field-guide card, Poster view        │               │ GET /api/context · GET /api/health    │          │ offline only │
 └──────────────────────────────────────┘               │ R2: uploads/ (7-day), scenes/ (kept)  │          └──────────────┘
                                                        │ KV: daily budget counter              │
                                                        └───────────────────────────────────────┘
```

**Why this shape**
- API keys must never reach the browser → a server is mandatory.
- **The client never sends a prompt.** Era requests carry only `{forkId, biome}` for a signed `sceneId` and a known year; the Worker builds every prompt from the committed chronicles. Combined with a **Turnstile** check on scene creation and an HMAC-signed scene ID, the Worker can't be used as a free general-purpose image generator on your key.
- The **client orchestrates and owns the scene state**: it requests eras (at most 4 in flight, nearest-first), renders each as it lands, and saves the finished scene JSON once (for sharing). The Worker writes every result to R2 under a **deterministic key** (`scenes/{sceneId}/{fork|base}/{biome|-}/{year}`) via `ctx.waitUntil`, so a result is kept even if the phone suspends the tab mid-request; on return the client `GET`s existing eras before re-requesting.
- Spark is used **offline** (a local script with your key writes the chronicles); there's no public Spark route in the MVP.
- Everything after generation is local: scrubbing, transitions and gyro run at 60 fps with no network.
- **Region for free:** every request to a Worker carries `request.cf` with a coarse country, region and latitude/longitude derived from the IP. `GET /api/context` maps that to a biome (`temperate | arid | tropical | cold`) with no permission prompt and no GPS. The user can override it in the viewer (VPNs, wrong guesses).
- Cloudflare Workers + R2 is new tech for you, cheap, and gives HTTPS out of the box (required for `getUserMedia` on phones). Fallback if it fights you: one Hono/Node server on Fly.io or Render with S3-compatible storage. The Hono code ports unchanged.

**Repo layout: one Vite project** (`@cloudflare/vite-plugin` runs the client and the Worker together: one `package.json`, one dev server, one deploy)
```
elsewhen/
  src/
    capture/           camera, photo capture, demo-scene picker
    timeline/          symlog slider, era math, branch marker
    render/            three.js scene, transition shader, gyro pan
    interact/          hit-testing on masks, creature cards, poster view
    generate/          orchestrator, progress UI, scene state
    shared/            types + zod schemas (Fork, Chronicle, Era, Scene)
  worker/
    index.ts           Hono app: scenes, masks, eras, context, health
    guard.ts           Turnstile verification, signed scene IDs, daily budget, kill switch
    biome.ts           request.cf (country/region/lat) → biome lookup
    meta/              image.ts, sam.ts (thin typed clients; model IDs pinned in config)
    prompts/           era edit, poster, poster-on-wall (built from chronicles only)
  scripts/             chronicle.ts (offline Spark drafting), contact-sheet.ts, export-demo.ts (R2 scene → public/demo/)
  forks/               curated fork definitions + hand-edited chronicles (JSON)
  public/demo/         pre-generated demo scenes (scene JSON + assets)
  docs/
  vite.config.ts  wrangler.jsonc  package.json
```

## 5. Data model

```ts
type Fork = {
  id: string                    // "our-timeline" | "rome-never-fell" | ...
  title: string
  divergenceYear: number | null // null for our timeline; e.g. 476
  premise: string               // one paragraph, human-written for curated forks
}

type EraStop = { year: number; label: string }   // year relative to now: -1_000_000 … +1_000_000

type Biome = "temperate" | "arid" | "tropical" | "cold"

type Fauna = {                             // card text lives here, hand-edited; no runtime call
  kind: "extinct" | "speculative"          // past = real paleontology (cited); future = invented, labelled as such
  name: string; binomial: string; ancestor: string; niche: string
  adaptations: { trait: string; because: string }[]
  sources?: string[]                       // required for "extinct"; from Spark web search, shown on the card
}

type BiologyVariant = {                    // one per biome
  environment: string                      // climate, landforms, what humans left
  fauna: Fauna[]
  visualPrompt: string
}

type StructureState =
  | "unbuilt"                              // past: the site before any building; open land from this viewpoint and height
  | "predecessor"                          // past: an earlier, era-appropriate building on the same site
  | "intact" | "weathered" | "ruined" | "overgrown" | "buried" | "gone"

// The "poster" is really the era's idea fossil: the artifact through which the winning idea survives.
// Its medium has to fit the era; a printed poster in ancient Rome breaks the illusion.
type FossilMedium = "inscription" | "coin" | "mosaic" | "mural" | "banner" | "stained-glass" | "poster" | "billboard" | "hologram"

type ChronicleEra = {
  year: number
  caption: string                          // one line under the slider, also streamed during loading
  driver: "culture" | "biology"            // which kind of evolution dominates
  structures: {                            // monotonic along each direction from now; injected into every prompt
    state: StructureState                  // so independently generated eras agree with each other
    vegetation: 0 | 1 | 2 | 3              // none … total cover
    water: "none" | "puddles" | "flooded" | "submerged"
  }
  // culture-driven eras
  environment?: string
  dominantIdeology?: { name: string; tenets: string[]; aesthetic: string; rivals: string[] }
  architecture?: string
  poster?: {                               // the idea fossil (field name kept short)
    medium: FossilMedium                   // e.g. −2k inscription, −500 mural, −100 poster, +1k hologram
    brief: string                          // overall composition + style; the image itself has NO text
    slogan: string                         // overlaid as real typography in the exploded view
    elements: { name: string; technique: string; explanation: string }[]  // e.g. "the eagle" → "inherited authority"
  }
  visualPrompt?: string                    // what Muse Image should change in the scene
  // biology-driven eras: everything is biome-specific
  biomes?: Record<Biome, BiologyVariant>
}

type Chronicle = {
  forkId: string
  chain: { year: number; event: string; consequence: string }[]   // divergence → now, shown from the branch marker
  eras: ChronicleEra[]
  sources?: string[]
}

type Keyframe = {                          // client-side state; saved once as part of Scene
  year: number
  imageUrl: string
  creature?: { maskUrl: string; faunaIndex: number }
  poster?: { maskUrl: string; posterUrl: string; elementMasks: { name: string; maskUrl: string }[] }
  status: "pending" | "ready" | "failed"
}

type Scene = {
  id: string; forkId: string; biome: Biome; photoUrl: string
  aspect: string; width: number; height: number  // canonical size every keyframe is resized to
  baseMasks: { label: string; url: string }[]   // from the original photo; drive transitions
  keyframes: Keyframe[]; createdAt: string
}
```

**Which eras are culture and which are biology (fixed for every fork):**

| Keyframe | −1M | −100k | −10k | −2k | −500 | −100 | now | +100 | +1k | +10k | +100k | +1M |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Driver | biology | biology | biology | culture | culture | culture | the photo* | culture | culture | biology | biology | biology |
| Idea fossil medium (typical) | – | – | – | inscription / coin | mural / mosaic | poster | – | poster / billboard | hologram / banner | – | – | – |

\* In our timeline "now" *is* the photo, so 11 eras are generated. A fork also generates its alternate "now" but reuses every keyframe before its divergence year: "Rome never fell" (476) generates 8, "printing press never invented" (1440) generates 7, "Library of Alexandria survives" (~48 BCE) generates 9.

**Real history vs. fiction:**
- **Our timeline** shows real history, so its idea fossils are **real but non-political**: advertising, public-health and civic posters, world's-fair art, coins and dedication inscriptions (the "ideas" of progress, hygiene, commerce, civic pride). No real propaganda, which keeps safety filters and controversy out.
- **Forks** carry fictional ideologies, and their fossils can be openly propagandistic.
- **Creatures:** past fauna is real (`kind: "extinct"`, with cited sources from Spark's web search) and future fauna is invented (`kind: "speculative"`, labelled "Speculative biology" on the card).

**Key insight on caching:** the *chronicle* depends only on the fork, not the scene. Pre-generate, hand-edit and commit chronicles for the curated forks (including creature-card text and poster elements), so per-scene work is only image edits + segmentation. Keyframes before a fork's divergence year are identical across forks: cache key `sceneId + year + (year < divergenceYear ? "base" : forkId) + (biology era ? biome : "")`.

**Biome workload:** biology eras need 4 biome variants each. The deep past (−1M, −100k, −10k) is shared by all forks, so that's 3 eras × 4 biomes; the far future is per fork. Let Spark draft every variant, then hand-edit only the ones your demo scenes use and spot-check the rest.

## 6. Generation pipeline (per scene)

1. **Create the scene** (`POST /api/scenes` with a Turnstile token). The client first downscales the photo to ~1536px long edge via canvas re-encode (which drops all EXIF/GPS for free) and **crops it to the canonical aspect ratio**: whichever ratio Muse Image supports that's closest to the photo. The Worker stores it under `uploads/`, checks the daily budget, and returns an HMAC-signed `sceneId` plus the canonical `width × height`.
2. **Base masks** (`POST /api/scenes/:id/masks`: SAM 3.1 on the photo with text prompts `sky, building, wall, tree, vegetation, ground, road, water, person`). These drive every transition. They stay valid for all eras *because* the edits preserve layout, which is exactly the go/no-go assumption the spike tests. If `person` covers a large share of the frame, show "Elsewhen works best on places, not people" before generating.
3. **Per era** (`POST /api/scenes/:id/eras/:year` with `{forkId, biome}` only). The client keeps **at most 4 requests in flight**, nearest-to-now first, with exponential backoff + jitter on 429. The Worker:
   0. **Idempotency first:** if R2 already has this `(scene, fork|base, biome|-, year)`, return it without generating. Otherwise take a short in-progress lock on the key (a marker object in R2 or a KV entry with a TTL), so concurrent duplicates wait instead of paying twice. Every combination is generated at most once, so a scene's worst case is bounded (≈ 4 forks × 4 biomes × 12 years ≈ $1.50) even if its signed link spreads.
   1. Builds the prompt **server-side** from the chronicle: `visualPrompt` + the era's `structures` state (*"buildings: ruined; vegetation: heavy; water: puddles"*) + a preservation clause that depends on the state:
      - built states: *"Same camera position, framing, horizon line and perspective. Keep the large structures in the same places, transformed by time. Remove any people unless this is the present. Photorealistic."*
      - `unbuilt`: *"The building does not exist yet. Show the open land at this exact spot, from the same viewpoint, height and direction, keeping the horizon and terrain. Photorealistic."*
      - `predecessor`: *"Replace the building with an earlier, era-appropriate structure on the same footprint, same viewpoint."*
   2. **Culture eras (fossil-first):** Muse Image text-to-image of the idea fossil in its era's `medium` from `poster.brief` (naming each element, **no text or lettering**) → Muse Image **multi-image blend** of photo + fossil: *"…and place this {medium} where it fits naturally (on a wall, a plinth, a facade)."* The fossil in the scene and the exploded one are the same image by construction.
   3. **Biology eras:** use `biomes[scene.biome]`: its `visualPrompt` plus *"one {fauna[0].name}, {adaptations}, clearly visible in the mid-ground"*.
   4. **Muse Image edit** → R2 at the deterministic key, stored as returned (written in `ctx.waitUntil`, so it survives a client disconnect). **The client scales each keyframe to the canonical `width × height` when it loads it** (canvas / `createImageBitmap` with resize options). Workers can't do image resizing or heavy decoding within their CPU limits (10 ms per request on the free plan), so the Worker only moves bytes.
   5. **SAM 3.1 only for the one target** on the keyframe (the Worker stores SAM's raw text output; the client decodes masks with `@meta-sam/parser`): the fossil (prompted by its `medium`) or the creature name/`animal`. For fossils, also run SAM on the fossil image with each `poster.elements[].name` as the text prompt → element masks whose technique labels are known by construction. If fewer than 3 elements are found, regenerate the poster once, then label whatever was found.
4. **Resume:** on load or return from background, the client `GET`s each era first and only requests the ones R2 doesn't have.
5. **Creature cards, poster labels and slogans** come straight from the hand-edited chronicle. No runtime Spark calls in the per-scene path.
6. **Save** the finished `Scene` JSON once (`PUT /api/scenes/:id`) under `scenes/`, which has no expiry, for the share URL.

**Order of arrival:** eras nearest to "now" first (0, ±100, ±1k …) so the slider becomes usable within the first ~10 s.

**Indoor photos** are the hardest case for the deep past (what does a living room look like before the house existed?). Demo scenes stay outdoors; for user photos, the `unbuilt` prompt is tried and the pre-hackathon test includes one indoor room to see whether it holds up.

**Era consistency — parallel vs. chained (decided by the pre-hackathon test):** eras generated independently from the original photo can disagree (a ruin at +1k, standing again at +10k), which turns scrubbing into flicker. The default fix is the monotonic `structures` state in every prompt. The alternative is **two sequential chains**, now → past and now → future, where each era is edited from its neighbour's keyframe: more consistent, but slower (two chains of ~5 calls each instead of full parallelism). Test both on the same photos and pick.

**The wait is content:** while keyframes generate, the captured photo sits behind a slow shimmer shader, the chronicle's `caption`s stream in one by one ("12,000 BCE · the ice retreats…"), and each era pops onto the slider as it lands. The captions are already in the chronicle, so this costs no model calls.

**Cost estimate per scene:** ~11 edits + ~3 posters at $0.01 + ~1 + 11 + 3×(elements) SAM calls ≈ **$0.15–0.25** (confirm SAM pricing). Switching forks on the same scene re-uses the pre-divergence keyframes.

## 7. The time slider

- **Symlog mapping:** position `p ∈ [-1, 1]` → `year = sign(p) · (10^(|p|·6) − 1)`. 0 is now, ±1 is ±1M years. Ticks at 10, 100, 1k, 10k, 100k, 1M.
- **Blending between keyframes** is computed in **slider position**, not in years: at position `p` between keyframe positions `pA` and `pB`, `t = (p − pA) / (pB − pA)`. So −37,000 sits visually between −100k and −10k exactly where the slider puts it.
- **Keyframe stops (11):** −1M, −100k, −10k, −2k, −500, −100, **now**, +100, +1k, +10k, +100k, +1M (drop one if generation is slow).
- **Branch marker:** for forks with `divergenceYear`, draw where this world splits from ours. Eras before it reuse "our timeline" keyframes (cache across forks for the same scene!). **Tap the marker** → a sheet with `chronicle.chain`: the chain of events from the divergence to now ("476 · the Western court survives the Gothic siege → …").
- **Era label + one-line caption** under the slider ("~12,000 BCE · Ice retreats; mammoth steppe").
- **Desktop input:** scroll wheel / trackpad scrolls through time; ←/→ jump between keyframes; Home returns to now.
- **Change history:** a button in the viewer opens a sheet with the 2 curated forks (premise + divergence year). Our timeline is the default; there is no fork screen before the first view.

## 8. Rendering & transitions (the "beautiful" part)

Use **three.js** with a full-screen orthographic quad and a custom `ShaderMaterial`. WebGL2 baseline; WebGPU is optional later.

**Transition shader** between keyframes A and B with blend `t ∈ [0,1]`:
- Inputs: texA, texB, **one delay map** (a grayscale texture baked once per scene from the *original photo's* masks: sky = 0.0, vegetation = 0.3, structures = 0.6, ground = 0.8), and a noise texture.
- Per pixel: `local = smoothstep(delay - w, delay + w, t * (1 + w) + noise * 0.15)`, then `mix(A, B, local)`.
- Effect: the sky changes first, vegetation creeps, buildings dissolve last, with an organic noise edge instead of a flat crossfade.

**Look-around (single layer, every device):**
- Overscan the image ~8–10%; one UV offset for the whole frame, smoothed with a low-pass filter.
- **Desktop (first-class, where judges are):** mouse/trackpad position drives the offset; landscape layout with the slider along the bottom.
- **Phone:** touch-drag works immediately. A "Tilt to look around" chip appears in the viewer; tapping it calls `DeviceOrientationEvent.requestPermission()` on iOS (must come from a user gesture) and switches to gyro.
- **Why not multi-layer depth parallax:** moving sky/structures/ground layers independently opens holes where one layer covered another, and a cut-out creature that moves leaves a ghost of itself in the background. Doing it right needs inpainting the background behind each layer, so it's on the stretch list. Creatures get the tap-hint glow only, no sway.

**Grading:** subtle film grain + vignette per era; warm for the deep past, cold for the far future.

**Fitting any screen:** every scene has one canonical aspect ratio. Render with "cover" fit; where the viewport's shape differs (a portrait phone photo on a landscape laptop), fill the leftover space with a heavily blurred, colour-sampled copy of the current keyframe. Demo scenes are landscape.

**GPU memory (iPhone Safari will otherwise kill the tab):** 11 keyframes at ~1536×2048 are ~12 MB each as textures. Keep **only the 2–3 keyframes around the slider position** on the GPU; hold the rest as compressed blobs and decode with `createImageBitmap` as the slider approaches them. Cap phones at 1280 px on the long edge. Listen for `webglcontextlost` / `webglcontextrestored` and rebuild textures from the blobs.

## 9. Interaction

- **Hit-testing:** on tap, sample the current keyframe's mask textures at the tap UV (keep masks in CPU-readable `ImageData` too). Creature hit → field-guide card; poster hit → poster view.
- **Hint affordance:** a soft pulsing outline (mask edge glow in the shader) on tappable things for 2 s after an era loads.
- **Landing:** opens straight into a demo scene running a 6-second auto-scrub (now → +1M → −1M → now), then fades in the controls and a "Try it where you are" button. The camera permission is only requested after that button is pressed.
- **Field-guide card:** Haeckel/Victorian naturalist styling: name (Latin binomial, real for extinct species), ancestor ("descended from: rock pigeon"), niche, 3 adaptations with "because…" reasons, era, fork and biome ("Arid · your region"), plus a small biome override. Extinct species show their sources; speculative ones carry a "Speculative biology" line.
- **Idea fossil view (exploded):** works the same for every medium (inscription, mural, poster, hologram). It uses the *same* image that's in the scene, with each element (SAM mask from the chronicle's element names) on its own plane at increasing z. Swipe to rotate; elements fan apart; each element shows its label from the chronicle (e.g., *Heroic low angle*, *Enemy dehumanization*, *Color: authority red*). The poster's slogan is set as real typography on its own plane (generated images never contain text, because image models garble lettering). A bottom sheet tells the story: "Why this idea won: …" plus its rival ideologies (static "species of ideas" cards in MVP).

## 10. Forks (curated for MVP)

Pick forks that are original **and** avoid image safety filters (no real extremist movements or symbols; all ideologies fictional). **The MVP ships our timeline + 2 forks**: draft all three, then keep the two whose drafts are strongest. The third is the first stretch item.

1. **Our timeline** (baseline, needed anyway).
2. **The printing press was never invented** (divergence 1440): knowledge stays oral and guild-held; ideologies of secrecy and memory; architecture of scriptoria-cities.
3. **The Library of Alexandria never burned** (divergence ~48 BCE): an early scientific revolution; Hellenistic techno-civilization.
4. **Rome never fell** (divergence 476): a continuous imperial bureaucracy; neo-classical megastructures.

Write each premise by hand (it's your creative voice). Generate the chronicle with Spark, reasoning set high and web search on for grounding (including the `chain` of events from divergence to now and the 4 biome variants for biology eras), then **edit it by hand** and commit to `forks/`.

## 11. Prompts to write (keep in `worker/prompts/`, versioned)

| Prompt | Model | Output |
|---|---|---|
| `chronicle` (offline) | Spark (high reasoning, web search) | `Chronicle` JSON incl. creature cards + poster elements; then hand-edited |
| `era-edit` | Muse Image edit | keyframe (includes the era's `structures` state) |
| `poster` | Muse Image t2i | poster (elements named in the prompt, no text) |
| `poster-on-wall` | Muse Image multi-image blend | keyframe with that exact poster |

Keep a `prompts/eval/` folder: 5 reference photos (street, room, park, kitchen, office) × all eras, re-run whenever a prompt changes, and eyeball a contact sheet (a small script that tiles outputs into one image).

## 12. Safety, privacy, cost controls

- **No open generator:** the client never sends prompt text; the Worker builds every prompt from committed chronicles. Scene creation requires a Cloudflare **Turnstile** token (free, usually invisible), and era/mask routes only accept HMAC-signed scene IDs.
- EXIF/GPS is dropped by the client-side canvas re-encode. The R2 lifecycle rule expires **only `uploads/`** after 7 days; saved scenes under `scenes/` and the static demo scenes never expire (judging happens after Nov 4).
- People in the scene: SAM `person` check with a "works best on places" warning; prompts remove people in non-present eras; scene IDs are random and unguessable; no public gallery; never identify anyone.
- Fork ideologies are always fictional; fossil prompts forbid real-world political symbols and slogans. Our timeline's fossils are real but non-political (advertising, civic, public-health, world's-fair art, coins).
- On a safety refusal: retry once with a softened prompt, then fall back to the "our timeline" keyframe for that era with a small "this world is hidden" note.
- **Budget guard:** daily spend counter in KV + a kill-switch env var that forces demo-only mode. Essential once the URL is public for judging. (No per-IP limiting: Turnstile stops scripts, demo mode serves the judges, and the daily cap bounds the worst case.)
- **Graceful degradation:** `/api/health` checks the pinned model IDs and the budget. If the live path is unavailable (cap hit, model deprecated, credits gone), "Try it where you are" shows "Live generation is resting — explore a demo world" instead of an error. Demo scenes make zero API calls.

## 13. Before the hackathon (Oct 21–25) — preparation, not product code

Check the rules on prior work first. Learning, design and throwaway experiments are normally fine; the product repo should start on Oct 26.

- [ ] Read the hackathon rules (prior work, required submission assets, video length, repo visibility) and **note when judging ends**: the deployment and API credits must stay alive until then.
- [ ] Get Meta Model API access and keys; read the Spark, Muse Image and SAM 3.1 docs; note rate limits and pricing.
- [ ] **Throwaway spike (in the scratch folder, not the repo):** 3 of your own photos (one street, one park, **one indoor room**) × 5 eras via Muse Image edit. Is the place still recognizable at −1M and +1M? Does the `unbuilt` prompt produce a believable deep past for the room? This is the go/no-go for the whole concept.
- [ ] Same photos through SAM 3.1 with text prompts; check mask quality for sky/building/poster.
- [ ] Learn: three.js basics + `ShaderMaterial`; *The Book of Shaders* chapters on noise and mixing; the Cloudflare Vite plugin (`@cloudflare/vite-plugin`) + Hono; R2 + KV bindings.
- [ ] In the spike, also test **multi-image blend** (photo + a poster → poster placed on the wall). The poster-first pipeline depends on it.
- [ ] In the spike, record **output dimensions and supported aspect ratios** (does an edit return the input's size?).
- [ ] In the spike, compare **era consistency**: 5 eras edited independently from the photo (with explicit `structures` states in the prompts) vs. a sequential chain (each era edited from the previous one). Does scrubbing read as progress or flicker? Pick the approach (§6).
- [ ] Set up accounts: Cloudflare (incl. a Turnstile site key), a domain (optional), GitHub repo (empty).
- [ ] Write the 3 fork premises by hand.
- [ ] Moodboard: Haeckel plates, Dougal Dixon's *After Man*, Roman inscriptions and coins, medieval murals and stained glass, WPA/public-health and world's-fair posters, Constructivist styles (for fork propaganda), Simon Stålenhag for far-future mood.
- [ ] Collect demo photos from **other climates** (arid, tropical, cold): CC0 or Unsplash-licensed street and park shots, landscape orientation. Note each licence.
- [ ] Test devices: your laptop (Chrome + Safari) first, since that's where judges are; then your iPhone (Safari) and one Android (Chrome) if available.

**If the spike fails** (scenes become unrecognizable), fallback options in order:
1. Lower edit strength: only change SAM-masked regions (inpaint per mask instead of whole-image edit).
2. Composite: keep the original photo's structure layer and only regenerate sky/ground/vegetation, then blend.
3. Pivot the frame: "postcards from elsewhen" — stylized illustrations of the scene per era instead of photoreal continuity.

### Spike results (2026-10-26) — gate G1

Run: 3 portrait iPhone photos (street, park, room) × 5 eras, independent and chained, plus poster blend and SAM. 27 images generated (≈ $0.27). Report: `spike/outputs/index.html`.

| Question | Result | Decision |
|---|---|---|
| Recognizable at −1M / +1M? | **Yes, outdoors.** Sky, sun position, horizon and foreground vegetation survive every era; 1526 puts timber buildings on today's footprints. | **Go.** Core concept holds. |
| Masks line up? | Building IoU at +1k vs. the photo: **0.917** (street), **0.928** (park). SAM overlays sit on their boxes (mask-in-box placement confirmed). | One delay map from the original photo's masks. |
| Independent vs. chained | Chaining **drifts**: by −1M the sun, sky and foreground are gone, and 1526 changes composition. 3-link chains took **66–86 s**. Independent keeps the anchors. | **Independent (parallel) generation.** Drop the chain option. |
| Indoor deep past | 1526 is excellent (same window, bench where the sofa is). Deep past/future become **generic landscapes**; nothing anchors them to the room. +1k indoor was always blocked by the filter. | "Works best outdoors" notice for indoor captures; demo scenes outdoors. |
| Creature found? | SAM `animal` found the creature at −1M in **6/6** images (independent and chained). | Creature prompts as planned. |
| Poster blend | Text-free poster ✓ (no garbled lettering). Multi-image blend placed it on a wall with nothing else changed ✓, but **small**. SAM `poster` found it ✓. Multi-image edits need Meta's JSON form (`images: [{image_url}]`); the SDK's multipart `image[]` is rejected. | Fossil-first as planned; ask for a larger placement; Worker uses the JSON form. |
| Latency | Edit median **23 s** (16–38 s); generate 17 s; SAM median **5.4 s** (3–12 s). | 15–30 s band → **9 keyframes**; test higher concurrency (6) on day 3. |
| Output size | 1152×1536 in → **1344×1792** out (3:4 kept, upscaled). | Canonical aspect = the photo's; client scales on load. |
| **New: content filter on decay** | The +1,000 "ruined / collapsed / long after people left" prompt was blocked on all photos. Calm "nature has gently reclaimed this place" wording passed independently but failed in a later run on the *same* photo and prompt: **the filter is non-deterministic**. One retry rescued some, not all. | Calm wording for every future era; retry once on `content_policy_violation`; fallback keyframe; a prompt-probing session for future eras on day 1 (D1.6). |
| SAM phrases | `ground` and `road` returned **0 matches** on both outdoor photos; `tree` returns 18–19 separate trees. | Try `grass`, `street`, `pavement`; union per phrase as the spike does. |

## 14. Day-by-day build plan (≈4 h/day)

Each day ends with a **deployed** build you can open on your phone.

**Day 1 — Sun Oct 26: Foundations + spike confirmation**
- [ ] Create the single Vite + TS project with `@cloudflare/vite-plugin`, a Hono Worker, R2 + KV bindings, lint + prettier.
- [ ] Typed clients for Image/SAM in `worker/meta/` with retries + timeouts; model IDs pinned in config; `/api/health`.
- [ ] Re-run the spike inside the real code path: one photo → one era edit → SAM masks. Record latency per call.
- [ ] Deploy the Worker + static site to Cloudflare (HTTPS on the phone from day 1).
- [ ] `GET /api/context` + `worker/biome.ts`: log what `request.cf` returns for you (country/region/lat) on the deployed Worker.
- ✅ Done when: the phone hits the deployed API and gets back one generated era image, and `/api/context` returns your biome.

**Day 2 — Mon Oct 27: Capture + scene creation**
- [ ] Camera page: `getUserMedia({ video: { facingMode: "environment" } })`, shutter, canvas downscale/re-encode, crop to the canonical aspect ratio.
- [ ] `POST /api/scenes` with Turnstile verification, HMAC-signed scene IDs, daily budget check; R2 `uploads/` with the 7-day lifecycle rule on that prefix only.
- [ ] Base SAM masks (incl. `person` check + warning); bake the delay-map texture on the client.
- [ ] File-picker fallback (desktop, or camera permission denied).
- [ ] Writing track starts: `scripts/chronicle.ts` drafts all 3 forks + our timeline with Spark (captions, `chain`, `structures` states incl. `unbuilt`/`predecessor`, idea fossils with era-appropriate `medium` and slogans, 4 biome variants with `kind` and cited sources for extinct fauna; our timeline's fossils real but non-political).
- ✅ Done when: taking a photo on the phone produces a signed scene + stored photo + base masks + delay map, and a scene request without a Turnstile token is rejected.

**Day 3 — Tue Oct 28: Chronicles + full generation**
- [ ] `POST/GET /api/scenes/:id/eras/:year`: server-side idempotency check + in-progress lock, prompt builder from chronicles (incl. `structures` and the state-dependent preservation clause), fossil-first (text-free t2i fossil in its `medium` → multi-image blend), deterministic R2 key via `ctx.waitUntil`, SAM target (raw SAM text stored; masks decoded on the client with `@meta-sam/parser`).
- [ ] Client orchestrator: ≤4 in flight, nearest-era-first, backoff + jitter on 429, resume from R2 before re-requesting, pre-divergence keyframe reuse.
- [ ] Waiting state as content: shimmer over the photo + streamed era captions.
- [ ] Temporary viewer: a plain grid of keyframes to judge quality.
- ✅ Done when: one capture + one fork → 11 keyframes on the phone in under ~60 s.

**Day 4 — Wed Oct 29: Slider + renderer**
- [ ] three.js full-screen quad; texture manager that keeps only the 2–3 keyframes around the slider on the GPU (blobs + `createImageBitmap` for the rest, 1280 px cap on phones, context-loss recovery).
- [ ] "Cover" fit with the blurred backdrop for mismatched viewports.
- [ ] Symlog slider component with ticks, era label/caption, branch marker; tap the marker → chain-of-events sheet.
- [ ] Desktop input: scroll wheel/trackpad scrubbing, ←/→ keyframe jumps, Home = now; landscape layout.
- [ ] Plain crossfade between neighbouring keyframes (fancy shader comes tomorrow).
- [ ] "Change history" sheet in the viewer (2 forks with premise + divergence year); our timeline by default.
- ✅ Done when: you can scrub −1M → +1M smoothly on the phone **and** on the laptop, three full sweeps on the iPhone without a crash or context loss. **This is the first "it's real" moment — record a screen capture.**

**Day 5 — Thu Oct 30: Beauty pass 1 — transitions + look-around**
- [ ] Noise-dissolve transition shader driven by the scene's delay map.
- [ ] Single-layer look-around with overscan: mouse on desktop, touch-drag on phones, and the "Tilt to look around" chip that requests the iOS motion permission and switches to gyro.
- [ ] Film grain, vignette, per-era grading.
- ✅ Done when: transitions feel organic (sky first, buildings last) and tilting the phone looks around.

**Day 6 — Fri Oct 31: Creatures**
- [ ] Ensure biology eras include one creature (prompt) and SAM finds it.
- [ ] Tap hit-testing on the creature mask; hint glow.
- [ ] Field-guide card UI (naturalist styling) from the chronicle's fauna entry for the scene's biome, with the biome override.
- ✅ Done when: at +100k years you can tap a creature, read why it evolved, and switching the biome gives a different, regionally plausible creature.

**Day 7 — Sat Nov 1: Idea fossils**
- [ ] Verify fossil-first keyframes across media: SAM finds the fossil in the scene (prompted by its `medium`: `inscription`, `mural`, `poster`…); element masks from the fossil image by element name.
- [ ] Tap → exploded view (same component for every medium).
- [ ] Exploded 3D view with swipe-to-rotate, chronicle labels, the slogan as real typography, "why this idea won" sheet + rival idea cards.
- [ ] Fallback: fewer than 3 elements found → regenerate once, then label what was found.
- ✅ Done when: in "Rome never fell" you can tap an inscription at −500 and a poster at +100 and pull each apart, and in our timeline the −100 fossil is a real non-political artifact.

**Day 8 — Sun Nov 2: Robustness + demo mode** *(feature freeze at end of day)*
- [ ] Demo scenes: 3–4 pre-generated outdoor scenes (your photos + licensed photos from other climates, different biomes) run through your own pipeline and copied into `public/demo/` with `scripts/export-demo.ts`; licences credited in the README.
- [ ] Landing = a demo scene with the 6-second auto-scrub, then controls + "Try it where you are". No permission prompts before it.
- [ ] Share URL (`/s/:sceneId`) with OG image (the +1M keyframe).
- [ ] Error states: camera denied, generation failure per era, safety refusal fallback, slow network, tab suspended mid-generation (resume works).
- [ ] Budget guard (daily cap) + kill switch + "Live generation is resting" fallback driven by `/api/health`.
- [ ] Device test pass: desktop Chrome + Safari first, then iPhone Safari, Android Chrome.
- ✅ Done when: a stranger can open the link cold and get a great experience in under 30 s.

**Day 9 — Mon Nov 3: Polish + story**
- [ ] Hints instead of onboarding screens: the auto-scrub teaches the slider; one-time hint chips for "scroll through time", "tap the creature", "tap the branch".
- [ ] Typography, loading animation, sound (optional).
- [ ] Record the demo video (2–3 min): hook (your street at +1M), the thesis (evolution at both speeds), poster explode, creature card, how it's built (the three Meta models), what's next.
- [ ] README: concept, architecture diagram, model usage, how to run.
- ✅ Done when: video and README drafts exist.

**Day 10 — Tue Nov 4 (deadline 9 PM EST): Ship**
- [ ] Fix only blocking bugs. Re-verify the deployed URL, demo scenes, and budget guard.
- [ ] Make sure Cloudflare billing and Meta API credits will last **until judging ends**, and set a calendar reminder to check the live URL during judging.
- [ ] Submit early (by ~5 PM EST), not at 8:59.
- [ ] Post the video/link where the hackathon community gathers; mention you're open to teammates for the continuation.

**Writing track (days 3–7, ~45 min/day):** hand-edit the Spark drafts in this order: the demo path first (the forks, eras and biomes your demo scenes use), then the chains, then spot-check the remaining biome variants. Keep it out of the build hours. Day 3 alone can't absorb 6–10 hours of writing.

**Buffer:** the Occam simplifications freed roughly 5–7 hours; the red-team fixes spend about 5 of them. What's left is thin, so protect it.

**If you're more than half a day behind,** cut in this order: poster rival cards → per-era grading → gyro (keep mouse/touch drag) → 2 forks down to 1.

## 15. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Muse Image edits don't preserve scene geometry | Medium | Fatal | Pre-hackathon spike; masked inpainting / compositing fallbacks (§13) |
| Generation too slow (>90 s per scene) | Medium | High | Nearest-first progressive loading; drop to 7 keyframes; demo mode |
| Safety filters refuse poster/ideology prompts | Medium | Medium | Fictional ideologies only; softened retry; fallback keyframe |
| SAM misses creatures/posters in generated images | Medium | Medium | Ask Muse Image for clear, centered subjects; box prompts from Spark-vision bounding boxes as fallback |
| Base-photo masks drift from generated eras (transitions misaligned) | Low–Medium | Medium | Same root cause as the geometry risk, so the spike covers it; fallback: run SAM per keyframe and bake per-keyframe delay maps |
| Multi-image blend doesn't place the poster convincingly | Medium | Medium | Spike it pre-hackathon; fallback: generate the poster separately and accept that wall and exploded posters differ, or composite the poster onto the SAM `wall` mask with a perspective warp |
| iOS gyro/camera permission quirks | High | Low | Permission from a user gesture; drag fallback |
| API cost runaway once public | Low | High | Daily budget cap + kill switch; demo mode for judges |
| Worker abused as a free image generator | Medium | High | Server-built prompts only; Turnstile; signed scene IDs; daily cap |
| Independently generated eras contradict each other (flicker) | Medium | High | Monotonic `structures` state in prompts; sequential chains if the spike shows flicker |
| iPhone Safari kills the tab (texture memory) | High | High | 2–3 keyframes on GPU, blobs for the rest, 1280 px cap, context-loss recovery |
| Links/live generation dead by judging time | Medium | High | `scenes/` never expires; static demo scenes; pinned model IDs + `/api/health` fallback; keep credits funded |
| Paid results lost when the phone suspends the tab | High | Medium | Deterministic R2 keys written in `ctx.waitUntil`; client resumes from R2 |
| Aspect-ratio mismatch breaks mask alignment / desktop view | Medium | Medium | Canonical aspect per scene; the client scales every keyframe to it on load; cover fit + blurred backdrop |
| Worker CPU limits (10 ms free plan) | High if on free plan | High | Worker only moves bytes: no image resizing or mask decoding server-side (client does both); use Workers Paid ($5/mo, 30 s CPU) for HMAC/JSON headroom |
| Writing workload overruns day 3 | High | Medium | Parallel writing track; MVP = our timeline + 2 forks |
| Garbled text in generated posters | High | Low | Text-free posters; slogan as real typography |
| Anachronistic or real-political idea fossils break the illusion or trip filters | Medium | High | Era-appropriate `medium` per keyframe; our timeline uses real non-political artifacts; fictional ideologies only in forks |
| Deep past of an indoor scene looks absurd | Medium | Medium | `unbuilt` prompt; tested on an indoor photo pre-hackathon; demo scenes outdoors |
| Wrong real fauna for a region (credibility) | Medium | Medium | `kind: "extinct"` entries drafted with web search and cited; hand-check demo biomes |
| Rate limits during judging | Medium | Medium | Demo scenes are static; ≤4 requests in flight with backoff; live generation is optional for judges |
| Scope creep (it's a fun world to keep expanding) | High | High | Feature freeze end of day 8; stretch list stays a list |

## 16. Testing

- **Unit (vitest):** symlog mapping, era selection/blend math, prompt builders (snapshot), zod schema validation of model outputs.
- **Prompt eval:** contact sheets for 5 reference photos × eras after every prompt change (§11).
- **Unit:** `request.cf` → biome mapping (a table of sample countries/latitudes); scene-ID signing/verification; era routes reject unknown years, forks and unsigned IDs.
- **Memory:** three full −1M ↔ +1M sweeps on the iPhone without context loss (days 4 and 8).
- **Resume:** start a generation on the phone, switch apps for 30 s, return; no era is requested twice.
- **Manual device matrix** at the end of days 4, 6, 8: desktop Chrome/Safari first, then iPhone Safari, Android Chrome.
- **Idempotency:** request the same era twice concurrently and sequentially; exactly one generation is billed.
- **Smoke test script:** run one fixture photo through scene creation (with a Turnstile test key), masks, and one era on the deployed Worker; assert each returns an image/mask at the canonical size.

## 17. Submission checklist

- [ ] Live URL (demo mode works without camera/permissions), funded and monitored until judging ends
- [ ] Demo video (check required length/format in the rules)
- [ ] Public repo + README with architecture and Meta model usage
- [ ] Short description (application text, refreshed with what actually shipped)
- [ ] Screenshots: slider at −1M / now / +1M, poster exploded, creature card

## 18. After the hackathon (if you keep going)

- Pan/video capture → wider panoramas; later on-device models for near-live re-rendering.
- Open forks: anyone types a "what if"; a public gallery of worlds.
- Precise location-grounded deep time: real paleo-geography and climate data for the exact spot (MVP only has 4 biomes from a coarse IP region).
- The animated ideology ecosystem (ideas-as-organisms simulation, WebGPU compute).
- Teammates: a shader/3D person and a speculative-biology illustrator or writer.
- Possibly a museum or education angle (schools, science centres).

## 19. Open decisions (defaults chosen; change any)

| Decision | Default | Alternative |
|---|---|---|
| Hosting | One Vite project + Cloudflare Worker (R2, KV for budget only) | Node/Hono on Fly.io + S3 |
| Scene state | Client-held, saved once for sharing | Server-side manifest |
| Parallax | Single-layer gyro pan | Multi-layer with inpainting (stretch) |
| Location grounding | 4 biomes from `request.cf`, user-overridable | Browser geolocation (another permission prompt) or a runtime Spark call per region |
| First screen | Auto-playing demo scene | Choice screen (rejected: loses judges) |
| Renderer | three.js, WebGL2 | raw WebGL / WebGPU |
| UI framework | none (vanilla TS + a tiny state store) | Svelte or React for screens |
| Keyframes | 11 | 7 if generation is slow |
| Era generation | Parallel from the photo + monotonic `structures` state | Two sequential chains (now → past, now → future), if the spike shows flicker |
| Forks | Our timeline + 2 curated | A third as stretch; 1 if behind |
| Name | Elsewhen | Strata, Deep Window, Forking Present |

## 20. Revision log

**2026-10-21: Occam's Razor pass** (advanced elicitation)
- One Vite project with `@cloudflare/vite-plugin` instead of a pnpm monorepo.
- Client owns scene state; server routes are thin pass-throughs; KV only for the budget counter.
- Dropped the Spark scene-analysis call (Muse Image sees the photo it edits).
- Transitions use one delay map from the original photo's masks; SAM on generated keyframes only for the creature/poster target.
- Creature-card text and poster element labels live in the hand-edited chronicles (no runtime Spark calls per scene).
- Budget guard reduced to a daily cap + kill switch; EXIF stripping comes free with the canvas re-encode; haptics dropped.
- **Fixed:** layered parallax would open disocclusion holes and ghost creatures → single-layer gyro pan in MVP.
- **Fixed:** the lazily generated poster wouldn't match the one on the wall → poster-first pipeline via multi-image blend; element labels correct by construction.

**2026-10-21: User Persona Focus Group** (judge on a laptop, group-chat phone user, history skeptic, biology teacher)
- Landing is an auto-playing demo scene; the camera is a secondary "Try it where you are" button; no permissions before the first wow.
- Our timeline is the default; "Change history" lives in the viewer; the iOS motion permission is requested only from the "Tilt to look around" chip.
- Desktop is first-class: mouse look, scroll-wheel/arrow-key scrubbing, landscape layout; desktop goes first in every test pass.
- The generation wait shows a shimmer over the photo and streams the chronicle's era captions.
- Tapping the branch marker shows `chronicle.chain`, the chain of events from the divergence to now.
- Deep-time fauna is grounded in 4 biomes picked from Cloudflare's coarse `request.cf` location (user-overridable); chronicles carry per-biome variants for biology eras.
- Not taken: clip export (MediaRecorder), "speculative" badges, and the video-hook note.

**2026-10-21: Red Team vs Blue Team**
- The client never sends prompts; the Worker builds them from committed chronicles. Turnstile on scene creation, HMAC-signed scene IDs. Spark runs offline only.
- Monotonic `structures` state per era so independently generated eras agree; the pre-hackathon test decides between parallel generation and two sequential chains.
- GPU texture manager (2–3 keyframes on the GPU, 1280 px cap on phones, context-loss recovery) so iPhone Safari doesn't kill the tab.
- R2 lifecycle applies to `uploads/` only; static demo scenes; pinned model IDs, `/api/health` and a "Live generation is resting" fallback; keep credits funded until judging ends.
- Deterministic R2 keys written in `ctx.waitUntil`; the client resumes from R2 after the tab is suspended.
- A canonical aspect ratio per scene; every keyframe is resized to it; cover fit with a blurred backdrop.
- The writing track runs in parallel (days 3–7); the MVP is our timeline + 2 forks.
- Posters are generated without text; the slogan is real typography; regenerate once if fewer than 3 elements are found.
- At most 4 requests in flight with backoff + jitter on 429.
- SAM `person` check with a "works best on places" warning; people removed from non-present eras.

**2026-10-21: Feynman Technique** (explaining the plan simply exposed these gaps)
- Fixed table of culture vs. biology eras; generated-keyframe counts per fork (our timeline 11, Rome 8, printing press 7, Alexandria 9).
- "Posters" generalized to era-appropriate **idea fossils** (`medium`: inscription, coin, mural, poster, hologram…); same exploded view for all.
- Our timeline shows real but non-political artifacts; fictional ideologies only in forks.
- Past fauna is real (`kind: "extinct"`, cited sources); future fauna is `speculative` and labelled.
- `unbuilt` / `predecessor` structure states with a state-dependent preservation clause; indoor photo added to the pre-hackathon test; demo scenes stay outdoors.
- Blending between keyframes defined in slider position (symlog), not years.
- Server-side idempotency + in-progress lock: each `(scene, fork, biome, year)` is generated at most once, bounding a leaked scene link at ~$1.50.
- Demo scenes: licensed photos from other climates + `scripts/export-demo.ts`.

**2026-10-21: Execution planning**
- Worker CPU limits: the Worker no longer resizes images or decodes masks. The client scales keyframes to the canonical size on load and decodes SAM's raw text with `@meta-sam/parser`. Workers Paid plan recommended.
- Granular task list with estimates, dependencies and decision gates: [execution-plan.md](execution-plan.md).

**2026-10-26: Spike (G1)** — go. Independent generation (chains drift), one delay map from the photo (IoU ≈ 0.92), 9 keyframes (edit median 23 s), indoor notice, JSON form for multi-image edits, and the content filter is non-deterministic on decay prompts (calm wording + retry + fallback). Details in §13.
