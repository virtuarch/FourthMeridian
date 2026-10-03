import type { MetadataRoute } from "next";
import { PUBLIC_CONFIG } from "@site/lib/public-config";
import { SITE_ROUTES } from "@site/lib/routes";

export const dynamic = "force-static";

/** Every site page, on this deployment's own origin. Never an app URL. */
export default function sitemap(): MetadataRoute.Sitemap {
  return SITE_ROUTES.map((route) => ({ url: `${PUBLIC_CONFIG.siteOrigin}${route === "/" ? "" : route}` }));
}
