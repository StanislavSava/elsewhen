import { describe, expect, it } from "vitest";
import { lookFromTilt } from "../src/tilt";

describe("tilt look-around", () => {
  const base = { alpha: 350, beta: 85 };
  it("turning left shows the left, across the 0/360 seam", () => {
    expect(lookFromTilt(base, { alpha: 5, beta: 85 }, 0).x).toBeLessThan(0); // +15°, counter-clockwise
    expect(lookFromTilt(base, { alpha: 335, beta: 85 }, 0).x).toBeGreaterThan(0); // −15°
    expect(Math.abs(lookFromTilt(base, { alpha: 5, beta: 85 }, 0).x)).toBeCloseTo(15 / 22);
  });
  it("pointing the camera up looks up, pointing it down looks down (portrait)", () => {
    expect(lookFromTilt(base, { alpha: 350, beta: 95 }, 0).y).toBeLessThan(0);
    expect(lookFromTilt(base, { alpha: 350, beta: 75 }, 0).y).toBeGreaterThan(0);
    expect(lookFromTilt(base, { alpha: 350, beta: 95 }, 180).y).toBeGreaterThan(0);
  });
  it("in landscape, only pans sideways", () => {
    expect(lookFromTilt(base, { alpha: 350, beta: 120 }, 90).y).toBe(0);
  });
});
