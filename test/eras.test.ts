import { describe, expect, it } from "vitest";
import { CHRONICLES, DEFAULT_FORK, findEra, isShared, yearsFor } from "../src/shared/chronicles";
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
  it("our timeline covers every generated year exactly once", () => {
    expect(CHRONICLES[DEFAULT_FORK].eras.map((e) => e.year).sort((x, y) => x - y)).toEqual(GENERATED_YEARS);
  });
  it("each fork defines exactly its own eras: culture years after the divergence, plus its own now", () => {
    for (const [id, c] of Object.entries(CHRONICLES)) {
      if (id === DEFAULT_FORK) continue;
      const own = yearsFor(id).filter((y) => !isShared(id, y));
      expect(c.eras.map((e) => e.year).sort((x, y) => x - y), id).toEqual(own);
      expect(own).toContain(0);
      for (const y of yearsFor(id)) expect(findEra(id, y), `${id} ${y}`).toBeDefined();
    }
  });
  it("shares deep time and everything before the divergence", () => {
    expect(isShared("no-printing-press", -1_000_000)).toBe(true);
    expect(isShared("no-printing-press", -2_000)).toBe(true); // before 1440
    expect(isShared("no-printing-press", -500)).toBe(false); // 1526
    expect(isShared("no-printing-press", 1_000_000)).toBe(true);
    expect(isShared("library-of-alexandria", -2_000)).toBe(false); // 26 CE is after 48 BCE
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
