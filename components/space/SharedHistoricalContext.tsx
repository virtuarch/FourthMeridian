"use client";

/**
 * components/space/SharedHistoricalContext.tsx
 *
 * Perspective shell — Row 1 (Shared Historical Context). These controls sit
 * ABOVE the Perspective tabs and define the shared context every Perspective
 * inherits: the as-of valuation date, an optional comparison date, and the
 * shell-level Completeness and Evidence surfaces. Time is a property of the
 * shell, not of any single Perspective (the permanent Perspective Engine
 * hierarchy).
 *
 * Presentation only — this component holds no business logic and computes
 * nothing:
 *  - As of / Compare to carry the shared FinancialContext state (the A5-S1
 *    ComputeOptions.asOf contract). Perspectives whose historical engines are
 *    complete consume it; others ignore it for now.
 *  - Completeness / Evidence render an existing envelope / provenance summary
 *    when one is supplied, and a neutral, non-fabricated placeholder otherwise —
 *    a slot that cleanly accommodates the real DTOs when they arrive, never
 *    invented data.
 */

import { CalendarDays, ArrowLeftRight, ShieldCheck, FileSearch, X } from "lucide-react";

/** A completeness/trust summary for the shell — supplied only when it exists. */
export interface CompletenessSummary {
  /** User-facing label, e.g. "Reconstructed", "Complete". Never a tier name. */
  label: string;
  tone?: "neutral" | "positive" | "warning";
}

/** An evidence/provenance summary for the shell — supplied only when it exists. */
export interface EvidenceSummary {
  label: string;
}

interface Props {
  /** As-of date (YYYY-MM-DD). Defaults to today upstream. */
  asOf: string;
  onAsOfChange: (value: string) => void;
  /** Optional comparison date (YYYY-MM-DD) or null for none. */
  compareTo: string | null;
  onCompareToChange: (value: string | null) => void;
  /** Today (YYYY-MM-DD) — the max selectable date; no future as-of. */
  today: string;
  /** Surfaced when the completeness envelope exists; placeholder otherwise. */
  completeness?: CompletenessSummary;
  /** Surfaced when an evidence/provenance summary exists; placeholder otherwise. */
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

export function SharedHistoricalContext({
  asOf,
  onAsOfChange,
  compareTo,
  onCompareToChange,
  today,
  completeness,
  evidence,
  className = "",
}: Props) {
  return (
    <div
      className={["flex flex-wrap items-center gap-2", className].join(" ")}
      aria-label="Shared historical context"
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

      {/* Compare to — optional comparison date; none by default. */}
      <label className="inline-flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)]">
          <ArrowLeftRight size={13} className="text-[var(--text-faint)]" aria-hidden />
          Compare to
        </span>
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
        <ShellChip
          icon={<ShieldCheck size={13} />}
          label="Completeness"
          value={completeness?.label}
          tone={completeness?.tone}
        />
        <ShellChip
          icon={<FileSearch size={13} />}
          label="Evidence"
          value={evidence?.label}
        />
      </div>
    </div>
  );
}
