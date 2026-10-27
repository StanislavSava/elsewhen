import { api, HttpError } from "./api";
import { fromFile, prepare, startCamera, stopCamera, type PreparedPhoto } from "./capture";
import { closeSheet, showCreature } from "./card";
import { playFracture } from "./fracture";
import { closeTimeCore, isTimeCoreOpen, openTimeCore, type Side, type Slice } from "./timecore";
import { demoEras, demoMaskUrls, loadDemo, loadDemoIndex, type Demo, type DemoIndexEntry } from "./demo";
import { generateAll, nearestFirst, type EraStatus } from "./orchestrator";
import { bakeDelayMap, Renderer, tintForPosition } from "./renderer";
import { anchor, coverage, hit, loadMask, type Mask } from "./sam";
import type { EraResult, NotesResponse } from "./shared/api";
import { CHRONICLES, DEFAULT_FORK, findEra, isShared, yearsFor } from "./shared/chronicles";
import {
  BIOMES,
  ERA_YEARS,
  blendAt,
  eraCaption,
  formatYear,
  positionToYear,
  relativeDivergence,
  yearToPosition,
  type Biome,
  type Setting,
} from "./shared/eras";
import { loading } from "./loading";
import { getTurnstileToken } from "./turnstile";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const screens = { landing: $("landing"), camera: $("camera"), viewer: $("viewer") };
/** The landing is an overlay: when a scene (usually a demo) is loaded, it plays underneath. */
function show(name: keyof typeof screens): void {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  if (name === "landing" && state.renderer) screens.viewer.hidden = false;
  document.body.classList.toggle("overlay", name === "landing" && Boolean(state.renderer));
  if (name !== "landing") stopAutoplay();
  if (name === "viewer" && !tapHinted) {
    tapHinted = true;
    setTimeout(() => toast("Tap anywhere to see that spot through time."), 2500);
  }
}
let tapHinted = false;

const slider = $<HTMLInputElement>("slider");
const yearEl = $("era-year");
const captionEl = $("era-caption");
const statusEl = $("status");
const hintEl = $("hint");
const biomeSelect = $<HTMLSelectElement>("biome");
const forkSelect = $<HTMLSelectElement>("fork");

/** Live scenes can paint any history; a demo offers only the histories it was pre-generated with. */
function fillForkPicker(available?: string[]): void {
  forkSelect.replaceChildren();
  for (const c of Object.values(CHRONICLES)) {
    if (!available || available.includes(c.forkId)) forkSelect.add(new Option(c.title, c.forkId));
  }
  if (![...forkSelect.options].some((o) => o.value === state.forkId)) state.forkId = DEFAULT_FORK;
  forkSelect.value = state.forkId;
}

type EraState = { status: EraStatus; result?: EraResult; mask?: Mask | null };

const state = {
  forkId: DEFAULT_FORK,
  biome: "temperate" as Biome,
  setting: "outdoor" as Setting,
  turnstileSiteKey: "",
  token: "",
  photo: null as PreparedPhoto | null,
  renderer: null as Renderer | null,
  eras: new Map<number, EraState>(),
  displaySize: { width: 0, height: 0 },
  stream: null as MediaStream | null,
  generation: 0, // bumps on every new scene so stale callbacks are ignored
  demo: null as Demo | null,
  demoIndex: [] as DemoIndexEntry[],
  /** The historian's notes for each history researched so far in this scene. */
  notes: new Map<string, NotesResponse>(),
  /** "Why it changed" lines per history (see storyFor). */
  stories: new Map<string, Promise<Record<string, string[]> | null>>(),
};

// ---------------------------------------------------------------- bootstrap

fillForkPicker();

const configReady = api.config().then((cfg) => {
  state.turnstileSiteKey = cfg.turnstileSiteKey;
  state.biome = cfg.biome;
  biomeSelect.value = cfg.biome;
  if (!cfg.live) toast("Live generation is resting right now. Try again later.", 0);
  return cfg;
});

$("open-camera").addEventListener("click", async () => {
  show("camera");
  try {
    state.stream = await startCamera($<HTMLVideoElement>("video"));
  } catch {
    show("landing");
    $<HTMLInputElement>("file").click();
  }
});

