// Exploded view of an idea fossil: each named element is cut out with its SAM mask and floats on its own
// layer above the dimmed original, labelled with the persuasion technique it carries. Drag to rotate.
import type { Mask } from "./sam";
import type { Fossil } from "./shared/eras";

const LAYER_GAP_PX = 70;

function cutout(image: HTMLImageElement, mask: Mask): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0, mask.width, mask.height);
  const img = ctx.getImageData(0, 0, mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) img.data[i * 4 + 3] = mask.data[i] ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function center(mask: Mask): { x: number; y: number } {
  const b = [...mask.boxes].sort((a, c) => (c.x2 - c.x1) * (c.y2 - c.y1) - (a.x2 - a.x1) * (a.y2 - a.y1))[0];
  return { x: (b.x1 + b.x2) / 2 / mask.width, y: (b.y1 + b.y2) / 2 / mask.height };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export async function buildExploded(
  stage: HTMLElement,
  imageUrl: string,
  fossil: Fossil,
  masks: (Mask | null)[],
): Promise<void> {
  const image = await loadImage(imageUrl);
  const rig = document.createElement("div");
  rig.className = "explode-rig";
  rig.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;

  const base = document.createElement("img");
  base.src = imageUrl;
  base.className = "explode-layer explode-base";
  base.alt = "";
  rig.append(base);

  const layers: HTMLElement[] = [];
  fossil.elements.forEach((el, i) => {
    const mask = masks[i];
    if (!mask) return;
    const layer = document.createElement("div");
    layer.className = "explode-layer";
    layer.dataset.depth = String(layers.length + 1);
    layer.append(cutout(image, mask));
    const c = center(mask);
    const tag = document.createElement("span");
    tag.className = "explode-tag";
    tag.style.left = `${c.x * 100}%`;
    tag.style.top = `${c.y * 100}%`;
    tag.textContent = el.technique;
    layer.append(tag);
    rig.append(layer);
    layers.push(layer);
  });

  if (fossil.slogan) {
    const slogan = document.createElement("div");
    slogan.className = "explode-layer explode-slogan";
    slogan.dataset.depth = String(layers.length + 1);
    slogan.textContent = fossil.slogan;
    rig.append(slogan);
    layers.push(slogan);
  }

  stage.replaceChildren(rig);

  // Fan out after the first paint so the layers visibly lift off the poster.
  let rx = 12;
  let ry = -28;
  const apply = () => (rig.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const layer of layers) layer.style.transform = `translateZ(${Number(layer.dataset.depth) * LAYER_GAP_PX}px)`;
      apply();
      stage.classList.add("exploded");
    }),
  );

  let drag: { x: number; y: number; rx: number; ry: number } | null = null;
  stage.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY, rx, ry };
    stage.setPointerCapture(e.pointerId);
  };
  stage.onpointermove = (e) => {
    if (!drag) return;
    ry = Math.max(-60, Math.min(60, drag.ry + (e.clientX - drag.x) * 0.3));
    rx = Math.max(-40, Math.min(40, drag.rx - (e.clientY - drag.y) * 0.3));
    apply();
  };
  stage.onpointerup = () => (drag = null);
}
