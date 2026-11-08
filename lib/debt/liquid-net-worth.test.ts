/**
 * lib/debt/liquid-net-worth.test.ts
 *
 * Mortgage F1 — OWNER DECISION 2026-11-08: liquid net worth excludes mortgages
 * and other long-term installment liabilities; total net worth keeps every
 * liability; the UI and the AI explain the difference and never call liquid net
 * worth debt-free. Unknown-kind liabilities are COUNTED (never overstated).
 *
 * Fabricated fixture values only ($10k checking, $300k mortgage, $5k card).
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/debt/liquid-net-worth.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyAccounts } from "@/lib/account-classifier";
import { computeSnapshotFields, computeLiquidSplit } from "@/lib/snapshots/backfill-core";
import {
  LIQUID_NET_WORTH_DEFINITION, LIQUID_NET_WORTH_NOT_DEBT_FREE, NET_LIQUID_HISTORY_AI_NOTE,
  LIQUID_NW_INSTALLMENT_EXCLUSION_FROM, LIQUID_NW_DEFINITION_CHANGE_LABEL, liquidNetWorthChartMarkers,
  aiLiquidNetWorth, inSentence, isExcludedFromLiquidNetWorth, liquidNetWorthBasis, liquidNetWorthNoteText,
  netLiquidIdentityViolation, storedExcludedInstallmentDebt,
} from "@/lib/debt/liquid-net-worth";
import { excludedAccountCounts, unobservedTotalCoverage } from "@/lib/balances/unobserved-totals";
import { aggregateIdentityViolations } from "@/lib/snapshots/series-integrity.core";
import { authoriseAggregates } from "@/lib/snapshots/aggregate-authorisation.core";
import { buildLensRootNode } from "@/lib/history/lens-root-node";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { METRIC_DRIVER_COMPONENTS } from "@/components/space/widgets/wealth/wealth-metric-facets";
import { registerAssembler } from "@/lib/ai/assembler-registry";
import { getFinancialSnapshot } from "@/lib/ai/conversation/tools/snapshot";
import { FinanceDomains, type AccountsSectionData } from "@/lib/ai/types";
import type { Snapshot } from "@/types";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);

const CHECKING = { id: "chk", type: "checking", balance: 10_000, currency: "USD" };
const MORTGAGE = { id: "mtg", type: "debt", balance: 300_000, currency: "USD", providerSubtype: "mortgage" };
const CARD     = { id: "card", type: "debt", balance: 5_000, currency: "USD", providerSubtype: "credit card" };
const AUTO     = { id: "auto", type: "debt", balance: 20_000, currency: "USD", debtSubtype: "auto_loan" };
const MANUAL   = { id: "man", type: "debt", balance: 2_000, currency: "USD" }; // no kind evidence

// ── 1. The owner's fixture: checking 10k + mortgage 300k ─────────────────────
{
  const c = classifyAccounts([CHECKING, MORTGAGE]);
  const f = computeSnapshotFields(c);
  assert.equal(f.netLiquid, 10_000, "liquid NW = 10,000 (mortgage excluded)");
  assert.equal(f.netWorth, -290_000, "total net worth unchanged: still subtracts the mortgage");
  assert.equal(f.debt, 300_000, "debt still carries the mortgage");
  assert.equal(c.totalInstallmentLiabilities, 300_000);
  assert.equal(computeLiquidSplit(c)?.netLiquidUnrestricted, 10_000, "Hero basis excludes it too");
  const basis = liquidNetWorthBasis([CHECKING, MORTGAGE]);
  assert.deepEqual(basis.excludedKinds, ["mortgage"]);
  assert.equal(basis.excludedNote, "Excludes: mortgage");
  assert.equal(liquidNetWorthNoteText(basis),
    "Liquid net worth excludes mortgages and other long-term loans; total net worth includes all debts. Excludes: mortgage.");
  ok("checking 10k + mortgage 300k ⇒ liquid NW 10,000, mortgage named as excluded, net worth −290,000 unchanged");
}

// ── 2. Revolving debt stays in liquid NW ─────────────────────────────────────
{
  const c = classifyAccounts([CHECKING, CARD]);
  const f = computeSnapshotFields(c);
  assert.equal(f.netLiquid, 5_000);
  assert.equal(f.netWorth, 5_000);
  assert.equal(c.totalInstallmentLiabilities, 0);
  const basis = liquidNetWorthBasis([CHECKING, CARD]);
  assert.equal(basis.excludedNote, null);
  assert.equal(liquidNetWorthNoteText(basis), LIQUID_NET_WORTH_DEFINITION, "definition alone when nothing is excluded");
  // Card + mortgage together: only the card counts.
  const both = computeSnapshotFields(classifyAccounts([CHECKING, CARD, MORTGAGE]));
  assert.equal(both.netLiquid, 5_000);
  assert.equal(both.netWorth, -295_000);
  // HELOC with a limit is revolving (counted); closed-end home equity is installment.
  assert.equal(isExcludedFromLiquidNetWorth({ type: "debt", providerSubtype: "home equity", creditLimit: 50_000 }), false);
  assert.equal(isExcludedFromLiquidNetWorth({ type: "debt", providerSubtype: "home equity", creditLimit: null }), true);
  assert.equal(isExcludedFromLiquidNetWorth({ type: "debt", debtSubtype: "heloc" }), false);
  assert.equal(isExcludedFromLiquidNetWorth({ type: "debt", providerSubtype: "line of credit" }), false);
  ok("card 5k stays ⇒ liquid NW 5,000; HELOC / line of credit counted; closed-end home equity excluded");
}

// ── 3. Several installment kinds are all named ───────────────────────────────
{
  const rows = [CHECKING, MORTGAGE, AUTO, { id: "stu", type: "debt", balance: 1, providerSubtype: "student" }];
  const basis = liquidNetWorthBasis(rows);
  assert.deepEqual(basis.excludedKinds, ["mortgage", "auto loan", "student loan"]);
  assert.equal(basis.excludedNote, "Excludes: mortgage, auto loan, student loan");
  assert.equal(computeSnapshotFields(classifyAccounts(rows)).netLiquid, 10_000);
  // Labels come from debtTypeLabel (#485), lower-cased mid-sentence; a closed-end
  // home-equity loan and other Plaid loan subtypes are "installment loan".
  const more = liquidNetWorthBasis([
    { type: "debt", balance: 1, providerSubtype: "home equity", creditLimit: null },
    { type: "debt", balance: 1, providerSubtype: "construction" },
    { type: "debt", balance: 1, debtSubtype: "personal_loan" },
  ]);
  assert.deepEqual(more.excludedKinds, ["installment loan", "personal loan"]);
  assert.equal(inSentence("HELOC"), "HELOC");
  ok("mortgage + auto + student ⇒ all excluded and named in first-seen order; labels from debtTypeLabel");
}

// ── 4. Unknown kind is COUNTED and disclosed (never overstated) ──────────────
{
  const c = classifyAccounts([CHECKING, MANUAL, MORTGAGE]);
  assert.equal(computeSnapshotFields(c).netLiquid, 8_000, "unknown-kind debt is subtracted");
  const basis = liquidNetWorthBasis([CHECKING, MANUAL, MORTGAGE]);
  assert.equal(basis.unknownKindCount, 1);
  assert.equal(basis.unknownKindNote, "Includes a debt of unknown type, so liquid net worth is not overstated");
  assert.match(liquidNetWorthNoteText(basis), /Excludes: mortgage\. Includes a debt of unknown type/);
  // A hand-built total without the installment field: nothing is excluded.
  assert.equal(computeSnapshotFields({
    totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 10_000, totalSavings: 0,
    totalLiabilities: 300_000, totalRealAssets: 0,
  }).netLiquid, -290_000, "no kind evidence ⇒ the conservative all-debt figure");
  ok("unknown-kind liability counted in liquid NW and disclosed; absent evidence never invents an exclusion");
}

// ── 5. Never worded as debt-free ─────────────────────────────────────────────
{
  for (const text of [LIQUID_NET_WORTH_DEFINITION, LIQUID_NET_WORTH_NOT_DEBT_FREE, NET_LIQUID_HISTORY_AI_NOTE,
    liquidNetWorthNoteText(liquidNetWorthBasis([MORTGAGE, MANUAL]))]) {
    assert.ok(!/debt-free (wealth|net worth) is|you are debt-free|no debts?\b/i.test(text), text);
  }
  assert.match(LIQUID_NET_WORTH_NOT_DEBT_FREE, /not debt-free/);
  assert.match(LIQUID_NET_WORTH_DEFINITION, /total net worth includes all debts/);
  ok("copy states the exclusion and that total net worth includes all debts; never claims debt-free");
}

// ── 6. Stored-row identity is bounded, pre-F1 rows still valid ───────────────
{
  const pre  = { stocks: 0, crypto: 0, total: 0, cash: 10_000, savings: 0, debt: 300_000, netWorth: -290_000, totalAssets: 10_000, netLiquid: -290_000 };
  const post = { ...pre, netLiquid: 10_000 };
  assert.deepEqual(aggregateIdentityViolations(pre), [], "pre-F1 row (all debt subtracted) still valid");
  assert.deepEqual(aggregateIdentityViolations(post), [], "F1 row (mortgage excluded) valid");
  assert.equal(storedExcludedInstallmentDebt(post), 300_000);
  assert.ok(netLiquidIdentityViolation({ ...pre, netLiquid: 10_001 }, 0.01), "above cash + savings ⇒ contradiction");
  assert.ok(netLiquidIdentityViolation({ ...pre, netLiquid: -290_001 }, 0.01), "below cash + savings − debt ⇒ contradiction");
  const auth = authoriseAggregates({ values: { ...post, cashOnHand: 10_000 }, componentAssertable: {}, isEstimated: true });
  assert.equal(auth.netLiquid.state, "EXACT");
  ok("netLiquid identity bounded: cash + savings − debt ≤ netLiquid ≤ cash + savings; F1 and pre-F1 rows authorise EXACT");
}

// ── 7. Lens root reconciles and names the exclusion ──────────────────────────
{
  const snap = {
    date: "2026-11-08", totalInvestments: 0, totalCrypto: 0, totalCash: 10_000, totalSavings: 0,
    totalDebt: 305_000, total: 0, totalAssets: 10_000, netWorth: -295_000, netLiquid: 5_000,
    cashOnHand: 10_000, isEstimated: true, completenessTier: "derived", currency: "USD",
  } as unknown as Snapshot;
  const n = buildLensRootNode({ snapshot: snap, lens: "liquid-net-worth", dateISO: "2026-11-08", fromISO: "2026-11-01", toISO: "2026-11-08", currency: "USD" })!;
  assert.equal(n.displayedValue, 5_000);
  assert.equal(n.reconciliation, "EXACT", "cash − debt + excluded installment = netLiquid");
  assert.match(n.provenance.note ?? "", /installment loans/);
  assert.match(n.provenance.note ?? "", /\$300,000\.00/);
  assert.equal(n.explainedLiabilities, 5_000, "only the counted debt is the liquid root's liability side");
  ok("lens root Liquid net worth reconciles EXACT with the installment add-back stated in its note");
}

// ── 8. Wealth drivers reconcile for Liquid NW ────────────────────────────────
{
  const mk = (date: string, debt: number, netLiquid: number, cash: number): Snapshot => ({
    date, totalInvestments: 0, totalCrypto: 0, totalCash: cash, totalSavings: 0, totalDebt: debt,
    totalAssets: cash, netWorth: cash - debt, netLiquid, cashOnHand: cash, isEstimated: false,
  } as unknown as Snapshot);
  // Mortgage paid down 2,000 from cash; card unchanged at 5,000.
  const r = computeWealthTimeMachine({
    snapshots: [mk("2026-10-01", 305_000, 7_000, 12_000), mk("2026-11-01", 303_000, 5_000, 10_000)],
    asOf: "2026-11-01", compareTo: "2026-10-01", currency: "USD",
  } as never);
  assert.equal(r.deltas!.liquidNetWorth.abs, -2_000);
  const ids = new Set<string>(METRIC_DRIVER_COMPONENTS.liquidNetWorth);
  const sum = (r.drivers ?? []).filter((d) => ids.has(d.id))
    .reduce((s, d) => s + (d.id === "liquidDebt" ? -d.delta : d.delta), 0);
  assert.equal(sum, -2_000, "Δ cash − Δ liquidDebt = Δ liquid NW (the mortgage paydown is not a liquid driver)");
  assert.ok(!METRIC_DRIVER_COMPONENTS.netWorth.includes("liquidDebt" as never), "liquidDebt never drives Net Worth");
  ok("Liquid NW drivers = cash + liquidDebt and reconcile; a mortgage paydown moves cash only");
}

// ── 8b. S2 B1 — a change across the F1 date is a DEFINITION change ─────────
{
  const mk = (date: string, debt: number, netLiquid: number, cash: number, isEstimated = false): Snapshot => ({
    date, totalInvestments: 0, totalCrypto: 0, totalCash: cash, totalSavings: 0, totalDebt: debt,
    totalAssets: cash, netWorth: cash - debt, netLiquid, cashOnHand: cash, isEstimated,
  } as unknown as Snapshot);
  // Pre-F1 OBSERVED row (old basis): mortgage 300,000 + card 5,000 subtracted.
  // Post-F1 row: card paid down to 3,000, cash 10,000 → 11,000, mortgage unchanged.
  const pre  = mk("2026-10-01", 305_000, 10_000 - 305_000, 10_000);
  const post = mk("2026-11-09", 303_000, 11_000 - 3_000, 11_000);
  const r = computeWealthTimeMachine({ snapshots: [pre, post], asOf: "2026-11-09", compareTo: "2026-10-01", currency: "USD" } as never);
  const comp = r.deltas!.composition;
  assert.equal(comp.liquidDefinitionChange, 300_000, "definition change = the mortgage balance");
  assert.equal(comp.liquidDebt, -2_000, "liquid-debt movement = the real card paydown only (mortgage movement 0)");
  assert.equal(comp.cash, 1_000);
  assert.equal(comp.cash - comp.liquidDebt + comp.liquidDefinitionChange, r.deltas!.liquidNetWorth.abs, "parts reconcile to Δ liquid NW");
  const def = r.drivers!.find((d) => d.id === "liquidDefinitionChange")!;
  assert.equal(def.label, LIQUID_NW_DEFINITION_CHANGE_LABEL);
  assert.match(def.label, /Definition change — installment loans no longer subtracted \(from 2026-11-08\)/);
  // A window entirely on one side of the date has no definition part.
  const r2 = computeWealthTimeMachine({ snapshots: [mk("2026-11-09", 303_000, 8_000, 11_000), mk("2026-11-20", 302_000, 9_000, 12_000)],
    asOf: "2026-11-20", compareTo: "2026-11-09", currency: "USD" } as never);
  assert.equal(r2.deltas!.composition.liquidDefinitionChange, 0);
  // A compare row already regenerated onto the new basis is not double-counted.
  const r3 = computeWealthTimeMachine({ snapshots: [mk("2026-10-01", 305_000, 5_000, 10_000, true), post],
    asOf: "2026-11-09", compareTo: "2026-10-01", currency: "USD" } as never);
  assert.equal(r3.deltas!.composition.liquidDefinitionChange, 0);
  // Chart annotation at the date, liquid NW series only; AI note cites the same constant.
  assert.deepEqual(liquidNetWorthChartMarkers("liquidNetWorth"), [{ date: LIQUID_NW_INSTALLMENT_EXCLUSION_FROM, label: "Definition change" }]);
  assert.deepEqual(liquidNetWorthChartMarkers("netWorth"), []);
  assert.ok(readFileSync(join(process.cwd(), "components/space/widgets/wealth/WealthTrendChart.tsx"), "utf8").includes("markers={liquidNetWorthChartMarkers(metric)}"));
  assert.ok(readFileSync(join(process.cwd(), "components/space/widgets/charts/TrendChart.tsx"), "utf8").includes("data-chart-marker={m.date}"));
  assert.ok(NET_LIQUID_HISTORY_AI_NOTE.includes(`across ${LIQUID_NW_INSTALLMENT_EXCLUSION_FROM}`));
  ok("B1: change across 2026-11-08 ⇒ definition change = mortgage, liquidDebt = card movement only; chart annotated; AI note cites the date");
}

// ── 9. Unobserved installment loan leaves liquid NW COMPLETE ─────────────────
{
  const unobsMortgage = { ...MORTGAGE, balance: 0, valuationUnknown: true };
  assert.equal(unobservedTotalCoverage("LIQUID_NET_WORTH", excludedAccountCounts([CHECKING, unobsMortgage])).status, "COMPLETE");
  assert.equal(unobservedTotalCoverage("NET_WORTH", excludedAccountCounts([CHECKING, unobsMortgage])).status, "PARTIAL");
  const unobsUnknown = { ...MANUAL, balance: 0, valuationUnknown: true };
  assert.equal(unobservedTotalCoverage("LIQUID_NET_WORTH", excludedAccountCounts([CHECKING, unobsUnknown])).status, "PARTIAL",
    "an unknown-kind debt of unknown balance still makes liquid NW partial");
  assert.equal(excludedAccountCounts([CHECKING]).installmentDebt, undefined, "count unchanged when nothing installment is excluded");
  ok("an unobserved mortgage no longer makes liquid NW partial; an unobserved unknown-kind debt still does");
}

// ── 10. AI: the assembled payload carries definition + excluded kinds ────────
async function aiPayload(): Promise<void> {
  const rows = [CHECKING, CARD, MORTGAGE, AUTO, MANUAL];
  const c = classifyAccounts(rows);
  const block = aiLiquidNetWorth(rows, c);
  assert.deepEqual(block, {
    amount: 10_000 - 5_000 - 2_000,
    definition: LIQUID_NET_WORTH_DEFINITION,
    notDebtFree: LIQUID_NET_WORTH_NOT_DEBT_FREE,
    excludedInstallmentDebt: 320_000,
    excludedKinds: ["mortgage", "auto loan"],
    unknownKindLiabilityCount: 1,
  });
  // The assembler emits exactly this builder over its classifiable rows (DB-bound, so source-pinned).
  const asm = readFileSync(join(process.cwd(), "lib/ai/assemblers/accounts.ts"), "utf8");
  assert.ok(asm.includes("liquidNetWorth: aiLiquidNetWorth(classifiableAll, classification)"));
  assert.ok(/debtSubtype: l\.financialAccount\.debtSubtype,\s*\n\s*creditLimit: l\.financialAccount\.creditLimit,/.test(asm),
    "classifiable rows carry the liability-kind evidence");
  // …and the conversation tool hands it to the model beside net worth.
  const data = {
    netWorth: c.netWorth, totalAssets: c.totalAssets, totalLiabilities: c.totalLiabilities,
    totalLiquid: c.totalLiquid, totalInvestments: 0, totalDigitalAssets: 0, totalRealAssets: 0,
    totalsEstimated: false, totalsUnconverted: false, totalCount: rows.length,
    counts: { liquid: 1, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: 4 },
    health: {} as never, knowledgeGaps: [], accounts: [], liquidNetWorth: block,
  } as unknown as AccountsSectionData;
  registerAssembler(FinanceDomains.ACCOUNTS, async () => ({ domain: FinanceDomains.ACCOUNTS, assembledAt: "2026-11-08T00:00:00.000Z", data }) as never);
  const out = await getFinancialSnapshot.run({}, { asOfISO: "2026-11-08", spaceId: "s", userId: "u" } as never) as Record<string, unknown>;
  const lnw = out.liquidNetWorth as typeof block;
  assert.equal(lnw.definition, LIQUID_NET_WORTH_DEFINITION);
  assert.deepEqual(lnw.excludedKinds, ["mortgage", "auto loan"]);
  assert.equal(out.netWorth, c.netWorth, "net worth still subtracts every debt");
  assert.ok(c.netWorth < lnw.amount);
  // History section states the definition beside every netLiquid.
  const snapAsm = readFileSync(join(process.cwd(), "lib/ai/assemblers/snapshot.ts"), "utf8");
  assert.ok(snapAsm.includes("netLiquidNote:    NET_LIQUID_HISTORY_AI_NOTE"));
  assert.match(NET_LIQUID_HISTORY_AI_NOTE, /does NOT subtract installment loans/);
  ok("AI: accounts payload + get_financial_snapshot carry liquid NW amount, definition, not-debt-free rule and excluded kinds");
}

aiPayload().then(() => {
  for (const c of checks) console.log(`  ✓ ${c}`);
  console.log(`\nliquid-net-worth: ${checks.length} checks passed`);
}).catch((e) => { console.error(e); process.exit(1); });
