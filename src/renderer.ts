// Full-screen three.js quad that blends two keyframes. Each pixel changes on its own schedule from a
// delay map baked from the photo's SAM masks: sky first, plants next, structures last, with a noisy edge.
// Structures also change along their height, block by block: they rise from the ground while a place is being
// built up and come down from the roofline as it weathers away, so nothing simply pops in or out. When both
// keyframes know where their own buildings stand (a SAM mask per era), each building is handled on its own: one
// only in the older keyframe comes down first, one only in the newer rises after, one in both ages in place.
// While a transition plays, cloud shadows sweep the land and a few days and nights flick by.
import * as THREE from "three";

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uA;
  uniform sampler2D uB;
  uniform sampler2D uDelay;
  uniform sampler2D uSA; // where keyframe A's own structures stand
  uniform sampler2D uSB;
  uniform float uPerEra; // 1 when both are known; otherwise the photo's structures and uBuild stand in
  uniform float uT;
  uniform float uImgAspect;
  uniform float uViewAspect;
  uniform float uZoom;
  uniform vec2 uScale;   // fraction of the image spanned by the viewport (>1 = contain, letterboxed)
  uniform vec2 uOffset;
  uniform vec3 uTint;
  uniform float uTime;
  uniform float uBuild; // +1 structures grow from A to B, −1 they wear away, 0 neither

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  vec3 blend(vec2 uv, float local) { return mix(texture2D(uA, uv).rgb, texture2D(uB, uv).rgb, local); }

  void main() {
    // Map the viewport onto the image; zoomed in slightly so look-around never shows an edge.
    vec2 scale = uScale / uZoom;
    vec2 slack = max(vec2(0.0), 1.0 - scale);
    vec2 uv = (vUv - 0.5) * scale + 0.5 + uOffset * slack * 0.5;

    // Each pixel transitions over a window of length L that starts later for higher delays.
    // r: when this pixel changes; g: how much it belongs to a structure.
    vec2 d = texture2D(uDelay, uv).rg;
    float delay;
    float structure;
    if (uPerEra > 0.5) {
      // A is always the older keyframe; scrubbing back simply plays this in reverse.
      float sa = texture2D(uSA, uv).r;
      float sb = texture2D(uSB, uv).r;
      float gone = sa * (1.0 - sb);
      float born = sb * (1.0 - sa);
      delay = mix(d.r, 0.05 + (1.0 - uv.y) * 0.4, gone); // roofline first, early
      delay = mix(delay, 0.5 + uv.y * 0.45, born);        // from the ground up, late
      structure = max(gone, born);
    } else {
      delay = clamp(d.r + d.g * uBuild * (uv.y - 0.5) * 0.7, 0.0, 1.0);
      structure = d.g * abs(uBuild);
    }
    const float L = 0.45;
    float start = delay * (1.0 - L);
    float n = noise(uv * 18.0) * 0.6 + noise(uv * 64.0) * 0.4;
    // Structures go block by block, like courses of stone, instead of melting.
    float blocks = hash(floor(uv * vec2(120.0, 170.0))) - 0.5;
    float pass = sin(3.14159 * uT); // 0 at the keyframes, so they always show exactly as painted
    float jitter = ((n - 0.5) * 0.18 + blocks * 0.14 * structure) * pass;
    float local = clamp(smoothstep(start, start + L, uT + jitter), 0.0, 1.0);

    vec3 color;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      // Letterbox: a dark, heavily blurred stretch of the image fills the space around it.
      vec2 bu = clamp((vUv - 0.5) * vec2(0.35, 0.35) + 0.5, 0.0, 1.0);
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 0.5236;
        acc += blend(clamp(bu + vec2(cos(a), sin(a)) * 0.08, 0.0, 1.0), uT);
      }
      color = acc / 12.0 * 0.45;
    } else {
      color = blend(uv, local);
    }

    // Era grading: warm past, cool future; then vignette and fine grain.
    // Kept subtle: heavier grading made photographs read as paintings.
    // Time passing: cloud shadows drift over the land (not the sky, the earliest layer) and days dim and brighten.
    float sky = 1.0 - smoothstep(0.0, 0.08, d.r);
    float cloud = smoothstep(0.5, 0.78, noise(uv * vec2(2.2, 3.0) + vec2(uT * 7.0, uT * 1.3)));
    color *= 1.0 - pass * 0.1 * cloud * (1.0 - sky);
    color *= 1.0 - pass * 0.05 * (0.5 - 0.5 * cos(uT * 6.2832 * 3.0));

    color = mix(color, color * uTint, 0.12);
    float vig = smoothstep(1.2, 0.4, length(vUv - 0.5) * 1.4);
    color *= mix(0.9, 1.0, vig);
    color += (hash(vUv * 1000.0 + uTime) - 0.5) * 0.015;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export type Look = { x: number; y: number }; // −1…1 each

