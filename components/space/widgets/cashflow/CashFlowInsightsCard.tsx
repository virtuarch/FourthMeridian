"use client";

/**
 * components/space/widgets/cashflow/CashFlowInsightsCard.tsx
 *
 * S4 — the Cash Flow "Key Insights" body. Renders the deterministic bullets from
 * buildCashFlowInsights (no AI, no new classification). Pure over its props; the
 * O(n) build is memoized on the inputs. The card carries NO header — the grid
 * wraps it in the shared Panel ("Key Insights"); evidence caveats here are a
 * single status line and never duplicate the shell's Evidence drawer.
 */

import { useId, useMemo, useState } from "react";
import { AlertTriangle, TrendingUp, Info } from "lucide-react";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { CashFlowPerspective } from "@/lib/transactions/cash-flow-projection";
import { periodKey } from "@/lib/transactions/cash-flow";
import type { CashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import { buildCashFlowInsights, type InsightTone } from "./cash-flow-insights";

/** R5 — compact (<lg) shows this many observations up front; the rest wait behind
 *  "Show all observations". The completeness caveat is never hidden. */
export const COMPACT_INSIGHT_LEAD = 3;

/** The completeness caveat's id in buildCashFlowInsights — always visible. */
const ALWAYS_VISIBLE = new Set(["completeness"]);

/** Compact-only visibility of observation `index` (same objects, same order —
 *  this never rewrites, reorders or derives anything; it only hides below lg). */
export function compactHidden(insight: { id: string }, index: number, showAll: boolean): boolean {
  return !showAll && index >= COMPACT_INSIGHT_LEAD && !ALWAYS_VISIBLE.has(insight.id);
}

const TONE_COLOR: Record<InsightTone, string> = {
  neutral:  "var(--text-secondary)",
  positive: "var(--flow-in, #22c55e)",
  warning:  "var(--flow-warn, #f59e0b)",
};

function ToneIcon({ tone }: { tone: InsightTone }) {
  const color = TONE_COLOR[tone];
  if (tone === "positive") return <TrendingUp size={14} className="shrink-0 mt-0.5" style={{ color }} />;
  if (tone === "warning")  return <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color }} />;
  return <Info size={14} className="shrink-0 mt-0.5" style={{ color }} />;
}

export function CashFlowInsightsCard({
  transactions,
  accounts,
  period,
  now,
  compareTo,
  perspective,
  txCtx,
  stamp,
}: {
  transactions?: Transaction[] | null;
  accounts:      { id: string; type: string }[];
  period:        CashFlowPeriod;
  /** The canonical As-of clock — the anchor for the primary period window. */
  now:           () => Date;
  /** Canonical compareTo (strictly-earlier) — anchors the then-vs-now comparison. */
  compareTo?:    string | null;
  perspective:   CashFlowPerspective;
  txCtx?:        ConversionContext;
  stamp?:        CashFlowStamp | null;
}) {
  // A stable primitive key for the period object (React can't compare it by value).
  const periodId = periodKey(period);
  const insights = useMemo(
    () => buildCashFlowInsights({ transactions, accounts, period, perspective, now, compareTo, moneyCtx: txCtx, stamp }),
    // period is reconstructed from periodId; stamp identity is stable per host memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, accounts, periodId, perspective, txCtx, stamp, now, compareTo],
  );

  // R5 — compact disclosure state (inert on desktop: every class it toggles is max-lg).
  const [showAll, setShowAll] = useState(false);
  const listId = useId();

  if (transactions == null) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Reading your activity…</p>;
  }

  const hiddenCount = insights.filter((i, idx) => compactHidden(i, idx, false)).length;

  return (
    <>
      <ul id={listId} className="space-y-2.5">
        {insights.map((i, idx) => (
          <li key={i.id} className={compactHidden(i, idx, showAll) ? "flex items-start gap-2 max-lg:hidden" : "flex items-start gap-2"}>
            <ToneIcon tone={i.tone} />
            <span className={showAll || hiddenCount === 0 || ALWAYS_VISIBLE.has(i.id)
              ? "text-sm text-[var(--text-secondary)] leading-snug"
              : "text-sm text-[var(--text-secondary)] leading-snug max-lg:line-clamp-2"}>{i.text}</span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          aria-expanded={showAll}
          aria-controls={listId}
          onClick={() => setShowAll((v) => !v)}
          className="lg:hidden mt-3 inline-flex min-h-10 items-center rounded-[var(--radius-full)] px-3 text-xs font-semibold text-[var(--meridian-400)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
          style={{ background: "var(--glass-ultrathin)", border: "1px solid var(--border-hairline)" }}
        >
          {showAll ? "Show fewer observations" : `Show all observations (${insights.length})`}
        </button>
      )}
    </>
  );
}