$("camera-cancel").addEventListener("click", () => {
  stopCamera(state.stream);
  show("landing");
});

$("shutter").addEventListener("click", async () => {
  const photo = await prepare($<HTMLVideoElement>("video"));
  stopCamera(state.stream);
  void begin(photo);
});

$<HTMLInputElement>("file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    void begin(await fromFile(file));
  } catch {
    toast("That photo couldn't be read. Try a JPEG or PNG.");
  }
});

/** The scene lives in the URL: reloading or sharing resumes it from storage without new generation. */
function syncUrl(): void {
  if (state.demo) {
    const q = new URLSearchParams({ demo: state.demo.manifest.name });
    if (state.forkId !== DEFAULT_FORK) q.set("f", state.forkId);
    return history.replaceState(null, "", `?${q}`);
  }
  if (!state.token) return;
  const q = new URLSearchParams({ s: state.token, b: state.biome });
  if (state.forkId !== DEFAULT_FORK) q.set("f", state.forkId);
  history.replaceState(null, "", `?${q}`);
}

$("new-place").addEventListener("click", () => {
  closeSheet();
  closeTimeCore();
  history.replaceState(null, "", location.pathname);
  show("landing");
});

$("explore").addEventListener("click", () => {
  show("viewer");
  syncUrl();
});

$("another-place").addEventListener("click", () => {
  const list = state.demoIndex;
  if (!list.length || !state.demo) return;
  const i = list.findIndex((d) => d.name === state.demo!.manifest.name);
  void openDemo(list[(i + 1) % list.length].name, false);
});

async function openDemo(name: string, withLanding: boolean): Promise<void> {
  const demo = await loadDemo(name);
  if (!demo) return;
  const blob = await (await fetch(demo.base + demo.manifest.photo)).blob();
  const photo: PreparedPhoto = { blob, width: demo.manifest.width, height: demo.manifest.height, url: demo.base + demo.manifest.photo };
  const started = begin(photo, { demo });
  // begin() creates the renderer; show the landing over it (or the viewer) once it exists.
  await new Promise((r) => requestAnimationFrame(r));
  show(withLanding ? "landing" : "viewer");
  await started;
  if (withLanding) startAutoplay();
  else syncUrl();
}

// ---------------------------------------------------------------- landing autoplay

let autoplayTimer = 0;
let autoplayOn = false;

/** now → +1M → −1M → now, slowly, while the landing overlay is up. */
function startAutoplay(): void {
  autoplayOn = true;
  const legs = [1, -1, 0];
  let leg = 0;
  const next = () => {
    if (!autoplayOn) return;
    animateTo(legs[leg % legs.length], 3600);
    leg++;
    autoplayTimer = window.setTimeout(next, 3600 + 1400);
  };
  autoplayTimer = window.setTimeout(next, 1500);
}

function stopAutoplay(): void {
  if (!autoplayOn) return;
  autoplayOn = false;
  clearTimeout(autoplayTimer);
  cancelAnimationFrame(anim); // a scrub can be mid-flight when a new scene starts
}

/** Resume a scene from ?s=<token>&b=<biome>&f=<fork> (reloads and share links). */
async function resumeFromUrl(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const token = params.get("s");
  const fork = params.get("f");
  if (fork && CHRONICLES[fork]) {
    state.forkId = fork;
    forkSelect.value = fork;
  }
  state.demoIndex = await loadDemoIndex();
  const demoName = params.get("demo");
  if (!token) {
    // A shared demo link opens straight into it; otherwise a demo plays behind the landing.
    if (demoName) return openDemo(demoName, false);
    const first = state.demoIndex[0];
    if (first) await openDemo(first.name, true);
    return;
  }
  await configReady;
  const biome = params.get("b") as Biome | null;
  if (biome && BIOMES.includes(biome)) {
    state.biome = biome;
    biomeSelect.value = biome;
  }
  const id = token.split(".")[0];
  const res = await fetch(`/api/files/scenes/${id}/photo.jpg`);
  if (!res.ok) return void history.replaceState(null, "", location.pathname);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const photo: PreparedPhoto = { blob, width: bmp.width, height: bmp.height, url: URL.createObjectURL(blob) };
  bmp.close();
  await begin(photo, { token });
}
void resumeFromUrl();

