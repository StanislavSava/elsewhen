import { Hono, type Context } from "hono";
import type { ApiError, ConfigResponse, CreateSceneResponse, ElementsResponse, EraResult, MasksResponse, NotesResponse } from "../src/shared/api";
import { CHRONICLES, DEFAULT_FORK, findEra, isShared } from "../src/shared/chronicles";
import { BIOMES, SETTINGS, isEraYear, type Biome, type ChronicleEra, type Fossil, type Setting } from "../src/shared/eras";
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
import { ContentFilteredError, editImage, generateImage, segment } from "./meta/client";
import { eraLabel, getNotes, noteFor, readNoteFor, type PlaceNote } from "./historian";
import { iou, occupancy } from "./geometry";
import { judge, passes } from "./judge";
import { eraPrompt, fossilPlacement, fossilPrompt, promptVersion, targetPhrase } from "./prompts";

type C = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

const fail = (c: C, status: 400 | 403 | 404 | 409 | 422 | 502 | 503, error: ApiError["error"], detail?: string) =>
  c.json<ApiError>({ error, detail }, status);

const fileUrl = (key: string) => `/api/files/${key}`;

function toDataUrl(bytes: ArrayBuffer, mime: string): string {
  const view = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}

/**
 * Copy a short-lived Meta image URL into R2 and return it as a data URL. Meta can't fetch its own
 * temporary URLs as inputs (media_url_not_fetchable), so follow-up calls need the bytes inline.
 */
