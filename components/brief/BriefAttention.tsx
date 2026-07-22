"use client";

/**
 * BriefAttention
 *
 * Always rendered; clicking the panel opens AttentionModal (no route change).
 *
 * Header copy/tone is state-aware so it never contradicts the body:
 *   - Items present  → "Needs Attention", coral warning tone, Review action.
 *   - Zero items     → "All Clear", emerald healthy tone, success icon,
 *                       no Review action (nothing to act on).
 * Alert state: up to 3 horizontal alert chips (non-interactive in the panel;
 *              full detail and links live inside the modal).
 *
 * Per the locked Fourth Meridian color semantics, "warning" surfaces use a
 * restrained Coral accent — never Brass/Amber, which is reserved for
 * Investments/Premium — so caution never teaches the wrong color
 * association.
 *
 * Alert chips are display-only here. Interactive elements (links/buttons)
 * inside a role="button" container would be invalid HTML; they're in the modal.
 */

import { useState, useCallback } from "react";
import { ShieldCheck, AlertTriangle, ChevronRight } from "lucide-react";
import type { BriefSection, BriefItem } from "@/lib/brief-types";
import { AttentionModal } from "./AttentionModal";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { TONE_CHIP_BG, TONE_TEXT, TONE_VALUE } from "@/components/atlas/tones";
import { AtlasLiquidCard } from "@/components/atlas/AtlasLiquidCard";
import { useAtlasLiquid } from "@/components/atlas/useAtlasLiquid";

// ── Alert chip — display only, no interactive elements ───────────────────────

function AlertChip({ item }: { item: BriefItem }) {
  const tone = item.tone ?? "warning";
  return (
    <div className={`flex-1 min-w-0 rounded-[var(--radius-md)] border p-4 ${TONE_CHIP_BG[tone]}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${TONE_TEXT[tone]}`} />
        <div className="min-w-0">
          <p className={`text-sm font-medium leading-snug ${TONE_TEXT[tone]}`}>
            {item.label}
          </p>
          {item.detail && (
            <p className="text-xs text-[var(--text-muted)] mt-0.5 leading-tight">{item.detail}</p>
          )}
          {item.value && (
            <p className={`text-sm mt-1 tabular-nums ${TONE_VALUE[tone]}`}>{item.value}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface BriefAttentionProps {
  section?: BriefSection;
}

export function BriefAttention({ section }: BriefAttentionProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const handleOpen  = useCallback(() => setModalOpen(true),  []);
  const handleClose = useCallback(() => setModalOpen(false), []);

  const items    = (section?.items ?? []).slice(0, 3);
  const hasAlerts = items.length > 0;

  const ariaLabel = hasAlerts
    ? "Needs Attention — click to review issues"
    : "All Clear — click for details";
  const liquid = useAtlasLiquid();

  // Shared crisp content. The hover-brightening overlay is Atlas-only and
  // OMITTED on the Liquid path (no Atlas glass stacked on LiquidGlassCard).
  const content = (
    <>
      {!liquid && (
        <div className="absolute inset-0 bg-transparent group-hover:bg-[var(--surface-hover)] transition-colors duration-300 pointer-events-none z-0" />
      )}

      <div className="relative z-10 px-6 md:px-8 py-5 md:py-6">
          {/* Header — tone flips between warning (coral) and healthy
              (emerald) based on whether there are any items, so the title/
              icon never contradict the body copy below it. */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              {hasAlerts
                ? <AlertTriangle className="w-4 h-4 text-[var(--coral-300)]/90" />
                : <ShieldCheck   className="w-4 h-4 text-[var(--emerald-400)]/90" />}
              <p
                className={[
                  "text-[10px] font-bold tracking-[0.18em] uppercase",
                  hasAlerts ? "text-[var(--coral-300)]/90" : "text-[var(--emerald-400)]/90",
                ].join(" ")}
              >
                {hasAlerts ? "Needs Attention" : "All Clear"}
              </p>
            </div>
            {/* Details action — only shown when there's something to review.
                In the healthy state there's nothing to act on, so the
                affordance is dropped rather than left dangling. */}
            {hasAlerts && (
              <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors">
                Review
                <ChevronRight className="w-3 h-3" />
              </span>
            )}
          </div>

          {/* Healthy state */}
          {!hasAlerts && (
            <div className="flex items-center gap-3 py-3">
              <div className="w-8 h-8 rounded-full bg-[var(--emerald-500)]/15 border border-[var(--emerald-500)]/25 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-4 h-4 text-[var(--emerald-400)]" />
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--emerald-300)]">Everything looks healthy today.</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">No issues detected across your accounts and assets.</p>
              </div>
            </div>
          )}

          {/* Alert chips — display only */}
          {hasAlerts && (
            <div className="flex flex-col sm:flex-row gap-3">
              {items.map(item => <AlertChip key={item.id} item={item} />)}
            </div>
          )}
        </div>
    </>
  );

  return (
    <>
      {/* Liquid supported → LiquidGlassCard material (opens the same modal). */}
      {liquid ? (
        <AtlasLiquidCard onClick={handleOpen} ariaLabel={ariaLabel}>
          {content}
        </AtlasLiquidCard>
      ) : (
        // Fallback → the Atlas Glass panel.
        <GlassPanel
          as="div"
          role="button"
          tabIndex={0}
          aria-label={ariaLabel}
          onClick={handleOpen}
          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpen(); } }}
          depth="thin"
          elevation="e3"
          radius="lg"
          interactive
          className="group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        >
          {content}
        </GlassPanel>
      )}

      {/* Modal — unchanged, shared by both paths */}
      <AttentionModal
        open={modalOpen}
        onClose={handleClose}
        section={section}
      />
    </>
  );
}
