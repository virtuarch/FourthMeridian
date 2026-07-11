"use client";

/**
 * components/space/widgets/wealth/WealthPerspective.tsx
 *
 * The Wealth Perspective workspace (A6) — a coherent historical financial
 * perspective driven entirely by the shared shell context (As Of / Compare To /
 * shared range), which SpaceDashboard threads in as a computed WealthResult.
 * This component owns NO time/comparison state; it only composes the presentation:
 *
 *   Section A — KPI strip (Net Worth · Assets · Liabilities · Liquid NW)
 *   Section B — editorial grid:
 *       "How wealthy am I?"  ·  "How has my net worth changed?" (dominant chart)
 *       "What is my wealth composed of?"  ·  "What caused the biggest impact?"
 *   Full width — "What's the story behind the change?"
 *
 * Responsive: 1 column (mobile) → chart-full + 2-col analytical (tablet) →
 * 3-column editorial with the chart as the dominant central surface (desktop).
 */

import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { WealthKpiStrip } from "./WealthKpiStrip";
import { WealthNetWorthChart } from "./WealthNetWorthChart";
import { WealthCompositionCard } from "./WealthCompositionCard";
import { WealthChangeCard, WealthDriversCard, WealthStoryCard } from "./WealthChangeCards";
import { WealthUnavailable } from "./wealth-ui";

export function WealthPerspective({
  result,
  currency,
  onSelectAsOf,
}: {
  result:        WealthResult;
  currency:      string;
  onSelectAsOf?: (date: string) => void;
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

  const compareLabel = result.compareState?.found && result.compareState.date
    ? formatWealthDate(result.compareState.date)
    : undefined;

  return (
    <div className="space-y-4 min-w-0">
      {/* Section A — compact KPI strip. */}
      <WealthKpiStrip result={result} currency={currency} compareLabel={compareLabel} />

      {/* Section B — editorial grid; chart is the dominant central surface. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
        <div className="min-w-0">
          <WealthChangeCard result={result} currency={currency} compareLabel={compareLabel} />
        </div>
        <div className="min-w-0 md:col-span-2 md:order-first lg:order-none lg:col-span-2">
          <WealthNetWorthChart result={result} currency={currency} onSelectAsOf={onSelectAsOf} />
        </div>
        <div className="min-w-0">
          <WealthCompositionCard result={result} currency={currency} />
        </div>
        <div className="min-w-0 md:col-span-2 lg:col-span-2">
          <WealthDriversCard result={result} currency={currency} />
        </div>
      </div>

      {/* Full-width story. */}
      <WealthStoryCard result={result} />
    </div>
  );
}
