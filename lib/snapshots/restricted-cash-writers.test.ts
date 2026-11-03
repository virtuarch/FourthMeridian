/**
 * lib/snapshots/restricted-cash-writers.test.ts   (FIN-E part 2 — FIN-005)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/snapshots/restricted-cash-writers.test.ts
 *
 * SpaceSnapshot.restrictedCash — the restricted share (HSA, retirement cash) of a
 * day's cash + savings. Pinned here:
 *   1. ALL THREE writers set it from classifyAccounts(...).totalRestrictedCash
 *      (regenerate = today, regenerate-history, backfill), through ONE helper.
 *   2. The readers choose UNRESTRICTED only when EVERY row in the window recorded
 *      it; one unrecorded row keeps the window ALL_CASH (the null fallback).
 *   3. The AI section and the Brief follow the same basis.
 *   4. The DSAR export carries it (empty = not recorded, never 0).
 * Synthetic fixtures only. No DB.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Snapshot } from "@/types";
import type { AccountsSectionData } from "@/lib/ai/types";
import { classifyAccounts } from "@/lib/account-classifier";
import { snapshotRestrictedCash } from "./backfill-core";
import { regenerateDay, restrictedCashWriteData, type DayRegenInput } from "./regenerate-history.core";
import { convertStampedValues } from "./stamp-conversion";
import {
  ALL_CASH_HISTORY_AI_NOTE, UNRESTRICTED_HISTORY_AI_NOTE, CASH_HISTORY_BASIS_PRESENTATION,
  cashHistoryBasisOf, clipCashHistory,
} from "@/lib/liquidity/cash-history";
import { convertWealthSnapshots } from "@/lib/wealth/display-conversion";
import { projectSnapshotSection } from "@/lib/ai/assemblers/snapshot";
import { projectBriefPackage, type BriefInputs } from "@/lib/ai/brief/package";
import { toSnapshotsCsv } from "@/lib/export/csv";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

// ── §1 the writers ───────────────────────────────────────────────────────────
{
  // The helper: the classifier's own split, never an invented 0.
  const c = classifyAccounts([
    { type: "checking", balance: 1_000, currency: "USD" },
    { type: "checking", balance: 400, currency: "USD", providerSubtype: "hsa" },
    { type: "savings", balance: 250, currency: "USD" },
  ]);
  assert.equal(c.totalRestrictedCash, 400, "fixture: the HSA checking is restricted");
  assert.equal(snapshotRestrictedCash(c), 400, "helper = classifyAccounts.totalRestrictedCash");
  assert.equal(snapshotRestrictedCash({}), null, "no split on the totals ⇒ NULL (not recorded), never 0");
  assert.equal(snapshotRestrictedCash({ totalRestrictedCash: 0 }), 0, "a measured zero stays 0");

  // Writer 1 — today's live row (regenerate.ts): both create and update, from the same `c`.
  const live = src("./regenerate.ts");
  assert.ok(/const restrictedCash = snapshotRestrictedCash\(c\);/.test(live), "regenerate: from the SAME classification `c`");
  assert.equal((live.match(/reportingCurrency, restrictedCash,/g) ?? []).length, 2, "regenerate: create AND update carry it");

  // Writer 2 — backfill.ts: every reconstructed day, from that day's `c`.
  const bf = src("./backfill.ts");
  assert.ok(/const c = classifyAccounts\(dayAccounts, ctx, dISO\);/.test(bf) && /restrictedCash: snapshotRestrictedCash\(c\),/.test(bf),
    "backfill: each day's row from that day's classification");

  // Writer 3 — regenerate-history: base carries the split; full writes always set it; patches only when recomputed.
  const rh = src("./regenerate-history.ts");
  assert.ok(/totalRestrictedCash: c\.totalRestrictedCash,/.test(rh), "regenerate-history: the day's classification feeds the base");
  // S2 review — re-pinned: the full write and the patch BOTH go through the one
  // fragment, which omits the key when the cash was preserved (see §6).
  assert.ok(/\.\.\.restrictedCashWriteData\(w\),/.test(rh), "regenerate-history: every full write goes through restrictedCashWriteData");
  assert.ok(/\.\.\.restrictedCashWriteData\(p\),/.test(rh), "regenerate-history: a partial patch too");
  const core = src("./regenerate-history.core.ts");
  assert.ok(/\.\.\.\(refusedBy\.has\("cash"\) \|\| refusedBy\.has\("savings"\) \? \{\} : \{ restrictedCash: snapshotRestrictedCash\(base\) \}\),/.test(core),
    "regenerate-history core: preserved cash ⇒ the key is ABSENT (never NULL over a recorded value)");

  // …and behaviourally, through the pure day rule.
  const day = (over: Partial<DayRegenInput> = {}): DayRegenInput => ({
    date: "2026-02-01", existingIsEstimated: true, existing: null,
    base: { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 1_400, totalSavings: 250, totalLiabilities: 0, totalRealAssets: 0, totalRestrictedCash: 400 },
    investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
    digitalAssetValue: 0, digitalAssetTier: "estimated", hasDigitalAssetEvidence: false,
    cashCardTier: "derived",
    ...over,
  } as DayRegenInput);
  const w = regenerateDay(day());
  assert.ok(w.action === "write" && w.restrictedCash === 400, `regenerateDay writes the day's restricted share (${w.action}, ${w.restrictedCash})`);
  const noSplit = regenerateDay(day({ base: { ...day().base, totalRestrictedCash: undefined } }));
  assert.equal(noSplit.restrictedCash, null, "no split ⇒ NULL");
  const frozen = regenerateDay(day({ existingIsEstimated: false }));
  assert.equal(frozen.restrictedCash, undefined, "a frozen (observed) row is skipped — nothing written");

  // Every writer goes through the ONE helper: no direct totalRestrictedCash read at a write site.
  for (const [name, s] of [["regenerate", live], ["backfill", bf]] as const) {
    assert.ok(!/restrictedCash:\s*c\.totalRestrictedCash/.test(s), `${name}: no per-site re-derivation`);
  }
  ok("§1 all three writers set restrictedCash from classifyAccounts.totalRestrictedCash via snapshotRestrictedCash");
}

// ── §2 readers choose the series ─────────────────────────────────────────────
const snap = (date: string, restrictedCash?: number): Snapshot => ({
  date, isEstimated: true, totalCash: 5_000, totalSavings: 1_000, totalInvestments: 0, totalCrypto: 0, totalDebt: 200,
  totalAssets: 6_000, netWorth: 5_800, netLiquid: 5_800, cashOnHand: 5_000,
  ...(restrictedCash !== undefined ? { restrictedCash } : {}),
} as Snapshot);
const DAYS = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 1, 20 + i)).toISOString().slice(0, 10));
const TODAY = DAYS.at(-1)!;
const ALL_RECORDED = DAYS.map((d) => snap(d, 1_500));
const ONE_MISSING = DAYS.map((d, i) => snap(d, i === 0 ? undefined : 1_500));
{
  assert.equal(cashHistoryBasisOf(ALL_RECORDED), "UNRESTRICTED");
  assert.equal(cashHistoryBasisOf(ONE_MISSING), "ALL_CASH", "one unrecorded row ⇒ the whole window stays ALL_CASH");
  assert.equal(cashHistoryBasisOf([]), "ALL_CASH", "nothing proven ⇒ ALL_CASH");

  const u = clipCashHistory(ALL_RECORDED, TODAY, null, "USD")!;
  assert.equal(u.basis, "UNRESTRICTED");
  assert.ok(u.points.every((p) => p.cashNow === 4_500), "UNRESTRICTED = cash + savings − restrictedCash");
  const a = clipCashHistory(ONE_MISSING, TODAY, null, "USD")!;
  assert.equal(a.basis, "ALL_CASH");
  assert.ok(a.points.every((p) => p.cashNow === 6_000), "ALL_CASH fallback: never stitched point by point");
  // Windowing: a window that EXCLUDES the unrecorded day is UNRESTRICTED.
  assert.equal(clipCashHistory(ONE_MISSING, TODAY, DAYS[1], "USD")!.basis, "UNRESTRICTED", "the decision is per WINDOW");
  assert.ok(!/accessible/i.test(CASH_HISTORY_BASIS_PRESENTATION.UNRESTRICTED.label), "label never borrows the hero's wording");

  // Display conversion carries it at the row's rate; an unrecorded row stays unrecorded.
  const ctx = { target: "EUR", resolve: (_f: string, d: string) => ({ kind: "rate", rate: 0.5, requestedDateISO: d, effectiveDates: { from: d, to: d }, staleness: "exact" }) } as never;
  const conv = convertWealthSnapshots([snap(DAYS[0], 1_500), snap(DAYS[1])], "USD", ctx);
  assert.equal(conv[0].restrictedCash, 750, "converted with the row");
  assert.ok(!("restrictedCash" in conv[1]), "absent stays absent (never a converted 0)");

  // The hero's cross-basis deferral applies only to an ALL_CASH series.
  const ws = src("../../components/space/widgets/liquidity/LiquidityWorkspace.tsx");
  assert.ok(/const allCashDeltaMismatch = \(cashHistory\?\.basis \?\? "ALL_CASH"\) === "ALL_CASH"/.test(ws), "deferral keyed on the series basis");
  ok("§2 readers: UNRESTRICTED only when every in-window row recorded it; ALL_CASH fallback otherwise");
}

// ── §3 the AI follows the same basis ─────────────────────────────────────────
{
  const u = projectSnapshotSection(ALL_RECORDED, "full")!;
  assert.equal(u.liquidBasis, "UNRESTRICTED");
  assert.equal(u.liquidBasisNote, UNRESTRICTED_HISTORY_AI_NOTE);
  assert.equal(u.latest!.liquid, 4_500, "AI liquid = cash + savings − restrictedCash");
  assert.equal(u.latest!.netLiquid, 5_800 - 1_500, "netLiquid on the same basis");
  const a = projectSnapshotSection(ONE_MISSING, "full")!;
  assert.equal(a.liquidBasis, "ALL_CASH");
  assert.equal(a.liquidBasisNote, ALL_CASH_HISTORY_AI_NOTE);
  assert.equal(a.latest!.liquid, 6_000, "fallback: all cash, labelled so");

  const acc = { totalLiquid: 4_500, totalRestrictedCash: 1_500, totalLiabilities: 200, netWorth: 5_800, totalInvestments: 0,
    totalDigitalAssets: 0, redactedCount: 0, totalsUnconverted: false, accounts: [],
    counts: { liquid: 2, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: 1 } } as unknown as AccountsSectionData;
  const brief = (rows: Snapshot[]) => projectBriefPackage({
    asOf: TODAY, today: TODAY, now: new Date(`${TODAY}T12:00:00.000Z`), currency: "USD", accounts: acc, transactions: null,
    snapshot: projectSnapshotSection(rows, "full"), holdings: null, assessment: null, memories: [], recentActivity: null,
  } as BriefInputs).recentChanges;
  const rcU = brief(ALL_RECORDED.map((s, i) => ({ ...s, totalCash: s.totalCash + i * 10 })));
  assert.ok(rcU.w1?.liquid && rcU.w1.unavailable?.liquid === undefined, "UNRESTRICTED history ⇒ the liquid change is stated (same basis)");
  const rcA = brief(ONE_MISSING.map((s, i) => ({ ...s, totalCash: s.totalCash + i * 10 })));
  assert.ok(rcA.w1 && rcA.w1.liquid === undefined && typeof rcA.w1.unavailable?.liquid === "string", "ALL_CASH history ⇒ still withheld");
  ok("§3 AI section + Brief follow the window's basis");
}

// ── §4 the DSAR export carries it ────────────────────────────────────────────
{
  const rows = [
    { ...snap("2026-02-20", 1_500), spaceId: "space-x", spaceName: "Synthetic" },
    { ...snap("2026-02-21"), spaceId: "space-x", spaceName: "Synthetic" },
  ];
  const csv = toSnapshotsCsv(rows as never).split(/\r?\n/);
  const header = csv[0].split(",");
  const i = header.indexOf("restricted_cash");
  assert.ok(i >= 0, "snapshots.csv has a restricted_cash column");
  assert.equal(csv[1].split(",")[i], "1500", "recorded value exported");
  assert.equal(csv[2].split(",")[i], "", "unrecorded ⇒ empty, never 0");
  const read = src("../data/snapshots.ts");
  assert.ok(/\.\.\.\(typeof r\.restrictedCash === "number" \? \{ restrictedCash: r\.restrictedCash as number \} : \{\}\)/.test(read),
    "the canonical read (which the export uses) carries the stored column when recorded");
  ok("§4 export: restricted_cash in snapshots.csv; empty when not recorded");
}

// ── §5 the migration ─────────────────────────────────────────────────────────
{
  const sql = readFileSync(new URL("../../prisma/migrations/20261103160000_fin_e_restricted_cash/migration.sql", import.meta.url), "utf8");
  const stmts = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(stmts, ['ALTER TABLE "SpaceSnapshot" ADD COLUMN "restrictedCash" DOUBLE PRECISION'], "one additive, nullable, no-default column");
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
  assert.ok(/^\s+restrictedCash Float\?$/m.test(schema), "schema: Float? (nullable, no default)");
  ok("§5 migration: one nullable catalog-only column");
}

// ── §6 S2 review — a PRESERVING write never NULLs a recorded value ───────────
{
  const base = { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 1_400, totalSavings: 250, totalLiabilities: 0, totalRealAssets: 0, totalRestrictedCash: 300 };
  const existing = { stocks: 0, crypto: 0, total: 0, cash: 1_200, savings: 250, debt: 0, netWorth: 1_450, totalAssets: 1_450, netLiquid: 1_450, cashOnHand: 1_200 };
  const input = (over: Partial<DayRegenInput>): DayRegenInput => ({
    date: "2026-02-01", existingIsEstimated: true, existing, base,
    investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
    digitalAssetValue: 0, digitalAssetTier: "estimated", hasDigitalAssetEvidence: false,
    cashCardTier: "derived", ...over,
  } as DayRegenInput);
  // Prisma update semantics: an omitted key leaves the stored column as it is.
  const applyUpdate = <T extends object>(stored: T, data: object): T => ({ ...stored, ...data });

  // (a) cash PRESERVED (an impossible walked balance) ⇒ the key is omitted, the stored 400 survives.
  const preservedCash = regenerateDay(input({ base: { ...base, totalChecking: -5 } }));
  assert.ok(preservedCash.components?.some((c) => c.component === "cash" && c.action === "preserved"), "fixture: cash is preserved");
  assert.ok(!("restrictedCash" in preservedCash), "preserved cash ⇒ restrictedCash UNDEFINED (not this run's)");
  assert.deepEqual(restrictedCashWriteData(preservedCash), {}, "…so the write data carries no restrictedCash key");
  assert.equal(applyUpdate({ restrictedCash: 400 as number | null }, restrictedCashWriteData(preservedCash)).restrictedCash, 400,
    "stored 400 + a write preserving cash ⇒ still 400");
  const preservedSavings = regenerateDay(input({ base: { ...base, totalSavings: Number.NaN } }));
  assert.equal(applyUpdate({ restrictedCash: 400 as number | null }, restrictedCashWriteData(preservedSavings)).restrictedCash, 400,
    "…and the same when savings is the preserved component");
  // (c) a pre-part-2 NULL row that is preserved stays NULL (never a made-up number).
  assert.equal(applyUpdate({ restrictedCash: null as number | null }, restrictedCashWriteData(preservedCash)).restrictedCash, null,
    "pre-part-2 null + preserving write ⇒ still null");

  // (b) cash RECOMPUTED ⇒ the new value is written over the stored one.
  const recomputed = regenerateDay(input({}));
  assert.equal(recomputed.restrictedCash, 300);
  assert.equal(applyUpdate({ restrictedCash: 400 as number | null }, restrictedCashWriteData(recomputed)).restrictedCash, 300,
    "recomputed cash ⇒ the new restricted share replaces the stored one");
  // Recomputed but no split on the totals ⇒ an explicit NULL (the stored share describes cash this run replaced).
  const noSplit = regenerateDay(input({ base: { ...base, totalRestrictedCash: undefined } }));
  assert.deepEqual(restrictedCashWriteData(noSplit), { restrictedCash: null });

  // Both persistence sites go through the one fragment; no other restrictedCash key is written there.
  const rh = src("./regenerate-history.ts");
  assert.equal((rh.match(/\.\.\.restrictedCashWriteData\((w|p)\),/g) ?? []).length, 2, "full write AND patch use restrictedCashWriteData");
  assert.ok(!/restrictedCash: w\.restrictedCash|restrictedCash: p\.restrictedCash|restrictedCash: res\.restrictedCash \?\? null/.test(rh),
    "no direct (NULL-capable) restrictedCash assignment at a write site");
  ok("§6 preserving writes leave restrictedCash untouched (recorded 400 or pre-part-2 null); recomputed writes replace it");
}

// ── §7 FX — restrictedCash converts with the SAME rate and date as the row's cash ──
{
  const seen: string[] = [];
  const RATE = 0.8;
  const ctx = {
    target: "USD",
    resolve: (from: string, d: string) => { seen.push(`${from}@${d}`); return { kind: "rate", rate: RATE, requestedDateISO: d, effectiveDates: { from: d, to: d }, staleness: "exact" }; },
  } as never;
  // A non-USD (EUR-stamped) stored row, through the canonical read's stamp conversion.
  const raw = { totalCash: 2_000, totalSavings: 500, restrictedCash: 750, netWorth: 2_500 };
  const out = convertStampedValues(raw, "EUR", "2026-02-10", ctx);
  const factor = (k: keyof typeof raw) => out.values[k] / raw[k];
  assert.ok(Math.abs(factor("restrictedCash") - factor("totalCash")) < 1e-12 && Math.abs(factor("restrictedCash") - factor("totalSavings")) < 1e-12,
    "stamp conversion: restrictedCash takes the identical factor as cash and savings");
  assert.ok(seen.every((x) => x === "EUR@2026-02-10"), "…at the row's own date and currency, for every field");
  assert.ok(out.values.restrictedCash <= out.values.totalCash + out.values.totalSavings, "invariant after stamp conversion: restricted ≤ cash + savings");

  // …and through the display conversion (Wealth/Liquidity), on a non-USD target.
  const disp = { target: "GBP", resolve: (_f: string, d: string) => ({ kind: "rate", rate: 0.79, requestedDateISO: d, effectiveDates: { from: d, to: d }, staleness: "exact" }) } as never;
  const rows = [snap("2026-02-20", 1_500), snap("2026-02-21", 6_000)];
  for (const r of convertWealthSnapshots(rows, "USD", disp)) {
    const src0 = rows.find((x) => x.date === r.date)!;
    assert.ok(Math.abs(r.restrictedCash! / src0.restrictedCash! - r.totalCash / src0.totalCash) < 1e-12, `display: identical factor (${r.date})`);
    assert.ok(r.restrictedCash! <= r.totalCash + r.totalSavings + 1e-9, `display invariant: restricted ≤ cash + savings (${r.date})`);
  }
  // The unrestricted series built from converted rows is never negative.
  const u = clipCashHistory(convertWealthSnapshots(rows, "USD", disp), "2026-02-21", null, "GBP")!;
  assert.ok(u.basis === "UNRESTRICTED" && u.points.every((p) => p.cashNow >= 0), "converted UNRESTRICTED series ≥ 0");
  ok("§7 FX: restrictedCash converts at the row's own rate/date, identical factor; restricted ≤ cash + savings after conversion");
}

for (const c of checks) console.log(`  ✓ ${c}`);
console.log(`restricted-cash-writers (FIN-E part 2): ${checks.length} checks passed`);
