"use client";

/**
 * components/space/shell/ShellContextRow.tsx
 *
 * Perspective shell — Container 1, Row A ("time & trust"). Absorbs the former
 * SharedHistoricalContext: the As Of date, a ⇄ swap affordance, the Compare To
 * date (with clear), and the shell-level Completeness / Evidence chips. The chips
 * are read-only this slice; S4 makes them interactive. Presentation only — every
 * mutation flows up through the canonical shell reducer.
 */

import { CalendarDays, ArrowLeftRight, ShieldCheck, FileSearch, X } from "lucide-react";

/** A completeness/trust summary for the shell — supplied only when it exists. */
export interface CompletenessSummary {
  /** User-facing label, e.g. "Reconstructed", "Observed". Never a tier name. */
  label: string;
  tone?: "neutral" | "positive" | "warning";
}

/** An evidence/provenance summary for the shell — supplied only when it exists. */
export interface EvidenceSummary {
  label: string;
}

interface Props {
  asOf: string;
  onAsOfChange: (value: string) => void;
  compareTo: string | null;
  onCompareToChange: (value: string | null) => void;
  /** Exchange As Of ↔ Compare To (disabled when there is no comparison). */
  onSwap: () => void;
  /** Today (YYYY-MM-DD) — the max selectable date; no future As Of. */
  today: string;
  completeness?: CompletenessSummary;
  evidence?: EvidenceSummary;
  className?: string;
}

const FIELD_CLASS =
  "bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-lg px-2.5 py-1.5 " +
  "text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-info)] " +
  "[color-scheme:dark]";

/** A read-only shell chip: an icon + label + value, or a muted placeholder. */
function ShellChip({
  icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  tone?: "neutral" | "positive" | "warning";
}) {
  const toneColor =
    value === undefined
      ? "var(--text-faint)"
      : tone === "positive"
        ? "var(--accent-positive)"
        : tone === "warning"
          ? "var(--accent-warning)"
          : "var(--text-secondary)";
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 bg-[var(--surface-inset)] border border-[var(--border-hairline)]"
      title={value === undefined ? `${label} — not yet available` : `${label}: ${value}`}
    >
      <span className="text-[var(--text-faint)]" aria-hidden>{icon}</span>
      <span className="text-[11px] font-medium text-[var(--text-muted)]">{label}</span>
      <span className="text-[11px] font-semibold tabular-nums" style={{ color: toneColor }}>
        {value ?? "—"}
      </span>
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
  completeness,
  evidence,
  className = "",
}: Props) {
  return (
    <div
      className={["flex flex-wrap items-center gap-2", className].join(" ")}
      aria-label="Time and trust context"
    >
      {/* As of — the shared valuation date (defaults to today). */}
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

      {/* Swap — exchange As Of ↔ Compare To (concept's ⇄ affordance). */}
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

      {/* Compare to — optional comparison date; none by default. */}
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

      {/* Shell-level trust surfaces — real envelope/provenance when present,
          neutral placeholder otherwise (never fabricated). */}
      <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
        <ShellChip icon={<ShieldCheck size={13} />} label="Completeness" value={completeness?.label} tone={completeness?.tone} />
        <ShellChip icon={<FileSearch size={13} />} label="Evidence" value={evidence?.label} />
      </div>
    </div>
  );
}
