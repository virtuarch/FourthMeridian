"use client";

/**
 * components/space/widgets/wealth/WealthPerspective.tsx
 *
 * The Wealth Perspective workspace (A6) — a coherent historical financial
 * perspective driven entirely by the shared shell context (As Of / Compare To /
 * shared range), which SpaceDashboard threads in as a computed WealthResult.
 * This component owns NO time/comparison state; it only composes the five
 * surfaces in their fixed narrative order.
 *
 * Layout (plan §5) — desktop is a 12-column grid, mobile/tablet stacks ①→⑤:
 *   ① WealthHero (4)        ② WealthTrendChart (8)     ← net worth + the chart
 *   ③ WealthChangeLedger (6) ④ WealthCompositionCard (6) ← what changed + mix
 *   ⑤ WealthExplanationCard (12)                        ← the plain-language read
 *
 * Net worth is a headline exactly once (the hero); there are zero sparklines on
 * the page; the ledger owns the single attribution note. No horizontal overflow
 * (every column is min-w-0).
 */

import { Loader2 } from "lucide-react";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import type { ConversionContext } from "@/lib/money/types";
import type { WealthAdapterAccount } from "@/components/space/widgets/wealth-adapters";
import { WealthHero } from "./WealthHero";
import { WealthTrendChart, type WealthMetricKey } from "./WealthTrendChart";
import { WealthChangeLedger } from "./WealthChangeLedger";
import { WealthCompositionCard } from "./WealthCompositionCard";
import { WealthExplanationCard } from "./WealthExplanationCard";
import { WealthUnavailable } from "./wealth-ui";

export function WealthPerspective({
  result,
  currency,
  onSelectAsOf,
  onSwitchLens,
  onViewEvidence,
  metric,
  onMetricChange,
  accounts,
  ctx,
  backfillInProgress,
}: {
  result:         WealthResult;
  currency:       string;
  onSelectAsOf?:  (date: string) => void;
  onSwitchLens?:  (lensId: string) => void;
  onViewEvidence?: () => void;
  metric?:        WealthMetricKey;
  onMetricChange?: (m: WealthMetricKey) => void;
  accounts?:      WealthAdapterAccount[];
  ctx?:           ConversionContext;
  /** Part-6 — a snapshot backfill is actively running for this Space. */
  backfillInProgress?: boolean;
}) {
  // Part-6 — while a backfill is running, the snapshot series is still being
  // written, so a partial (or empty) WealthResult must NOT render as if final.
  // Show an honest loading state (distinct from both the normal render and the
  // "no history" empty state). Clears automatically once the backfill completes
  // and the poll re-fetches with backfillInProgress=false (SpaceDashboard).
  if (backfillInProgress) {
    return (
      <div
        className="rounded-2xl border p-8 flex flex-col items-center justify-center text-center gap-3 min-h-[220px]"
        style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
      >
        <Loader2 className="animate-spin" size={26} style={{ color: "var(--meridian-400)" }} />
        <div className="max-w-sm">
          <p className="text-sm font-semibold text-[var(--text-primary)]">Creating your 30-day snapshot history…</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            We&rsquo;re reconstructing balance history from the accounts you just connected.
            This can take a few minutes — the chart appears here the moment it&rsquo;s ready.
          </p>
        </div>
      </div>
    );
  }

  if (!result.hasHistory) {
    return (
      <div
        className="rounded-2xl border p-8"
        style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
      >
        <WealthUnavailable message="No wealth history yet. Once this Space accrues daily snapshots (or you connect accounts), the historical Wealth perspective builds itself — nothing is fabricated in the meantime." />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0">
      {/* ① Hero + ② Trend chart. */}
      <div className="min-w-0 lg:col-span-4">
        <WealthHero result={result} currency={currency} onSwitchLens={onSwitchLens} />
      </div>
      <div className="min-w-0 lg:col-span-8">
        <WealthTrendChart
          result={result}
          currency={currency}
          onSelectAsOf={onSelectAsOf}
          metric={metric}
          onMetricChange={onMetricChange}
        />
      </div>

      {/* ③ Change ledger + ④ Composition. */}
      <div className="min-w-0 lg:col-span-6">
        <WealthChangeLedger result={result} currency={currency} />
      </div>
      <div className="min-w-0 lg:col-span-6">
        <WealthCompositionCard result={result} currency={currency} accounts={accounts} ctx={ctx} />
      </div>

      {/* ⑤ Explanation. */}
      <div className="min-w-0 lg:col-span-12">
        <WealthExplanationCard result={result} currency={currency} onViewEvidence={onViewEvidence} />
      </div>
    </div>
  );
}