// ---------------------------------------------------------------- a new scene

async function begin(photo: PreparedPhoto, opts: { token?: string; demo?: Demo } = {}): Promise<void> {
  const gen = ++state.generation;
  closeSheet();
  closeTimeCore();
  state.photo = photo;
  state.eras = new Map();
  state.notes = new Map(Object.entries(opts.demo?.manifest.notes ?? {}));
  state.stories = new Map();
  state.token = "";
  state.setting = "outdoor";
  state.demo = opts.demo ?? null;
  slider.value = "0";
  if (!opts.demo) show("viewer");
  // Demo scenes were generated for one biome; live scenes can switch.
  biomeSelect.disabled = Boolean(opts.demo);
  if (opts.demo) {
    state.biome = opts.demo.manifest.biome;
    biomeSelect.value = state.biome;
  }
  $("credit").innerHTML = opts.demo ? opts.demo.manifest.credit : "";
  fillForkPicker(opts.demo ? Object.keys(opts.demo.manifest.forks) : undefined);
  $("another-place").hidden = !opts.demo || state.demoIndex.length < 2;

  // Phones get ≤1280 px textures so ~10 keyframes fit in iOS GPU memory.
  const maxEdge = matchMedia("(pointer: coarse)").matches ? 1280 : 1536;
  const scale = Math.min(1, maxEdge / Math.max(photo.width, photo.height));
  state.displaySize = { width: Math.round(photo.width * scale), height: Math.round(photo.height * scale) };

  state.renderer?.dispose();
  const canvas = $<HTMLCanvasElement>("canvas");
  state.renderer = new Renderer(canvas, photo.width / photo.height);
  state.renderer.setKeyframe(0, await bitmap(photo.blob));
  // In our timeline "now" is the photo; a fork paints its own alternate present.
  state.eras.set(0, { status: state.forkId === DEFAULT_FORK ? "ready" : "pending" });
  renderTicks();
  update();

  if (opts.demo) {
    await applyMasks(gen, photo, demoMaskUrls(opts.demo));
    return loadDemoEras(gen);
  }

  loading.show("Opening a window into this place");
  loading.step("read", "active");
  try {
    status("Opening a window…");
    const cfg = await configReady;
    if (opts.token) {
      state.token = opts.token;
    } else {
      if (!cfg.live) return status("");
      // If Cloudflare wants a click, the widget shows above the loading screen with a word of explanation.
      const token = await getTurnstileToken(state.turnstileSiteKey, $("turnstile"), (visible) =>
        loading.caption(visible ? "One quick check that you're human, then we start." : ""),
      );
      const scene = await api.createScene(photo.blob, photo.width, photo.height, token);
      state.token = scene.token;
    }
    if (gen !== state.generation) return;
    syncUrl();

    status("Reading the scene…");
    // Research runs alongside segmentation: both only need the photo.
    loading.step("research", "active");
    const research = research_(gen, state.forkId);
    const { masks } = await api.masks(state.token);
    if (!(await applyMasks(gen, photo, masks))) return;
    loading.step("read", "done");
    await research;
    // applyMasks sets state.setting; TypeScript still sees the "outdoor" assigned above.
    if ((state.setting as Setting) === "indoor") toast("Works best outdoors: the deep past and far future can't keep a room's shape.");

    await generate(gen);
  } catch (err) {
    if (gen !== state.generation) return;
    loading.hide();
    if (err instanceof HttpError && err.status === 503) toast("Live generation is resting right now. Try again later.", 0);
    else toast("Something went wrong opening this scene. Try another photo.");
    status("");
  }
}

