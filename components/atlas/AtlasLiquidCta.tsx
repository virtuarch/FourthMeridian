"use client";

/**
 * AtlasLiquidCta — first-class Atlas **Liquid** CTA material (button-shaped).
 *
 * A rare premium accent (Daily Brief hero CTAs, Spaces "Create Space"). Atlas
 * Glass remains the default; useAtlasLiquid() picks Liquid vs the Glass fallback
 * at the call-site. Does NOT replace GlassButton/GlassPanel.
 *
 * Content lives as CHILDREN of the vendored LiquidGlassCard, composited over its
 * WebGL canvas. Two clickable modes:
 *   - `href`    → next/link navigation
 *   - `onClick` → a <button> (e.g. opening a modal)
 *
 * `fullWidth` (default true) is the Daily Brief behavior (full on mobile, auto on
 * desktop). `fullWidth={false}` is a compact, content-width CTA (e.g. a header
 * button). Optional `className` for positioning.
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

// GEOMETRY ONLY — free the library's min-height:220px and set the CTA's vertical
// padding (~py-3); keep the 24px horizontal content padding (≈ px-6). Corner
// radius is settings.radius (no CSS radius exists). The `--auto` modifier lets a
// non-full-width CTA shrink to its content instead of the library's 380px floor.
const GEOMETRY_CSS =
  ".atlas-liquid-cta .lg-card { min-height: 0; } " +
  ".atlas-liquid-cta .lg-card__content { padding-top: 12px; padding-bottom: 12px; } " +
  ".atlas-liquid-cta--auto .lg-card { width: auto; }";

const INTERACTION =
  "no-underline rounded-[10px] " +
  "transition-transform duration-[var(--dur-base)] ease-[var(--ease-standard)] " +
  "motion-safe:hover:-translate-y-[1px] " +
  "motion-safe:active:translate-y-0 motion-safe:active:scale-[0.97] active:duration-[var(--dur-instant)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

export function AtlasLiquidCta({
  href,
  onClick,
  ariaLabel,
  backgroundImage = DEFAULT_BG,
  fullWidth = true,
  className = "",
  children,
}: {
  href?: string;
  onClick?: () => void;
  ariaLabel: string;
  backgroundImage?: string;
  fullWidth?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const widthCls = fullWidth
    ? "block w-full sm:w-auto"
    : "inline-flex atlas-liquid-cta--auto";
  const shell = `atlas-liquid-cta ${widthCls} ${INTERACTION} ${className}`.trim();
  const cardCls = fullWidth ? "w-full sm:w-auto" : "w-auto";

  const inner = (
    <LiquidGlassCard backgroundImage={backgroundImage} variant="frosted" settings={SETTINGS} className={cardCls}>
      <span className="inline-flex items-center justify-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        {children}
      </span>
    </LiquidGlassCard>
  );

  return (
    <>
      <style>{GEOMETRY_CSS}</style>
      {href ? (
        <Link href={href} aria-label={ariaLabel} className={shell}>
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={onClick} aria-label={ariaLabel} className={`${shell} cursor-pointer`}>
          {inner}
        </button>
      )}
    </>
  );
}
