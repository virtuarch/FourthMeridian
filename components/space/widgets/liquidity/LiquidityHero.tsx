"use client";

/**
 * components/space/widgets/liquidity/LiquidityHero.tsx
 *
 * Surface ① of the Liquidity Workspace — the editorial lede, in the Net Worth / Debt
 * idiom (bare, no card): an eyebrow + trust chip, the accessible-cash headline, its
 * change over the balance-history window, a coverage/readiness stat line, and the lens
 * verdict sentence. Liquidity answers "how much money can I access and how resilient am
 * I?" — access & readiness, NOT wealth or performance. Mirrors DebtHero / InvestmentsHero.
 *
 * HONESTY (Liquidity is temporalCapability: PARTIAL — the load-bearing rule):
 *  - The headline is the PRESENT-DAY cashNow tier (classifyAccounts.totalLiquid over the
 *    accounts array — the figure of record, shared with the Sources ledger / Ladder so
 *    they can never disagree). It does NOT move with As-Of; only the trend, verdict, and
 *    trust below do. When a past As-Of is selected we SAY so, rather than letting a
 *    present-day number masquerade as historical (the Debt precedent).
 *  - The change is the balance-history WINDOW delta (cashNow snapshot series — the same
 *    figure the chart states), labelled "vs {windowStart}", never invented: it renders
 *    only when a real window with ≥2 points exists. goodDirection="up" — more accessible
 *    cash is good.
 *  - Coverage months renders ONLY when a monthly-expense baseline exists (the Space's
 *    emergency_fund_progress config); without it, no coverage is shown — never a
 *    fabricated runway (the Emergency Fund Readiness doctrine, kept).
 *
 * Presentation only — every figure is passed in, already computed/converted upstream.
 */

import type { ReactNode } from "react";
import { formatCurrency, formatDate } from "@/lib/format";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { Figure } from "@/components/atlas/Surface";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import { DeltaBadge } from "@/components/space/widgets/wealth/wealth-ui";

/** The balance-history window delta, ready for the badge (cashNow snapshot basis). */
export interface LiquidityWindowChange {
  /** last − first over the in-window cashNow series (positive = accessible cash grew). */
  abs: number;
  /** % of the opening balance, or null when the opening is 0/unknown. */
  pct: number | null;
  /** The window's opening date (formatted), for the "vs {date}" label. */
  fromLabel: string;
}

/** Coverage months — present ONLY when a monthly-expense baseline exists. */
export interface LiquidityCoverage {
  /** cashNow / monthlyExpenses. */
  months: number;
  /** The Space-native monthly expense figure (for the disclosed assumption). */
  monthlyExpenses: number;
}

