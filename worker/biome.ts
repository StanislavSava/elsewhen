// Coarse biome from Cloudflare's request.cf (IP-derived; no permission prompt). Users can override it.
import type { Biome } from "../src/shared/eras";

const ARID_COUNTRIES = new Set([
  "SA", "AE", "QA", "KW", "BH", "OM", "YE", "EG", "LY", "DZ", "IQ", "JO", "SY", "IR", "AF",
  "NE", "ML", "TD", "MR", "SD", "NA", "BW", "EH",
]);
// US states and Mexican/Australian regions that are mostly desert or semi-desert.
const ARID_REGIONS = new Set(["US-AZ", "US-NV", "US-NM", "US-UT", "MX-SON", "MX-CHH", "AU-NT", "AU-SA", "AU-WA"]);

export function biomeFor(cf: { country?: string; regionCode?: string; latitude?: string } | undefined): Biome {
  const country = cf?.country?.toUpperCase();
  const region = country && cf?.regionCode ? `${country}-${cf.regionCode.toUpperCase()}` : undefined;
  const lat = cf?.latitude ? Math.abs(Number(cf.latitude)) : Number.NaN;

  if ((country && ARID_COUNTRIES.has(country)) || (region && ARID_REGIONS.has(region))) return "arid";
  if (Number.isNaN(lat)) return "temperate";
  if (lat < 23.5) return "tropical";
  if (lat >= 58) return "cold";
  return "temperate";
}
