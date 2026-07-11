/**
 * lib/investments/current-holdings.test.ts
 *
 * Pure tests for the Investments-by-account derivation (Slice B). Standalone
 * `tsx` script (exit 0/1), no DB — same pattern as lib/sync/status.test.ts.
 *
 *     npx tsx lib/investments/current-holdings.test.ts
 */

import {
  deriveInvestmentAccountState,
  buildInvestmentAccountView,
  buildInvestmentAccountsView,
  type InvestmentAccountInput,
  type HoldingView,
} from "./current-holdings";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

function holding(p: Partial<HoldingView>): HoldingView {
  return {
    id: p.id ?? "h", symbol: p.symbol ?? "AAA", name: p.name ?? "Thing",
    quantity: p.quantity ?? 1, price: p.price ?? 10, value: p.value ?? 10,
    currency: p.currency ?? "USD", change24h: p.change24h ?? 0, isCash: p.isCash ?? false,
  };
}

function acct(p: Partial<InvestmentAccountInput>): InvestmentAccountInput {
  return {
    accountId: p.accountId ?? "a", name: p.name ?? "Acct", institution: p.institution ?? "Broker",
    type: p.type ?? "investment", balance: p.balance ?? 1000, currency: p.currency ?? "USD",
    lastUpdated: p.lastUpdated ?? null, provider: p.provider ?? "PLAID",
    plaidItemId: p.plaidItemId ?? "item1",
    investmentsConsent: p.investmentsConsent ?? "ENABLED",
    itemStatus: p.itemStatus ?? "ACTIVE", itemErrorCode: p.itemErrorCode ?? null,
    lastSyncedAt: p.lastSyncedAt ?? null, holdings: p.holdings ?? [],
  };
}

console.log("deriveInvestmentAccountState — precedence + honesty");
check("crypto/wallet → wallet",
  deriveInvestmentAccountState({ type: "crypto", provider: "WALLET", investmentsConsent: null, itemStatus: null, positionCount: 0 }) === "wallet");
check("plaid ERROR beats holdings → error",
  deriveInvestmentAccountState({ type: "investment", provider: "PLAID", investmentsConsent: "ENABLED", itemStatus: "ERROR", positionCount: 5 }) === "error");
check("plaid NEEDS_REAUTH → needs_reauth",
  deriveInvestmentAccountState({ type: "investment", provider: "PLAID", investmentsConsent: "ENABLED", itemStatus: "NEEDS_REAUTH", positionCount: 5 }) === "needs_reauth");
check("consent required (even with 0 holdings) → consent_required",
  deriveInvestmentAccountState({ type: "investment", provider: "PLAID", investmentsConsent: "CONSENT_REQUIRED", itemStatus: "ACTIVE", positionCount: 0 }) === "consent_required");
check("enabled + positions → holdings",
  deriveInvestmentAccountState({ type: "investment", provider: "PLAID", investmentsConsent: "ENABLED", itemStatus: "ACTIVE", positionCount: 3 }) === "holdings");
check("enabled + no positions → zero_holdings (NOT collapsed to consent)",
  deriveInvestmentAccountState({ type: "investment", provider: "PLAID", investmentsConsent: "ENABLED", itemStatus: "ACTIVE", positionCount: 0 }) === "zero_holdings");

console.log("buildInvestmentAccountView — split cash + sort positions");
const view = buildInvestmentAccountView(acct({
  holdings: [
    holding({ id: "c", symbol: "CASH", isCash: true, value: 200 }),
    holding({ id: "s", symbol: "VOO", value: 500 }),
    holding({ id: "b", symbol: "AAPL", value: 900 }),
  ],
}));
check("cash split out of positions", view.cash?.id === "c" && view.positions.every((p) => !p.isCash));
check("positionCount excludes cash", view.positionCount === 2);
check("positions sorted by value desc", view.positions[0].symbol === "AAPL" && view.positions[1].symbol === "VOO");
check("totalValue = account balance (canonical)", view.totalValue === 1000);
check("state = holdings", view.state === "holdings");

console.log("buildInvestmentAccountsView — richest account first");
const list = buildInvestmentAccountsView([
  acct({ accountId: "small", balance: 100 }),
  acct({ accountId: "big", balance: 9000 }),
]);
check("sorted by totalValue desc", list[0].accountId === "big" && list[1].accountId === "small");

console.log("zero-holdings account keeps its balance visible");
const zero = buildInvestmentAccountView(acct({ balance: 484.22, holdings: [] }));
check("zero_holdings state", zero.state === "zero_holdings");
check("balance preserved for display", zero.totalValue === 484.22);

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll current-holdings checks passed");
