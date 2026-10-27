// In-scene explosion of an idea fossil into a navigable network.
// 1. Lift: the poster leaves its wall from exactly where it hangs in the scene and comes forward.
// 2. Expand: it grows a little, a breath before the burst.
// 3. Explode: its elements spring out from where they sat on the poster into one connected network: each
//    element stays linked to its spot on the poster, and on to a node naming its persuasion technique
//    (the slogan headlines the info panel).
// 4. Navigate: drag to orbit, wheel/pinch to zoom (bounded, no panning): nothing ever floats away.
// Closing folds everything back into the poster and the poster back onto the wall.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Mask } from "./sam";
import type { Fossil } from "./shared/eras";
import { formatYear } from "./shared/eras";

export type ScreenRect = { left: number; top: number; width: number; height: number };

const FOV = 35;
const LIFT_MS = 900;
const EXPAND_MS = 380;
const EXPLODE_MS = 1400;
const EASE_FLY = "cubic-bezier(.2,.9,.2,1)";
const ACCENT = new THREE.Color("#e7c76a");

let open: { close: () => Promise<void> } | null = null;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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

/** The element cut out of the poster with its SAM mask, cropped to its own bounds. */
function cutout(image: HTMLImageElement, mask: Mask) {
  const x1 = Math.min(...mask.boxes.map((b) => b.x1));
  const y1 = Math.min(...mask.boxes.map((b) => b.y1));
  const x2 = Math.max(...mask.boxes.map((b) => b.x2));
  const y2 = Math.max(...mask.boxes.map((b) => b.y2));
  const w = x2 - x1 + 1;
  const h = y2 - y1 + 1;
  const full = document.createElement("canvas");
  full.width = mask.width;
  full.height = mask.height;
  const fctx = full.getContext("2d")!;
  fctx.drawImage(image, 0, 0, mask.width, mask.height);
  const img = fctx.getImageData(x1, y1, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask.data[(y1 + y) * mask.width + x1 + x]) img.data[(y * w + x) * 4 + 3] = 0;
    }
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.putImageData(img, 0, 0);
  // Normalized centre and size within the poster.
  return { canvas: out, cx: (x1 + w / 2) / mask.width, cy: (y1 + h / 2) / mask.height, nw: w / mask.width, nh: h / mask.height };
}

/** A pill-shaped text label as a texture. */
function labelTexture(text: string, font: string, fg: string, bg: string | null): { tex: THREE.CanvasTexture; aspect: number } {
  const scale = 3;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  const h = 40;
  c.width = w * scale;
  c.height = h * scale;
  ctx.scale(scale, scale);
  if (bg) {
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, h / 2);
    ctx.fill();
  }
  ctx.font = font;
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  if (!bg) {
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 8;
  }
  ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: w / h };
}

const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** Where the poster comes to rest: centred, or left of the info panel on wide screens. */
function restRect(aspect: number): ScreenRect {
  const wide = innerWidth >= 900;
  const maxH = innerHeight * (wide ? 0.42 : 0.24);
  const maxW = innerWidth * (wide ? 0.24 : 0.34);
  let height = maxH;
  let width = height * aspect;
  if (width > maxW) {
    width = maxW;
    height = width / aspect;
  }
  const cx = wide ? innerWidth * 0.38 : innerWidth / 2;
  const cy = wide ? innerHeight * 0.5 : innerHeight * 0.3;
  return { left: cx - width / 2, top: cy - height / 2, width, height };
}

type Node = {
  obj: THREE.Object3D;
  start: THREE.Vector3;
  end: THREE.Vector3;
  delay: number; // 0..1 share of the explode timeline
  index: number; // element index (techniques/elements), -1 for slogan
  baseScale: THREE.Vector3;
  spin: number; // starting twist (pieces tumble out and settle)
};

/**
 * Keeps the network closed: squeeze the exploded positions so every node (with its size) lands inside the
 * free screen area around the poster, left of / above the info panel, with a margin. Done per axis.
 */
