/**
 * components/space/widgets/debt/debt-presentation-class.test.ts
 *
 * v2.7 R2 — display-only Debt classification (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/widgets/debt/debt-presentation-class.test.ts
 *
 * Locks: the providerSubtype truth table (case/whitespace variants, null, unknown),
 * stored debtSubtype precedence (incl. line_of_credit → cards, heloc → loans), a
 * limit-only account → other (owner D-5), label outputs, the 14-row Preview-like
 * split Credit 4 / Loans 8 / Other 2, and that totals do not depend on
 * classification (utilization follows Mortgage F2's installment rule instead).
 */

import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import {
  presentationDebtClass, presentationDebtLabel, classifyDebt, debtSubtypeLabel, accountUtilization,
  type DebtClass,
} from "./debt-ledger-util";
import { computeDebtKpis } from "./debt-kpis";
import { isInstallmentLoan } from "@/lib/debt/liability-kind";
import { debtClassCounts } from "@/components/space/compact/compact-sections";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

let uid = 0;
function debt(over: Partial<DebtPerspectiveAccount>): DebtPerspectiveAccount {
  return { id: `d${uid++}`, name: "Liability", type: "debt", institution: "Bank", balance: 100, currency: "USD", ...over };
}

console.log("\n1. providerSubtype fallback truth table (no stored debtSubtype)");
const TABLE: Array<[string | null | undefined, DebtClass, string]> = [
  ["credit card",                "cards", "Credit card"],
  ["Credit Card",                "cards", "Credit card"],
  ["  CREDIT CARD  ",            "cards", "Credit card"],
  ["paypal",                     "cards", "Credit card"],
  ["PayPal",                     "cards", "Credit card"],
  ["line of credit",             "cards", "Line of credit"],
  ["Line Of Credit ",            "cards", "Line of credit"],
  ["home equity",                "loans", "HELOC"],
  ["Home Equity",                "loans", "HELOC"],
  ["mortgage",                   "loans", "Mortgage"],
  [" MORTGAGE",                  "loans", "Mortgage"],
  ["student",                    "loans", "Student loan"],
  ["Student",                    "loans", "Student loan"],
  ["auto",                       "loans", "Auto loan"],
  ["AUTO ",                      "loans", "Auto loan"],
  ["consumer",                   "loans", "Personal loan"],
  ["loan",                       "loans", "Personal loan"],
  ["personal",                   "loans", "Personal loan"],
  ["installment personal loans", "loans", "Personal loan"],
  ["Installment Personal Loans", "loans", "Personal loan"],
  [null,                         "other", "Other liabilities"],
  [undefined,                    "other", "Other liabilities"],
  ["",                           "other", "Other liabilities"],
  ["   ",                        "other", "Other liabilities"],
  ["overdraft",                  "other", "Other liabilities"],
  ["business",                   "other", "Other liabilities"],
  ["credit_card",                "other", "Other liabilities"], // stored-vocabulary spelling is NOT a provider value
];
for (const [sub, cls, label] of TABLE) {
  const a = debt({ providerSubtype: sub });
  const gotCls = presentationDebtClass(a);
  const gotLabel = presentationDebtLabel(a);
  check(`${JSON.stringify(sub)} → ${cls} / "${label}"`, gotCls === cls && gotLabel === label, `got ${gotCls} / "${gotLabel}"`);
}

console.log("\n2. stored debtSubtype ALWAYS wins");
const STORED: Array<[string, DebtClass, string]> = [
  ["credit_card",    "cards", "Credit card"],
  ["line_of_credit", "cards", "Line of credit"], // owner: revolving lines present under Credit
  ["heloc",          "loans", "HELOC"],          // owner D-4: home equity stays with Loans
  ["auto_loan",      "loans", "Auto loan"],
  ["mortgage",       "loans", "Mortgage"],
  ["personal_loan",  "loans", "Personal loan"],
  ["student_loan",   "loans", "Student loan"],
];
for (const [stored, cls, label] of STORED) {
  // providerSubtype deliberately contradicts the stored value — stored must win.
  const contra = cls === "cards" ? "mortgage" : "credit card";
  const a = debt({ debtSubtype: stored, providerSubtype: contra, creditLimit: 5000 });
  check(`stored ${stored} (provider "${contra}") → ${cls} / "${label}"`,
    presentationDebtClass(a) === cls && presentationDebtLabel(a) === label);
}
{
  const a = debt({ debtSubtype: "something_new", providerSubtype: "credit card", creditLimit: 5000 });
  check("an unknown STORED subtype → other (stored wins; no fall-through to provider)",
    presentationDebtClass(a) === "other" && presentationDebtLabel(a) === "Other liabilities");
}

console.log("\n3. a credit limit alone is never a card (owner D-5)");
check("limit-only account → other", presentationDebtClass(debt({ creditLimit: 12000 })) === "other");
check("limit + null providerSubtype → other", presentationDebtClass(debt({ creditLimit: 12000, providerSubtype: null })) === "other");
check("home equity WITH a limit → loans (not cards)", presentationDebtClass(debt({ creditLimit: 50000, providerSubtype: "home equity" })) === "loans");
check("privacy-aggregated row ignores a member's providerSubtype → other",
  presentationDebtClass(debt({ providerSubtype: "credit card", aggregate: { memberAccountIds: ["x", "y"], memberCount: 2 } })) === "other");

