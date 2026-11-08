/**
 * lib/snapshots/installment-debt-writers.test.ts   (Mortgage F1b — S2 Prod blocker)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/snapshots/installment-debt-writers.test.ts
 *
 * SpaceSnapshot.installmentDebt — the installment debt (mortgage, auto, …) a row's
 * netLiquid EXCLUDED. Pinned here:
 *   1. ALL THREE writers (regenerate = today, regenerate-history, backfill) set it
 *      on every new row through ONE helper, from the SAME classification as netLiquid;
 *      mortgage present ⇒ its balance, absent ⇒ a recorded 0; identity EXACT.
 *   2. regenerate-history: recomputed debt ⇒ written; PRESERVED debt ⇒ untouched
 *      (a legacy NULL row keeps its old basis; a recorded row keeps its share).
 *   3. The AI history payload carries a per-point basis flag.
 *   4. The Liquid NW chart never joins previous-definition points to current ones.
 * Synthetic fixtures only. No DB.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Snapshot } from "@/types";
import { classifyAccounts } from "@/lib/account-classifier";
import { computeSnapshotFields, snapshotInstallmentDebt } from "./backfill-core";
import { regenerateDay, installmentDebtWriteData, type DayRegenInput } from "./regenerate-history.core";
import { netLiquidIdentityViolation, liquidNetWorthRowBasis } from "@/lib/debt/liquid-net-worth";
import { projectSnapshotSection } from "@/lib/ai/assemblers/snapshot";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { projectWealthTrendPoints } from "@/components/space/widgets/wealth/wealth-trend-points";
import { toRuns, toBasisSeams, joinsAcrossSeam, DAY_MS } from "@/components/space/widgets/charts/trend-runs.core";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const CHECKING = { id: "chk", type: "checking", balance: 10_000, currency: "USD" };
const MORTGAGE = { id: "mtg", type: "debt", balance: 300_000, currency: "USD", providerSubtype: "mortgage" };
const CARD     = { id: "card", type: "debt", balance: 5_000, currency: "USD", providerSubtype: "credit card" };

// ── §1 the helper + the three writers ────────────────────────────────────────
{
  const withMtg = classifyAccounts([CHECKING, MORTGAGE, CARD]);
  const f = computeSnapshotFields(withMtg);
  const inst = snapshotInstallmentDebt(withMtg);
  assert.equal(inst, 300_000, "mortgage present ⇒ its balance");
  assert.equal(f.netLiquid, f.cash + f.savings - f.debt + inst, "netLiquid = cash + savings − debt + installmentDebt, exactly");
  assert.equal(netLiquidIdentityViolation({ ...f, installmentDebt: inst }, 0), null, "exact identity at zero tolerance");
  assert.equal(liquidNetWorthRowBasis({ ...f, installmentDebt: inst }), "INSTALLMENTS_EXCLUDED");

  const noMtg = classifyAccounts([CHECKING, CARD]);
  const g = computeSnapshotFields(noMtg);
  assert.equal(snapshotInstallmentDebt(noMtg), 0, "mortgage absent ⇒ a RECORDED 0 (not null)");
  assert.equal(g.netLiquid, g.cash + g.savings - g.debt + 0);
  assert.equal(liquidNetWorthRowBasis({ ...g, installmentDebt: 0 }), "INSTALLMENTS_EXCLUDED", "a recorded 0 is the new basis");
  assert.equal(snapshotInstallmentDebt({ totalLiabilities: 5_000 }), 0, "no kind evidence ⇒ nothing excluded, never invented");

  // Writer 1 — today's live row: create AND update, from the SAME `c` as netLiquid.
  const live = src("./regenerate.ts");
  assert.ok(/const installmentDebt = snapshotInstallmentDebt\(c\);/.test(live), "regenerate: from the SAME classification `c`");
  assert.ok(/\} = computeSnapshotFields\(c\);/.test(live), "regenerate: netLiquid from that `c` too");
  assert.equal((live.match(/reportingCurrency, restrictedCash, installmentDebt,/g) ?? []).length, 2, "regenerate: create AND update carry it");
  // Writer 2 — backfill: every reconstructed day, from that day's `c`.
  const bf = src("./backfill.ts");
  assert.ok(/const fields = computeSnapshotFields\(c\);/.test(bf) && /installmentDebt: snapshotInstallmentDebt\(c\),/.test(bf), "backfill: each day's row");
  // Writer 3 — regenerate-history: full write AND patch through the one fragment; the read selects it.
  const rh = src("./regenerate-history.ts");
  assert.ok(/\.\.\.installmentDebtWriteData\(w\),/.test(rh), "regenerate-history: full write");
  assert.ok(/\.\.\.installmentDebtWriteData\(p\),/.test(rh), "regenerate-history: partial patch");
  assert.equal((rh.match(/installmentDebt: res\.installmentDebt,/g) ?? []).length, 2, "regenerate-history: the day result reaches BOTH the write and the patch");
  assert.ok(/installmentDebt: prior\.installmentDebt,/.test(rh), "regenerate-history: the stored share reaches the day rule");
  assert.equal((rh.match(/installmentDebt: true/g) ?? []).length, 2, "regenerate-history: existing-row read AND the integrity probe select it");
  for (const [name, s] of [["regenerate", live], ["backfill", bf]] as const) {
    assert.ok(!/installmentDebt:\s*c\.totalInstallmentLiabilities/.test(s), `${name}: no per-site re-derivation`);
  }
  ok("§1 all three writers record installmentDebt via snapshotInstallmentDebt (mortgage ⇒ 300k, none ⇒ 0); identity exact");
}

// ── §2 regenerate-history: recomputed vs preserved debt ──────────────────────
{
  const base = { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 10_000, totalSavings: 0,
    totalLiabilities: 305_000, totalInstallmentLiabilities: 300_000, totalRealAssets: 0 };
  const day = (over: Partial<DayRegenInput> = {}): DayRegenInput => ({
    date: "2026-10-01", existingIsEstimated: true, existing: null, base,
    investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
    digitalAssetValue: 0, digitalAssetTier: "estimated", hasDigitalAssetEvidence: false,
    cashCardTier: "derived", membershipChangedSince: false,
    ...over,
  } as DayRegenInput);

  const w = regenerateDay(day());
  assert.equal(w.action, "write");
  assert.equal(w.installmentDebt, 300_000, "recomputed debt ⇒ recorded");
  assert.deepEqual(installmentDebtWriteData(w), { installmentDebt: 300_000 });
  assert.equal(netLiquidIdentityViolation({ ...w.fields!, installmentDebt: w.installmentDebt }, 0.005), null, "exact");

  const none = regenerateDay(day({ base: { ...base, totalLiabilities: 5_000, totalInstallmentLiabilities: 0 } }));
  assert.equal(none.installmentDebt, 0, "no mortgage ⇒ recorded 0");

  // Debt PRESERVED (walked debt unusable) on a LEGACY old-basis row: column untouched, old basis kept.
  const legacy = { stocks: 0, crypto: 0, total: 0, cash: 9_000, savings: 0, debt: 305_000,
    netWorth: -296_000, totalAssets: 9_000, netLiquid: -296_000, cashOnHand: 9_000, installmentDebt: null };
  const pl = regenerateDay(day({ existing: legacy, base: { ...base, totalLiabilities: Number.NaN } }));
  assert.equal(pl.action, "write-partial");
  assert.equal(pl.installmentDebt, undefined, "preserved debt ⇒ key absent (never NULLs/stamps the column)");
  assert.deepEqual(installmentDebtWriteData(pl), {});
  assert.equal(pl.fields!.netLiquid, 10_000 - 305_000, "legacy row keeps the OLD basis (nothing excluded)");
  assert.equal(liquidNetWorthRowBasis({ ...pl.fields!, installmentDebt: null }), "INSTALLMENTS_SUBTRACTED");

  // Debt PRESERVED on a RECORDED row: its own share carries into netLiquid.
  const recorded = { ...legacy, netLiquid: 4_000, installmentDebt: 300_000 };
  const pr = regenerateDay(day({ existing: recorded, base: { ...base, totalLiabilities: Number.NaN } }));
  assert.equal(pr.installmentDebt, undefined, "column untouched");
  assert.equal(pr.fields!.netLiquid, 10_000 - 305_000 + 300_000, "recomputed cash + the row's RECORDED share");
  assert.equal(netLiquidIdentityViolation({ ...pr.fields!, installmentDebt: 300_000 }, 0.005), null, "stays exact against the kept column");

  const frozen = regenerateDay(day({ existingIsEstimated: false }));
  assert.equal(frozen.installmentDebt, undefined, "a frozen observed row is skipped — nothing written");
  ok("§2 regenerate-history: recomputed debt ⇒ recorded; preserved ⇒ untouched (legacy stays old basis, recorded keeps its share)");
}

// ── §3 + §4 AI basis flag; chart segments never mixed ────────────────────────
const mk = (date: string, netLiquid: number, installmentDebt?: number): Snapshot => ({
  date, isEstimated: installmentDebt !== undefined, totalCash: 10_000, totalSavings: 0, totalInvestments: 0, totalCrypto: 0,
  totalDebt: 305_000, totalAssets: 10_000, netWorth: -295_000, netLiquid, cashOnHand: 10_000,
  ...(installmentDebt !== undefined ? { installmentDebt } : {}),
} as Snapshot);
const ROWS = [mk("2026-10-01", -295_000), mk("2026-10-02", -295_000), mk("2026-10-03", 5_000, 300_000), mk("2026-10-04", 5_000, 300_000)];
{
  const sec = projectSnapshotSection(ROWS, "full")!;
  assert.deepEqual(sec.history.map((p) => p.netLiquidBasis),
    ["INSTALLMENTS_SUBTRACTED", "INSTALLMENTS_SUBTRACTED", "INSTALLMENTS_EXCLUDED", "INSTALLMENTS_EXCLUDED"], "per-point basis, from the row");
  assert.equal(sec.latest!.netLiquidBasis, "INSTALLMENTS_EXCLUDED");
  assert.match(sec.netLiquidNote!, /INSTALLMENTS_SUBTRACTED is the previous definition/);
  assert.ok(!/2026-11-08/.test(sec.netLiquidNote!), "the note no longer explains the basis by a date");
  ok("§3 AI history: every point carries netLiquidBasis; the note explains old vs new");
}
{
  const r = computeWealthTimeMachine({ snapshots: ROWS, asOf: "2026-10-04", compareTo: "2026-10-01", currency: "USD" } as never);
  const liq = projectWealthTrendPoints(r, "liquidNetWorth");
  assert.deepEqual(liq.map((p) => p.basis ?? null), ["previousDefinition", "previousDefinition", null, null]);
  assert.ok(projectWealthTrendPoints(r, "netWorth").every((p) => p.basis !== "previousDefinition"), "other series unaffected");
  const geom = liq.map((p) => ({ ...p, t: Date.parse(`${p.date}T00:00:00Z`) }));
  const runs = toRuns(geom, 3);
  assert.equal(runs.length, 2, "two runs");
  assert.ok(runs.every((run) => new Set(run.points.map((p) => p.basis === "previousDefinition")).size === 1), "no run mixes the two definitions");
  const seams = toBasisSeams(geom, 3);
  assert.equal(seams.length, 1);
  assert.equal(joinsAcrossSeam(seams[0]), false, "the chart never joins across the definition change");
  assert.equal(joinsAcrossSeam({ fromBasis: "reconstructed", toBasis: "observed" }), true, "other seams still join (v2.7)");
  const tc = src("../../components/space/widgets/charts/TrendChart.tsx");
  assert.ok(/toBasisSeams\(pts, gapDays\)\.filter\(joinsAcrossSeam\)/.test(tc), "TrendChart filters joins through joinsAcrossSeam");
  assert.ok(/previousDefinition: \{ fill: null,/.test(tc), "a distinct, unfilled style for the previous definition");
  assert.ok(DAY_MS > 0);
  ok("§4 chart: previous-definition points are their own unjoined segment; marker only at the first new-basis point");
}

for (const c of checks) console.log(`  ✓ ${c}`);
console.log(`\ninstallment-debt-writers: ${checks.length} checks passed`);