/** Decodes the base masks into the transition delay map and detects indoor scenes. False if superseded. */
async function applyMasks(gen: number, photo: PreparedPhoto, masks: Record<string, string | null>): Promise<boolean> {
  const decoded = Object.fromEntries(
    await Promise.all(Object.entries(masks).map(async ([k, url]) => [k, await loadMask(url)] as const)),
  ) as Record<string, Mask | null>;
  if (gen !== state.generation || !state.renderer) return false;
  // Indoors: a ceiling, or almost no sky.
  state.setting = coverage(decoded.ceiling) > 0.03 || coverage(decoded.sky) < 0.01 ? "indoor" : "outdoor";
  state.renderer.setDelayMap(
    bakeDelayMap(
      photo.width,
      photo.height,
      [
        { mask: decoded.ceiling, delay: 0.1 },
        { mask: decoded.sky, delay: 0 },
        { mask: decoded.tree, delay: 0.3 },
        { mask: decoded.grass, delay: 0.35 },
        { mask: decoded.building, delay: 0.65 },
        { mask: decoded.wall, delay: 0.65 },
        { mask: decoded.floor, delay: 0.85 },
        { mask: decoded.street, delay: 0.85 },
      ],
      [decoded.building, decoded.wall],
    ),
  );
  return true;
}

/** Demo scenes: every era is already a static file, loaded nearest-to-now first. */
function loadDemoEras(gen: number, years: number[] = yearsFor(state.forkId)): void {
  if (!state.demo) return;
  const eras = demoEras(state.demo, state.forkId);
  for (const year of nearestFirst(years)) {
    const result = eras.get(year);
    if (!result) continue;
    state.eras.set(year, { status: "ready", result });
    void loadKeyframe(gen, year, result);
  }
  renderTicks();
}

/** Muse Spark identifies the place and writes what stood here in each era; shown on the loading screen. */
async function research_(gen: number, forkId: string): Promise<void> {
  try {
    // A history's own eras are described by its notes, the eras it shares with ours by our timeline's.
    const [notes] = await Promise.all(
      [forkId, DEFAULT_FORK].filter((f, i) => i === 0 || f !== forkId).map(async (f) => {
        const n = state.notes.get(f) ?? (await api.notes(state.token, f));
        state.notes.set(f, n);
        return n;
      }),
    );
    if (gen !== state.generation) return;
    loading.place(notes.place);
    loading.step("research", "done");
  } catch {
    loading.step("research", "failed", "continuing without it");
  }
}

async function generate(gen: number, years: number[] = yearsFor(state.forkId)): Promise<void> {
  let done = 0;
  const total = years.length;
  loading.step("paint", "active");
  loading.step("check", "active");
  loading.progress(0, total);
  await generateAll(
    state.token,
    { forkId: state.forkId, biome: state.biome, setting: state.setting },
    {
      onStatus: (year, s, result) => {
        if (gen !== state.generation) return;
        const era = state.eras.get(year) ?? { status: s };
        era.status = s;
        state.eras.set(year, era);
        if (s === "loading") {
          const e = findEra(state.forkId, year);
          if (e) {
            status(`Painting ${formatYear(year)} · ${eraCaption(e, state.biome)}`);
            loading.caption(`${formatYear(year)} · ${eraCaption(e, state.biome)}`);
          }
        }
        if (s === "ready" && result) {
          era.result = result;
          done++;
          void loadKeyframe(gen, year, result);
          // The first finished era is enough to start exploring; the rest keep painting behind.
          loading.hide();
        }
        if (s === "failed") done++;
        loading.progress(done, total);
        if (done === total) {
          status("");
          loading.hide();
        }
        renderTicks();
      },
      onResting: () => toast("Live generation is resting right now. Try again later.", 0),
    },
    years,
  );
}

async function loadKeyframe(gen: number, year: number, result: EraResult): Promise<void> {
  const res = await fetch(result.imageUrl);
  const image = await bitmap(await res.blob());
  if (gen !== state.generation || !state.renderer) return;
  state.renderer.setKeyframe(year, image);
  const era = state.eras.get(year);
  if (era) era.mask = await loadMask(result.target?.samUrl ?? null);
  update();
}

function bitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, {
    imageOrientation: "flipY",
    resizeWidth: state.displaySize.width,
    resizeHeight: state.displaySize.height,
    resizeQuality: "high",
  });
}

// ---------------------------------------------------------------- slider & display

function availableYears(): number[] {
  return [...state.eras.entries()]
    .filter(([y, e]) => e.status === "ready" && state.renderer?.hasKeyframe(y))
    .map(([y]) => y)
    .sort((a, b) => a - b);
}

