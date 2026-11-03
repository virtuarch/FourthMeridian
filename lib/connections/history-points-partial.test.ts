/**
 * lib/connections/history-points-partial.test.ts  (PB-8d — hardening after PB-8c)
 *
 * PB-8c withheld the AI's CHANGE figures across the balance-history floor, but
 * `get_net_worth_history` still returned the raw POINTS before it (only a
 * section-level note), so a model could subtract two points across the floor
 * itself. Now structural: before the floor of the accounts a metric is composed
 * from, that metric is null on the point and the point says `partial: true`
 * (+ `partialMetrics`); the date stays. A reconstructed day holding a debt at
 * today's balance keeps its values, flagged `estimated: true`. The same rule
 * applies to `find_in_balance_history` (those days are not searched).
 *
 * Exact PB-8b Preview shape (synthetic, no customer data): 12 debts, 10 floored
 * at 2026-11-02 (4 held flat), cash covered since 2026-01-05, comparison day
 * 2026-06-17. Both tools are RUN end-to-end against a fake read client.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/connections/history-points-partial.test.ts
 */

import assert from "node:assert/strict";
import { getNetWorthHistory, findInBalanceHistory, maskBalancePoint, partialMetricsOn, type BalanceHistoryPoint } from "@/lib/ai/conversation/tools/history";
import type { ToolContext } from "@/lib/ai/conversation/tools/types";
import type { BalanceCoverage } from "./balance-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

const FLOOR = "2026-11-02";
const TODAY = "2026-11-03";
const COV: BalanceCoverage = {
  liabilityFloors: ["2026-01-05", "2026-02-10", ...Array<string>(10).fill(FLOOR)],
  assetFloors: ["2026-01-05"],
  estimatedLiabilityFloors: Array<string>(4).fill(FLOOR),
};
const CASH = 20_000;
const PRE_DEBT = 12_376.80;
const POST_DEBT = PRE_DEBT + 316_074.35;
const DAYS = [
  { date: "2026-06-17", debt: PRE_DEBT,        est: true },
  { date: "2026-08-17", debt: 12_100.00,       est: true },
  { date: "2026-10-03", debt: 11_900.00,       est: true },
  { date: "2026-11-01", debt: 11_650.00,       est: true },
  { date: FLOOR,        debt: POST_DEBT - 210, est: true },
  { date: TODAY,        debt: POST_DEBT,       est: false },
];
const rawRows = DAYS.map((d) => ({
  date: new Date(`${d.date}T00:00:00.000Z`), reportingCurrency: "USD", stocks: 0, crypto: 0, total: 0,
  cash: CASH, savings: 0, debt: d.debt, netWorth: CASH - d.debt, totalAssets: CASH, netLiquid: CASH - d.debt,
  cashOnHand: CASH, isEstimated: d.est, cryptoValuationStatus: null, completenessTier: null,
  contributingComponentCount: null, totalComponentCount: null,
}));
const fakeClient = new Proxy({
  spaceSnapshot: { findMany: async () => rawRows },
  space: { findUnique: async () => ({ reportingCurrency: "USD", type: "PERSONAL" }) },
  spaceAccountLink: { findMany: async () => [] },
} as Record<string, unknown>, { get: (t, k: string) => t[k] ?? new Proxy({}, { get: () => async () => [] }) });
const ctx = (cov: BalanceCoverage | null): ToolContext => ({
  spaceId: "space_A", asOfISO: TODAY, readClient: fakeClient as never, memoryClient: fakeClient as never,
  spaceCtx: { userId: "u", spaceId: "space_A", role: "OWNER", space: { id: "space_A", reportingCurrency: "USD" } } as never,
  balanceCoverage: () => Promise.resolve(cov),
} as ToolContext);

type SeriesOut = { series: BalanceHistoryPoint[]; first: BalanceHistoryPoint; last: BalanceHistoryPoint;
  coverage: Record<string, unknown>; change: Record<string, unknown> | null };

