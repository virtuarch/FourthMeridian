/**
 * components/space/widgets/debt/mortgage-f3-labels.render.test.ts
 *
 * Mortgage F3 (S2 ruling) — the debt UI widgets render the rate under the
 * liability KIND's name and surface PARTIAL / rate-unknown states:
 *   • a Plaid mortgage (debtSubtype null, providerSubtype "mortgage") reads
 *     "Mortgage rate", an auto loan "Interest rate" (owner 2026-11-08), a card "APR";
 *   • the payoff planner labels the mortgage's projection "Mortgage rate unknown",
 *     shows the "Rate known for 1 of 2 debts (x% of what you owe)" note, shows
 *     "Not enough rate information" when < 50% of the balance is rated, and never calls a blend of
 *     a mortgage and a card an "APR";
 *   • the signals rail says "no rate", not "no APR", for a mortgage.
 *
 * Fabricated fixtures only. Pure render (renderToStaticMarkup) — no DB, no network.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/widgets/debt/mortgage-f3-labels.render.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DebtPayoffSection } from "@/components/space/sections/DebtPayoffSection";
import { InterestCostWidget } from "./InterestCostWidget";
import { LiabilitiesLedger } from "./LiabilitiesLedger";
import { DebtAccountDetail } from "./DebtAccountDetail";
import { buildDebtSignals } from "./debt-signals";
import { computeDebtKpis } from "./debt-kpis";
import type { LiabilityRow } from "./debt-ledger-util";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const acct = (id: string, name: string, balance: number, over: Partial<DebtPerspectiveAccount> = {}): DebtPerspectiveAccount => ({
  id, name, type: "debt", institution: "Bank", balance, currency: "USD", visibilityLevel: "FULL", ...over,
});
const MORTGAGE = acct("mtg", "Home Loan", 300_000, { providerSubtype: "mortgage" });
const MORTGAGE_RATED = acct("mtg", "Home Loan", 300_000, { providerSubtype: "mortgage", interestRate: 6.5 });
const AUTO = acct("auto", "Car Loan", 12_000, { providerSubtype: "auto", interestRate: 7.25 });
const CARD = acct("card", "Card A", 5_000, { debtSubtype: "credit_card", interestRate: 25 });
const TODAY = "2026-01-01";

console.log("1. Interest cost — per-row label follows the kind");
{
  const t = text(renderToStaticMarkup(createElement(InterestCostWidget, { accounts: [MORTGAGE, CARD, AUTO], onSaved: () => {} })));
  check("Plaid mortgage with no rate: 'no mortgage rate on file', 'Add mortgage rate' — never 'APR'",
    t.includes("Home Loan Interest unknown — no mortgage rate on file") && t.includes("Add mortgage rate"), t);
  check("card keeps '25.00% APR'; auto loan reads '7.25% Interest rate'", t.includes("25.00% APR") && t.includes("7.25% Interest rate"), t);
  check("footer: the unknown debt is a mortgage ⇒ 'without a rate', not 'without an APR'",
    t.includes("1 debt without a rate not counted") && !t.includes("without an APR"), t);
  const html = renderToStaticMarkup(createElement(InterestCostWidget, { accounts: [MORTGAGE_RATED], onSaved: () => {} }));
  check("rated mortgage: '6.50% Mortgage rate', edit control 'Edit mortgage rate for Home Loan'",
    text(html).includes("6.50% Mortgage rate") && html.includes('aria-label="Edit mortgage rate for Home Loan"'), text(html));
}

console.log("2. Liabilities ledger + account detail");
{
  const t = text(renderToStaticMarkup(createElement(LiabilitiesLedger, { accounts: [MORTGAGE_RATED, CARD], currency: "USD" })));
  check("ledger meta: '6.50% Mortgage rate' and '25.00% APR'", t.includes("6.50% Mortgage rate") && t.includes("25.00% APR"), t);
  check("ledger never calls the mortgage rate an APR", !t.includes("6.50% APR"), t);
  const row: LiabilityRow = { account: MORTGAGE, cls: "loans", state: "owed", value: 300_000, credit: 0, share: 1,
    limit: null, estInterest: null, utilizationPct: null, estimated: false };
  const d = text(renderToStaticMarkup(createElement(DebtAccountDetail, { row, currency: "USD" })));
  check("detail facts row is labelled 'Mortgage rate' (unknown ⇒ add it in Interest cost)",
    d.includes("Mortgage rate Unknown — add it in Interest cost") && !/\bAPR\b/.test(d), d);
}

console.log("3. Payoff planner — rate unknown labelled, blend is a 'rate'");
{
  // The planner's default budget is 50/mo, so the fixtures are small enough to amortize.
  const SMALL_MTG = acct("mtg", "Home Loan", 3_000, { providerSubtype: "mortgage" });
  const SMALL_CARD = acct("card", "Card A", 500, { debtSubtype: "credit_card", interestRate: 25 });
  const t = text(renderToStaticMarkup(createElement(DebtPayoffSection, { accounts: [SMALL_MTG, SMALL_CARD], today: TODAY, onAddApr: () => {} })));
  check("by-account row: 'Home Loan Mortgage rate unknown' + 'Interest not included — mortgage rate unknown'",
    t.includes("Home Loan Mortgage rate unknown") && t.includes("Interest not included — mortgage rate unknown"), t);
  check("note states the count AND the owed share: 'Rate known for 1 of 2 debts (14% of what you owe) — …'",
    t.includes("Rate known for 1 of 2 debts (14% of what you owe) — no rate is assumed for the others, and they are left out of the interest total."), t);
  check("estimate notice: 'a rate on file' and 'No rate on file: Home Loan.'",
    t.includes("Interest is counted only on the debts with a rate on file.") && t.includes("No rate on file: Home Loan."), t);
  check("the card + mortgage blend is 'Avg rate (known)', never 'Avg APR'", t.includes("Avg rate (known) · reference") && !t.includes("Avg APR"), t);
  check("14% rated (< 50%) ⇒ 'Not enough rate information' in place of the average",
    t.includes("Avg rate (known) · reference Not enough rate information") && !t.includes("reference 25.00%"), t);
  check("…the number + its coverage stay in the by-account drill-down",
    t.includes("Avg rate (known): 25.00% · rate known for 1 of 2 debts (14% of what you owe)"), t);
  const half = text(renderToStaticMarkup(createElement(DebtPayoffSection, {
    accounts: [acct("mtg", "Home Loan", 500, { providerSubtype: "mortgage" }), acct("card", "Card A", 500, { debtSubtype: "credit_card", interestRate: 25 })],
    today: TODAY, onAddApr: () => {},
  })));
  check("50% rated ⇒ the average IS shown (partial): 'Avg rate (known) · reference 25.00%'", half.includes("Avg rate (known) · reference 25.00%"), half);
  check("interest line is scoped: 'Estimated interest (known rates only)'", t.includes("Estimated interest (known rates only)"), t);
  const cards = text(renderToStaticMarkup(createElement(DebtPayoffSection, {
    accounts: [SMALL_CARD, acct("c2", "Card B", 400, { debtSubtype: "credit_card" })], today: TODAY, onAddApr: () => {},
  })));
  check("card-only plan keeps APR wording ('Avg APR (known)', 'No APR on file: Card B.')",
    cards.includes("Avg APR (known) · reference 25.00%") && cards.includes("No APR on file: Card B.") && cards.includes("Card B APR unknown"), cards);
}

console.log("4. Signals + KPIs");
{
  const s = buildDebtSignals({ accounts: [MORTGAGE, CARD] });
  const gaps = s.find((x) => x.id === "gaps")?.text ?? "";
  check("mortgage without a rate ⇒ '1 debt with no rate — interest cost unknown'", gaps.startsWith("1 debt with no rate — interest cost unknown"), gaps);
  const k = computeDebtKpis([MORTGAGE, CARD]);
  check("KPIs carry the typed coverage: rate PARTIAL, minimum NONE (no minimums on file)",
    k.rateCoverage?.status === "PARTIAL" && k.rateCoverage.note === "rate known for 1 of 2 debts (2% of what you owe)" && k.rateCoverage.sufficient === false && k.minimumCoverage?.status === "NONE",
    JSON.stringify({ r: k.rateCoverage, m: k.minimumCoverage }));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll Mortgage F3 UI label checks passed.");
