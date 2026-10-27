/**
 * components/space/widgets/debt/debt-scope-donuts.test.ts
 *
 * v2.7 final UX pass — the compact Credit and Loans views each get a donut: the
 * SAME DebtCompositionCard / debtCompositionItems (no second implementation),
 * scoped to one presentation class (presentationDebtClass — the classifier the
 * class ledger uses: stored debtSubtype, else provider subtype, else Other;
 * never a credit limit, never a name).
 *
 *   1. reconciliation — each scoped donut sums EXACTLY to that class's owed
 *      total (same display conversion + amountOwed as the ledger rows), every
 *      grouping agrees, and Credit + Loans + Other partition All exactly;
 *   2. zero / credit balances are not slices but are counted honestly;
 *   3. empty states — no qualifying accounts vs all paid off;
 *   4. currency — the display currency (conversion context), like the All donut;
 *   5. Loans groups by stated kind only when it splits; else by account;
 *   6. wiring — compact only, under the Credit / Loans tabs, tab-controlled.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/widgets/debt/debt-scope-donuts.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { identityContext, convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { formatCurrency } from "@/lib/currency";
import type { ConversionContext } from "@/lib/money/types";
import {
  debtCompositionItems, debtScopeSummary,
  type DebtPerspectiveAccount, type DebtCompositionGrouping,
} from "@/components/space/widgets/debt-perspective-adapters";
import { presentationDebtClass } from "./debt-ledger-util";
import { DebtCompositionCard, DEBT_SCOPE_GROUPINGS, defaultScopeGrouping } from "./DebtCompositionCard";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/\s+/g, " ").trim();
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const sum = (xs: { value: number }[]) => xs.reduce((s, x) => s + x.value, 0);

const EUR_CTX: ConversionContext = {
  target: "EUR",
  resolve: (from, dateISO) => from === "USD"
    ? { kind: "rate", rate: 0.5, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" } as never
    : { kind: "miss", quote: from, requestedDateISO: dateISO },
};

let uid = 0;
const debt = (over: Record<string, unknown>): DebtPerspectiveAccount =>
  ({ id: `d${uid++}`, name: "Acct", type: "debt", institution: "Bank", balance: 0, currency: "USD", ...over } as unknown as DebtPerspectiveAccount);

// Positive balance = owed (lib/debt/balance-semantics amountOwed).
const ACCOUNTS: DebtPerspectiveAccount[] = [
  debt({ id: "visa",   name: "Visa",        institution: "Chase",  balance: 1200.11, debtSubtype: "credit_card" }),
  debt({ id: "gold",   name: "Gold",        institution: "Amex",   balance: 300.27,  providerSubtype: "credit card" }),
  debt({ id: "loc",    name: "Line",        institution: "Chase",  balance: 99.5,    debtSubtype: "line_of_credit" }),
  debt({ id: "paid",   name: "Paid card",   institution: "Citi",   balance: 0,       debtSubtype: "credit_card" }),
  debt({ id: "over",   name: "Overpaid",    institution: "Citi",   balance: -50,     debtSubtype: "credit_card" }),
  debt({ id: "mort",   name: "Home",        institution: "Wells",  balance: 250000,  debtSubtype: "mortgage" }),
  debt({ id: "auto",   name: "Car",         institution: "Chase",  balance: 8000.34, providerSubtype: "auto" }),
  debt({ id: "stud",   name: "School",      institution: "Nelnet", balance: 12000,   debtSubtype: "student_loan" }),
  // A credit limit alone is NOT evidence of a card (owner D-5) ⇒ Other, in neither view.
  debt({ id: "iou",    name: "IOU",         institution: "Friend", balance: 500, creditLimit: 1000 }),
  { id: "chk", name: "Checking", type: "checking", institution: "Chase", balance: 9999, currency: "USD" } as unknown as DebtPerspectiveAccount,
];

/** The class ledger's own figure, computed independently (LiabilitiesLedger buildRows: convertMoney at yesterday-UTC, amount ?? 0, then max(·,0)). */
function ledgerOwed(accounts: DebtPerspectiveAccount[], ctx: ConversionContext | undefined, cls: "cards" | "loans" | "other" | null): number {
  return accounts
    .filter((a) => a.type === "debt" && (cls === null || presentationDebtClass(a) === cls))
    .reduce((s, a) => {
      const amt = ctx ? (convertMoney({ amount: a.balance, currency: a.currency ?? null }, yesterdayUTCISO(), ctx).amount ?? 0) : a.balance;
      return s + Math.max(amt, 0);
    }, 0);
}

