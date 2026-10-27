// The time core: tap any spot of the scene and that patch lifts out of the photo and bursts straight away into
// the same patch in every era, laid out along a golden time thread (left to right, or bottom to top on phones).
// The camera never moved between eras, so the patches line up exactly: one spot, seen through all of time.
// Turn the stack by dragging, step through time with the wheel, arrow keys or a click; "Go there" jumps the
// scene to that era. Closing folds every era back into the patch and the patch back into the scene.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CURRENT_YEAR } from "./shared/eras";

export type ScreenRect = { left: number; top: number; width: number; height: number };
/** Image-space rectangle, 0..1 with v down. */
export type Patch = { u0: number; v0: number; u1: number; v1: number };

export type Slice = {
  year: number;
  imageUrl: string;
  /** What is at this spot in this era, e.g. "timber granary with thatched roof". */
  label: string | null;
  caption: string;
  note: string;
};

const FOV = 35;
const LIFT_MS = 420;
const BURST_MS = 1250;
const FOLD_MS = 650;
const TURN = 0.95; // how far side slices turn toward the centre (radians)
const ACCENT = new THREE.Color("#e7c76a");

let open: { close: () => Promise<void> } | null = null;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** "1526", "26 CE", "Now", "10k years ago": calendar years where they mean something, else distance. */
export function sliceYear(year: number): string {
  if (year === 0) return "Now";
  if (Math.abs(year) >= 10_000) {
    const abs = Math.abs(year);
    const n = abs >= 1_000_000 ? `${abs / 1_000_000}M` : `${abs / 1_000}k`;
    return year < 0 ? `${n} years ago` : `In ${n} years`;
  }
  const cal = CURRENT_YEAR + year;
  return cal <= 0 ? `${1 - cal} BCE` : cal < 1000 ? `${cal} CE` : String(cal);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function crop(img: HTMLImageElement, p: Patch): HTMLCanvasElement {
  const sx = p.u0 * img.naturalWidth;
  const sy = p.v0 * img.naturalHeight;
  const sw = (p.u1 - p.u0) * img.naturalWidth;
  const sh = (p.v1 - p.v0) * img.naturalHeight;
  const scale = Math.min(1, 640 / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  c.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

type Card = {
  slice: Slice;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  chip: HTMLElement;
  /** Burst flight: from the patch to its place on the thread. */
  from: { pos: THREE.Vector3; rot: THREE.Euler; scale: number };
  to: { pos: THREE.Vector3; rot: THREE.Euler; scale: number };
  delay: number; // ms after the burst starts
  spin: number;
};

export async function openTimeCore(opts: {
  slices: Slice[]; // chronological
  current: number; // index of the era on screen when tapped
  patch: Patch;
  /** The patch's width / height in pixels. */
  aspect: number;
  from: ScreenRect; // where the patch sits on screen
  onStage?: (on: boolean) => void;
  onTravel?: (year: number) => void;
}): Promise<void> {
  await open?.close();
  // The era on screen is lifted out at once; the others stream in while it rises.
  const crops = opts.slices.map((s) => loadImage(s.imageUrl).then((img) => crop(img, opts.patch)));
  const first = await crops[opts.current].catch(() => null);
  if (!first) return;
  const items = opts.slices.map((s) => ({ s }));
  let focus = opts.current;
  const startIndex = focus;
  const aspect = opts.aspect;

  // ---------------------------------------------------------------- DOM shell
  const root = document.createElement("div");
  root.className = "tc";
  root.innerHTML = `
    <div class="tc-backdrop"></div>
    <canvas class="tc-gl"></canvas>
    <div class="tc-chips"></div>
    <section class="tc-info" aria-live="polite">
      <div class="tc-kicker"></div>
      <h2 class="tc-label"></h2>
      <p class="tc-note"></p>
      <div class="tc-actions">
        <button class="tc-prev" aria-label="Earlier">‹</button>
        <button class="tc-go">Go there</button>
        <button class="tc-next" aria-label="Later">›</button>
      </div>
    </section>
    <p class="tc-hint">This spot through time · drag to turn · scroll or ← → to travel</p>
    <button class="tc-close" aria-label="Put it back">×</button>`;
  document.body.append(root);
  const backdrop = root.querySelector<HTMLElement>(".tc-backdrop")!;
  const glCanvas = root.querySelector<HTMLCanvasElement>(".tc-gl")!;
  const chipsEl = root.querySelector<HTMLElement>(".tc-chips")!;
  const info = root.querySelector<HTMLElement>(".tc-info")!;
  backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, fill: "forwards" });
  opts.onStage?.(true);

  // ---------------------------------------------------------------- three.js
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.1, 200);
  const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

  // Layout: along x on landscape screens, along y (past below) on portrait ones. A slice is 2 units tall.
  const vertical = innerWidth < innerHeight * 0.9;
  const W = 2 * aspect;
  const H = 2;
  const along = vertical ? H : W; // slice size along the thread
  const pitch = along * (vertical ? 0.2 : 0.26); // between side slices
  const gap = along * (vertical ? 0.56 : 0.62); // between the focused slice and its neighbours
  const FOCUS_SCALE = 1.22;

  // World units → px at z = 0, chosen so the longest possible strip fits beside the info panel.
  const n = items.length;
  const span = (n - 1) * pitch + 2 * gap + along * 0.6;
  const infoRoom = vertical ? 210 : 190;
  const unit = Math.min(
    vertical ? (innerHeight - 70 - infoRoom) / span : (innerWidth - 48) / span,
    vertical ? (innerWidth * 0.7) / (W * FOCUS_SCALE) : (innerHeight - 90 - infoRoom) / (H * FOCUS_SCALE),
  );
  const dist = innerHeight / (2 * tan * unit);
  // The strip's centre (world origin) sits in the free area above the info panel.
  const centrePx = vertical ? 56 + (innerHeight - 56 - infoRoom) / 2 : 40 + (innerHeight - 40 - infoRoom) / 2;
  const home = new THREE.Vector3(0, 0, dist);
  const target = new THREE.Vector3();
  camera.position.copy(home);
  camera.setViewOffset(innerWidth, innerHeight, 0, innerHeight / 2 - centrePx, innerWidth, innerHeight);

  const group = new THREE.Group();
  scene.add(group);

  /** Screen rect → the pose of a slice exactly covering it at z = 0. */
  const fromScreen = (r: ScreenRect) => ({
    pos: new THREE.Vector3((r.left + r.width / 2 - innerWidth / 2) / unit, -(r.top + r.height / 2 - centrePx) / unit, 0),
    rot: new THREE.Euler(),
    scale: r.height / unit / H,
  });

  /** Where each slice rests for a given focus. Centred as a whole, so the strip never leaves the screen. */
  const layout = (f: number) => {
    const offs = items.map((_, i) => {
      const k = i - f;
      return k === 0 ? 0 : Math.sign(k) * (gap + (Math.abs(k) - 1) * pitch);
    });
    const mid = (offs[0] + offs[n - 1]) / 2;
    return items.map((_, i) => {
      const k = i - f;
      const o = offs[i] - mid;
      const pos = vertical ? new THREE.Vector3(0, o, 0) : new THREE.Vector3(o, 0, 0);
      pos.z = k === 0 ? 0.6 : -0.15 * Math.min(4, Math.abs(k));
      const turn = k === 0 ? 0 : Math.sign(k) * TURN;
      const rot = vertical ? new THREE.Euler(turn, 0, 0) : new THREE.Euler(0, -turn, 0);
      return { pos, rot, scale: k === 0 ? FOCUS_SCALE : 1 };
    });
  };

  const origin = fromScreen(opts.from);
  const failed: boolean[] = [];
  let rest = layout(focus);
  const cards: Card[] = items.map(({ s }, i) => {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, color: 0x000000 });
    const setImage = (canvas: HTMLCanvasElement) => {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.needsUpdate = true;
    };
    if (i === startIndex) setImage(first);
    else crops[i].then(setImage, () => (mesh.visible = false, (failed[i] = true)));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
    // Slices start stacked behind the tapped one, hidden until the burst.
    mesh.position.copy(origin.pos).setZ(-0.01 * Math.abs(i - startIndex));
    mesh.scale.setScalar(origin.scale);
    mesh.visible = i === startIndex;
    mat.color.setScalar(i === startIndex ? 1 : 0.5);
    group.add(mesh);
    const chip = document.createElement("div");
    chip.className = "tc-chip";
    chip.textContent = sliceYear(s.year);
    chipsEl.append(chip);
    const d = Math.abs(i - startIndex);
    return {
      slice: s,
      mesh,
      mat,
      chip,
      from: { pos: mesh.position.clone(), rot: new THREE.Euler(), scale: origin.scale },
      to: rest[i],
      delay: d * 55,
      spin: (i % 2 ? 1 : -1) * (0.35 + Math.random() * 0.4),
    };
  });

  // A soft golden glow behind the tapped patch while it lifts.
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 2.2, H * 2.2),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader:
        "varying vec2 vUv; uniform float uOpacity; void main(){ float d = length(vUv - 0.5) * 2.0; gl_FragColor = vec4(1.0, 0.86, 0.5, uOpacity * smoothstep(1.0, 0.0, d) * 0.9); }",
    }),
  );
  glow.position.copy(origin.pos).setZ(-0.2);
  glow.scale.setScalar(origin.scale);
  group.add(glow);

  // The time thread: a golden line through every slice, in time order.
  const threadGeo = new THREE.BufferGeometry();
  const thread = new THREE.Line(threadGeo, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0 }));
  group.add(thread);
  const knots = new THREE.Points(threadGeo, new THREE.PointsMaterial({ color: ACCENT, size: 0.09, transparent: true, opacity: 0 }));
  group.add(knots);
  /** Each slice's knot on the thread: below it, or left of it on phones. */
  const knotOf = (c: Card) =>
    new THREE.Vector3(vertical ? -W / 2 - 0.12 : 0, vertical ? 0 : -H / 2 - 0.14, 0).applyMatrix4(c.mesh.matrixWorld);

  const controls = new OrbitControls(camera, glCanvas);
  controls.target.copy(target);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.enableZoom = false; // the wheel travels through time instead
  controls.minPolarAngle = Math.PI * 0.3;
  controls.maxPolarAngle = Math.PI * 0.7;
  controls.minAzimuthAngle = -Math.PI * 0.3;
  controls.maxAzimuthAngle = Math.PI * 0.3;
  let steered = false;
  controls.addEventListener("start", () => (steered = true));

  // ---------------------------------------------------------------- info, focus, hover
  let hovered: number | null = null;
  const showInfo = () => {
    const s = cards[focus].slice;
    root.querySelector(".tc-kicker")!.textContent = s.label ? `${sliceYear(s.year)} · ${s.caption}` : sliceYear(s.year);
    const label = s.label ?? s.caption;
    root.querySelector(".tc-label")!.textContent = label.charAt(0).toUpperCase() + label.slice(1);
    root.querySelector(".tc-note")!.textContent = s.note;
    root.querySelector<HTMLButtonElement>(".tc-go")!.textContent = focus === startIndex ? "Back to the scene" : `Go to ${sliceYear(s.year)}`;
    root.querySelector<HTMLButtonElement>(".tc-prev")!.disabled = focus === 0;
    root.querySelector<HTMLButtonElement>(".tc-next")!.disabled = focus === n - 1;
    info.classList.remove("tc-info-in");
    void info.offsetWidth;
    info.classList.add("tc-info-in");
  };
  const setFocus = (f: number) => {
    f = Math.max(0, Math.min(n - 1, f));
    if (f === focus) return;
    focus = f;
    rest = layout(focus);
    showInfo();
  };
  root.querySelector(".tc-prev")!.addEventListener("click", () => setFocus(focus - 1));
  root.querySelector(".tc-next")!.addEventListener("click", () => setFocus(focus + 1));
  root.querySelector(".tc-go")!.addEventListener("click", () => {
    const year = cards[focus].slice.year;
    void close().then(() => opts.onTravel?.(year));
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pick = (e: PointerEvent) => {
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(cards.map((c) => c.mesh))[0];
    return hit ? cards.findIndex((c) => c.mesh === hit.object) : null;
  };
  let down: { x: number; y: number } | null = null;
  glCanvas.addEventListener("pointermove", (e) => {
    hovered = pick(e);
    glCanvas.style.cursor = hovered !== null ? "pointer" : "grab";
  });
  glCanvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  glCanvas.addEventListener("pointerup", (e) => {
    const click = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6;
    down = null;
    if (!click || phase !== "live") return;
    const i = pick(e);
    if (i === null) void close();
    else setFocus(i);
  });
  let wheelAcc = 0;
  glCanvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      wheelAcc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (Math.abs(wheelAcc) > 60) {
        setFocus(focus + Math.sign(wheelAcc));
        wheelAcc = 0;
      }
    },
    { passive: false },
  );

  const onResize = () => void close();
  addEventListener("resize", onResize);

  // ---------------------------------------------------------------- burst effects
  let ring: THREE.Mesh | null = null;
  let sparks: THREE.Points | null = null;
  let sparkVel: Float32Array | null = null;
  function startBurst(at: THREE.Vector3, scale: number, source: HTMLCanvasElement): void {
    ring = new THREE.Mesh(
      new THREE.RingGeometry(0.95, 1, 128),
      new THREE.MeshBasicMaterial({ color: 0xfff2c4, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    ring.position.copy(at).setZ(at.z + 0.05);
    group.add(ring);
    const sample = document.createElement("canvas");
    sample.width = 32;
    sample.height = 32;
    const sctx = sample.getContext("2d")!;
    sctx.drawImage(source, 0, 0, 32, 32);
    const px = sctx.getImageData(0, 0, 32, 32).data;
    const count = 420;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    sparkVel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = Math.random();
      const v = Math.random();
      const x = (u - 0.5) * W * scale;
      const y = (0.5 - v) * H * scale;
      positions.set([at.x + x, at.y + y, at.z + 0.03], i * 3);
      const p = (Math.floor(v * 31) * 32 + Math.floor(u * 31)) * 4;
      // Mostly the patch's own colours, some golden embers.
      const gold = Math.random() < 0.3;
      colors.set(gold ? [1, 0.85, 0.5] : [px[p] / 255, px[p + 1] / 255, px[p + 2] / 255], i * 3);
      const len = Math.hypot(x, y) || 1;
      const speed = 1.5 + Math.random() * 4;
      sparkVel.set([(x / len) * speed + (Math.random() - 0.5), (y / len) * speed + (Math.random() - 0.3), Math.random() * 3], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    sparks = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.05, vertexColors: true, transparent: true, depthWrite: false }));
    group.add(sparks);
  }

  // ---------------------------------------------------------------- frame loop
  let phase: "lift" | "burst" | "live" | "closing" = "lift";
  let phaseStart = performance.now();
  let burstAt = -1;
  let raf = 0;
  const v = new THREE.Vector3();

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const t = now - phaseStart;
    const lifted = cards[startIndex];

    if (phase === "lift") {
      // The patch comes off the scene toward you, glowing, with a last shiver before it bursts.
      const k = easeInOut(clamp01(t / LIFT_MS));
      lifted.mesh.position.copy(origin.pos).setZ(0.5 * k);
      lifted.mesh.scale.setScalar(origin.scale * (1 + 0.08 * k));
      lifted.mesh.rotation.z = k > 0.6 ? Math.sin(t * 0.12) * 0.02 * k : 0;
      (glow.material as THREE.ShaderMaterial).uniforms.uOpacity.value = k;
      if (t >= LIFT_MS) {
        phase = "burst";
        phaseStart = now;
        burstAt = now;
        for (const [i, c] of cards.entries()) {
          c.mesh.visible = !failed[i];
          c.from.pos.copy(c === lifted ? lifted.mesh.position : c.from.pos);
          c.from.scale = c === lifted ? lifted.mesh.scale.x : c.from.scale;
          c.to = rest[cards.indexOf(c)];
        }
        startBurst(lifted.mesh.position, lifted.mesh.scale.x, first);
        showInfo();
        root.classList.add("tc-open");
      }
    } else if (phase === "burst") {
      // Every era springs out of the patch to its place on the thread, tumbling and settling.
      let doneAll = true;
      cards.forEach((c, i) => {
        const local = clamp01((t - c.delay) / (BURST_MS - 300));
        if (local < 1) doneAll = false;
        const e = easeOutBack(local);
        c.mesh.position.lerpVectors(c.from.pos, rest[i].pos, e);
        c.mesh.scale.setScalar(c.from.scale + (rest[i].scale - c.from.scale) * e);
        c.mesh.rotation.set(rest[i].rot.x * e, rest[i].rot.y * e, c.spin * (1 - clamp01(e)));
        c.mat.opacity = i === startIndex ? 1 : clamp01(local * 3);
      });
      (glow.material as THREE.ShaderMaterial).uniforms.uOpacity.value = Math.max(0, 1 - t / 500);
      if (doneAll && t > BURST_MS) {
        phase = "live";
        controls.enabled = true;
      }
    } else if (phase === "live") {
      // Ease toward the layout for the current focus.
      cards.forEach((c, i) => {
        c.mesh.position.lerp(rest[i].pos, 0.14);
        c.mesh.scale.lerp(v.setScalar(rest[i].scale * (hovered === i && i !== focus ? 1.04 : 1)), 0.14);
        c.mesh.rotation.x += (rest[i].rot.x - c.mesh.rotation.x) * 0.14;
        c.mesh.rotation.y += (rest[i].rot.y - c.mesh.rotation.y) * 0.14;
        c.mesh.rotation.z *= 0.86;
      });
      // A slow sway until someone takes the wheel.
      if (!steered) {
        const s = now / 1000;
        camera.position.set(home.x + Math.sin(s * 0.5) * dist * 0.08, home.y + Math.sin(s * 0.37) * dist * 0.03, home.z);
        camera.lookAt(target);
      }
    }

    // Brightness: the focused era in full, the rest dimmed, the hovered one in between.
    if (phase !== "lift") {
      cards.forEach((c, i) => {
        const b = i === focus ? 1 : hovered === i ? 0.85 : 0.5;
        c.mat.color.setScalar(c.mat.color.r + (b - c.mat.color.r) * 0.15);
      });
    }

    if (burstAt >= 0) {
      const bt = (now - burstAt) / 1000;
      if (ring) {
        ring.scale.setScalar(0.3 + bt * 7);
        (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - bt * 1.1);
      }
      if (sparks && sparkVel) {
        const pos = sparks.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(i, pos.getX(i) + sparkVel[i * 3] * 0.016, pos.getY(i) + sparkVel[i * 3 + 1] * 0.016 - bt * 0.005, pos.getZ(i) + sparkVel[i * 3 + 2] * 0.016);
          sparkVel[i * 3] *= 0.965;
          sparkVel[i * 3 + 1] *= 0.965;
          sparkVel[i * 3 + 2] *= 0.965;
        }
        pos.needsUpdate = true;
        (sparks.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - bt / 1.7);
      }
      if (bt > 2) burstAt = -1;
    }

    controls.update();
    group.updateMatrixWorld();

    // The thread and the year chips follow the slices.
    const threadOn = phase === "live" || phase === "burst" ? clamp01(phase === "burst" ? (t - 500) / 600 : 1) : 0;
    const pts: number[] = [];
    cards.forEach((c, i) => {
      const k = knotOf(c);
      pts.push(k.x, k.y, k.z);
      const p = k.clone().project(camera);
      const x = (p.x * 0.5 + 0.5) * innerWidth;
      const y = (-p.y * 0.5 + 0.5) * innerHeight;
      c.chip.style.transform = `translate(${x}px, ${y}px) translate(${vertical ? "-100%" : "-50%"}, ${vertical ? "-50%" : "4px"})`;
      // Named: the focus, the one under the pointer and where you came from; the knots mark the rest.
      const named = i === hovered || i === startIndex;
      c.chip.style.opacity = String(failed[i] ? 0 : threadOn * (i === focus ? 1 : named ? 0.8 : 0));
      c.chip.classList.toggle("on", i === focus);
      c.chip.classList.toggle("here", i === startIndex);
    });
    threadGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    (thread.material as THREE.LineBasicMaterial).opacity = 0.7 * threadOn;
    (knots.material as THREE.PointsMaterial).opacity = threadOn;

    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  // ---------------------------------------------------------------- close: fold back into the patch
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    phase = "closing";
    controls.enabled = false;
    root.classList.remove("tc-open");
    const startPos = camera.position.clone();
    const snapshot = cards.map((c) => ({ pos: c.mesh.position.clone(), rot: c.mesh.rotation.clone(), scale: c.mesh.scale.x }));
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FOLD_MS + 150, fill: "forwards" });
    await new Promise<void>((resolve) => {
      const t0 = performance.now();
      const step = (now: number) => {
        const k = easeInOut(clamp01((now - t0) / FOLD_MS));
        camera.position.lerpVectors(startPos, home, k);
        camera.lookAt(target);
        cards.forEach((c, i) => {
          const s = snapshot[i];
          c.mesh.position.lerpVectors(s.pos, origin.pos, k);
          c.mesh.scale.setScalar(s.scale + (origin.scale - s.scale) * k);
          c.mesh.rotation.set(s.rot.x * (1 - k), s.rot.y * (1 - k), s.rot.z * (1 - k));
          // Every other era folds into the one that was on screen, which settles back into the scene.
          c.mat.opacity = i === startIndex ? 1 - clamp01((k - 0.75) * 4) : 1 - k;
        });
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    opts.onStage?.(false);
    cancelAnimationFrame(raf);
    removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKey);
    controls.dispose();
    cards.forEach((c) => (c.mat.map?.dispose(), c.mat.dispose(), c.mesh.geometry.dispose()));
    renderer.dispose();
    root.remove();
    open = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") void close();
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") setFocus(focus - 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") setFocus(focus + 1);
    else if (e.key === "Enter") root.querySelector<HTMLButtonElement>(".tc-go")!.click();
    else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  root.querySelector(".tc-close")!.addEventListener("click", () => void close());
  open = { close };
}

export function closeTimeCore(): void {
  void open?.close();
}

export const isTimeCoreOpen = () => open !== null;
