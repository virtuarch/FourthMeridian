/**
 * app/(public)/page.tsx — the public home / hero.
 *
 * Route groups don't affect URLs, so this serves "/" once app/page.tsx's old
 * redirect to /dashboard/brief is removed (it is — see that file).
 *
 * The beta-access form lives on its own /request-access page (a cleaner,
 * linkable seam); the home page drives users there via CTAs rather than
 * inlining the form. All copy is in content/marketing/copy.ts.
 */

import Link from "next/link";
import { Hero } from "@/components/marketing/Hero";
import { FeatureGrid } from "@/components/marketing/FeatureGrid";
import { Container } from "@/components/marketing/Container";
import { HOME } from "@/content/marketing/copy";

export default function HomePage() {
  return (
    <>
      <Hero />
      <FeatureGrid />

      {/* Closing CTA band */}
      <section className="py-20">
        <Container>
          <div
            className="rounded-3xl border px-8 py-14 text-center"
            style={{
              borderColor: "var(--border-hairline)",
              backgroundColor: "var(--glass-ultrathin)",
            }}
          >
            <h2
              className="mx-auto max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl"
              style={{ color: "var(--text-primary)" }}
            >
              One clear reading of where you actually stand.
            </h2>
            <p
              className="mx-auto mt-4 max-w-xl text-base leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              Fourth Meridian is in a closed beta. Request access and we'll reach
              out when a spot opens.
            </p>
            <div className="mt-8">
              <Link
                href={HOME.primaryCta.href}
                className="inline-flex rounded-xl px-6 py-3 text-sm font-semibold transition-colors"
                style={{ backgroundColor: "var(--meridian-600)", color: "#fff" }}
              >
                {HOME.primaryCta.label}
              </Link>
            </div>
          </div>
        </Container>
      </section>
    </>
  );
}
