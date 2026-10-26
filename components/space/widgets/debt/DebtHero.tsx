"use client";

/**
 * components/space/widgets/debt/DebtHero.tsx
 *
 * Surface ① of the Debt Workspace — the editorial lede, in the Net Worth / prototype
 * idiom (bare, no card): an eyebrow + trust chip, the total-owed headline, its change
 * over the balance-history window, and a quiet secondary stat line. Mirrors
 * InvestmentsHero / WealthHero.
 *
 * HONESTY (Debt is temporalCapability: PARTIAL — the load-bearing rule):
 *  - The headline is the PRESENT-DAY total owed (computeDebtKpis over the accounts
 *    array — the figure of record, shared with the ledger / utilization / payoff so
 *    they can never disagree). It does NOT move with As-Of; only the trend, verdict,
 *    and trust below do. When a past As-Of is selected we SAY so, rather than letting
 *    a present-day number masquerade as historical.
 *  - The change is the balance-history WINDOW delta (snapshot basis — the same figure
 *    the chart states), labelled "vs {windowStart}", never invented: it renders only
 *    when a real window with ≥2 points exists. goodDirection="down" — debt falling is
 *    good (wealth-ui's own note).
 *
 * Presentation only — every figure is passed in, already computed/converted upstream.
 */

import type { ReactNode } from "react";
import { CompactHeroCard } from "@/components/space/compact/CompactHeroCard";
import { formatDate } from "@/lib/format";
import { formatCurrency } from "@/lib/currency";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import type { DebtKpis } from "./debt-kpis";
import { Figure } from "@/components/atlas/Surface";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import { DeltaBadge } from "@/components/space/widgets/wealth/wealth-ui";

/** The balance-history window delta, ready for the badge (snapshot basis). */
export interface DebtWindowChange {
  /** last − first over the in-window snapshot series (positive = debt grew). */
  abs: number;
  /** % of the opening balance, or null when the opening is 0/unknown. */
  pct: number | null;
  /** The window's opening date (formatted), for the "vs {date}" label. */
  fromLabel: string;
}

const UTIL_COLOR: Record<string, string> = {
  low:      "var(--accent-positive)",
  moderate: "#f59e0b",
  high:     "#f97316",
  over:     "var(--accent-negative)",
};

