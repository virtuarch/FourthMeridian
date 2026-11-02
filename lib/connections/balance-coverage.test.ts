/**
 * lib/connections/balance-coverage.test.ts  (PB-8 — owner ruling 2026-10-30)
 *
 * Coverage-floor presentation for held-flat / late-floored balances, on a
 * synthetic fixture shaped like the 2026-11-01 Production finding (no customer
 * data): a walked card with history since Jul 1, a card Plaid sent without a
 * limit (83 transactions since Aug 4, unwalkable), and a mortgage with zero
 * transactions — both unwalkable accounts connected Oct 30. The stored series
 * holds the card from Aug 4 and the mortgage from Oct 1 (the 30-day window).
 *
 *   §1 TODAY'S BEHAVIOUR (before PB-8) — pinned first, through the real read
 *      models: before each floor the account is simply absent, and every chart
 *      point reads as an ordinary reconstructed total. Nothing says partial;
 *      net worth "drops" by the mortgage on Oct 1.
 *   §2 the coverage authority → the Space's balance floors (dates + counts only).
 *   §3 PB-8: points before the latest relevant floor are marked PARTIAL with the
 *      existing idiom (basis `unreliable` + coverage line); values unchanged;
 *      the caption says so; series that do not contain cash/debt are untouched.
 *   §4 wiring pins.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import type { Snapshot } from "@/types";
import { projectWealthTrendPoints } from "@/components/space/widgets/wealth/wealth-trend-points";
import { debtTrendPoints } from "@/components/space/widgets/debt/debt-trend-points";
import { resolveAccountCoverage, coverageClassFor, type AccountCoverageInput } from "@/lib/data/account-coverage.core";
import { isReconstructableCard } from "@/lib/snapshots/backfill-core";
import {
  deriveBalanceCoverage, balanceCoverageSideOf, balanceCoverageSidesFor, balanceCoveredFromISO,
  balanceCoverageNote, partialCoverageLabel, type BalanceCoverageAccountInput,
} from "./balance-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

// ── Fixture: stored rows as the writer leaves them ───────────────────────────
const CASH = 20_000, CARD = 1_000, CAPONE = 12_800, MORTGAGE = 323_800, HOUSE = 450_000;
function snap(date: string): Snapshot {
  const debt = CARD + (date >= "2026-08-04" ? CAPONE : 0) + (date >= "2026-10-01" ? MORTGAGE : 0);
  const totalAssets = CASH + HOUSE;
  return {
    date, isEstimated: date < "2026-11-01",
    totalCash: CASH, totalSavings: 0, totalInvestments: 0, totalCrypto: 0, totalDebt: debt,
    totalAssets, netWorth: totalAssets - debt, netLiquid: CASH - debt, cashOnHand: CASH,
  } as Snapshot;
}
const DATES = ["2026-07-15", "2026-08-03", "2026-08-04", "2026-09-30", "2026-10-01", "2026-10-29", "2026-10-30", "2026-11-01"];
const ROWS = DATES.map(snap);
const result = computeWealthTimeMachine({ snapshots: ROWS, asOf: "2026-11-01", compareTo: "2026-07-15", currency: "USD" });
const debtSlice = {
  points: ROWS.map((r) => ({ date: r.date, totalDebt: r.totalDebt, isEstimated: r.isEstimated ?? false })),
  currency: "USD", windowStart: "2026-07-15", windowAsOf: "2026-11-01",
};

// ── §1 TODAY'S BEHAVIOUR (no coverage supplied = the pre-PB-8 path) ──────────
{
  const debt = debtTrendPoints(debtSlice, null);
  const nw = projectWealthTrendPoints(result, "netWorth");
  assert.equal(debt.find((p) => p.date === "2026-09-30")!.value, CARD + CAPONE, "before its floor the mortgage is simply absent");
  assert.equal(debt.find((p) => p.date === "2026-07-15")!.value, CARD, "…and so is the card with no walk");
  assert.ok(debt.every((p) => p.basis === undefined && p.coverageLabel === undefined), "every debt point is an ordinary point — nothing says partial");
  assert.ok(nw.every((p) => p.basis === undefined && p.coverageLabel === undefined));
  const sep30 = nw.find((p) => p.date === "2026-09-30")!.value, oct1 = nw.find((p) => p.date === "2026-10-01")!.value;
  assert.equal(sep30 - oct1, MORTGAGE, "net worth 'drops' by the whole mortgage on Oct 1");
  assert.equal(result.deltas!.totalLiabilities.abs, CAPONE + MORTGAGE, "the window change counts both arrivals as new debt");
  ok("§1 today: pre-floor days read as complete totals ($0 owed for the absent liabilities), no partial marking");
}

// ── §2 the coverage authority → balance floors ───────────────────────────────
const ACCOUNTS = [
  { id: "chk",      type: "checking", balance: CASH,     debtSubtype: null, creditLimit: null,  connection: "2026-10-30", earliestPosted: "2026-07-01" },
  { id: "card",     type: "debt",     balance: CARD,     debtSubtype: null, creditLimit: 5_000, connection: "2026-10-30", earliestPosted: "2026-07-01" },
  { id: "capone",   type: "debt",     balance: CAPONE,   debtSubtype: null, creditLimit: null,  connection: "2026-10-30", earliestPosted: "2026-08-04" },
  { id: "mortgage", type: "debt",     balance: MORTGAGE, debtSubtype: null, creditLimit: null,  connection: "2026-10-30", earliestPosted: null },
  { id: "paidoff",  type: "debt",     balance: 0,        debtSubtype: null, creditLimit: null,  connection: "2026-10-30", earliestPosted: null },
  { id: "brokerage", type: "investment", balance: 9_000, debtSubtype: null, creditLimit: null,  connection: "2026-10-30", earliestPosted: null },
];
const inputs: BalanceCoverageAccountInput[] = [];
for (const a of ACCOUNTS) {
  const side = balanceCoverageSideOf(a.type);
  if (!side) continue;
  const cls = coverageClassFor(a.type, isReconstructableCard(a));
  const covIn: AccountCoverageInput = {
    accountId: a.id, coverageClass: cls, connectionFloorISO: a.connection, earliestPostedTxISO: a.earliestPosted,
    earliestPositionObservationISO: null, earliestReconstructionAnchorISO: null, earliestInvestmentEventISO: null,
  };
  inputs.push({ side, coverageClass: cls, displayFromISO: resolveAccountCoverage(covIn).displayFromISO, balance: a.balance });
}
const cov = deriveBalanceCoverage(inputs)!;
{
  // card walked from its ledger; capone + mortgage unwalkable ⇒ connection; the
  // zero-balance held-flat debt and the brokerage are not counted.
  assert.deepEqual(cov, { liabilityFloors: ["2026-07-01", "2026-10-30", "2026-10-30"], assetFloors: ["2026-07-01"] });
  assert.equal(balanceCoveredFromISO(cov, ["liability"]), "2026-10-30");
  assert.equal(balanceCoveredFromISO(cov, ["asset"]), "2026-07-01");
  assert.equal(balanceCoveredFromISO(cov, []), null);
  assert.equal(deriveBalanceCoverage([]), null);
  assert.deepEqual(balanceCoverageSidesFor("invested"), []);
  assert.deepEqual(balanceCoverageSidesFor("netWorth"), ["asset", "liability"]);
  assert.ok(!JSON.stringify(cov).includes("capone") && !JSON.stringify(cov).includes(String(MORTGAGE)), "dates only — no ids, no balances");
  ok("§2 display floors from the one coverage authority; held-flat zero balances + out-of-scope types not counted; dates only");
}

// ── §3 PB-8 — partial, said, values unchanged ───────────────────────────────
{
  const debt = debtTrendPoints(debtSlice, cov);
  const before = debtTrendPoints(debtSlice, null);
  assert.deepEqual(debt.map((p) => p.value), before.map((p) => p.value), "values are never changed");
  for (const p of debt) {
    if (p.date < "2026-10-30") {
      assert.equal(p.basis, "unreliable", `${p.date} partial`);
      assert.equal(p.coverageLabel, "Partial: 2 of 3 debts have no balance history this far back");
    } else {
      assert.equal(p.basis, undefined, `${p.date} covered`);
      assert.equal(p.coverageLabel, undefined);
    }
  }
  assert.equal(partialCoverageLabel(cov, ["liability"], "2026-06-30"), "Partial: 3 of 3 debts have no balance history this far back");

  const nw = projectWealthTrendPoints(result, "netWorth", null, cov);
  assert.equal(nw.find((p) => p.date === "2026-10-29")!.basis, "unreliable");
  assert.equal(nw.find((p) => p.date === "2026-10-29")!.coverageLabel, "Partial: 2 of 4 accounts have no balance history this far back");
  assert.equal(nw.find((p) => p.date === "2026-10-30")!.basis, undefined);
  // Assets/cash: the checking account's floor (Jul 1) precedes the window ⇒ untouched.
  assert.ok(projectWealthTrendPoints(result, "totalAssets", null, cov).every((p) => p.basis === undefined));
  assert.ok(projectWealthTrendPoints(result, "cash", null, cov).every((p) => p.basis === undefined));

  assert.equal(
    balanceCoverageNote(cov, ["liability"], "2026-07-15"),
    "History is partial before Oct 30, 2026: 2 of 3 debts have no balance history that far back, so earlier days don’t fully include them; a missing debt isn’t $0 owed.",
  );
  assert.equal(balanceCoverageNote(cov, ["liability"], "2026-10-30"), null, "a window starting on/after the floor says nothing");
  assert.equal(balanceCoverageNote(cov, ["asset"], "2026-07-15"), null);
  assert.equal(balanceCoverageNote(null, ["liability"], "2026-07-15"), null);
  ok("§3 pre-floor points marked partial (unreliable + coverage line), values unchanged, caption only when the window reaches before the floor");
}

// ── §4 wiring ────────────────────────────────────────────────────────────────
{
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const route = src("../../app/api/spaces/[id]/data-health/route.ts");
  assert.ok(/loadBalanceCoverage\(tx, spaceId\)/.test(route) && /sources: health\.sources, balanceCoverage,/.test(route), "data-health returns balanceCoverage");
  assert.ok(/useSpaceBalanceCoverage/.test(src("../../components/space/widgets/wealth/WealthTrendChart.tsx")), "Net Worth trend marks partial");
  assert.ok(/debtTrendPoints\(history, balanceCoverage\)/.test(src("../../components/space/widgets/debt/DebtBalanceHistory.tsx")), "Debt trend marks partial");
  assert.ok(/<BalanceCoverageNote[^>]*metric=\{metric\}/.test(src("../../components/space/widgets/wealth/WealthWorkspace.tsx")), "Net Worth caption");
  assert.ok(/<BalanceCoverageNote[^>]*metric="totalLiabilities"/.test(src("../../components/space/widgets/debt/DebtWorkspace.tsx")), "Debt caption");
  const read = src("./balance-coverage.ts");
  assert.ok(/getAccountCoverage\(client, refs\)/.test(read) && /grantsBalanceDisclosure/.test(read), "floors come from the one coverage authority, disclosed links only");
  ok("§4 data-health → hook → Net Worth + Debt charts and captions");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`balance-coverage: ${checks.length} checks passed`);
