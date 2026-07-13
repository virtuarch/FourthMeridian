/**
 * app/(public)/layout.tsx
 *
 * Layout for the public, unauthenticated landing pages. This is its own route
 * group so it does not affect URLs — (public)/page.tsx serves "/", security/
 * serves "/security", and so on. Wraps every marketing page in the shared nav +
 * footer chrome on the app's fixed dark surface.
 *
 * Server-only by design: the only client component reachable from here is the
 * beta-access form (components/marketing/RequestAccessForm). Everything else
 * consumes the globals.css design tokens directly and never touches the
 * authenticated app's client component library or any Prisma module — the seam
 * that lets this whole tree split into its own repo/deploy later
 * (investigation §3; enforced by lib/marketing-boundary.test.ts).
 */

import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

export const metadata: Metadata = {
  title: "Fourth Meridian — Your whole financial life, in one clear view",
  description:
    "Fourth Meridian brings your balances, investments, crypto, and debt into a " +
    "single, honest picture — organized into Spaces, with an ambient daily briefing.",
};

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex min-h-[100svh] flex-col"
      style={{ backgroundColor: "var(--bg-deep)", color: "var(--text-primary)" }}
    >
      <MarketingNav />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
