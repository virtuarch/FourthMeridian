import type { MetadataRoute } from "next";
import { PUBLIC_CONFIG } from "@site/lib/public-config";

export const dynamic = "force-static";

/** Production site: index everything, point at the sitemap. Anything else: index nothing. */
export default function robots(): MetadataRoute.Robots {
  if (!PUBLIC_CONFIG.indexable) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${PUBLIC_CONFIG.siteOrigin}/sitemap.xml`,
    host: PUBLIC_CONFIG.siteOrigin,
  };
}