/** The keyframe the viewer is effectively looking at (for captions, hints and taps). */
function settledYear(): number | null {
  const avail = availableYears();
  if (!avail.length) return null;
  const { a, b, t } = blendAt(Number(slider.value), avail);
  if (t < 0.15) return a;
  if (t > 0.85) return b;
  return null;
}

function update(): void {
  const r = state.renderer;
  const avail = availableYears();
  if (!r || !avail.length) return;
  const p = Number(slider.value);
  const { a, b, t } = blendAt(p, avail);
  // Buildings rise through the past and wear away in the far future (+1000 years on).
  r.show(a, b, t, tintForPosition(p), b <= 0 ? 1 : a >= 1000 ? -1 : 0);

  const year = Math.round(positionToYear(p));
  yearEl.textContent = Math.abs(year) < 1 ? "now" : formatYear(roundNicely(year));
  const nearest = [...ERA_YEARS].sort((x, y) => Math.abs(yearToPosition(x) - p) - Math.abs(yearToPosition(y) - p))[0];
  const era = findEra(state.forkId, nearest);
  captionEl.textContent =
    nearest === 0 && state.forkId === DEFAULT_FORK ? "Where you are standing, today." : era ? eraCaption(era, state.biome) : "";
  placeHint();
}

function roundNicely(year: number): number {
  const abs = Math.abs(year);
  const step = abs >= 100_000 ? 10_000 : abs >= 10_000 ? 1_000 : abs >= 1_000 ? 100 : abs >= 100 ? 10 : 1;
  return Math.sign(year) * Math.round(abs / step) * step;
}

function renderTicks(): void {
  const ticks = $("ticks");
  ticks.innerHTML = "";
  const ownNow = state.forkId !== DEFAULT_FORK;
  for (const y of ERA_YEARS) {
    const el = document.createElement("span");
    const s = y === 0 && !ownNow ? "now" : (state.eras.get(y)?.status ?? "pending");
    el.className = `tick ${s}`;
    el.style.left = `${((yearToPosition(y) + 1) / 2) * 100}%`;
    el.title = formatYear(y);
    ticks.append(el);
  }
  // The branch point: where this history splits from ours. Tap it for the chain of events.
  const chronicle = CHRONICLES[state.forkId];
  const div = relativeDivergence(chronicle);
  if (div !== null) {
    const b = document.createElement("button");
    b.className = "branch";
    b.textContent = `splits ${chronicle.divergenceYear! < 0 ? `${-chronicle.divergenceYear!} BCE` : chronicle.divergenceYear}`;
    b.style.left = `${((yearToPosition(div) + 1) / 2) * 100}%`;
    b.addEventListener("click", () => void playFracture(chronicle, b));
    ticks.append(b);
  }
}

slider.addEventListener("input", update);

// Desktop: scroll wheel / trackpad moves through time; arrows jump between keyframes; Home = now.
$("viewer").addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    slider.value = String(Math.max(-1, Math.min(1, Number(slider.value) - e.deltaY * 0.0012)));
    update();
  },
  { passive: false },
);

document.addEventListener("keydown", (e) => {
  if (isTimeCoreOpen()) return; // it has its own keys
  if (screens.viewer.hidden) return;
  const p = Number(slider.value);
  const positions = availableYears().map(yearToPosition);
  if (e.key === "ArrowRight") animateTo(positions.find((x) => x > p + 1e-4) ?? p);
  else if (e.key === "ArrowLeft") animateTo([...positions].reverse().find((x) => x < p - 1e-4) ?? p);
  else if (e.key === "Home") animateTo(0);
  else return;
  e.preventDefault();
});

let anim = 0;
function animateTo(target: number, ms = 700): void {
  cancelAnimationFrame(anim);
  const from = Number(slider.value);
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / ms);
    const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    slider.value = String(from + (target - from) * ease);
    update();
    if (k < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

// ---------------------------------------------------------------- look-around & taps

const canvas = $<HTMLCanvasElement>("canvas");
let drag: { x: number; y: number; lookX: number; lookY: number; moved: boolean } | null = null;
let look = { x: 0, y: 0 };

canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse" && !drag) {
    const rect = canvas.getBoundingClientRect();
    look = { x: ((e.clientX - rect.left) / rect.width) * 2 - 1, y: ((e.clientY - rect.top) / rect.height) * 2 - 1 };
    state.renderer?.setLook(look);
    placeHint();
  } else if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 6) drag.moved = true;
    look = { x: drag.lookX - (dx / canvas.clientWidth) * 3, y: drag.lookY - (dy / canvas.clientHeight) * 3 };
    state.renderer?.setLook(look);
    placeHint();
  }
});

canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, lookX: look.x, lookY: look.y, moved: false };
});

canvas.addEventListener("pointerup", (e) => {
  const wasTap = drag && !drag.moved;
  drag = null;
  if (wasTap) tap(e.clientX, e.clientY);
});

const TAP_SLOP_PX = 22; // creatures can be small, fingers are not, and mouse-look shifts the image a little

/** Only deep-time eras have a tappable subject: their creature. */
const hasSubject = (year: number | null): year is number => year !== null && Boolean(state.eras.get(year)?.mask);

function tap(clientX: number, clientY: number): void {
  const r = state.renderer;
  if (!r || !availableYears().length) return;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const year = settledYear();
  const mask = hasSubject(year) ? state.eras.get(year)!.mask! : null;
  for (let dy = -TAP_SLOP_PX; mask && dy <= TAP_SLOP_PX; dy += TAP_SLOP_PX / 2) {
    for (let dx = -TAP_SLOP_PX; dx <= TAP_SLOP_PX; dx += TAP_SLOP_PX / 2) {
      const { u, v } = r.screenToImage(x + dx, y + dy);
      if (hit(mask, u, v)) return openCreature(year!);
    }
  }
  openSpot(x, y);
}

function openCreature(year: number): void {
  const era = findEra(state.forkId, year);
  if (era?.driver === "biology") showCreature(era.biomes[state.biome].fauna[0], year, state.biome);
}

const PATCH_SIDE = 0.4; // of the image's short side
const CELLS = 3; // the historian labels a 3×3 grid of every image

/** The time core: the tapped patch of the scene, in every era of this history. */
function openSpot(x: number, y: number): void {
  const r = state.renderer;
  const photo = state.photo;
  if (!r || !photo) return;
  const { u, v } = r.screenToImage(x, y);
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  const side = PATCH_SIDE * Math.min(photo.width, photo.height);
  const hw = side / photo.width / 2;
  const hh = side / photo.height / 2;
  const cu = Math.min(1 - hw, Math.max(hw, u));
  const cv = Math.min(1 - hh, Math.max(hh, v));
  const patch = { u0: cu - hw, v0: cv - hh, u1: cu + hw, v1: cv + hh };
  const cell = Math.min(CELLS - 1, Math.floor(v * CELLS)) * CELLS + Math.min(CELLS - 1, Math.floor(u * CELLS));

  const years = availableYears();
  const slices = years.map((year) => sliceFor(year, cell)).filter((s): s is Slice => s !== null);
  if (!slices.length) return;
  const p = Number(slider.value);
  const current = slices.reduce(
    (best, s, i) => (Math.abs(yearToPosition(s.year) - p) < Math.abs(yearToPosition(slices[best].year) - p) ? i : best),
    0,
  );
  const rect = canvas.getBoundingClientRect();
  const p1 = r.imageToScreen(patch.u0, patch.v0);
  const p2 = r.imageToScreen(patch.u1, patch.v1);
  const forkId = state.forkId;
  const notes = state.notes.get(forkId) ?? state.notes.get(DEFAULT_FORK);
  stopAutoplay();
  void openTimeCore({
    slices,
    current,
    patch,
    aspect: (hw * photo.width) / (hh * photo.height),
    from: { left: rect.left + p1.x, top: rect.top + p1.y, width: p2.x - p1.x, height: p2.y - p1.y },
    history: forkId === DEFAULT_FORK ? "Our history" : CHRONICLES[forkId].title,
    place: notes?.town || "This place",
    otherHistory: forkId === DEFAULT_FORK ? undefined : "our history",
    enrich: enrich(slices, cell, forkId),
    // The scene behind pushes back a little while the spot is lifted out of it.
    onStage: (on) => state.renderer?.setZoomBoost(on ? 1.12 : 1),
    onTravel: (year) => animateTo(yearToPosition(year), 1600),
  });
}

