import { describe, expect, it } from "vitest";
import { CHRONICLES } from "../src/shared/chronicles";
import { BIOMES, ERA_YEARS, GENERATED_YEARS, blendAt, positionToYear, yearToPosition } from "../src/shared/eras";

describe("symlog time mapping", () => {
  it("round-trips years through slider positions", () => {
    for (const y of [-1_000_000, -37_000, -500, 0, 1, 100, 1_000_000]) {
      expect(positionToYear(yearToPosition(y))).toBeCloseTo(y, 3);
    }
  });
  it("puts now in the middle and ±1M at the ends", () => {
    expect(yearToPosition(0)).toBe(0);
    expect(yearToPosition(1_000_000)).toBeCloseTo(1, 6);
    expect(yearToPosition(-1_000_000)).toBeCloseTo(-1, 6);
  });
});

describe("blendAt", () => {
  const years = [...ERA_YEARS];
  it("blends in slider space between neighbouring keyframes", () => {
    const p = yearToPosition(-37_000);
    const { a, b, t } = blendAt(p, years);
    expect([a, b]).toEqual([-1_000_000, -10_000]);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
  });
  it("skips missing keyframes", () => {
    const { a, b } = blendAt(yearToPosition(500), [-100, 0, 10_000]);
    expect([a, b]).toEqual([0, 10_000]);
  });
  it("clamps at the ends", () => {
    expect(blendAt(-1, years)).toEqual({ a: -1_000_000, b: -1_000_000, t: 0 });
    expect(blendAt(1, years)).toEqual({ a: 1_000_000, b: 1_000_000, t: 0 });
  });
});

describe("chronicles", () => {
  it("cover every generated year exactly once", () => {
    for (const c of Object.values(CHRONICLES)) {
      expect(c.eras.map((e) => e.year).sort((x, y) => x - y)).toEqual(GENERATED_YEARS);
    }
  });
  it("cite sources for every extinct creature and fill every biome", () => {
    for (const c of Object.values(CHRONICLES)) {
      for (const era of c.eras) {
        if (era.driver !== "biology") continue;
        for (const biome of BIOMES) {
          for (const f of era.biomes[biome].fauna) {
            if (f.kind === "extinct") expect(f.sources?.length, `${era.year} ${biome} ${f.name}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