function fitNetwork(nodes: Node[], poster: ScreenRect, info: DOMRect): void {
  const unit = poster.height / 2; // px per world unit at the poster's depth
  const cx = poster.left + poster.width / 2;
  const cy = poster.top + poster.height / 2;
  const margin = 16;
  const wide = innerWidth >= 900;
  const room = {
    left: (cx - margin) / unit,
    right: ((wide ? info.left : innerWidth) - margin - cx) / unit,
    up: (cy - margin - 56) / unit, // leave the close button and top bar clear
    down: ((wide ? innerHeight : info.top) - margin - cy) / unit,
  };
  let fx = 1;
  let fy = 1;
  for (const n of nodes) {
    const plane = n.obj instanceof THREE.Mesh ? (n.obj.geometry as THREE.PlaneGeometry).parameters : null;
    const halfW = (plane ? plane.width / 2 : Math.abs(n.baseScale.x) / 2) + 0.08;
    const halfH = (plane ? plane.height / 2 : Math.abs(n.baseScale.y) / 2) + 0.08;
    const x = n.end.x;
    const y = n.end.y;
    if (x > 0) fx = Math.min(fx, Math.max(0.2, (room.right - halfW) / x));
    if (x < 0) fx = Math.min(fx, Math.max(0.2, (room.left - halfW) / -x));
    if (y > 0) fy = Math.min(fy, Math.max(0.2, (room.up - halfH) / y));
    if (y < 0) fy = Math.min(fy, Math.max(0.2, (room.down - halfH) / -y));
  }
  for (const n of nodes) n.end.set(n.end.x * fx, n.end.y * fy, n.end.z);

}