/** "Why it changed here" lines for a history: from the demo's files, or written once by Muse Spark and cached. */
function storyFor(forkId: string): Promise<Record<string, string[]> | null> {
  let story = state.stories.get(forkId);
  if (!story) {
    story = state.demo
      ? Promise.resolve(state.demo.manifest.story?.[forkId] ?? null)
      : api.story(state.token, { forkId, biome: state.biome, setting: state.setting }).then((r) => r.story, () => null);
    state.stories.set(forkId, story);
  }
  return story;
}

/** Adds each slice's "why" line and, in an alternate history, the same spot and era in ours. */
async function enrich(slices: Slice[], cell: number, forkId: string): Promise<Slice[]> {
  const gen = state.generation;
  const [story, ourStory] = await Promise.all([storyFor(forkId), forkId === DEFAULT_FORK ? null : storyFor(DEFAULT_FORK)]);
  const ours = forkId === DEFAULT_FORK ? [] : await Promise.all(slices.map((s) => ourSide(s.year, cell, ourStory)));
  if (gen !== state.generation) return slices;
  return slices.map((s, i) => ({ ...s, why: story?.[String(s.year)]?.[cell] ?? null, other: ours[i] ?? null }));
}

/** Our history's view of a spot in an era a fork changed; null where the two histories agree. */
async function ourSide(year: number, cell: number, story: Record<string, string[]> | null): Promise<Side | null> {
  if (isShared(state.forkId, year)) return null;
  const notes = state.notes.get(DEFAULT_FORK);
  const why = story?.[String(year)]?.[cell] ?? null;
  const note = notes?.eras[String(year)] ?? "";
  const era = findEra(DEFAULT_FORK, year);
  const caption = era ? eraCaption(era, state.biome).replace(/^[\d,]+( BCE| CE)? · /, "") : "";
  if (year === 0) {
    const url = state.photo?.url;
    return url ? { imageUrl: url, label: notes?.cells?.[cell] ?? null, why, caption: "where you are standing", note } : null;
  }
  const result = state.demo
    ? demoEras(state.demo, DEFAULT_FORK).get(year)
    : await api.getEra(state.token, year, { forkId: DEFAULT_FORK, biome: state.biome, setting: state.setting }).catch(() => undefined);
  return result ? { imageUrl: result.imageUrl, label: result.cells?.[cell] ?? null, why, caption, note } : null;
}

function sliceFor(year: number, cell: number): Slice | null {
  const era = state.eras.get(year);
  const ownNow = year === 0 && state.forkId === DEFAULT_FORK; // the photo itself
  const imageUrl = ownNow ? state.photo?.url : era?.result?.imageUrl;
  if (!imageUrl) return null;
  const notes = state.notes.get(isShared(state.forkId, year) ? DEFAULT_FORK : state.forkId);
  const cells = ownNow ? notes?.cells : era?.result?.cells;
  const chronicleEra = findEra(state.forkId, year);
  // Captions lead with their year ("1526 · …"); the time core shows the year on its own.
  const caption = ownNow ? "where you are standing" : chronicleEra ? eraCaption(chronicleEra, state.biome).replace(/^[\d,]+( BCE| CE)? · /, "") : "";
  return { year, imageUrl, label: cells?.[cell] ?? null, why: null, caption, note: notes?.eras[String(year)] ?? "" };
}

hintEl.addEventListener("click", () => {
  const year = settledYear();
  if (hasSubject(year)) openCreature(year);
});

function placeHint(): void {
  const r = state.renderer;
  const year = settledYear();
  const mask = hasSubject(year) ? state.eras.get(year)?.mask : null;
  const pt = mask && anchor(mask);
  if (!r || !pt) {
    hintEl.hidden = true;
    return;
  }
  const { x, y } = r.imageToScreen(pt.u, pt.v);
  hintEl.style.left = `${x}px`;
  hintEl.style.top = `${y}px`;
  hintEl.hidden = false;
}

