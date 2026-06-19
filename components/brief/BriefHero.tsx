"use client";

/**
 * BriefHero
 *
 * Cinematic Daily Brief hero with Earth backdrop.
 *
 * Hierarchy (pinned to lower portion of hero):
 *   DAILY BRIEF · timestamp
 *   Good afternoon, Jane.
 *   You're up to date.
 *   Here's what changed since your last visit.
 *   [Continue to Dashboard]  [View AI Analysis]   ← primary CTAs live here
 *
 * CTAs are placed directly under the hero status line so users who
 * already know their intent don't need to scroll past the brief cards.
 * Not shown for new_user (they use BriefNewUser CTAs instead).
 *
 * Hero region:
 *   The Earth backdrop swaps to a region-specific crop based on the
 *   viewer's resolved IANA timezone (lib/hero-region.ts) — no GPS, no
 *   permission prompt. Detection is client-only and runs in an effect
 *   after mount so the server-rendered HTML and the client's first paint
 *   match exactly (avoids a hydration mismatch); the default wide Earth
 *   shows for that first frame, then swaps in once detected. The viewer
 *   can override it for the session via the Region control in UserMenu's
 *   dropdown — that override is plain state in HeroRegionProvider, never
 *   persisted.
 *
 * Appearance:
 *   resolvedTheme comes from the app-wide ThemeProvider (Midnight Glass /
 *   Light Glass / System) and is passed straight into EarthBackground so
 *   the hero swaps to the matching light/dark regional crop.
 *
 * Controls:
 *   Appearance and Region used to live as standalone glass buttons in this
 *   hero's top-right corner. They were moved into UserMenu's dropdown
 *   (Daily Brief responsive polish pass) because the two controls competed
 *   for the same small slice of horizontal space the hero shares with
 *   BriefLayout's header, on both desktop and mobile. Region state is now
 *   read from HeroRegionProvider (a sibling-spanning context — see that
 *   file) instead of local component state.
 */

import Link from "next/link";
import { LayoutDashboard, Brain, ArrowRight } from "lucide-react";
import { EarthBackground } from "./EarthBackground";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useHeroRegion } from "./HeroRegionProvider";
import type { VisitState } from "@/lib/brief-types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month:   "short",
    day:     "numeric",
    year:    "numeric",
    hour:    "numeric",
    minute:  "2-digit",
  });
}

function greetVerb(state: VisitState): string {
  if (state === "new_user") return "Welcome to FinTracker";
  const h = new Date().getHours();
  if (h < 12) return "Good morning,";
  if (h < 17) return "Good afternoon,";
  return "Good evening,";
}

function extractFirstName(contextLine: string): string | null {
  const m = contextLine.match(/,\s+([A-Z][a-z]+)/);
  return m ? m[1] : null;
}

function statusLine(state: VisitState): string {
  switch (state) {
    case "new_user":   return "Let's build your financial picture.";
    case "immediate":  return "You're up to date.";
    case "short":      return "You're up to date.";
    case "day":        return "Here's your daily check-in.";
    case "away":       return "Welcome back.";
  }
}

function subLine(state: VisitState): string | null {
  if (state === "new_user" || state === "immediate") return null;
  return "Here's what happened since your last visit.";
}

// ── Hero CTAs ─────────────────────────────────────────────────────────────────
// Placed in the hero so the user never has to scroll to act.
// Intentionally lighter/smaller than a full CTA block — they live on the backdrop.

// Shared interaction recipe for both hero CTAs — they're sibling Atlas Glass
// controls, not a solid button + a ghost button. Hover lifts and brightens
// the glass (the brightness filter also reads as the specular edge "becoming
// clearer", per the design language's glass material guidance); press is a
// tactile scale(0.98), no spring/bounce easing (--ease-spring is reserved for
// toggle knobs, not button presses). Built independently of GlassPanel's own
// `interactive` prop so this exact transition list (transform + filter) is
// one declaration, not two competing ones. Reduced motion is already handled
// globally in app/globals.css (transition/animation durations collapse to
// ~0), so no extra handling is needed here.
const CTA_BASE =
  "relative inline-flex items-center justify-center gap-2 py-3 px-6 text-sm " +
  "transition-[transform,filter] duration-[var(--dur-base)] ease-[var(--ease-standard)] " +
  "hover:-translate-y-[1px] hover:[filter:brightness(1.12)] " +
  "active:scale-[0.98] active:duration-[var(--dur-instant)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

