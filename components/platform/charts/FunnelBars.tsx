"use client";

/**
 * components/platform/charts/FunnelBars.tsx  (Platform Spaces 2.0 — the stage funnel)
 *
 * A strict funnel drawn as horizontal bars, each a share of the FIRST stage,
 * with the count, the step conversion the authority computed (never re-derived
 * here) and the stage's drop-off. Three-state rates (product-analytics-types):
 * a number renders as a percentage, null as "—" (no denominator), undefined as
 * nothing (not measured). Domain-free: stage words and figures arrive from the
 * caller's model. A row is a button when `onSelect` is given (drill-down).
 */

import { ChevronRight } from "lucide-react";

export interface FunnelBarStage {
  key: string;
  label: string;
  count: number;
  /** Step conversion from the previous stage — three-state. */
  rate?: number | null;
  /** Reached this stage, not the next, beyond the horizon. */
  dropped?: number;
}

const n = (v: number) => v.toLocaleString("en-US");
const rateText = (r: number | null | undefined) => (r === undefined ? null : r === null ? "—" : `${Math.round(r * 100)}%`);

export function FunnelBars({ stages, ariaLabel, onSelect, droppedNoun = "stalled" }: {
  stages: readonly FunnelBarStage[];
  ariaLabel: string;
  onSelect?: (key: string) => void;
  droppedNoun?: string;
}) {
  const base = stages[0]?.count ?? 0;
  return (
    <ol aria-label={ariaLabel} className="flex min-w-0 flex-col gap-2" data-funnel-bars>
      {stages.map((s) => {
        const w = base > 0 ? Math.max(s.count > 0 ? 2 : 0, (s.count / base) * 100) : 0;
        const rate = rateText(s.rate);
        const body = (
          <>
            <span className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-xs text-[var(--text-primary)]">{s.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">{n(s.count)}</span>
                {rate !== null && <span className="ml-1.5 text-[11px] text-[var(--text-muted)]">{rate} of prev.</span>}
              </span>
            </span>
            <span className="mt-1 block h-2 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text-muted)_10%,transparent)]">
              <span className="block h-full rounded-full" style={{ width: `${w}%`, background: "color-mix(in srgb, var(--meridian-400) 75%, transparent)" }} />
            </span>
            {s.dropped !== undefined && s.dropped > 0 && (
              <span className="mt-0.5 block text-[10px] tabular-nums text-[var(--text-muted)]">{n(s.dropped)} {droppedNoun}</span>
            )}
          </>
        );
        return (
          <li key={s.key} className="min-w-0">
            {onSelect ? (
              <button type="button" onClick={() => onSelect(s.key)} aria-haspopup="dialog"
                className="group flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-xs)] py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
                <span className="block min-w-0 flex-1">{body}</span>
                <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)] group-hover:text-[var(--text-secondary)]" />
              </button>
            ) : (
              <div className="py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
