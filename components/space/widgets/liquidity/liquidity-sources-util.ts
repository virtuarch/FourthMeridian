/**
 * components/space/widgets/liquidity/liquidity-sources-util.ts
 *
 * Pure presentation helpers for the editorial Sources ledger — the liquidity analogue
 * of debt-ledger-util.ts. No math authority beyond the SAME one-FX-pass the adapters
 * already use (convertMoney at the latest close): these helpers CLASSIFY by access
 * horizon and LABEL for grouping/rows. They never introduce a second valuation engine,
 * never read history, and never re-partition the canonical liquidity tiers — the horizon
 * of an account is a pure function of its type, exactly as classifyAccounts buckets it.
 *
 * The three horizons mirror the Liquidity Ladder (liquidity-adapters.tsx doctrine):
 * checking/savings = reachable NOW, investment/crypto = reachable in DAYS (settlement),
 * other = ILLIQUID. The schema has no retirement/settlement typing, so no "locked /
 * penalty" tier is faked — the same honest reduction the adapters enforce.
 */

import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { isDigitalAssetAccountType } from "@/lib/account-classifier";
import type { ConversionContext } from "@/lib/money/types";
import type { LiquidityAdapterAccount } from "@/components/space/widgets/liquidity-adapters";

/** The three editorial access horizons, in reachability order (top = reachable). */
export type SourceHorizon = "now" | "days" | "illiquid";

export const HORIZON_LABEL: Record<SourceHorizon, string> = {
  now:      "Available now",
  days:     "Available in days",
  illiquid: "Illiquid",
};

/** The quiet sub-label under each horizon heading (what sits in it). */
export const HORIZON_META: Record<SourceHorizon, string> = {
  now:      "Checking · savings",
  days:     "Brokerage · crypto (settlement)",
  illiquid: "Property · other long-term",
};

/** Tier colours — identical to the Ladder tiles so the ledger reads as the same family. */
export const HORIZON_COLOR: Record<SourceHorizon, string> = {
  now:      "#22c55e",
  days:     "#3b82f6",
  illiquid: "#6b7280",
};

/** Ordered top (reachable now) → bottom (locked away) — the ladder reading order. */
export const HORIZON_ORDER: SourceHorizon[] = ["now", "days", "illiquid"];

/**
 * One liquidity source prepared for the ledger + detail — display figures computed
 * ONCE (one FX pass, mirroring the adapters' inDisp), so a row and its detail panel can
 * never disagree.
 */
export interface LiquiditySourceRow {
  account:   LiquidityAdapterAccount;
  horizon:   SourceHorizon;
  /** Display-currency balance. */
  value:     number;
  /** value / total-assets, clamped 0–1 (the weight-bar length). */
  share:     number;
  /** True when the display figure was FX-estimated. */
  estimated: boolean;
}

/** Classify a source into its access horizon — a pure function of account type, the
 *  SAME partition classifyAccounts uses (checking/savings → now, investment/crypto →
 *  days, other → illiquid). Debt/unknown types are not liquidity sources. */
export function classifySource(a: LiquidityAdapterAccount): SourceHorizon | null {
  if (a.type === "checking" || a.type === "savings") return "now";
  if (a.type === "investment" || isDigitalAssetAccountType(a.type)) return "days";
  if (a.type === "other") return "illiquid";
  return null; // debt / uncategorized — excluded from the sources ledger
}

/**
 * Build the ledger rows from the accounts array — one display-currency FX pass over
 * the asset accounts (mirrors the adapters' inDisp; convert each at the latest close).
 * The weight-bar `share` is each row's fraction of TOTAL ASSETS, so the bar length is
 * comparable across horizons ("how much of everything sits here"). Sorted most-first.
 */
export function buildSourceRows(
  accounts: LiquidityAdapterAccount[],
  ctx?:     ConversionContext,
): LiquiditySourceRow[] {
  const asOf = yesterdayUTCISO();
  const conv = (amount: number, currency: string | null | undefined) => {
    if (!ctx) return { amount, estimated: false };
    const c = convertMoney({ amount, currency: currency ?? null }, asOf, ctx);
    return { amount: c.amount, estimated: c.estimated };
  };

  const prepared = accounts
    .map((a) => ({ a, horizon: classifySource(a) }))
    .filter((x): x is { a: LiquidityAdapterAccount; horizon: SourceHorizon } => x.horizon !== null)
    .map(({ a, horizon }) => {
      const bal = conv(a.balance, a.currency);
      return {
        account:   a,
        horizon,
        value:     bal.amount,
        estimated: bal.estimated,
        share:     0, // filled after the total is known
      } as LiquiditySourceRow;
    })
    .filter((r) => r.value > 0);

  const total = prepared.reduce((s, r) => s + r.value, 0);
  for (const r of prepared) r.share = total > 0 ? Math.max(0, Math.min(1, r.value / total)) : 0;

  // Most important first (largest balance), stable across groups.
  return prepared.sort((x, y) => y.value - x.value);
}
