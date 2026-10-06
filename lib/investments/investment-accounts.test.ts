/**
 * lib/investments/investment-accounts.test.ts  (2026-10-07)
 *
 * Every account that contributes to the canonical investment aggregate is
 * findable in Assets — at its balance, whether or not holdings exist — and the
 * Assets ledger reconciles with that aggregate instead of computing a second
 * one. Dogfood: a Sandbox user's 401(k) + IRA ($23,952.74, institution with no
 * Investments product) were counted at the top of Assets and shown as
 * "Portfolio value $0.00 · No holdings" in its Investments section.
 *
 *   npx tsx lib/investments/investment-accounts.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleInvestmentAccounts, type InvestmentAccountInput } from "./investment-accounts";
import { classifyAccounts } from "@/lib/account-classifier";
import { investedClassLabel } from "@/lib/wealth/invested-label";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

const acct = (over: Partial<InvestmentAccountInput> & Pick<InvestmentAccountInput, "id" | "type" | "balance">): InvestmentAccountInput => ({
  currency: "USD", name: over.id, institution: "First Platypus Bank - OAuth", detailVisible: true,
  consentPending: false, connectionNeedsAttention: false, holdings: 0, ...over,
});

// The live Preview population (Brandon), plus the classes the invariant names.
const K401   = acct({ id: "Plaid 401k", type: "investment", balance: 23631.9805 });
const IRA    = acct({ id: "Plaid IRA",  type: "investment", balance: 320.76 });
const BROKER = acct({ id: "Schwab Brokerage", type: "investment", balance: 50_000, holdings: 12, institution: "Schwab" });
const ROTH   = acct({ id: "Roth IRA", type: "investment", balance: 8_000, holdings: 3 });
const WALLET = acct({ id: "BTC wallet", type: "crypto", balance: 1_500, institution: null });
const CHECK  = acct({ id: "Checking", type: "checking", balance: 9_999 });
const PENDING = acct({ id: "Consent-pending 403b", type: "investment", balance: 4_000, consentPending: true });

console.log("1–3. Every investment account is listed at its balance; holdings are enrichment");
{
  const s = assembleInvestmentAccounts([BROKER, ROTH, K401, IRA], "USD");
  const row = (id: string) => s.rows.find((r) => r.id === id)!;
  check("brokerage WITH holdings: listed, counted, status holdings (12)", row("Schwab Brokerage").status === "holdings" && row("Schwab Brokerage").holdings === 12 && row("Schwab Brokerage").counted);
  check("retirement WITH holdings (Roth IRA): listed with its holdings", row("Roth IRA").status === "holdings" && row("Roth IRA").value === 8000);
  check("REGRESSION: retirement with a balance and NO holdings (401k) is listed at its balance", row("Plaid 401k").value === 23631.9805 && row("Plaid 401k").counted);
  check("…and says holdings are unavailable — never claims any", row("Plaid 401k").status === "holdings_unavailable" && row("Plaid 401k").holdings === 0);
}

console.log("4. Unsupported Investments product: the account does not disappear");
{
  const s = assembleInvestmentAccounts([K401, IRA], "USD");
  check("both live Preview accounts are present", s.rows.length === 2);
  check("REGRESSION: the ledger total is $23,952.74 — the canonical figure, not $0", near(s.investmentsTotal + s.cryptoTotal, 23952.7405), String(s.investmentsTotal));
  check("…and equals SpaceSnapshot.stocks for that Space (23952.7405 on Preview)", near(s.investmentsTotal, 23952.7405) && s.cryptoTotal === 0);
}

console.log("5–6. Reconciliation with the canonical aggregate; no double counting");
{
  const all = [BROKER, ROTH, K401, IRA, WALLET, CHECK, PENDING];
  const s = assembleInvestmentAccounts(all, "USD");
  const canonical = classifyAccounts(all.filter((a) => !a.consentPending)); // the snapshot's population and rule
  check("investments total = classifyAccounts(...).totalInvestments", near(s.investmentsTotal, canonical.totalInvestments));
  check("crypto total = classifyAccounts(...).totalDigitalAssets", near(s.cryptoTotal, canonical.totalDigitalAssets));
  const countedSum = s.rows.filter((r) => r.counted).reduce((t, r) => t + (r.value ?? 0), 0);
  check("Σ counted rows = the canonical total (the ledger is not a second interpretation)", near(countedSum, s.investmentsTotal + s.cryptoTotal));
  check("non-investment accounts are not listed", !s.rows.some((r) => r.id === "Checking"));
  const noHoldings = assembleInvestmentAccounts(all.map((a) => ({ ...a, holdings: 0 })), "USD");
  check("no double counting: holdings never change a value or a total",
    near(noHoldings.investmentsTotal, s.investmentsTotal) && s.rows.every((r) => r.value === noHoldings.rows.find((x) => x.id === r.id)!.value));
}

console.log("7. Consent-pending accounts: shown, honestly not counted (the snapshot's own rule)");
{
  const s = assembleInvestmentAccounts([K401, PENDING], "USD");
  const p = s.rows.find((r) => r.id === "Consent-pending 403b")!;
  check("listed, marked consent_required, not counted", p.status === "consent_required" && !p.counted);
  check("excluded from the total, exactly as SpaceSnapshot excludes it", near(s.investmentsTotal, 23631.9805));
  check("counted rows sort before uncounted ones", s.rows[s.rows.length - 1].id === "Consent-pending 403b");
}

console.log("Visibility: a link that withholds detail shows the value, not the identity");
{
  const s = assembleInvestmentAccounts([{ ...K401, detailVisible: false }], "USD");
  check("generic name, no institution, value still counted", s.rows[0].name === "Investment account" && s.rows[0].institution === null && s.rows[0].counted);
}

console.log("Label: named for the classes actually held");
check("investments only ⇒ Investments", investedClassLabel({ investments: 23952.74, crypto: 0 }) === "Investments");
check("investments + crypto ⇒ Investments & crypto", investedClassLabel({ investments: 50_000, crypto: 1_500 }) === "Investments & crypto");
check("crypto only ⇒ Crypto", investedClassLabel({ investments: 0, crypto: 1_500 }) === "Crypto");
check("neither ⇒ null (no manufactured category)", investedClassLabel({ investments: 0, crypto: 0 }) === null);
check("float residue is not a holding", investedClassLabel({ investments: 23952.74, crypto: 1e-9 }) === "Investments");

console.log("Surfaces and authority");
{
  const ws = code("components/space/widgets/investments/InvestmentsWorkspace.tsx");
  check("REGRESSION: with accounts but no holdings, the ledger renders INSTEAD of '$0 / No holdings'",
    /if \(isEmpty && accountsLedger\)/.test(ws) && ws.indexOf("isEmpty && accountsLedger") < ws.indexOf("No holdings for this date"));
  check("the ledger also renders when holdings exist", (ws.match(/\{accountsLedger\}/g) ?? []).length >= 2);
  check("the generic Connections card is gone from the Investments section", !/InvestmentConnectionsCard/.test(ws));
  const hero = code("components/space/widgets/wealth/WealthHero.tsx");
  check("REGRESSION: the headline/secondary invested label comes from the composition, not a constant",
    /investedClassLabel\(asOfState\.composition\)/.test(hero) && /metricLabel/.test(hero) && /secondaryRows\.map/.test(hero));
  const loader = code("lib/investments/space-data.ts");
  check("the ledger reads the canonical population (the snapshot's reader + the shared consent rule)",
    /readSpaceAccountsForSnapshot\(spaceId,/.test(loader) && /consentPendingInvestmentAccountIds\(/.test(loader));
  check("…on the caller's client (no owner/system client in this module — RLS applies)", !/from "@\/lib\/db"/.test(loader));
  check("the snapshot uses the SAME consent rule", /consentPendingInvestmentAccountIds\(client,/.test(code("lib/snapshots/regenerate.ts")));
}

if (failures > 0) { console.error(`\ninvestment-accounts.test: ${failures} failure(s).`); process.exit(1); }
console.log("\ninvestment-accounts.test: all passed.");
