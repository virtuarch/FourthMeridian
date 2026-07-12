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
}) {
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
