/**
 * lib/email/design/config.ts
 *
 * Where an email's public links and images point.
 *
 * SITE ORIGIN. Legal pages and the hosted logo live on the PUBLIC site
 * (site/, fourthmeridian.com). The application knows that origin only through
 * NEXT_PUBLIC_SITE_URL (lib/marketing/public-site.ts); when it is unset or
 * invalid, emails use the Production site origin. The constant is a copy of
 * site/lib/public-config.ts `PRODUCTION_SITE_ORIGIN` (application code may not
 * import from site/ — lib/public-site-boundary.test.ts); design.test.ts pins the
 * two as equal.
 *
 * SUPPORT CONTACT. There is no env var for a support address. The one published,
 * owner-confirmed support destination is `SUPPORT_EMAIL` in
 * content/marketing/copy.ts (also printed in the Privacy Policy), so the footer
 * reuses it rather than inventing one.
 */

import { parsePublicSiteOrigin } from "@/lib/marketing/public-site";
import { SUPPORT_EMAIL } from "@/content/marketing/copy";

/** Copy of site/lib/public-config.ts PRODUCTION_SITE_ORIGIN (parity-tested). */
export const PRODUCTION_SITE_ORIGIN = "https://fourthmeridian.com";

/** Path of the 128 px mark on the public site (site/public/brand/). */
export const LOGO_PATH = "/brand/fm-mark-dark-128.png";

/** Legal pages on the public site (all three exist: audit §7). */
export const LEGAL_LINKS = [
  { label: "Privacy Policy",   path: "/privacy" },
  { label: "Terms of Service", path: "/terms" },
  { label: "AI & data use",    path: "/legal/ai" },
] as const;

export interface EmailBrandConfig {
  /** Public site origin, no trailing slash. */
  siteOrigin: string;
  /** Support mailbox shown in the footer, or null to omit the line. */
  supportEmail: string | null;
}

/** The site origin for this build: NEXT_PUBLIC_SITE_URL when valid, else Production. */
export function resolveEmailSiteOrigin(raw: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): string {
  return parsePublicSiteOrigin(raw) ?? PRODUCTION_SITE_ORIGIN;
}

/** Default brand config for real sends. */
export function defaultEmailBrandConfig(): EmailBrandConfig {
  return { siteOrigin: resolveEmailSiteOrigin(), supportEmail: SUPPORT_EMAIL };
}