console.log("\n4. classifyDebt / debtSubtypeLabel delegate to the one presentation function");
for (const [sub] of TABLE) {
  const a = debt({ providerSubtype: sub, creditLimit: 1000 });
  check(`delegation agrees for ${JSON.stringify(sub)}`,
    classifyDebt(a) === presentationDebtClass(a) && debtSubtypeLabel(a) === presentationDebtLabel(a));
}

console.log("\n5. 14 Preview-like rows ⇒ Credit 4 / Loans 8 / Other 2");
const PREVIEW: DebtPerspectiveAccount[] = [
  debt({ name: "Card 1", providerSubtype: "credit card", creditLimit: 10000, balance: 1200, interestRate: 24.99 }),
  debt({ name: "Card 2", providerSubtype: "credit card", creditLimit: 5000,  balance: 300 }),
  debt({ name: "Card 3", providerSubtype: "credit card", creditLimit: 8000,  balance: -40 }),
  debt({ name: "Card 4", providerSubtype: "credit card", creditLimit: 2000,  balance: 0 }),
  debt({ name: "Mortgage 1", providerSubtype: "mortgage", balance: 280000, interestRate: 5.1 }),
  debt({ name: "Mortgage 2", providerSubtype: "mortgage", balance: 190000 }),
  debt({ name: "Student 1",  providerSubtype: "student",  balance: 22000, interestRate: 4.5 }),
  debt({ name: "Student 2",  providerSubtype: "student",  balance: 9000 }),
  debt({ name: "Auto 1",     providerSubtype: "auto",     balance: 14000, interestRate: 6.5 }),
  debt({ name: "Auto 2",     providerSubtype: "auto",     balance: 7000 }),
  debt({ name: "HELOC 1",    providerSubtype: "home equity", creditLimit: 50000, balance: 12000 }),
  debt({ name: "HELOC 2",    providerSubtype: "home equity", creditLimit: 30000, balance: 0 }),
  debt({ name: "Legacy 1",   providerSubtype: null, creditLimit: 4000, balance: 800 }),
  debt({ name: "Legacy 2",   providerSubtype: null, creditLimit: 6000, balance: 150 }),
];
{
  const counts = debtClassCounts(PREVIEW);
  check("debtClassCounts = { cards: 4, loans: 8, other: 2 }",
    counts.cards === 4 && counts.loans === 8 && counts.other === 2, JSON.stringify(counts));
  // Under the removed limit fallback the same rows split 8 / 0 / 6 — the defect R2 fixes.
  const legacy = PREVIEW.filter((a) => a.creditLimit != null && a.creditLimit > 0).length;
  check("(sanity) 8 rows carry a limit — the old rule would have called them all cards", legacy === 8);
}

console.log("\n6. totals do not depend on classification; utilization follows the F2 installment rule, not the display class");
{
  // Mortgage F2 (S2 ruling + HELOC follow-up) — a Plaid installment
  // providerSubtype (mortgage, student, auto, …; home equity only without a
  // limit) is never revolving, so providerSubtype now feeds
  // utilization THROUGH lib/debt/liability-kind.ts isInstallmentLoan. It still
  // never feeds totals, and the DISPLAY class (presentationDebtClass) is not
  // what decides utilization.
  const stripped = PREVIEW.map(({ providerSubtype: _p, ...rest }) => rest as DebtPerspectiveAccount);
  const subs = PREVIEW.map((a) => a.providerSubtype).reverse();
  const asStored = PREVIEW.map((a, i) => ({ ...a, providerSubtype: subs[i] }));
  const totals = (xs: DebtPerspectiveAccount[]) => {
    const { utilizationPct: _u, utilizationLevel: _l, ...rest } = computeDebtKpis(xs);
    return JSON.stringify(rest);
  };
  const k0 = totals(PREVIEW);
  check("debt totals identical with providerSubtype stripped", k0 === totals(stripped));
  check("debt totals identical when every row is re-classed (providerSubtype permuted)", k0 === totals(asStored));
  const u0 = PREVIEW.map(accountUtilization);
  check("utilization: cards, limit-bearing home equity (S2 HELOC ruling) and legacy rows; installment loans have none",
    JSON.stringify(u0) === JSON.stringify([12, 6, 0, 0, null, null, null, null, null, null, 24, 0, 20, 2.5]), JSON.stringify(u0));
  check("utilization with providerSubtype stripped: limit-bearing rows read their limit again (no loan evidence)",
    JSON.stringify(stripped.map(accountUtilization)) === JSON.stringify([12, 6, 0, 0, null, null, null, null, null, null, 24, 0, 20, 2.5]),
    JSON.stringify(stripped.map(accountUtilization)));
  check("(sanity) the permutation really re-classed rows",
    JSON.stringify(debtClassCounts(asStored)) === JSON.stringify(debtClassCounts(PREVIEW))
      && asStored.some((a, i) => presentationDebtClass(a) !== presentationDebtClass(PREVIEW[i])));
  check("re-classed rows: utilization is null exactly for Plaid loan subtypes",
    asStored.every((a) => (accountUtilization(a) === null) === (isInstallmentLoan(a) || !(a.creditLimit! > 0))));
  const k = computeDebtKpis(PREVIEW);
  check("aggregate utilization includes limit-bearing home equity, excludes installment loans: 14,450 / 115,000",
    k.utilizationPct !== null && Math.abs(k.utilizationPct - (14450 / 115000) * 100) < 1e-9, String(k.utilizationPct));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
