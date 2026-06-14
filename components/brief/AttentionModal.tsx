"use client";

/**
 * AttentionModal
 *
 * Shown when the user clicks the "Needs Attention" panel.
 *
 * Healthy state: confirmation message + placeholder Attention Center link
 * Alert state:  list of issues grouped by tone, each with optional action
 *
 * The "Open Attention Center" button links to /dashboard/attention which
 * is a future route — it is rendered as a disabled/coming-soon state for
 * now so we don't navigate to a 404.
 *
 * TODO: build /dashboard/attention page and remove the `disabled` flag
 *       from the footer button.
 */

import Link from "next/link";
import { BriefModal } from "./BriefModal";
import type { BriefSection, BriefItem, BriefTone } from "@/lib/brief-types";
import {
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  Info,
  ArrowRight,
} from "lucide-react";

// ── Tone helpers ──────────────────────────────────────────────────────────────

const CHIP_BORDER: Record<BriefTone, string> = {
  positive: "border-emerald-500/20",
  warning:  "border-amber-500/20",
  danger:   "border-red-500/25",
  info:     "border-blue-500/20",
  neutral:  "border-white/[0.08]",
};

const CHIP_LABEL: Record<BriefTone, string> = {
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

function ToneIcon({ tone }: { tone: BriefTone }) {
  const cls = "w-4 h-4 shrink-0";
  switch (tone) {
    case "danger":   return <AlertCircle   className={`${cls} text-red-400`}     />;
    case "warning":  return <AlertTriangle className={`${cls} text-amber-400`}   />;
    case "info":     return <Info          className={`${cls} text-blue-400`}    />;
    case "positive": return <ShieldCheck   className={`${cls} text-emerald-400`} />;
    default:         return <Info          className={`${cls} text-gray-400`}    />;
  }
}

// ── Alert row ─────────────────────────────────────────────────────────────────

function AlertRow({ item }: { item: BriefItem }) {
  const tone = item.tone ?? "warning";
  return (
    <div
      className={`rounded-xl border px-4 py-4 ${CHIP_BORDER[tone]}`}
      style={{ background: "rgba(255,255,255,0.02)" }}
    >
      <div className="flex items-start gap-3">
        <ToneIcon tone={tone} />
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium leading-snug ${CHIP_LABEL[tone]}`}>
            {item.label}
          </p>
          {item.detail && (
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">{item.detail}</p>
          )}
          {item.value && (
            <p className={`text-sm mt-1.5 tabular-nums ${CHIP_VALUE[tone]}`}>{item.value}</p>
          )}
        </div>
        {item.href && (
          <Link
            href={item.href}
            className="shrink-0 flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Fix <ArrowRight className="w-3 h-3" />
          </Link>
        )}
      </div>
    </div>
  );
}

// ── Healthy state ─────────────────────────────────────────────────────────────

function HealthyState() {
  return (
    <div className="flex flex-col items-center text-center py-6 gap-4">
      <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
        <ShieldCheck className="w-6 h-6 text-emerald-400" />
      </div>
      <div>
        <p className="text-base font-semibold text-emerald-300 mb-1">
          Everything looks healthy today.
        </p>
        <p className="text-sm text-gray-500 max-w-xs mx-auto">
          No issues detected across your accounts and assets.
        </p>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface AttentionModalProps {
  open: boolean;
  onClose: () => void;
  section?: BriefSection;
}

// TODO: set ATTENTION_CENTER_LIVE = true when /dashboard/attention is built
const ATTENTION_CENTER_LIVE = false;

export function AttentionModal({ open, onClose, section }: AttentionModalProps) {
  const items    = (section?.items ?? []);
  const hasItems = items.length > 0;

  return (
    <BriefModal open={open} onClose={onClose} title="Needs Attention">
      {/* Attention items or healthy state */}
      {hasItems ? (
        <div className="flex flex-col gap-3 mb-6">
          {items.map(item => <AlertRow key={item.id} item={item} />)}
        </div>
      ) : (
        <div className="mb-6">
          <HealthyState />
        </div>
      )}

      {/* Footer: Attention Center CTA */}
      <div className="pt-4 border-t border-white/[0.06]">
        {ATTENTION_CENTER_LIVE ? (
          <Link
            href="/dashboard/attention"
            onClick={onClose}
            className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-xl bg-white/[0.06] hover:bg-white/[0.10] text-gray-300 hover:text-white text-sm font-medium transition-colors border border-white/[0.09]"
          >
            Open Attention Center
            <ArrowRight className="w-4 h-4" />
          </Link>
        ) : (
          <button
            disabled
            className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-xl bg-white/[0.03] text-gray-700 text-sm font-medium border border-white/[0.05] cursor-not-allowed"
            title="Attention Center coming soon"
          >
            Open Attention Center
            <ArrowRight className="w-4 h-4" />
          </button>
          // TODO: remove disabled state when /dashboard/attention is built
        )}
      </div>
    </BriefModal>
  );
}