function HeroCTAs() {
  return (
    <div className="flex flex-col sm:flex-row gap-2.5 mt-7">
      {/* Primary — Meridian-tinted Atlas Glass, not a solid-blue button.
          A translucent Meridian wash sits over the standard thin-glass
          recipe (still backdrop-blurred/frosted, per GlassPanel) instead of
          a flat --meridian-600 fill, and a one-notch-higher elevation (e2 vs
          the secondary's e1) carries "this is primary" — no neon outer glow. */}
      <GlassPanel
        as={Link}
        href="/dashboard"
        depth="thin"
        radius="sm"
        elevation="e2"
        className={`group ${CTA_BASE} font-semibold text-[var(--text-primary)]`}
        style={{
          background:
            "linear-gradient(135deg, rgba(59,130,246,.30), rgba(37,99,235,.15)), var(--glass-thin)",
          border: "1px solid rgba(125,168,255,.34)",
        }}
      >
        {/* GlassPanel nests children one level deeper inside its own
            unstyled wrapper div — give icon/label/arrow their own inline-flex
            row so they lay out horizontally regardless (same fix as the
            secondary CTA below). */}
        <span className="relative z-10 inline-flex items-center justify-center gap-2">
          <LayoutDashboard className="w-4 h-4 shrink-0" />
          <span>Continue to Dashboard</span>
          <ArrowRight className="w-3.5 h-3.5 shrink-0 transition-transform duration-[var(--dur-base)] ease-[var(--ease-standard)] group-hover:translate-x-0.5" />
        </span>
      </GlassPanel>

      {/* Secondary — neutral Atlas Glass with the built-in "ai" glow recipe
          (meridian + brass corner bloom — GlassPanel's reserved AI-surface
          pairing) standing in for a flat accent color. Same height, padding,
          radius, icon size, gap, transition timing and press behavior as the
          primary via CTA_BASE — true sibling controls, differentiated only
          by tint and the quieter e1 elevation. */}
      <GlassPanel
        as={Link}
        href="/dashboard/analyze"
        depth="thin"
        radius="sm"
        elevation="e1"
        glow="ai"
        className={`${CTA_BASE} font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]`}
      >
        <span className="relative z-10 inline-flex items-center justify-center gap-2">
          <Brain className="w-4 h-4 shrink-0" />
          <span>View AI Analysis</span>
        </span>
      </GlassPanel>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface BriefHeroProps {
  visitState:  VisitState;
  contextLine: string;
  generatedAt: string;
}

export function BriefHero({ visitState, contextLine, generatedAt }: BriefHeroProps) {
  const firstName = extractFirstName(contextLine);
  const verb      = greetVerb(visitState);
  const isNewUser = visitState === "new_user";
  const status    = statusLine(visitState);
  const sub       = subLine(visitState);

  const { resolvedTheme } = useTheme();

  // Region (auto-detected, with optional manual override) now lives in
  // HeroRegionProvider so UserMenu's dropdown — a sibling, not a parent —
  // can read and set it too. See HeroRegionProvider.tsx.
  const { effectiveRegion } = useHeroRegion();

  return (
    <div
      className="relative w-full"
      style={{ height: "clamp(480px, 72vh, 820px)" }}
    >
      {/* Earth — bleeds to all four edges */}
      <EarthBackground region={effectiveRegion} theme={resolvedTheme} />

      {/* Hero text — pinned to the lower portion */}
      <div className="absolute inset-0 flex flex-col justify-end">
        <div className="px-6 md:px-10 xl:px-16 pb-10 md:pb-14 max-w-[1400px] mx-auto w-full">

          {/* DAILY BRIEF label + timestamp */}
          <div className="flex items-center gap-3 mb-5">
            <span className="text-[10px] font-bold tracking-[0.22em] uppercase text-[var(--meridian-400)]">
              Daily Brief
            </span>
            <span className="w-px h-3" style={{ background: "var(--border-hairline-strong)" }} />
            <span className="text-[10px] text-[var(--text-muted)] tracking-wide">
              {formatTimestamp(generatedAt)}
            </span>
          </div>

          {/* Primary greeting */}
          {isNewUser ? (
            <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold leading-none tracking-tight mb-4">
              <span className="text-[var(--text-primary)]">Welcome to </span>
              <span className="text-[var(--brass-300)]">FinTracker</span>
            </h1>
          ) : (
            <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold leading-none tracking-tight mb-4">
              <span className="text-[var(--text-primary)]">{verb}</span>
              {firstName && (
                <>
                  {" "}
                  <span className="text-[var(--brass-300)]">{firstName}.</span>
                </>
              )}
              {!firstName && <span className="text-[var(--text-primary)]">.</span>}
            </h1>
          )}

          {/* Status line */}
          <p className="text-2xl md:text-3xl font-medium text-[var(--text-primary)]/90 mb-2 leading-snug">
            {status}
          </p>

          {/* Sub line */}
          {sub && (
            <p className="text-sm md:text-base text-[var(--text-muted)] leading-relaxed">
              {sub}
            </p>
          )}

          {/* Hero CTAs — only for returning users */}
          {!isNewUser && <HeroCTAs />}
        </div>
      </div>
    </div>
  );
}