console.log("1. reconciliation — each scoped donut sums exactly to its class's owed total");
for (const ctx of [identityContext("USD"), EUR_CTX] as ConversionContext[]) {
  const tag = ctx.target;
  for (const scope of ["cards", "loans"] as const) {
    const want = ledgerOwed(ACCOUNTS, ctx, scope);
    for (const g of DEBT_SCOPE_GROUPINGS[scope].map((o) => o.id) as DebtCompositionGrouping[]) {
      const items = debtCompositionItems(ACCOUNTS, ctx, g, scope);
      check(`${tag} ${scope} by ${g}: Σ slices === class ledger owed (${want})`, near(sum(items), want), String(sum(items)));
    }
    check(`${tag} ${scope}: debtScopeSummary.total === the same figure`, near(debtScopeSummary(ACCOUNTS, ctx, scope).total, want));
  }
  const all = sum(debtCompositionItems(ACCOUNTS, ctx, "account"));
  check(`${tag}: Credit + Loans + Other partition All exactly`,
    near(ledgerOwed(ACCOUNTS, ctx, "cards") + ledgerOwed(ACCOUNTS, ctx, "loans") + ledgerOwed(ACCOUNTS, ctx, "other"), all) && near(all, ledgerOwed(ACCOUNTS, ctx, null)));
}
{
  const ids = debtCompositionItems(ACCOUNTS, identityContext("USD"), "account", "cards").map((i) => i.id).sort().join();
  check("Credit = cards + line of credit only (no loan, no limit-only IOU)", ids === "gold,loc,visa", ids);
  const kinds = debtCompositionItems(ACCOUNTS, identityContext("USD"), "kind", "loans").map((i) => i.label);
  check("Loans by kind uses the stated kinds, largest first", kinds.join() === "Mortgage,Student loan,Auto loan", kinds.join());
  const src = readFileSync(path.join(process.cwd(), "components/space/widgets/debt/LiabilitiesLedger.tsx"), "utf8");
  check("the ledger still uses the same conversion seam the donut mirrors (convertMoney @ yesterdayUTCISO, amountOwed)",
    /yesterdayUTCISO\(\)/.test(src) && /convertMoney\(/.test(src) && /amountOwed\(bal\.amount\)/.test(src));
}

console.log("\n2. zero / credit balances: not slices, but counted honestly");
{
  const s = debtScopeSummary(ACCOUNTS, identityContext("USD"), "cards");
  check("cards: 5 accounts, 3 owing, 2 with nothing owed", s.accountCount === 5 && s.owedCount === 3 && s.notOwedCount === 2, JSON.stringify(s));
  check("no zero / negative slice", debtCompositionItems(ACCOUNTS, identityContext("USD"), "account", "cards").every((i) => i.value > 0));
  const html = text(renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: ACCOUNTS, ctx: identityContext("USD"), currency: "USD", scope: "cards" })));
  check("the card says so under the donut", html.includes("2 credit accounts with nothing owed aren't shown"), html);
}

