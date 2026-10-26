import { describe, expect, it } from "vitest";
import { biomeFor } from "../worker/biome";

describe("biomeFor", () => {
  it.each([
    [{ country: "RO", latitude: "44.43" }, "temperate"],
    [{ country: "US", regionCode: "AZ", latitude: "33.4" }, "arid"],
    [{ country: "US", regionCode: "CA", latitude: "37.7" }, "temperate"],
    [{ country: "SA", latitude: "24.7" }, "arid"],
    [{ country: "IN", latitude: "19.07" }, "tropical"],
    [{ country: "BR", latitude: "-23.0" }, "tropical"],
    [{ country: "NO", latitude: "63.4" }, "cold"],
    [{ country: "GB", latitude: "51.5" }, "temperate"],
    [undefined, "temperate"],
  ] as const)("%o → %s", (cf, expected) => {
    expect(biomeFor(cf)).toBe(expected);
  });
});
