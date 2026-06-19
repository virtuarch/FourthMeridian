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
import { TONE_TEXT, TONE_VALUE, TONE_CHIP_BG } from "@/components/atlas/tones";
import type { BriefSection, BriefItem, BriefTone } from "@/lib/brief-types";
import {
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  Info,
  ArrowRight,
} from "lucide-react";

function ToneIcon({ tone }: { tone: BriefTone }) {
  const cls = `w-4 h-4 shrink-0 ${TONE_TEXT[tone]}`;
  switch (tone) {
    case "danger":   return <AlertCircle   className={cls} />;
    case "warning":  return <AlertTriangle className={cls} />;
    case "info":     return <Info          className={cls} />;
    case "positive": return <ShieldCheck   className={cls} />;
    default:         return <Info          className={cls} />;
  }
}

// Semantic icon chip — circular tone-tinted glass background behind the
// tone icon, matching the chip language used across the rest of the brief.
function ToneIconChip({ tone }: { tone: BriefTone }) {
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${TONE_CHIP_BG[tone]}`}>
      <ToneIcon tone={tone} />
    </div>
  );
}

// ── Alert row ─────────────────────────────────────────────────────────────────
// Lives directly on the modal's own glass surface — no card, no border, no
// divider. Severity reads from the tone-tinted icon chip and tone-colored
// text alone; rows are separated purely by vertical rhythm (py-3.5).

function AlertRow({ item }: { item: BriefItem }) {
  const tone = item.tone ?? "warning";
  return (
    <div className="flex items-start gap-3 py-3.5">
      <ToneIconChip tone={tone} />
      <div className="flex-1 min-w-0 pt-0.5">
        <p className={`text-sm font-medium leading-snug ${TONE_TEXT[tone]}`}>
          {item.label}
        </p>
        {item.detail && (
          <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">{item.detail}</p>
        )}
        {item.value && (
          <p className={`text-sm mt-1.5 tabular-nums ${TONE_VALUE[tone]}`}>{item.value}</p>
        )}
      </div>
      {item.href && (
        <Link
          href={item.href}
          className="shrink-0 flex items-center gap-1 text-xs text-[var(--meridian-400)] hover:text-[var(--meridian-300)] transition-colors pt-0.5"
        >
          Fix <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}

// ── Healthy state ─────────────────────────────────────────────────────────────

function HealthyState() {
  return (
    <div className="flex flex-col items-center text-center py-6 gap-4">
      <div className="w-12 h-12 rounded-full bg-[var(--emerald-500)]/10 border border-[var(--emerald-500)]/20 flex items-center justify-center">
        <ShieldCheck className="w-6 h-6 text-[var(--emerald-400)]" />
      </div>
      <div>
        <p className="text-base font-semibold text-[var(--emerald-300)] mb-1">
          Everything looks healthy today.
        </p>
        <p className="text-sm text-[var(--text-muted)] max-w-xs mx-auto">
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
    <BriefModal open={open} onClose={onClose} title={hasItems ? "Needs Attention" : "All Clear"}>
      {/* Attention items or healthy state — rows sit directly on the modal's
          glass, no nested card */}
      {hasItems ? (
        <div className="flex flex-col mb-8">
          {items.map(item => <AlertRow key={item.id} item={item} />)}
        </div>
      ) : (
        <div className="mb-8">
          <HealthyState />
        </div>
      )}

      {/* Footer: Attention Center CTA — separated from the list by spacing
          alone, no divider line. */}
      <div>
        {ATTENTION_CENTER_LIVE ? (
          <Link
            href="/dashboard/attention"
            onClick={onClose}
            className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-[var(--radius-sm)] bg-[var(--surface-hover)] hover:bg-[var(--surface-hover-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm font-medium transition-colors border border-[var(--border-hairline-strong)]"
          >
            Open Attention Center
            <ArrowRight className="w-4 h-4" />
          </Link>
        ) : (
          <button
            disabled
            className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-[var(--radius-sm)] bg-[var(--surface-muted)] text-[var(--text-muted)]/60 text-sm font-medium border border-[var(--border-hairline)] cursor-not-allowed"
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
