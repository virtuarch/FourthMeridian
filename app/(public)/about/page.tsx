/**
 * app/(public)/about/page.tsx — the public about page.
 *
 * Server-only. Copy in content/marketing/copy.ts (ABOUT).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/marketing/PageHeader";
import { Container } from "@/components/marketing/Container";
import { ABOUT } from "@/content/marketing/copy";

export const metadata: Metadata = {
  title: "About — Fourth Meridian",
  description:
    "Why Fourth Meridian exists: one honest reading of your financial position, " +
    "built to be trusted more and looked at less.",
};

export default function AboutPage() {
  return (
    <>
      <PageHeader heading={ABOUT.heading} />

      <Container className="pb-8">
        <div className="max-w-2xl space-y-5">
          {ABOUT.paragraphs.map((paragraph, i) => (
            <p
              key={i}
              className="text-lg leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              {paragraph}
            </p>
          ))}
        </div>

        <div className="mt-10">
          <Link
            href={ABOUT.cta.href}
            className="inline-flex rounded-xl px-5 py-3 text-sm font-semibold transition-colors"
            style={{ backgroundColor: "var(--meridian-600)", color: "#fff" }}
          >
            {ABOUT.cta.label}
          </Link>
        </div>
      </Container>
    </>
  );
}
