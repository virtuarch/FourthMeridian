"use client";

/**
 * components/space/widgets/wealth/WealthChangeLedger.tsx
 *
 * Surface ③ of the Wealth Perspective — "Where did the change come from?" One
 * row per composition component that actually moved (the read model's
 * epsilon-filtered, |Δ|-sorted drivers), colored by whether the move was good
 * (liabilities DOWN is good), closing with a hairline-separated Net Change total
 * that equals deltas.netWorth. Exactly ONE forward-phrased attribution note — the
 * rows stay generic {id,label,delta} so historical valuation (A9) can swap the
 * source (market growth vs. contributions) without a redesign; we NEVER label a
 * row Market Growth / Contributions / Income / Spending / Fees today. Honest
 * states: no comparison ⇒ the add-a-date prompt; a flat period ⇒ the flat note.
 * Presentation only — every number comes from the WealthResult.
 */

import type { WealthResult, WealthDriver } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { Surface, Block, Figure } from "@/components/atlas/Surface";
import { WealthUnavailable, formatSigned } from "./wealth-ui";

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
}: {
  result:   WealthResult;
  currency: string;
}) {
  const { deltas, drivers, compareState } = result;
  const compareLabel =
    compareState?.found && compareState.date ? formatWealthDate(compareState.date) : undefined;

  if (!deltas) {
    return (
      <Block label="What moved it">
        <WealthUnavailable message="Add a Compare To date above to break down how your wealth changed." />
      </Block>
    );
  }

  const rows = drivers ?? [];

  return (
    <Block
      label="What moved it"
      hint={compareLabel ? <span className="text-[11px] text-[var(--text-muted)]">Since {compareLabel}</span> : undefined}
    >
      {rows.length === 0 ? (
        <Surface className="px-4 py-3">
          <p className="text-xs text-[var(--text-muted)]">
            Net worth was essentially flat over this period.
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
          {/* Net Change — the authoritative total (hairline-separated). */}
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm font-semibold text-[var(--text-primary)]">Net Change</span>
            <Figure
              value={formatSigned(deltas.netWorth.abs, currency)}
              size="lede"
              tone={deltas.netWorth.abs >= 0 ? "up" : "down"}
              className="shrink-0 font-semibold"
            />
          </div>
        </Surface>
      )}
      <p className="mt-3 text-[11px] text-[var(--text-muted)] leading-relaxed">{ATTRIBUTION_NOTE}</p>
    </Block>
  );
}
