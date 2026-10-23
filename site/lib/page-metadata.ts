import type { Metadata } from "next";
import type { SiteRoute } from "./routes";

/** Title, description, canonical URL and Open Graph for one page. */
export function pageMetadata(route: SiteRoute, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: route },
    openGraph: { title, description, url: route, siteName: "Fourth Meridian", type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}
