// A measurable scale check for eras that keep their buildings: SAM finds "building" in the new image and it must
// overlap the photo's buildings. Spark's judgement alone let zoomed-out futures through (review, Bucharest 2126).
import { decodeMaskToRaster } from "@meta-sam/parser";

const GRID = 64; // sample points per side: plenty for an overlap score, cheap on Worker CPU
const RECORD = /\d+<\|box;([^|]*)\|><\|mask;([^|]*)\|>/g;

function fields(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dataAt = s.indexOf("data=");
  for (const part of (dataAt >= 0 ? s.slice(0, dataAt) : s).split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  if (dataAt >= 0) out.data = s.slice(dataAt + 5);
  return out;
}

/** SAM raw text → GRID×GRID occupancy, in normalized image coordinates. */
export function occupancy(raw: string): Uint8Array {
  const grid = new Uint8Array(GRID * GRID);
  for (const m of raw.matchAll(RECORD)) {
    const box = fields(m[1]);
    const mk = fields(m[2]);
    const [x1, y1, x2, y2, w, h] = ["x1", "y1", "x2", "y2", "w", "h"].map((k) => Number(box[k]));
    const [rh, rw, ...rest] = (mk.data ?? "").split(",");
    const payload = rest.join(",");
    const rows = Number(rh);
    const cols = Number(rw);
    if (![x1, y1, x2, y2, w, h, rows, cols].every(Number.isFinite) || !payload) continue;
    let raster: Uint8Array;
    try {
      raster = decodeMaskToRaster({ encoding: payload.startsWith("~") ? "lossless" : "one_bit", payload, width: cols, height: rows });
    } catch {
      continue;
    }
    for (let gy = 0; gy < GRID; gy++) {
      const py = ((gy + 0.5) / GRID) * h;
      if (py < y1 || py > y2) continue;
      const ry = Math.min(rows - 1, Math.floor(((py - y1) / (y2 - y1 + 1)) * rows));
      for (let gx = 0; gx < GRID; gx++) {
        const px = ((gx + 0.5) / GRID) * w;
        if (px < x1 || px > x2) continue;
        const rx = Math.min(cols - 1, Math.floor(((px - x1) / (x2 - x1 + 1)) * cols));
        if (raster[ry * cols + rx]) grid[gy * GRID + gx] = 1;
      }
    }
  }
  return grid;
}

/** Intersection over union of two occupancy grids; null when neither has anything to compare. */
export function iou(a: Uint8Array, b: Uint8Array): number | null {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    inter += a[i] & b[i];
    union += a[i] | b[i];
  }
  return union ? inter / union : null;
}
