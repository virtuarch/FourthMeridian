"use client";

/**
 * components/space/widgets/wealth/WealthCompositionCard.tsx
 *
 * Card 3 — "What is my wealth composed of?" Renders the composition of the
 * SELECTED As Of date, taken from that date's snapshot fields (never today's
 * account classification), so it is genuinely historical. Reconstructed
 * (isEstimated) snapshots are labeled as such; a date before coverage shows an
 * honest unavailable state — the card never presents present-day allocation as
 * though it belonged to a historical date.
 */

import { formatCurrency } from "@/lib/format";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { WealthCard, WealthUnavailable } from "./wealth-ui";

export function WealthCompositionCard({
  result,
  currency,
}: {
  result:   WealthResult;
  currency: string;
}) {
  const { asOfState } = result;

  const subtitle = asOfState.date ? `As of ${formatWealthDate(asOfState.date)}` : undefined;
  const badge = asOfState.found && asOfState.isEstimated ? (
    <span
      className="text-[10px] font-medium px-2 py-0.5 rounded-full"
      style={{ color: "var(--accent-warning)", background: "color-mix(in srgb, var(--accent-warning) 14%, transparent)" }}
      title="Reconstructed from history — some values held at recent prices"
    >
      Reconstructed
    </span>
  ) : undefined;

  if (!asOfState.found) {
    return (
      <WealthCard title="What is my wealth composed of?">
        <WealthUnavailable
          message={
            result.coverageFrom
              ? `Historical composition unavailable — no history before ${formatWealthDate(result.coverageFrom)}.`
              : "Historical composition unavailable for this date."
          }
        />
      </WealthCard>
    );
  }

  const c = asOfState.composition;
  const items: BreakdownItem[] = [
    { id: "cash",        label: "Cash",        value: c.cash },
    { id: "investments", label: "Investments", value: c.investments },
    { id: "crypto",      label: "Crypto",      value: c.crypto },
    { id: "real",        label: "Real assets", value: c.real },
  ].filter((i) => i.value > 0);

  return (
    <WealthCard title="What is my wealth composed of?" subtitle={subtitle} right={badge}>
      {items.length > 0 ? (
        <BreakdownWidget
          items={items}
          viewMode="donut"
          itemNoun="asset class"
          emptyHeadline="No assets on this date"
          emptySubline="This snapshot recorded no asset balances."
          formatValue={(v: number) => formatCurrency(v, currency)}
        />
      ) : (
        <WealthUnavailable message="This snapshot recorded no asset balances." />
      )}
      {c.liabilities > 0 && (
        <div
          className="mt-3 flex items-center justify-between rounded-xl px-3 py-2 border"
          style={{ background: "var(--surface-hover)", borderColor: "var(--border-hairline)" }}
        >
          <span className="text-xs text-[var(--text-muted)]">Liabilities (shown separately)</span>
          <span className="text-xs font-semibold tabular-nums text-[var(--accent-negative)]">
            −{formatCurrency(c.liabilities, currency)}
          </span>
        </div>
      )}
    </WealthCard>
  );
}
