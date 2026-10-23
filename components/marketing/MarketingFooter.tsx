/**
 * components/marketing/MarketingFooter.tsx
 *
 * Server-only footer for the public landing pages: legal links + copyright.
 */

import Link from "next/link";
import { Container } from "./Container";
import { SITE } from "@/content/marketing/copy";
import { PUBLIC_SITE_ORIGIN, publicSiteHref } from "@/lib/marketing/public-site";

// Site-owned pages are absolute on the public site once one is configured
// (domain split); /request-access is the application's own form.
const site = (p: `/${string}`) => publicSiteHref(p, PUBLIC_SITE_ORIGIN);
const FOOTER_LINKS = [
  { label: "Security", href: site("/security") },
  { label: "About", href: site("/about") },
  { label: "Get Started", href: "/request-access" },
  { label: "Terms", href: site("/terms") },
  { label: "Privacy", href: site("/privacy") },
  { label: "AI disclosures", href: site("/legal/ai") },
] as const;

export function MarketingFooter() {
  return (
    <footer
      className="border-t py-12"
      style={{ borderColor: "var(--border-hairline)" }}
    >
      <Container className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <nav className="flex flex-wrap gap-x-5 gap-y-2">
          {FOOTER_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm transition-colors hover:opacity-80"
              style={{ color: "var(--text-secondary)" }}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          © 2026 {SITE.name}. All rights reserved.
        </p>
      </Container>
    </footer>
  );
}
