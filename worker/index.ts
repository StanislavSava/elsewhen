import { Hono, type Context } from "hono";
import type { ApiError, ConfigResponse, CreateSceneResponse, EraResult, MasksResponse, NotesResponse, StoryResponse } from "../src/shared/api";
import { anchorYear, CHRONICLES, DEFAULT_FORK, findEra, isShared, yearsFor } from "../src/shared/chronicles";
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
import { judge, penalty } from "./judge";
import { bareEraPrompt, CREATURE_PHRASE, eraPrompt, minimalEraPrompt, promptVersion, type PlaceFacts, type Reference } from "./prompts";

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
    return c.json<NotesResponse>({
      place: notes.place,
      town,
      eras: notes.eras,
      cells: notes.cells ?? null,
      biome: notes.biome ?? null,
    });
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
 * What the historian read off the photo and every era keeps: where a road is ("" for none) and where the camera
 * is. Null before the notes exist. If the historian saw no road but SAM finds a street, we don't know where: null,
 * so a missed reading never erases a real road. GET and POST derive it the same way: it is part of the prompt hash.
 */
async function factsOf(env: Env, sceneId: string): Promise<PlaceFacts> {
  const [notes, mask] = await Promise.all([readNotes(env, sceneId, DEFAULT_FORK), env.BUCKET.get(`scenes/${sceneId}/masks/street.txt`)]);
  const viewpoint = notes?.viewpoint ?? null;
  if (notes?.road === undefined) return { road: null, viewpoint };
  if (notes.road === "" && mask && occupancy(await mask.text()).some(Boolean)) return { road: null, viewpoint };
  return { road: notes.road, viewpoint };
}

/**
 * Shared eras (before a divergence, and all of deep time) are stored once under "base" for every history.
 * The prompt version makes an edited chronicle regenerate only the eras whose prompts changed.
 */
async function eraPrefix(
  sceneId: string,
  year: number,
  p: EraParams,
  era: ChronicleEra,
  note: string,
  facts: PlaceFacts,
): Promise<string> {
  const fork = isShared(p.forkId, year) ? "base" : p.forkId;
  const version = await promptVersion(era, p.biome, p.setting, note, facts);
  return `scenes/${sceneId}/${fork}/${era.driver === "biology" ? p.biome : "-"}/${p.setting}/${year}/${version}`;
}

/** R2 key of an era's current image (the draft, or the refined one once it exists). */
const imageKey = (result: EraResult) => result.imageUrl.slice("/api/files/".length);

/**
 * The neighbouring era toward now, if it is already painted (a draft is enough): its image goes in as a second
 * input so the eras agree on what stands where. The client paints eras outward from now, so it usually is.
 */
async function referenceFor(
  env: Env,
  sceneId: string,
  year: number,
  p: EraParams,
  facts: PlaceFacts,
): Promise<(Reference & { image: string; url: string }) | null> {
  const anchor = anchorYear(p.forkId, year);
  const era = anchor === null ? undefined : findEra(p.forkId, anchor);
  if (anchor === null || !era) return null;
  try {
    const note = await readNoteFor(env, sceneId, p.forkId, anchor);
    if (note === null) return null;
    const meta = await readEra(env, await eraPrefix(sceneId, anchor, p, era, note, facts));
    const obj = meta && (await env.BUCKET.get(imageKey(meta)));
    if (!obj) return null;
    const image = toDataUrl(await obj.arrayBuffer(), obj.httpMetadata?.contentType ?? "image/webp");
    return { label: eraLabel(anchor), later: anchor > year, image, url: meta.imageUrl };
  } catch (err) {
    console.error(`reference ${sceneId} ${year}:`, String(err).slice(0, 200));
    return null;
  }
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
  const result = await readEra(c.env, await eraPrefix(id, year, params, era, note, await factsOf(c.env, id)));
  return result ? c.json(result) : fail(c, 404, "not_found");
});

type Painting = { bytes: ArrayBuffer; type: string; data: string };

/** The critic's weighted penalty (0 = passes), its complaints, and whether it answered at all. */
type Evaluation = { penalty: number; issues: string[]; verified: boolean };

/**
 * Everything one era needs to be painted, checked and described. Shared by the draft (POST …/eras/:year: one
 * paint, shown straight away) and the refinement (POST …/eras/:year/refine: the critic and repaints, which
 * replace the draft only with something better), so a scene fills in fast and gets better behind the scenes.
 */
