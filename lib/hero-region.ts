/**
 * lib/hero-region.ts
 *
 * Timezone → geographic region mapping for the Daily Brief hero backdrop.
 *
 * Presentation-only: picks which pre-rendered Earth image sits behind the
 * Daily Brief hero so the view feels "local" to the viewer — purely a
 * cosmetic touch, never a data source. Deliberately uses the browser's
 * resolved IANA timezone (Intl.DateTimeFormat().resolvedOptions().timeZone)
 * rather than geolocation:
 *   - no GPS / Geolocation API
 *   - no permission prompt
 *   - no network request
 *   - degrades silently to the default hero if the API is ever
 *     unavailable or the timezone doesn't map to one of the six regions
 *
 * No backend, schema, auth, or Plaid involvement — this only decides which
 * static asset EarthBackground renders.
 */

export type HeroRegion = "americas" | "europe" | "mena" | "africa" | "asia" | "australia";

/**
 * Default hero — used whenever detection fails, the API is unavailable, or
 * the resolved timezone doesn't map cleanly to one of the six regions
 * below (Antarctica, mid-Atlantic/Indian Ocean, Etc/*, etc.). This is the
 * original Daily Brief hero image, which already reads as a wide
 * Europe/MENA-centered view of Earth, so it's a natural fallback.
 */
export const DEFAULT_HERO_SRC = "/oval-world.png";

export const HERO_REGION_SRC: Record<HeroRegion, string> = {
  americas: "/hero/earth-americas.png",
  europe: "/hero/earth-europe.png",
  mena: "/hero/earth-mena.png",
  africa: "/hero/earth-africa.png",
  asia: "/hero/earth-asia.png",
  australia: "/hero/earth-australia.png",
};

/**
 * Light-mode ("Light Glass") counterparts of the six regional crops
 * above — same framing per region, lit for daytime instead of night.
 * Added for the Midnight/Light Glass appearance system; selection logic
 * lives in `heroSrcForRegion`, not here.
 */
export const HERO_REGION_SRC_LIGHT: Record<HeroRegion, string> = {
  americas: "/hero/earth-americas-light.png",
  europe: "/hero/earth-europe-light.png",
  mena: "/hero/earth-mena-light.png",
  africa: "/hero/earth-africa-light.png",
  asia: "/hero/earth-asia-light.png",
  australia: "/hero/earth-australia-light.png",
};

/**
 * Light-mode fallback when no region is detected/overridden. There is no
 * light counterpart of oval-world.png (DEFAULT_HERO_SRC) — that asset is a
 * night-side Earth shot (deep navy, city lights on black) that reads as
 * Midnight Glass regardless of which theme is active, so reusing it in
 * light mode would look broken. The Europe regional crop keeps the same
 * "Europe/MENA-centered" fallback framing the dark default uses, just lit
 * for daytime — a deliberate substitution, not a design change.
 */
export const DEFAULT_HERO_SRC_LIGHT = HERO_REGION_SRC_LIGHT.europe;

/** Resolved appearance mode — mirrors the app-wide theme system's two glass themes. */
export type HeroThemeMode = "dark" | "light";

export const HERO_REGION_LABEL: Record<HeroRegion, string> = {
  americas: "Americas",
  europe: "Europe",
  mena: "MENA",
  africa: "Africa",
  asia: "Asia",
  australia: "Australia",
};

export const HERO_REGIONS: HeroRegion[] = ["americas", "europe", "mena", "africa", "asia", "australia"];

// IANA zones in the Asia/* and Africa/* namespaces that are conventionally
// grouped under "Middle East & North Africa" rather than under the broader
// "Asia" or "africa" buckets. Everything else under Asia/* falls through to
// the general "asia" region; everything else under Africa/* falls through
// to the general "africa" region (see regionFromTimeZone below) — these
// zones stay MENA regardless of the Africa region's existence.
const MENA_ZONES = new Set<string>([
  // Middle East
  "Asia/Aden", "Asia/Amman", "Asia/Baghdad", "Asia/Bahrain", "Asia/Beirut",
  "Asia/Damascus", "Asia/Dubai", "Asia/Gaza", "Asia/Hebron", "Asia/Istanbul",
  "Asia/Jerusalem", "Asia/Kuwait", "Asia/Muscat", "Asia/Nicosia",
  "Asia/Qatar", "Asia/Riyadh", "Asia/Tehran",
  // North Africa
  "Africa/Cairo", "Africa/Tripoli", "Africa/Tunis", "Africa/Algiers",
  "Africa/Casablanca", "Africa/El_Aaiun",
]);

// IANA's Pacific/* namespace mixes US territories with Oceania. Anything
// not explicitly American here falls into the Australia/Oceania bucket.
const PACIFIC_AMERICAS_ZONES = new Set<string>([
  "Pacific/Honolulu", "Pacific/Guam", "Pacific/Saipan",
]);

/**
 * Maps an IANA timezone identifier (e.g. "America/New_York") to one of the
 * six hero regions, or null if it doesn't map cleanly to any of them.
 * Pure function — no browser APIs — so it's trivial to unit test.
 */
export function regionFromTimeZone(timeZone: string | undefined | null): HeroRegion | null {
  if (!timeZone) return null;

  // Checked before the continent switch so the North African/Middle
  // Eastern zones in MENA_ZONES stay "mena" — they never reach the
  // "Africa" case below.
  if (MENA_ZONES.has(timeZone)) return "mena";

  const continent = timeZone.split("/")[0];

  switch (continent) {
    case "America":
      return "americas";
    case "Europe":
      return "europe";
    case "Africa":
      return "africa";
    case "Australia":
      return "australia";
    case "Asia":
      return "asia";
    case "Pacific":
      return PACIFIC_AMERICAS_ZONES.has(timeZone) ? "americas" : "australia";
    default:
      // Atlantic/*, Indian/*, Antarctica/*, Etc/*, UTC...
      return null;
  }
}

/**
 * Detects the resolved region for the current browser. Client-only —
 * never call during SSR (the server has no notion of the visitor's
 * timezone). Returns null on any failure so callers fall back to
 * DEFAULT_HERO_SRC.
 */
export function detectHeroRegion(): HeroRegion | null {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return regionFromTimeZone(timeZone);
  } catch {
    return null;
  }
}

/**
 * Resolves a region (or null) to the hero image path to render, for the
 * given appearance mode. `mode` defaults to "dark" so existing callers
 * that only pass `region` keep their original (pre-theme-system) behavior
 * unchanged.
 */
export function heroSrcForRegion(
  region: HeroRegion | null | undefined,
  mode: HeroThemeMode = "dark",
): string {
  if (mode === "light") {
    if (!region) return DEFAULT_HERO_SRC_LIGHT;
    return HERO_REGION_SRC_LIGHT[region] ?? DEFAULT_HERO_SRC_LIGHT;
  }
  if (!region) return DEFAULT_HERO_SRC;
  return HERO_REGION_SRC[region] ?? DEFAULT_HERO_SRC;
}
