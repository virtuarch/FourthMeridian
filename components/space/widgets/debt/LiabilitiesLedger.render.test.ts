/**
 * components/space/widgets/debt/LiabilitiesLedger.render.test.ts
 *
 * V25-SIDE-1 final slice — RENDER-PATH proof for the Liabilities browser
 * (house pattern: standalone tsx + renderToStaticMarkup, DB-free):
 *
 *   npx tsx components/space/widgets/debt/LiabilitiesLedger.render.test.ts
 *
 * The unit tests in lib/debt/balance-semantics.test.ts prove the MATH. This
 * proves what a user actually SEES, by rendering the real component and reading
 * the markup back — the two failure modes this slice exists to prevent are both
 * invisible to pure math:
 *
 *   1. a paid-off or credit-balance account silently DISAPPEARING, and
 *   2. a credit balance rendering as "−$124.04" in the negative/problem colour.
 *
 * Also pins the STRUCTURAL population rule: the ledger is a browser of liability
 * ACCOUNTS, so its row count tracks account identity, never amount owed. The
 * debt-magnitude widgets (KPIs, charts, payoff) are asserted alongside it to
 * hold the other half of the contract — they stay at zero while the ledger
 * stays populated.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiabilitiesLedger } from "./LiabilitiesLedger";
import { computeDebtKpis } from "./debt-kpis";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const acct = (
  name: string,
  balance: number,
  over: Partial<DebtPerspectiveAccount> = {},
): DebtPerspectiveAccount => ({
  id: name.toLowerCase().replace(/\W/g, ""),
  name, type: "debt", institution: "Bank", balance, currency: "USD",
  ...over,
} as DebtPerspectiveAccount);

/** Render the real ledger and return (markup, visible text). */
function render(accounts: DebtPerspectiveAccount[]) {
  const html = renderToStaticMarkup(
    createElement(LiabilitiesLedger, { accounts, currency: "USD" }),
  );
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { html, text };
}

/** Rows are <button> elements, one per liability. */
const rowCount = (html: string) => (html.match(/<button/g) ?? []).length;

// ── 1. Mixed state ───────────────────────────────────────────────────────────
console.log("1. MIXED — $2,100 owed · $0 settled · $124.04 credit");
{
  const accounts = [
    acct("Auto Loan", 2100, { debtSubtype: "auto_loan", interestRate: 6.49, minimumPayment: 287 }),
    acct("Visa", 0, { debtSubtype: "credit_card", creditLimit: 5000, interestRate: 21.99 }),
    acct("Chase Sapphire", -124.04, { debtSubtype: "credit_card", creditLimit: 33700 }),
  ];
  const { html, text } = render(accounts);
  const k = computeDebtKpis(accounts);

  check("all three accounts render a row", rowCount(html) === 3, `${rowCount(html)}`);
  check("owed row is present by name", text.includes("Auto Loan"));
  check("settled row is present by name", text.includes("Visa"));
  check("credit row is present by name", text.includes("Chase Sapphire"));

  // Owed/settled use the ledger's house whole-dollar rounding; a CREDIT is shown
  // exact, because credits are small enough that rounding would destroy them.
  check("owed row states the amount owed", text.includes("$2,100 owed"), text);
  check("settled row states $0 owed", text.includes("$0 owed"), text);
  check("settled row is labelled Paid off", text.includes("Paid off"));
  check("credit row states the positive credit to the cent",
    text.includes("$124.04 credit"), text);

  // The two forbidden renderings.
  check("NO raw negative balance anywhere", !/[-−]\s?\$?124\.04/.test(text), text);
  check("credit uses the POSITIVE accent, not the negative one",
    html.includes("accent-positive") && !/accent-negative[^>]*>\s*[^<]*124\.04/.test(html));

  // Subtype is on the row so a zero-amount account still identifies itself.
  check("rows name their subtype", text.includes("Auto loan") && text.includes("Credit card"), text);

  // The other half of the contract: debt magnitude counts ONLY real debt.
  check("KPI totalDebt = 2100 (credit + settled excluded)", k.totalDebt === 2100);
  check("structural count 3 ≠ owing count 1", k.accountCount === 3 && k.owingCount === 1);
}

