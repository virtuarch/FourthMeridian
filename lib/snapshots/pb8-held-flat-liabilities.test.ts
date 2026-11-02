/**
 * lib/snapshots/pb8-held-flat-liabilities.test.ts  (PB-8 — owner's five required regressions)
 *
 * The EXACT Production shape (2026-11-01, diagnosed read-only; every number here
 * is synthetic except the shape the owner specified):
 *
 *   card A    walked: 150 posted tx from 2024-11, credit limit present
 *   card B    walked:  79 posted tx from 2025-05, credit limit present
 *   card C    providerSubtype "credit card", NO debtSubtype, NO creditLimit;
 *             83 posted (0 pending): 79 negative + 4 positive, first 2026-08-04,
 *             anchor 12,839.48
 *   mortgage  providerSubtype "mortgage", 0 transactions
 *   every account created + linked 2026-11-01 (PERSONAL Space); today 2026-11-02.
 *
 * The four states (owner rule) on the existing vocabulary:
 *   VERIFIED = observed · RECONSTRUCTED = derived (walked) · ESTIMATED = estimated
 *   (held flat inside its floor) · UNKNOWN = incomplete (before the floor).
 *
 *   1. card C (no subtype, no limit, providerSubtype "credit card") ⇒ RECONSTRUCTED.
 *   2. the walk: posted-only, sign convention, payments/credits, interest-as-tx;
 *      reproduces today's anchor; days before the first tx are UNKNOWN.
 *   3. mortgage ⇒ ESTIMATED from its link floor, UNKNOWN before — never $0, never
 *      back-filled, never the epoch.
 *   4. incomplete coverage ⇒ partial/unknown marker in the series AND the chart
 *      DTO (debt and net worth), caption, rendered — no unexplained $0 cliff.
 *   5. the probe: the prod shape yields 0 false violations; the mortgage is
 *      UNVERIFIABLE; a genuine walked mismatch is still flagged; rows an earlier
 *      30-day run wrote before the link are counted, not alarmed.
 *   +  one shared card predicate (refresh.ts calls it; no second copy).
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isReconstructableCard, isHeldFlatBalanceAccount, computeAccountFloors, reconstructDailyLiabilityBalances,
  fromISO, isoDate, addDaysUTC, PLAID_CREDIT_SUBTYPES,
} from "./backfill-core";
import { amountOwed } from "@/lib/debt/balance-semantics";
import { auditDebtReplay, auditLiabilitySeries, type DebtReplayRow } from "./series-integrity.core";
import { resolveAccountsOverWindow, type AsOfAccountInput } from "@/lib/data/accounts-asof.core";
import { resolveAccountCoverage, coverageClassFor } from "@/lib/data/account-coverage.core";
import {
  deriveBalanceCoverage, writerAlignedFloorISO, balanceCoverageNote, balanceCoverageSidesFor,
  type BalanceCoverageAccountInput,
} from "@/lib/connections/balance-coverage.core";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { projectWealthTrendPoints } from "@/components/space/widgets/wealth/wealth-trend-points";
import { debtTrendPoints } from "@/components/space/widgets/debt/debt-trend-points";
import { TrendChart } from "@/components/space/widgets/charts/TrendChart";
import { BalanceCoverageNote } from "@/components/space/widgets/shared/BalanceCoverageNote";
import type { Snapshot } from "@/types";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);
const r2 = (n: number) => Math.round(n * 100) / 100;

// ── The prod-shape fixture ───────────────────────────────────────────────────
const TODAY = fromISO("2026-11-02");
const LINKED = fromISO("2026-11-01");
const FROM = "2024-11-01";
const TO = "2026-11-01"; // yesterday — the regen window's end

type Tx = { date: string; amount: number; pending: boolean };
/** Stored convention on a debt account: NEGATIVE = charge (owed ↑), POSITIVE = payment/credit (owed ↓). */
function series(first: string, n: number, everyDays: number, amount: (i: number) => number): Tx[] {
  return Array.from({ length: n }, (_, i) => ({ date: isoDate(addDaysUTC(fromISO(first), i * everyDays)), amount: amount(i), pending: false }));
}
const TX_A = series("2024-11-05", 150, 4, (i) => (i % 2 === 0 ? -50 : 45));
const TX_B = series("2025-05-10", 79, 6, (i) => (i % 3 === 0 ? 120 : -40));
const POSITIVE_C = new Set([20, 40, 60, 80]);
const TX_C: Tx[] = [
  ...series("2026-08-04", 83, 1, (i) => (POSITIVE_C.has(i) ? 600 : i === 33 ? -45.17 /* interest, posted as a charge */ : -r2(25 + ((i * 37) % 90) + 0.19))),
  // A PENDING authorisation: excluded by the posted-only delta query (pinned below).
  { date: "2026-10-30", amount: -999.99, pending: true },
];
const ANCHOR_C = 12_839.48;