export function LiquidityHero({
  cashNow,
  reachableSoon,
  sharePctNow,
  sourceCount,
  coverage,
  estimated,
  currency,
  asOf,
  today,
  historical,
  change,
  envelope,
  verdict,
  verdictAsOf,
  redactions,
}: {
  /** Present-day accessible cash (cashNow tier) — the figure of record. */
  cashNow:       number;
  /** Reachable within days (marketable tier), for the secondary line. */
  reachableSoon: number;
  /** Share of total assets that is reachable now (0–100), or null when no assets. */
  sharePctNow:   number | null;
  /** How many liquidity sources the headline sums (for the "across N" line). */
  sourceCount:   number;
  /** Coverage months, or null when no expense baseline exists (no fabrication). */
  coverage:      LiquidityCoverage | null;
  /** True when any display figure was FX-estimated (the "≈" marker). */
  estimated:     boolean;
  currency:      string;
  asOf:          string;
  today:         string;
  /** asOf < today ⇒ the headline is present-day while trend/verdict are as-of. */
  historical:    boolean;
  /** The balance-history window delta, or null when no window exists. */
  change:        LiquidityWindowChange | null;
  /** The workspace's canonical trust envelope — drives the confidence chip. */
  envelope:      PerspectiveEnvelope;
  /** The lens verdict SENTENCE (prose only), or null. */
  verdict:       string | null;
  /** The lens data freshness date (formatted upstream), or null. */
  verdictAsOf:   string | null;
  /** Count of account details the lens withheld, for an honest note. */
  redactions:    number;
}) {
  const approx = estimated ? "≈ " : "";
  const nowColor = sharePctNow == null ? undefined : sharePctNow >= 15 ? "var(--accent-positive)" : sharePctNow >= 5 ? "#f59e0b" : "var(--accent-negative)";

  return (
    // Bare hero — no card, no border. The headline is the point; the read surfaces
    // (chart, ledger) sit below.
    <section>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Accessible cash</p>
        <TrustIndicator variant="compact" envelope={envelope} />
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <Figure
          value={`${approx}${formatCurrency(cashNow, currency)}`}
          size="hero"
          className="sm:text-5xl leading-none"
        />
        {/* The window delta rides the balance-history (cashNow snapshot) basis. Present-day
            it coincides with this headline, so it's coherent; in a HISTORICAL view the
            headline is present-day while the trend is as-of — different bases, so the delta
            is deferred to the chart and dropped here (the Debt precedent). */}
        {!historical && (
          change != null ? (
            <DeltaBadge
              abs={change.abs}
              pct={change.pct}
              currency={currency}
              goodDirection="up"
              compareLabel={change.fromLabel}
              className="!text-xs"
            />
          ) : (
            <span className="text-[11px] text-[var(--text-muted)]">Add a Compare To date above to see the change.</span>
          )
        )}
      </div>

      <p className="mt-2.5 text-sm text-[var(--text-secondary)]">
        reachable right now, across <span className="tabular-nums">{sourceCount}</span> source{sourceCount === 1 ? "" : "s"}
        <span className="text-[var(--text-muted)]"> · {historical ? "current balances" : `as of ${formatDate(asOf < today ? asOf : today)}`}</span>
      </p>

      {/* PARTIAL-capability honesty: in a historical view the balances are still
          present-day; only the trend, verdict, and trust honour the selected date. */}
      {historical && (
        <p className="mt-1 text-[11px] text-[var(--text-faint)]">
          Balances are current — the trend and verdict below reflect {formatDate(asOf)}.
        </p>
      )}

      {/* Quiet secondary stats — coverage / reachability, each only when honestly
          available. Coverage is the resilience headline; it is NEVER fabricated. */}
      {(coverage || reachableSoon > 0 || sharePctNow != null) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-[var(--text-muted)]">
          {coverage && (
            <Stat label="Coverage">
              <span style={{ color: coverage.months >= 6 ? "var(--accent-positive)" : coverage.months >= 3 ? "#f59e0b" : "var(--accent-negative)" }}>
                {coverage.months.toFixed(1)} months
              </span>
              <span className="text-[var(--text-faint)]"> · at {formatCurrency(coverage.monthlyExpenses, currency)}/mo</span>
            </Stat>
          )}
          {reachableSoon > 0 && (
            <Stat label="Within days">{approx}{formatCurrency(reachableSoon, currency)}</Stat>
          )}
          {sharePctNow != null && (
            <Stat label="Share reachable now">
              <span style={{ color: nowColor }}>{sharePctNow.toFixed(0)}%</span>
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
              {redactions > 0 ? ` · ${redactions} account detail${redactions === 1 ? "" : "s"} withheld` : ""}
            </span>
          )}
        </p>
      )}

      {/* Trust caveat — the SHARED indicator over the SAME envelope the shell chip reads
          (reconstructed/estimated tier, or an orthogonal FX caveat). Renders only when
          noteworthy; the "≈"/reason marker is no longer hand-derived. */}
      <TrustIndicator variant="inline" envelope={envelope} className="mt-2" />
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{label}</span>
      <span className="text-[var(--text-secondary)]">{children}</span>
    </span>
  );
}