// Phones: gyro look-around, asked for only when the visitor taps the chip (iOS needs a user gesture).
const tiltBtn = $("tilt");
if ("DeviceOrientationEvent" in window && matchMedia("(pointer: coarse)").matches) tiltBtn.hidden = false;
tiltBtn.addEventListener("click", async () => {
  const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof DOE.requestPermission === "function" && (await DOE.requestPermission().catch(() => "denied")) !== "granted") {
    toast("Motion access was denied. You can still drag to look around.");
    return;
  }
  let base: { beta: number; gamma: number } | null = null;
  window.addEventListener("deviceorientation", (e) => {
    if (e.beta === null || e.gamma === null) return;
    base ??= { beta: e.beta, gamma: e.gamma };
    look = { x: (e.gamma - base.gamma) / 20, y: (e.beta - base.beta) / 20 };
    state.renderer?.setLook(look);
    placeHint();
  });
  tiltBtn.hidden = true;
});

// ---------------------------------------------------------------- biome

biomeSelect.addEventListener("change", () => {
  const biome = biomeSelect.value as Biome;
  if (!BIOMES.includes(biome) || biome === state.biome || state.demo) return;
  state.biome = biome;
  update();
  if (!state.token) return;
  syncUrl();
  // Only biology eras depend on the biome; culture eras are kept.
  const chronicle = CHRONICLES[state.forkId];
  const biologyYears = chronicle.eras.filter((e) => e.driver === "biology").map((e) => e.year);
  for (const y of biologyYears) state.eras.delete(y);
  renderTicks();
  update();
  void generate(state.generation, biologyYears);
});

// ---------------------------------------------------------------- history (forks)

forkSelect.addEventListener("change", async () => {
  stopAutoplay();
  const forkId = forkSelect.value;
  if (!CHRONICLES[forkId] || forkId === state.forkId) return;
  const previous = state.forkId;
  state.forkId = forkId;
  closeSheet();
  syncUrl();
  // Keep shared keyframes (deep time, and anything before both divergences); repaint the rest.
  for (const y of [...state.eras.keys()]) {
    if (!isShared(previous, y) || !isShared(forkId, y)) state.eras.delete(y);
  }
  if (forkId === DEFAULT_FORK && state.photo && state.renderer) {
    state.renderer.setKeyframe(0, await bitmap(state.photo.blob));
    state.eras.set(0, { status: "ready" });
  }
  renderTicks();
  update();
  const gen = state.generation;
  const missing = yearsFor(forkId).filter((y) => state.eras.get(y)?.status !== "ready");
  // Start painting this world straight away (demo files load instantly); the cinematic covers the wait.
  let painting: Promise<void> = Promise.resolve();
  if (state.demo) loadDemoEras(gen, missing);
  else if (state.token) painting = research_(gen, forkId).then(() => generate(gen, missing));

  const chronicle = CHRONICLES[forkId];
  const div = relativeDivergence(chronicle);
  if (div === null) return void animateTo(0, 1200);
  // Rewind through the real eras to the moment the worlds split…
  animateTo(yearToPosition(div), 1400);
  await new Promise((r) => setTimeout(r, 1450));
  if (gen !== state.generation) return;
  // …watch history fracture and the chain of events play out…
  await playFracture(chronicle, document.querySelector<HTMLElement>(".branch"));
  if (gen !== state.generation) return;
  // …then fast-forward through the new world to its present.
  const stillPainting = yearsFor(forkId).some((y) => state.eras.get(y)?.status !== "ready");
  if (stillPainting && !state.demo) {
    loading.show(`Painting a world where ${chronicle.title.charAt(0).toLowerCase()}${chronicle.title.slice(1)}`);
    loading.step("read", "done");
    loading.step("research", "done");
    loading.step("paint", "active");
    loading.step("check", "active");
    // Fast-forward as soon as the first era of this world is in (the loading screen clears itself then).
    await Promise.race([
      painting,
      new Promise<void>((r) => {
        const check = setInterval(() => !loading.visible && (clearInterval(check), r()), 400);
      }),
    ]);
  }
  animateTo(0, 2800);
});

// ---------------------------------------------------------------- messages

function status(text: string): void {
  statusEl.textContent = text;
}

let toastTimer = 0;
function toast(text: string, ms = 5000): void {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = window.setTimeout(() => (el.hidden = true), ms);
}
