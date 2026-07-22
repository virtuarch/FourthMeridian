/**
 * components/marketing/MarketingFooter.tsx
 *
 * Server-only footer for the public landing pages: legal links + copyright.
 */

import Link from "next/link";
import { Container } from "./Container";
import { SITE } from "@/content/marketing/copy";

const FOOTER_LINKS = [
  { label: "Security", href: "/security" },
  { label: "About", href: "/about" },
  { label: "Get Started", href: "/request-access" },
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
  { label: "AI disclosures", href: "/legal/ai" },
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
