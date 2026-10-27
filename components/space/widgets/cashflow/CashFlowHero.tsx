"use client";

/**
 * components/space/widgets/cashflow/CashFlowHero.tsx
 *
 * Surface ① of the Cash Flow Workspace — the editorial lede, in the Net Worth /
 * prototype idiom (bare, no card): an eyebrow, the Net headline for
 * the selected window, its change vs the comparison window, a quiet "as of" bridge
 * line. Mirrors DebtHero / InvestmentsHero, tuned for
 * an OPERATIONAL surface — the Cash In / Cash Out drilldowns and the movement
 * context render just below (CashFlowSummaryWidget, headless), not inside the lede.
 *
 * HONESTY — Cash Flow is genuinely historical (transaction-based; the window
 * travels with As-Of), so unlike Debt/Liquidity there is NO present-day headline
 * masquerading as as-of and NO "balances are current" caveat. The Net and its
 * delta are on the SAME reconstructed basis, so the delta is shown in a historical
 * view too (never suppressed).
 *
 * v2.7 FINAL PERSPECTIVE UX PASS (owner) — Cash Flow is ONE axis now: actual
 * cash movement (liquidity). The former Cash Flow ⇄ Spending toggle is gone —
 * Spending is its own perspective (SpendingHero). The "Set a Compare To date
 * above to see the change." hint is gone too: no comparison ⇒ nothing is shown.
 * The eyebrow is the shared HeroEyebrow (one header skeleton across perspectives).
 *
 * Presentation only — every figure is passed in, already folded/converted upstream
 * (the contract's DayFacts + the workspace's compareCashFlow window delta). The
 * one derivation here is the perspective-dependent Net, taken straight off the
 * shared facts via the canonical economicSpend helper (no new fold), so it
 * reconciles by construction with the tiles below.
 *
 * NO PROVENANCE BADGE — this hero deliberately mounts no TrustIndicator, for ANY
 * completeness tier. The workspace still resolves the Cash Flow trust envelope and
 * reports it up (onEnvelopeChange), so the shell's ShellTrustRow keeps showing the
 * orthogonal FX / syncing caveats, and the Insights card keeps its stamp caveat.
 * The other four Overview heroes keep their compact TrustIndicator.
 */

import { formatCurrency } from "@/lib/currency";
import { Figure } from "@/components/atlas/Surface";
import { DeltaBadge } from "@/components/space/widgets/wealth/wealth-ui";
import { periodLabel, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { economicSpend, type CashFlowPerspective, type DayFacts } from "@/lib/transactions/cash-flow-projection";
import { HeroEyebrow, HeroTalk } from "@/components/space/hero/HeroParts";
import { useSpaceChrome } from "@/lib/space/space-chrome-context";
import { CompactHeroCard } from "@/components/space/compact/CompactHeroCard";
import { compactWindowLabel } from "./hero-window-label";

/** The comparison-window delta, ready for the badge (now − then over the shared
 *  projection; see compareCashFlow). Null when no honest comparison exists. */
export interface CashFlowHeroChange {
  /** now − then for the hero's figure (Cash Flow: net; Spending: total spending). */
  abs: number;
  /** % of the opening (|then|), or null when the opening is 0/unknown. */
  pct: number | null;
  /** The comparison window's label, for the "vs {…}" suffix. */
  fromLabel: string;
}

/** The sub line under the Cash Flow headline — exported so a test pins the copy. */
export const CASH_FLOW_HERO_SUB = "cash that moved in and out of your bank accounts";

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
  currency,
  period,
  windowLabel,
  change,
}: {
  /** The contract's window summary facts, or null while transactions load. */
  facts:        DayFacts | null | undefined;
  currency:     string;
  period:       CashFlowPeriod;
  /** Where the window sits ("as of Oct 27, 2026", or an explicit period's range). */
  windowLabel:  string;
  /** The comparison-window Net delta, or null when no honest comparison exists. */
  change:       CashFlowHeroChange | null;
}) {
  const net = facts ? heroNet(facts, "liquidity") : null;
  // v2.7 mobile/desktop parity — the Space's canonical freshness claim ("Last
  // checked N ago"), the SAME string the desktop sidebar and the Net Worth /
  // Debt compact heroes show (SpaceDashboard publishes it to the chrome). The
  // compact card used to pass null here, so a phone never said how fresh
  // Cash Flow's data was.
  const freshness = useSpaceChrome().space?.identity.updatedLabel ?? null;
  const showChange = net != null && change != null;
  const netStr = net == null ? "—" : `${net >= 0 ? "+" : "−"}${formatCurrency(Math.abs(net), currency)}`;

  return (
    <>
      {/* COMPACT (<lg) — the shared five-row card, the SAME skeleton as Net Worth /
          Assets / Debt (v2.7 final UX pass, one page shell). No trust chip: Cash
          Flow mounts no provenance badge by design (see the header note). */}
      <CompactHeroCard
        title={`Net cash flow · ${periodLabel(period)}`}
        freshness={freshness}
        trust={null}
        value={netStr}
        valueTone={net != null && net < 0 ? "negative" : "neutral"}
        change={showChange ? { abs: change.abs, pct: change.pct, goodDirection: "up" } : null}
        range={compactWindowLabel(windowLabel)}
        currency={currency}
        talkSection="cash-flow"
        talkPeriod={period}
        note={flowHeroNote(CASH_FLOW_HERO_SUB, showChange ? change.fromLabel : null)}
      />

      {/* DESKTOP (≥lg) — bare hero, no card, no border. The Net headline is the
          point; the Cash In / Cash Out summaries and read surfaces sit below. */}
      <section className="max-lg:hidden">
        <HeroEyebrow label={`Net cash flow · ${periodLabel(period)}`} />

        <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-2">
          <Figure
            value={netStr}
            size="hero"
            tone={net == null ? "muted" : net >= 0 ? "up" : "down"}
            className="sm:text-5xl leading-none"
          />
          {/* Cash Flow reconstructs historically, so the headline and this delta share
              ONE basis. No comparison window ⇒ nothing here (no persistent hint). */}
          {showChange && (
            <DeltaBadge
              abs={change.abs}
              pct={change.pct}
              currency={currency}
              goodDirection="up"
              compareLabel={change.fromLabel}
              className="!text-xs"
            />
          )}
        </div>

        <p className="mt-2.5 text-sm text-[var(--text-secondary)]">
          {CASH_FLOW_HERO_SUB}
          <span className="text-[var(--text-muted)]"> · {windowLabel}</span>
        </p>
        <HeroTalk section="cash-flow" period={period} />
      </section>
    </>
  );
}

/**
 * v2.7 mobile/desktop parity — the compact card's standing note for the flow
 * perspectives: the window the change compares against (the desktop badge's
 * "vs …") and what the figure counts (the desktop sub line). Shared with
 * SpendingHero so both say it the same way.
 */
export function flowHeroNote(sub: string, fromLabel: string | null): string {
  const what = sub.charAt(0).toUpperCase() + sub.slice(1);
  return fromLabel ? `Change vs ${fromLabel} · ${what}` : what;
}