async function storeFromUrl(env: Env, url: string, key: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch generated image → ${res.status}`);
  const type = res.headers.get("content-type") ?? "image/webp";
  const bytes = await res.arrayBuffer();
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: type } });
  return toDataUrl(bytes, type);
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
    return c.json<NotesResponse>({ place: notes.place });
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
/** The idea fossil an era paints: the historian's replacement for this place, else the chronicle's. */
function fossilFor(era: ChronicleEra, place: PlaceNote): Fossil | undefined {
  return era.driver === "culture" && era.fossil ? (place.fossil ?? era.fossil) : undefined;
}

async function eraPrefix(sceneId: string, year: number, p: EraParams, era: ChronicleEra, place: PlaceNote): Promise<string> {
  const fork = isShared(p.forkId, year) ? "base" : p.forkId;
  const version = await promptVersion(era, p.biome, p.setting, place.note, fossilFor(era, place));
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
  const place = await readNoteFor(c.env, id, params.forkId, year);
  if (place === null) return fail(c, 404, "not_found");
  const result = await readEra(c.env, await eraPrefix(id, year, params, era, place));
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
  let place: PlaceNote;
  try {
    place = await noteFor(c.env, scene.id, params.forkId, year, async () => photo);
  } catch (err) {
    console.error(`notes ${scene.id} ${params.forkId}:`, String(err).slice(0, 300));
    place = { note: "" };
  }
  const note = place.note;
  const prefix = await eraPrefix(scene.id, year, params, era, place);

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
      let fossilUrl: string | null = null;
      let fossilData: string | null = null;
      const fossil = fossilFor(era, place);
      if (fossil) {
        const fossilTemp = await generateImage(env.MODEL_API_KEY, { prompt: fossilPrompt(fossil), size: "1024x1536" });
        fossilData = await storeFromUrl(env, fossilTemp, `${prefix}/fossil.webp`);
        fossilUrl = fileUrl(`${prefix}/fossil.webp`);
        await spend(env, IMAGE_PRICE_CENTS);
      }
      const paint = async (fixes: string): Promise<string> => {
        const edit = (prompt: string) =>
          editImage(env.MODEL_API_KEY, {
            prompt: fossil ? `${prompt} ${fossilPlacement(fossil)}` : prompt,
            images: fossilData ? [photo, fossilData] : [photo],
            size,
          });
        let url: string;
        try {
          url = await edit(eraPrompt(era, params.biome, params.setting, note, fixes));
        } catch (err) {
          // The content filter is non-deterministic and blocks even calm notes now and then: last try, plain prompt.
          if (!(err instanceof ContentFilteredError)) throw err;
          console.warn(`era ${prefix}: content filter twice, retrying with the plain prompt`);
          url = await edit(eraPrompt(era, params.biome, params.setting, "", ""));
        }
        await spend(env, IMAGE_PRICE_CENTS);
        return storeFromUrl(env, url, `${prefix}/image.webp`);
      };

      // Two checks, one repaint: Muse Spark judges viewpoint, scale, photographic look and plausibility; and where
      // buildings should keep their place, SAM measures that they still overlap the photo's buildings.
      let imageData = await paint("");
      const issues: string[] = [];
      const keepsBuildings = ["intact", "weathered", "overgrown"].includes(era.structures);
      const [verdict, overlap] = await Promise.all([
        judge(env, photo, imageData, eraLabel(year), note).catch((err) => {
          console.error(`judge ${prefix}:`, String(err).slice(0, 300));
          return null;
        }),
        keepsBuildings ? buildingOverlap(env, scene.id, imageData) : Promise.resolve(null),
      ]);
      if (verdict && !passes(verdict)) issues.push(verdict.issues || "the viewpoint, scale or photographic look changed");
      if (overlap !== null && overlap < MIN_BUILDING_OVERLAP) {
        issues.push("the buildings moved or changed size: keep every building exactly where and exactly as large as in the original photo, same zoom");
      }
      if (issues.length) imageData = await paint(issues.join("; "));
      console.log(`era ${prefix}: ${issues.length ? `repainted (${issues.join("; ")})` : "passed"}${overlap !== null ? ` · building overlap ${overlap.toFixed(2)}` : ""}`);

      let target: EraResult["target"] = null;
      const phrase = targetPhrase(era, fossil);
      if (phrase) {
        try {
          const raw = await segment(env.MODEL_API_KEY, { phrase, image: imageData });
          await env.BUCKET.put(`${prefix}/target.txt`, raw, { httpMetadata: { contentType: "text/plain" } });
          target = { phrase, samUrl: fileUrl(`${prefix}/target.txt`) };
        } catch (err) {
          console.error(`target ${prefix} "${phrase}":`, String(err).slice(0, 300));
          target = null; // the era still works without a tappable subject
        }
      }

      const result: EraResult = { year, imageUrl: fileUrl(`${prefix}/image.webp`), target, fossilUrl, fossil };
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

/** Lazily segments each named element of an era's idea fossil, for the exploded view. SAM calls only. */
app.post("/api/scenes/:token/eras/:year/elements", async (c) => {
  const year = Number(c.req.param("year"));
  const params = parseEraParams(await c.req.json().catch(() => ({})));
  const era = params && findEra(params.forkId, year);
  if (!params || !era || era.driver !== "culture" || !era.fossil) return fail(c, 400, "bad_request");
  const id = await verifySceneToken(c.env, c.req.param("token"));
  if (!id) return fail(c, 404, "not_found");
  const place = await readNoteFor(c.env, id, params.forkId, year);
  if (place === null) return fail(c, 404, "not_found");
  const prefix = await eraPrefix(id, year, params, era, place);
  const used = fossilFor(era, place)!;
  const fossil = await c.env.BUCKET.get(`${prefix}/fossil.webp`);
  if (!fossil) return fail(c, 404, "not_found");
  const image = toDataUrl(await fossil.arrayBuffer(), fossil.httpMetadata?.contentType ?? "image/webp");

  // One at a time with a retry: three SAM calls at once on the same image failed transiently in testing.
  const elements: ElementsResponse["elements"] = [];
  for (const [i, { name }] of used.elements.entries()) {
    const key = `${prefix}/elements/${i}.txt`;
    let ok = Boolean(await c.env.BUCKET.head(key));
    for (let attempt = 0; !ok && attempt < 2; attempt++) {
      try {
        let raw = await segment(c.env.MODEL_API_KEY, { phrase: name, image });
        // SAM wants plain concrete nouns; if a two-word name finds nothing, try its head noun.
        const head = name.split(" ").at(-1)!;
        if (!raw.includes("<|box") && head !== name) raw = await segment(c.env.MODEL_API_KEY, { phrase: head, image });
        await c.env.BUCKET.put(key, raw, { httpMetadata: { contentType: "text/plain" } });
        ok = true;
      } catch (err) {
        console.error(`elements ${prefix} "${name}" attempt ${attempt + 1}:`, String(err).slice(0, 300));
      }
    }
    elements.push({ name, samUrl: ok ? fileUrl(key) : null });
  }
  return c.json<ElementsResponse>({ elements });
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

export default app;
