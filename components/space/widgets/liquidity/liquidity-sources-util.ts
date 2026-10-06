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
 * The horizons mirror the Liquidity Ladder and come from liquidityAccess
 * (lib/account-classifier.ts): unrestricted cash = NOW, known brokerage + crypto =
 * DAYS, retirement/HSA = RESTRICTED, investments of unreported kind = UNVERIFIED,
 * other = ILLIQUID. Names/colours live in ./horizons.ts.
 */

import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { liquidityAccess } from "@/lib/account-classifier";
import type { ConversionContext } from "@/lib/money/types";
import { reachableForAccount, type LiquidityAdapterAccount } from "@/components/space/widgets/liquidity-adapters";

export { HORIZON_LABEL, HORIZON_META, HORIZON_COLOR, HORIZON_ORDER, type SourceHorizon } from "./horizons";
import type { SourceHorizon } from "./horizons";

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

/** Classify a source into its access horizon — liquidityAccess, the one rule
 *  (lib/account-classifier.ts): type AND provider subtype. Debt/unknown types are
 *  not liquidity sources. */
export function classifySource(a: LiquidityAdapterAccount): SourceHorizon | null {
  switch (liquidityAccess(a)) {
    case "cash":       return "now";
    case "marketable": return "days";
    case "restricted": return "restricted";
    case "unverified": return "unverified";
    case "illiquid":   return "illiquid";
    default:           return null; // debt / uncategorized — excluded from the sources ledger
  }
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
      // v2.6-L3 — a row under the "Available now" heading shows the REACHABLE
      // figure, through the same authority the headline totals, so a row and the
      // headline above it can never disagree. Non-cash horizons are unchanged.
      // Null (reachable unknown) yields 0 and is dropped by the filter below —
      // the same exclusion the total applies.
      const reach = horizon === "now" ? reachableForAccount(a, ctx) : null;
      return {
        account:   a,
        horizon,
        value:     horizon === "now" ? (reach ?? 0) : bal.amount,
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
