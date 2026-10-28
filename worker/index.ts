import { Hono, type Context } from "hono";
import type { ApiError, ConfigResponse, CreateSceneResponse, EraResult, MasksResponse, NotesResponse, StoryResponse } from "../src/shared/api";
import { CHRONICLES, DEFAULT_FORK, findEra, isShared, yearsFor } from "../src/shared/chronicles";
import { BIOMES, SETTINGS, isEraYear, type Biome, type ChronicleEra, type Setting } from "../src/shared/eras";
import { biomeFor } from "./biome";
import { BASE_PHRASES, IMAGE_MODEL, IMAGE_PRICE_CENTS, MAX_PHOTO_BYTES, SAM_MODEL, type Env } from "./config";
import {
  budgetLeftCents,
  isLive,
  releaseLock,
  signScene,
  spend,
  takeLock,
  verifySceneToken,
  verifyTurnstile,
} from "./guard";
import { describeCells } from "./cells";
import { gate } from "./gate";
import { ContentFilteredError, editImage, segment } from "./meta/client";
import { eraLabel, getNotes, noteFor, readNoteFor, readNotes, townOf } from "./historian";
import { writeStory, type StoryEra } from "./story";
import { iou, occupancy } from "./geometry";
import { judge, passes } from "./judge";
import { bareEraPrompt, CREATURE_PHRASE, eraPrompt, promptVersion } from "./prompts";

type C = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

// Everything, static files included (run_worker_first), sits behind the shared password.
app.use("*", gate);

const fail = (c: C, status: 400 | 403 | 404 | 409 | 422 | 502 | 503, error: ApiError["error"], detail?: string) =>
  c.json<ApiError>({ error, detail }, status);

const fileUrl = (key: string) => `/api/files/${key}`;

function toDataUrl(bytes: ArrayBuffer, mime: string): string {
  const view = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}

// ---------------------------------------------------------------- config & health

app.get("/api/config", async (c) => {
  return c.json<ConfigResponse>({
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
    live: await isLive(c.env),
    biome: biomeFor(c.req.raw.cf as Parameters<typeof biomeFor>[0]),
  });
});

app.get("/api/health", async (c) => {
  return c.json({
    live: await isLive(c.env),
    budgetLeftCents: await budgetLeftCents(c.env),
    models: { image: IMAGE_MODEL, sam: SAM_MODEL },
  });
});

// ---------------------------------------------------------------- scenes

app.post("/api/scenes", async (c) => {
  if (!(await isLive(c.env))) return fail(c, 503, "resting");
  const ok = await verifyTurnstile(c.env, c.req.header("cf-turnstile-response"), c.req.header("cf-connecting-ip"));
  if (!ok) return fail(c, 403, "turnstile_failed");

  const width = Number(c.req.header("x-photo-width"));
  const height = Number(c.req.header("x-photo-height"));
  const length = Number(c.req.header("content-length") ?? "0");
  if (c.req.header("content-type") !== "image/jpeg") return fail(c, 400, "bad_request", "expected image/jpeg");
  if (!length || length > MAX_PHOTO_BYTES) return fail(c, 400, "bad_request", "photo too large or empty");
  if (!(width > 0 && height > 0 && width <= 2048 && height <= 2048)) return fail(c, 400, "bad_request", "bad size");

  const id = crypto.randomUUID();
  const photoKey = `scenes/${id}/photo.jpg`;
  await c.env.BUCKET.put(photoKey, c.req.raw.body, {
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: { width: String(width), height: String(height) },
  });
  return c.json<CreateSceneResponse>({ token: await signScene(c.env, id), id, width, height, photoUrl: fileUrl(photoKey) });
});

async function sceneFromToken(c: C): Promise<{ id: string; photo: R2ObjectBody } | null> {
  const id = await verifySceneToken(c.env, c.req.param("token") ?? "");
  if (!id) return null;
  const photo = await c.env.BUCKET.get(`scenes/${id}/photo.jpg`);
  return photo ? { id, photo } : null;
}

app.post("/api/scenes/:token/masks", async (c) => {
  const scene = await sceneFromToken(c);
  if (!scene) return fail(c, 404, "not_found");
  const photo = toDataUrl(await scene.photo.arrayBuffer(), "image/jpeg");
  const masks: Record<string, string | null> = {};
  await Promise.all(
    BASE_PHRASES.map(async (phrase) => {
      const key = `scenes/${scene.id}/masks/${phrase}.txt`;
      const existing = await c.env.BUCKET.head(key);
      if (!existing) {
        try {
          await c.env.BUCKET.put(key, await segment(c.env.MODEL_API_KEY, { phrase, image: photo }), {
            httpMetadata: { contentType: "text/plain" },
          });
        } catch (err) {
          console.error(`masks ${scene.id} "${phrase}":`, String(err).slice(0, 300));
          masks[phrase] = null;
          return;
        }
      }
      masks[phrase] = fileUrl(key);
    }),
  );
  return c.json<MasksResponse>({ masks });
});

