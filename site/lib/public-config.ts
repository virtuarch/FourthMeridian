/**
 * site/lib/public-config.ts — the ONE place the public site reads its
 * environment.
 *
 * The public site is a zero-authority security domain. It holds no secret, reads
 * no cookie and calls no API; the only things it knows about the world are two
 * PUBLIC origins:
 *
 *   NEXT_PUBLIC_SITE_ORIGIN — where this site is served (canonical URLs, robots,
 *                             sitemap, Open Graph).
 *   NEXT_PUBLIC_APP_ORIGIN  — the authenticated Fourth Meridian application.
 *                             Every "Sign in" / "Request access" / "Open" link is
 *                             an ordinary top-level navigation to this origin.
 *
 * plus two build-environment facts that are not secrets:
 *
 *   NODE_ENV   — "production" for `next build`, "development" for `next dev`.
 *   VERCEL_ENV — set by Vercel at build time ("production" | "preview" |
 *                "development"); absent locally and in CI.
 *
 * tests/public-env.test.mts proves no other file reads `process.env` and no
 * other name is read here.
 *
 * FAIL CLOSED. A production build with a missing, non-HTTPS, loopback or
 * path-carrying origin refuses to build rather than emitting links that point
 * somewhere unintended. Development gets explicit LOOPBACK defaults — never a
 * Production URL. A Vercel Preview build that names a Production origin is
 * refused: Preview must never send a visitor to Production.
 *
 * Pure: no imports, so Node can load it directly in the tests.
 */

export const PRODUCTION_SITE_ORIGIN = "https://fourthmeridian.com";
export const PRODUCTION_APP_ORIGIN = "https://app.fourthmeridian.com";

/** `next dev` defaults. The financial app's dev server is :3000; this site is :3001. */
export const DEV_APP_ORIGIN = "http://localhost:3000";
export const DEV_SITE_ORIGIN = "http://localhost:3001";

export interface PublicEnv {
  NEXT_PUBLIC_APP_ORIGIN?: string;
  NEXT_PUBLIC_SITE_ORIGIN?: string;
  NODE_ENV?: string;
  VERCEL_ENV?: string;
}

export interface PublicConfig {
  /** Origin of the authenticated application, e.g. https://app.fourthmeridian.com */
  appOrigin: string;
  /** Origin this site is served on, e.g. https://fourthmeridian.com */
  siteOrigin: string;
  /** Search engines may index this deployment (Production site origin only). */
  indexable: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseOrigin(name: string, raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`[site] ${name} is not an absolute URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`[site] ${name} must be http(s): ${JSON.stringify(raw)}`);
  }
  if (url.username || url.password) {
    throw new Error(`[site] ${name} must not carry credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`[site] ${name} must be a bare origin (no path, query or fragment): ${JSON.stringify(raw)}`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (production && (url.protocol !== "https:" || loopback)) {
    throw new Error(`[site] ${name} must be a public https origin in a production build: ${JSON.stringify(raw)}`);
  }
  if (!production && url.protocol === "http:" && !loopback) {
    throw new Error(`[site] ${name} may use http only for a loopback host: ${JSON.stringify(raw)}`);
  }
  return url.origin;
}

function present(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

export function resolvePublicConfig(env: PublicEnv): PublicConfig {
  const production = env.NODE_ENV === "production";
  const rawApp = present(env.NEXT_PUBLIC_APP_ORIGIN);
  const rawSite = present(env.NEXT_PUBLIC_SITE_ORIGIN);

  if (production && (rawApp === undefined || rawSite === undefined)) {
    throw new Error(
      "[site] A production build requires NEXT_PUBLIC_APP_ORIGIN and NEXT_PUBLIC_SITE_ORIGIN. " +
        "They are public origins, not secrets; set them per Vercel environment (site/README.md).",
    );
  }

  const appOrigin = rawApp === undefined ? DEV_APP_ORIGIN : parseOrigin("NEXT_PUBLIC_APP_ORIGIN", rawApp, production);
  const siteOrigin = rawSite === undefined ? DEV_SITE_ORIGIN : parseOrigin("NEXT_PUBLIC_SITE_ORIGIN", rawSite, production);

  if (new URL(appOrigin).host === new URL(siteOrigin).host) {
    throw new Error("[site] NEXT_PUBLIC_APP_ORIGIN and NEXT_PUBLIC_SITE_ORIGIN must be different hosts");
  }

  const vercelEnv = present(env.VERCEL_ENV);
  if (vercelEnv !== undefined && vercelEnv !== "production") {
    for (const [name, value] of [["NEXT_PUBLIC_APP_ORIGIN", appOrigin], ["NEXT_PUBLIC_SITE_ORIGIN", siteOrigin]] as const) {
      if (value === PRODUCTION_APP_ORIGIN || value === PRODUCTION_SITE_ORIGIN) {
        throw new Error(`[site] A ${vercelEnv} build must not name a Production origin (${name}=${value})`);
      }
    }
  }

  return {
    appOrigin,
    siteOrigin,
    indexable: siteOrigin === PRODUCTION_SITE_ORIGIN && (vercelEnv === undefined || vercelEnv === "production"),
  };
}

/** This build's configuration. Evaluated at build time (the site is a static export). */
export const PUBLIC_CONFIG: PublicConfig = resolvePublicConfig({
  NEXT_PUBLIC_APP_ORIGIN: process.env.NEXT_PUBLIC_APP_ORIGIN,
  NEXT_PUBLIC_SITE_ORIGIN: process.env.NEXT_PUBLIC_SITE_ORIGIN,
  NODE_ENV: process.env.NODE_ENV,
  VERCEL_ENV: process.env.VERCEL_ENV,
});

/** An absolute link into the authenticated application. `path` must be app-relative. */
export function appUrl(path: `/${string}`, config: PublicConfig = PUBLIC_CONFIG): string {
  if (path.startsWith("//")) throw new Error(`[site] app path must not be protocol-relative: ${path}`);
  return `${config.appOrigin}${path}`;
}

/** The application entry points the public site links to. Nothing else. */
export const APP_LINKS = {
  signIn: () => appUrl("/login"),
  open: () => appUrl("/dashboard"),
  requestAccess: () => appUrl("/request-access"),
} as const;
