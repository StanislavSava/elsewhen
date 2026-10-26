# Elsewhen — Execution Plan

The task-by-task checklist to work from. The *why* behind each task lives in [implementation-plan.md](implementation-plan.md) (section numbers given as §N).
Each task has an ID, an estimate, its dependencies and a "done when". Days are sized for ~4 h of build time, plus a separate ~45 min writing track on days 2–7.

**Clock check (if you're on Romanian time, EET):** the hackathon opens **Sun Oct 26, 18:00 your time** (12:00 PM ET), and the deadline is **Tue Nov 4, 9:00 PM ET = Wed Nov 5, 04:00 your time**. The plan's "submit by 5 PM ET" target is **midnight Nov 4→5 your time**. Day 1 is therefore an evening session.

## Progress (updated 2026-10-26, day 1)

Ahead of plan. Done on day 1: D1.x foundations, D2.x capture + scene creation, D3.x era generation, most of D4 (renderer, symlog slider, desktop input, history picker + chain sheet), the D5 transition shader and look-around, D6 creatures + field-guide card, D7 exploded idea fossils, D8.1 demo scenes (in progress) and the landing overlay with autoplay. Forks drafted by Muse Spark (W2–W3). Not yet: deploy (waiting for go-ahead), Turnstile hostname, share-link OG image, budget/kill-switch test on the deployed Worker, hint chips, video.

---

## Phase 0 — Before the API key arrives (Oct 21–25)

Nothing here needs the key. Order matters: P0-1 and P0-2 first (they can change everything else), then the two sandboxes (they de-risk the tech you haven't used before), then the creative work.

**Sandboxes are throwaway learning code** in `sandbox/` (git-ignored, like `spike/`). Rewrite rather than copy on Oct 26, which keeps you clear of "prior work" rules.

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| **P0-1** | Read the hackathon rules. Record in `docs/hackathon-rules.md`: prior-work policy, judging dates, required submission assets (video length/format, repo visibility, description), model-usage requirements, any rules on third-party services. | 0.5 h | – | You know the judging end date and whether sandboxes/spike are allowed as prior learning. |
| **P0-2** | Accounts: Cloudflare (enable Workers **Paid**, $5/mo: 30 s CPU instead of 10 ms), R2 bucket, KV namespace, Turnstile site + secret key; GitHub repo (empty, private until submission); optional domain. | 0.5 h | – | All keys stored in the root `.env` (never committed). |
| **P0-3** | **Sandbox B, the platform** (`sandbox/platform/`): `npm create cloudflare` with Vite + `@cloudflare/vite-plugin` + Hono. Routes: `GET /api/hello` returning `request.cf` (country/region/lat), an R2 put/get, a KV counter, a Turnstile-protected `POST`. A page that opens the rear camera with `getUserMedia`, captures a frame to canvas, and asks for the iOS motion permission from a button. Deploy. | 2.5 h | P0-2 | On your iPhone over HTTPS: camera preview works, a captured frame lands in R2, tilt values print, `request.cf` shows your region. |
| **P0-4** | **Sandbox A, the renderer** (`sandbox/renderer/`): three.js full-screen quad with a `ShaderMaterial` crossfading two of your photos (use one HEIC photo plus a recoloured copy). Then add the noise-dissolve with a **hand-painted delay map** (grayscale PNG: sky black, buildings light grey). Then mouse look-around with ~8% overscan and a range slider driving `t`. | 3.5 h | – | Dragging the slider dissolves sky first and buildings last with a noisy edge, at 60 fps on your phone. |
| **P0-5** | Write the 3 fork premises by hand (one paragraph each, plus divergence year). | 1 h | – | `forks/premises.md` exists. |
| **P0-6** | Chronicle style guide (`docs/chronicle-style.md`): caption ≤ 60 chars; chain of 5–7 events; idea-fossil medium per era (§5 table); our timeline uses real non-political artifacts only; fork ideologies fictional; banned content (real extremist symbols, real politicians, people's faces); extinct fauna must cite sources; speculative fauna is labelled. | 1 h | P0-5 | Spark drafting on day 2 has a spec to follow. |
| **P0-7** | Biome mapping table (`docs/biome-map.md`): rules from `request.cf` country + latitude → `temperate / arid / tropical / cold`, plus a fallback. | 0.5 h | – | Covers your country, the judges' likely countries (US, UK, EU, India, Brazil) and a default. |
| **P0-8** | Moodboard + visual identity: 1 display typeface + 1 text face (Google Fonts), a palette that works over photos, field-guide card styling, slider styling. | 1.5 h | – | A one-page `docs/visual-identity.md` with fonts, colours and 3–5 reference images. |
| **P0-9** | Demo photos: your own **landscape** street photo, plus 3 licensed (CC0/Unsplash) outdoor landscape photos from arid, tropical and cold regions. Record each licence. | 1 h | – | `demo-photos/` (git-ignored) + `demo-photos/LICENSES.md`. |
| **P0-10** | Demo video storyboard: 2–3 min shot list. Hook (your street → +1M in 5 s), the thesis line, the scrub, a fossil explode, a creature card, how it's built, what's next. Note which shots you can capture as you build. | 0.5 h | – | `docs/video-storyboard.md`. |
| **P0-11** | **When the key arrives:** run the spike (`spike/README.md`), first `--only eras`, then everything. | 1 h | key | `spike/outputs/index.html` reviewed. |
| **G1** | **Decision gate: spike results** (see below). | 0.5 h | P0-11 | Decisions written into implementation-plan §13. |

**Phase 0 total:** ~14 h. If you only get half of it done, do **P0-1, P0-2, P0-3, P0-4, P0-11/G1**. The creative tasks (P0-5 to P0-10) can slide into the writing track.

### G1 — Spike decision gate

| Question | If yes | If no |
|---|---|---|
| Is the place recognizable at −1M and +1M? | Proceed as planned. | Try fallback 1 (masked inpainting) in the spike; if still no, fallback 2 (composite) or 3 ("postcards from elsewhen"). **Re-plan days 3–5 before Oct 26.** |
| Independent eras scrub as progress? | Parallel generation (default). | Two sequential chains; drop to 9 keyframes if the chain wall-clock exceeds ~90 s. |
| Indoor deep past believable? | Allow indoor photos. | "Works best outdoors" notice for indoor captures. |
| Building/wall IoU at +1k high enough (≳ 0.6)? | One delay map from the photo's masks. | Run SAM per keyframe and bake per-keyframe delay maps (+~1 h on day 5). |
| Poster blend works and SAM finds it? | Fossil-first via multi-image blend. | Composite the fossil onto the SAM `wall` mask with a perspective warp (+~2 h on day 7, cut rival cards). |
| Median edit latency? | ≤ 15 s: 11 keyframes. | 15–30 s: 9 keyframes. > 30 s: 7 keyframes and lean harder on the waiting-state content. |
| Edits keep the input aspect ratio? | Done. | Canonical aspect = nearest ratio that comes back; crop on the client. |

---

## Phase 1 — Hackathon build (Oct 26 – Nov 4)

Every day ends with a **deployed build** you've opened on your phone and laptop. Dependencies point to earlier task IDs.

### Day 1 — Sun Oct 26 (evening): foundations

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D1.1 | `git init`; Vite + TS + `@cloudflare/vite-plugin` + Hono (rebuilt from what you learned in P0-3); `wrangler.jsonc` with R2 + KV bindings; ESLint + Prettier + Vitest; `.gitignore` keeps `spike/`, `sandbox/`, `demo-photos/`, `.env*` out. | 1 h | P0-3 | `npm run dev` serves page + worker locally; first commit. |
| D1.2 | Secrets: `MODEL_API_KEY`, `TURNSTILE_SECRET`, `SCENE_HMAC_KEY` via `wrangler secret put`; local `.dev.vars` generated from the root `.env`; model IDs pinned in `worker/config.ts`. | 0.25 h | D1.1 | `/api/health` (D1.5) sees the secrets locally and deployed. |
| D1.3 | `worker/meta/image.ts`: `edit()` and `generate()` with `fetch` (JSON body with `images: [{image_url: dataURL}]`), timeout, retry with backoff on 429/503, `content_policy_violation` surfaced as a typed error. | 0.75 h | D1.2 | One edit from a fixture photo returns bytes. |
| D1.4 | `worker/meta/sam.ts`: Responses call with `stream: true`, collect `output_text` into raw text, no decoding (client job). | 0.5 h | D1.2 | Raw SAM text for "sky" on a fixture photo. |
| D1.5 | `GET /api/health` (pinned models reachable, budget state) and `GET /api/context` (`worker/biome.ts` from P0-7) + unit test for the biome table. | 0.5 h | D1.1 | Tests pass; deployed `/api/context` returns your biome. |
| D1.6 | Port the spike's winning prompts into `worker/prompts/` (era clauses by structure state, poster, blend). | 0.5 h | G1 | Prompt builders unit-tested with snapshots. |
| D1.7 | Deploy; temporary dev-only route (guarded by a secret header) that runs one era edit end to end. Delete it on day 3. | 0.5 h | D1.3 | Phone hits the deployed route and shows a generated era. |

### Day 2 — Mon Oct 27: capture + scene creation

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D2.1 | Capture screen: rear camera preview, shutter, file-picker fallback (desktop, or permission denied). | 1 h | D1.1 | Works on iPhone Safari and desktop Chrome. |
| D2.2 | Client preprocessing: canvas downscale to 1536 px, crop to the canonical aspect from G1, JPEG re-encode (strips EXIF). | 0.5 h | D2.1 | Unit test for the crop maths; output has no EXIF. |
| D2.3 | `POST /api/scenes`: Turnstile verify, budget check, store under `uploads/`, return HMAC-signed `sceneId` + canonical size. R2 lifecycle rule on `uploads/` only. | 1 h | D1.2 | A request without a token is rejected; a signed ID verifies; a tampered one doesn't. |
| D2.4 | `POST /api/scenes/:id/masks`: base SAM phrases in parallel, raw text to R2. | 0.5 h | D1.4, D2.3 | Raw mask text for 8–9 phrases stored. |
| D2.5 | Client: decode masks with `@meta-sam/parser`; `person` coverage check + "works best on places" notice; bake the delay map to a texture. | 1 h | D2.4 | The delay map, rendered as greyscale on screen, matches the photo. |
| ✍️ W2 | `scripts/chronicle.ts`: Spark drafts all 3 forks + our timeline against the style guide (structured output → zod-validated JSON). | 0.75 h | P0-6 | 4 draft chronicles in `forks/drafts/`. |

### Day 3 — Tue Oct 28: era generation

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D3.1 | Chronicle zod schema + loader; validate the drafts, fix what fails. | 0.5 h | W2 | All drafts parse. |
| D3.2 | `POST/GET /api/scenes/:id/eras/:year`: validate fork/year/biome, idempotency check, in-progress lock, server-built prompt, deterministic R2 key via `ctx.waitUntil`. | 1.25 h | D1.6, D3.1 | Two concurrent identical requests bill once; a disconnect mid-request still stores the result. |
| D3.3 | Fossil-first path for culture eras: text-free fossil (t2i) → multi-image blend (or the G1 fallback). | 0.5 h | D3.2 | A culture era comes back with its fossil in the scene. |
| D3.4 | SAM target per keyframe (`animal`/creature name or fossil medium), raw text to R2. | 0.25 h | D3.2 | Masks stored for the target. |
| D3.5 | Client orchestrator: queue with ≤4 in flight, nearest-first, backoff + jitter, resume via `GET`, pre-divergence reuse, per-era status. | 1 h | D3.2 | Kill the tab mid-generation, reopen: nothing is requested twice. |
| D3.6 | Waiting state (shimmer + streamed captions) and a temporary grid viewer. Delete the D1.7 route. | 0.5 h | D3.5 | A full scene generates on the phone; you can see every keyframe. |
| ✍️ W3 | Hand-edit our timeline (all eras) and the demo path of fork 1. | 0.75 h | W2 | Committed to `forks/`. |
| **G2** | **Gate:** is generation reliable and fast enough? | – | D3.6 | < 90 s and < 10% failures → continue. Otherwise cut keyframes now (not on day 8). |

### Day 4 — Wed Oct 29: renderer + slider

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D4.1 | three.js quad (from P0-4) + texture manager: 2–3 keyframes on the GPU, the rest as blobs, `createImageBitmap` with resize to canonical size, 1280 px cap on phones, context-loss recovery. | 1.25 h | D3.6, P0-4 | Three full sweeps on the iPhone with no crash. |
| D4.2 | Cover fit + blurred colour-sampled backdrop. | 0.5 h | D4.1 | A portrait scene looks intentional on a landscape laptop. |
| D4.3 | Symlog slider: ticks, era label + caption, blend in slider space (§7); unit tests for the maths. | 1 h | D4.1 | Scrubbing is smooth with plain crossfades. |
| D4.4 | Desktop input: wheel/trackpad, ←/→ jumps, Home = now. | 0.25 h | D4.3 | Works on a laptop without touching the slider. |
| D4.5 | Branch marker + chain sheet; "Change history" sheet (2 forks); biome shown in the UI. | 0.75 h | D4.3, W3 | Switching to fork 1 regenerates only post-divergence eras. |
| D4.6 | Device pass + **record a screen capture** (first footage for the video). | 0.25 h | – | Clip saved in `video/`. |
| ✍️ W4 | Fork 1: chain + remaining eras; fork 2: demo path. | 0.75 h | W3 | Committed. |

### Day 5 — Thu Oct 30: beauty pass

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D5.1 | Noise-dissolve transition shader driven by the delay map (from P0-4). | 1 h | D4.3, D2.5 | Sky first, buildings last, organic edge. |
| D5.2 | Look-around: mouse, touch-drag, "Tilt to look around" chip with the iOS permission, low-pass filter. | 1 h | D4.1 | Tilt works on the iPhone; drag works everywhere. |
| D5.3 | Grading: grain, vignette, warm past / cold future tint. | 0.75 h | D5.1 | Eras feel distinct at a glance. |
| D5.4 | UI styling from the visual identity (P0-8): typography, slider, sheets. | 1 h | P0-8 | Screens look designed, not default. |
| D5.5 | Device pass. | 0.25 h | – | – |
| ✍️ W5 | Fork 2: chain + remaining eras. | 0.75 h | W4 | Committed. |
| **G3** | **Gate:** is it beautiful? | – | D5.4 | If transitions or grading look cheap, spend buffer here before adding creatures/fossils. |

### Day 6 — Fri Oct 31: creatures

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D6.1 | Creature hit-testing on the decoded mask (CPU `ImageData`). | 0.75 h | D3.4 | Tapping the creature (and only it) registers. |
| D6.2 | Hint glow on tappable masks (edge glow in the shader, 2 s after an era loads). | 0.75 h | D5.1 | Visible but not noisy. |
| D6.3 | Field-guide card: naturalist styling, binomial, ancestor, niche, adaptations with "because…", sources for extinct / "Speculative biology" for future. | 1.5 h | D6.1 | Cards read well on phone and desktop. |
| D6.4 | Biome override → regenerate biology eras only. | 0.5 h | D3.5 | Switching biome swaps the creature. |
| D6.5 | Device pass. | 0.5 h | – | – |
| ✍️ W6 | Spot-check non-demo biome variants; fix the worst. | 0.75 h | – | – |

### Day 7 — Sat Nov 1: idea fossils

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D7.1 | Fossil hit-testing; decode element masks from the fossil image. | 0.5 h | D3.3 | Tapping the fossil opens the view. |
| D7.2 | Exploded view: one plane per element, swipe/drag to rotate, labels, slogan as real typography. | 2 h | D7.1 | The same fossil from the scene pulls apart cleanly. |
| D7.3 | Story sheet: "why this idea won" + rival idea cards. | 0.75 h | D7.2 | – |
| D7.4 | Fallback: fewer than 3 elements found → regenerate once → label what was found. | 0.25 h | D7.1 | – |
| D7.5 | Device pass; capture footage of an explode. | 0.5 h | – | Clip saved. |
| ✍️ W7 | Final read-through of every caption and chain on the demo path. | 0.75 h | – | – |

### Day 8 — Sun Nov 2: demo + robustness (**feature freeze tonight**)

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D8.1 | Generate demo scenes from P0-9 photos; `scripts/export-demo.ts` into `public/demo/`; licence credits. | 1 h | P0-9 | 3–4 demo scenes load with zero API calls. |
| D8.2 | Landing: auto-scrub demo (6 s) → controls + "Try it where you are". | 0.75 h | D8.1 | No permission prompt before the first wow. |
| D8.3 | Share URL `/s/:id` + OG image (the +1M keyframe); saved scenes under `scenes/` (no expiry). | 0.5 h | D3.5 | A shared link opens on another device. |
| D8.4 | Error states + "Live generation is resting" driven by `/api/health`. | 0.75 h | D1.5 | Each failure shows a human message, never a stack trace. |
| D8.5 | Budget cap + kill switch tested on the deployed Worker. | 0.25 h | – | Flipping the switch forces demo-only mode. |
| D8.6 | Full device matrix (desktop Chrome/Safari, iPhone Safari, Android Chrome), resume test, idempotency test. | 0.75 h | – | All pass, or bugs are logged for day 9. |
| | *(If any time is left)* `bmad-code-review` on the diff. | – | – | – |

### Day 9 — Mon Nov 3: polish + story

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D9.1 | One-time hint chips (scroll through time, tap the creature, tap the branch). | 0.5 h | – | – |
| D9.2 | Polish from the list you kept during days 4–8 (no new features). | 1.5 h | – | – |
| D9.3 | Record the demo video from the storyboard (P0-10) + the clips you captured. | 1.5 h | P0-10 | First cut exported. |
| D9.4 | README: concept, architecture diagram, Meta model usage, how to run, photo credits. | 0.5 h | – | – |

### Day 10 — Tue Nov 4: ship (deadline 9 PM ET = 04:00 EET Nov 5)

| ID | Task | Est. | Depends | Done when |
|---|---|---|---|---|
| D10.1 | Blocking fixes only. | ≤ 2 h | – | – |
| D10.2 | Final verification: live URL cold-open on desktop + phone, demo scenes, share link, budget guard, `/api/health`. | 0.5 h | – | – |
| D10.3 | **Submit by 5 PM ET (midnight EET)**: URL, video, repo (make public if required), description. | 0.5 h | D10.2 | Confirmation received. |
| D10.4 | Post in the hackathon community; mention you're open to teammates. | 0.25 h | – | – |
| D10.5 | Confirm Cloudflare billing + Meta credits last until judging ends; calendar reminders to check the URL during judging. | 0.25 h | P0-1 | Reminders set. |

---

## Running rules

- **Keep a polish list** (`docs/polish.md`) from day 4: anything ugly goes there instead of being fixed mid-task.
- **Capture footage as you go** (days 4, 5, 7): the video is far easier from real clips than recorded in one evening.
- **Behind by more than half a day?** Cut in this order: rival idea cards → per-era grading → gyro (keep drag) → 2 forks down to 1 (implementation-plan §14).
- **After the freeze (end of day 8):** bugs and polish only.
