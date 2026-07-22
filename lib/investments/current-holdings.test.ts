/**
 * lib/investments/current-holdings.test.ts
 *
 * Pure tests for the Investment connection-state derivation (Connections card).
 * Standalone `tsx` script (exit 0/1), no DB — same pattern as lib/sync/status.test.ts.
 *
 *     npx tsx lib/investments/current-holdings.test.ts
 *
 * P2-5: the module derives state from a canonical position COUNT
 * (getCurrentPositions), not from legacy Holding contents — it is a connection-
 * health surface, not a portfolio surface.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveInvestmentAccountState,
  buildInvestmentAccountView,
  buildInvestmentAccountsView,
  type InvestmentAccountInput,
} from "./current-holdings";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

function acct(p: Partial<InvestmentAccountInput>): InvestmentAccountInput {
  return {
    accountId: p.accountId ?? "a", name: p.name ?? "Acct", institution: p.institution ?? "Broker",
    type: p.type ?? "investment", balance: p.balance ?? 1000, currency: p.currency ?? "USD",
    lastUpdated: p.lastUpdated ?? null, provider: p.provider ?? "PLAID",
    plaidItemId: p.plaidItemId ?? "item1",
    investmentsConsent: p.investmentsConsent ?? "ENABLED",
    itemStatus: p.itemStatus ?? "ACTIVE", itemErrorCode: p.itemErrorCode ?? null,
    lastSyncedAt: p.lastSyncedAt ?? null, positionCount: p.positionCount ?? 0,
  };
}

console.log("deriveInvestmentAccountState — precedence + honesty");
check("crypto/wallet → wallet (before positionCount is consulted)",
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

console.log("buildInvestmentAccountView — canonical count → state");
const withPositions = buildInvestmentAccountView(acct({ positionCount: 2 }));
check("positionCount passed through", withPositions.positionCount === 2);
check("totalValue = account balance (canonical, from FinancialAccount)", withPositions.totalValue === 1000);
check("state = holdings", withPositions.state === "holdings");

console.log("buildInvestmentAccountsView — richest account first");
const list = buildInvestmentAccountsView([
  acct({ accountId: "small", balance: 100 }),
  acct({ accountId: "big", balance: 9000 }),
]);
check("sorted by totalValue desc", list[0].accountId === "big" && list[1].accountId === "small");

console.log("zero-holdings account keeps its balance visible");
const zero = buildInvestmentAccountView(acct({ balance: 484.22, positionCount: 0 }));
check("zero_holdings state", zero.state === "zero_holdings");
check("balance preserved for display", zero.totalValue === 484.22);

// ── Source guard — Connections stays off the general legacy Holding read ──────
console.log("source guard — no general legacy Holding read in Connections");
{
  const dataFn = readFileSync(join(process.cwd(), "lib/data/investment-accounts.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments
  check("investment-accounts.ts does NOT call getHoldings", !/getHoldings/.test(dataFn));
  check("investment-accounts.ts does NOT read prisma.holding directly", !/\.holding\./.test(dataFn));
  check("investment-accounts.ts sources presence from countCurrentPositionsByAccount",
    /countCurrentPositionsByAccount\s*\(/.test(dataFn));

  const pureMod = readFileSync(join(process.cwd(), "lib/investments/current-holdings.ts"), "utf8");
  check("current-holdings.ts carries no holding-contents view (position PRESENCE only)",
    !/HoldingView/.test(pureMod));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll current-holdings checks passed");
