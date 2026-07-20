"use client";

/**
 * components/space/widgets/wealth/WealthChangeLedger.tsx
 *
 * Surface ③ of the Wealth Perspective — "Where did the change come from?" One
 * row per composition component that actually moved (the read model's
 * epsilon-filtered, |Δ|-sorted drivers), colored by whether the move was good
 * (liabilities DOWN is good), closing with a hairline-separated Net Change total.
 * Exactly ONE forward-phrased attribution note — the rows stay generic
 * {id,label,delta} so historical valuation (A9) can swap the source (market
 * growth vs. contributions) without a redesign; we NEVER label a row Market
 * Growth / Contributions / Income / Spending / Fees today. Honest states: no
 * comparison ⇒ the add-a-date prompt; a flat period ⇒ the flat note.
 * Presentation only — every number comes from the WealthResult.
 *
 * V25-CLOSE-4A — the card is METRIC-AWARE. It reconciles with the SELECTED wealth
 * metric, not always net worth: the Net Change total is deltas[metric] and the
 * driver rows are filtered to that metric's components (assets-only for Assets,
 * the liabilities driver for Liabilities, cash+debt for Liquid). This uses only
 * the deltas/drivers WealthResult already carries — no new aggregation.
 */

import type { WealthResult, WealthDriver } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { Surface, Block, Figure } from "@/components/atlas/Surface";
import { WealthUnavailable, formatSigned } from "./wealth-ui";
import type { WealthMetricKey } from "./WealthTrendChart";
import { METRIC_DRIVER_COMPONENTS, METRIC_POSSESSIVE } from "./wealth-metric-facets";

/**
 * The single forward-phrased attribution note (A9 slot contract). Deliberately
 * free of the reserved source labels — asserting that in the colocated test locks
 * the honesty rule.
 */
export const ATTRIBUTION_NOTE =
  "Attribution by market growth vs. contributions arrives with historical valuation.";

/** A move is "good" when net worth rose from it — liabilities are good going DOWN. */
export function driverGood(d: WealthDriver): boolean {
  return d.id === "liabilities" ? d.delta < 0 : d.delta > 0;
}

export function WealthChangeLedger({
  result,
  currency,
  metric = "netWorth",
}: {
  result:   WealthResult;
  currency: string;
  /** The selected wealth metric — the card reconciles with this, not net worth. */
  metric?:  WealthMetricKey;
}) {
  const { deltas, drivers, compareState } = result;
  const compareLabel =
    compareState?.found && compareState.date ? formatWealthDate(compareState.date) : undefined;

  const heading = `What moved ${METRIC_POSSESSIVE[metric]}?`;

  if (!deltas) {
    return (
      <Block label={heading}>
        <WealthUnavailable message={`Add a Compare To date above to break down how ${METRIC_POSSESSIVE[metric]} changed.`} />
      </Block>
    );
  }

  // Filter drivers to the metric's components (assets-only for Assets, the
  // liabilities driver for Liabilities, cash+debt for Liquid). The driver order
  // is the read model's |Δ|-sort, preserved. No new aggregation — just a view.
  const allowed = new Set<string>(METRIC_DRIVER_COMPONENTS[metric]);
  const rows = (drivers ?? []).filter((d) => allowed.has(d.id));

  // The authoritative total is the SELECTED metric's delta — the whole point of
  // the slice: "What moved your assets" closes on deltas.totalAssets.
  const metricDelta = deltas[metric];
  // Direction sense mirrors the Hero: rising liabilities are BAD; every other
  // metric is good when it rises. Tone is a good/bad colour, not an arrow.
  const netChangeGood = metric === "totalLiabilities" ? metricDelta.abs < 0 : metricDelta.abs >= 0;

  return (
    <Block
      label={heading}
      hint={compareLabel ? <span className="text-[11px] text-[var(--text-muted)]">Since {compareLabel}</span> : undefined}
    >
      {rows.length === 0 ? (
        <Surface className="px-4 py-3">
          <p className="text-xs text-[var(--text-muted)]">
            {METRIC_POSSESSIVE[metric].replace(/^your /, "Your ")} was essentially flat over this period.
          </p>
        </Surface>
      ) : (
        <Surface className="divide-y divide-[var(--border-hairline)] overflow-hidden">
          {rows.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-sm text-[var(--text-secondary)] truncate">{d.label}</span>
              <Figure
                value={formatSigned(d.delta, currency)}
                size="body"
                tone={driverGood(d) ? "up" : "down"}
                className="shrink-0 font-semibold"
              />
            </div>
          ))}
          {/* Net Change — the authoritative total for the SELECTED metric. */}
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm font-semibold text-[var(--text-primary)]">Net Change</span>
            <Figure
              value={formatSigned(metricDelta.abs, currency)}
              size="lede"
              tone={netChangeGood ? "up" : "down"}
              className="shrink-0 font-semibold"
            />
          </div>
        </Surface>
      )}
      <p className="mt-3 text-[11px] text-[var(--text-muted)] leading-relaxed">{ATTRIBUTION_NOTE}</p>
    </Block>
  );
}