export function DebtHero({
  kpis,
  currency,
  liabilityCount,
  asOf,
  today,
  historical,
  change,
  envelope,
  verdict,
  verdictAsOf,
  redactions,
  timePreset,
  freshnessLabel = null,
}: {
  kpis:           DebtKpis;
  currency:       string;
  /** How many liabilities the headline sums (for the "across N" line). */
  liabilityCount: number;
  asOf:           string;
  today:          string;
  /** asOf < today ⇒ the headline is present-day while trend/verdict are as-of. */
  historical:     boolean;
  /** The balance-history window delta, or null when no window exists. */
  change:         DebtWindowChange | null;
  /** The workspace's canonical trust envelope — drives the confidence chip. */
  envelope:       PerspectiveEnvelope;
  /** The lens verdict SENTENCE (prose only), or null. */
  verdict:        string | null;
  /** The lens data freshness date (formatted upstream), or null. */
  verdictAsOf:    string | null;
  /** Count of account details the lens withheld, for an honest note. */
  redactions:     number;
  /** v2.7 R6 — the shell slice id for the compact AI entry link (allowlisted there). */
  timePreset?:    string;
  /** v2.7 — the Space's canonical freshness claim ("Last checked N ago"), compact label row only. */
  freshnessLabel?: string | null;
}) {
  const approx = kpis.estimated ? "≈ " : "";

  const asOfShown = formatDate(asOf < today ? asOf : today);
  const withheld = redactions > 0 ? `${redactions} account detail${redactions === 1 ? "" : "s"} withheld` : null;

  return (
    <div>
      {/* v2.7 visual-first — COMPACT (<lg): the shared five-row card, the same
          as Net Worth. In a HISTORICAL view the headline is present-day while the
          trend is as-of, so no change is printed beside it (different bases);
          the "Balances are current" and withheld-details disclosures render as
          visible notes BELOW the card, never as extra rows. */}
      <CompactHeroCard
        title="Total debt"
        freshness={freshnessLabel}
        trust={<TrustIndicator variant="compact" envelope={envelope} />}
        value={`${approx}${formatCurrency(kpis.totalDebt, currency)}`}
        valueTone="negative"
        change={!historical && change != null ? { abs: change.abs, pct: change.pct, goodDirection: "down" } : null}
        noChangeLabel={historical ? "Change shown in the chart" : undefined}
        range={historical ? "Current balances" : change != null ? `${change.fromLabel} → ${asOfShown}` : `As of ${asOfShown}`}
        currency={currency}
        talkSection="debt"
        talkPeriod={timePreset}
        notes={[
          historical ? `Balances are current — the trend reflects ${formatDate(asOf)}.` : null,
          withheld,
        ]}
      />

      {/* DESKTOP (≥lg) — bare hero, no card, no border. The headline is the
          point; the read surfaces (chart, ledger) sit below. */}
      <section className="max-lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Total debt</p>
          <TrustIndicator variant="compact" envelope={envelope} />
        </div>

        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <Figure
            value={`${approx}${formatCurrency(kpis.totalDebt, currency)}`}
            size="hero"
            className="sm:text-5xl leading-none text-[var(--accent-negative)]"
          />
          {/* The window delta rides the balance-history (snapshot) basis. Present-day it
              coincides with this headline, so it's coherent; in a HISTORICAL view the
              headline is present-day while the trend is as-of — the two would be on
              different bases, so the delta is deferred to the chart and dropped here. */}
          {!historical && (
            change != null ? (
              <DeltaBadge
                abs={change.abs}
                pct={change.pct}
                currency={currency}
                goodDirection="down"
                compareLabel={change.fromLabel}
                className="!text-xs"
              />
            ) : (
              <span className="text-[11px] text-[var(--text-muted)]">Add a Compare To date above to see the change.</span>
            )
          )}
        </div>

        <p className="mt-2.5 text-sm text-[var(--text-secondary)]">
          across <span className="tabular-nums">{liabilityCount}</span> liabilit{liabilityCount === 1 ? "y" : "ies"}
          <span className="text-[var(--text-muted)]"> · {historical ? "current balances" : `as of ${asOfShown}`}</span>
        </p>

        {/* PARTIAL-capability honesty: in a historical view the balances are still
            present-day; only the trend, verdict, and trust honour the selected date. */}
        {historical && (
          <p className="mt-1 text-[11px] text-[var(--text-faint)]">
            Balances are current — the trend and verdict below reflect {formatDate(asOf)}.
          </p>
        )}

        {/* Quiet secondary stats — the retired KPI strip, folded into a single inline
            line rather than a card grid. Each renders only when honestly available. */}
        {kpis.totalDebt > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-[var(--text-muted)]">
            {kpis.ratedCount > 0 && (
              <Stat label="Est. interest">
                <span className="text-[var(--accent-negative)]">{approx}{formatCurrency(kpis.estMonthlyInterest, currency)}</span>/mo
              </Stat>
            )}
            {kpis.utilizationPct != null && kpis.utilizationLevel != null && (
              <Stat label="Utilization">
                <span style={{ color: UTIL_COLOR[kpis.utilizationLevel] }}>{kpis.utilizationPct.toFixed(0)}%</span>
              </Stat>
            )}
          </div>
        )}

        {/* Lens verdict — the as-of intelligence sentence (prose only, never a figure). */}
        {verdict && (
          <p className="mt-3 max-w-prose text-[13px] leading-snug text-[var(--text-secondary)]">
            {verdict}
            {(verdictAsOf || redactions > 0) && (
              <span className="text-[var(--text-faint)]">
                {verdictAsOf ? ` · as of ${verdictAsOf}` : ""}
                {withheld ? ` · ${withheld}` : ""}
              </span>
            )}
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * v2.7 — the hero's secondary stats as compact KPI-strip items (Liabilities ·
 * Est. interest · Utilization), for the strip under the compact balance chart.
 * Same kpis values and the same "≈" estimated marker the hero uses — owned here
 * so the workspace never re-derives a trust marker.
 */
export function debtCompactKpiItems(kpis: DebtKpis, currency: string): { key: string; label: string; value: string }[] {
  const approx = kpis.estimated ? "≈ " : "";
  return [
    { key: "liabilities", label: "Liabilities", value: String(kpis.owingCount) },
    ...(kpis.ratedCount > 0 ? [{ key: "interest", label: "Est. interest", value: `${approx}${formatCurrency(kpis.estMonthlyInterest, currency)}/mo` }] : []),
    ...(kpis.utilizationPct != null ? [{ key: "utilization", label: "Utilization", value: `${kpis.utilizationPct.toFixed(0)}%` }] : []),
  ];
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{label}</span>
      <span className="text-[var(--text-secondary)]">{children}</span>
    </span>
  );
}