export async function explodeFossil(opts: {
  fossil: Fossil;
  imageUrl: string;
  year: number;
  from: ScreenRect | null;
  loadMasks: () => Promise<(Mask | null)[]>;
  /** Called with true when the poster lifts and false when it's back on the wall (e.g. push the scene back). */
  onStage?: (on: boolean) => void;
}): Promise<void> {
  await open?.close();
  const { fossil, year } = opts;
  const image = await loadImage(opts.imageUrl);
  const aspect = image.naturalWidth / image.naturalHeight;
  const to = restRect(aspect);
  const from =
    opts.from ?? { left: to.left + to.width * 0.4, top: to.top + to.height * 0.4, width: to.width * 0.2, height: to.height * 0.2 };

  // ---------------------------------------------------------------- DOM shell
  const root = document.createElement("div");
  root.className = "xp";
  root.innerHTML = `
    <div class="xp-backdrop"></div>
    <div class="xp-flare"></div>
    <canvas class="xp-gl"></canvas>
    <img class="xp-flyer" alt="" />
    <aside class="xp-info">
      <div class="xp-kicker">Idea fossil · ${esc(fossil.medium)} · ${esc(formatYear(year))}</div>
      ${fossil.slogan ? `<p class="xp-slogan-text">${esc(fossil.slogan)}</p>` : ""}
      <ol class="xp-list">${fossil.elements
        .map((e, i) => `<li data-i="${i}"><b>${esc(e.technique)}</b><span>${esc(e.name)}: ${esc(e.explanation)}.</span></li>`)
        .join("")}</ol>
      <p class="xp-hint">Drag to turn · scroll to zoom</p>
    </aside>
    <button class="xp-close" aria-label="Put it back">×</button>`;
  document.body.append(root);
  const backdrop = root.querySelector<HTMLElement>(".xp-backdrop")!;
  const flyer = root.querySelector<HTMLImageElement>(".xp-flyer")!;
  const glCanvas = root.querySelector<HTMLCanvasElement>(".xp-gl")!;
  const listItems = [...root.querySelectorAll<HTMLElement>(".xp-list li")];
  flyer.src = opts.imageUrl;
  Object.assign(flyer.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });

  // ---------------------------------------------------------------- 1. lift (DOM, FLIP from the wall)
  const flip = `translate(${from.left - to.left + (from.width - to.width) / 2}px, ${from.top - to.top + (from.height - to.height) / 2}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, fill: "forwards" });
  opts.onStage?.(true);
  // A warm light blooms behind the poster as it comes off the wall.
  const flare = root.querySelector<HTMLElement>(".xp-flare")!;
  const flareSize = Math.max(to.width, to.height) * 2.2;
  Object.assign(flare.style, {
    left: `${to.left + to.width / 2 - flareSize / 2}px`,
    top: `${to.top + to.height / 2 - flareSize / 2}px`,
    width: `${flareSize}px`,
    height: `${flareSize}px`,
  });
  flare.animate(
    [
      { opacity: 0, transform: "scale(0.2)" },
      { opacity: 0.95, transform: "scale(1)", offset: 0.75 },
      { opacity: 0.55, transform: "scale(0.9)" },
    ],
    { duration: LIFT_MS + 200, easing: "ease-out", fill: "forwards" },
  );
  const lift = flyer.animate(
    [
      { transform: `${flip}`, boxShadow: "0 0 0 rgba(0,0,0,0)" },
      { transform: "translateY(-6px) scale(1.02)", boxShadow: "0 30px 50px rgba(0,0,0,.55)", offset: 0.7 },
      { transform: "none", boxShadow: "0 24px 40px rgba(0,0,0,.5)" },
    ],
    { duration: LIFT_MS, easing: EASE_FLY, fill: "forwards" },
  );

  // ---------------------------------------------------------------- burst effects (built at the burst)
  let burstStart = -1;
  let ring: THREE.Mesh | null = null;
  let sparks: THREE.Points | null = null;
  let sparkVel: Float32Array | null = null;

  // ---------------------------------------------------------------- three.js network
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.1, 100);
  const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  // Poster plane is 2 units tall; place the camera so it covers exactly the resting rect on screen.
  const dist = innerHeight / (tan * to.height);
  camera.position.set(0, 0, dist);
  const cx = to.left + to.width / 2;
  const cy = to.top + to.height / 2;
  camera.setViewOffset(innerWidth, innerHeight, innerWidth / 2 - cx, innerHeight / 2 - cy, innerWidth, innerHeight);

  const H = 2;
  const W = 2 * aspect;
  const group = new THREE.Group();
  scene.add(group);
  const posterTex = new THREE.Texture(image);
  posterTex.colorSpace = THREE.SRGBColorSpace;
  posterTex.needsUpdate = true;
  const posterMat = new THREE.MeshBasicMaterial({ map: posterTex, side: THREE.DoubleSide, transparent: true });
  const poster = new THREE.Mesh(new THREE.PlaneGeometry(W, H), posterMat);
  group.add(poster);

  const controls = new OrbitControls(camera, glCanvas);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false; // the network can turn and zoom, never wander off
  controls.minDistance = dist * 0.55;
  controls.maxDistance = dist * 1.5;
  controls.minPolarAngle = Math.PI * 0.22;
  controls.maxPolarAngle = Math.PI * 0.78;
  controls.minAzimuthAngle = -Math.PI * 0.42;
  controls.maxAzimuthAngle = Math.PI * 0.42;
  controls.autoRotateSpeed = 0.55;
  controls.target.set(0, 0, 0);

  const nodes: Node[] = [];
  const links: { a: () => THREE.Vector3; b: () => THREE.Vector3; index: number }[] = [];
  const lineGeo = new THREE.BufferGeometry();
  const lineMat = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0 });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  group.add(lines);
  const dots = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: ACCENT, size: 0.07, transparent: true, opacity: 0 }),
  );
  group.add(dots);

  let raf = 0;
  let phase: "lift" | "expand" | "explode" | "live" | "closing" = "lift";
  let phaseStart = performance.now();
  let focused: number | null = null;
  let pinned: number | null = null;
  let explodeT = 0;

  const focus = (i: number | null) => {
    focused = i;
    listItems.forEach((li) => li.classList.toggle("on", Number(li.dataset.i) === (i ?? pinned)));
  };
  listItems.forEach((li) => {
    li.addEventListener("pointerenter", () => focus(Number(li.dataset.i)));
    li.addEventListener("pointerleave", () => focus(null));
    li.addEventListener("click", () => {
      pinned = pinned === Number(li.dataset.i) ? null : Number(li.dataset.i);
      focus(pinned);
    });
  });

  // Hover nodes in 3D.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  glCanvas.addEventListener("pointermove", (e) => {
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(nodes.filter((n) => n.index >= 0).map((n) => n.obj))[0];
    const node = hit && nodes.find((n) => n.obj === hit.object);
    focus(node ? node.index : null);
    glCanvas.style.cursor = node ? "pointer" : "grab";
  });
  // Pause the gentle auto-turn while someone is steering.
  controls.addEventListener("start", () => (controls.autoRotate = false));

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.setViewOffset(innerWidth, innerHeight, innerWidth / 2 - cx, innerHeight / 2 - cy, innerWidth, innerHeight);
    camera.updateProjectionMatrix();
  };
  addEventListener("resize", resize);

  const updateLinks = () => {
    const pts: number[] = [];
    const ends: number[] = [];
    for (const l of links) {
      const a = l.a();
      const b = l.b();
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      ends.push(b.x, b.y, b.z);
    }
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    dots.geometry.setAttribute("position", new THREE.Float32BufferAttribute(ends, 3));
  };

  /** Shockwave ring and a spray of flecks in the poster's own colours, from the poster's surface. */
  function startBurst(): void {
    ring = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 96),
      new THREE.MeshBasicMaterial({ color: 0xfff2c4, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    ring.position.z = 0.05;
    group.add(ring);
    const sample = document.createElement("canvas");
    sample.width = 32;
    sample.height = 48;
    const sctx = sample.getContext("2d")!;
    sctx.drawImage(image, 0, 0, 32, 48);
    const px = sctx.getImageData(0, 0, 32, 48).data;
    const count = 320;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    sparkVel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = Math.random();
      const v = Math.random();
      const x = (u - 0.5) * W;
      const y = (0.5 - v) * H;
      positions.set([x, y, 0.03], i * 3);
      const p = (Math.floor(v * 47) * 32 + Math.floor(u * 31)) * 4;
      colors.set([px[p] / 255, px[p + 1] / 255, px[p + 2] / 255], i * 3);
      const len = Math.hypot(x, y) || 1;
      const speed = 1.2 + Math.random() * 3.2;
      sparkVel.set([(x / len) * speed + (Math.random() - 0.5), (y / len) * speed + (Math.random() - 0.3), Math.random() * 2.4], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    sparks = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.045, vertexColors: true, transparent: true, opacity: 1, depthWrite: false }),
    );
    group.add(sparks);
  }

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const t = now - phaseStart;
    if (phase === "expand") {
      // A breath before the burst: the poster swells a little.
      const k = easeInOut(clamp01(t / EXPAND_MS));
      group.scale.setScalar(1 + 0.1 * Math.sin(k * Math.PI) + 0.04 * k);
      // Anticipation: a tremble that builds until it bursts.
      group.rotation.z = Math.sin(t * 0.11) * 0.018 * k;
      group.position.x = Math.sin(t * 0.17) * 0.012 * k;
      if (t >= EXPAND_MS) {
        group.rotation.z = 0;
        group.position.x = 0;
        phase = "explode";
        phaseStart = now;
        burstStart = now;
        startBurst();
      }
    }
    if (phase === "explode" || phase === "closing") {
      const dir = phase === "explode" ? 1 : -1;
      explodeT = clamp01(phase === "explode" ? t / EXPLODE_MS : 1 - t / 650);
      for (const n of nodes) {
        const local = clamp01((explodeT - n.delay) / (1 - n.delay));
        const e = dir > 0 ? easeOutBack(local) : easeInOut(local);
        n.obj.position.lerpVectors(n.start, n.end, e);
        if (n.obj instanceof THREE.Mesh) n.obj.rotation.z = n.spin * (1 - Math.min(1, e));
      }
      posterMat.color.setScalar(1 - 0.55 * easeInOut(explodeT));
      lineMat.opacity = 0.75 * clamp01(explodeT * 1.6 - 0.4);
      (dots.material as THREE.PointsMaterial).opacity = lineMat.opacity;
      if (phase === "explode" && t >= EXPLODE_MS) {
        phase = "live";
        controls.enabled = true;
        controls.autoRotate = true;
        root.classList.add("exploded");
      }
    }
    if (burstStart >= 0) {
      const bt = (now - burstStart) / 1000;
      if (ring) {
        ring.scale.setScalar(0.3 + bt * 5.5);
        (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 - bt * 1.1);
      }
      if (sparks && sparkVel) {
        const pos = sparks.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(
            i,
            pos.getX(i) + sparkVel[i * 3] * 0.016,
            pos.getY(i) + sparkVel[i * 3 + 1] * 0.016 - bt * 0.004,
            pos.getZ(i) + sparkVel[i * 3 + 2] * 0.016,
          );
          sparkVel[i * 3] *= 0.97;
          sparkVel[i * 3 + 1] *= 0.97;
          sparkVel[i * 3 + 2] *= 0.97;
        }
        pos.needsUpdate = true;
        (sparks.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - bt / 1.6);
      }
      if (bt > 1.8) burstStart = -1;
    }
    // Focus: the hovered/pinned element and its technique stay bright, the rest recede.
    const active = focused ?? pinned;
    for (const n of nodes) {
      const mat = (n.obj as THREE.Mesh | THREE.Sprite).material as THREE.Material & { opacity: number };
      const focusOpacity = active === null || n.index === active || n.index < 0 ? 1 : 0.22;
      // Labels and the slogan only appear as they fly out; pieces are part of the poster from the start.
      const appear = n.obj instanceof THREE.Sprite ? clamp01((explodeT - n.delay) * 2.5) : 1;
      const target = focusOpacity * appear;
      mat.opacity += (target - mat.opacity) * 0.2;
      const grow = active !== null && n.index === active ? 1.08 : 1;
      // Labels pop in with a little overshoot as they arrive.
      const pop = n.obj instanceof THREE.Sprite ? 0.2 + 0.8 * easeOutBack(appear) : 1;
      n.obj.scale.lerp(n.baseScale.clone().multiplyScalar(grow * pop), 0.25);
    }
    updateLinks();
    controls.update();
    renderer.render(scene, camera);
  };

  // ---------------------------------------------------------------- close
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    controls.enabled = false;
    controls.autoRotate = false;
    root.classList.remove("exploded");
    if (phase === "live" || phase === "explode") {
      phase = "closing";
      phaseStart = performance.now();
      // Turn back to face the viewer while the pieces fold in.
      const startPos = camera.position.clone();
      const home = new THREE.Vector3(0, 0, dist);
      await new Promise<void>((resolve) => {
        const t0 = performance.now();
        const step = (now: number) => {
          const k = easeInOut(clamp01((now - t0) / 650));
          camera.position.lerpVectors(startPos, home, k);
          camera.lookAt(0, 0, 0);
          if (k < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    }
    group.scale.setScalar(1);
    flare.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 500, fill: "forwards" });
    glCanvas.style.opacity = "0";
    flyer.style.visibility = "visible";
    root.querySelector(".xp-info")!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: "forwards" });
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 650, fill: "forwards" });
    await flyer.animate([{ transform: "none" }, { transform: flip, opacity: 0.25 }], {
      duration: 700,
      easing: EASE_FLY,
      fill: "forwards",
    }).finished;
    opts.onStage?.(false);
    cancelAnimationFrame(raf);
    removeEventListener("resize", resize);
    document.removeEventListener("keydown", onKey);
    controls.dispose();
    renderer.dispose();
    root.remove();
    open = null;
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && void close();
  document.addEventListener("keydown", onKey);
  root.querySelector(".xp-close")!.addEventListener("click", () => void close());
  backdrop.addEventListener("click", () => void close());
  open = { close };

  // ---------------------------------------------------------------- 2–3. expand, then explode
  const [masks] = await Promise.all([opts.loadMasks().catch(() => [] as (Mask | null)[]), lift.finished]);
  if (closing) return;

  const parts = fossil.elements
    .map((el, i) => ({ el, i, mask: masks[i] }))
    .filter((p): p is { el: typeof p.el; i: number; mask: Mask } => Boolean(p.mask));
  parts.forEach(({ el, i, mask }, n) => {
    const cut = cutout(image, mask);
    const tex = new THREE.CanvasTexture(cut.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sw = cut.nw * W;
    const sh = cut.nh * H;
    const piece = new THREE.Mesh(
      new THREE.PlaneGeometry(sw, sh),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    // Starts exactly where it sits on the poster…
    const start = new THREE.Vector3((cut.cx - 0.5) * W, (0.5 - cut.cy) * H, 0.02 + n * 0.01);
    // …and springs outward in the direction it was already facing, alternating depth.
    let dir = new THREE.Vector2(start.x, start.y);
    if (dir.length() < 0.15) dir = new THREE.Vector2(Math.cos((n / parts.length) * Math.PI * 2), Math.sin((n / parts.length) * Math.PI * 2));
    dir.normalize();
    const reach = Math.max(W, H) * 0.62 + Math.max(sw, sh) * 0.35;
    // Wide screens have room sideways, phones above and below the poster.
    const [sx, sy] = innerWidth >= 900 ? [1.5, 0.7] : [1.1, 0.9];
    const end = new THREE.Vector3(dir.x * reach * sx, dir.y * reach * sy, n % 2 ? 0.9 : 0.55);
    group.add(piece);
    nodes.push({ obj: piece, start, end, delay: n * 0.08, index: i, baseScale: new THREE.Vector3(1, 1, 1), spin: (n % 2 ? 1 : -1) * (0.5 + Math.random() * 0.6) });
    links.push({ a: () => start, b: () => piece.position, index: i });

    // The technique, one hop further out.
    const { tex: ltex, aspect: la } = labelTexture(el.technique, "600 18px system-ui, sans-serif", "#1c1a14", "#e7c76a");
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: ltex, transparent: true, depthWrite: false }));
    const lh = 0.2;
    label.scale.set(lh * la, lh, 1);
    const lend = end.clone().add(new THREE.Vector3(dir.x * 0.55, dir.y * 0.4 + 0.05, 0.25));
    group.add(label);
    nodes.push({ obj: label, start: start.clone(), end: lend, delay: 0.25 + n * 0.08, index: i, baseScale: label.scale.clone(), spin: 0 });
    links.push({ a: () => piece.position, b: () => label.position, index: i });
  });

  fitNetwork(nodes, to, root.querySelector<HTMLElement>(".xp-info")!.getBoundingClientRect());

  // Hand over from the lifted DOM poster to the identical 3D one, then breathe, then burst.
  nodes.forEach((n) => {
    n.obj.position.copy(n.start);
    if (n.obj instanceof THREE.Sprite) n.obj.material.opacity = 0;
  });
  glCanvas.style.opacity = "1";
  flyer.style.visibility = "hidden";
  phase = parts.length ? "expand" : "live";
  if (!parts.length) {
    controls.enabled = true;
    root.classList.add("exploded");
  }
  phaseStart = performance.now();
  raf = requestAnimationFrame(frame);
}

export function closeExploded(): void {
  void open?.close();
}
