"use client";

/**
 * BriefSinceLastVisit
 *
 * "Since Your Last Visit" — horizontal 4-column glass panel.
 * Clicking the panel opens SinceLastVisitModal for detailed activity.
 *
 * Per-item hrefs are intentionally NOT rendered here:
 *   - The panel is itself interactive (opens modal)
 *   - Nesting links inside a clickable container is invalid HTML
 *   - Detail + navigation lives inside the modal instead
 *
 * Icon color follows the locked Fourth Meridian category semantics
 * (cash → meridian, goals → violet) except for net-worth deltas, whose
 * arrow follows the positive/negative tone (emerald/coral) since the icon
 * itself communicates direction, not the "net worth = white" identity.
 */

import { useState, useCallback } from "react";
import {
  TrendingUp,
  TrendingDown,
  Landmark,
  Target,
  Bell,
  Activity,
  Minus,
  ChevronRight,
} from "lucide-react";
import type { BriefSection, BriefItem } from "@/lib/brief-types";
import { SinceLastVisitModal } from "./SinceLastVisitModal";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { TONE_VALUE, TONE_ICON, CATEGORY_ICON, categoryFromItemId } from "@/components/atlas/tones";

// ── Icon map ──────────────────────────────────────────────────────────────────

function ItemIcon({ item }: { item: BriefItem }) {
  const category = categoryFromItemId(item.id);
  const tone     = item.tone ?? "neutral";
  const colorCls = category === "netWorth" ? TONE_ICON[tone] : CATEGORY_ICON[category];
  const cls      = `w-5 h-5 ${colorCls}`;

  if (category === "netWorth") {
    const isUp = item.value?.startsWith("+");
    return isUp ? <TrendingUp className={cls} /> : <TrendingDown className={cls} />;
  }
  if (category === "cash")    return <Landmark className={cls} />;
  if (category === "pending") return <Bell     className={cls} />;
  if (category === "goal")    return <Target   className={cls} />;
  return <Activity className={cls} />;
}

// ── Placeholder column ────────────────────────────────────────────────────────

function EmptyColumn() {
  return (
    <div className="flex flex-col gap-2 opacity-25">
      <Minus className="w-5 h-5 text-[var(--text-muted)]" />
      <div className="h-3 w-16 rounded bg-[var(--surface-hover-strong)]" />
      <div className="h-5 w-10 rounded bg-[var(--surface-hover-strong)]" />
      <div className="h-2.5 w-20 rounded bg-[var(--surface-hover-strong)]" />
    </div>
  );
}

// ── Item column ───────────────────────────────────────────────────────────────
// No per-item links — the panel is the interactive element, modal has detail

function ItemColumn({ item }: { item: BriefItem }) {
  const tone     = item.tone ?? "neutral";
  const valueCls = TONE_VALUE[tone];

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <ItemIcon item={item} />
      <p className="text-[11px] font-semibold tracking-wide uppercase text-[var(--text-muted)] mt-1">
        {item.label}
      </p>
      {item.value && (
        <p className={`text-xl leading-none tabular-nums ${valueCls}`}>
          {item.value}
        </p>
      )}
      {item.detail && (
        <p className="text-xs text-[var(--text-muted)] leading-tight">{item.detail}</p>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface BriefSinceLastVisitProps {
  section: BriefSection;
}

const TARGET_COLS = 4;

export function BriefSinceLastVisit({ section }: BriefSinceLastVisitProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const handleOpen  = useCallback(() => setModalOpen(true),  []);
  const handleClose = useCallback(() => setModalOpen(false), []);

  const items  = section.items ?? [];
  const padded = [
    ...items,
    ...Array.from({ length: Math.max(0, TARGET_COLS - items.length) }, () => null as null),
  ].slice(0, TARGET_COLS);

  return (
    <>
      {/* Clickable panel */}
      <GlassPanel
        as="div"
        role="button"
        tabIndex={0}
        aria-label="Since Your Last Visit — click to expand activity"
        onClick={handleOpen}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpen(); } }}
        depth="thin"
        elevation="e3"
        radius="lg"
        interactive
        className="group cursor-pointer px-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      >
        {/* Hover brightening overlay */}
        <div className="absolute inset-0 bg-transparent group-hover:bg-[var(--surface-hover)] transition-colors duration-300 pointer-events-none z-0" />

        {/* Header strip */}
        <div
          className="relative z-10 flex items-center justify-between px-6 md:px-8 pt-5 pb-3"
          style={{ borderBottom: "1px solid var(--border-hairline)" }}
        >
          <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-[var(--meridian-400)]/90">
            {section.title}
          </p>
          <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors">
            View activity
            <ChevronRight className="w-3 h-3" />
          </span>
        </div>

        {/* 4-column grid */}
        <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 divide-x divide-[var(--border-hairline)]">
          {padded.map((item, i) => (
            <div key={item?.id ?? `empty-${i}`} className="px-6 md:px-8 py-6">
              {item ? <ItemColumn item={item} /> : <EmptyColumn />}
            </div>
          ))}
        </div>
      </GlassPanel>

      {/* Modal */}
      <SinceLastVisitModal
        open={modalOpen}
        onClose={handleClose}
        section={section}
      />
    </>
  );
}
