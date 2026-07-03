"use client";

/**
 * AtlasLiquidCard — first-class Atlas **Liquid** card material.
 *
 * A rare premium accent (Daily Brief flagship cards only). Atlas Glass
 * (GlassPanel) remains the default material and the capability fallback — see
 * useAtlasLiquid(). This does NOT replace GlassPanel/DataCard.
 *
 * Content lives as CHILDREN of the vendored LiquidGlassCard, composited over its
 * WebGL canvas. No Atlas frost/shimmer/glow/bevel/border/hover-overlay — callers
 * supply only crisp content.
 *
 * Two clickable modes:
 *   - `href`    → next/link navigation (e.g. Today's Insight → /dashboard/analyze)
 *   - `onClick` → role="button" that opens a modal (Since Last Visit / Attention);
 *                 Enter/Space activate; the modal stays a sibling at the call-site.
 *   - neither   → static card.
 *
 * Fourth Meridian integration: the click wrapper, hover/press + focus (Atlas
 * tokens, motion-safe), a restrained contrast scrim, and GEOMETRY — free the
 * library's floating-panel sizing (width:min(380px,100%), min-height:220px) so
 * the card fills the column, and zero the card's own content padding so each
 * card keeps its existing padding.
 *
 * Material vendored from @ogtirth/liquid-glass-oss (MIT); see
 * components/atlas/vendor/liquid-glass/VENDORED.md.
 */

import Link from "next/link";
import { KeyboardEvent, ReactNode } from "react";
import { LiquidGlassCard } from "@/components/atlas/vendor/liquid-glass";
import "@/components/atlas/vendor/liquid-glass/card.css";

const DEFAULT_BG = "/oval-world.png";

// Production material (the dev "prism"/strong diagnostic is dropped). Only
// `radius` is geometry (card corner ≈ --radius-lg).
const SETTINGS = { refraction: 0.5, chromaticAberration: 0.12, radius: 20 };

const SHELL =
  "atlas-liquid-card group block w-full no-underline rounded-[20px] " +
  "transition-transform duration-[var(--dur-base)] ease-[var(--ease-standard)] " +
  "motion-safe:hover:-translate-y-[1px] motion-safe:active:translate-y-0 " +
  "motion-safe:active:scale-[0.99] active:duration-[var(--dur-instant)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

const GEOMETRY_CSS =
  ".atlas-liquid-card .lg-card { width: 100%; min-height: 0; } " +
  ".atlas-liquid-card .lg-card__content { padding: 0; }";

export function AtlasLiquidCard({
  href,
  onClick,
  ariaLabel,
  backgroundImage = DEFAULT_BG,
  children,
}: {
  href?: string;
  onClick?: () => void;
  ariaLabel: string;
  backgroundImage?: string;
  children: ReactNode;
}) {
  const inner = (
    <LiquidGlassCard backgroundImage={backgroundImage} variant="frosted" settings={SETTINGS}>
      {/* Contrast scrim — content is already crisp DOM above the glass; this
          restrained backing lifts the data so it reads as real UI over the glass.
          Above the glass, below the content. No frost/shimmer/glare. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{ background: "rgba(6,9,17,0.32)" }}
      />
      {children}
    </LiquidGlassCard>
  );

  let wrapper: ReactNode;
  if (href) {
    wrapper = (
      <Link href={href} aria-label={ariaLabel} className={SHELL}>
        {inner}
      </Link>
    );
  } else if (onClick) {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    };
    wrapper = (
      <div
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={`${SHELL} cursor-pointer`}
      >
        {inner}
      </div>
    );
  } else {
    wrapper = (
      <div aria-label={ariaLabel} className={SHELL}>
        {inner}
      </div>
    );
  }

  return (
    <>
      <style>{GEOMETRY_CSS}</style>
      {wrapper}
    </>
  );
}
