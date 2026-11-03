/**
 * lib/connections/history-coverage-fail-closed.test.ts  (S2 sweep — the AI history tools fail CLOSED)
 *
 * When the balance-history coverage read FAILED, `get_net_worth_history` and
 * `find_in_balance_history` used to receive null — the same value as "nothing to
 * cover" — so PB-8c/8d masking switched off and pre-floor debt and net-worth
 * points reached the model as facts, with a cross-floor `change`. A failed read
 * is now BALANCE_COVERAGE_UNAVAILABLE:
 *
 *   series tool   points kept but explicitly unvouched; `change` withheld (every
 *                 metric, no %); `coverage` carries the note
 *   find tool     the answer withheld (`result: null`,
 *                 BALANCE_HISTORY_COMPLETENESS_UNREADABLE) with the note
 *
 * for a throwing provider, a throwing no-phase loader, and a phase with no
 * provider. The normal paths (coverage read, nothing to cover) are byte-identical
 * to the same calls before this change. Synthetic data; both tools RUN end to end.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/connections/history-coverage-fail-closed.test.ts
 */

import assert from "node:assert/strict";
import { getNetWorthHistory, findInBalanceHistory, type BalanceHistoryPoint } from "@/lib/ai/conversation/tools/history";
import type { ToolContext } from "@/lib/ai/conversation/tools/types";
import { readBalanceCoverage } from "@/lib/ai/conversation/evidence";
import {
  BALANCE_COVERAGE_UNAVAILABLE, BALANCE_COVERAGE_UNREADABLE_NOTE, type BalanceCoverage, type BalanceCoverageRead,
} from "./balance-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

const FLOOR = "2026-11-02";
const TODAY = "2026-11-03";
const COV: BalanceCoverage = {
  liabilityFloors: ["2026-01-05", ...Array<string>(3).fill(FLOOR)],
  assetFloors: ["2026-01-05"],
  estimatedLiabilityFloors: [],
};
const CASH = 20_000;
const PRE_DEBT = 1_234.5;
const POST_DEBT = PRE_DEBT + 98_765.25;
const DAYS = [
  { date: "2026-06-17", debt: PRE_DEBT,   est: true },
  { date: "2026-10-03", debt: 1_100,      est: true },
  { date: FLOOR,        debt: POST_DEBT,  est: true },
  { date: TODAY,        debt: POST_DEBT,  est: false },
];
const rawRows = DAYS.map((d) => ({
  date: new Date(`${d.date}T00:00:00.000Z`), reportingCurrency: "USD", stocks: 0, crypto: 0, total: 0,
  cash: CASH, savings: 0, debt: d.debt, netWorth: CASH - d.debt, totalAssets: CASH, netLiquid: CASH - d.debt,
  cashOnHand: CASH, isEstimated: d.est, cryptoValuationStatus: null, completenessTier: null,
  contributingComponentCount: null, totalComponentCount: null,
}));
const client = (coverageThrows: boolean) => new Proxy({
  spaceSnapshot: { findMany: async () => rawRows },
  space: { findUnique: async () => ({ reportingCurrency: "USD", type: "PERSONAL" }) },
  // Only the COVERAGE loader asks for `visibilityLevel` (the balance-disclosure grant); it alone throws.
  spaceAccountLink: {
    findMany: async (q: { select?: Record<string, unknown> }) => {
      if (coverageThrows && q?.select && "visibilityLevel" in q.select) throw new Error("boom space_A acct_secret");
      return [];
    },
  },
} as Record<string, unknown>, { get: (t, k: string) => t[k] ?? new Proxy({}, { get: () => async () => [] }) });

type Provider = "value" | "throwing-provider" | "no-phase-throwing-loader" | "phase-without-provider";
const ctx = (mode: Provider, cov: BalanceCoverageRead = null): ToolContext => {
  const c = client(mode === "no-phase-throwing-loader");
  const base = {
    spaceId: "space_A", asOfISO: TODAY, readClient: c as never, memoryClient: c as never,
    spaceCtx: { userId: "u", spaceId: "space_A", role: "OWNER", space: { id: "space_A", reportingCurrency: "USD" } } as never,
  };
  if (mode === "value") return { ...base, balanceCoverage: () => Promise.resolve(cov) } as ToolContext;
  if (mode === "throwing-provider") {
    // The engine's provider is readBalanceCoverage over a phase that throws — exactly production.
    const failing = readBalanceCoverage((() => Promise.reject(new Error("boom"))) as never, "space_A");
    return { ...base, balanceCoverage: () => failing } as ToolContext;
  }
  if (mode === "phase-without-provider") return { ...base, phase: (async () => { throw new Error("no"); }) as never } as ToolContext;
  return base as ToolContext;
};

type SeriesOut = { series: BalanceHistoryPoint[]; first: BalanceHistoryPoint; last: BalanceHistoryPoint;
  coverage: Record<string, unknown>; change: Record<string, unknown> | null };
const series = async (c: ToolContext) =>
  (await getNetWorthHistory.run({ from: "2026-06-17", to: TODAY, granularity: "daily" }, c)) as SeriesOut;
const find = async (c: ToolContext) =>
  (await findInBalanceHistory.run({ metric: "debt", operation: "minimum" }, c)) as Record<string, unknown> & { coverage: Record<string, unknown> };

