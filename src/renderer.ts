// Full-screen three.js quad that blends two keyframes. Each pixel changes on its own schedule from a
// delay map baked from the photo's SAM masks: sky first, plants next, structures last, with a noisy edge.
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
  uniform float uT;
  uniform float uImgAspect;
  uniform float uViewAspect;
  uniform float uZoom;
  uniform vec2 uScale;   // fraction of the image spanned by the viewport (>1 = contain, letterboxed)
  uniform vec2 uOffset;
  uniform vec3 uTint;
  uniform float uTime;

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
    float delay = texture2D(uDelay, uv).r;
    const float L = 0.45;
    float start = delay * (1.0 - L);
    float n = noise(uv * 18.0) * 0.6 + noise(uv * 64.0) * 0.4;
    float jitter = (n - 0.5) * 0.18 * sin(3.14159 * uT); // no jitter at the keyframes themselves
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
    color = mix(color, color * uTint, 0.35);
    float vig = smoothstep(1.15, 0.35, length(vUv - 0.5) * 1.4);
    color *= mix(0.78, 1.0, vig);
    color += (hash(vUv * 1000.0 + uTime) - 0.5) * 0.035;
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
  private look: Look = { x: 0, y: 0 };
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
    const delay = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    delay.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uA: { value: blank },
        uB: { value: blank },
        uDelay: { value: delay },
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
    this.material.uniforms.uTime.value = (performance.now() % 10000) / 1000;
    this.renderer.render(this.scene, this.camera);
  };

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

  show(a: number, b: number, t: number, tint: [number, number, number]): void {
    const ta = this.textures.get(a);
    const tb = this.textures.get(b);
    if (!ta || !tb) return;
    this.material.uniforms.uA.value = ta;
    this.material.uniforms.uB.value = tb;
    this.material.uniforms.uT.value = t;
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
    this.renderer.dispose();
  }
}

/** Grey delay map from base masks: sky 0 → plants → structures → ground 1. Painted in that order. */
export function bakeDelayMap(
  width: number,
  height: number,
  layers: { mask: { width: number; height: number; data: Uint8Array } | null; delay: number }[],
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgb(128,128,128)";
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
