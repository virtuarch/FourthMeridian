"use client";

/**
 * components/space/widgets/liquidity/SourceAccountDetail.tsx
 *
 * The per-source DETAIL body, shown inside the Sources ledger's RightPanel (the Atlas
 * panel primitive — "tell me more about what I selected"). The liquidity analogue of
 * DebtAccountDetail: it leads with the customer's ACCESS FACTS (how much, how reachable)
 * and stays honest about what isn't tracked.
 *
 * HONESTY: every figure is the ledger's own display-converted LiquiditySourceRow (never
 * re-derived here) — the panel and the row can never disagree. Liquidity's per-account
 * panels are PRESENT-DAY (the current anchor — they cannot be reconstructed per-account
 * historically); these are current balances. Per-account balance HISTORY is not carried
 * by the contract (only the cashNow tier over time is) — so it is OMITTED, never
 * fabricated; the note says so plainly.
 */

import type { ReactNode } from "react";
import { formatCurrency } from "@/lib/format";
import {
  HORIZON_LABEL, HORIZON_META, HORIZON_COLOR, type LiquiditySourceRow,
} from "./liquidity-sources-util";

/** The one-line access description under the horizon heading. */
const HORIZON_ACCESS: Record<string, string> = {
  now:      "Reachable right now",
  days:     "Reachable within days (settlement)",
  illiquid: "Longer horizon — not readily reachable",
};

function Row({ label, value, valueColor }: { label: string; value: ReactNode; valueColor?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-xs text-[var(--text-faint)]">{label}</span>
      <span className="text-sm tabular-nums text-right" style={{ color: valueColor ?? "var(--text-secondary)" }}>{value}</span>
    </div>
  );
}

export function SourceAccountDetail({ row, currency }: { row: LiquiditySourceRow; currency: string }) {
  const a = row.account;
  const approx = row.estimated ? "≈ " : "";
  const color = HORIZON_COLOR[row.horizon];

  return (
    <div className="min-w-0">
      {/* Headline balance. */}
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Current balance</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
        {approx}{formatCurrency(row.value, currency)}
      </p>
      <p className="mt-1 flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        {HORIZON_LABEL[row.horizon]}{a.institution ? ` · ${a.institution}` : ""}
      </p>

      {/* Facts. */}
      <div className="mt-5 divide-y divide-[var(--border-hairline)] border-t border-[var(--border-hairline)]">
        <Row label="Access" value={HORIZON_ACCESS[row.horizon]} />
        <Row label="Category" value={HORIZON_META[row.horizon]} />
        <Row label="Share of assets" value={`${(row.share * 100).toFixed(1)}%`} />
      </div>

      {/* Honest scope note — what this panel does NOT show, said plainly. */}
      <p className="mt-5 text-[11px] leading-snug text-[var(--text-faint)]">
        Balances are current. Per-account history isn&rsquo;t tracked — the balance-history chart above the
        ledger shows total accessible cash over time, not this account alone.
      </p>
    </div>
  );
}
