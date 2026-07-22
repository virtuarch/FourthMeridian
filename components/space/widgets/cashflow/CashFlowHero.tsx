"use client";

/**
 * components/space/widgets/cashflow/CashFlowHero.tsx
 *
 * Surface ① of the Cash Flow Workspace — the editorial lede, in the Net Worth /
 * prototype idiom (bare, no card): an eyebrow + trust chip, the Net headline for
 * the selected window, its change vs the comparison window, a quiet "as of" bridge
 * line, and the perspective toggle. Mirrors DebtHero / InvestmentsHero, tuned for
 * an OPERATIONAL surface — the Cash In / Cash Out drilldowns and the movement
 * context render just below (CashFlowSummaryWidget, headless), not inside the lede.
 *
 * HONESTY — Cash Flow is genuinely historical (transaction-based; the window
 * travels with As-Of), so unlike Debt/Liquidity there is NO present-day headline
 * masquerading as as-of and NO "balances are current" caveat. The Net and its
 * delta are on the SAME reconstructed basis, so the delta is shown in a historical
 * view too (never suppressed).
 *
 * Presentation only — every figure is passed in, already folded/converted upstream
 * (the contract's DayFacts + the workspace's compareCashFlow window delta). The
 * one derivation here is the perspective-dependent Net, taken straight off the
 * shared facts via the canonical economicSpend helper (no new fold), so it
 * reconciles by construction with the tiles below.
 */

import { formatCurrency, formatDate } from "@/lib/format";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { Figure } from "@/components/atlas/Surface";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import { DeltaBadge } from "@/components/space/widgets/wealth/wealth-ui";
import { periodLabel, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { economicSpend, type CashFlowPerspective, type DayFacts } from "@/lib/transactions/cash-flow-projection";
import { CashFlowFilterControls, DEFAULT_FILTER_ID } from "@/components/space/widgets/CashFlowFilterControls";

/** The comparison-window delta, ready for the badge (now − then over the shared
 *  projection; see compareCashFlow). Null when no honest comparison exists. */
export interface CashFlowHeroChange {
  /** now.net − then.net for the active perspective (positive = net improved). */
  abs: number;
  /** % of the opening (|then.net|), or null when the opening is 0/unknown. */
  pct: number | null;
  /** The comparison window's label, for the "vs {…}" suffix. */
  fromLabel: string;
}

/** The perspective-dependent Net for the window, off the shared facts (no re-fold).
 *  Liquidity: Cash In − Cash Out. Economic: Income − clamped spending. Identical to
 *  the arithmetic in CashFlowSummaryWidget, so the headline and the tiles agree. */
export function heroNet(facts: DayFacts, perspective: CashFlowPerspective): number {
  return perspective === "economic"
    ? facts.income - economicSpend(facts)
    : facts.cashIn - facts.cashOut;
}

export function CashFlowHero({
  facts,
  perspective,
  filterId,
  onPerspectiveChange,
  currency,
  period,
  asOf,
  change,
  envelope,
}: {
  /** The contract's window summary facts, or null while transactions load. */
  facts:        DayFacts | null | undefined;
  perspective:  CashFlowPerspective;
  filterId:     string;
  onPerspectiveChange: (perspective: CashFlowPerspective, filterId: string) => void;
  currency:     string;
  period:       CashFlowPeriod;
  /** Canonical As-of — the window anchor (Cash Flow is historical, so this is the
   *  window's real end, not "today"). */
  asOf:         string;
  /** The comparison-window Net delta, or null when no honest comparison exists. */
  change:       CashFlowHeroChange | null;
  /** The workspace's canonical trust envelope — drives the confidence chip. */
  envelope:     PerspectiveEnvelope;
}) {
  const economic = perspective === "economic";
  const net = facts ? heroNet(facts, perspective) : null;
  const netStr = net == null ? "—" : `${net >= 0 ? "+" : "−"}${formatCurrency(Math.abs(net), currency)}`;

  return (
    // Bare hero — no card, no border. The Net headline is the point; the breakdown
    // tiles and read surfaces sit below.
    <section>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Net cash flow · {periodLabel(period)}
        </p>
        <TrustIndicator variant="compact" envelope={envelope} />
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-2">
        <Figure
          value={netStr}
          size="hero"
          tone={net == null ? "muted" : net >= 0 ? "up" : "down"}
          className="sm:text-5xl leading-none"
        />
        {/* Cash Flow reconstructs historically, so the headline and this delta share
            ONE basis — the delta is coherent in a historical view too and is never
            deferred (unlike Debt's present-day-vs-as-of split). */}
        {net != null && (
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
            <span className="text-[11px] text-[var(--text-muted)]">Set a Compare To date above to see the change.</span>
          )
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-[var(--text-secondary)]">
          {economic ? "net after spending (incl. credit-card purchases)" : "net cash this period"}
          <span className="text-[var(--text-muted)]"> · as of {formatDate(asOf)}</span>
        </p>
        {/* Perspective toggle (Cash Flow ⇄ Spending) — relocated here from the
            Summary panel corner; the workspace still owns the shared state. */}
        <CashFlowFilterControls
          perspective={perspective}
          filterId={filterId || DEFAULT_FILTER_ID}
          onChange={onPerspectiveChange}
          compact
        />
      </div>
    </section>
  );
}
