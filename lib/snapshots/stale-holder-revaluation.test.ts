/**
 * lib/snapshots/stale-holder-revaluation.test.ts
 *
 * P1 FINANCIAL CORRECTNESS (live on Preview 2026-10-31, QA Space): 31 stored
 * rows 2026-09-27..2026-10-27 were written before the BTC wallet was linked —
 * SOL only (~$76), stamped `supported` — and the holder revaluation rebuilt only
 * the days BEFORE the earliest row, so they were never revisited. 10-27 read
 * $76.04 where the correct value is $26,793.01.
 *
 * Behavioural, against the pure cores the binding runs, end to end:
 *   holderRevaluationFor → revalueHoldersAfterPriceGaps (chunks, markers) →
 *   per day: valueCryptoDay → cryptoTokenDayDecision → cryptoHoldersNotValued →
 *   regenerateDay → planDayPersistence → an in-memory SpaceSnapshot store that
 *   applies write / patch / status-only stamp exactly as the binding does.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/snapshots/stale-holder-revaluation.test.ts
 */

import { readFileSync } from "node:fs";
import { minusDaysISO } from "@/lib/prices/config";
import {
  holderRevaluationFor, revalueHoldersAfterPriceGaps, revaluationOwedFromISO,
  type RevaluationDeps,
} from "@/lib/prices/price-gap";
import { valueCryptoDay, cryptoHoldersNotValued, type CryptoAccountBalance } from "@/lib/crypto/historical-crypto-valuation.core";
import { cryptoTokenDayDecision } from "@/lib/crypto/token-valuation.core";
import { regenerateDay } from "./regenerate-history.core";
import type { SnapshotFields } from "./backfill-core";
import { planDayPersistence, type StoredRowForPersistence } from "./regeneration-candidates.core";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── The live facts (R2, to the cent) ─────────────────────────────────────────
const SOL_QTY = 0.751600602;
const BTC_QTY = 0.33061617;
const TODAY = "2026-10-31";
const FROZEN_DAY = "2026-10-28";        // observed row: never touched
const BTC_UNPRICED_DAY = "2026-10-15";  // a hole in the BTC archive
const solPx = (d: string) => (d === "2026-10-27" ? 101.167853461284 : 100);
const btcPx = (d: string): number | null => (d === BTC_UNPRICED_DAY ? null : d === "2026-10-27" ? 80809.6448049456 : 80000);

type Row = StoredRowForPersistence & SnapshotFields & { date: string };
const store = new Map<string, Row>();
const ops = { writes: 0, patches: 0, stamps: 0 };
const days = (from: string, to: string) => { const o: string[] = []; for (let d = from; d <= to; d = minusDaysISO(d, -1)) o.push(d); return o; };

