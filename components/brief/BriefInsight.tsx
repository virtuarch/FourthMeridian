"use client";

/**
 * BriefInsight
 *
 * "Today's Insight" — the Daily Brief's AI surface. Per the Fourth Meridian
 * ambient-lighting rules, AI surfaces get a faint Meridian-blue + Brass
 * bloom (GlassPanel's `glow="ai"`) plus a slow, restrained shimmer sweep —
 * the AI motion identity (never a spinner).
 *
 * The entire card is a Link to /dashboard/analyze.
 *
 * The inner "View AI Analysis" text is a styled span (not a link)
 * because the outer card is already navigating there — nesting
 * <a> inside <a> is invalid HTML and causes hydration warnings.
 *
 * Left: icon, label, insight body, CTA indicator
 * Right: decorative faded chart SVG (static v1)
 */

import Link from "next/link";
import { Lightbulb, ArrowRight } from "lucide-react";
import type { BriefSection } from "@/lib/brief-types";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { AtlasLiquidCard } from "@/components/atlas/AtlasLiquidCard";
import { useAtlasLiquid } from "@/components/atlas/useAtlasLiquid";

// ── Decorative right-side visualization ──────────────────────────────────────

function InsightDecoration({ liquid }: { liquid: boolean }) {
  // Same chart, same Fourth Meridian palette. On the Glass card 14% opacity reads
  // as faint decoration on a flat dark surface; over the Liquid card's brighter,
  // textured refracted background that 14% washes out, so the Liquid path lifts
  // the overall opacity (only) to restore the original contrast. Tune this one
  // value if the chart should read stronger/softer.
  return (
    <div className="absolute inset-0 flex items-center justify-end pr-6 pointer-events-none overflow-hidden">
      <svg
        viewBox="0 0 220 160"
        className={`w-56 h-40 ${liquid ? "opacity-[0.45]" : "opacity-[0.14]"}`}
        xmlns="http://www.w3.org/2000/svg"
      >
        <polyline
          points="10,130 40,110 65,90 90,100 115,70 140,55 165,40 195,25"
          fill="none"
          style={{ stroke: "var(--meridian-400)" }}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polygon
          points="10,130 40,110 65,90 90,100 115,70 140,55 165,40 195,25 195,150 10,150"
          fill="url(#insightGrad)"
        />
        {([[10,130],[40,110],[65,90],[90,100],[115,70],[140,55],[165,40],[195,25]] as [number,number][]).map(([x,y], i) => (
          <circle key={i} cx={x} cy={y} r="3" style={{ fill: "var(--meridian-400)" }} />
        ))}
        <line x1="10" y1="80" x2="195" y2="80" style={{ stroke: "var(--text-muted)" }} strokeWidth="0.8" strokeDasharray="5,4" />
        {[40,80,120,160].map(x => (
          <line key={x} x1={x} y1="20" x2={x} y2="145" style={{ stroke: "var(--text-muted)" }} strokeWidth="0.4" />
        ))}
        <defs>
          <linearGradient id="insightGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="var(--meridian-400)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--meridian-400)" stopOpacity="0"    />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface BriefInsightProps {
  section: BriefSection;
}

export function BriefInsight({ section }: BriefInsightProps) {
  const dest = section.actionHref ?? "/dashboard/analyze";
  const actionLabel = section.actionLabel ?? "View AI Analysis";
  const liquid = useAtlasLiquid();

  // Shared crisp content for both the Glass card and the Liquid card. On the
  // Liquid path the Atlas-only effects (ai-shimmer + hover overlay) are OMITTED
  // (no old glass/frost/shimmer stacked on the Liquid material).
  const content = (
    <>
      {/* AI motion identity — Glass path only */}
      {!liquid && <div className="ai-shimmer" />}

      {/* Hover brightening overlay — Glass path only */}
      {!liquid && (
        <div className="absolute inset-0 bg-transparent group-hover:bg-[var(--surface-hover)] transition-colors duration-300 pointer-events-none z-0" />
      )}

      {/* Decorative right side — behind content */}
      <InsightDecoration liquid={liquid} />

      {/* Content */}
      <div className="relative z-10 flex flex-col md:flex-row">
        {/* Left: text — content owns its padding (LiquidGlassCard's own padding
            is zeroed), so it matches the Glass path on both flags. */}
        <div className="flex-1 px-6 md:px-8 py-6 md:py-7">
          <div className="flex items-center gap-2 mb-4">
            <Lightbulb className="w-4 h-4 text-[var(--meridian-400)]/90" />
            <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-[var(--meridian-400)]/90">
              Today&apos;s Insight
            </p>
          </div>

          <p className="text-sm md:text-base text-[var(--text-secondary)] leading-relaxed mb-5 max-w-xl">
            {section.body ?? "No insights available yet. Connect accounts to start receiving personalized analysis."}
          </p>

          {/* CTA indicator — a <span> (the whole card is already the <a>). */}
          <span className="inline-flex items-center gap-1.5 text-sm text-[var(--meridian-400)] group-hover:text-[var(--meridian-300)] font-medium transition-colors">
            {actionLabel}
            <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>

        {/* Right: spacer so the decoration shows */}
        <div className="hidden md:block w-56 shrink-0" />
      </div>
    </>
  );

  // Liquid supported → LiquidGlassCard material (no Atlas glass stacked on top).
  if (liquid) {
    return (
      <AtlasLiquidCard href={dest} ariaLabel={actionLabel}>
        {content}
      </AtlasLiquidCard>
    );
  }

  // Fallback → the Atlas Glass card.
  return (
    <GlassPanel
      as={Link}
      href={dest}
      depth="thin"
      elevation="e3"
      radius="lg"
      glow="ai"
      interactive
      className="group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
    >
      {content}
    </GlassPanel>
  );
}
