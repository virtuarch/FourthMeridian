"use client";

/**
 * BriefInsight
 *
 * "Today's Insight" — wide premium card.
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

// ── Decorative right-side visualization ──────────────────────────────────────

function InsightDecoration() {
  return (
    <div className="absolute inset-0 flex items-center justify-end pr-6 pointer-events-none overflow-hidden">
      <svg
        viewBox="0 0 220 160"
        className="w-56 h-40 opacity-[0.12]"
        xmlns="http://www.w3.org/2000/svg"
      >
        <polyline
          points="10,130 40,110 65,90 90,100 115,70 140,55 165,40 195,25"
          fill="none"
          stroke="#38bdf8"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polygon
          points="10,130 40,110 65,90 90,100 115,70 140,55 165,40 195,25 195,150 10,150"
          fill="url(#insightGrad)"
        />
        {([[10,130],[40,110],[65,90],[90,100],[115,70],[140,55],[165,40],[195,25]] as [number,number][]).map(([x,y], i) => (
          <circle key={i} cx={x} cy={y} r="3" fill="#38bdf8" />
        ))}
        <line x1="10" y1="80" x2="195" y2="80" stroke="#94a3b8" strokeWidth="0.8" strokeDasharray="5,4" />
        {[40,80,120,160].map(x => (
          <line key={x} x1={x} y1="20" x2={x} y2="145" stroke="#94a3b8" strokeWidth="0.4" />
        ))}
        <defs>
          <linearGradient id="insightGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#38bdf8" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0"    />
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

  return (
    <Link
      href={dest}
      className="group relative block rounded-2xl overflow-hidden transition-transform duration-300 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      style={{
        backdropFilter: "blur(28px) saturate(140%)",
        WebkitBackdropFilter: "blur(28px) saturate(140%)",
        background: "rgba(8,14,28,0.34)",
        border: "1px solid rgba(125,180,255,0.12)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 24px 80px rgba(0,0,0,0.38), 0 0 60px rgba(37,99,235,0.08)",
      }}
    >
      {/* Hover brightening overlay */}
      <div className="absolute inset-0 rounded-2xl bg-white/0 group-hover:bg-white/[0.025] transition-colors duration-300 pointer-events-none z-0" />

      {/* Decorative right side — behind content */}
      <InsightDecoration />

      {/* Content */}
      <div className="relative z-10 flex flex-col md:flex-row">

        {/* Left: text */}
        <div className="flex-1 px-6 md:px-8 py-6 md:py-7">
          {/* Label */}
          <div className="flex items-center gap-2 mb-4">
            <Lightbulb className="w-4 h-4 text-cyan-400/80" />
            <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-cyan-400/80">
              Today&apos;s Insight
            </p>
          </div>

          {/* Insight body */}
          <p className="text-sm md:text-base text-gray-200 leading-relaxed mb-5 max-w-xl">
            {section.body ?? "No insights available yet. Connect accounts to start receiving personalized analysis."}
          </p>

          {/*
            CTA indicator — styled as a link visually, but is a <span>
            because the whole card is already an <a> (Link).
            Nesting <a> inside <a> is invalid HTML.
          */}
          <span className="inline-flex items-center gap-1.5 text-sm text-blue-400 group-hover:text-blue-300 font-medium transition-colors">
            {section.actionLabel ?? "View AI Analysis"}
            <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>

        {/* Right: spacer so the decoration shows */}
        <div className="hidden md:block w-56 shrink-0" />
      </div>
    </Link>
  );
}
