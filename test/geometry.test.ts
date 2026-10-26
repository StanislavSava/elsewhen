import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { iou, occupancy } from "../worker/geometry";

// A real SAM 3.1 "building" result from a demo scene.
const raw = readFileSync("public/demo/temperate-krakow/mask-building.txt", "utf8");

describe("building overlap", () => {
  it("finds buildings in real SAM output", () => {
    expect(occupancy(raw).some(Boolean)).toBe(true);
  });
  it("is 1 for identical masks and null when both are empty", () => {
    const g = occupancy(raw);
    expect(iou(g, g)).toBe(1);
    expect(iou(new Uint8Array(g.length), new Uint8Array(g.length))).toBeNull();
  });
  it("drops when the buildings shift", () => {
    const g = occupancy(raw);
    const shifted = new Uint8Array(g.length);
    for (let i = 0; i < g.length - 16; i++) shifted[i + 16] = g[i]; // a quarter of the frame to the right
    expect(iou(g, shifted)!).toBeLessThan(0.9);
  });
});
