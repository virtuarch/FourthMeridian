/**
 * components/space/compact/CompactKpiStrip.tsx  (v2.7 R4 — compact cockpit)
 *
 * A compact-only (<1024px) row of secondary figures — label · value · change —
 * as small tiles. Presentation only: every value and change node is supplied
 * by the caller, already formatted from figures the read model computed (the
 * Net Worth page passes the hero's own secondary stat rows). The root carries
 * `lg:hidden`, so it never renders at ≥1024px.
 *
 * No fixed widths: equal minmax(0,1fr) columns and overflow-wrap so a long
 * figure wraps inside its tile instead of overflowing a 375px viewport.
 */

import type { ReactNode } from "react";

export interface CompactKpiItem {
  key: string;
  label: string;
  value: string;
  /** The change, already formatted (or null when there is no comparison). */
  change?: ReactNode;
}

export function CompactKpiStrip({ items, ariaLabel }: { items: CompactKpiItem[]; ariaLabel: string }) {
  if (items.length === 0) return null;
  return (
    <dl
      aria-label={ariaLabel}
      data-compact-kpi-strip
      className="lg:hidden grid gap-2"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => (
        <div
          key={item.key}
          data-compact-kpi={item.key}
          className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-3 py-2.5"
        >
          <dt className="truncate text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{item.label}</dt>
          <dd className="mt-1 text-[13px] font-semibold leading-tight tabular-nums text-[var(--text-primary)] [overflow-wrap:anywhere]">{item.value}</dd>
          {item.change ? (
            <dd className="mt-0.5 text-[11px] leading-tight tabular-nums [overflow-wrap:anywhere]">{item.change}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