const ACCOUNTS = [
  { id: "cardA", type: "debt", balance: 2_345.67, debtSubtype: null, creditLimit: 10_000, providerSubtype: "credit card", tx: TX_A },
  { id: "cardB", type: "debt", balance: 789.01, debtSubtype: null, creditLimit: 5_000, providerSubtype: "credit card", tx: TX_B },
  { id: "cardC", type: "debt", balance: ANCHOR_C, debtSubtype: null, creditLimit: null, providerSubtype: "credit card", tx: TX_C },
  { id: "mortgage", type: "debt", balance: 323_800, debtSubtype: null, creditLimit: null, providerSubtype: "mortgage", tx: [] as Tx[] },
] as const;

// What the posted-only delta query hands the walk: (from, today], pending excluded.
function postedDeltas(ids: readonly string[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const a of ACCOUNTS) {
    if (!ids.includes(a.id)) continue;
    const m = new Map<string, number>();
    for (const t of a.tx) if (!t.pending && t.date > FROM) m.set(t.date, r2((m.get(t.date) ?? 0) + t.amount));
    out.set(a.id, m);
  }
  return out;
}

// ── The writer's composition, from its single authorities (regenerate-history) ──
const earliestTx = new Map(ACCOUNTS.filter((a) => a.tx.length).map((a) => [a.id, fromISO([...a.tx].map((t) => t.date).sort()[0])] as const));
const heldFlatIds = new Set(ACCOUNTS.filter((a) => isHeldFlatBalanceAccount(a, earliestTx.has(a.id))).map((a) => a.id));
const writerFloors = computeAccountFloors(
  ACCOUNTS.map((a) => ({ id: a.id, linkCreatedAt: LINKED, type: a.type, accountCreatedAt: LINKED })),
  earliestTx, heldFlatIds, false, TODAY,
);
const cards = ACCOUNTS.filter(isReconstructableCard).map((a) => ({ id: a.id, balance: a.balance }));
const walk = reconstructDailyLiabilityBalances(cards, postedDeltas(cards.map((c) => c.id)), TODAY, fromISO(FROM));
function writerDebtOn(dISO: string): number {
  let n = 0;
  for (const a of ACCOUNTS) {
    if (isoDate(writerFloors.get(a.id)!) > dISO) continue;      // before its floor: not in the day
    n += amountOwed(walk.get(dISO)?.has(a.id) ? walk.get(dISO)!.get(a.id)! : a.balance); // walked, else held flat
  }
  return n;
}
const DAYS: string[] = [];
for (let d = fromISO(FROM); d.getTime() <= fromISO(TO).getTime(); d = addDaysUTC(d, 1)) DAYS.push(isoDate(d));
const STORED: DebtReplayRow[] = DAYS.map((d) => ({ dateISO: d, debt: writerDebtOn(d), isEstimated: true }));

