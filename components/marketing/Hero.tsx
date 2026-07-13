/**
 * components/marketing/Hero.tsx
 *
 * Server-only home hero. Copy comes from content/marketing/copy.ts; colors
 * from the globals.css design tokens.
 */

import Link from "next/link";
import { Container } from "./Container";
import { HOME } from "@/content/marketing/copy";

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-20 pb-16 sm:pt-28 sm:pb-24">
      {/* Ambient brass glow — decorative, pointer-safe. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-60"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 0%, color-mix(in srgb, var(--brass-500) 16%, transparent) 0%, transparent 70%)",
        }}
      />
      <Container className="relative">
        <p
          className="text-sm font-semibold uppercase tracking-widest"
          style={{ color: "var(--brass-400)" }}
        >
          {HOME.eyebrow}
        </p>
        <h1
          className="mt-5 max-w-3xl text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl"
          style={{ color: "var(--text-primary)" }}
        >
          {HOME.heading}
        </h1>
        <p
          className="mt-6 max-w-2xl text-lg leading-relaxed sm:text-xl"
          style={{ color: "var(--text-secondary)" }}
        >
          {HOME.subheading}
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link
            href={HOME.primaryCta.href}
            className="rounded-xl px-5 py-3 text-sm font-semibold transition-colors"
            style={{ backgroundColor: "var(--meridian-600)", color: "#fff" }}
          >
            {HOME.primaryCta.label}
          </Link>
          <Link
            href={HOME.secondaryCta.href}
            className="rounded-xl border px-5 py-3 text-sm font-semibold transition-colors hover:opacity-80"
            style={{
              borderColor: "var(--border-hairline-strong)",
              color: "var(--text-primary)",
            }}
          >
            {HOME.secondaryCta.label}
          </Link>
        </div>
      </Container>
    </section>
  );
}
