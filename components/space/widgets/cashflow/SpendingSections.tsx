"use client";

/**
 * components/space/widgets/cashflow/SpendingSections.tsx  (v2.7 final perspective UX pass)
 *
 * The Spending perspective's own surfaces (owner decision: Spending is a separate
 * perspective, no longer a toggle inside Cash Flow):
 *
 *   SpendingHero          — "Total spending" for the window (economicSpend), its
 *                           change vs the comparison window (spending up = worse).
 *   SpendingTierBreakdown — the compact credit / direct split (economicSpendByTier):
 *                           Credit-card spending · Direct & other spending · the
 *                           refunds-beyond-charges line when > 0 · = Total spending.
 *   SpendingDistribution  — the distribution donut (the shared BreakdownWidget, the
 *                           Net Worth / Cash / Debt idiom) over the category net
 *                           figures, with the category ledger directly beneath it
 *                           in the same Surface (grouped visually).
 *
 * Semantics (the economic axis, unchanged): card purchases count at purchase; a
 * card bill payment is not spending again; owned transfers are excluded; refunds
 * net against their own tier / category. Presentation only — every figure arrives
 * from the composition contract or an existing authority; nothing is folded here.
 */

import type { ReactNode } from "react";
import { COMPACT_HERO } from "@/components/space/compact/compact-hero";
import { formatCurrency } from "@/lib/currency";
import { Figure, Surface } from "@/components/atlas/Surface";
import { DeltaBadge } from "@/components/space/widgets/wealth/wealth-ui";
import { HeroEyebrow } from "@/components/space/hero/HeroParts";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { periodLabel, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { EconomicSpendByTier } from "@/lib/transactions/cash-flow-projection";
import type { CashFlowHeroChange } from "./CashFlowHero";
import type { SpendingDonutModel } from "./spending-distribution";

/** The sub line under the Spending headline — exported so a test pins the copy. */
export const SPENDING_HERO_SUB =
  "purchases across cards and bank accounts, net of refunds — card payments aren't counted again";

export function SpendingHero({
  total,
  currency,
  period,
  windowLabel,
  change,
}: {
  /** data.spending.net — THE Total spending, or null while transactions load. */
  total:       number | null | undefined;
  currency:    string;
  period:      CashFlowPeriod;
  windowLabel: string;
  /** Total-spending delta vs the comparison window, or null (then nothing is shown). */
  change:      CashFlowHeroChange | null;
}) {
  const value = total == null ? "—" : formatCurrency(total, currency);
  return (
    <section className={COMPACT_HERO} data-hero="spending">
      <HeroEyebrow label={`Total spending · ${periodLabel(period)}`} />
      <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-2">
        <Figure value={value} size="hero" tone={total == null ? "muted" : "neutral"} className="sm:text-5xl leading-none" />
        {total != null && change != null && (
          <DeltaBadge abs={change.abs} pct={change.pct} currency={currency} goodDirection="down" compareLabel={change.fromLabel} className="!text-xs" />
        )}
      </div>
      <p className="mt-2.5 text-sm text-[var(--text-secondary)]">
        {SPENDING_HERO_SUB}
        <span className="text-[var(--text-muted)]"> · {windowLabel}</span>
      </p>
    </section>
  );
}

function TierRow({ label, value, sub, onOpen, strong }: { label: string; value: string; sub?: string; onOpen?: () => void; strong?: boolean }) {
  const body = (
    <>
      <span className="min-w-0">
        <span className={strong ? "block text-sm font-semibold text-[var(--text-primary)]" : "block text-sm text-[var(--text-secondary)]"}>{label}</span>
        {sub && <span className="block text-[11px] leading-snug text-[var(--text-faint)]">{sub}</span>}
      </span>
      <span className={strong ? "shrink-0 text-base font-semibold tabular-nums text-[var(--text-primary)]" : "shrink-0 text-sm font-semibold tabular-nums text-[var(--text-primary)]"}>{value}</span>
    </>
  );
  return onOpen ? (
    <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onOpen}
      className="w-full flex items-start justify-between gap-3 text-left rounded-lg -mx-1 px-1 py-1 hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
      {body}
    </button>
  ) : (
    <div className="flex items-start justify-between gap-3 py-1">{body}</div>
  );
}

/** The credit / direct split. creditCard + direct − refundsUnapplied = Total spending
 *  (economicSpendByTier's identity), shown as arithmetic so it visibly reconciles. */
export function SpendingTierBreakdown({
  tier, total, fmt, onOpenCard, onOpenDirect, onOpenRefunds,
}: {
  tier: EconomicSpendByTier;
  total: number;
  fmt: (v: number) => string;
  onOpenCard?: () => void;
  onOpenDirect?: () => void;
  onOpenRefunds?: () => void;
}) {
  return (
    <div data-spending-tiers><Surface className="p-4 min-w-0">
      <TierRow label="Credit-card spending" sub="card purchases, counted when you buy" value={fmt(tier.creditCard)} onOpen={onOpenCard} />
      <TierRow label="Direct & other spending" sub="paid straight from your bank accounts" value={fmt(tier.direct)} onOpen={onOpenDirect} />
      {tier.refundsUnapplied > 0 && (
        <TierRow label="Refunds beyond charges" sub="refunds larger than the charges on the same accounts this period" value={`−${fmt(tier.refundsUnapplied)}`} onOpen={onOpenRefunds} />
      )}
      <div className="mt-1 border-t border-[var(--border-hairline)] pt-1">
        <TierRow label="Total spending" value={fmt(total)} strong />
      </div>
    </Surface></div>
  );
}

/** Donut (high on the page, like the other perspectives) + the category ledger beneath it. */
export function SpendingDistribution({
  model, fmt, ledger,
}: {
  model:  SpendingDonutModel;
  fmt:    (v: number) => string;
  /** The category ledger (CashFlowCategoryLedger) — rendered directly beneath the ring. */
  ledger: ReactNode;
}) {
  return (
    <div data-spending-distribution><Surface className="p-4 min-w-0">
      {model.slices.length > 0 && (
        <div role="group" aria-label={`${model.centerLabel}: ${fmt(model.centerValue)}`} data-spending-donut>
          <BreakdownWidget
            items={model.slices}
            viewMode="donut"
            itemNoun="category"
            formatValue={fmt}
            centerTotal={{ value: model.centerValue, label: model.centerLabel }}
            centerTone="neutral"
            emptyHeadline="No spending to draw"
          />
          {!model.reconciles && (
            <p className="mt-3 text-[11px] text-[var(--text-faint)]" data-spending-adjustment>
              {model.adjustment > 0 ? `Less refunds with no matching purchase −${fmt(model.adjustment)} · ` : ""}
              Total spending {fmt(model.total)}
            </p>
          )}
        </div>
      )}
      <div className={model.slices.length > 0 ? "mt-4 border-t border-[var(--border-hairline)] pt-4" : ""}>
        {ledger}
      </div>
    </Surface></div>
  );
}
