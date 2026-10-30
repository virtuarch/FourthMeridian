"use client";

/**
 * components/platform/leads/visual-kit.tsx  (Platform Ops visual spec §1 / §5)
 *
 * The few presentation helpers the Providers and AI & Costs dashboards share,
 * in the grammar the accepted Operations dashboard uses (OperationsLead.tsx
 * keeps its own private copies — it is accepted and not touched here):
 *
 *   Doorway       a quiet "label ›" link in a Block header (≥ 44 px below lg)
 *   Caption       the ONE caption line under a chart
 *   ChartMessage  a chart card's loading / unavailable line (never a fake chart)
 *   Segmented     a two/three-way window or series toggle (aria-pressed)
 *   Meter         a utilisation bar — drawn only from a real percentage
 *
 * Domain-free: every word, figure and tone arrives from the caller's model.
 */

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { TONE_COLOR, type StatusTone } from "../platform-surface";

const DOORWAY =
  "inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-xs)] text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8";

export function Doorway({ label, onSelect, dialog = false }: { label: string; onSelect: () => void; dialog?: boolean }) {
  return (
    <button type="button" onClick={onSelect} aria-haspopup={dialog ? "dialog" : undefined} className={DOORWAY}>
      {label} <ChevronRight size={12} aria-hidden />
    </button>
  );
}

export function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-3 truncate text-[11px] text-[var(--text-muted)]">{children}</p>;
}

export function ChartMessage({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-xs text-[var(--text-muted)]">{children}</p>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <span role="group" aria-label={label} className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={`min-h-11 rounded-[var(--radius-xs)] px-2.5 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-7 ${
            o.id === value ? "bg-[var(--surface-raised,rgba(255,255,255,.06))] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** A utilisation bar. `pct` is drawn capped at 100 % (the figure beside it says when it is over). */
export function Meter({ pct, tone, label }: { pct: number; tone: StatusTone; label: string }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
      className="block h-2 w-full overflow-hidden rounded-full bg-[var(--border-hairline)]" data-meter>
      <span className="block h-full rounded-full" style={{ width: `${w}%`, background: tone === "muted" ? "var(--text-faint)" : TONE_COLOR[tone] }} />
    </span>
  );
}
