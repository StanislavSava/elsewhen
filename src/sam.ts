// Decodes SAM 3.1 raw output text into full-frame binary masks.
// Grammar (dev.meta.ai/docs/sam/reading-segmentation):
//   <0f>ID<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..[;c=..]|><|mask;x=0;y=0[;c=..];data=H,W,<enc>payload|>,ID…
// Box corners are inclusive source pixels; the mask raster covers exactly the box.
import { decodeMaskToRaster } from "@meta-sam/parser";

export type Mask = {
  /** Source frame size the boxes refer to. */
  width: number;
  height: number;
  /** Union of all matches, one byte per source pixel (0/1). */
  data: Uint8Array;
  boxes: { x1: number; y1: number; x2: number; y2: number; confidence?: number }[];
};

const RECORD = /(\d+)<\|box;([^|]*)\|><\|mask;([^|]*)\|>/g;

function fields(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dataAt = s.indexOf("data=");
  const head = dataAt >= 0 ? s.slice(0, dataAt) : s;
  for (const part of head.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  if (dataAt >= 0) out.data = s.slice(dataAt + 5); // the payload may itself contain ';'
  return out;
}

export function parseSam(raw: string): Mask | null {
  let mask: Mask | null = null;
  for (const m of raw.matchAll(RECORD)) {
    const box = fields(m[2]);
    const mk = fields(m[3]);
    const [x1, y1, x2, y2, w, h] = ["x1", "y1", "x2", "y2", "w", "h"].map((k) => Number(box[k]));
    if (![x1, y1, x2, y2, w, h].every(Number.isFinite)) continue;
    mask ??= { width: w, height: h, data: new Uint8Array(w * h), boxes: [] };
    mask.boxes.push({ x1, y1, x2, y2, confidence: box.c ? Number(box.c) : undefined });

    const [rh, rw, ...rest] = (mk.data ?? "").split(",");
    const payload = rest.join(",");
    const rows = Number(rh);
    const cols = Number(rw);
    if (!rows || !cols || !payload) continue;
    let raster: Uint8Array;
    try {
      raster = decodeMaskToRaster({
        encoding: payload.startsWith("~") ? "lossless" : "one_bit",
        payload,
        width: cols,
        height: rows,
      });
    } catch {
      continue;
    }
    // Scale the raster (rows × cols) onto the inclusive box, nearest-neighbour.
    const bw = x2 - x1 + 1;
    const bh = y2 - y1 + 1;
    for (let y = 0; y < bh; y++) {
      const ry = Math.min(rows - 1, Math.floor((y * rows) / bh));
      const row = (y1 + y) * w;
      for (let x = 0; x < bw; x++) {
        const rx = Math.min(cols - 1, Math.floor((x * cols) / bw));
        if (raster[ry * cols + rx]) mask.data[row + x1 + x] = 1;
      }
    }
  }
  return mask;
}

export function coverage(mask: Mask | null): number {
  if (!mask) return 0;
  let n = 0;
  for (const v of mask.data) n += v;
  return n / mask.data.length;
}

/** Is the normalized point (u, v ∈ [0,1], v down) inside the mask? */
export function hit(mask: Mask, u: number, v: number): boolean {
  const x = Math.floor(u * mask.width);
  const y = Math.floor(v * mask.height);
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
  return mask.data[y * mask.width + x] === 1;
}

/** Centre of the largest box, normalized, for placing a tap hint. */
export function anchor(mask: Mask): { u: number; v: number } | null {
  const big = [...mask.boxes].sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1))[0];
  return big ? { u: (big.x1 + big.x2) / 2 / mask.width, v: (big.y1 + big.y2) / 2 / mask.height } : null;
}

export async function loadMask(url: string | null): Promise<Mask | null> {
  if (!url) return null;
  const res = await fetch(url);
  return res.ok ? parseSam(await res.text()) : null;
}
