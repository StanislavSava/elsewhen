import { api, HttpError } from "./api";
import { fromFile, prepare, startCamera, stopCamera, type PreparedPhoto } from "./capture";
import { closeSheet, showChain, showCreature, showFossil } from "./card";
import { generateAll, type EraStatus } from "./orchestrator";
import { bakeDelayMap, Renderer, tintForPosition } from "./renderer";
import { anchor, coverage, hit, loadMask, type Mask } from "./sam";
import type { EraResult } from "./shared/api";
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
import { getTurnstileToken } from "./turnstile";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const screens = { landing: $("landing"), camera: $("camera"), viewer: $("viewer") };
function show(name: keyof typeof screens): void {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
}

const slider = $<HTMLInputElement>("slider");
const yearEl = $("era-year");
const captionEl = $("era-caption");
const statusEl = $("status");
const hintEl = $("hint");
const biomeSelect = $<HTMLSelectElement>("biome");
const forkSelect = $<HTMLSelectElement>("fork");
for (const c of Object.values(CHRONICLES)) forkSelect.add(new Option(c.title, c.forkId));

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
};

// ---------------------------------------------------------------- bootstrap

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
  if (!state.token) return;
  const q = new URLSearchParams({ s: state.token, b: state.biome });
  if (state.forkId !== DEFAULT_FORK) q.set("f", state.forkId);
  history.replaceState(null, "", `?${q}`);
}

$("new-place").addEventListener("click", () => {
  closeSheet();
  history.replaceState(null, "", location.pathname);
  show("landing");
});

/** Resume a scene from ?s=<token>&b=<biome>&f=<fork> (reloads and share links). */
async function resumeFromUrl(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const token = params.get("s");
  if (!token) return;
  await configReady;
  const fork = params.get("f");
  if (fork && CHRONICLES[fork]) {
    state.forkId = fork;
    forkSelect.value = fork;
  }
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
  await begin(photo, token);
}
void resumeFromUrl();

// ---------------------------------------------------------------- a new scene

async function begin(photo: PreparedPhoto, existingToken?: string): Promise<void> {
  const gen = ++state.generation;
  closeSheet();
  state.photo = photo;
  state.eras = new Map();
  state.token = "";
  state.setting = "outdoor";
  slider.value = "0";
  show("viewer");

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

  try {
    status("Opening a window…");
    const cfg = await configReady;
    if (existingToken) {
      state.token = existingToken;
    } else {
      if (!cfg.live) return status("");
      const token = await getTurnstileToken(state.turnstileSiteKey, $("turnstile"));
      const scene = await api.createScene(photo.blob, photo.width, photo.height, token);
      state.token = scene.token;
    }
    if (gen !== state.generation) return;
    syncUrl();

    status("Reading the scene…");
    const { masks } = await api.masks(state.token);
    const decoded = Object.fromEntries(
      await Promise.all(Object.entries(masks).map(async ([k, url]) => [k, await loadMask(url)] as const)),
    ) as Record<string, Mask | null>;
    if (gen !== state.generation) return;

    // Indoors: a ceiling, or almost no sky.
    state.setting = coverage(decoded.ceiling) > 0.03 || coverage(decoded.sky) < 0.01 ? "indoor" : "outdoor";
    if (state.setting === "indoor") toast("Works best outdoors: the deep past and far future can't keep a room's shape.");

    state.renderer.setDelayMap(
      bakeDelayMap(photo.width, photo.height, [
        { mask: decoded.ceiling, delay: 0.1 },
        { mask: decoded.sky, delay: 0 },
        { mask: decoded.tree, delay: 0.3 },
        { mask: decoded.grass, delay: 0.35 },
        { mask: decoded.building, delay: 0.65 },
        { mask: decoded.wall, delay: 0.65 },
        { mask: decoded.floor, delay: 0.85 },
        { mask: decoded.street, delay: 0.85 },
      ]),
    );

    await generate(gen);
  } catch (err) {
    if (gen !== state.generation) return;
    if (err instanceof HttpError && err.status === 503) toast("Live generation is resting right now. Try again later.", 0);
    else toast("Something went wrong opening this scene. Try another photo.");
    status("");
  }
}

async function generate(gen: number, years: number[] = yearsFor(state.forkId)): Promise<void> {
  let done = 0;
  const total = years.length;
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
          if (e) status(`Painting ${formatYear(year)} · ${eraCaption(e, state.biome)}`);
        }
        if (s === "ready" && result) {
          era.result = result;
          done++;
          void loadKeyframe(gen, year, result);
        }
        if (s === "failed") done++;
        if (done === total) status("");
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
  r.show(a, b, t, tintForPosition(p));

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
    b.addEventListener("click", () => showChain(chronicle));
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
function animateTo(target: number): void {
  cancelAnimationFrame(anim);
  const from = Number(slider.value);
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / 700);
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

/** Our timeline's "now" is the plain photo; every other keyframe can have a tappable subject. */
const hasSubject = (year: number | null): year is number => year !== null && (year !== 0 || state.forkId !== DEFAULT_FORK);

function tap(clientX: number, clientY: number): void {
  const r = state.renderer;
  const year = settledYear();
  if (!r || !hasSubject(year)) return;
  const mask = state.eras.get(year)?.mask;
  if (!mask) return;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let inside = false;
  for (let dy = -TAP_SLOP_PX; dy <= TAP_SLOP_PX && !inside; dy += TAP_SLOP_PX / 2) {
    for (let dx = -TAP_SLOP_PX; dx <= TAP_SLOP_PX && !inside; dx += TAP_SLOP_PX / 2) {
      const { u, v } = r.screenToImage(x + dx, y + dy);
      inside = hit(mask, u, v);
    }
  }
  if (inside) openSubject(year);
}

function openSubject(year: number): void {
  const era = state.eras.get(year);
  const chronicleEra = findEra(state.forkId, year);
  if (!chronicleEra) return;
  if (chronicleEra.driver === "biology") showCreature(chronicleEra.biomes[state.biome].fauna[0], year, state.biome);
  else if (chronicleEra.fossil) showFossil(chronicleEra.fossil, era?.result?.fossilUrl ?? null, year);
}

hintEl.addEventListener("click", () => {
  const year = settledYear();
  if (hasSubject(year)) openSubject(year);
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
  if (!BIOMES.includes(biome) || biome === state.biome) return;
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
  if (!state.token) return;
  const missing = yearsFor(forkId).filter((y) => state.eras.get(y)?.status !== "ready");
  if (forkId !== DEFAULT_FORK && CHRONICLES[forkId].divergenceYear !== null) showChain(CHRONICLES[forkId]);
  void generate(state.generation, missing);
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
