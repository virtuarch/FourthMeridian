/**
 * lib/connections/connection-facts.ts  (server-side — the loader's facts)
 *
 * Kept out of connection-detail.core.ts so the client bundle does not carry the
 * account classifier. Pure.
 */

import { classifyAccounts } from "@/lib/account-classifier";

/**
 * The Personal Space views that ACTUALLY consume a connection's data:
 *   balances — by THE account classifier (lib/account-classifier), the same
 *     buckets the perspectives total: asset buckets → Net Worth + Assets,
 *     liquid → Cash, investments / digital assets → Investments, liabilities →
 *     Net Worth + Debt;
 *   activity — Transactions / Cash Flow / Spending ONLY when the connection's
 *     accounts have rows in the banking population (`hasBankingRows`), which
 *     excludes crypto-owned rows by design. Imported on-chain transactions do
 *     not make a wallet appear in Cash Flow.
 */
const DESTINATION_ORDER = ["Net Worth", "Assets", "Cash", "Investments", "Debt", "Transactions", "Cash Flow", "Spending"] as const;

export function connectionDestinations(accountTypes: readonly string[], hasBankingRows: boolean): string[] {
  const b = classifyAccounts(accountTypes.map((type) => ({ type, balance: 0 })) as never) as unknown as Record<string, unknown[]>;
  const has = (k: string) => Array.isArray(b[k]) && b[k].length > 0;
  const out = new Set<string>();
  const assets = has("liquid") || has("restrictedCash") || has("investments") || has("digitalAssets") || has("realAssets");
  if (assets) { out.add("Net Worth"); out.add("Assets"); }
  if (has("liquid")) out.add("Cash");
  if (has("investments") || has("digitalAssets")) out.add("Investments");
  if (has("liabilities")) { out.add("Net Worth"); out.add("Debt"); }
  if (hasBankingRows) { out.add("Transactions"); out.add("Cash Flow"); out.add("Spending"); }
  return DESTINATION_ORDER.filter((d) => out.has(d));
}

