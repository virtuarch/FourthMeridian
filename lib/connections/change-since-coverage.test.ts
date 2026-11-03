/**
 * lib/connections/change-since-coverage.test.ts  (PB-8b — post-PB-8 honesty fix)
 *
 * PB-8 marks history days before a liability's balance-history floor as PARTIAL,
 * but the headline "change since" still subtracted a PARTIAL opening day from a
 * COMPLETE closing one. Verified on Preview 2026-11-03 (Debt view, PAST_YEAR):
 * the hero read "↑ $316,074.35 · 2553.8% vs Jun 17, 2026" — on Jun 17, 10 of 12
 * debts had no history, so the "change" is the missing debts arriving.
 *
 * The rule (balance-coverage.core `changeComparability`): a change whose opening
 * (or closing) day is before the coverage floor of the accounts its series is
 * composed from is WITHHELD and said — "Change unavailable: history is partial
 * before <floor>" — never a $ / % figure; an ESTIMATED endpoint (a held-flat
 * liability inside its floor) keeps the change, labelled estimated; no coverage
 * ⇒ byte-identical to before.
 *
 * Synthetic fixture shaped like the Preview finding (no customer data): 12 debts,
 * 2 walked cards with history since early 2026, 10 debts whose floor is Nov 2,
 * 2026 (4 of them held flat — installment loans). Sections:
 *   §1 the core gate
 *   §2 Debt hero — the exact Preview shape (withheld), complete window
 *      (unchanged), estimated window (labelled); rendered
 *   §3 Net Worth hero + secondary rows + KPI rows — same three cases; rendered
 *   §4 story / insight text — "What moved …?" ledger and the composition chips
 *   §5 wiring pins
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/connections/change-since-coverage.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot } from "@/types";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { debtWindowChange } from "@/components/space/widgets/debt/debt-trend-points";
import { DebtHero } from "@/components/space/widgets/debt/DebtHero";
import { WealthHero, gatedDelta } from "@/components/space/widgets/wealth/WealthHero";
import { WealthChangeLedger } from "@/components/space/widgets/wealth/WealthChangeLedger";
import { WealthCompositionCard } from "@/components/space/widgets/wealth/WealthCompositionCard";
import { wealthChangeGate, gateFor, gateForDriver, gatedCompareLabel } from "@/components/space/widgets/wealth/wealth-change-gate";
import { changeComparability, changeUnavailableMessage, type BalanceCoverage } from "./balance-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// ── Fixture — the Preview shape ──────────────────────────────────────────────
const FLOOR = "2026-11-02";
const TODAY = "2026-11-03";
const COV: BalanceCoverage = {
  liabilityFloors: ["2026-01-05", "2026-02-10", ...Array<string>(10).fill(FLOOR)],
  assetFloors: ["2026-01-05"],
  estimatedLiabilityFloors: Array<string>(4).fill(FLOOR),
};
// All floors before the window — nothing partial, nothing held flat.
const COV_COMPLETE: BalanceCoverage = { liabilityFloors: ["2026-01-05", "2026-02-10"], assetFloors: ["2026-01-05"], estimatedLiabilityFloors: [] };

// The opening day holds only the 2 walked cards; from the floor all 12 are in.
const OPENING_DEBT = 12_376.80;
const CLOSING_DEBT = OPENING_DEBT + 316_074.35;
const DEBT_POINTS = [
  { date: "2026-06-17", totalDebt: OPENING_DEBT, isEstimated: true },
  { date: "2026-09-01", totalDebt: 11_900.00, isEstimated: true },
  { date: "2026-11-01", totalDebt: 11_650.00, isEstimated: true },
  { date: FLOOR,        totalDebt: CLOSING_DEBT - 210, isEstimated: true },
  { date: TODAY,        totalDebt: CLOSING_DEBT, isEstimated: false },
];
const slice = (from: string) => ({
  points: DEBT_POINTS.filter((p) => p.date >= from), currency: "USD", windowStart: from, windowAsOf: TODAY,
});

// ── §1 the core gate ─────────────────────────────────────────────────────────
{
  assert.equal(changeUnavailableMessage(FLOOR), "Change unavailable: history is partial before Nov 2, 2026");
  assert.deepEqual(changeComparability(COV, ["liability"], { fromISO: "2026-06-17", toISO: TODAY }),
    { state: "withheld", coveredFromISO: FLOOR, message: "Change unavailable: history is partial before Nov 2, 2026" });
  assert.equal(changeComparability(COV, ["liability"], { fromISO: "2026-06-17", toISO: "2026-11-01" }).state, "withheld", "both endpoints partial ⇒ withheld");
  assert.equal(changeComparability(COV, ["liability"], { fromISO: FLOOR, toISO: TODAY }).state, "comparable", "on the floor, observed endpoints ⇒ comparable");
  assert.equal(changeComparability(COV, ["liability"], { fromISO: FLOOR, toISO: TODAY, fromEstimated: true }).state, "estimated", "a held-flat endpoint ⇒ estimated");
  assert.equal(changeComparability(COV, ["asset"], { fromISO: "2026-06-17", toISO: TODAY }).state, "comparable", "cash covered since Jan ⇒ comparable");
  assert.equal(changeComparability(COV, [], { fromISO: "2026-06-17", toISO: TODAY }).state, "comparable", "a series of neither side is never gated");
  assert.equal(changeComparability(null, ["liability"], { fromISO: "2026-06-17", toISO: TODAY }).state, "comparable", "no coverage read ⇒ as before");
  assert.equal(changeComparability(COV_COMPLETE, ["liability"], { fromISO: "2026-06-17", toISO: TODAY, fromEstimated: true }).state, "comparable",
    "a reconstructed (walked) endpoint with no held-flat debt is not 'estimated'");
  ok("§1 withheld before the floor (either endpoint); estimated only for a held-flat endpoint; fail-open without coverage");
}

// ── §2 Debt hero ─────────────────────────────────────────────────────────────
const KPIS = {
  totalDebt: CLOSING_DEBT, estMonthlyInterest: 0, accountCount: 12, owingCount: 12, settledCount: 0, creditCount: 0,
  ratedCount: 0, unratedCount: 12, utilizationPct: null, utilizationLevel: null, estimated: false,
};
const ENVELOPE = { completeness: "complete", warnings: [] };
const debtHero = (w: ReturnType<typeof debtWindowChange>) => text(renderToStaticMarkup(createElement(DebtHero, {
  kpis: KPIS, currency: "USD", liabilityCount: 12, asOf: TODAY, today: TODAY, historical: false,
  change: w.change, changeWithheld: w.withheld, envelope: ENVELOPE, verdict: null, verdictAsOf: null, redactions: 0,
} as never)));
{
  // Before the fix (no coverage applied) — the exact Preview figure, pinned so the fixture is the finding.
  const before = debtWindowChange(slice("2026-06-17"), null);
  assert.equal(before.change!.abs.toFixed(2), "316074.35");
  assert.equal(before.change!.pct!.toFixed(1), "2553.8");
  assert.ok(/↑ \$316,074\.35 · 2553\.8% vs Jun 17, 2026/.test(debtHero(before)), "pre-fix hero reads the meaningless cross-floor delta");

  // PB-8b — the opening day is partial ⇒ withheld, said, no figure, no %.
  const partial = debtWindowChange(slice("2026-06-17"), COV);
  assert.equal(partial.change, null);
  assert.equal(partial.withheld, "Change unavailable: history is partial before Nov 2, 2026");
  const html = debtHero(partial);
  assert.ok(html.includes("Change unavailable: history is partial before Nov 2, 2026"), "said on the hero (desktop + compact)");
  assert.equal((html.match(/Change unavailable: history is partial before Nov 2, 2026/g) ?? []).length, 2, "both layouts say it");
  assert.ok(!/316,074|2553\.8%|vs Jun 17/.test(html), "no cross-floor $ / % / 'vs' anywhere");
  assert.ok(!html.includes("Add a Compare To date"), "the withheld reason replaces the no-comparison hint");

  // Complete window — unchanged: same object as the no-coverage path, same render.
  const complete = debtWindowChange(slice("2026-06-17"), COV_COMPLETE);
  assert.deepEqual(complete, before, "a complete window is byte-identical to before");
  assert.equal(debtHero(complete), debtHero(before));

  // Estimated — opening on the floor, a reconstructed day carrying held-flat debts.
  const est = debtWindowChange(slice(FLOOR), COV);
  assert.equal(est.withheld, null);
  assert.equal(est.change!.estimated, true);
  assert.equal(est.change!.abs, 210);
  const eh = debtHero(est);
  assert.ok(/vs Nov 2, 2026 · estimated/.test(eh), "desktop badge labelled estimated");
  assert.ok(/Nov 2, 2026 → Nov 3, 2026 · estimated/.test(eh), "compact range labelled estimated");

  // A historical view keeps its own wording (different bases) — never the withheld text.
  const hist = text(renderToStaticMarkup(createElement(DebtHero, {
    kpis: KPIS, currency: "USD", liabilityCount: 12, asOf: "2026-10-01", today: TODAY, historical: true,
    change: null, changeWithheld: partial.withheld, envelope: ENVELOPE, verdict: null, verdictAsOf: null, redactions: 0,
  } as never)));
  assert.ok(hist.includes("Change shown in the chart") && !/316,074/.test(hist));
  ok("§2 Debt hero: Preview shape withheld (no $/%), complete window unchanged, estimated labelled");
}

// ── §3 Net Worth ─────────────────────────────────────────────────────────────
const CASH = 20_000, INVESTED = 50_000;
function snap(date: string, debt: number, isEstimated: boolean): Snapshot {
  const totalAssets = CASH + INVESTED;
  return {
    date, isEstimated, totalCash: CASH, totalSavings: 0, totalInvestments: INVESTED, totalCrypto: 0, totalDebt: debt,
    totalAssets, netWorth: totalAssets - debt, netLiquid: CASH - debt, cashOnHand: CASH,
  } as Snapshot;
}
const ROWS = DEBT_POINTS.map((p) => snap(p.date, p.totalDebt, p.isEstimated));
const wealth = (compareTo: string) => computeWealthTimeMachine({ snapshots: ROWS, asOf: TODAY, compareTo, currency: "USD" });
const nwHero = (result: ReturnType<typeof wealth>, changeGate: unknown, metric = "netWorth") =>
  text(renderToStaticMarkup(createElement(WealthHero, { result, currency: "USD", envelope: ENVELOPE, metric, changeGate } as never)));
{
  const r = wealth("2026-06-17");
  assert.ok(r.deltas, "the read model itself is untouched (deltas still computed)");
  const gate = wealthChangeGate(r, COV)!;
  assert.equal(gate.netWorth.state, "withheld");
  assert.equal(gate.totalLiabilities.state, "withheld");
  assert.equal(gate.liquidNetWorth.state, "withheld");
  assert.equal(gate.totalAssets.state, "comparable", "assets are covered since Jan");
  assert.equal(gate.cash.state, "comparable");
  assert.equal(gate.invested.state, "comparable");

  const before = nwHero(r, null);
  assert.ok(/vs Jun 17, 2026/.test(before) && /−\$316,074/.test(before), "pre-fix: the cross-floor net-worth change is printed");
  const html = nwHero(r, gate);
  assert.equal((html.match(/Change unavailable: history is partial before Nov 2, 2026/g) ?? []).length, 2, "both layouts say it");
  assert.ok(!/vs Jun 17, 2026/.test(html) && !/316,074/.test(html), "no cross-floor net-worth or liabilities change");
  assert.equal(gatedDelta(r, gate, "totalLiabilities"), null, "Liabilities row: value only");
  assert.equal(gatedDelta(r, gate, "liquidNetWorth"), null, "Liquid NW row: value only");
  assert.deepEqual(gatedDelta(r, gate, "totalAssets"), r.deltas!.totalAssets, "Assets row keeps its (covered) change");
  // Debt metric on the Net Worth page (Total liabilities) — withheld too.
  assert.ok(nwHero(r, gate, "totalLiabilities").includes("Change unavailable: history is partial before Nov 2, 2026"));
  // Assets headline is covered ⇒ unchanged.
  assert.equal(nwHero(r, gate, "totalAssets"), nwHero(r, null, "totalAssets"));

  // Complete window — no gate at all, byte-identical render.
  const gc = wealthChangeGate(r, COV_COMPLETE)!;
  assert.ok(Object.values(gc).every((g) => g.state === "comparable"));
  assert.equal(nwHero(r, gc), before);
  assert.equal(wealthChangeGate(r, null), null, "no coverage read ⇒ no gate");

  // Estimated — compare on the floor (a reconstructed day with held-flat debts).
  const re = wealth(FLOOR);
  const ge = wealthChangeGate(re, COV)!;
  assert.equal(ge.netWorth.state, "estimated");
  assert.equal(ge.totalAssets.state, "comparable", "no held-flat asset ⇒ not estimated");
  assert.equal(gatedCompareLabel("Nov 2, 2026", ge.netWorth), "Nov 2, 2026 · estimated");
  const eh = nwHero(re, ge);
  assert.ok(/vs Nov 2, 2026 · estimated/.test(eh) && /Nov 2, 2026 → Nov 3, 2026 · estimated/.test(eh), "labelled estimated in both layouts");
  ok("§3 Net Worth hero + secondary rows: withheld across the floor, complete unchanged, estimated labelled");
}

// ── §4 story / insight text ──────────────────────────────────────────────────
{
  const r = wealth("2026-06-17");
  const gate = wealthChangeGate(r, COV)!;
  const ledger = (metric: string, g: unknown) => text(renderToStaticMarkup(createElement(WealthChangeLedger, { result: r, currency: "USD", metric, changeGate: g } as never)));
  const l = ledger("netWorth", gate);
  assert.ok(l.includes("What moved your net worth?") && l.includes("Change unavailable: history is partial before Nov 2, 2026."), "the story card says why");
  assert.ok(!/Net Change|316,074|Since Jun 17/.test(l), "no cross-floor attribution or total");
  assert.ok(ledger("totalLiabilities", gate).includes("Change unavailable"));
  assert.equal(ledger("totalAssets", gate), ledger("totalAssets", null), "a covered series' story is unchanged");
  assert.equal(ledger("netWorth", wealthChangeGate(r, COV_COMPLETE)), ledger("netWorth", null), "complete window unchanged");
  const le = text(renderToStaticMarkup(createElement(WealthChangeLedger, { result: wealth(FLOOR), currency: "USD", metric: "netWorth", changeGate: wealthChangeGate(wealth(FLOOR), COV) } as never)));
  assert.ok(le.includes("Since Nov 2, 2026 · estimated"), "estimated story labelled");

  // Composition chips — the liabilities chip would be the arrival; cash is covered.
  assert.equal(gateForDriver(gate, "liabilities").state, "withheld");
  assert.equal(gateForDriver(gate, "cash").state, "comparable");
  assert.equal(gateForDriver(gate, "investments").state, "comparable");
  const card = (g: unknown) => text(renderToStaticMarkup(createElement(WealthCompositionCard, { result: r, currency: "USD", metric: "netWorth", changeGate: g } as never)));
  const before = card(null);
  assert.ok(/Liabilities\s*−\$316,074/.test(before) || /316,074/.test(before), "pre-fix: a cross-floor liabilities chip");
  assert.ok(!/316,074/.test(card(gate)), "no cross-floor chip");
  assert.equal(gateFor(null, "netWorth").state, "comparable");
  ok("§4 'What moved …?' story + composition chips: withheld across the floor, estimated labelled, covered series unchanged");
}

// ── §5 wiring ────────────────────────────────────────────────────────────────
{
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const dw = src("../../components/space/widgets/debt/DebtWorkspace.tsx");
  assert.ok(/debtWindowChange\(history, balanceCoverage\)/.test(dw) && /changeWithheld=\{changeWithheld\}/.test(dw), "Debt workspace gates its hero");
  const ww = src("../../components/space/widgets/wealth/WealthWorkspace.tsx");
  assert.ok(/wealthChangeGate\(result, balanceCoverage\)/.test(ww), "Net Worth workspace builds the gate");
  assert.equal((ww.match(/changeGate=\{changeGate\}/g) ?? []).length, 3, "hero, composition card and ledger receive it");
  assert.ok(/gatedDelta\(result, changeGate, row\.key\)/.test(ww), "compact KPI strip rows gated");
  ok("§5 Debt + Net Worth workspaces wire the gate into every change surface");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`change-since-coverage: ${checks.length} checks passed`);
