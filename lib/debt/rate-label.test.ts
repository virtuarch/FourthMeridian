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
import { computeDebtAggregate, MIN_KNOWN_OWED_SHARE, formatOwedShare } from "./aggregates";
import { computeDebt } from "@/lib/perspective-engine/lenses/debt.core";
import { computeAssessment } from "@/lib/ai/intelligence/annotations";
import { FinanceDomains, type AccountSummaryItem, type AccountsSectionData, type SpaceContext_AI } from "@/lib/ai/types";
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
  check("mixed: rate note states count AND share: 'rate known for 1 of 2 debts (2% of what you owe)'",
    mixed.rateCoverage.note === "rate known for 1 of 2 debts (2% of what you owe)", mixed.rateCoverage.note);
  check("mixed: minimum sum is the KNOWN 150, typed PARTIAL (not a silent 0 for the mortgage)",
    mixed.minimumPayment === 150 && mixed.minimumCoverage.status === "PARTIAL"
      && mixed.minimumCoverage.note === "minimum payment known for 1 of 2 debts (2% of what you owe)", mixed.minimumCoverage);
  check("mixed: unknown share of owed ≈ 98.4%", Math.abs(mixed.minimumCoverage.unknownOwedShare - 300_000 / 305_000) < 1e-12);

  const two = computeDebtAggregate([
    { balance: 1_000, apr: null, minimumPayment: 40 },
    { balance: 2_000, apr: null, minimumPayment: null },
    { balance: 3_000, apr: 10,   minimumPayment: 60 },
  ]);
  check("three debts: 'rate known for 1 of 3 debts (50% of what you owe)'", two.rateCoverage.note === "rate known for 1 of 3 debts (50% of what you owe)", two.rateCoverage.note);
  check("…and 'minimum payment known for 2 of 3 debts (67% of what you owe)'", two.minimumCoverage.note === "minimum payment known for 2 of 3 debts (67% of what you owe)", two.minimumCoverage.note);

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
      && none.rateCoverage.note === "rate known for 0 of 2 debts (0% of what you owe)" && none.rateCoverage.unknownOwedShare === 1
      && none.rateCoverage.sufficient === false, none);

  const settled = computeDebtAggregate([{ balance: 0, apr: null, minimumPayment: null }, { balance: -50, apr: null, minimumPayment: null }]);
  check("nothing owed: NOT_APPLICABLE (a settled card's missing terms are not a gap)",
    settled.rateCoverage.status === "NOT_APPLICABLE" && settled.minimumCoverage.status === "NOT_APPLICABLE"
      && settled.rateCoverage.note === null && settled.rateCoverage.unknownOwedShare === 0, settled);
}

