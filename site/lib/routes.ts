/**
 * Every page this site serves — the sitemap's source and the route-inventory
 * test's expectation. Adding a page means adding it here.
 */
export const SITE_ROUTES = [
  "/",
  "/about",
  "/security",
  "/request-access",
  "/terms",
  "/privacy",
  "/legal/ai",
] as const;

export type SiteRoute = (typeof SITE_ROUTES)[number];