// ---------------------------------------------------------------- place research

/** Muse Spark researches what stood here in every era of a history (cached); returns the place it identified. */
app.post("/api/scenes/:token/notes", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { forkId?: string };
  const forkId = body.forkId && CHRONICLES[body.forkId] ? body.forkId : DEFAULT_FORK;
  const scene = await sceneFromToken(c);
  if (!scene) return fail(c, 404, "not_found");
  if (!(await isLive(c.env))) return fail(c, 503, "resting");
  try {
    const photo = toDataUrl(await scene.photo.arrayBuffer(), "image/jpeg");
    const notes = await getNotes(c.env, scene.id, forkId, async () => photo);
    const town = await townOf(c.env, scene.id, notes.place).catch(() => null);
    return c.json<NotesResponse>({ place: notes.place, town, eras: notes.eras, cells: notes.cells ?? null });
  } catch (err) {
    console.error(`notes ${scene.id} ${forkId}:`, String(err).slice(0, 300));
    return fail(c, 502, "upstream");
  }
});

// ---------------------------------------------------------------- eras

type EraParams = { forkId: string; biome: Biome; setting: Setting };

const MIN_BUILDING_OVERLAP = 0.6; // spike: a well-kept scene scored ~0.92

/** Overlap between the photo's buildings and the new image's buildings, or null when there's nothing to compare. */
async function buildingOverlap(env: Env, sceneId: string, imageData: string): Promise<number | null> {
  try {
    const base = await env.BUCKET.get(`scenes/${sceneId}/masks/building.txt`);
    if (!base) return null;
    const before = occupancy(await base.text());
    if (!before.some(Boolean)) return null;
    const after = occupancy(await segment(env.MODEL_API_KEY, { phrase: "building", image: imageData }));
    return iou(before, after);
  } catch (err) {
    console.error(`overlap ${sceneId}:`, String(err).slice(0, 200));
    return null;
  }
}

/**
 * Shared eras (before a divergence, and all of deep time) are stored once under "base" for every history.
 * The prompt version makes an edited chronicle regenerate only the eras whose prompts changed.
 */
async function eraPrefix(sceneId: string, year: number, p: EraParams, era: ChronicleEra, note: string): Promise<string> {
  const fork = isShared(p.forkId, year) ? "base" : p.forkId;
  const version = await promptVersion(era, p.biome, p.setting, note);
  return `scenes/${sceneId}/${fork}/${era.driver === "biology" ? p.biome : "-"}/${p.setting}/${year}/${version}`;
}

async function readEra(env: Env, prefix: string): Promise<EraResult | null> {
  const meta = await env.BUCKET.get(`${prefix}/meta.json`);
  return meta ? ((await meta.json()) as EraResult) : null;
}

function parseEraParams(input: Record<string, unknown>): EraParams | null {
  const { forkId, biome, setting } = input;
  if (typeof forkId !== "string" || !CHRONICLES[forkId]) return null;
  if (!BIOMES.includes(biome as Biome) || !SETTINGS.includes(setting as Setting)) return null;
  return { forkId, biome: biome as Biome, setting: setting as Setting };
}

app.get("/api/scenes/:token/eras/:year", async (c) => {
  const id = await verifySceneToken(c.env, c.req.param("token"));
  const year = Number(c.req.param("year"));
  const params = parseEraParams(c.req.query());
  const era = params && findEra(params.forkId, year);
  if (!id || !params || !era) return fail(c, 404, "not_found");
  const note = await readNoteFor(c.env, id, params.forkId, year);
  if (note === null) return fail(c, 404, "not_found");
  const result = await readEra(c.env, await eraPrefix(id, year, params, era, note));
  return result ? c.json(result) : fail(c, 404, "not_found");
});

