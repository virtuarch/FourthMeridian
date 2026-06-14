"use client";

/**
 * BriefAttention
 *
 * "Needs Attention" — always rendered.
 * Clicking the panel opens AttentionModal (no route change).
 *
 * Healthy state (no items): green "Everything looks healthy today."
 * Alert state: up to 3 horizontal alert chips (non-interactive in the panel;
 *              full detail and links live inside the modal).
 *
 * Alert chips are display-only here. Interactive elements (links/buttons)
 * inside a role="button" container would be invalid HTML; they're in the modal.
 */

import { useState, useCallback } from "react";
import { ShieldCheck, AlertTriangle, ChevronRight } from "lucide-react";
import type { BriefSection, BriefItem, BriefTone } from "@/lib/brief-types";
import { AttentionModal } from "./AttentionModal";

// ── Tone styles ───────────────────────────────────────────────────────────────

const CHIP_BG: Record<BriefTone, string> = {
  positive: "bg-emerald-500/10 border-emerald-500/20",
  warning:  "bg-amber-500/10  border-amber-500/20",
  danger:   "bg-red-500/10    border-red-500/20",
  info:     "bg-blue-500/10   border-blue-500/20",
  neutral:  "bg-white/[0.05]  border-white/[0.08]",
};

const CHIP_TEXT: Record<BriefTone, string> = {
  positive: "text-emerald-300",
  warning:  "text-amber-300",
  danger:   "text-red-300",
  info:     "text-blue-300",
  neutral:  "text-gray-300",
};

const CHIP_VALUE: Record<BriefTone, string> = {
  positive: "text-emerald-400 font-semibold",
  warning:  "text-amber-400  font-semibold",
  danger:   "text-red-400    font-semibold",
  info:     "text-blue-400   font-semibold",
  neutral:  "text-white      font-semibold",
};

// ── Alert chip — display only, no interactive elements ───────────────────────

function AlertChip({ item }: { item: BriefItem }) {
  const tone = item.tone ?? "warning";
  return (
    <div className={`flex-1 min-w-0 rounded-xl border p-4 ${CHIP_BG[tone]}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${CHIP_TEXT[tone]}`} />
        <div className="min-w-0">
          <p className={`text-sm font-medium leading-snug ${CHIP_TEXT[tone]}`}>
            {item.label}
          </p>
          {item.detail && (
            <p className="text-xs text-gray-500 mt-0.5 leading-tight">{item.detail}</p>
          )}
          {item.value && (
            <p className={`text-sm mt-1 tabular-nums ${CHIP_VALUE[tone]}`}>{item.value}</p>
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

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={hasAlerts ? "Needs Attention — click to review issues" : "All healthy — click for details"}
        onClick={handleOpen}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpen(); } }}
        className="group relative rounded-2xl overflow-hidden cursor-pointer transition-transform duration-300 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
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

        <div className="relative z-10 px-6 md:px-8 py-5 md:py-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400/80" />
              <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-amber-400/80">
                Needs Attention
              </p>
            </div>
            <span className="flex items-center gap-1 text-[10px] text-gray-600 group-hover:text-gray-400 transition-colors">
              {hasAlerts ? "Review" : "Details"}
              <ChevronRight className="w-3 h-3" />
            </span>
          </div>

          {/* Healthy state */}
          {!hasAlerts && (
            <div className="flex items-center gap-3 py-3">
              <div className="w-8 h-8 rounded-full bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-emerald-300">Everything looks healthy today.</p>
                <p className="text-xs text-gray-500 mt-0.5">No issues detected across your accounts and assets.</p>
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
      </div>

      {/* Modal */}
      <AttentionModal
        open={modalOpen}
        onClose={handleClose}
        section={section}
      />
    </>
  );
}