export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private textures = new Map<number, THREE.Texture>();
  /** Per keyframe: where its own structures stand. Missing = unknown (older scenes and demos). */
  private structures = new Map<number, THREE.Texture>();
  private blank: THREE.Texture;
  private look: Look = { x: 0, y: 0 };
  private zoomBoost = 1;
  private zoomBoostTarget = 1;
  /** Zoom past the edges, so looking around never shows one. More while the gyro steers, which needs room. */
  private baseZoom = 1.08;
  private baseZoomTarget = 1.08;
  private lookTarget: Look = { x: 0, y: 0 };
  private raf = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private imgAspect: number,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this.blank = blank;
    const delay = new THREE.DataTexture(new Uint8Array([128, 0, 128, 255]), 1, 1);
    delay.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uA: { value: blank },
        uB: { value: blank },
        uDelay: { value: delay },
        uSA: { value: blank },
        uSB: { value: blank },
        uPerEra: { value: 0 },
        uBuild: { value: 0 },
        uT: { value: 0 },
        uImgAspect: { value: imgAspect },
        uViewAspect: { value: 1 },
        uZoom: { value: 1.08 },
        uScale: { value: new THREE.Vector2(1, 1) },
        uOffset: { value: new THREE.Vector2() },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uTime: { value: 0 },
      },
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
    canvas.addEventListener("webglcontextrestored", () => this.textures.forEach((t) => (t.needsUpdate = true)));
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.loop();
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.material.uniforms.uViewAspect.value = w / h;
    const [sx, sy] = this.fit();
    (this.material.uniforms.uScale.value as THREE.Vector2).set(sx, sy);
  }

  /**
   * Fraction of the image spanned by the viewport on each axis. A screen much wider than the photo (a
   * portrait photo on a laptop) gets contain + blurred backdrop, so nothing ends up cropped behind the
   * time bar. Otherwise cover: on a phone the photo fills the screen like a window, and drag/tilt pans.
   */
  private fit(): [number, number] {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    const r = w / h / this.imgAspect;
    const contain = r > 1.3;
    if (contain) return r > 1 ? [r, 1] : [1, 1 / r];
    return r > 1 ? [1, 1 / r] : [r, 1];
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    // Low-pass the look offset so mouse, drag and gyro all feel smooth.
    this.look.x += (this.lookTarget.x - this.look.x) * 0.08;
    this.look.y += (this.lookTarget.y - this.look.y) * 0.08;
    (this.material.uniforms.uOffset.value as THREE.Vector2).set(this.look.x, -this.look.y);
    this.zoomBoost += (this.zoomBoostTarget - this.zoomBoost) * 0.06;
    this.baseZoom += (this.baseZoomTarget - this.baseZoom) * 0.06;
    this.material.uniforms.uZoom.value = this.baseZoom * this.zoomBoost;
    this.material.uniforms.uTime.value = (performance.now() % 10000) / 1000;
    this.renderer.render(this.scene, this.camera);
  };

  /** A slow camera push into the scene (e.g. while a poster lifts off its wall); 1 = rest. */
  setZoomBoost(k: number): void {
    this.zoomBoostTarget = k;
  }

  /** Extra room to look around (the gyro): 1.08 at rest. */
  setLookRoom(zoom: number): void {
    this.baseZoomTarget = zoom;
  }

  setLook(look: Look): void {
    this.lookTarget = { x: Math.max(-1, Math.min(1, look.x)), y: Math.max(-1, Math.min(1, look.y)) };
  }

  /**
   * Keyframes are uploaded once as textures at display size (≤1280 px on phones, so ~10 of them fit
   * comfortably in iOS GPU memory). Bitmaps must be created with imageOrientation: "flipY", because
   * WebGL can't flip an ImageBitmap at upload time.
   */
  setKeyframe(year: number, image: ImageBitmap): void {
    const tex = new THREE.Texture(image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    this.textures.get(year)?.dispose();
    this.textures.set(year, tex);
    this.setStructures(year, null); // a new image makes the old one's structures stale
  }

  /** Where a keyframe's own structures stand (white on black, any size), or null when unknown. */
  setStructures(year: number, canvas: HTMLCanvasElement | null): void {
    this.structures.get(year)?.dispose();
    this.structures.delete(year);
    if (!canvas) return;
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.structures.set(year, tex);
  }

  hasKeyframe(year: number): boolean {
    return this.textures.has(year);
  }

  setDelayMap(canvas: HTMLCanvasElement): void {
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.material.uniforms.uDelay.value = tex;
  }

  /** build: +1 when structures grow from keyframe a to b, −1 when they wear away, 0 otherwise. */
  show(a: number, b: number, t: number, tint: [number, number, number], build = 0): void {
    const ta = this.textures.get(a);
    const tb = this.textures.get(b);
    if (!ta || !tb) return;
    this.material.uniforms.uA.value = ta;
    this.material.uniforms.uB.value = tb;
    this.material.uniforms.uT.value = t;
    this.material.uniforms.uBuild.value = build;
    const sa = this.structures.get(a);
    const sb = this.structures.get(b);
    this.material.uniforms.uSA.value = sa ?? this.blank;
    this.material.uniforms.uSB.value = sb ?? this.blank;
    this.material.uniforms.uPerEra.value = sa && sb ? 1 : 0;
    (this.material.uniforms.uTint.value as THREE.Vector3).set(...tint);
  }

  /** Screen point (CSS px within the canvas) → image UV (0..1, v down), mirroring the shader. */
  screenToImage(px: number, py: number): { u: number; v: number } {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    const { sx, sy, ox, oy } = this.mapping();
    const u = (px / w - 0.5) * sx + 0.5 + ox;
    const vUp = (1 - py / h - 0.5) * sy + 0.5 + oy;
    return { u, v: 1 - vUp };
  }

  /** Image UV → screen point, for placing DOM hints over the image. */
  imageToScreen(u: number, v: number): { x: number; y: number } {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    const { sx, sy, ox, oy } = this.mapping();
    const vx = (u - 0.5 - ox) / sx + 0.5;
    const vUp = (1 - v - 0.5 - oy) / sy + 0.5;
    return { x: vx * w, y: (1 - vUp) * h };
  }

  private mapping(): { sx: number; sy: number; ox: number; oy: number } {
    const zoom = this.material.uniforms.uZoom.value as number;
    const [fx, fy] = this.fit();
    const sx = fx / zoom;
    const sy = fy / zoom;
    const off = this.material.uniforms.uOffset.value as THREE.Vector2;
    return { sx, sy, ox: off.x * Math.max(0, 1 - sx) * 0.5, oy: off.y * Math.max(0, 1 - sy) * 0.5 };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.textures.forEach((t) => t.dispose());
    this.structures.forEach((t) => t.dispose());
    this.renderer.dispose();
  }
}

