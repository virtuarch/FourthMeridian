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
import type { BriefSection, BriefItem, BriefTone } from "@/lib/brief-types";
import { SinceLastVisitModal } from "./SinceLastVisitModal";

// ── Icon map ──────────────────────────────────────────────────────────────────

function ItemIcon({ item }: { item: BriefItem }) {
  const tone = item.tone ?? "neutral";
  const colorCls =
    tone === "positive" ? "text-emerald-400" :
    tone === "warning"  ? "text-amber-400"   :
    tone === "danger"   ? "text-red-400"      :
    tone === "info"     ? "text-blue-400"     :
    "text-gray-400";

  const cls = `w-5 h-5 ${colorCls}`;

  if (item.id.startsWith("nw")) {
    const isUp = item.value?.startsWith("+");
    return isUp ? <TrendingUp className={cls} /> : <TrendingDown className={cls} />;
  }
  if (item.id.startsWith("account")) return <Landmark className={cls} />;
  if (item.id.startsWith("pending")) return <Bell     className={cls} />;
  if (item.id.startsWith("goal"))    return <Target   className={cls} />;
  return <Activity className={cls} />;
}

const TONE_VALUE: Record<BriefTone, string> = {
  positive: "text-emerald-400",
  warning:  "text-amber-400",
  danger:   "text-red-400",
  info:     "text-blue-400",
  neutral:  "text-white",
};

// ── Placeholder column ────────────────────────────────────────────────────────

function EmptyColumn() {
  return (
    <div className="flex flex-col gap-2 opacity-25">
      <Minus className="w-5 h-5 text-gray-500" />
      <div className="h-3 w-16 rounded bg-white/10" />
      <div className="h-5 w-10 rounded bg-white/10" />
      <div className="h-2.5 w-20 rounded bg-white/10" />
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
      <p className="text-[11px] font-semibold tracking-wide uppercase text-gray-400 mt-1">
        {item.label}
      </p>
      {item.value && (
        <p className={`text-xl font-bold leading-none tabular-nums ${valueCls}`}>
          {item.value}
        </p>
      )}
      {item.detail && (
        <p className="text-xs text-gray-500 leading-tight">{item.detail}</p>
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
      <div
        role="button"
        tabIndex={0}
        aria-label="Since Your Last Visit — click to expand activity"
        onClick={handleOpen}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpen(); } }}
        className="group relative rounded-2xl overflow-hidden px-0 cursor-pointer transition-transform duration-300 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
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

        {/* Header strip */}
        <div className="relative z-10 flex items-center justify-between px-6 md:px-8 pt-5 pb-3 border-b border-white/[0.06]">
          <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-cyan-400/80">
            {section.title}
          </p>
          <span className="flex items-center gap-1 text-[10px] text-gray-600 group-hover:text-gray-400 transition-colors">
            View activity
            <ChevronRight className="w-3 h-3" />
          </span>
        </div>

        {/* 4-column grid */}
        <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 divide-x divide-white/[0.06]">
          {padded.map((item, i) => (
            <div key={item?.id ?? `empty-${i}`} className="px-6 md:px-8 py-6">
              {item ? <ItemColumn item={item} /> : <EmptyColumn />}
            </div>
          ))}
        </div>
      </div>

      {/* Modal */}
      <SinceLastVisitModal
        open={modalOpen}
        onClose={handleClose}
        section={section}
      />
    </>
  );
}