async function eraJob(c: C, year: number, params: EraParams) {
  const era = findEra(params.forkId, year)!;
  const scene = await sceneFromToken(c);
  if (!scene) return null;
  const env = c.env;
  const photo = toDataUrl(await scene.photo.arrayBuffer(), "image/jpeg");
  // What actually stood here in this era (Muse Spark, once per scene and history).
  let note: string;
  try {
    note = await noteFor(env, scene.id, params.forkId, year, async () => photo);
  } catch (err) {
    console.error(`notes ${scene.id} ${params.forkId}:`, String(err).slice(0, 300));
    note = "";
  }
  const facts = await factsOf(env, scene.id);
  const prefix = await eraPrefix(scene.id, year, params, era, note, facts);
  const size = `${scene.photo.customMetadata?.width}x${scene.photo.customMetadata?.height}`;

  // The content filter is non-deterministic and blocks even calm notes now and then. Each level drops more:
  // the full prompt, then without the historian's note, then the era's own description and the camera/photo
  // rules alone, then a single sentence. Once an era only passes at some level, its repaints start there instead of re-hitting the filter.
  let reference: Awaited<ReturnType<typeof referenceFor>> | undefined;
  const levels = [
    (fixes: string) => ({ prompt: eraPrompt(era, params.biome, params.setting, note, facts, fixes, reference), ref: true }),
    (fixes: string) => ({ prompt: eraPrompt(era, params.biome, params.setting, "", facts, fixes, reference), ref: true }),
    () => ({ prompt: bareEraPrompt(era, params.biome, params.setting, facts), ref: false }),
    () => ({ prompt: minimalEraPrompt(era, year, params.biome), ref: false }),
  ];
  let level = 0;
  const paint = async (fixes: string): Promise<Painting> => {
    if (reference === undefined) reference = await referenceFor(env, scene.id, year, params, facts);
    let url: string;
    for (;;) {
      const { prompt, ref } = levels[level](fixes);
      try {
        url = await editImage(env.MODEL_API_KEY, { prompt, images: reference && ref ? [photo, reference.image] : [photo], size });
        break;
      } catch (err) {
        if (!(err instanceof ContentFilteredError) || level === levels.length - 1) throw err;
        level++;
        console.warn(`era ${prefix}: content filter twice, dropping to prompt level ${level}`);
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

  // Two checks: Muse Spark judges viewpoint, scale, light, photographic look and plausibility; and where buildings
  // should keep their place, SAM measures that they still overlap the photo's buildings.
  // Only our own timeline keeps the photo's buildings; an alternate world's futures replace them by design.
  const keepsBuildings = isShared(params.forkId, year) && ["intact", "weathered", "overgrown"].includes(era.structures);
  // The critic also checks an alternate world for things it can't have (cars where nothing runs on electricity).
  const chronicle = CHRONICLES[params.forkId];
  const history = isShared(params.forkId, year) ? "" : `Alternate history: ${chronicle.title}. ${chronicle.premise} `;
  const absent = era.driver === "culture" && era.world ? ` It must not show: ${era.world.absent.join(", ")}.` : "";
  // A road painted where the photo has none reads as a different place.
  const roads =
    era.driver === "culture" && params.setting === "outdoor"
      ? facts.road === ""
        ? " The original view has no road or street: any road, track, rails or vehicle is wrong."
        : ` Roads and vehicles may only be ${facts.road ? `where the original photo has them (${facts.road})` : "where the original photo has a street"}; a road or tracks anywhere else are wrong.`
      : "";
  const camera = facts.viewpoint ? ` The camera is ${facts.viewpoint}; image 2 must keep that height and angle.` : "";
  const expected = `${history}${note}${absent}${roads}${camera}`;
  // The critic sees the neighbouring era toward now as well (the same one the era is painted with), so a cottage
  // that moved or a road that bent between two eras counts against it. A critic that can't answer is retried once;
  // if it still can't, the result is unverified, not a pass.
  const check = async (img: string): Promise<Evaluation> => {
    if (reference === undefined) reference = await referenceFor(env, scene.id, year, params, facts);
    const neighbour = reference ? { image: reference.image, label: reference.label } : null;
    const ask = () => judge(env, photo, img, eraLabel(year), expected, neighbour);
    const [verdict, overlap] = await Promise.all([
      ask().catch(() =>
        ask().catch((err) => {
          console.error(`judge ${prefix}:`, String(err).slice(0, 300));
          return null;
        }),
      ),
      keepsBuildings ? buildingOverlap(env, scene.id, img) : Promise.resolve(null),
    ]);
    const issues: string[] = [];
    let score = verdict ? penalty(verdict) : 0;
    if (verdict && score > 0) issues.push(verdict.issues || "the viewpoint, scale or photographic look changed");
    if (overlap !== null && overlap < MIN_BUILDING_OVERLAP) {
      score += 2;
      issues.push("the buildings moved or changed size: keep every building exactly where and exactly as large as in the original photo, same zoom");
    }
    return { penalty: score, issues, verified: verdict !== null };
  };

  const writeMeta = (r: EraResult) =>
    env.BUCKET.put(`${prefix}/meta.json`, JSON.stringify(r), { httpMetadata: { contentType: "application/json" } });

  /**
   * Stores an image as the era's current one and returns at once, so the next era in the chain can use it as its
   * reference; its creature, cell labels and building mask follow in the background (enrich).
   */
  const publish = async (p: Painting, file: string, extra: Partial<EraResult>, background = true): Promise<EraResult> => {
    await env.BUCKET.put(`${prefix}/${file}`, p.bytes, { httpMetadata: { contentType: p.type } });
    const result: EraResult = {
      year,
      imageUrl: fileUrl(`${prefix}/${file}`),
      target: null,
      cells: null,
      structuresUrl: null,
      level,
      referenceUrl: reference?.url ?? null,
      ...extra,
    };
    await writeMeta(result);
    if (background) c.executionCtx.waitUntil(enrich(p.data).catch((err) => console.error(`enrich ${prefix}:`, String(err).slice(0, 200))));
    return result;
  };

  /** Adds the creature, cell labels and building mask to the era's current image (once; skipped if replaced). */
  const enrich = async (data: string): Promise<EraResult | null> => {
    const current = await readEra(env, prefix);
    if (!current || current.enriched) return current;
    const file = imageKey(current).split("/").pop()!;
    const p = { data };
    // Deep time's creature to tap, and labels for every part of the image (the time core).
    const findCreature = async (): Promise<EraResult["target"]> => {
      if (era.driver !== "biology") return null;
      try {
        const raw = await segment(env.MODEL_API_KEY, { phrase: CREATURE_PHRASE, image: p.data });
        await env.BUCKET.put(`${prefix}/${file}.target.txt`, raw, { httpMetadata: { contentType: "text/plain" } });
        return { phrase: CREATURE_PHRASE, samUrl: fileUrl(`${prefix}/${file}.target.txt`) };
      } catch (err) {
        console.error(`target ${prefix}:`, String(err).slice(0, 300));
        return null; // the era still works without a tappable creature
      }
    };
    // Where this era's own buildings stand, so transitions can bring each one down or up on its own.
    const findStructures = async (): Promise<string | null> => {
      if (params.setting === "indoor" || era.structures === "unbuilt" || era.structures === "gone") return null;
      try {
        const raw = await segment(env.MODEL_API_KEY, { phrase: "building", image: p.data });
        await env.BUCKET.put(`${prefix}/${file}.structures.txt`, raw, { httpMetadata: { contentType: "text/plain" } });
        return fileUrl(`${prefix}/${file}.structures.txt`);
      } catch (err) {
        console.error(`structures ${prefix}:`, String(err).slice(0, 200));
        return null; // transitions fall back to the photo's buildings
      }
    };
    const [target, cells, structuresUrl] = await Promise.all([
      findCreature(),
      describeCells(env, p.data, eraLabel(year), note),
      findStructures(),
    ]);
    // The era may have been refined meanwhile: only the image these were made for gets them.
    const latest = await readEra(env, prefix);
    if (!latest || latest.imageUrl !== current.imageUrl) return latest;
    const result: EraResult = { ...latest, target, cells, structuresUrl, enriched: true };
    await writeMeta(result);
    return result;
  };

  /** Repaints of an era the filter forced down a level start there, instead of walking down again. */
  const startAt = (l: number | undefined) => (level = Math.min(Math.max(l ?? 0, 0), levels.length - 1));

  return { env, scene, prefix, paint, check, publish, enrich, writeMeta, startAt };
}

/** Runs era work under waitUntil, so a phone that suspends the tab mid-request still gets the result on resume. */
async function runLocked(c: C, lock: string, work: () => Promise<EraResult>): Promise<Response> {
  if (!(await takeLock(c.env, lock))) return fail(c, 409, "pending");
  const job = (async () => {
    try {
      return await work();
    } finally {
      await releaseLock(c.env, lock);
    }
  })();
  c.executionCtx.waitUntil(job.catch(() => undefined));
  try {
    return c.json(await job);
  } catch (err) {
    if (err instanceof ContentFilteredError) return fail(c, 422, "content_filtered");
    return fail(c, 502, "upstream", String(err).slice(0, 200));
  }
}

async function eraRequest(c: C): Promise<{ year: number; params: EraParams } | Response> {
  const year = Number(c.req.param("year"));
  const params = parseEraParams(await c.req.json().catch(() => ({})));
  // Year 0 is the photo itself in our timeline; a fork paints its own alternate present.
  if (!isEraYear(year) || !params || (year === 0 && params.forkId === DEFAULT_FORK)) return fail(c, 400, "bad_request");
  if (!findEra(params.forkId, year)) return fail(c, 400, "bad_request", "no such era in this fork");
  if (!(await isLive(c.env))) return fail(c, 503, "resting");
  return { year, params };
}

/** The draft: one paint, published straight away. */
app.post("/api/scenes/:token/eras/:year", async (c) => {
  const req = await eraRequest(c);
  if (req instanceof Response) return req;
  const job = await eraJob(c, req.year, req.params);
  if (!job) return fail(c, 404, "not_found");
  const existing = await readEra(c.env, job.prefix);
  if (existing) return c.json(existing);
  return runLocked(c, job.prefix, async () => job.publish(await job.paint(""), "image.webp", { draft: true }));
});

/**
 * The refinement: the critic checks the draft and repaints what it rejects (each repaint checked again), keeping
 * the best attempt. The draft stays if nothing beats it. Idempotent: a refined era is returned as it is.
 */
app.post("/api/scenes/:token/eras/:year/refine", async (c) => {
  const req = await eraRequest(c);
  if (req instanceof Response) return req;
  const job = await eraJob(c, req.year, req.params);
  if (!job) return fail(c, 404, "not_found");
  const current = await readEra(c.env, job.prefix);
  if (!current) return fail(c, 404, "not_found");
  if (!current.draft) return c.json(current);
  const { env, prefix } = job;
  job.startAt(current.level);
  return runLocked(c, `${prefix}:refine`, async () => {
    const draft = await env.BUCKET.get(imageKey(current));
    if (!draft) throw new Error("draft image missing");
    const type = draft.httpMetadata?.contentType ?? "image/webp";
    const bytes = await draft.arrayBuffer();
    let best: Painting = { bytes, type, data: toDataUrl(bytes, type) };
    let bestEval = await job.check(best.data);
    let improved = false;
    const maxRepaints = Number(env.MAX_REPAINTS ?? "2");
    // An unverified draft isn't repainted blind: without a verdict there is nothing to fix or to compare against.
    for (let repaint = 1; bestEval.verified && bestEval.penalty > 0 && repaint <= maxRepaints; repaint++) {
      console.log(`era ${prefix}: repaint ${repaint} (penalty ${bestEval.penalty}: ${bestEval.issues.join("; ")})`);
      let next: Painting;
      try {
        next = await job.paint(bestEval.issues.join("; "));
      } catch (err) {
        // A repaint the filter blocks must not throw away the painting we already have.
        if (!(err instanceof ContentFilteredError)) throw err;
        console.warn(`era ${prefix}: repaint ${repaint} filtered, keeping the earlier attempt`);
        break;
      }
      const nextEval = await job.check(next.data);
      // Only a clearly better repaint replaces: one that trades the camera or the geometry for a fix elsewhere
      // scores worse, and a tie keeps what is already there.
      if (nextEval.verified && nextEval.penalty < bestEval.penalty) [best, bestEval, improved] = [next, nextEval, true];
    }
    const verdict = !bestEval.verified ? "unverified" : bestEval.penalty ? `kept with issues (${bestEval.issues.join("; ")})` : "passed";
    console.log(`era ${prefix}: ${verdict}${improved ? ", replaced the draft" : ""}`);
    if (improved) {
      // A new file name: era images are served as immutable, so the draft's URL must not change content.
      await job.publish(best, "refined.webp", { draft: false, verified: true }, false);
    } else {
      const latest = (await readEra(env, prefix)) ?? current;
      await job.writeMeta({ ...latest, draft: false, verified: bestEval.verified });
    }
    // The client gets the era complete: make sure its labels and mask exist before answering.
    return (await job.enrich(best.data)) ?? current;
  });
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
  const [base, facts] = await Promise.all([readNotes(c.env, id, DEFAULT_FORK), factsOf(c.env, id)]);
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
    const meta = await readEra(c.env, await eraPrefix(id, year, params, era, note, facts));
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
