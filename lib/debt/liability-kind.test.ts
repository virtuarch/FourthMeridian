/**
 * lib/debt/liability-kind.test.ts
 *
 * Mortgage F2 (S2 ruling + HELOC follow-up) — Plaid installment loans are never
 * revolving credit; line of credit / overdraft are; home equity is revolving only
 * with a positive limit. Pins the
 * shared helper and EVERY site that consumes it: history replay
 * (isReconstructableCard), utilization (isRevolvingLine / creditUtilization /
 * debt KPIs / ledger row utilization), available credit (account balances +
 * reconciliation, Liquidity lens credit tier), and the "add a credit limit"
 * prompt (CreditHealthInputs.canCarryLimit, creditUtilization.missingLimit).
 *
 * Fabricated fixtures only. Pure: no DB, no network.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/debt/liability-kind.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isInstallmentLoan, liabilityKind, revolvingCreditLimit, PLAID_REVOLVING_LOAN_SUBTYPES, PLAID_LIMIT_DISCRIMINATED_SUBTYPES, PLAID_LOAN_SUBTYPES, PLAID_CREDIT_SUBTYPES, REVOLVING_DEBT_SUBTYPES,
} from "@/lib/debt/liability-kind";
import { isReconstructableCard } from "@/lib/snapshots/backfill-core";
import { isRevolvingLine, creditUtilization } from "@/lib/accounts/credit-utilization";
import { resolveAccountBalances, reconcileAccount } from "@/lib/balances/account-balances";
import { resolveAccountFreshness } from "@/lib/freshness/observation";
import { computeLiquidity, type LiquidityAccountRow } from "@/lib/perspective-engine/lenses/liquidity.core";
import { computeDebtKpis } from "@/components/space/widgets/debt/debt-kpis";
import { accountUtilization } from "@/components/space/widgets/debt/debt-ledger-util";
import { canCarryLimit } from "@/components/space/widgets/debt/CreditHealthInputs";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

// Fabricated rows. `kind` names the case; all carry a limit unless stated.
const CASES = {
  card:          { type: "debt", debtSubtype: null,          providerSubtype: "credit card", creditLimit: 10_000 },
  legacyCard:    { type: "debt", debtSubtype: null,          providerSubtype: null,          creditLimit: 10_000 },
  explicitCard:  { type: "debt", debtSubtype: "credit_card", providerSubtype: null,          creditLimit: 10_000 },
  mortgage:      { type: "debt", debtSubtype: null,          providerSubtype: "mortgage",    creditLimit: 400_000 },
  student:       { type: "debt", debtSubtype: null,          providerSubtype: "student",     creditLimit: 40_000 },
  auto:          { type: "debt", debtSubtype: null,          providerSubtype: "auto",        creditLimit: 30_000 },
  unknownLoan:   { type: "debt", debtSubtype: null,          providerSubtype: "loan",        creditLimit: 20_000 },
  otherLoan:     { type: "debt", debtSubtype: null,          providerSubtype: "other",       creditLimit: 20_000 },
  explicitLoan:  { type: "debt", debtSubtype: "boat_loan",   providerSubtype: null,          creditLimit: 20_000 },
  // A user's explicit FM classification outranks the Plaid subtype.
  userHeloc:     { type: "debt", debtSubtype: "heloc",       providerSubtype: "home equity", creditLimit: 50_000 },
} as const;
const LOANS = ["mortgage", "student", "auto", "unknownLoan", "otherLoan", "explicitLoan"] as const;
const REVOLVING = ["card", "legacyCard", "explicitCard", "userHeloc"] as const;

console.log("1. Helper — isInstallmentLoan / revolvingCreditLimit");
{
  for (const k of LOANS)     check(`${k} is an installment loan`, isInstallmentLoan(CASES[k]) === true);
  for (const k of REVOLVING) check(`${k} is NOT an installment loan`, isInstallmentLoan(CASES[k]) === false);
  check("case/whitespace-insensitive Plaid subtype ('  Mortgage ')", isInstallmentLoan({ type: "debt", providerSubtype: "  Mortgage " }));
  check("non-debt row is never an installment loan", isInstallmentLoan({ type: "checking", providerSubtype: "mortgage" }) === false);
  check("type omitted ⇒ decided on subtypes alone", isInstallmentLoan({ providerSubtype: "student" }) === true);
  check("no evidence (all null) ⇒ not installment (legacy rules apply)", isInstallmentLoan({ type: "debt" }) === false);
  check("revolvingCreditLimit: mortgage ⇒ null", revolvingCreditLimit(CASES.mortgage) === null);
  check("revolvingCreditLimit: card ⇒ its limit", revolvingCreditLimit(CASES.card) === 10_000);
  // Lists are disjoint and match the plaid-node enums (LoanAccountSubtype / CreditAccountSubtype, minus `all`).
  check("Plaid loan subtypes = plaid-node LoanAccountSubtype minus 'all'",
    [...PLAID_LOAN_SUBTYPES].sort().join("|") ===
      ["auto", "business", "commercial", "construction", "consumer", "home equity", "line of credit", "loan", "mortgage", "other", "overdraft", "student"].join("|"));
  check("no Plaid subtype is both credit and loan", [...PLAID_CREDIT_SUBTYPES].every((s) => !PLAID_LOAN_SUBTYPES.has(s)));
  check("revolving FM subtypes unchanged", [...REVOLVING_DEBT_SUBTYPES].sort().join("|") === "credit_card|heloc|line_of_credit");
}

console.log("2. History replay — isReconstructableCard");
{
  check("card (Plaid 'credit card') walks", isReconstructableCard(CASES.card) === true);
  check("legacy untyped card with a limit still walks", isReconstructableCard(CASES.legacyCard) === true);
  check("explicit credit_card walks", isReconstructableCard(CASES.explicitCard) === true);
  check("Plaid credit card WITHOUT a limit still walks (PB-8)", isReconstructableCard({ ...CASES.card, creditLimit: null }) === true);
  for (const k of LOANS) check(`${k} with a limit is NOT walked (held flat)`, isReconstructableCard(CASES[k]) === false);
}

console.log("3. Utilization — isRevolvingLine / creditUtilization");
{
  for (const k of REVOLVING) check(`${k} is a revolving line`, isRevolvingLine(CASES[k]) === true);
  for (const k of LOANS)     check(`${k} is NOT a revolving line`, isRevolvingLine(CASES[k]) === false);

  const acct = (id: string, c: { debtSubtype: string | null; providerSubtype: string | null; creditLimit: number | null }) =>
    ({ id, name: id, type: "debt", balance: 7_500, ...c });
  const u = creditUtilization([
    acct("card", CASES.card), acct("mortgage", CASES.mortgage), acct("student", CASES.student),
    acct("auto", CASES.auto), acct("unknownLoan", CASES.unknownLoan),
    acct("cardNoLimit", { ...CASES.card, creditLimit: null }),
    acct("mortgageNoLimit", { ...CASES.mortgage, creditLimit: null }),
    acct("studentNoLimit", { ...CASES.student, creditLimit: null }),
  ]);
  check("only the card is a utilization row (75% of 10,000)", u.rows.length === 1 && u.rows[0].id === "card" && u.rows[0].pct === 75, u.rows);
  check("only the limit-less card is prompted for a limit", u.missingLimit.map((m) => m.id).join() === "cardNoLimit", u.missingLimit);
}

console.log("4. Available credit — account balances + reconciliation");
{
  const NOW = new Date("2026-06-30T12:00:00.000Z");
  const fresh = resolveAccountFreshness({ accountId: "x", ingestedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), providerBalanceAt: null }, NOW);
  const resolve = (c: { debtSubtype: string | null; providerSubtype: string | null; creditLimit: number | null }) =>
    resolveAccountBalances({ accountId: "x", accountType: "debt", currency: "USD", balance: 7_500, availableBalance: 2_500, freshness: fresh, ...c });
  for (const k of ["card", "legacyCard", "explicitCard"] as const) {
    const b = resolve(CASES[k]);
    check(`${k}: available is AVAILABLE_CREDIT`, b.available.status === "AVAILABLE" && b.available.quantity === "AVAILABLE_CREDIT", b.available);
    check(`${k}: reconciles as REVOLVING_CREDIT`, reconcileAccount(b, undefined, CASES[k].creditLimit).basis === "REVOLVING_CREDIT");
  }
  for (const k of LOANS) {
    const b = resolve(CASES[k]);
    check(`${k}: available is NOT_APPLICABLE (no credit headroom)`, b.available.status !== "AVAILABLE" && JSON.stringify(b.available).includes("NOT_APPLICABLE"), b.available);
    check(`${k}: not reconciled as revolving credit`, reconcileAccount(b, undefined, CASES[k].creditLimit).basis !== "REVOLVING_CREDIT");
  }
}

console.log("5. Available credit — Liquidity lens credit tier");
{
  const T = "2026-06-29T00:00:00.000Z";
  const row = (id: string, c: { debtSubtype: string | null; providerSubtype: string | null; creditLimit: number }): LiquidityAccountRow =>
    ({ id, type: "debt", balance: 7_500, lastUpdated: T, visibilityLevel: "FULL", debtSubtype: c.debtSubtype, providerSubtype: c.providerSubtype, creditLimit: c.creditLimit });
  const lens = computeLiquidity({ spaceId: "s", userId: "u" }, { now: () => new Date("2026-06-30T12:00:00.000Z") }, [
    row("card", CASES.card), row("mortgage", CASES.mortgage), row("student", CASES.student),
    row("auto", CASES.auto), row("unknownLoan", CASES.unknownLoan), row("explicitLoan", CASES.explicitLoan),
  ]);
  const credit = lens.metrics.find((m) => m.id === "availableCredit")?.value;
  check("available credit = the card's headroom only (10,000 − 7,500 = 2,500)", credit === 2_500, credit);
}

console.log("6. Debt widgets — KPIs, ledger utilization, 'add a credit limit'");
{
  let uid = 0;
  const debt = (c: { debtSubtype: string | null; providerSubtype: string | null; creditLimit: number | null }): DebtPerspectiveAccount => ({
    id: `d${uid++}`, name: "Debt", type: "debt", institution: "Bank", balance: 7_500, currency: "USD",
    ...(c.debtSubtype ? { debtSubtype: c.debtSubtype } : {}),
    providerSubtype: c.providerSubtype,
    ...(c.creditLimit != null ? { creditLimit: c.creditLimit } : {}),
  });
  const k = computeDebtKpis([debt(CASES.card), debt(CASES.mortgage), debt(CASES.student), debt(CASES.auto), debt(CASES.unknownLoan)]);
  check("aggregate utilization counts the card only (75%)", k.utilizationPct === 75, k.utilizationPct);

  check("ledger: card row has utilization 75%", accountUtilization(debt(CASES.card)) === 75);
  for (const kk of LOANS) check(`ledger: ${kk} row has NO utilization`, accountUtilization(debt(CASES[kk])) === null);

  check("credit health: card can carry a limit", canCarryLimit(debt(CASES.card)) === true);
  check("credit health: limit-less card can carry a limit", canCarryLimit(debt({ ...CASES.card, creditLimit: null })) === true);
  check("credit health: user-classified heloc can carry a limit", canCarryLimit(debt(CASES.userHeloc)) === true);
  for (const kk of LOANS) {
    check(`credit health: ${kk} is never asked for a limit`, canCarryLimit(debt(CASES[kk])) === false);
    check(`credit health: limit-less ${kk} is never asked for a limit`, canCarryLimit(debt({ ...CASES[kk], creditLimit: null })) === false);
  }
}

console.log("7. One authority — no duplicated subtype lists at the affected sites");
{
  const root = process.cwd();
  const src = (p: string) => readFileSync(join(root, p), "utf8");
  const sites = [
    "lib/snapshots/backfill-core.ts",
    "lib/accounts/credit-utilization.ts",
    "lib/balances/account-balances.ts",
    "lib/perspective-engine/lenses/liquidity.core.ts",
    "components/space/widgets/debt/debt-ledger-util.ts",
    "components/space/widgets/debt/CreditHealthInputs.tsx",
  ];
  for (const p of sites) {
    const s = src(p);
    check(`${p} imports lib/debt/liability-kind`, s.includes(`from "@/lib/debt/liability-kind"`));
    check(`${p} declares no local subtype Set`, !/new Set\(\s*\[\s*"(credit_card|mortgage|credit card|auto|student)"/.test(s));
  }
}

console.log("8. S2 HELOC ruling — home equity / line of credit / overdraft, and debtSubtype overrides");
{
  const NOW = new Date("2026-06-30T12:00:00.000Z");
  const fresh = resolveAccountFreshness({ accountId: "x", ingestedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), providerBalanceAt: null }, NOW);
  type C = { debtSubtype: string | null; providerSubtype: string | null; creditLimit: number | null };
  const heWithLimit:  C = { debtSubtype: null, providerSubtype: "home equity",    creditLimit: 50_000 };
  const heNoLimit:    C = { debtSubtype: null, providerSubtype: "home equity",    creditLimit: null };
  const heZeroLimit:  C = { debtSubtype: null, providerSubtype: "home equity",    creditLimit: 0 };
  const locNoLimit:   C = { debtSubtype: null, providerSubtype: "line of credit", creditLimit: null };
  const odNoLimit:    C = { debtSubtype: null, providerSubtype: "overdraft",      creditLimit: null };
  const locWithLimit: C = { debtSubtype: null, providerSubtype: "line of credit", creditLimit: 5_000 };
  const mtgWithLimit: C = { debtSubtype: null, providerSubtype: "mortgage",       creditLimit: 400_000 };

  // home equity WITH a positive limit ⇒ revolving, utilization computed
  check("home equity + limit ⇒ revolving", liabilityKind({ type: "debt", ...heWithLimit }) === "revolving");
  check("home equity + limit is a revolving line", isRevolvingLine(heWithLimit) === true);
  const uHe = creditUtilization([{ id: "he", name: "he", type: "debt", balance: 12_500, ...heWithLimit }]);
  check("home equity + limit: utilization row 25%", uHe.rows.length === 1 && uHe.rows[0].pct === 25, uHe);
  check("home equity + limit: walked like a revolving line", isReconstructableCard({ type: "debt", ...heWithLimit }) === true);
  const bHe = resolveAccountBalances({ accountId: "he", accountType: "debt", currency: "USD", balance: 12_500, availableBalance: 37_500, freshness: fresh, ...heWithLimit });
  check("home equity + limit: available is AVAILABLE_CREDIT", bHe.available.status === "AVAILABLE" && bHe.available.quantity === "AVAILABLE_CREDIT", bHe.available);

  // home equity WITHOUT a (positive) limit ⇒ installment
  for (const [label, c] of [["no limit", heNoLimit], ["zero limit", heZeroLimit]] as const) {
    check(`home equity, ${label} ⇒ installment`, isInstallmentLoan({ type: "debt", ...c }) === true);
    check(`home equity, ${label}: not prompted for a limit`,
      creditUtilization([{ id: "he", name: "he", type: "debt", balance: 12_500, ...c }]).missingLimit.length === 0);
    check(`home equity, ${label}: not walked`, isReconstructableCard({ type: "debt", ...c }) === false);
    const b = resolveAccountBalances({ accountId: "he", accountType: "debt", currency: "USD", balance: 12_500, availableBalance: 1_000, freshness: fresh, ...c });
    check(`home equity, ${label}: available NOT_APPLICABLE`, JSON.stringify(b.available).includes("NOT_APPLICABLE"), b.available);
  }

  // line of credit / overdraft WITHOUT a limit ⇒ revolving; utilization unknown (never ÷0 / ÷null)
  for (const [label, c] of [["line of credit", locNoLimit], ["overdraft", odNoLimit]] as const) {
    check(`${label}, no limit ⇒ revolving`, liabilityKind({ type: "debt", ...c }) === "revolving" && !isInstallmentLoan(c));
    const u = creditUtilization([{ id: "x", name: "x", type: "debt", balance: 900, ...c }]);
    check(`${label}, no limit: no utilization row (unknown, not a number)`, u.rows.length === 0, u);
    check(`${label}, no limit: offered 'add a credit limit' (it IS revolving)`, u.missingLimit.length === 1, u);
    const util = accountUtilization({ id: "x", name: "x", type: "debt", institution: "B", balance: 900, currency: "USD", providerSubtype: c.providerSubtype });
    check(`${label}, no limit: ledger utilization is null (never NaN/Infinity)`, util === null, util);
    check(`${label}, no limit: KPI utilization null`, computeDebtKpis([{ id: "x", name: "x", type: "debt", institution: "B", balance: 900, currency: "USD", providerSubtype: c.providerSubtype }]).utilizationPct === null);
    check(`${label}, no limit: credit health can carry a limit`,
      canCarryLimit({ id: "x", name: "x", type: "debt", institution: "B", balance: 900, currency: "USD", providerSubtype: c.providerSubtype }) === true);
    const b = resolveAccountBalances({ accountId: "x", accountType: "debt", currency: "USD", balance: 900, availableBalance: 4_100, freshness: fresh, ...c });
    check(`${label}, no limit: provider available read as AVAILABLE_CREDIT`, b.available.status === "AVAILABLE" && b.available.quantity === "AVAILABLE_CREDIT", b.available);
  }
  const uLoc = creditUtilization([{ id: "loc", name: "loc", type: "debt", balance: 1_000, ...locWithLimit }]);
  check("line of credit + limit: utilization 20%", uLoc.rows.length === 1 && uLoc.rows[0].pct === 20, uLoc);

  // mortgage WITH a limit stays installment (H5)
  check("mortgage + limit ⇒ installment", isInstallmentLoan({ type: "debt", ...mtgWithLimit }) === true && isRevolvingLine(mtgWithLimit) === false);

  // debtSubtype overrides both ways
  check("override → revolving: Plaid mortgage + debtSubtype heloc", liabilityKind({ ...mtgWithLimit, debtSubtype: "heloc" }) === "revolving" && isRevolvingLine({ ...mtgWithLimit, debtSubtype: "heloc" }));
  check("override → revolving: home equity w/o limit + debtSubtype line_of_credit", liabilityKind({ ...heNoLimit, debtSubtype: "line_of_credit" }) === "revolving");
  check("override → installment: home equity + limit + debtSubtype mortgage", isInstallmentLoan({ ...heWithLimit, debtSubtype: "mortgage" }) && !isRevolvingLine({ ...heWithLimit, debtSubtype: "mortgage" }));
  check("override → installment: line of credit + debtSubtype personal_loan", isInstallmentLoan({ ...locWithLimit, debtSubtype: "personal_loan" }));
  check("override → installment: Plaid credit card + debtSubtype auto_loan", isInstallmentLoan({ ...CASES.card, debtSubtype: "auto_loan" }));

  // sub-lists stay inside the enum-parity list
  check("revolving/limit-discriminated Plaid loan subtypes are members of PLAID_LOAN_SUBTYPES",
    [...PLAID_REVOLVING_LOAN_SUBTYPES, ...PLAID_LIMIT_DISCRIMINATED_SUBTYPES].every((x) => PLAID_LOAN_SUBTYPES.has(x)));
}

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll Mortgage F2 liability-kind checks passed.");