// ── 2. All settled ───────────────────────────────────────────────────────────
console.log("2. ALL SETTLED — every card paid off");
{
  const accounts = [
    acct("Visa", 0, { debtSubtype: "credit_card", creditLimit: 5000 }),
    acct("Mastercard", 0, { debtSubtype: "credit_card", creditLimit: 9000 }),
  ];
  const { html, text } = render(accounts);
  const k = computeDebtKpis(accounts);

  check("total debt = $0", k.totalDebt === 0);
  check("ledger STILL renders both accounts", rowCount(html) === 2, `${rowCount(html)}`);
  check("no empty state shown", !text.includes("No liability accounts"), text);
  check("both rows read Paid off", (text.match(/Paid off/g) ?? []).length === 2, text);
  check("structural summary: 2 settled, 0 owing",
    k.accountCount === 2 && k.settledCount === 2 && k.owingCount === 0);
  check("Block renders (gated on accountCount, not totalDebt)", k.accountCount > 0);
}

// ── 3. All credited ──────────────────────────────────────────────────────────
console.log("3. ALL CREDITED — every card carries an issuer credit");
{
  const accounts = [
    acct("Chase Sapphire", -124.04, { debtSubtype: "credit_card", creditLimit: 33700 }),
    acct("Amex Platinum", -25.77, { debtSubtype: "credit_card" }),
  ];
  const { html, text } = render(accounts);
  const k = computeDebtKpis(accounts);

  check("total debt = $0 — no phantom debt", k.totalDebt === 0);
  check("no phantom interest", k.estMonthlyInterest === 0);
  check("utilization is 0%, never negative", (k.utilizationPct ?? 0) === 0);
  check("ledger STILL renders both accounts", rowCount(html) === 2, `${rowCount(html)}`);
  check("both credits shown as positive magnitudes, to the cent",
    text.includes("$124.04 credit") && text.includes("$25.77 credit"), text);
  check("NO negative sign on any amount", !/[-−]\s?\$/.test(text), text);
  check("structural summary: 2 in credit", k.accountCount === 2 && k.creditCount === 2);
}

// ── 4. Genuinely empty ───────────────────────────────────────────────────────
console.log("4. NO LIABILITY ACCOUNTS — the only legitimate empty state");
{
  const { html, text } = render([]);
  check("no rows", rowCount(html) === 0);
  check("empty state names ACCOUNT absence, not zero debt",
    text.includes("No liability accounts in this Space"), text);
  check("empty state never says 'nothing owed'", !/nothing owed/i.test(text), text);
}

// ── 5. Ordering keeps owed first WITHIN a class, and drops nothing ───────────
//
// Rows are grouped by liability CLASS first (Credit cards → Loans → Other, the
// pre-existing DEBT_CLASS_ORDER), so ordering is only meaningful inside a group
// — a paid-off card legitimately appears above a mortgage because cards come
// before loans. What this pins is that owed rows lead within their own class and
// that nothing is dropped.
console.log("5. Ordering — owed first within a class, nothing dropped");
{
  const accounts = [
    acct("Credit Card", -50, { debtSubtype: "credit_card" }),
    acct("Paid Card", 0, { debtSubtype: "credit_card" }),
    acct("Owed Card", 900, { debtSubtype: "credit_card" }),
    acct("Mortgage", 285000, { debtSubtype: "mortgage" }),
    acct("Auto Loan", 11200, { debtSubtype: "auto_loan" }),
  ];
  const { html, text } = render(accounts);
  check("every account still rendered", rowCount(html) === 5, `${rowCount(html)}`);

  const at = (name: string) => text.indexOf(name);
  check("within Credit cards: owed leads rows owing nothing",
    at("Owed Card") < at("Paid Card") && at("Owed Card") < at("Credit Card"),
    `${at("Owed Card")} / ${at("Paid Card")} / ${at("Credit Card")}`);
  check("within Loans: largest debt first", at("Mortgage") < at("Auto Loan"));
  check("class grouping precedes amount (cards before loans)",
    at("Owed Card") < at("Mortgage"));
}

console.log(failures === 0
  ? "\n✅ LiabilitiesLedger render: all checks passed"
  : `\n❌ LiabilitiesLedger render: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
