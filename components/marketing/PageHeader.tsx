/**
 * components/marketing/PageHeader.tsx
 *
 * Server-only heading block for inner landing pages (security, about, legal,
 * request-access). Optional eyebrow + heading + intro paragraph.
 */

import type { ReactNode } from "react";
import { Container } from "./Container";

export function PageHeader({
  eyebrow,
  heading,
  intro,
}: {
  eyebrow?: string;
  heading: string;
  intro?: ReactNode;
}) {
  return (
    <Container className="pt-16 pb-8 sm:pt-24">
      {eyebrow && (
        <p
          className="text-sm font-semibold uppercase tracking-widest"
          style={{ color: "var(--brass-400)" }}
        >
          {eyebrow}
        </p>
      )}
      <h1
        className="mt-3 max-w-3xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl"
        style={{ color: "var(--text-primary)" }}
      >
        {heading}
      </h1>
      {intro && (
        <p
          className="mt-5 max-w-2xl text-lg leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          {intro}
        </p>
      )}
    </Container>
  );
}