app.post("/api/scenes/:token/eras/:year", async (c) => {
  const year = Number(c.req.param("year"));
  const params = parseEraParams(await c.req.json().catch(() => ({})));
  // Year 0 is the photo itself in our timeline; a fork paints its own alternate present.
  if (!isEraYear(year) || !params || (year === 0 && params.forkId === DEFAULT_FORK)) return fail(c, 400, "bad_request");
  const era = findEra(params.forkId, year);
  if (!era) return fail(c, 400, "bad_request", "no such era in this fork");

  const scene = await sceneFromToken(c);
  if (!scene) return fail(c, 404, "not_found");
  if (!(await isLive(c.env))) return fail(c, 503, "resting");
  const photo = toDataUrl(await scene.photo.arrayBuffer(), "image/jpeg");
  // What actually stood here in this era (Muse Spark, once per scene and history).
  let note: string;
  try {
    note = await noteFor(c.env, scene.id, params.forkId, year, async () => photo);
  } catch (err) {
    console.error(`notes ${scene.id} ${params.forkId}:`, String(err).slice(0, 300));
    note = "";
  }
  const prefix = await eraPrefix(scene.id, year, params, era, note);

  const existing = await readEra(c.env, prefix);
  if (existing) return c.json(existing);
  if (!(await takeLock(c.env, prefix))) return fail(c, 409, "pending");

  const env = c.env;
  const width = scene.photo.customMetadata?.width;
  const height = scene.photo.customMetadata?.height;
  const size = `${width}x${height}`;

  // Runs under waitUntil so a phone that suspends the tab mid-request still gets the result on resume.
  const work = (async (): Promise<EraResult> => {
    try {
      type Painting = { bytes: ArrayBuffer; type: string; data: string };
      const paint = async (fixes: string): Promise<Painting> => {
        const edit = (prompt: string) => editImage(env.MODEL_API_KEY, { prompt, images: [photo], size });
        let url: string;
        try {
          url = await edit(eraPrompt(era, params.biome, params.setting, note, fixes));
        } catch (err) {
          // The content filter is non-deterministic and blocks even calm notes now and then: last try, plain prompt.
          if (!(err instanceof ContentFilteredError)) throw err;
          console.warn(`era ${prefix}: content filter twice, retrying with the plain prompt`);
          try {
            url = await edit(eraPrompt(era, params.biome, params.setting, "", ""));
          } catch (err2) {
            // Last resort: the era's own description and the camera/photo rules, nothing else.
            if (!(err2 instanceof ContentFilteredError)) throw err2;
            console.warn(`era ${prefix}: plain prompt filtered too, trying the bare era`);
            url = await edit(bareEraPrompt(era, params.biome, params.setting));
          }
        }
        await spend(env, IMAGE_PRICE_CENTS);
        // Meta can't fetch its own temporary URLs as inputs (media_url_not_fetchable): checks need the bytes inline.
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch generated image → ${res.status}`);
        const type = res.headers.get("content-type") ?? "image/webp";
        const bytes = await res.arrayBuffer();
        return { bytes, type, data: toDataUrl(bytes, type) };
      };

      // Two checks: Muse Spark judges viewpoint, scale, photographic look and plausibility; and where buildings
      // should keep their place, SAM measures that they still overlap the photo's buildings. Every repaint is
      // checked again (an unchecked repaint let zoomed-in deep-time eras through); the best attempt is kept.
      // Only our own timeline keeps the photo's buildings; an alternate world's futures replace them by design.
      const keepsBuildings = isShared(params.forkId, year) && ["intact", "weathered", "overgrown"].includes(era.structures);
      // The critic also checks an alternate world for things it can't have (cars where nothing runs on electricity).
      const chronicle = CHRONICLES[params.forkId];
      const history = isShared(params.forkId, year) ? "" : `Alternate history: ${chronicle.title}. ${chronicle.premise} `;
      const expected = `${history}${note}${era.driver === "culture" && era.world ? ` It must not show: ${era.world.absent.join(", ")}.` : ""}`;
      const check = async (img: string): Promise<string[]> => {
        const [verdict, overlap] = await Promise.all([
          judge(env, photo, img, eraLabel(year), expected).catch((err) => {
            console.error(`judge ${prefix}:`, String(err).slice(0, 300));
            return null;
          }),
          keepsBuildings ? buildingOverlap(env, scene.id, img) : Promise.resolve(null),
        ]);
        const issues: string[] = [];
        if (verdict && !passes(verdict)) issues.push(verdict.issues || "the viewpoint, scale or photographic look changed");
        if (overlap !== null && overlap < MIN_BUILDING_OVERLAP) {
          issues.push("the buildings moved or changed size: keep every building exactly where and exactly as large as in the original photo, same zoom");
        }
        return issues;
      };
      let best = await paint("");
      let bestIssues = await check(best.data);
      const maxRepaints = Number(env.MAX_REPAINTS ?? "2");
      for (let repaint = 1; bestIssues.length && repaint <= maxRepaints; repaint++) {
        console.log(`era ${prefix}: repaint ${repaint} (${bestIssues.join("; ")})`);
        const next = await paint(bestIssues.join("; "));
        const nextIssues = await check(next.data);
        if (nextIssues.length <= bestIssues.length) [best, bestIssues] = [next, nextIssues];
      }
      console.log(`era ${prefix}: ${bestIssues.length ? `kept with issues (${bestIssues.join("; ")})` : "passed"}`);
      await env.BUCKET.put(`${prefix}/image.webp`, best.bytes, { httpMetadata: { contentType: best.type } });
      const imageData = best.data;

      // Deep time's creature to tap, and labels for every part of the image (the time core).
      const findCreature = async (): Promise<EraResult["target"]> => {
        if (era.driver !== "biology") return null;
        try {
          const raw = await segment(env.MODEL_API_KEY, { phrase: CREATURE_PHRASE, image: imageData });
          await env.BUCKET.put(`${prefix}/target.txt`, raw, { httpMetadata: { contentType: "text/plain" } });
          return { phrase: CREATURE_PHRASE, samUrl: fileUrl(`${prefix}/target.txt`) };
        } catch (err) {
          console.error(`target ${prefix}:`, String(err).slice(0, 300));
          return null; // the era still works without a tappable creature
        }
      };
      const [target, cells] = await Promise.all([findCreature(), describeCells(env, imageData, eraLabel(year), note)]);

      const result: EraResult = { year, imageUrl: fileUrl(`${prefix}/image.webp`), target, cells };
      await env.BUCKET.put(`${prefix}/meta.json`, JSON.stringify(result), {
        httpMetadata: { contentType: "application/json" },
      });
      return result;
    } finally {
      await releaseLock(env, prefix);
    }
  })();
  c.executionCtx.waitUntil(work.catch(() => undefined));

  try {
    return c.json(await work);
  } catch (err) {
    if (err instanceof ContentFilteredError) return fail(c, 422, "content_filtered");
    return fail(c, 502, "upstream", String(err).slice(0, 200));
  }
});

// ---------------------------------------------------------------- story

const STORY_VERSION = 1;

/**
 * What changed at each spot between eras, and why (the time core's "why" line). Built from the eras already
 * painted and their notes, never triggering painting or research; cached by a hash of its inputs, so it is
 * rewritten once more eras exist.
 */
app.post("/api/scenes/:token/story", async (c) => {
  const params = parseEraParams(await c.req.json().catch(() => ({})));
  const id = await verifySceneToken(c.env, c.req.param("token"));
  if (!params || !id) return fail(c, 404, "not_found");
  const base = await readNotes(c.env, id, DEFAULT_FORK);
  const eras: StoryEra[] = [];
  for (const year of yearsFor(params.forkId)) {
    const era = findEra(params.forkId, year);
    if (!era) continue;
    if (year === 0 && params.forkId === DEFAULT_FORK) {
      eras.push({ year, label: eraLabel(0), note: "the photo itself, today", cells: base?.cells ?? null });
      continue;
    }
    const note = await readNoteFor(c.env, id, params.forkId, year);
    if (note === null) continue;
    const meta = await readEra(c.env, await eraPrefix(id, year, params, era, note));
    if (meta) eras.push({ year, label: eraLabel(year), note, cells: meta.cells ?? null });
  }
  if (eras.length < 2) return c.json<StoryResponse>({ story: null });

  const chronicle = CHRONICLES[params.forkId];
  const history =
    params.forkId === DEFAULT_FORK ? "This is our real history." : `Alternate history: ${chronicle.title}. ${chronicle.premise}`;
  const input = JSON.stringify({ v: STORY_VERSION, history, eras });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  const hash = [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `scenes/${id}/story/${params.forkId}/${params.biome}/${params.setting}/${hash}.json`;
  const cached = await c.env.BUCKET.get(key);
  if (cached) return c.json<StoryResponse>({ story: await cached.json() });
  if (!(await isLive(c.env))) return fail(c, 503, "resting");

  const story = await writeStory(c.env, history, eras);
  if (story) await c.env.BUCKET.put(key, JSON.stringify(story), { httpMetadata: { contentType: "application/json" } });
  return c.json<StoryResponse>({ story });
});

// ---------------------------------------------------------------- files

app.get("/api/files/*", async (c) => {
  const key = c.req.path.slice("/api/files/".length);
  if (!/^scenes\/[0-9a-f-]{36}\/[\w./-]+$/.test(key) || key.includes("..")) return fail(c, 404, "not_found");
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return fail(c, 404, "not_found");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});

// Signed in: the built app and demos, with the SPA fallback from wrangler.jsonc.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