async function main() {
  // ── §1 the pure rule ───────────────────────────────────────────────────────
  assert.deepEqual(partialMetricsOn(COV, "2026-06-17"), ["netWorth", "debt"], "only debt-composed metrics are before their floor");
  assert.deepEqual(partialMetricsOn(COV, FLOOR), []);
  assert.deepEqual(partialMetricsOn(null, "2026-06-17"), [], "no coverage ⇒ nothing masked");
  const p: BalanceHistoryPoint = { date: "2026-06-17", netWorth: 1, totalAssets: 2, liquid: 3, checking: 3, investments: 0, digitalAssets: 0, debt: 4 };
  assert.deepEqual(maskBalancePoint(p, COV, true), { ...p, netWorth: null, debt: null, partial: true, partialMetrics: ["netWorth", "debt"] });
  assert.equal(maskBalancePoint(p, null, true), p);
  ok("§1 the pure rule: before the floor ⇒ debt-composed metrics null + partial; cash untouched; no coverage ⇒ identical");

  // ── §2 get_net_worth_history, end to end ───────────────────────────────────
  const run = async (cov: BalanceCoverage | null) =>
    (await getNetWorthHistory.run({ from: "2026-06-17", to: TODAY, granularity: "daily" }, ctx(cov))) as SeriesOut;
  const before = await run(null);
  const after = await run(COV);
  assert.equal(before.series.length, DAYS.length);
  assert.ok(before.series.every((q) => typeof q.debt === "number" && !q.partial), "pre-fix: every point carries a debt number");

  for (const q of after.series) {
    if (q.date < FLOOR) {
      assert.equal(q.debt, null, `${q.date}: debt not knowable`);
      assert.equal(q.netWorth, null, `${q.date}: net worth not knowable`);
      assert.equal(q.partial, true);
      assert.deepEqual(q.partialMetrics, ["netWorth", "debt"]);
      assert.equal(q.liquid, CASH, "cash is covered — its value stays");
      assert.ok(typeof q.date === "string", "the date stays");
    }
  }
  const b = new Map(before.series.map((q) => [q.date, q]));
  assert.deepEqual(after.series.find((q) => q.date === TODAY), b.get(TODAY), "the live day is unchanged");
  const onFloor = after.series.find((q) => q.date === FLOOR)!;
  assert.deepEqual(onFloor, { ...b.get(FLOOR)!, estimated: true }, "the reconstructed floor day: values kept, flagged estimated");
  assert.ok(!onFloor.partial);
  assert.equal(after.first.debt, null, "first (Jun 17) withheld too");
  assert.equal(after.last.debt, POST_DEBT);
  assert.equal(after.coverage.pointsPartial, 4);
  assert.ok(/NOT KNOWABLE/.test(String(after.coverage.partialPointsNote)));
  assert.deepEqual(await run({ liabilityFloors: ["2026-01-05"], assetFloors: ["2026-01-05"], estimatedLiabilityFloors: [] }), before,
    "complete coverage ⇒ byte-identical output");

  // A naive cross-floor subtraction is impossible: one side is always null.
  const debts = after.series.map((q) => q.debt);
  const naive: number[] = [];
  for (let i = 0; i < after.series.length; i++) for (let j = i + 1; j < after.series.length; j++) {
    const [x, y] = [after.series[i], after.series[j]];
    if (x.date < FLOOR && y.date >= FLOOR && typeof x.debt === "number" && typeof y.debt === "number") naive.push(y.debt - x.debt);
  }
  assert.deepEqual(naive, [], "no pre-floor/post-floor pair has two debt numbers");
  assert.ok(!JSON.stringify(after.series).includes(String(PRE_DEBT)), "the pre-floor debt figure is gone from the series");
  assert.ok(debts.filter((d) => d !== null).length === 2);
  assert.ok(after.change && !("debt" in after.change) && "unavailable" in after.change, "the change block still withholds (PB-8c)");
  assert.ok(/partial: true/.test(getNetWorthHistory.description) && /NOT KNOWABLE/.test(getNetWorthHistory.description), "description says what partial means");
  ok("§2 get_net_worth_history: no pre-floor point carries a debt/net-worth number, post-floor unchanged, estimated flagged, naive subtraction impossible");

  // ── §3 find_in_balance_history ─────────────────────────────────────────────
  type FindOut = { result: { date: string; value: number; estimated?: true; previousObservation?: { date: string; estimated?: true } } | null; coverage: Record<string, unknown> };
  const find = async (args: Record<string, unknown>, cov: BalanceCoverage | null) =>
    (await findInBalanceHistory.run(args, ctx(cov))) as FindOut;
  const minBefore = await find({ metric: "debt", operation: "minimum" }, null);
  assert.equal(minBefore.result?.date, "2026-11-01", "pre-fix: the 'lowest debt' is a day missing 10 debts");
  const min = await find({ metric: "debt", operation: "minimum" }, COV);
  assert.equal(min.result?.date, FLOOR, "only knowable days are searched");
  assert.equal(min.result?.estimated, true, "the matched held-flat day is flagged estimated");
  assert.equal(min.coverage.observationsPartial, 4);
  assert.equal(min.coverage.observationsUnassertable, 0, "partial is not counted as unassertable");
  assert.ok(/NOT KNOWABLE/.test(String(min.coverage.partialNote)));
  const max = await find({ metric: "debt", operation: "maximum" }, COV);
  assert.equal(max.result?.date, TODAY);
  assert.equal(max.result?.estimated, undefined, "the live day is not estimated");
  assert.equal(max.result?.previousObservation?.date, FLOOR);
  assert.equal(max.result?.previousObservation?.estimated, true);
  const below = await find({ metric: "debt", operation: "first_below", threshold: 20_000 }, COV);
  assert.equal(below.result, null, "no knowable day has debt below 20k — never a pre-floor day");
  const liquid = await find({ metric: "liquid", operation: "minimum" }, COV);
  assert.equal(liquid.coverage.observationsPartial, undefined, "a covered metric is searched in full");
  assert.deepEqual(await find({ metric: "liquid", operation: "minimum" }, null), liquid);
  assert.ok(/NOT KNOWABLE/.test(findInBalanceHistory.description));
  ok("§3 find_in_balance_history: pre-floor days not searched (counted apart), estimated flagged, covered metrics unchanged");
}

main().then(() => {
  for (const c of checks) console.log("  ✓ " + c);
  console.log(`history-points-partial: ${checks.length} checks passed`);
}).catch((e) => { console.error(e); process.exit(1); });
