"use client";

/**
 * AtlasLiquidCta — first-class Atlas **Liquid** CTA material (button-shaped).
 *
 * A rare premium accent (Daily Brief hero CTAs only). Atlas Glass remains the
 * default; useAtlasLiquid() picks Liquid vs the Glass fallback at the call-site.
 * Does NOT replace GlassButton/GlassPanel.
 *
 * Content lives as CHILDREN of the vendored LiquidGlassCard, composited over its
 * WebGL canvas; the whole thing is wrapped in a next/link for real navigation.
 *
 * Fourth Meridian integration only: the Link wrapper, CTA-sized geometry, and
 * hover/press + focus (Atlas tokens, motion-safe).
 *
 * Material vendored from @ogtirth/liquid-glass-oss (MIT); see
 * components/atlas/vendor/liquid-glass/VENDORED.md.
 */

import Link from "next/link";
import { ReactNode } from "react";
import { LiquidGlassCard } from "@/components/atlas/vendor/liquid-glass";
import "@/components/atlas/vendor/liquid-glass/card.css";

const DEFAULT_BG = "/oval-world.png";

// Production material. `radius: 10` (geometry) matches --radius-sm — the corner
// is shader-drawn, so a small radius keeps the short CTA a rounded rectangle,
// not a pill.
const SETTINGS = { refraction: 0.5, chromaticAberration: 0.12, radius: 10 };

export function AtlasLiquidCta({
  href,
  ariaLabel,
  backgroundImage = DEFAULT_BG,
  children,
}: {
  href: string;
  ariaLabel: string;
  backgroundImage?: string;
  children: ReactNode;
}) {
  return (
    <>
      {/* GEOMETRY ONLY — free the library's min-height:220px and set the CTA's
          vertical padding (~py-3); keep the 24px horizontal content padding
          (≈ px-6). Corner radius is settings.radius (no CSS radius exists). */}
      <style>{`
        .atlas-liquid-cta .lg-card { min-height: 0; }
        .atlas-liquid-cta .lg-card__content { padding-top: 12px; padding-bottom: 12px; }
      `}</style>
      <Link
        href={href}
        aria-label={ariaLabel}
        className={
          "atlas-liquid-cta block w-full no-underline sm:w-auto rounded-[10px] " +
          "transition-transform duration-[var(--dur-base)] ease-[var(--ease-standard)] " +
          "motion-safe:hover:-translate-y-[1px] " +
          "motion-safe:active:translate-y-0 motion-safe:active:scale-[0.97] active:duration-[var(--dur-instant)] " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] " +
          "focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        }
      >
        <LiquidGlassCard backgroundImage={backgroundImage} variant="frosted" settings={SETTINGS} className="w-full sm:w-auto">
          <span className="inline-flex items-center justify-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            {children}
          </span>
        </LiquidGlassCard>
      </Link>
    </>
  );
}
