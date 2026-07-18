"use client";

/**
 * components/space/shell/ShellContextRow.tsx
 *
 * Perspective shell — Container 1, Row A ("time & trust"). As Of, a ⇄ swap
 * affordance, Compare To (with clear), and the shell-level Completeness /
 * Evidence chips. The chips are interactive (S4): when the active perspective's
 * envelope carries a reason/records, Completeness opens a popover and Evidence
 * opens a drawer; an absent envelope stays an inert "—" placeholder — no fake
 * counts, no percentages. Presentation only; every mutation flows up through the
 * canonical shell reducer.
 */

import { useState } from "react";
import { CalendarDays, ArrowLeftRight, ShieldCheck, FileSearch, X } from "lucide-react";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { CompletenessPopover } from "./CompletenessPopover";
import { EvidenceDrawer } from "./EvidenceDrawer";

interface Props {
  asOf: string;
  onAsOfChange: (value: string) => void;
  compareTo: string | null;
  onCompareToChange: (value: string | null) => void;
  /** Exchange As Of ↔ Compare To (disabled when there is no comparison). */
  onSwap: () => void;
  /** Today (YYYY-MM-DD) — the max selectable date; no future As Of. */
  today: string;
  /** The active perspective's trust envelope (empty ⇒ inert "—" chips). */
  envelope: PerspectiveEnvelope;
  /** Temporal-capability gates (default true) — hide the point-in-time controls
   *  for a lens that does not consume that axis (e.g. Cash Flow). The trust chips
   *  always render regardless. */
  showAsOf?: boolean;
  showCompareTo?: boolean;
  className?: string;
}

const FIELD_CLASS =
  "bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-lg px-2.5 py-1.5 " +
  "text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-info)] " +
  "[color-scheme:dark]";

/** A shell chip; a button when `onClick` is provided, otherwise a static chip. */
function ShellChip({
  icon,
  label,
  value,
  tone = "neutral",
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  tone?: "neutral" | "positive" | "warning";
  onClick?: () => void;
}) {
  const toneColor =
    value === undefined
      ? "var(--text-faint)"
      : tone === "positive"
        ? "var(--accent-positive)"
        : tone === "warning"
          ? "var(--accent-warning)"
          : "var(--text-secondary)";
  const inner = (
    <>
      <span className="text-[var(--text-faint)]" aria-hidden>{icon}</span>
      <span className="text-[11px] font-medium text-[var(--text-muted)]">{label}</span>
      <span className="text-[11px] font-semibold tabular-nums" style={{ color: toneColor }}>
        {value ?? "—"}
      </span>
    </>
  );
  const base = "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 bg-[var(--surface-inset)] border border-[var(--border-hairline)]";
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${label}: ${value ?? "—"}`}
        className={`${base} hover:border-[var(--border-hairline-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] transition-colors cursor-pointer`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={base} title={value === undefined ? `${label} — not yet available` : `${label}: ${value}`}>
      {inner}
    </div>
  );
}

export function ShellContextRow({
  asOf,
  onAsOfChange,
  compareTo,
  onCompareToChange,
  onSwap,
  today,
  envelope,
  showAsOf = true,
  showCompareTo = true,
  className = "",
}: Props) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const completeness = envelope.completeness;
  const evidence = envelope.evidence;
  const canPopover = !!completeness?.detail;
  const canDrawer = !!(evidence?.rows && evidence.rows.length > 0);

  return (
    <div
      className={["flex flex-wrap items-center gap-2", className].join(" ")}
      aria-label="Time and trust context"
    >
      {/* As of — the shared valuation date (defaults to today). Hidden for lenses
          that do not consume the point-in-time axis (temporalCapability.asOf none). */}
      {showAsOf && (
      <label className="inline-flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)]">
          <CalendarDays size={13} className="text-[var(--text-faint)]" aria-hidden />
          As of
        </span>
        <input
          type="date"
          value={asOf}
          max={today}
          onChange={(e) => onAsOfChange(e.target.value || today)}
          aria-label="As of date"
          className={FIELD_CLASS}
        />
      </label>
      )}

      {/* Swap — exchange As Of ↔ Compare To (only when both controls are shown). */}
      {showAsOf && showCompareTo && (
      <button
        type="button"
        onClick={onSwap}
        disabled={compareTo === null}
        aria-label="Swap As of and Compare to dates"
        title="Swap As of and Compare to"
        className="inline-flex items-center justify-center h-7 w-7 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-inset)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-hairline-strong)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <ArrowLeftRight size={13} aria-hidden />
      </button>
      )}

      {/* Compare to — optional comparison date; none by default. Hidden when the
          lens does not consume the compareTo axis (temporalCapability.compareTo none). */}
      {showCompareTo && (
      <label className="inline-flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-muted)]">Compare to</span>
        <span className="inline-flex items-center">
          <input
            type="date"
            value={compareTo ?? ""}
            max={today}
            onChange={(e) => onCompareToChange(e.target.value || null)}
            aria-label="Compare to date"
            className={`${FIELD_CLASS} ${compareTo ? "rounded-r-none" : ""}`}
          />
          {compareTo ? (
            <button
              type="button"
              onClick={() => onCompareToChange(null)}
              aria-label="Clear comparison date"
              className="inline-flex items-center px-1.5 py-1.5 rounded-l-none rounded-r-lg border border-l-0 border-[var(--border-hairline-strong)] bg-[var(--surface-inset)] text-[var(--text-faint)] hover:text-[var(--text-secondary)] transition-colors"
            >
              <X size={13} aria-hidden />
            </button>
          ) : (
            <span className="ml-1.5 text-[11px] text-[var(--text-faint)]">None</span>
          )}
        </span>
      </label>
      )}

      {/* Shell-level trust surfaces — interactive when the envelope has detail.
          Always rendered (trust is independent of the temporal-control gating). */}
      <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
        <ShellChip
          icon={<ShieldCheck size={13} />}
          label="Completeness"
          value={completeness?.label}
          tone={completeness?.tone}
          onClick={canPopover ? () => setPopoverOpen(true) : undefined}
        />
        <ShellChip
          icon={<FileSearch size={13} />}
          label="Evidence"
          value={evidence?.label}
          onClick={canDrawer ? () => setDrawerOpen(true) : undefined}
        />
      </div>

      {completeness && (
        <CompletenessPopover open={popoverOpen} onClose={() => setPopoverOpen(false)} completeness={completeness} />
      )}
      {evidence && (
        <EvidenceDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} evidence={evidence} />
      )}
    </div>
  );
}
