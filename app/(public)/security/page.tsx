/**
 * app/(public)/security/page.tsx — the public security page.
 *
 * Server-only. Copy in content/marketing/copy.ts (SECURITY).
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/marketing/PageHeader";
import { Container } from "@/components/marketing/Container";
import { SECURITY, SUPPORT_EMAIL } from "@/content/marketing/copy";

export const metadata: Metadata = {
  title: "Security — Fourth Meridian",
  description:
    "How Fourth Meridian protects your financial data today: bcrypt-hashed passwords, " +
    "AES-256-GCM encrypted bank tokens, read-only connections, two-factor authentication, " +
    "audit logging, rate limiting, export and a seven-day deletion window.",
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
          {SECURITY.footnote}{" "}
          {/* The published support destination — a plain mailto. */}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2" style={{ color: "var(--text-secondary)" }}>
            {SUPPORT_EMAIL}
          </a>
        </p>
      </Container>
    </>
  );
}