type MaskLike = { width: number; height: number; data: Uint8Array };

/**
 * Delay map from base masks. Red: when each pixel changes, sky 0 → plants → structures → ground 1, painted in
 * that order. Green: where the structures are, for the rise-and-fall sweep.
 */
export function bakeDelayMap(
  width: number,
  height: number,
  layers: { mask: MaskLike | null; delay: number }[],
  structures: (MaskLike | null)[],
): HTMLCanvasElement {
  const delay = paintLayers(width, height, "rgb(128,128,128)", layers);
  const solid = paintLayers(width, height, "rgb(0,0,0)", structures.map((mask) => ({ mask, delay: 1 })));
  const d = delay.getContext("2d")!.getImageData(0, 0, width, height);
  const s = solid.getContext("2d")!.getImageData(0, 0, width, height).data;
  for (let i = 0; i < d.data.length; i += 4) d.data[i + 1] = s[i];
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  out.getContext("2d")!.putImageData(d, 0, 0);
  return out;
}

/** A keyframe's structures as white on black, for Renderer.setStructures. An empty list means "none stand here". */
export function bakeStructures(width: number, height: number, masks: (MaskLike | null)[]): HTMLCanvasElement {
  return paintLayers(width, height, "rgb(0,0,0)", masks.map((mask) => ({ mask, delay: 1 })));
}

function paintLayers(width: number, height: number, ground: string, layers: { mask: MaskLike | null; delay: number }[]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);
  for (const { mask, delay } of layers) {
    if (!mask) continue;
    const img = new ImageData(mask.width, mask.height);
    const g = Math.round(delay * 255);
    for (let i = 0; i < mask.data.length; i++) {
      if (!mask.data[i]) continue;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    const tmp = document.createElement("canvas");
    tmp.width = mask.width;
    tmp.height = mask.height;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0, width, height);
  }
  // Soften edges so the transition front doesn't trace hard mask outlines.
  const blurred = document.createElement("canvas");
  blurred.width = width;
  blurred.height = height;
  const bctx = blurred.getContext("2d")!;
  bctx.filter = `blur(${Math.round(width / 120)}px)`;
  bctx.drawImage(canvas, 0, 0);
  return blurred;
}

/** Warm for the deep past, neutral now, cool for the far future. */
export function tintForPosition(p: number): [number, number, number] {
  const k = Math.abs(p);
  return p < 0 ? [1 + 0.08 * k, 1 + 0.02 * k, 1 - 0.1 * k] : [1 - 0.06 * k, 1 + 0.01 * k, 1 + 0.1 * k];
}
