/**
 * lib/transactions/income-source.test.ts   (V27-TRUTH-4)
 *
 * The canonical income taxonomy. Every fixture is a real shape from the live
 * corpus (2026-08-04).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attributeIncome, foldIncome, classOfSubtype,
  INCOME_CLASS_LABEL, INCOME_SUBTYPE_LABEL, type IncomeEvidence,
} from "./income-source";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ev = (o: Partial<IncomeEvidence>): IncomeEvidence =>
  ({ flowType: "INCOME", accountType: "checking", amount: 100, ...o });

console.log("V27-TRUTH-4 INCOME. Earned income");
{
  // "VECTRUS SYSTEMS PAYROLL PPD ID: 22215228" — 54 rows, $255,648.69.
  const salary = attributeIncome(ev({ providerDetail: "INCOME_SALARY", amount: 5286.64 }));
  check("payroll ⇒ EARNED_INCOME / SALARY",
    salary.incomeClass === "EARNED_INCOME" && salary.subtype === "SALARY");
  check("contractor ⇒ EARNED_INCOME / CONTRACT",
    attributeIncome(ev({ providerDetail: "INCOME_CONTRACTOR" })).subtype === "CONTRACT");
  check("gig ⇒ EARNED_INCOME / CONTRACT",
    attributeIncome(ev({ providerDetail: "INCOME_GIG_ECONOMY" })).incomeClass === "EARNED_INCOME");
}

console.log("V27-TRUTH-4 INCOME. Interest is NOT earned, and keeps its source account");
{
  // HYSA "Interest Payment" $6.03; CHASE SAVINGS "INTEREST PAYMENT" $0.01.
  const i = attributeIncome(ev({ providerDetail: "INCOME_INTEREST_EARNED", amount: 6.03,
    accountType: "savings", sourceAccountId: "hysa" }));
  check("interest ⇒ INTEREST_INCOME", i.incomeClass === "INTEREST_INCOME");
  check("...and is NOT earned income", i.incomeClass !== "EARNED_INCOME");
  check("...and retains the paying ACCOUNT", i.sourceAccountId === "hysa");
  check("...with a reason that says it is not earned", /not earned income/.test(i.reason));
}

console.log("V27-TRUTH-4 INCOME. Dividends keep their security");
{
  const d = attributeIncome(ev({ providerDetail: "INCOME_DIVIDENDS", instrumentId: "VTI", accountType: "investment" }));
  check("dividend ⇒ DIVIDEND_INCOME", d.incomeClass === "DIVIDEND_INCOME");
  check("...and retains the paying SECURITY", d.instrumentId === "VTI");
  // The 25 InvestmentEvent DIVIDEND rows carry no provider detail at all.
  const fromEvent = attributeIncome(ev({ providerDetail: null, instrumentId: "SCHD", accountType: "investment" }));
  check("an investment-event dividend still resolves by its instrument",
    fromEvent.incomeClass === "DIVIDEND_INCOME" && fromEvent.instrumentId === "SCHD");
}

console.log("V27-TRUTH-4 INCOME. Non-income inflows are excluded, and NAMED");
{
  check("an owned internal transfer is NOT income",
    attributeIncome(ev({ isOwnedInternalTransfer: true, providerDetail: "INCOME_SALARY" })).incomeClass === "NOT_INCOME");
  check("...even when the provider says salary — structure outranks the label",
    attributeIncome(ev({ isOwnedInternalTransfer: true, providerDetail: "INCOME_SALARY" })).subtype === "INTERNAL_TRANSFER");
  // +$280.45 "MICROSOFT" on a CREDIT CARD, currently filed INCOME.
  const issuer = attributeIncome(ev({ accountType: "debt", amount: 280.45, liabilityInflowIsIssuerCredit: true }));
  check("an issuer credit on a card is NOT income", issuer.incomeClass === "NOT_INCOME");
  check("...and is named as an issuer credit", issuer.subtype === "ISSUER_CREDIT");
  check("a refund is NOT income",
    attributeIncome(ev({ flowType: "REFUND" })).subtype === "REFUND_REVERSAL");
  check("loan proceeds are NOT income",
    attributeIncome(ev({ providerDetail: "LOAN_DISBURSEMENTS_STUDENT_LOAN_DISBURSEMENT" })).incomeClass === "NOT_INCOME");
}

console.log("V27-TRUTH-4 INCOME. Interest CHARGED is not interest income");
{
  // 44 live rows, Σ−16,158.26, BANK_FEES_INTEREST_CHARGE on cards.
  const charged = attributeIncome(ev({ flowType: "INTEREST", amount: -412.55, accountType: "debt",
    providerDetail: "BANK_FEES_INTEREST_CHARGE" }));
  check("a NEGATIVE interest row is never INTEREST_INCOME", charged.incomeClass !== "INTEREST_INCOME");
  check("...and never earned income", charged.incomeClass !== "EARNED_INCOME");
}

console.log("V27-TRUTH-4 INCOME. UNKNOWN is preserved, never promoted");
{
  // 28 "Bitcoin received" rows on Cold Wallet BTC, no provider family at all.
  const u = attributeIncome(ev({ providerDetail: null, providerFamily: null, amount: 0.01, accountType: "crypto" }));
  check("no evidence ⇒ UNRESOLVED_INCOME", u.subtype === "UNRESOLVED_INCOME");
  check("...classed OTHER_INCOME, never EARNED", u.incomeClass === "OTHER_INCOME");
  check("...and says the source is not established", /not established/.test(u.reason));
}

console.log("V27-TRUTH-4 INCOME. The rollup is composed, not asserted");
{
  const rows = [
    { amount: 255648.69, attribution: attributeIncome(ev({ providerDetail: "INCOME_SALARY" })) },
    { amount: 18435.75,  attribution: attributeIncome(ev({ providerDetail: "INCOME_CONTRACTOR" })) },
    { amount: 45.09,     attribution: attributeIncome(ev({ providerDetail: "INCOME_GIG_ECONOMY" })) },
    { amount: 68.63,     attribution: attributeIncome(ev({ providerDetail: "INCOME_INTEREST_EARNED" })) },
    { amount: 27.76,     attribution: attributeIncome(ev({ instrumentId: "VTI" })) },
    { amount: 0.24,      attribution: attributeIncome(ev({ providerDetail: null })) },
    { amount: 280.45,    attribution: attributeIncome(ev({ accountType: "debt", liabilityInflowIsIssuerCredit: true })) },
  ];
  const b = foldIncome(rows);
  check("broad income EQUALS the sum of its subtypes",
    Math.abs(b.broad - (b.earned + b.interest + b.dividends + b.other)) < 1e-9);
  check("earned excludes interest, dividends and the issuer credit",
    Math.abs(b.earned - 274129.53) < 0.005);
  check("interest is separated", Math.abs(b.interest - 68.63) < 0.005);
  check("dividends are separated", Math.abs(b.dividends - 27.76) < 0.005);
  check("other holds only the unresolved crypto receipts", Math.abs(b.other - 0.24) < 0.005);
  check("the issuer credit is EXCLUDED, and visibly so", Math.abs(b.excluded - 280.45) < 0.005);
  check("...so it is NOT inside broad income", b.broad < 274129.53 + 68.63 + 27.76 + 0.25);
  check("every row lands in exactly one class",
    Object.values(b.counts).reduce((s, n) => s + n, 0) === rows.length);
}

console.log("V27-TRUTH-4 INCOME. Static probes");
{
  const src = readFileSync(join(__dirname, "income-source.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  for (const f of ["merchant", "description", "descriptor", "toUpperCase", "RegExp", "test("]) {
    check(`no merchant-string logic: never references \`${f}\``, !src.includes(f));
  }
  for (const f of ["interval", "cadence", "recurr", "monthly", "biweekly", "getTime", "Date"]) {
    check(`no cadence inference: never references \`${f}\``, !src.includes(f));
  }
  check("pure — no DB, no React", !src.includes("@/lib/db") && !src.includes("react"));
  check("every subtype has a class and a label",
    Object.keys(INCOME_SUBTYPE_LABEL).every((s) => classOfSubtype(s as never) !== undefined));
  check("every class has a label", Object.keys(INCOME_CLASS_LABEL).length === 5);
}

console.log(failures === 0 ? "\nincome-source: all passed." : `\nincome-source: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