// ── 2b. Sufficiency threshold (S2: < 50% of the balance rated ⇒ not shown as the figure) ─
console.log("2b. Known-share threshold for showing a PARTIAL aggregate");
{
  const at = computeDebtAggregate([{ balance: 500, apr: 20, minimumPayment: 10 }, { balance: 500, apr: null, minimumPayment: null }]);
  check("exactly 50% rated ⇒ sufficient (shown, labelled partial)", at.rateCoverage.status === "PARTIAL" && at.rateCoverage.knownOwedShare === 0.5 && at.rateCoverage.sufficient === true, at.rateCoverage);
  check("…its minimum sum is sufficient too, '(50% of what you owe)'", at.minimumCoverage.sufficient === true && at.minimumCoverage.note === "minimum payment known for 1 of 2 debts (50% of what you owe)");
  const below = computeDebtAggregate([{ balance: 490, apr: 20, minimumPayment: null }, { balance: 510, apr: null, minimumPayment: null }]);
  check("49% rated ⇒ NOT sufficient ('not enough rate information')", below.rateCoverage.sufficient === false && below.rateCoverage.note === "rate known for 1 of 2 debts (49% of what you owe)", below.rateCoverage);
  check("COMPLETE is sufficient; NONE and NOT_APPLICABLE are not",
    computeDebtAggregate([{ balance: 10, apr: 1, minimumPayment: 1 }]).rateCoverage.sufficient
      && !computeDebtAggregate([{ balance: 10, apr: null, minimumPayment: null }]).rateCoverage.sufficient
      && !computeDebtAggregate([]).rateCoverage.sufficient);
  check("MIN_KNOWN_OWED_SHARE is 0.5", MIN_KNOWN_OWED_SHARE === 0.5);
  check("share formatting never claims 0% or 100% for a real partial", formatOwedShare(0.001) === "<1%" && formatOwedShare(0.999) === ">99%" && formatOwedShare(0.0164) === "2%");

  // The debt lens: ≥ 50% shows the number (labelled partial); < 50% shows the words.
  const SCOPE = { spaceId: "s", userId: "u" };
  const OPTS = { now: () => new Date("2026-07-03T12:00:00.000Z") };
  const lrow = (id: string, balance: number, interestRate?: number, minimumPayment?: number) =>
    ({ id, type: "debt", balance, lastUpdated: "2026-07-01T00:00:00.000Z", visibilityLevel: "FULL", interestRate, minimumPayment });
  const lensAt = computeDebt(SCOPE, OPTS, [lrow("a", 500, 20, 10), lrow("b", 500)]);
  const mAt = lensAt.metrics.find((m) => m.id === "blendedApr");
  check("lens at 50%: blended rate 20 shown, labelled 'partial: rate known for 1 of 2 debts (50% of what you owe)'",
    mAt?.value === 20 && mAt.label === "Blended rate (balance-weighted) — partial: rate known for 1 of 2 debts (50% of what you owe)", JSON.stringify(mAt));
  const lensLow = computeDebt(SCOPE, OPTS, [lrow("card", 5_000, 25, 150), lrow("mtg", 300_000)]);
  const mLow = lensLow.metrics.find((m) => m.id === "blendedApr");
  check("lens at 2%: 'Not enough rate information' in place of the number", mLow?.value === "Not enough rate information" && mLow.format === "text", JSON.stringify(mLow));
  check("…the number + coverage stay in the drill-down assumption",
    lensLow.assumptions.some((x) => x.id === "partial-rate" && x.text.includes("25.00%") && x.text.includes("rate known for 1 of 2 debts (2% of what you owe)")));
  const mMin = lensLow.metrics.find((m) => m.id === "minPayments");
  check("lens minimums: 'partial: minimum payment known for 1 of 2 debts (2% of what you owe)'",
    mMin?.value === 150 && mMin.label === "Minimum payments per month — partial: minimum payment known for 1 of 2 debts (2% of what you owe)", JSON.stringify(mMin));
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
    check("mixed: note names the count AND the owed share", payoffUnknownRateNote(mixed) === "Rate known for 1 of 2 debts (2% of what you owe) — no rate is assumed for the others, and they are left out of the interest total.", payoffUnknownRateNote(mixed));
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
  check("all unknown: note 'Rate known for 0 of 1 debt (0% of what you owe)'",
    payoffUnknownRateNote(none) === "Rate known for 0 of 1 debt (0% of what you owe) — no rate is assumed for the others, and they are left out of the interest total.", payoffUnknownRateNote(none));
  check("all unknown, mortgage: 'No rate is on file'",
    payoffEstimateNotice(none, "rate")?.detail === "No rate is on file, so this counts payments against the balance only.");
  const nonAm = planPayoff({ payment: 10, startISO: "2026-01-01", liabilities: [{ id: "card", balance: 10_000, aprPct: 24 }, { id: "mtg", balance: 1_000, aprPct: null }] });
  check("non-amortizing plans still carry the counts for the note", nonAm.status === "non_amortizing" && payoffUnknownRateNote(nonAm)?.startsWith("Rate known for 1 of 2 debts (91% of what you owe)") === true, nonAm.status);
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

// ── 5. AI annotation payload: mortgage $300k unrated + card $5k @ 25% ───────
console.log("5. AI annotation payload carries coverage beside every weighted rate (S2)");
{
  const debtAcct = (id: string, name: string, bal: number, apr: number | null): AccountSummaryItem => ({
    id, name, type: "debt", balance: bal, currency: "USD", reportingBalance: bal,
    lastUpdated: "2026-07-15T00:00:00.000Z", needsReauth: false, visibilityLevel: "FULL",
    apr, minimumPayment: null, rateSource: apr != null ? "user" : null,
  } as AccountSummaryItem);
  const accounts = [debtAcct("mtg", "Home Loan", 300_000, null), debtAcct("card", "Card A", 5_000, 25)];
  // The minimal context shape of lib/ai/intelligence/debt-strategy-fx.test.ts.
  const makeCtx = (accts: AccountSummaryItem[], gaps: AccountsSectionData["knowledgeGaps"]): SpaceContext_AI => {
    const totalLiabilities = accts.reduce((t, x) => t + Math.max(0, x.reportingBalance ?? 0), 0);
    const data: AccountsSectionData = {
      totalCount: accts.length, totalAssets: 0, totalLiabilities, netWorth: -totalLiabilities, totalLiquid: 0,
      totalInvestments: 0, totalDigitalAssets: 0, totalRealAssets: 0, totalsEstimated: false, totalsUnconverted: false,
      counts: { liquid: 0, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: accts.length },
      health: { errorCount: 0, staleCount: 0, needsReauthCount: 0, errorAccountNames: [], staleAccountNames: [], needsReauthAccountNames: [] },
      knowledgeGaps: gaps, accounts: accts,
    } as AccountsSectionData;
    return {
      requestedAt: "2026-07-15T00:00:00.000Z", spaceId: "s1", userId: "u1", role: "OWNER" as SpaceContext_AI["role"], agentId: "agent1",
      resolvedDomains: ["accounts"], space: { id: "s1", name: "Test", type: "personal", category: "personal", reportingCurrency: "USD" },
      domains: { [FinanceDomains.ACCOUNTS]: { domain: "accounts", assembledAt: "2026-07-15T00:00:00.000Z", data } },
      signals: [], auditLogId: "log1",
    } as unknown as SpaceContext_AI;
  };
  const a = computeAssessment(makeCtx(accounts, [{ accountId: "mtg", accountName: "Home Loan", field: "apr", label: "Mortgage rate" }]));
  const cov = a.debtStrategy.weightedAvgAprCoverage;
  check("debtStrategy coverage: PARTIAL, 1 rated / 1 unrated, unknownOwedShare ≈ 0.984",
    cov.status === "PARTIAL" && cov.ratedCount === 1 && cov.unratedCount === 1 && Math.abs(cov.unknownOwedShare - 0.984) < 0.0005, cov);
  check("weightedAvgApr is null (never the blend of all debt, never 0)", a.debtStrategy.weightedAvgApr === null, a.debtStrategy.weightedAvgApr);
  check("the 25% travels ONLY as ratedDebtsAvgRate, labelled 'rate across the debts with a known rate only, 2% of what you owe'",
    a.debtStrategy.ratedDebtsAvgRate?.ratePct === 25
      && a.debtStrategy.ratedDebtsAvgRate.meaning.startsWith("rate across the debts with a known rate only, 2% of what you owe"), a.debtStrategy.ratedDebtsAvgRate);
  check("capitalAllocation evidence: weightedDebtApr null + the same coverage beside it",
    a.capitalAllocation.evidence.weightedDebtApr === null && a.capitalAllocation.evidence.weightedDebtRateCoverage.status === "PARTIAL");
  check("debt classification refuses (INSUFFICIENT_DATA) with no weightedAprPct",
    a.debt.classification === "INSUFFICIENT_DATA" && !("weightedAprPct" in a.debt.reason.reasonMetrics));
  // No unqualified weighted rate anywhere: every key naming a weighted/avg rate
  // with a non-null number must sit beside a coverage object.
  const offenders: string[] = [];
  const walk = (v: unknown, path: string, parent: Record<string, unknown> | null): void => {
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`, v as Record<string, unknown>);
      return;
    }
    const key = path.split(".").pop() ?? "";
    if (typeof v === "number" && /weighted.*(apr|rate)|avg.*(apr|rate)/i.test(key) && !/coverage|share|count/i.test(key)) {
      const hasCov = parent && Object.keys(parent).some((k) => /coverage|meaning/i.test(k));
      if (!hasCov) offenders.push(`${path}=${v}`);
    }
  };
  walk(a, "assessment", null);
  check("no unqualified weighted rate anywhere in the assessment payload", offenders.length === 0, offenders);

  // All rated ⇒ COMPLETE; the blend is the rate of all owed debt.
  const ok = computeAssessment(makeCtx([debtAcct("mtg", "Home Loan", 300_000, 6), debtAcct("card", "Card A", 5_000, 25)], []));
  check("all rated: COMPLETE coverage, weightedAvgApr present, no ratedDebtsAvgRate, reasonMetrics carries rateCoverageStatus",
    ok.debtStrategy.weightedAvgAprCoverage.status === "COMPLETE" && typeof ok.debtStrategy.weightedAvgApr === "number"
      && ok.debtStrategy.ratedDebtsAvgRate === undefined && ok.debt.reason.reasonMetrics.rateCoverageStatus === "COMPLETE");
  // All unrated ⇒ NONE ⇒ null, never 0.
  const none = computeAssessment(makeCtx([debtAcct("mtg", "Home Loan", 300_000, null)], []));
  check("none rated: NONE coverage, weightedAvgApr null (never 0)",
    none.debtStrategy.weightedAvgAprCoverage.status === "NONE" && none.debtStrategy.weightedAvgApr === null && none.debtStrategy.ratedDebtsAvgRate === undefined);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll rate-label / coverage / payoff-label checks passed.");