// The coverage authority's view of each account (what the resolver + marker read).
const coverageOf = (a: (typeof ACCOUNTS)[number]) => {
  const cls = coverageClassFor(a.type, isReconstructableCard(a));
  const posted = a.tx.filter((t) => !t.pending).map((t) => t.date).sort();
  return { cls, cov: resolveAccountCoverage({
    accountId: a.id, coverageClass: cls, connectionFloorISO: isoDate(LINKED), earliestPostedTxISO: posted[0] ?? null,
    earliestPositionObservationISO: null, earliestReconstructionAnchorISO: null, earliestInvestmentEventISO: null,
  }) };
};
const RESOLVER_INPUT: AsOfAccountInput[] = ACCOUNTS.map((a) => ({
  id: a.id, type: a.type, balance: a.balance, debtSubtype: a.debtSubtype, creditLimit: a.creditLimit,
  providerSubtype: a.providerSubtype, floorISO: coverageOf(a).cov.displayFromISO,
}));
const byDate = resolveAccountsOverWindow(RESOLVER_INPUT, new Map(), postedDeltas(cards.map((c) => c.id)), TODAY, fromISO(FROM), fromISO(TO));

// ── 1 · providerSubtype "credit card" ⇒ RECONSTRUCTED ────────────────────────
{
  const c = ACCOUNTS[2];
  assert.equal(isReconstructableCard(c), true, "no debtSubtype, no limit, providerSubtype 'credit card' ⇒ walked");
  assert.equal(isReconstructableCard({ ...c, providerSubtype: null }), false, "without the provider subtype it would not walk (the defect)");
  assert.equal(isReconstructableCard({ ...c, providerSubtype: "CREDIT CARD " }), true, "normalised like normalizeProviderSubtype");
  assert.equal(isReconstructableCard({ ...c, providerSubtype: "paypal" }), true, "Plaid's other credit subtype");
  assert.equal(isReconstructableCard(ACCOUNTS[3]), false, "a mortgage never walks");
  assert.equal(isReconstructableCard({ ...c, debtSubtype: "mortgage" }), false, "an explicit non-card subtype still wins");
  assert.deepEqual([...PLAID_CREDIT_SUBTYPES].sort(), ["credit card", "paypal"]);
  assert.equal(coverageOf(c).cls, "BALANCE_WALK");
  assert.equal(byDate.get("2026-09-15")!.get("cardC")!.method, "card-walkback");
  assert.equal(byDate.get("2026-09-15")!.get("cardC")!.tier, "derived", "RECONSTRUCTED = derived");
  ok("1 · card C (no debtSubtype, no creditLimit, providerSubtype 'credit card') is RECONSTRUCTED from its transactions");
}

