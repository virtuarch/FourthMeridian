/**
 * site/lib/acquisition.ts — carry acquisition context across the CTA boundary.
 *
 * The public site is static and zero-authority: it stores nothing, reads no
 * cookie and calls no API. A visitor who arrived with `?utm_source=…` and
 * clicked "Get Started" used to land on the application's /request-access with
 * nothing — the campaign, the referrer and the page they clicked from all died
 * at the link, because APP_LINKS are fixed absolute URLs computed at build
 * time. The application is the only place that can RECORD anything, so the
 * site's job is to FORWARD, bounded.
 *
 * WHAT IS FORWARDED (and nothing else):
 *   - an ALLOWLIST of query keys already present on the current page's URL
 *     (the five utm_* fields, `ref`, `source`), each value clipped;
 *   - `from` = the site-relative PATH the visitor clicked from (no query, no
 *     fragment). Cross-origin referrers carry only the origin under this
 *     site's Referrer-Policy, so the path has to travel explicitly.
 *
 * WHAT IS NOT: no fingerprint, no timestamp, no visitor id, no storage of any
 * kind. Everything here is a pure string transformation of the current URL,
 * applied in the browser after hydration (components/AppLink.tsx); without
 * JavaScript the link is the plain build-time URL and still works.
 *
 * Pure: no imports, so Node can load it directly in tests/acquisition.test.mts.
 */

/** Query keys the site forwards. A key not here never crosses the boundary. */
export const ACQUISITION_QUERY_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ref",
  "source",
] as const;

/** The key carrying the site path the visitor clicked from. */
export const FROM_PATH_KEY = "from";

/** Longest value forwarded per key; longer values are clipped, never dropped. */
export const ACQUISITION_VALUE_MAX = 100;
/** Longest `from` path forwarded. */
export const FROM_PATH_MAX = 200;

/** Clip to `max` characters and drop control characters. */
function clip(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

/**
 * The acquisition parameters for the current page: allowlisted keys from
 * `search` (a `location.search`, with or without the leading "?"), clipped,
 * first occurrence wins; plus `from` = `pathname` when it is a site-relative
 * path. Returns an empty set when there is nothing to forward.
 */
export function acquisitionParams(search: string, pathname: string): URLSearchParams {
  const out = new URLSearchParams();
  const incoming = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of ACQUISITION_QUERY_KEYS) {
    const raw = incoming.get(key);
    if (raw === null) continue;
    const value = clip(raw.trim(), ACQUISITION_VALUE_MAX);
    if (value !== "") out.set(key, value);
  }
  // A site path only: starts with exactly one "/", no query, no fragment, no
  // protocol-relative shape. Anything else is simply not forwarded.
  if (/^\/(?!\/)[^?#\s]*$/.test(pathname)) {
    const from = clip(pathname, FROM_PATH_MAX);
    if (from !== "") out.set(FROM_PATH_KEY, from);
  }
  return out;
}

/**
 * `href` (an absolute application URL from lib/public-config.ts) with the
 * acquisition parameters appended. Parameters already on `href` are kept and
 * take precedence; a fragment on `href` is preserved. With nothing to forward,
 * `href` is returned unchanged.
 */
export function withAcquisition(href: string, search: string, pathname: string): string {
  const params = acquisitionParams(search, pathname);
  if ([...params.keys()].length === 0) return href;
  const hash = href.indexOf("#");
  const base = hash >= 0 ? href.slice(0, hash) : href;
  const fragment = hash >= 0 ? href.slice(hash) : "";
  const q = base.indexOf("?");
  const existing = new URLSearchParams(q >= 0 ? base.slice(q + 1) : "");
  for (const [k, v] of params) if (!existing.has(k)) existing.set(k, v);
  const path = q >= 0 ? base.slice(0, q) : base;
  return `${path}?${existing.toString()}${fragment}`;
}
