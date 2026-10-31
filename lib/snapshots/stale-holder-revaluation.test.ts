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
  holderRevaluationFor, revalueHoldersAfterPriceGaps, revaluationOwedFromISO, stampOwedHolders, holderContributionSpans,
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
function rebuild(from: string, to: string, withBtc: boolean, o: { withSol?: boolean; btcZero?: (d: string) => boolean; cash?: number } = {}): void {
  const withSol = o.withSol !== false;
  for (const d of days(from, to)) {
    if (d >= TODAY) continue; // the writable ceiling
    const accounts: CryptoAccountBalance[] = [
      ...(withSol ? [{ financialAccountId: "sol", name: "SOL", nativeBalance: SOL_QTY, assetKey: "sol", symbol: "SOL", applicable: true }] : []),
      ...(withBtc ? [{ financialAccountId: "btc", name: "BTC", nativeBalance: o.btcZero?.(d) ? 0 : BTC_QTY, assetKey: "btc", symbol: "BTC", applicable: true }] : []),
    ];
    const unitPriceByAssetKey: Record<string, number | null> = { ...(withSol ? { sol: solPx(d) } : {}), ...(withBtc ? { btc: btcPx(d) } : {}) };
    const v = valueCryptoDay({ accounts, unitPriceByAssetKey, quantityLicensed: true });
    const tokenDay = cryptoTokenDayDecision({ licensed: v.licensed, positionCount: v.positionCount }, null, d);
    const missing = cryptoHoldersNotValued({ accounts }, v);
    const evidence = tokenDay.tokensJoin; // as the binding: the guard is the day decision's (cryptoHoldersNotValued)
    const flat = (withSol ? SOL_QTY * 101 : 0) + (withBtc ? BTC_QTY * 81000 : 0); // today's carried balance
    const prior = store.get(d) ?? null;
    const res = regenerateDay({
      date: d, existingIsEstimated: prior ? prior.isEstimated : null,
      existing: prior,
      base: { totalInvestments: 0, totalDigitalAssets: flat, totalChecking: o.cash ?? 0, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
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
    } else if (plan.clearStamp && prior && prior.isEstimated) {
      ops.stamps++;
      store.set(d, { ...store.get(d)!, cryptoValuationStatus: null }); // a real recompute found no material crypto
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

  console.log("owner ruling: an OWED window is never `supported` while it waits for its rebuild");
  {
    store.clear();
    rebuild("2026-09-27", "2026-10-27", false); // SOL-only rows, `supported` — the holder is now owed
    store.set(FROZEN_DAY, { date: FROZEN_DAY, stocks: 0, crypto: 26744.23, total: 26744.23, cash: 0, savings: 0, debt: 0, netWorth: 26744.23, totalAssets: 26744.23, netLiquid: 0, cashOnHand: 0, isEstimated: false, cryptoValuationStatus: null });
    const wmarks = new Set<string>();
    let clock = 0;
    const applyStamp = async (_id: string, from: string, to: string) => {
      let n = 0;
      for (const d of days(from, to)) {
        const r = store.get(d);
        if (r && r.isEstimated && r.cryptoValuationStatus !== "unavailable") { store.set(d, { ...r, cryptoValuationStatus: "unavailable" }); n++; }
      }
      return n;
    };
    const wdeps: RevaluationDeps = {
      ...deps,
      owed: async () => { const h = holderRevaluationFor({ ...holderArgs, accountId: "btc-w", floors: new Map([["BTC", "2026-09-27"]]), snapshotMinBySpace: new Map([["qa", minOf()]]) }); return h ? [h] : []; },
      revaluedAlready: async (keys) => new Set(keys.filter((k) => wmarks.has(k))),
      markRevalued: async (k) => { wmarks.add(k); },
      markUnavailable: applyStamp,
      regenerate: async (_id, from, to) => { rebuild(from, to, true); clock += 20_000; },
      now: () => clock,
    };
    // A pass with time for only ONE batch (the newest): the rest of the window waits.
    await revalueHoldersAfterPriceGaps({ accountIds: ["btc-w"], deps: wdeps, deadlineMs: 95_000, todayISO: TODAY, msPerDay: 10_000 });
    const est = [...store.values()].filter((r) => r.isEstimated);
    const pendingRows = est.filter((r) => r.crypto < 26000);
    check("after a partial pass: rows not yet rebuilt are `unavailable` (never `supported` while missing the holder); rebuilt rows `supported`",
      pendingRows.length > 0 && pendingRows.every((r) => r.cryptoValuationStatus === "unavailable") && est.some((r) => r.crypto > 26000 && r.cryptoValuationStatus === "supported"),
      JSON.stringify(pendingRows.slice(0, 2)));
    check("…the frozen row is untouched", store.get(FROZEN_DAY)!.cryptoValuationStatus === null && store.get(FROZEN_DAY)!.isEstimated === false);
    clock = 0;
    await revalueHoldersAfterPriceGaps({ accountIds: ["btc-w"], deps: wdeps, deadlineMs: 1e12, todayISO: TODAY });
    check("…the rebuild restores `supported` per block: once done, every estimate row (bar the unpriced day) is `supported` with the holder",
      days("2026-09-27", "2026-10-27").filter((d) => d !== BTC_UNPRICED_DAY).every((d) => store.get(d)!.cryptoValuationStatus === "supported" && store.get(d)!.crypto > 26000));
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
      markAttempt: async (k, kind) => { const c = ptries.get(k) ?? { single: 0, batch: 0 }; if (kind === "dry_single") c.single--; else if (kind === "dry_batch") c.batch--; else c[kind]++; ptries.set(k, c); },
      // The production stamp's contract: the status column only, ESTIMATE rows only (supported AND null qualify).
      markUnavailable: async (_id, from, to) => {
        let n = 0;
        for (const d of days(from, to)) {
          const r = store.get(d);
          if (r && r.isEstimated && r.cryptoValuationStatus !== "unavailable") { store.set(d, { ...r, cryptoValuationStatus: "unavailable" }); n++; }
        }
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

  console.log("review #183 P1/P2: NULL rows, exact scope, frozen holder (stamp, don't rebuild), reversibility");
  {
    // A CASH-ONLY Space (rows NULL status, crypto 0 — read as `none`), then a BTC wallet with history is linked.
    // BTC held nothing 10-10..10-12 (drained, refilled): those days are outside its contribution spans.
    store.clear();
    const drained = (d: string) => d >= "2026-10-10" && d <= "2026-10-12";
    rebuild("2026-09-27", "2026-10-27", false, { withSol: false, cash: 1_000 });
    check("setup: cash-only rows carry NULL status (read as `none`, i.e. asserted complete)",
      days("2026-09-27", "2026-10-27").every((d) => store.get(d)!.cryptoValuationStatus === null && store.get(d)!.crypto === 0));
    const valuesBefore = JSON.stringify([...store.values()].map((r) => ({ d: r.date, c: r.crypto, n: r.netWorth, cash: r.cash })));
    const holder = holderRevaluationFor({ accountId: "btc-n", nativeLicences: new Map([["BTC", "2026-09-01"]]), allLicences: new Map([["BTC", "2026-09-01"]]),
      floors: new Map([["BTC", "2026-09-01"]]), snapshotMinBySpace: new Map([["qa", "2026-09-27"]]), spaceIds: ["qa"], evidenceFloorISO: "2026-09-27", ceilingISO: "2026-10-30" })!;
    const contributes = holderContributionSpans([
      { instrumentId: "btc", dateISO: "2026-09-27", quantity: BTC_QTY }, { instrumentId: "btc", dateISO: "2026-10-10", quantity: 0 }, { instrumentId: "btc", dateISO: "2026-10-13", quantity: BTC_QTY },
    ], holder.windowFromISO, "2026-10-30");
    const nmarks = new Set<string>();
    const calls = { gaps: 0, regen: 0, attempts: 0, done: 0 };
    const ndeps: RevaluationDeps = {
      acquireGaps: async () => { calls.gaps++; return { decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null }; },
      owed: async () => [{ ...holder, contributes }],
      revaluedAlready: async (keys) => new Set(keys.filter((k) => nmarks.has(k))),
      markRevalued: async (k) => { calls.done++; nmarks.add(k); },
      attemptsOf: async () => new Map(),
      markAttempt: async () => { calls.attempts++; },
      markUnavailable: async (_id, from, to) => {
        let n = 0;
        for (const d of days(from, to)) { const r = store.get(d); if (r && r.isEstimated && r.cryptoValuationStatus !== "unavailable") { store.set(d, { ...r, cryptoValuationStatus: "unavailable" }); n++; } }
        return n;
      },
      regenerate: async (_id, from, to) => { calls.regen++; rebuild(from, to, true, { withSol: false, cash: 1_000, btcZero: drained }); },
      now: () => 0,
    };
    // FROZEN: stamp, don't rebuild.
    const stamped = await stampOwedHolders(ndeps, ["btc-n"], TODAY);
    check("frozen holder: its NULL (`none`) rows are stamped `unavailable` — no rebuild, no gap fetch, no attempt, no done marker",
      stamped > 0 && calls.regen === 0 && calls.gaps === 0 && calls.attempts === 0 && calls.done === 0
        && days("2026-09-27", "2026-10-27").filter((d) => !drained(d)).every((d) => store.get(d)!.cryptoValuationStatus === "unavailable"));
    check("…VALUES preserved exactly (status only — never nulled, zeroed or omitted)",
      JSON.stringify([...store.values()].map((r) => ({ d: r.date, c: r.crypto, n: r.netWorth, cash: r.cash }))) === valuesBefore);
    check("…EXACT scope: days the holder held nothing (drained 10-10..10-12) are NOT stamped",
      ["2026-10-10", "2026-10-11", "2026-10-12"].every((d) => store.get(d)!.cryptoValuationStatus === null));
    // UNFREEZE: the next allowed pass rebuilds and clears the stamp automatically.
    await revalueHoldersAfterPriceGaps({ accountIds: ["btc-n"], deps: ndeps, deadlineMs: 1e12, todayISO: TODAY });
    check("after unfreeze: rebuilt — held days now include BTC and read `supported` (the stamp is reversed, not final)",
      days("2026-09-27", "2026-10-27").filter((d) => !drained(d) && d !== BTC_UNPRICED_DAY).every((d) => store.get(d)!.cryptoValuationStatus === "supported" && store.get(d)!.crypto > 26000));
    check("…drained days are decided by the rebuild's own verdict (never `supported` at $0); the unpriced day is honestly `unavailable`",
      ["2026-10-10", "2026-10-11", "2026-10-12"].every((d) => store.get(d)!.cryptoValuationStatus !== "supported") && store.get(BTC_UNPRICED_DAY)!.cryptoValuationStatus === "unavailable");

    // clearStamp: a stamped row whose REAL recompute finds no material crypto is restored to NULL.
    store.clear();
    rebuild("2026-10-01", "2026-10-03", false, { withSol: false, cash: 1_000 });
    for (const d of days("2026-10-01", "2026-10-03")) store.set(d, { ...store.get(d)!, cryptoValuationStatus: "unavailable" });
    rebuild("2026-10-01", "2026-10-03", false, { withSol: false, cash: 1_000 }); // a REAL recompute: no crypto at all
    check("planDayPersistence clearStamp: a pending stamp on a day whose real recompute finds no crypto is CLEARED to NULL (never stranded)",
      days("2026-10-01", "2026-10-03").every((d) => store.get(d)!.cryptoValuationStatus === null));
    // …but a membership skip carries no authority: it neither stamps nor clears.
    const skip = regenerateDay({ date: "2026-10-01", existingIsEstimated: true,
      existing: { stocks: 0, crypto: 0, total: 0, cash: 1000, savings: 0, debt: 0, netWorth: 1000, totalAssets: 1000, netLiquid: 1000, cashOnHand: 1000 },
      base: { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 1000, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
      investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false, digitalAssetValue: 0, digitalAssetTier: "estimated",
      hasDigitalAssetEvidence: false, cashCardTier: "derived", membershipChangedSince: true });
    const skipPrior: Row = { date: "2026-10-01", stocks: 0, crypto: 0, total: 0, cash: 1000, savings: 0, debt: 0, netWorth: 1000, totalAssets: 1000, netLiquid: 1000, cashOnHand: 1000, isEstimated: true, cryptoValuationStatus: "unavailable" };
    const skipPlan = planDayPersistence(skip, skipPrior);
    check("a membership-changed skip neither stamps nor clears (so the stamp never covers such days — see unblockedRanges)",
      skip.action === "skip-membership-changed" && skipPlan.stamp === null && skipPlan.clearStamp === false && !skipPlan.write, JSON.stringify(skipPlan));
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
    check("the binding executes planDayPersistence's clearStamp as a metadata-only NULL stamp (so a pending stamp is never stranded)",
      /else if \(applyWrites && plan\.clearStamp\) metadataOnlyStamps\.push\(\{ date: d, status: null \}\);/.test(src)
        && /where: \{ spaceId, date: m\.date, isEstimated: true \},\s*data:  \{ cryptoValuationStatus: m\.status \}/.test(src));
    check("the binding computes the missing holders from the SAME accounts it values, and hands them to the day decision",
      /cryptoHoldersMissing = cryptoHoldersNotValued\(\{ accounts: cryptoDayAccounts \}, cryptoDayValuation\);/.test(src)
        && /valueCryptoDay\(\{\s*accounts: cryptoDayAccounts,/.test(src) && /cryptoHoldersNotValued: cryptoHoldersMissing,/.test(src));
    const pg = readFileSync("lib/prices/price-gap.ts", "utf8");
    check("production revaluation reads the evidence-keyed holders and clamps to the CHUNK, not to the earliest snapshot",
      /owed: \(ids\) => holderRevaluations\(client, ids\)/.test(pg) && !/earliestSnapshotISO, 1\)/.test(pg.slice(pg.indexOf("export async function revalueHoldersAfterPriceGaps"))));
    // The abandoned-block stamp's DB binding: estimate rows only (a frozen
    // observation is never downgraded), status column only (no value written).
    const stamp = pg.slice(pg.indexOf("async markUnavailable("), pg.indexOf("async regenerate(", pg.indexOf("async markUnavailable(")));
    check("the abandoned-block stamp touches ESTIMATE rows only and writes only the status column",
      stamp.length > 0 && /isEstimated: true,/.test(stamp) && /data: \{ cryptoValuationStatus: "unavailable" \}/.test(stamp));
  }

  console.log(`\nstale-holder-revaluation: ${passes} passed, ${failures} failed.`);
  if (failures > 0) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