// ── 2 · the walk ─────────────────────────────────────────────────────────────
{
  const posted = TX_C.filter((t) => !t.pending);
  assert.equal(posted.length, 83);
  assert.equal(TX_C.filter((t) => t.pending).length, 1, "fixture carries one pending row, which must not move the walk");
  assert.equal(posted.filter((t) => t.amount < 0).length, 79);
  assert.equal(posted.filter((t) => t.amount > 0).length, 4);
  const sum = r2(posted.reduce((n, t) => n + t.amount, 0));
  const preHistory = walk.get("2026-08-03")!.get("cardC")!;
  // owed(d) = owed(d+1) + amount(d+1): reversing from the anchor; forward again it lands on the anchor.
  assert.equal(r2(preHistory - sum), ANCHOR_C, "walking forward from the pre-history balance reproduces today's anchor");
  assert.equal(r2(walk.get("2026-11-01")!.get("cardC")!), ANCHOR_C, "nothing posted after the last tx ⇒ yesterday = anchor (pending excluded)");
  // Sign convention: a charge raises owed, a payment lowers it, interest is a charge.
  assert.equal(r2(walk.get("2026-08-24")!.get("cardC")! - walk.get("2026-08-23")!.get("cardC")!), -600, "payment (+600) lowers owed");
  assert.equal(r2(walk.get("2026-09-06")!.get("cardC")! - walk.get("2026-09-05")!.get("cardC")!), 45.17, "interest (−45.17) raises owed");
  const d5 = walk.get("2026-08-05")!.get("cardC")! - walk.get("2026-08-04")!.get("cardC")!;
  assert.ok(d5 > 0, "a charge raises owed");
  // The ledger identity holds on every walked day (no phantom).
  const pts = DAYS.filter((d) => d >= "2026-08-04").map((d) => ({
    dateISO: d, value: walk.get(d)!.get("cardC")!, isEstimated: true,
    movement: posted.filter((t) => t.date === d).reduce((n, t) => n + t.amount, 0),
  }));
  assert.equal(auditLiabilitySeries(pts).healthy, true);
  // Before the first posted tx: UNKNOWN — not in the series, resolver says incomplete.
  assert.equal(isoDate(writerFloors.get("cardC")!), "2026-08-04");
  assert.equal(byDate.get("2026-08-03")!.get("cardC")!.method, "before-coverage");
  assert.equal(byDate.get("2026-08-03")!.get("cardC")!.tier, "incomplete", "UNKNOWN = incomplete");
  // Posted-only is the delta query's job: pinned in every walk binding.
  for (const f of ["./regenerate-history.ts", "../data/accounts-asof-window.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(/pending:\s*false/.test(src.slice(src.indexOf("function buildDeltas"))), `${f} buildDeltas is posted-only`);
  }
  const backfill = readFileSync(new URL("./backfill.ts", import.meta.url), "utf8");
  assert.ok(/financialAccountId: \{ in: cardIds \},\s*deletedAt: null,\s*pending:\s*false/.test(backfill), "backfill's card walk is posted-only");
  ok("2 · posted-only walk: sign convention, payments, interest-as-tx; reproduces 12,839.48; before 2026-08-04 UNKNOWN");
}

// ── 3 · the mortgage: ESTIMATED from its link floor, UNKNOWN before ──────────
{
  assert.ok(heldFlatIds.has("mortgage"));
  assert.equal(isoDate(writerFloors.get("mortgage")!), "2026-11-01", "floor = the LINK date, never the epoch");
  assert.ok(STORED.filter((r) => r.dateISO < "2026-11-01").every((r) => r.debt < 323_800), "never back-filled before its floor");
  assert.equal(r2(STORED.find((r) => r.dateISO === "2026-11-01")!.debt - writerDebtOn("2026-10-31")), r2(323_800 +
    (walk.get("2026-11-01")!.get("cardA")! - walk.get("2026-10-31")!.get("cardA")!)
    + (walk.get("2026-11-01")!.get("cardB")! - walk.get("2026-10-31")!.get("cardB")!)
    + (walk.get("2026-11-01")!.get("cardC")! - walk.get("2026-10-31")!.get("cardC")!)), "present from its floor");
  assert.equal(byDate.get("2026-10-31")!.get("mortgage")!.tier, "incomplete", "UNKNOWN before");
  assert.equal(byDate.get("2026-11-01")!.get("mortgage")!.tier, "estimated", "ESTIMATED from its floor");
  // A held-flat CASH account keeps REG-2's EPOCH floor (out of PB-8 scope) — unchanged.
  const cash = computeAccountFloors([{ id: "c", linkCreatedAt: LINKED, type: "savings", accountCreatedAt: LINKED }], new Map(), new Set(["c"]), false, TODAY);
  assert.equal(cash.get("c")!.getTime(), 0);
  // Unknown is never $0: the chart marks it (test 4), the resolver says incomplete, the writer omits it.
  ok("3 · mortgage: ESTIMATED from 2026-11-01 (its link), UNKNOWN before; never back-filled, never the epoch");
}

// ── 4 · incomplete coverage ⇒ marker in the series + chart DTO, rendered ─────
const covInputs: BalanceCoverageAccountInput[] = ACCOUNTS.map((a) => {
  const { cls, cov } = coverageOf(a);
  return { side: "liability", coverageClass: cls, floorISO: writerAlignedFloorISO(cov, cls, isoDate(LINKED), isoDate(LINKED), false), balance: a.balance };
});
const COV = deriveBalanceCoverage(covInputs)!;
{
  assert.deepEqual(COV.liabilityFloors, ["2024-11-05", "2025-05-10", "2026-08-04", "2026-11-01"], "marker floors = the writer's floors");
  assert.deepEqual(ACCOUNTS.map((a) => isoDate(writerFloors.get(a.id)!)).sort(), COV.liabilityFloors);
  assert.deepEqual(COV.estimatedLiabilityFloors, ["2026-11-01"]);

  const CASH = 30_000;
  const snaps: Snapshot[] = [...STORED.map((r) => ({ ...r, isEstimated: true })), { dateISO: "2026-11-02", debt: writerDebtOn("2026-11-01"), isEstimated: false }]
    .map((r) => ({ date: r.dateISO, isEstimated: r.isEstimated, totalCash: CASH, totalSavings: 0, totalInvestments: 0, totalCrypto: 0,
      totalDebt: r.debt, totalAssets: CASH, netWorth: CASH - r.debt, netLiquid: CASH - r.debt, cashOnHand: CASH } as Snapshot));
  const slice = { points: snaps.map((s) => ({ date: s.date, totalDebt: s.totalDebt, isEstimated: s.isEstimated ?? false })),
    currency: "USD", windowStart: "2026-10-01", windowAsOf: "2026-11-02" };
  slice.points = slice.points.filter((p) => p.date >= "2026-10-01");
  const debt = debtTrendPoints(slice, COV);
  const result = computeWealthTimeMachine({ snapshots: snaps, asOf: "2026-11-02", compareTo: "2026-10-01", currency: "USD" });
  const nw = projectWealthTrendPoints(result, "netWorth", null, COV);
  for (const pts of [debt, nw]) {
    const at = (d: string) => pts.find((p) => p.date === d)!;
    assert.equal(at("2026-10-31").basis, "unreliable", "UNKNOWN day ⇒ partial (debt AND net worth)");
    assert.match(at("2026-10-31").coverageLabel ?? "", /^Partial: 1 of 4 (debts|accounts) has no balance history this far back$/);
    assert.equal(at("2026-11-01").basis, "carried", "ESTIMATED day ⇒ carried");
    assert.equal(at("2026-11-01").coverageLabel, "Estimated: 1 of 4 debts held at today’s balance (no history)");
    assert.equal(at("2026-11-02").basis, undefined, "VERIFIED live row untouched");
  }
  // The cliff is there in the stored values (the mortgage is UNKNOWN before its
  // link) — and every point on the low side of it is marked partial, so it is
  // never presented as a $323,800 change.
  const drop = nw.find((p) => p.date === "2026-10-31")!.value - nw.find((p) => p.date === "2026-11-01")!.value;
  assert.ok(drop > 300_000 && nw.filter((p) => p.date < "2026-11-01").every((p) => p.basis === "unreliable"));
  assert.ok(nw.filter((p) => p.date < "2026-11-01").every((p) => p.value === snaps.find((s) => s.date === p.date)!.netWorth), "values unchanged");

  const note = balanceCoverageNote(COV, balanceCoverageSidesFor("totalLiabilities"), "2026-10-01");
  assert.equal(note, "History is partial before Nov 1, 2026: 1 of 4 debts has no balance history that far back, so earlier days don’t fully include it; a missing debt isn’t $0 owed.");
  // Rendered (fixture-driven — the Preview check is a Sandbox Space, never a customer's).
  const chart = renderToStaticMarkup(createElement(TrendChart, { points: debt, currency: "USD", ariaLabel: "Total debt over time" }));
  assert.ok(/stroke-dasharray="1 4"/.test(chart), "the partial run is drawn dotted (unreliable)");
  assert.ok(/stroke-dasharray="8 4"/.test(chart), "the estimated run is drawn long-dashed (carried)");
  const cap = renderToStaticMarkup(createElement(BalanceCoverageNote, { from: "2026-10-01", metric: "totalLiabilities", coverage: COV }));
  assert.ok(cap.includes("data-balance-coverage-note") && cap.includes("a missing debt isn’t $0 owed"), "caption rendered");
  assert.equal(renderToStaticMarkup(createElement(BalanceCoverageNote, { from: "2026-11-01", metric: "totalLiabilities", coverage: COV })), "");
  ok("4 · UNKNOWN ⇒ partial, ESTIMATED ⇒ carried, in the debt AND net-worth chart DTOs; caption + chart rendered; values unchanged");
}

// ── 5 · the probe: same floors as the writer, 0 false violations ─────────────
{
  const probeAccounts = ACCOUNTS.map((a) => ({ id: a.id, walked: isReconstructableCard(a), heldFlatOwed: amountOwed(a.balance) }));
  const walkedOwedOn = (d: string, id: string) => amountOwed(byDate.get(d)?.get(id)?.balance ?? 0);
  const floors = new Map([...writerFloors].map(([id, d]) => [id, isoDate(d)] as const));
  const r = auditDebtReplay(STORED, probeAccounts, walkedOwedOn, floors);
  assert.deepEqual(r.violations, [], "the prod shape yields 0 false violations");
  assert.deepEqual(r.walkedAccountIds, ["cardA", "cardB", "cardC"]);
  assert.deepEqual(r.unverifiableAccountIds, ["mortgage"]);
  assert.equal(r.rowsOffWriterFloor, 0);

  // EXISTING rows: an earlier 30-day run (before PB-8) held the mortgage flat from
  // 2026-10-01 and card C flat from 2026-08-04. Not a false alarm on the mortgage
  // part (unverifiable either way); card C held flat IS a genuine disagreement with
  // its walk — the stored rows are wrong until a regen rewrites them.
  const legacy = STORED.map((row) => ({ ...row, debt: row.dateISO >= "2026-10-01" && row.dateISO < "2026-11-01" ? row.debt + 323_800 : row.debt }));
  const rl = auditDebtReplay(legacy, probeAccounts, walkedOwedOn, floors);
  assert.deepEqual(rl.violations, []);
  assert.equal(rl.rowsOffWriterFloor, 31, "Oct 1–31 counted as written by an earlier run, not alarmed");
  const heldC = STORED.map((row) => (row.dateISO >= "2026-08-04" && row.dateISO < "2026-11-01"
    ? { ...row, debt: row.debt - amountOwed(walk.get(row.dateISO)!.get("cardC")!) + ANCHOR_C } : row));
  const rc = auditDebtReplay(heldC, probeAccounts, walkedOwedOn, floors);
  assert.ok(rc.violations.length > 0 && rc.violations[0].startsWith("2026-08-04"), "a walked card stored flat is a GENUINE mismatch");
  ok("5 · probe: 0 false violations on the prod shape; mortgage unverifiable; earlier-run rows counted; genuine walked mismatch flagged");
}

// ── + one shared card predicate ──────────────────────────────────────────────
{
  const refresh = readFileSync(new URL("../plaid/refresh.ts", import.meta.url), "utf8");
  assert.ok(/isReconstructableCard\(fa\)/.test(refresh), "refresh.ts calls the shared predicate");
  const root = new URL("../../", import.meta.url).pathname;
  const offenders: string[] = [];
  const walkDir = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { walkDir(p); continue; }
      if (!/\.(ts|tsx)$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
      const src = readFileSync(p, "utf8");
      // A second copy of the walk predicate: credit_card OR (null subtype AND a limit).
      if (/debtSubtype\s*===\s*"credit_card"[\s\S]{0,120}creditLimit\s*!=\s*null/.test(src) && !p.endsWith("lib/snapshots/backfill-core.ts")) {
        offenders.push(p.slice(root.length));
      }
    }
  };
  for (const d of ["lib", "app", "components", "jobs", "scripts"]) walkDir(join(root, d));
  assert.deepEqual(offenders, [], "no second copy of the revolving-card predicate");
  // Every walk binding selects the provider subtype it now depends on.
  for (const f of ["./regenerate-history.ts", "./backfill.ts", "../data/accounts-asof.ts", "../data/accounts-asof-window.ts", "../connections/balance-coverage.ts"]) {
    assert.ok(/providerSubtype:\s*true/.test(readFileSync(new URL(f, import.meta.url), "utf8")), `${f} selects providerSubtype`);
  }
  ok("+ one card predicate: refresh.ts calls it, no second copy anywhere, every binding selects providerSubtype");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`pb8-held-flat-liabilities: ${checks.length} checks passed`);
