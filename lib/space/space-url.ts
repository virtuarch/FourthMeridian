/**
 * lib/space/space-url.ts
 *
 * SD-0A — the ONE canonical Space URL serialization core. Pure: no React, no
 * `window`. Every Space URL writer (the shell time hook, SpaceDashboard's tab /
 * metric sync, and the Transaction drawer opener) builds its next query string
 * here, so unrelated params are ALWAYS preserved and there is a single
 * serialization authority — no writer can clobber another's params.
 *
 * The known Space-scoped params are tab · perspective · metric · asof ·
 * compareto · preset · account · transaction. The core is deliberately
 * param-agnostic — it sets/deletes exactly the keys a caller names and leaves
 * every other key byte-for-byte untouched. The runtime seam
 * (components/space/shell/useSpaceUrl.ts) owns the browser History writes and the
 * single popstate listener; this module owns only the string arithmetic (tested
 * in lib/space/space-url.test.ts).
 */

/** The Space-scoped query params, for documentation + the read helpers. */
export const SPACE_URL_PARAMS = [
  "tab",
  "perspective",
  "metric",
  "asof",
  "compareto",
  "preset",
  "account",
  "transaction",
] as const;
export type SpaceUrlParam = (typeof SPACE_URL_PARAMS)[number];

/**
 * A set of param updates. `null` deletes the key; a string sets/overwrites it.
 * Keys not present in the update object are left exactly as they are — this is
 * the preserve-unrelated-params rule that keeps the authority non-clobbering.
 */
export type SpaceUrlUpdate = Record<string, string | null>;

/** Accept either `window.location.search` ("?a=1") or a bare query string. */
function normalizeSearch(search: string): string {
  return search.startsWith("?") ? search.slice(1) : search;
}

/**
 * Apply `updates` to a query string, preserving every unrelated param, and
 * return the canonical query string (no leading "?", "" when empty). Existing
 * keys keep their insertion order; newly-added keys append. Setting overwrites;
 * a `null` value removes. This is the single serialization authority every Space
 * URL writer routes through.
 */
export function applySpaceUrlUpdate(search: string, updates: SpaceUrlUpdate): string {
  const params = new URLSearchParams(normalizeSearch(search));
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}

/**
 * Build the full path (`pathname` or `pathname?query`) a writer hands to
 * History/router, from a base search string plus updates. Strips the "?" when
 * the resulting query is empty (no dangling `pathname?`).
 */
export function buildSpaceUrl(pathname: string, search: string, updates: SpaceUrlUpdate): string {
  const qs = applySpaceUrlUpdate(search, updates);
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Read a single param from a search string — the one read primitive. */
export function readSpaceParam(search: string, key: string): string | null {
  return new URLSearchParams(normalizeSearch(search)).get(key);
}
