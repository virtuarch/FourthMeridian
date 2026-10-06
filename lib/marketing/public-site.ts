/**
 * lib/marketing/public-site.ts — the application's knowledge of the PUBLIC site's origin.
 *
 * Under the domain split the public website (site/, a separate static Vercel
 * project) and the authenticated application are different origins:
 *
 *                       PRODUCTION                PREVIEW
 *   public website      fourthmeridian.com        preview.fourthmeridian.com
 *   application         app.fourthmeridian.com    preview-app.fourthmeridian.com
 *
 * The application still contains its own copy of the marketing pages
 * (app/(public)/**, removed at domain-split Stage F). While the application is
 * ALSO the public host — Production on the apex today, local development — those
 * pages are served as before. Once NEXT_PUBLIC_SITE_URL names a public site,
 * the application stops being a second marketing site:
 *
 *   - "/" on the application means the application: it enters /dashboard (the
 *     proxy's authentication gate then sends a logged-out visitor to /login).
 *   - The marketing and legal pages 308 to the SAME path on the public site, so
 *     there is exactly one published copy of the Terms per environment.
 *   - /request-access stays here: it is the application's form (Turnstile +
 *     /api/access-request), and the public site links to it.
 *
 * NEXT_PUBLIC_SITE_URL is a PUBLIC origin, never a secret; it is inlined at build
 * time (the proxy runs on the edge). Unset ⇒ every function here is inert.
 *
 * SAFETY. The value must be a bare http(s) origin (no credentials, path, query
 * or fragment); anything else is treated as unset. A value equal to the
 * request's own origin is also inert — redirecting to ourselves would loop.
 * Only the fixed marketing paths below ever leave the application, and only to
 * this one configured origin with the request's own path and query: no part of
 * the destination host comes from the request.
 *
 * Pure: no imports. proxy.ts imports it and keeps a zero-dependency graph.
 */

/** Where "/" on the application goes once a public site exists. */
export const APP_ROOT_DESTINATION = "/dashboard";

/**
 * Marketing and legal pages the public site owns. A request for one of these
 * (or a sub-path) on the application is sent to the public site.
 */
export const PUBLIC_SITE_PATHS: readonly string[] = [
  "/about",
  "/legal",
  "/privacy",
  "/security",
  "/terms",
];

/** The validated public-site origin, or null when unset/invalid. */
export function parsePublicSiteOrigin(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

/** True when `pathname` is one of PUBLIC_SITE_PATHS or below one. */
export function isPublicSitePath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return PUBLIC_SITE_PATHS.some((base) => p === base || p.startsWith(`${base}/`));
}

export type PublicSiteRoute =
  | { kind: "none" }
  | { kind: "app-root"; location: string }
  | { kind: "public-site"; location: string };

/**
 * What the application does with a page request, given the configured public
 * site. `selfOrigin` is the origin the request was served on (null if unknown).
 * `location` is a path for "app-root" and an absolute URL on the public site
 * for "public-site".
 */
export function routePublicSiteRequest(input: {
  pathname: string;
  search: string;
  siteOrigin: string | null;
  selfOrigin: string | null;
}): PublicSiteRoute {
  const { pathname, search, siteOrigin, selfOrigin } = input;
  if (siteOrigin === null) return { kind: "none" };
  // Never redirect to ourselves (misconfiguration ⇒ inert, not a loop).
  if (selfOrigin !== null && selfOrigin.toLowerCase() === siteOrigin.toLowerCase()) return { kind: "none" };

  if (pathname === "/") return { kind: "app-root", location: APP_ROOT_DESTINATION };
  if (isPublicSitePath(pathname)) {
    return { kind: "public-site", location: `${siteOrigin}${pathname}${search}` };
  }
  return { kind: "none" };
}

/** Absolute link to a public-site page, or the same relative path when unset. */
export function publicSiteHref(path: `/${string}`, siteOrigin: string | null): string {
  if (path.startsWith("//")) throw new Error(`public-site path must not be protocol-relative: ${path}`);
  return siteOrigin === null ? path : `${siteOrigin}${path}`;
}

/** This build's configured public site (NEXT_PUBLIC_* is inlined at build time). */
export const PUBLIC_SITE_ORIGIN: string | null = parsePublicSiteOrigin(process.env.NEXT_PUBLIC_SITE_URL);
