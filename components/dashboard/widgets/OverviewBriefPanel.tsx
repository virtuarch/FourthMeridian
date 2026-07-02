"use client";

/**
 * OverviewBriefPanel
 *
 * Compact "AI Daily Brief" surface for the Overview tab's executive-summary
 * row — same AI motion identity (ai-shimmer, meridian+brass glow) as
 * components/brief/BriefInsight.tsx on the Daily Brief itself, condensed
 * into a slim card with a short bullet list pulled straight from the
 * existing AiAdvice record (lib/data/advice.ts via getLatestAdvice — the
 * `advice` prop already flowed into DashboardClient but went unused until
 * this pass). No new AI logic: same advice record, same numbered-list
 * parsing as components/dashboard/AdviceBanner.tsx's extractActions
 * (duplicated here since it's a tiny pure parser, not worth wiring a
 * cross-file import for).
 *
 * "View full brief" hands off to the existing, already-shipped Daily
 * Brief page — this card previews that page rather than standing up a
 * second, divergent AI surface.
 */

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { getGreeting, GREETING_PLACEHOLDER } from "@/lib/format";
import type { AiAdvice } from "@/types";

function extractActions(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.match(/^\s*\d+\.\s+/))
    .map((l) => l.replace(/^\s*\d+\.\s+/, "").replace(/\*\*/g, "").trim())
    .slice(0, 5);
}

export function OverviewBriefPanel({
  advice,
  firstName,
}: {
  advice: AiAdvice | null;
  firstName?: string;
}) {
  // SSR-safe time-of-day greeting — see lib/format.ts getGreeting() doc
  // comment for why this needs useSyncExternalStore rather than a plain
  // call during render.
  const greeting = useSyncExternalStore(
    () => () => {},
    () => getGreeting(),
    () => GREETING_PLACEHOLDER,
  );

  const actions = advice ? extractActions(advice.adviceText) : [];

  return (
    <GlassPanel depth="thin" elevation="e3" radius="lg" glow="ai" className="p-5 flex flex-col h-full">
      {/* AI motion identity — slow Meridian → Brass shimmer, never a spinner */}
      <div className="ai-shimmer" />

      <div className="relative z-10 flex flex-col h-full">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={14} className="text-[var(--meridian-400)]/90" />
          <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-[var(--meridian-400)]/90">
            AI Daily Brief
          </p>
        </div>

        <p className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          {greeting}
          {firstName ? `, ${firstName}.` : "."}
        </p>

        <div className="flex-1 min-h-0">
          {advice ? (
            actions.length > 0 ? (
              <ul className="space-y-2">
                {actions.slice(0, 4).map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-[var(--text-secondary)] leading-snug">
                    <span className="mt-1.5 w-1 h-1 rounded-full bg-[var(--meridian-400)] shrink-0" />
                    <span className="line-clamp-2">{a}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{advice.summary}</p>
            )
          ) : (
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              No insights yet. Connect accounts to start receiving personalized analysis.
            </p>
          )}
        </div>

        <Link
          href="/dashboard/brief"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--meridian-400)] hover:text-[var(--meridian-300)] transition-colors mt-4"
        >
          View full brief <ArrowRight size={12} />
        </Link>
      </div>
    </GlassPanel>
  );
}