/** The binding's day, for a Space whose crypto holders are `withBtc ? SOL+BTC : SOL`. */
function rebuild(from: string, to: string, withBtc: boolean): void {
  for (const d of days(from, to)) {
    if (d >= TODAY) continue; // the writable ceiling
    const accounts: CryptoAccountBalance[] = [
      { financialAccountId: "sol", name: "SOL", nativeBalance: SOL_QTY, assetKey: "sol", symbol: "SOL", applicable: true },
      ...(withBtc ? [{ financialAccountId: "btc", name: "BTC", nativeBalance: BTC_QTY, assetKey: "btc", symbol: "BTC", applicable: true }] : []),
    ];
    const unitPriceByAssetKey: Record<string, number | null> = { sol: solPx(d), ...(withBtc ? { btc: btcPx(d) } : {}) };
    const v = valueCryptoDay({ accounts, unitPriceByAssetKey, quantityLicensed: true });
    const tokenDay = cryptoTokenDayDecision({ licensed: v.licensed, positionCount: v.positionCount }, null, d);
    const missing = cryptoHoldersNotValued({ accounts }, v);
    const evidence = tokenDay.tokensJoin; // as the binding: the guard is the day decision's (cryptoHoldersNotValued)
    const flat = SOL_QTY * 101 + (withBtc ? BTC_QTY * 81000 : 0); // today's carried balance
    const prior = store.get(d) ?? null;
    const res = regenerateDay({
      date: d, existingIsEstimated: prior ? prior.isEstimated : null,
      existing: prior,
      base: { totalInvestments: 0, totalDigitalAssets: flat, totalChecking: 0, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
      investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
      digitalAssetValue: evidence ? v.nativeTotal : 0, digitalAssetTier: "estimated", hasDigitalAssetEvidence: evidence,
      digitalAssetHeldUnvalued: tokenDay.heldUnvalued, cryptoHoldersNotValued: missing,
      cashCardTier: "derived", membershipChangedSince: false,
    });
    const plan = planDayPersistence(res, prior);
    if (plan.write && res.fields) {
      ops.writes++;
      store.set(d, { date: d, ...res.fields, isEstimated: res.isEstimated, cryptoValuationStatus: res.cryptoValuationStatus });
    }
    if (plan.patch && prior) {
      ops.patches++;
      store.set(d, { ...prior, ...plan.patch, isEstimated: res.isEstimated, cryptoValuationStatus: res.cryptoValuationStatus });
    }
    if (plan.stamp !== null && prior && prior.isEstimated) {
      ops.stamps++;
      store.set(d, { ...store.get(d)!, cryptoValuationStatus: plan.stamp });
    }
  }
}
const snapshot = () => JSON.stringify([...store.entries()].sort());

async function main() {
  console.log("setup: the 10-28 05:16 build — SOL only, BTC not yet linked");
  rebuild("2026-09-27", "2026-10-27", false);
  store.set(FROZEN_DAY, { date: FROZEN_DAY, stocks: 0, crypto: 26744.23, total: 26744.23, cash: 0, savings: 0, debt: 0, netWorth: 26744.23, totalAssets: 26744.23, netLiquid: 0, cashOnHand: 0, isEstimated: false, cryptoValuationStatus: null });
  const stale = store.get("2026-10-27")!;
  check("reproduced: 10-27 stored ≈ $76.04 and stamped `supported` (BTC missing)",
    Math.abs(stale.crypto - 76.0378195645) < 0.005 && stale.cryptoValuationStatus === "supported", JSON.stringify(stale));
  check("…31 such rows, 09-27..10-27", [...store.values()].filter((r) => r.isEstimated && r.cryptoValuationStatus === "supported").length === 31);

  // BTC history (licence 2025-01-01) and prices (floor 2026-09-20) now exist; BTC is linked to the Space.
  const native = new Map([["BTC", "2025-01-01"]]);
  const floors = new Map([["BTC", "2026-09-20"]]);
  const holderArgs = { accountId: "btc", nativeLicences: native, allLicences: native, floors, spaceIds: ["qa"] };
  const minOf = () => [...store.keys()].sort()[0];

  console.log("the defect, pinned: the legacy rule clamps to the days BEFORE the earliest row");
  {
    const legacy = revaluationOwedFromISO({ licences: native, floors, earliestSnapshotISO: minOf() });
    check("legacy window = [valued-from, earliest row − 1] = 2026-09-20..2026-09-26 — the stale rows are outside it",
      legacy?.fromISO === "2026-09-20" && minusDaysISO(minOf(), 1) === "2026-09-26");
  }

  console.log("fix: revaluation rewrites EXISTING rows when the holder gains history + prices");
  const marks = new Set<string>();
  const regens: string[] = [];
  const deps: RevaluationDeps = {
    acquireGaps: async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null }),
    owed: async () => {
      const h = holderRevaluationFor({ ...holderArgs, snapshotMinBySpace: new Map([["qa", minOf()]]) });
      return h ? [h] : [];
    },
    revaluedAlready: async (keys) => new Set(keys.filter((k) => marks.has(k))),
    markRevalued: async (k) => { marks.add(k); },
    regenerate: async (_id, from, to) => { regens.push(`${from}..${to}`); rebuild(from, to, true); },
    now: () => 0,
  };
  const r1 = await revalueHoldersAfterPriceGaps({ accountIds: ["btc"], deps, deadlineMs: 1e9, todayISO: TODAY });
  const d27 = store.get("2026-10-27")!;
  check("10-27 now includes BTC: $26,793.01, `supported`",
    Math.abs(d27.crypto - 26793.013084) < 0.005 && Math.abs(d27.netWorth - 26793.013084) < 0.005 && d27.cryptoValuationStatus === "supported", JSON.stringify(d27));
  check("every stale interior row 09-27..10-27 (except the unpriced day) is rewritten with BTC",
    days("2026-09-27", "2026-10-27").filter((d) => d !== BTC_UNPRICED_DAY).every((d) => store.get(d)!.crypto > 26000 && store.get(d)!.cryptoValuationStatus === "supported"));
  check("the earlier-days fill still works: 09-20..09-26 written with BTC", days("2026-09-20", "2026-09-26").every((d) => (store.get(d)?.crypto ?? 0) > 26000));
  const hole = store.get(BTC_UNPRICED_DAY)!;
  check("a day with no BTC price: `unavailable` — never `supported`, never $0 (stored value preserved)",
    hole.cryptoValuationStatus === "unavailable" && hole.crypto > 0 && Math.abs(hole.crypto - SOL_QTY * 100) < 0.005, JSON.stringify(hole));
  const frozen = store.get(FROZEN_DAY)!;
  check("the frozen (observed) row is untouched", frozen.crypto === 26744.23 && frozen.isEstimated === false && frozen.cryptoValuationStatus === null);
  check("no row reads `supported` while the BTC holder is missing from it",
    [...store.values()].every((r) => !(r.cryptoValuationStatus === "supported" && r.isEstimated && r.crypto < 26000)));
  check("run reported: 1 holder revalued", r1.revalued === 1 && r1.owed === 1 && r1.failures === 0, JSON.stringify(r1));

  console.log("idempotent");
  {
    const before = snapshot();
    const n = regens.length;
    const r2 = await revalueHoldersAfterPriceGaps({ accountIds: ["btc"], deps, deadlineMs: 1e9, todayISO: TODAY });
    check("re-run under the same evidence: nothing rebuilt, nothing changed", r2.alreadyRevalued === 1 && regens.length === n && snapshot() === before);
    const w0 = { ...ops };
    rebuild("2026-09-20", "2026-10-30", true);
    check("re-regenerating the same window writes, patches and stamps NOTHING (no churn)",
      ops.writes === w0.writes && ops.patches === w0.patches && ops.stamps === w0.stamps && snapshot() === before, JSON.stringify({ w0, ops }));
  }

  console.log("new evidence re-owes the window");
  {
    floors.set("BTC", "2026-09-01"); // a price gap fill lowered the floor
    const n = regens.length;
    const r3 = await revalueHoldersAfterPriceGaps({ accountIds: ["btc"], deps, deadlineMs: 1e9, todayISO: TODAY });
    check("a lowered price floor ⇒ revalued again from the new floor (new days written, old rows unchanged)",
      r3.revalued === 1 && regens.length > n && (store.get("2026-09-01")?.crypto ?? 0) > 26000 && Math.abs(store.get("2026-10-27")!.crypto - 26793.013084) < 0.005, JSON.stringify(r3));
  }

  console.log("owner ruling: an ABANDONED block never stays `supported`");
  {
    // Fresh stale state: the SOL-only rows again, plus the frozen observation.
    store.clear();
    rebuild("2026-09-27", "2026-10-27", false);
    store.set(FROZEN_DAY, { date: FROZEN_DAY, stocks: 0, crypto: 26744.23, total: 26744.23, cash: 0, savings: 0, debt: 0, netWorth: 26744.23, totalAssets: 26744.23, netLiquid: 0, cashOnHand: 0, isEstimated: false, cryptoValuationStatus: null });
    const POISON = "2026-10-27"; // its block (10-26..11-01) also holds the frozen 10-28
    const pmarks = new Set<string>();
    const ptries = new Map<string, { single: number; batch: number }>();
    const pdeps: RevaluationDeps = {
      ...deps,
      owed: async () => { const h = holderRevaluationFor({ ...holderArgs, accountId: "btc-p", snapshotMinBySpace: new Map([["qa", minOf()]]) }); return h ? [h] : []; },
      revaluedAlready: async (keys) => new Set(keys.filter((k) => pmarks.has(k))),
      markRevalued: async (k) => { pmarks.add(k); },
      attemptsOf: async (keys) => new Map(keys.filter((k) => ptries.has(k)).map((k) => [k, { ...ptries.get(k)! }])),
      markAttempt: async (k, kind) => { const c = ptries.get(k) ?? { single: 0, batch: 0 }; c[kind]++; ptries.set(k, c); },
      // The production stamp's contract: the status column only, ESTIMATE rows only.
      markUnavailable: async (_id, from, to) => {
        let n = 0;
        for (const d of days(from, to)) { const r = store.get(d); if (r && r.isEstimated && r.cryptoValuationStatus !== "unavailable") { store.set(d, { ...r, cryptoValuationStatus: "unavailable" }); n++; } }
        return n;
      },
      regenerate: async (_id, from, to) => { if (from <= POISON && POISON <= to) throw new Error("poison"); rebuild(from, to, true); },
    };
    let last = null as Awaited<ReturnType<typeof revalueHoldersAfterPriceGaps>> | null;
    for (let i = 0; i < 3; i++) last = await revalueHoldersAfterPriceGaps({ accountIds: ["btc-p"], deps: pdeps, deadlineMs: 1e9, todayISO: TODAY });
    const p27 = store.get(POISON)!, p26 = store.get("2026-10-26")!;
    check("the abandoned block's understated rows are stamped `unavailable` (value preserved, never $0, never `supported`)",
      p27.cryptoValuationStatus === "unavailable" && p26.cryptoValuationStatus === "unavailable" && p27.crypto > 0 && p27.crypto < 100 && (last?.abandonedBlocks ?? 0) === 1,
      JSON.stringify({ p27, last }));
    check("…the frozen observation in the same block is untouched", JSON.stringify(store.get(FROZEN_DAY)) === JSON.stringify({ date: FROZEN_DAY, stocks: 0, crypto: 26744.23, total: 26744.23, cash: 0, savings: 0, debt: 0, netWorth: 26744.23, totalAssets: 26744.23, netLiquid: 0, cashOnHand: 0, isEstimated: false, cryptoValuationStatus: null }));
    check("…every other block was rebuilt with BTC and is `supported` (the bad day burned no neighbour)",
      days("2026-09-27", "2026-10-25").filter((d) => d !== BTC_UNPRICED_DAY).every((d) => store.get(d)!.crypto > 26000 && store.get(d)!.cryptoValuationStatus === "supported"));
    check("…no estimate row anywhere reads `supported` while understated", [...store.values()].every((r) => !(r.isEstimated && r.cryptoValuationStatus === "supported" && r.crypto < 26000)));
  }

  console.log("the day decision's holder-completeness guard");
  {
    const accounts: CryptoAccountBalance[] = [
      { financialAccountId: "sol", name: "SOL", nativeBalance: SOL_QTY, assetKey: "sol", symbol: "SOL" },
      { financialAccountId: "btc", name: "BTC", nativeBalance: BTC_QTY, assetKey: "btc", symbol: "BTC" },
    ];
    const v = valueCryptoDay({ accounts, unitPriceByAssetKey: { sol: 100, btc: 80000 }, quantityLicensed: true });
    check("a complete valuation names every holder", cryptoHoldersNotValued({ accounts }, v).length === 0);
    const dropped = { ...v, positions: v.positions.filter((p) => p.financialAccountId !== "btc") };
    check("a valuation missing a holder that existed is detected", cryptoHoldersNotValued({ accounts }, dropped).join() === "btc");
    check("an unknown quantity counts as a holder that existed",
      cryptoHoldersNotValued({ accounts: [...accounts, { financialAccountId: "eth", name: "ETH", nativeBalance: null, assetKey: "eth", symbol: "ETH" }] }, v).join() === "eth");
    check("a holder outside its existence interval does not",
      cryptoHoldersNotValued({ accounts: [...accounts, { financialAccountId: "eth", name: "ETH", nativeBalance: 1, assetKey: "eth", symbol: "ETH", applicable: false }] }, v).length === 0);
    // REVIEW: a DRAINED wallet (confirmed zero that day) is not a missing holder — the row stays `supported`.
    const drainedAccounts: CryptoAccountBalance[] = [accounts[0], { ...accounts[1], nativeBalance: 0 }];
    const vd = valueCryptoDay({ accounts: drainedAccounts, unitPriceByAssetKey: { sol: 100, btc: 80000 }, quantityLicensed: true });
    check("a drained holder (balance 0 that day) is NOT reported missing", cryptoHoldersNotValued({ accounts: drainedAccounts }, vd).length === 0);
    store.clear();
    store.set("2026-06-01", { date: "2026-06-01", stocks: 0, crypto: SOL_QTY * 100, total: SOL_QTY * 100, cash: 0, savings: 0, debt: 0, netWorth: SOL_QTY * 100, totalAssets: SOL_QTY * 100, netLiquid: 0, cashOnHand: 0, isEstimated: true, cryptoValuationStatus: "supported" });
    const drainedDay = regenerateDay({
      date: "2026-06-01", existingIsEstimated: true, existing: store.get("2026-06-01")!,
      base: { totalInvestments: 0, totalDigitalAssets: 26800, totalChecking: 0, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
      investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
      digitalAssetValue: vd.nativeTotal, digitalAssetTier: "estimated", hasDigitalAssetEvidence: true,
      cryptoHoldersNotValued: cryptoHoldersNotValued({ accounts: drainedAccounts }, vd),
      cashCardTier: "derived", membershipChangedSince: false,
    });
    check("…so the day stays `supported` at the SOL-only value (no false `unavailable`)",
      drainedDay.cryptoValuationStatus === "supported" && Math.abs((drainedDay.fields?.crypto ?? drainedDay.fieldPatch?.crypto ?? store.get("2026-06-01")!.crypto) - SOL_QTY * 100) < 0.005,
      JSON.stringify({ s: drainedDay.cryptoValuationStatus, a: drainedDay.action }));
    const day = (missing: string[]) => regenerateDay({
      date: "2026-10-27", existingIsEstimated: true,
      existing: { stocks: 0, crypto: 76.04, total: 76.04, cash: 0, savings: 0, debt: 0, netWorth: 76.04, totalAssets: 76.04, netLiquid: 0, cashOnHand: 0 },
      base: { totalInvestments: 0, totalDigitalAssets: 26800, totalChecking: 0, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
      investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
      digitalAssetValue: 76.04, digitalAssetTier: "estimated", hasDigitalAssetEvidence: true, cryptoHoldersNotValued: missing,
      cashCardTier: "derived", membershipChangedSince: false,
    });
    const guarded = day(["btc"]);
    check("regenerateDay: a value with a missing holder is NEVER `supported` — unavailable, stored crypto preserved (not $0)",
      guarded.cryptoValuationStatus === "unavailable" && guarded.components?.find((c) => c.component === "crypto")?.action === "preserved", JSON.stringify(guarded.cryptoValuationStatus));
    check("…and with no missing holder the same day is `supported`", day([]).cryptoValuationStatus === "supported");
  }

  console.log("wiring (complements the behavioural checks)");
  {
    const src = readFileSync("lib/snapshots/regenerate-history.ts", "utf8");
    check("the binding computes the missing holders from the SAME accounts it values, and hands them to the day decision",
      /cryptoHoldersMissing = cryptoHoldersNotValued\(\{ accounts: cryptoDayAccounts \}, cryptoDayValuation\);/.test(src)
        && /valueCryptoDay\(\{\s*accounts: cryptoDayAccounts,/.test(src) && /cryptoHoldersNotValued: cryptoHoldersMissing,/.test(src));
    const pg = readFileSync("lib/prices/price-gap.ts", "utf8");
    check("production revaluation reads the evidence-keyed holders and clamps to the CHUNK, not to the earliest snapshot",
      /owed: \(ids\) => holderRevaluations\(client, ids\)/.test(pg) && !/earliestSnapshotISO, 1\)/.test(pg.slice(pg.indexOf("export async function revalueHoldersAfterPriceGaps"))));
  }

  console.log(`\nstale-holder-revaluation: ${passes} passed, ${failures} failed.`);
  if (failures > 0) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
