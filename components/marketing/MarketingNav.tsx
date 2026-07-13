/**
 * components/marketing/MarketingNav.tsx
 *
 * Server-only top navigation for the public landing pages. Logo → home,
 * a couple of section links, a "Sign in" link to the existing authenticated
 * /login route, and the primary "Request access" CTA.
 *
 * No "use client": these are plain links. Colors come from the globals.css
 * design tokens directly (never the app's client component library).
 */

import Link from "next/link";
import { Container } from "./Container";
import { Wordmark } from "./Wordmark";

const NAV_LINKS = [
  { label: "Security", href: "/security" },
  { label: "About", href: "/about" },
] as const;

export function MarketingNav() {
  return (
    <header
      className="sticky top-0 z-10 border-b backdrop-blur-md"
      style={{
        borderColor: "var(--border-hairline)",
        backgroundColor: "color-mix(in srgb, var(--bg-deep) 82%, transparent)",
      }}
    >
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link href="/" aria-label="Fourth Meridian home" className="shrink-0">
          <Wordmark />
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="hidden sm:inline-flex rounded-lg px-3 py-2 text-sm transition-colors hover:opacity-80"
              style={{ color: "var(--text-secondary)" }}
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/login"
            className="rounded-lg px-3 py-2 text-sm transition-colors hover:opacity-80"
            style={{ color: "var(--text-secondary)" }}
          >
            Sign in
          </Link>
          <Link
            href="/request-access"
            className="rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors"
            style={{ backgroundColor: "var(--meridian-600)", color: "#fff" }}
          >
            Request access
          </Link>
        </nav>
      </Container>
    </header>
  );
}