console.log("\n3. empty states");
{
  const cardsOnly = ACCOUNTS.filter((a) => a.id !== "mort" && a.id !== "auto" && a.id !== "stud");
  const none = text(renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: cardsOnly, ctx: identityContext("USD"), currency: "USD", scope: "loans" })));
  check("no loan accounts ⇒ 'No loans' (no donut, no centre figure)", none.includes("No loans") && !none.includes("loans owed"), none);
  const paidLoans = [debt({ id: "pl", name: "Old car", balance: 0, debtSubtype: "auto_loan" })];
  const paid = text(renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: paidLoans, ctx: identityContext("USD"), currency: "USD", scope: "loans" })));
  check("loans exist but all paid ⇒ 'Nothing owed on loans' (not 'No loans')", paid.includes("Nothing owed on loans") && !paid.includes("No loans"), paid);
  const noCards = text(renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: paidLoans, ctx: identityContext("USD"), currency: "USD", scope: "cards" })));
  check("no credit accounts ⇒ its own empty state", noCards.includes("No credit cards or lines of credit"), noCards);
}

console.log("\n4. currency — display currency via the conversion context");
{
  const eur = text(renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: ACCOUNTS, ctx: EUR_CTX, currency: "EUR", scope: "loans" })));
  const want = ledgerOwed(ACCOUNTS, EUR_CTX, "loans"); // 270,000.34 × 0.5 (no half-cent: summation order cannot move the rounding)
  check("the converted total is the USD class total at the context's rate", near(want, ledgerOwed(ACCOUNTS, identityContext("USD"), "loans") * 0.5));
  const fmt = formatCurrency(want, "EUR"); // the app's ONE money formatter (as the card)
  check(`centre figure is the converted class total in EUR (${fmt})`, eur.includes(fmt) && eur.includes("loans owed"), eur.slice(0, 300));
  check("no USD symbol leaks into the EUR card", !eur.includes("$"));
}

console.log("\n5. default grouping");
{
  check("Loans with ≥2 stated kinds ⇒ by loan type", defaultScopeGrouping("loans", 3) === "kind");
  check("Loans with one kind ⇒ by account (a one-slice 'type' ring says nothing)", defaultScopeGrouping("loans", 1) === "account");
  check("Credit ⇒ by account", defaultScopeGrouping("cards", 5) === "account");
  check("Credit offers account · institution (never 'type': one class)", DEBT_SCOPE_GROUPINGS.cards.map((g) => g.id).join() === "account,institution");
  check("Loans offers loan type · account · institution", DEBT_SCOPE_GROUPINGS.loans.map((g) => g.id).join() === "kind,account,institution");
  const html = text(renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: ACCOUNTS, ctx: identityContext("USD"), currency: "USD", scope: "cards" })));
  check("Credit card labels: 'Where your credit is owed' + 'credit owed' centre", html.includes("Where your credit is owed") && html.includes("credit owed"));
  const all = text(renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: ACCOUNTS, ctx: identityContext("USD"), currency: "USD" })));
  check("the unscoped (All) card is unchanged: 'Where it's owed' + 'total debt'", all.includes("Where it's owed") && all.includes("total debt"));
}

console.log("\n6. wiring — compact Credit / Loans views only");
{
  const dw = readFileSync(path.join(process.cwd(), "components/space/widgets/debt/DebtWorkspace.tsx"), "utf8");
  check("the scoped card renders under the tabs, lg:hidden, for the selected class",
    /\{debtTabs && cv\.ledgerClass && \(\s*<div className="lg:hidden" data-compact-debt-donut=\{cv\.ledgerClass\}>\s*<DebtCompositionCard key=\{cv\.ledgerClass\} accounts=\{accounts\} ctx=\{ctx\} currency=\{displayCurrency\} scope=\{cv\.ledgerClass\} \/>/.test(dw));
  check("the Credit / Loans tabs control their donut", dw.includes('"debt-credit-composition", "debt-liabilities"') && dw.includes('["debt-loans-composition", "debt-liabilities"]'));
  check("the donut precedes the class ledger", dw.indexOf("data-compact-debt-donut") < dw.indexOf('id="debt-liabilities"'));
}

if (failures > 0) { console.error(`\ndebt-scope-donuts: ${failures} failure(s).`); process.exit(1); }
console.log("\ndebt-scope-donuts: all passed.");
