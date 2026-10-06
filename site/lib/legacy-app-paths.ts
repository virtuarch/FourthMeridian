/**
 * site/lib/legacy-app-paths.ts — application paths that used to be served on
 * THIS host, forwarded to the application origin.
 *
 * Before the domain split the application ran on the public host
 * (fourthmeridian.com in Production, preview.fourthmeridian.com in Preview).
 * Links to it still exist outside our control: password-reset, verification,
 * email-change and invite emails already sent, bookmarks, a browser's history.
 * After the public site takes the host those paths would 404 here.
 *
 * This site is a static export (no server, no middleware, and vercel.json cannot
 * vary by environment), so the forward happens in the not-found page: a small
 * inline script that, for a path under one of LEGACY_APP_PREFIXES, replaces the
 * location with the SAME path, query and fragment on the build's app origin.
 *
 * SAFETY:
 *   - The destination ORIGIN is the build-time NEXT_PUBLIC_APP_ORIGIN; nothing
 *     from the request can change it. The path is location.pathname, which on
 *     this origin always starts with "/", so origin + path stays on the app host.
 *   - Only fixed application prefixes forward; anything else is an ordinary 404.
 *     A protocol-relative-looking path ("//evil.com/login") does not match.
 *   - Nothing is read or written: no cookie, no storage, no network call. The
 *     visitor's browser simply navigates top-level, exactly as a link would.
 *   - /api is NOT forwarded: an API caller does not run this page's script, and
 *     the public site must never look like an API.
 *
 * Pure: no imports.
 */

/** First path segment of every application page that used to live here. */
export const LEGACY_APP_PREFIXES: readonly string[] = [
  "login",
  "register",
  "forgot-password",
  "reset-password",
  "verify-email",
  "confirm-email-change",
  "dashboard",
  "admin",
  "plaid-oauth-return",
  "merchant-ops",
];

/** The matcher the inline script uses; exported so tests exercise the same one. */
export function legacyAppPathPattern(): RegExp {
  return new RegExp(`^/(?:${LEGACY_APP_PREFIXES.join("|")})(?:/|$)`);
}

/**
 * The inline script for the not-found page. `appOrigin` is the validated bare
 * origin from PUBLIC_CONFIG; it is embedded as a JSON string literal.
 */
export function legacyAppForwardScript(appOrigin: string): string {
  const origin = JSON.stringify(appOrigin).replace(/</g, "\\u003c");
  const pattern = legacyAppPathPattern().source;
  return `(function(){var o=${origin},l=window.location,p=l.pathname;if(/${pattern}/.test(p))l.replace(o+p+l.search+l.hash);})();`;
}
