"use client";

/**
 * components/space/widgets/investments/InvestmentKpiStrip.tsx
 *
 * SD-4C — the top KPI strip of the Investments Workspace, in the mockup's dense
 * four-up idiom. Every figure here is CANONICALLY SUPPORTED — nothing is fabricated:
 *
 *   • Total Investment Value  ← portfolio.valuedSubtotal (+ the value change since
 *                               compareTo, from the A10 reconciliation — a value
 *                               DELTA, never labeled "gain/loss": it includes
 *                               contributions by construction).
 *   • Net Contributions       ← activity.netExternalFlows (+ contributions/withdrawals),
 *                               period-only (needs a comparison window).
 *   • Income Received         ← activity.income, period-only. Deliberately labeled
 *                               "combined" — the canonical flow layer MERGES dividends,
 *                               interest and capital-gain distributions into one
 *                               `income` figure, so a dividends-vs-interest SPLIT is
 *                               NOT shown (it would be fabricated).
 *
 * The mockup's "Total Gain/Loss" card (realized/unrealized) and "Performance"
 * (IRR / S&P·VTI benchmark / Sharpe / best·worst month) are OMITTED: no canonical
 * source exists for them, and the "do not fake data" rule forbids inventing them.
 * The value-change and net-contribution cards preserve the strip's visual balance
 * with supported figures instead.
 *
 * Props-in / render-out. Values are the reporting-currency figures verbatim (display-
 * currency conversion is a scoped SD-4D follow-up; see InvestmentsWorkspace).
 */

import type { ReactNode } from "react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { formatCurrency, formatPercent } from "@/lib/format";
import type { InvestmentsPortfolio, InvestmentsReconciliation } from "@/lib/investments/investments-time-machine-core";
import type { PeriodFlows } from "@/lib/investments/investment-flows-core";

const POS = "var(--accent-positive, #34d399)";
const NEG = "var(--accent-negative, #f87171)";

function signColor(n: number): string {
  return n > 0 ? POS : n < 0 ? NEG : "var(--text-muted)";
}
function signed(amount: number, currency: string): string {
  return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${formatCurrency(Math.abs(amount), currency)}`;
}

/** One KPI card: label + optional caption, big value, optional sub-line, optional split. */
function Kpi({
  label, caption, value, valueColor, sub, split,
}: {
  label: string;
  caption?: string;
  value: string;
  valueColor?: string;
  sub?: ReactNode;
  split?: { left: [string, ReactNode]; right: [string, ReactNode] };
}) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0 flex flex-col">
      <p className="text-sm font-semibold text-[var(--text-primary)]">{label}</p>
      {caption && <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{caption}</p>}
      <p className="text-2xl font-bold tabular-nums mt-2" style={{ color: valueColor ?? "var(--text-primary)" }}>
        {value}
      </p>
      {sub && <div className="text-xs mt-0.5">{sub}</div>}
      {split && (
        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t" style={{ borderColor: "var(--border-hairline)" }}>
          <div className="min-w-0">
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>{split.left[0]}</p>
            <p className="text-sm font-semibold tabular-nums truncate" style={{ color: "var(--text-secondary)" }}>{split.left[1]}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>{split.right[0]}</p>
            <p className="text-sm font-semibold tabular-nums truncate" style={{ color: "var(--text-secondary)" }}>{split.right[1]}</p>
          </div>
        </div>
      )}
    </GlassPanel>
  );
}

export function InvestmentKpiStrip({
  portfolio,
  reconciliation,
  activity,
  reportingCurrency,
  figureLabel,
  asOf,
}: {
  portfolio:         InvestmentsPortfolio;
  reconciliation:    InvestmentsReconciliation | null;
  activity?:         PeriodFlows;
  reportingCurrency: string;
  /** Trust-derived honest label ("Portfolio value" | "Valued holdings"). */
  figureLabel:       string;
  /** Resolved shell As Of — the point-in-time basis of the value card (§4). */
  asOf:              string;
}) {
  const ccy = reportingCurrency;
  // Value change since compareTo (a value DELTA, includes contributions — not a gain).
  const change = reconciliation?.totalChange ?? null;
  const opening = reconciliation?.openingValue ?? null;
  const pct = change != null && opening != null && opening !== 0 ? (change / opening) * 100 : null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 min-w-0">
      {/* ① Total Investment Value — value AT asOf (point-in-time, §4). */}
      <Kpi
        label={figureLabel}
        caption={`As of ${asOf} · all accounts`}
        value={formatCurrency(portfolio.valuedSubtotal, ccy)}
        valueColor="var(--text-primary)"
        sub={
          change != null ? (
            <span style={{ color: signColor(change) }}>
              {signed(change, ccy)}{pct != null ? ` (${change >= 0 ? "+" : ""}${formatPercent(pct)})` : ""}
              <span style={{ color: "var(--text-faint)" }}> value change since {reconciliation!.from}</span>
            </span>
          ) : (
            <span style={{ color: "var(--text-faint)" }}>Pick a Compare To date to see the change</span>
          )
        }
        split={
          reconciliation
            ? {
                left:  ["This period", formatCurrency(reconciliation.closingValue, ccy)],
                right: [reconciliation.from, formatCurrency(reconciliation.openingValue, ccy)],
              }
            : undefined
        }
      />

      {/* ② Net Contributions — period-only (needs a window). */}
      {activity ? (
        <Kpi
          label="Net Contributions"
          caption={`Capital moved in/out · ${activity.from} → ${activity.to}`}
          value={signed(activity.netExternalFlows, ccy)}
          valueColor={signColor(activity.netExternalFlows)}
          split={{
            left:  ["Contributions", <span key="c" style={{ color: signColor(activity.contributions) }}>{signed(activity.contributions, ccy)}</span>],
            right: ["Withdrawals",   <span key="w" style={{ color: signColor(activity.withdrawals) }}>{signed(activity.withdrawals, ccy)}</span>],
          }}
        />
      ) : (
        <Kpi label="Net Contributions" caption="Pick a Compare To date" value="—" valueColor="var(--text-muted)" />
      )}

      {/* ③ Investment Income — period-only, canonically COMBINED (no div/interest split). */}
      {activity ? (
        <Kpi
          label="Investment Income"
          caption={`Dividends, interest & distributions (combined) · ${activity.from} → ${activity.to}`}
          value={formatCurrency(activity.income, ccy)}
          valueColor={activity.income > 0 ? POS : "var(--text-primary)"}
        />
      ) : (
        <Kpi label="Investment Income" caption="Pick a Compare To date for the period" value="—" valueColor="var(--text-muted)" />
      )}
    </div>
  );
}
