/**
 * lib/marketing/acquisition.ts  (OPERATIONALIZATION P0 — beta acquisition facts)
 *
 * The ONE shape of acquisition context a beta-access request may carry, and the
 * pure functions that build it (browser) and bound it (server). Both sides run
 * the SAME allowlist, so the server never trusts the client to have filtered
 * and the client never sends what the server would drop.
 *
 * WHAT IT IS: bounded, operator-only context that cannot be recovered later —
 * which campaign or referrer brought a request, and which page of the public
 * site it was clicked from. It lands on BetaAccessRequestEvent.source
 * (app/api/access-request) and is read back only by GROWTH_REVENUE operators.
 *
 * WHAT IT IS NOT: a fingerprint. No IP, no user agent, no screen or timezone,
 * no visitor id, no raw header. Every value is a short string from an
 * allowlisted key; an unknown key is dropped, a long value is clipped, a
 * non-object is null.
 *
 * Pure (no imports), so it is loadable from the client form, the public route
 * and tests alike — and it stays inside the marketing seam
 * (lib/marketing-boundary.test.ts).
 */

/** Keys the client may send and the server will keep. Nothing else survives. */
export const ACQUISITION_SOURCE_KEYS = [
  "landingPath",   // the page the visitor clicked "Request access" from
  "referrerHost",  // host of a cross-origin referrer (never the full URL)
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
  "ref",
  "source",
] as const;

export type AcquisitionSourceKey = (typeof ACQUISITION_SOURCE_KEYS)[number];

/** The persisted shape. Every field optional; `country` is set SERVER-side only. */
export type AcquisitionSource = Partial<Record<AcquisitionSourceKey, string>> & {
  /** Two-letter ISO country from the edge (coarse, never an IP). Server-only. */
  country?: string;
};

/** Longest value kept per key. Clipped, never dropped, so a long campaign name still attributes. */
export const ACQUISITION_VALUE_MAX = 100;
/** Longest landing path kept. */
export const ACQUISITION_PATH_MAX = 200;

/** URL query key → source key, for the client side. `from` is what the public site forwards. */
const QUERY_TO_KEY: Readonly<Record<string, AcquisitionSourceKey>> = {
  utm_source:   "utmSource",
  utm_medium:   "utmMedium",
  utm_campaign: "utmCampaign",
  utm_content:  "utmContent",
  utm_term:     "utmTerm",
  ref:          "ref",
  source:       "source",
  from:         "landingPath",
};

const KEY_SET: ReadonlySet<string> = new Set(ACQUISITION_SOURCE_KEYS);

function clip(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** A site-relative path only: one leading "/", no query, fragment or whitespace. */
function isSitePath(p: string): boolean {
  return /^\/(?!\/)[^?#\s]*$/.test(p);
}

/**
 * BOUND an untrusted `source` (the request body's) to the allowlisted shape.
 * Returns null for a non-object or when nothing survives. `country` is NOT
 * accepted from the client — the server supplies it from the edge header.
 */
export function boundAcquisitionSource(input: unknown): AcquisitionSource | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const out: AcquisitionSource = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!KEY_SET.has(key) || typeof raw !== "string") continue;
    const k = key as AcquisitionSourceKey;
    const value = k === "landingPath"
      ? (isSitePath(raw.trim()) ? clip(raw, ACQUISITION_PATH_MAX) : "")
      : clip(raw, ACQUISITION_VALUE_MAX);
    if (value !== "") out[k] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Attach the server-side country (two letters) to a bounded source, or build one from it alone. */
export function withCountry(source: AcquisitionSource | null, country: string | null | undefined): AcquisitionSource | null {
  const cc = typeof country === "string" && /^[A-Za-z]{2}$/.test(country.trim()) ? country.trim().toUpperCase() : null;
  if (!cc) return source;
  return { ...(source ?? {}), country: cc };
}

/**
 * BUILD the client-side source from the page's URL and referrer.
 *
 *   search    window.location.search  (the public site forwards utm_* / ref /
 *             source and `from=<site path>`; see site/lib/acquisition.ts)
 *   referrer  document.referrer — same-origin ⇒ its PATH is the landing page
 *             (when no `from` was forwarded); cross-origin ⇒ only its HOST.
 *   origin    window.location.origin, to classify the referrer.
 */
export function acquisitionFromLocation(search: string, referrer: string, origin: string): AcquisitionSource | null {
  const raw: Record<string, string> = {};
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [queryKey, key] of Object.entries(QUERY_TO_KEY)) {
    const v = q.get(queryKey);
    if (v !== null && !(key in raw)) raw[key] = v;
  }
  if (referrer) {
    try {
      const r = new URL(referrer);
      if (r.origin === origin) {
        if (!("landingPath" in raw)) raw.landingPath = r.pathname;
      } else {
        raw.referrerHost = r.host;
      }
    } catch {
      // An unparsable referrer carries nothing worth keeping.
    }
  }
  return boundAcquisitionSource(raw);
}

/**
 * A short operator-facing summary ("via newsletter / spring · from /about ·
 * US"). Pure; the widget renders it beside a request.
 */
export function describeAcquisitionSource(source: AcquisitionSource | null | undefined): string | null {
  if (!source) return null;
  const parts: string[] = [];
  const via = [source.utmSource ?? source.source ?? source.ref, source.utmMedium, source.utmCampaign].filter(Boolean).join(" / ");
  if (via) parts.push(`via ${via}`);
  else if (source.referrerHost) parts.push(`from ${source.referrerHost}`);
  if (source.landingPath) parts.push(`page ${source.landingPath}`);
  if (source.referrerHost && via) parts.push(`ref ${source.referrerHost}`);
  if (source.country) parts.push(source.country);
  return parts.length > 0 ? parts.join(" · ") : null;
}
