/**
 * lib/debt/rate-label.test.ts
 *
 * Mortgage F3 (S2 ruling) — unit tests for:
 *   1. rate labels per liability kind (lib/debt/rate-label.ts) — the UI and the
 *      AI tool contract read the same function;
 *   2. PARTIAL weighted rate / minimum-payment totals (lib/debt/aggregates.ts
 *      rateCoverage / minimumCoverage): mixed known/unknown, all known, all
 *      unknown, nothing owed;
 *   3. payoff unknown-rate labelling (lib/debt/payoff.ts rateStatus /
 *      interestTotalScope + payoff-copy's note);
 *   4. the AI assembler / snapshot tool carry the same label (source scan —
 *      the assembler needs a DB).
 *
 * Fabricated fixture values only. Pure: no DB, no network, no clock.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/debt/rate-label.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rateLabel, rateLabelInline, blendedRateLabel, isMortgage } from "./rate-label";
import { computeDebtAggregate } from "./aggregates";
import { planPayoff } from "./payoff";
import { payoffEstimateNotice, payoffUnknownRateNote } from "@/components/space/widgets/debt/payoff-copy";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

// ── 1. Labels per kind ───────────────────────────────────────────────────────
console.log("1. Rate label follows the liability kind");
{
  const cases: Array<[string, Parameters<typeof rateLabel>[0], string]> = [
    ["Plaid mortgage (debtSubtype null)",            { type: "debt", providerSubtype: "mortgage" },                       "Mortgage rate"],
    ["Plaid mortgage carrying a limit (F2 H5)",      { type: "debt", providerSubtype: "mortgage", creditLimit: 400_000 },  "Mortgage rate"],
    ["FM debtSubtype mortgage",                      { type: "debt", debtSubtype: "mortgage" },                            "Mortgage rate"],
    ["FM debtSubtype wins over Plaid subtype",       { type: "debt", debtSubtype: "auto_loan", providerSubtype: "mortgage" }, "Loan rate"],
    ["Plaid auto",                                   { type: "debt", providerSubtype: "auto" },                            "Loan rate"],
    ["Plaid student",                                { type: "debt", providerSubtype: "student" },                         "Loan rate"],
    ["FM personal_loan",                             { type: "debt", debtSubtype: "personal_loan" },                       "Loan rate"],
    ["Plaid home equity, no limit (closed-end)",     { type: "debt", providerSubtype: "home equity" },                     "Loan rate"],
    ["Plaid home equity with a limit (HELOC)",       { type: "debt", providerSubtype: "home equity", creditLimit: 50_000 }, "APR"],
    ["FM heloc",                                     { type: "debt", debtSubtype: "heloc" },                               "APR"],
    ["Plaid credit card",                            { type: "debt", providerSubtype: "credit card" },                     "APR"],
    ["FM credit_card",                               { type: "debt", debtSubtype: "credit_card" },                         "APR"],
    ["Plaid line of credit",                         { type: "debt", providerSubtype: "line of credit" },                  "APR"],
    ["untyped row with a limit (legacy card)",       { type: "debt", creditLimit: 5_000 },                                 "APR"],
    ["untyped row, no limit",                        { type: "debt" },                                                     "Interest rate"],
  ];
  for (const [name, input, want] of cases) {
    const got = rateLabel(input);
    check(`${name} ⇒ "${want}"`, got === want, got);
  }
  check("APR is never the label of an installment loan",
    cases.filter(([, i]) => rateLabel(i) === "APR").every(([, i]) => !["mortgage", "auto", "student"].includes(i.providerSubtype ?? "")));
  check("inline: 'mortgage rate' / 'loan rate' / 'APR'",
    rateLabelInline({ providerSubtype: "mortgage" }) === "mortgage rate"
      && rateLabelInline({ providerSubtype: "auto" }) === "loan rate"
      && rateLabelInline({ providerSubtype: "credit card" }) === "APR");
  check("isMortgage reads FM subtype first, then Plaid's",
    isMortgage({ providerSubtype: "Mortgage" }) && !isMortgage({ debtSubtype: "auto_loan", providerSubtype: "mortgage" }));
  check("blended label: all revolving ⇒ 'APR'",
    blendedRateLabel([{ debtSubtype: "credit_card" }, { providerSubtype: "credit card" }]) === "APR");
  check("blended label: card + mortgage ⇒ 'rate'",
    blendedRateLabel([{ debtSubtype: "credit_card" }, { providerSubtype: "mortgage" }]) === "rate");
  check("blended label: nothing ⇒ 'rate'", blendedRateLabel([]) === "rate");
}

// ── 2. PARTIAL weighted rate / minimums ─────────────────────────────────────
console.log("2. Weighted rate and minimum-payment sums are typed PARTIAL when any owing debt lacks the term");
{
  const mixed = computeDebtAggregate([
    { balance: 300_000, apr: null, minimumPayment: null },
    { balance: 5_000,   apr: 25,   minimumPayment: 150 },
  ]);
  check("mixed: weightedApr over known only (25), never averaged over the unknown", mixed.weightedApr === 25, mixed.weightedApr);
  check("mixed: rateCoverage PARTIAL, 1 known / 1 unknown / 2 owing, unknown owed 300,000",
    mixed.rateCoverage.status === "PARTIAL" && mixed.rateCoverage.knownCount === 1 && mixed.rateCoverage.unknownCount === 1
      && mixed.rateCoverage.owingCount === 2 && mixed.rateCoverage.unknownOwed === 300_000, mixed.rateCoverage);
  check("mixed: rate note '1 of 2 debts has no rate on file'", mixed.rateCoverage.note === "1 of 2 debts has no rate on file", mixed.rateCoverage.note);
  check("mixed: minimum sum is the KNOWN 150, typed PARTIAL (not a silent 0 for the mortgage)",
    mixed.minimumPayment === 150 && mixed.minimumCoverage.status === "PARTIAL"
      && mixed.minimumCoverage.note === "1 of 2 debts has no minimum payment on file", mixed.minimumCoverage);
  check("mixed: unknown share of owed ≈ 98.4%", Math.abs(mixed.minimumCoverage.unknownOwedShare - 300_000 / 305_000) < 1e-12);

  const two = computeDebtAggregate([
    { balance: 1_000, apr: null, minimumPayment: 40 },
    { balance: 2_000, apr: null, minimumPayment: null },
    { balance: 3_000, apr: 10,   minimumPayment: 60 },
  ]);
  check("plural: '2 of 3 debts have no rate on file'", two.rateCoverage.note === "2 of 3 debts have no rate on file", two.rateCoverage.note);
  check("…and '1 of 3 debts has no minimum payment on file'", two.minimumCoverage.note === "1 of 3 debts has no minimum payment on file", two.minimumCoverage.note);

  const known = computeDebtAggregate([
    { balance: 1_000, apr: 20, minimumPayment: 35 },
    { balance: 3_000, apr: 0,  minimumPayment: 0 },
  ]);
  check("all known: COMPLETE, no note (a 0% rate and a 0 minimum are KNOWN)",
    known.rateCoverage.status === "COMPLETE" && known.minimumCoverage.status === "COMPLETE"
      && known.rateCoverage.note === null && known.minimumCoverage.note === null && known.weightedApr === 5, known);

  const none = computeDebtAggregate([
    { balance: 300_000, apr: null, minimumPayment: null },
    { balance: 20_000,  apr: null, minimumPayment: null },
  ]);
  check("all unknown: NONE, weightedApr null (no figure), minimum sum 0 with NONE coverage",
    none.rateCoverage.status === "NONE" && none.weightedApr === null
      && none.minimumCoverage.status === "NONE" && none.minimumPayment === 0
      && none.rateCoverage.note === "2 of 2 debts have no rate on file" && none.rateCoverage.unknownOwedShare === 1, none);

  const settled = computeDebtAggregate([{ balance: 0, apr: null, minimumPayment: null }, { balance: -50, apr: null, minimumPayment: null }]);
  check("nothing owed: NOT_APPLICABLE (a settled card's missing terms are not a gap)",
    settled.rateCoverage.status === "NOT_APPLICABLE" && settled.minimumCoverage.status === "NOT_APPLICABLE"
      && settled.rateCoverage.note === null && settled.rateCoverage.unknownOwedShare === 0, settled);
}

// ── 3. Payoff: unknown rate is labelled, kept out of the interest total ─────
console.log("3. Payoff never assumes 0% silently");
{
  const mixed = planPayoff({ payment: 3_000, startISO: "2026-01-01", liabilities: [
    { id: "mtg", balance: 300_000, aprPct: null }, { id: "card", balance: 5_000, aprPct: 25 },
  ] });
  if (mixed.status !== "paid_off") { check("mixed plan pays off", false, mixed.status); }
  else {
    const mtg = mixed.liabilities.find((l) => l.id === "mtg")!;
    const card = mixed.liabilities.find((l) => l.id === "card")!;
    check("mixed: mortgage rateStatus RATE_UNKNOWN, card KNOWN", mtg.rateStatus === "RATE_UNKNOWN" && card.rateStatus === "KNOWN");
    check("mixed: interestTotalScope KNOWN_RATE_ONLY; totalInterest = the card's interest only",
      mixed.interestTotalScope === "KNOWN_RATE_ONLY" && mixed.totalInterest === card.interestPaid, mixed.totalInterest);
    check("mixed: principal + totalInterest = totalPaid still holds", Math.abs(mixed.principal + mixed.totalInterest - mixed.totalPaid) < 0.005);
    check("mixed: basis counts 1 unknown of 2 owing", mixed.basis.unknownAprCount === 1 && mixed.basis.owingCount === 2);
    check("mixed: note names the count", payoffUnknownRateNote(mixed) === "Rate unknown for 1 of 2 debts — projected without interest and left out of the interest total.");
    check("mixed, non-revolving blend: estimate notice says 'a rate', never 'an APR'",
      payoffEstimateNotice(mixed, "rate")?.detail === "Interest is counted only on the debts with a rate on file.");
    check("mixed, card-only blend (default): estimate notice keeps 'an APR'",
      payoffEstimateNotice(mixed)?.detail === "Interest is counted only on the debts with an APR on file.");
  }

  const known = planPayoff({ payment: 500, startISO: "2026-01-01", liabilities: [{ id: "card", balance: 1_000, aprPct: 20 }] });
  check("all known: ALL_DEBTS scope, KNOWN status, no note",
    known.status === "paid_off" && known.interestTotalScope === "ALL_DEBTS"
      && known.liabilities[0].rateStatus === "KNOWN" && payoffUnknownRateNote(known) === null);

  const none = planPayoff({ payment: 3_000, startISO: "2026-01-01", liabilities: [{ id: "mtg", balance: 30_000, aprPct: null }] });
  check("all unknown: PRINCIPAL_ONLY, RATE_UNKNOWN, KNOWN_RATE_ONLY scope with 0 known interest",
    none.status === "paid_off" && none.basis.interest === "PRINCIPAL_ONLY" && none.liabilities[0].rateStatus === "RATE_UNKNOWN"
      && none.interestTotalScope === "KNOWN_RATE_ONLY" && none.totalInterest === 0);
  check("all unknown: note 'Rate unknown for 1 of 1 debt'",
    payoffUnknownRateNote(none) === "Rate unknown for 1 of 1 debt — projected without interest and left out of the interest total.", payoffUnknownRateNote(none));
  check("all unknown, mortgage: 'No rate is on file'",
    payoffEstimateNotice(none, "rate")?.detail === "No rate is on file, so this counts payments against the balance only.");
  const nonAm = planPayoff({ payment: 10, startISO: "2026-01-01", liabilities: [{ id: "card", balance: 10_000, aprPct: 24 }, { id: "mtg", balance: 1_000, aprPct: null }] });
  check("non-amortizing plans still carry the counts for the note", nonAm.status === "non_amortizing" && payoffUnknownRateNote(nonAm)?.startsWith("Rate unknown for 1 of 2 debts") === true, nonAm.status);
}

// ── 4. AI tool contract carries the same label ──────────────────────────────
console.log("4. AI assembler + snapshot tool use the same label as the UI");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const asm = strip(readFileSync(join(process.cwd(), "lib/ai/assemblers/accounts.ts"), "utf8"));
  check("assembler imports the ONE label authority", asm.includes("import { rateLabel } from '@/lib/debt/rate-label';"));
  check("knowledge-gap label for 'apr' is rateLabel(fa) (kind-aware, reads providerSubtype)", /field:\s*'apr',\s*label:\s*rateLabel\(fa\),/.test(asm));
  check("every FULL debt row carries rateLabel = rateLabel(fa)", /base\.rateLabel\s*=\s*rateLabel\(fa\);/.test(asm));
  check("no private debtSubtype-only resolver remains", !/resolveRateLabel|'Mortgage Rate'|'Auto Loan Rate'/.test(asm));
  const snap = strip(readFileSync(join(process.cwd(), "lib/ai/conversation/tools/snapshot.ts"), "utf8"));
  check("get_financial_snapshot projects rateLabel beside apr", /apr: a2\.apr, minimumPayment: a2\.minimumPayment,\s*\.\.\.\(a2\.rateLabel \? \{ rateLabel: a2\.rateLabel \} : \{\}\)/.test(snap));
  const meas = strip(readFileSync(join(process.cwd(), "lib/ai/conversation/tools/measures.ts"), "utf8"));
  check("get_measures discloses PARTIAL minimum debt service (typed status + note)",
    meas.includes("minimumDebtServiceCoverage") && meas.includes("aggregate.minimumCoverage.status"));
  // The label the AI receives for the fixture accounts — the same calls the assembler makes.
  check("assembler-shaped Plaid mortgage row ⇒ 'Mortgage rate'; card ⇒ 'APR'",
    rateLabel({ type: "debt", debtSubtype: null, providerSubtype: "mortgage", creditLimit: null }) === "Mortgage rate"
      && rateLabel({ type: "debt", debtSubtype: null, providerSubtype: "credit card", creditLimit: 5_000 }) === "APR");
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll rate-label / coverage / payoff-label checks passed.");
