/**
 * app/(public)/security/page.tsx — the public security page.
 *
 * Server-only. Copy in content/marketing/copy.ts (SECURITY).
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/marketing/PageHeader";
import { Container } from "@/components/marketing/Container";
import { SECURITY } from "@/content/marketing/copy";

export const metadata: Metadata = {
  title: "Security — Fourth Meridian",
  description:
    "How Fourth Meridian protects your financial data: encrypted credentials, " +
    "two-factor authentication, least-privilege access, audit logging, and rate limiting.",
};

export default function SecurityPage() {
  return (
    <>
      <PageHeader heading={SECURITY.heading} intro={SECURITY.intro} />

      <Container className="pb-8">
        <div className="grid gap-4 sm:grid-cols-2">
          {SECURITY.pillars.map((pillar) => (
            <div
              key={pillar.title}
              className="rounded-2xl border p-6"
              style={{
                borderColor: "var(--border-hairline)",
                backgroundColor: "var(--glass-ultrathin)",
              }}
            >
              <h2
                className="text-base font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                {pillar.title}
              </h2>
              <p
                className="mt-2 text-sm leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                {pillar.body}
              </p>
            </div>
          ))}
        </div>

        <p
          className="mt-8 max-w-2xl text-sm leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          {SECURITY.footnote}
        </p>
      </Container>
    </>
  );
}