async function main() {
  const warn = console.warn; const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    // ── §1 the series tool ──────────────────────────────────────────────────
    const none = await series(ctx("value", null));        // nothing to cover — the old fail-open shape
    const covered = await series(ctx("value", COV));
    for (const mode of ["throwing-provider", "no-phase-throwing-loader", "phase-without-provider", "value"] as const) {
      const out = await series(mode === "value" ? ctx("value", BALANCE_COVERAGE_UNAVAILABLE) : ctx(mode));
      const ch = out.change as { unavailable?: Record<string, string>; unavailableMeaning?: string } | null;
      assert.ok(ch && ch.unavailable, `${mode}: a change block that withholds`);
      for (const m of ["netWorth", "liquid", "checking", "debt"]) {
        assert.ok(!(m in ch!), `${mode}: ${m} change withheld`);
        assert.ok(typeof ch!.unavailable![m] === "string", `${mode}: ${m} carries its reason`);
      }
      for (const m of ["netWorth", "liquid", "checking", "debt"]) assert.ok(!JSON.stringify(ch).includes(`"${m}":{`), `${mode}: no ${m} figure or % in the change`);
      // Scoping (S2): investments / digitalAssets have no balance sides — coverage never governed them,
      // so an outage leaves their change MEASURED.
      const inv = (ch as Record<string, unknown>).investments as { abs?: number } | undefined;
      assert.ok(inv && typeof inv.abs === "number" && !("investments" in (ch!.unavailable ?? {})), `${mode}: the investments change stays measured`);
      assert.ok(ch!.unavailableMeaning!.includes(BALANCE_COVERAGE_UNREADABLE_NOTE), `${mode}: the meaning carries the note`);
      assert.equal(out.coverage.balanceHistoryCompleteness, "UNAVAILABLE", `${mode}: completeness UNAVAILABLE`);
      assert.equal(out.coverage.balanceHistoryNote, BALANCE_COVERAGE_UNREADABLE_NOTE, `${mode}: the owner's note, verbatim`);
      assert.equal(out.coverage.pointsUnvouched, true, `${mode}: points explicitly unvouched`);
      assert.deepEqual(out.series, none.series, `${mode}: points stay as they are (not masked, not invented)`);
    }
    ok("§1 get_net_worth_history: a failed coverage read ⇒ change withheld (no %), the note, points unvouched — every failure path");

    // ── §2 the find tool ────────────────────────────────────────────────────
    const findNone = await find(ctx("value", null));
    const unguarded = findNone.result as { value: number; date: string };
    assert.ok(unguarded.value === 1_100 && unguarded.date < FLOOR, "fixture: unguarded, the minimum is a PRE-floor debt (the hazard)");
    for (const mode of ["throwing-provider", "no-phase-throwing-loader", "phase-without-provider"] as const) {
      const out = await find(ctx(mode));
      assert.equal(out.result, null, `${mode}: no answer is stated`);
      assert.equal(out.unavailable, "BALANCE_HISTORY_COMPLETENESS_UNREADABLE", `${mode}: the reason`);
      assert.equal(out.coverage.balanceHistoryNote, BALANCE_COVERAGE_UNREADABLE_NOTE, `${mode}: the note`);
      assert.ok(![PRE_DEBT, 1_100].some((v) => JSON.stringify(out.result ?? null).includes(String(v))) && !("match" in out), `${mode}: no pre-floor value is stated as the answer`);
    }
    // Scoping (S2): a metric coverage does not govern still answers under UNAVAILABLE.
    for (const mode of ["throwing-provider", "no-phase-throwing-loader", "phase-without-provider"] as const) {
      const out = (await findInBalanceHistory.run({ metric: "digitalAssets", operation: "maximum" }, ctx(mode))) as Record<string, unknown> & { coverage: Record<string, unknown> };
      assert.ok(out.result !== null && out.unavailable === undefined && !("balanceHistoryNote" in out.coverage), `${mode}: find(digitalAssets, maximum) still answers`);
      const inv = (await findInBalanceHistory.run({ metric: "investments", operation: "minimum" }, ctx(mode))) as Record<string, unknown>;
      assert.ok(inv.result !== null, `${mode}: find(investments, minimum) still answers`);
    }
    ok("§2 find_in_balance_history: a failed coverage read ⇒ the answer withheld with its reason and the note (governed metrics only)");

    // ── §3 the normal paths are byte-identical ──────────────────────────────
    // "Nothing to cover" and a READ coverage carry no new key, and match the shape the tools always returned.
    for (const [name, out] of [["nothing to cover", none], ["coverage read", covered]] as const) {
      assert.ok(!("balanceHistoryCompleteness" in out.coverage) && !("pointsUnvouched" in out.coverage) && !("balanceHistoryNote" in out.coverage), `${name}: no new key`);
    }
    assert.ok(none.change && "debt" in none.change, "nothing to cover ⇒ the change is measured, exactly as before");
    assert.ok(covered.change && !("debt" in covered.change) && /history is partial before/.test(String((covered.change as { unavailableMeaning?: string }).unavailableMeaning)),
      "coverage read ⇒ the PB-8c withholding, with its own wording (unchanged)");
    const findCovered = await find(ctx("value", COV));
    assert.ok(findCovered.result !== null && !("balanceHistoryNote" in findCovered.coverage), "coverage read ⇒ find answers as before");
    assert.equal(JSON.stringify(await series(ctx("value", null))), JSON.stringify(none), "deterministic");
    ok("§3 the normal paths: nothing-to-cover and a read coverage carry no new key and behave as before");
  } finally { console.warn = warn; }

  // The failure is logged with counts only (no ids, no error text).
  assert.ok(lines.length > 0 && lines.every((l) => /\[balance-coverage\] load failed surface=(ai-history-tool|ai-snapshot)/.test(l) && !/space_A|acct_|boom/.test(l)), JSON.stringify(lines));
  ok("§4 counts-only log lines on each failure");

  for (const c of checks) console.log(`  ✓ ${c}`);
  console.log(`history-coverage-fail-closed: ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
