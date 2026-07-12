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

import { useMemo } from "react";
import { AlertTriangle, TrendingUp, Info } from "lucide-react";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { CashFlowPerspective } from "@/lib/transactions/cash-flow-projection";
import { periodKey } from "@/lib/transactions/cash-flow";
import type { CashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import { buildCashFlowInsights, type InsightTone } from "./cash-flow-insights";

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
  perspective,
  txCtx,
  stamp,
}: {
  transactions?: Transaction[] | null;
  accounts:      { id: string; type: string }[];
  period:        CashFlowPeriod;
  perspective:   CashFlowPerspective;
  txCtx?:        ConversionContext;
  stamp?:        CashFlowStamp | null;
}) {
  // A stable primitive key for the period object (React can't compare it by value).
  const periodId = periodKey(period);
  const insights = useMemo(
    () => buildCashFlowInsights({ transactions, accounts, period, perspective, now: () => new Date(), moneyCtx: txCtx, stamp }),
    // period is reconstructed from periodId; stamp identity is stable per host memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, accounts, periodId, perspective, txCtx, stamp],
  );

  if (transactions == null) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Reading your activity…</p>;
  }

  return (
    <ul className="space-y-2.5">
      {insights.map((i) => (
        <li key={i.id} className="flex items-start gap-2">
          <ToneIcon tone={i.tone} />
          <span className="text-sm text-[var(--text-secondary)] leading-snug">{i.text}</span>
        </li>
      ))}
    </ul>
  );
}
