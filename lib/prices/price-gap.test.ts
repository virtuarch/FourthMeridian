/**
 * lib/prices/price-gap.test.ts
 *
 * Historical price-gap detection + bounded, per-instrument backfill
 * (2026-10-28). Deterministic fixtures only: an in-memory archive and a fake
 * provider that serves a declared window and may omit days.
 *   npx tsx lib/prices/price-gap.test.ts
 */

import { readFileSync } from "node:fs";
import { minusDaysISO } from "./config";
import {
  valuedFromISO, planPriceGaps, acquireHistoricalPriceGaps, DEFAULT_PRICE_GAP_MAX_INSTRUMENTS,
  priceGapAttemptKey, revaluationOwedFromISO, cryptoHolderLicences, revalueHoldersAfterPriceGaps, REVALUATION_RESERVE_MS,
  holderRevaluationFor, holderRevaluations, revaluationBlocks, planRevaluationBatch, revaluationPending, REVALUATION_MAX_ATTEMPTS,
  estimateRebuildCost, batchDaysFor, REVALUATION_SUSPECT_HALVINGS, prismaRevaluationDeps, planRevaluation,
  unblockedRanges, holderContributionSpans, holderStampRanges, REVALUATION_MAX_BATCHES_PER_PASS, stampOwedHolders,
  type HolderLicence, type HolderRevaluation, type InstrumentPriceFacts, type PriceGapDeps, type RevaluationDeps,
} from "./price-gap";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const YESTERDAY = "2026-10-27";
const TODAY_P3 = "2026-10-31";
const PROVIDER_FLOOR = minusDaysISO("2026-10-28", 365); // CoinGecko Demo: rolling 365 days
const coingecko = (floorISO = PROVIDER_FLOOR): InstrumentPriceFacts["provider"] => ({ kind: "provider", source: "coingecko", floorISO });
const facts = (id: string, earliest: string | null, provider: InstrumentPriceFacts["provider"] = coingecko()): [string, InstrumentPriceFacts] =>
  [id, { instrumentId: id, earliestRawCloseISO: earliest, provider }];
const lic = (acct: string, inst: string, from: string): HolderLicence => ({ financialAccountId: acct, instrumentId: inst, licensedFromISO: from });

/** An in-memory archive + provider: serves every day in [floor, yesterday] except `missing`. */
function world(o: { archive: Record<string, string[]>; licences: HolderLicence[]; floor?: string; missing?: string[]; noProvider?: string[] }) {
  const archive = new Map(Object.entries(o.archive).map(([k, v]) => [k, new Set(v)]));
  const calls: Array<{ instrumentId: string; fromISO: string; toISO: string }> = [];
  const floor = o.floor ?? PROVIDER_FLOOR;
  const deps: PriceGapDeps = {
    licences: async (ids) => o.licences.filter((l) => ids.includes(l.financialAccountId)),
    priceFacts: async (ids) => new Map(ids.map((id) => {
      const days = [...(archive.get(id) ?? [])].sort();
      return facts(id, days[0] ?? null, o.noProvider?.includes(id) ? { kind: "none" } : coingecko(floor));
    })),
    acquire: async (instrumentId, fromISO, toISO) => {
      calls.push({ instrumentId, fromISO, toISO });
      const set = archive.get(instrumentId) ?? new Set<string>();
      let inserted = 0;
      // Missing-only, insert-only, never before the provider floor, never a carried price.
      for (let d = fromISO; d <= toISO; d = minusDaysISO(d, -1)) {
        if (d < floor || o.missing?.includes(d) || set.has(d)) continue;
        set.add(d); inserted++;
      }
      archive.set(instrumentId, set);
      return { inserted, detail: `${inserted} row(s)` };
    },
  };
  return { deps, archive, calls };
}
const days = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = minusDaysISO(d, -1)) out.push(d); return out; };

async function main() {
  console.log("valued-from = max(balance licence start, price floor)");
  {
    check("2-yr wallet + 1-yr prices ⇒ valued from the price floor (1 yr)", valuedFromISO("2024-10-28", "2025-10-28") === "2025-10-28");
    check("5-yr wallet + 10-yr prices ⇒ valued from the licence (5 yr)", valuedFromISO("2021-10-28", "2016-10-28") === "2021-10-28");
    check("no licence ⇒ null (no quantity is not 'from the beginning')", valuedFromISO(null, "2025-10-28") === null);
    check("no prices ⇒ null (never valued at zero)", valuedFromISO("2024-10-28", null) === null);
  }

  console.log("planning");
  {
    // The Preview case: balances proven to 2022-03-26, archive holds 31 days.
    const plan = planPriceGaps({ licences: [lic("a", "SOL", "2022-03-26")], facts: new Map([facts("SOL", "2026-09-27")]), yesterdayISO: YESTERDAY });
    check("a 4-year licence over a 31-day archive ⇒ ONE request, from the provider floor to the day before the archive",
      plan.length === 1 && plan[0].kind === "ACQUIRE" && plan[0].kind === "ACQUIRE"
        && plan[0].fromISO === PROVIDER_FLOOR && plan[0].toISO === "2026-09-26", JSON.stringify(plan));

    const covered = planPriceGaps({ licences: [lic("a", "BTC", "2025-01-01")], facts: new Map([facts("BTC", "2016-10-28")]), yesterdayISO: YESTERDAY });
    check("archive already older than the licence ⇒ COVERED (no request)", covered[0].kind === "COVERED");

    const below = planPriceGaps({ licences: [lic("a", "SOL", "2022-03-26")], facts: new Map([facts("SOL", PROVIDER_FLOOR)]), yesterdayISO: YESTERDAY });
    check("archive already at the provider floor ⇒ BELOW_PROVIDER_WINDOW (older days stay missing; never requested)", below[0].kind === "BELOW_PROVIDER_WINDOW");

    const none = planPriceGaps({ licences: [lic("a", "TOK", "2025-01-01")], facts: new Map([facts("TOK", null, { kind: "none" })]), yesterdayISO: YESTERDAY });
    check("no configured provider ⇒ NO_PROVIDER (nothing requested)", none[0].kind === "NO_PROVIDER");

    const empty = planPriceGaps({ licences: [lic("a", "ETH", "2026-06-01")], facts: new Map([facts("ETH", null)]), yesterdayISO: YESTERDAY });
    check("no prices at all ⇒ licence start (inside the window) to yesterday", empty[0].kind === "ACQUIRE" && empty[0].fromISO === "2026-06-01" && empty[0].toISO === YESTERDAY);

    const shared = planPriceGaps({
      licences: [lic("alice-wallet", "SOL", "2024-05-01"), lic("bob-wallet", "SOL", "2023-01-01"), lic("bob-wallet-2", "SOL", "2026-01-01")],
      facts: new Map([facts("SOL", "2026-09-27")]), yesterdayISO: YESTERDAY,
    });
    check("two customers holding the same asset ⇒ ONE decision for the instrument (the archive is shared), earliest need wins",
      shared.length === 1 && shared[0].holders === 3 && shared[0].neededFromISO === "2023-01-01", JSON.stringify(shared));

    const many = Array.from({ length: 8 }, (_, i) => `I${i}`);
    const capped = planPriceGaps({ licences: many.map((id) => lic(`acct-${id}`, id, "2026-01-01")), facts: new Map(many.map((id) => facts(id, "2026-10-01"))), yesterdayISO: YESTERDAY });
    check(`bounded per run: at most ${DEFAULT_PRICE_GAP_MAX_INSTRUMENTS} instruments acquire, the rest DEFERRED_RUN_CAP`,
      capped.filter((d) => d.kind === "ACQUIRE").length === DEFAULT_PRICE_GAP_MAX_INSTRUMENTS && capped.filter((d) => d.kind === "DEFERRED_RUN_CAP").length === 3);
    check("…in a deterministic order (instrumentId)", capped.filter((d) => d.kind === "ACQUIRE").map((d) => d.instrumentId).join() === "I0,I1,I2,I3,I4");

    const again = planPriceGaps({ licences: [lic("a", "SOL", "2022-03-26")], facts: new Map([facts("SOL", "2026-09-27")]), yesterdayISO: YESTERDAY, attempted: new Map([["SOL", PROVIDER_FLOOR]]) });
    check("already requested this run from the same day ⇒ ALREADY_ATTEMPTED", again[0].kind === "ALREADY_ATTEMPTED");
    const closed = planPriceGaps({ licences: [lic("a", "SOL", "2026-10-20")], facts: new Map([facts("SOL", "2026-10-28")]), yesterdayISO: YESTERDAY });
    check("never a request for today (closed dates only)", closed[0].kind === "ACQUIRE" && closed[0].toISO === YESTERDAY);
  }

  console.log("acquisition, end to end against an in-memory archive");
  {
    // 2-year wallet, 1-year provider window, 31-day archive, one day the provider lacks.
    const missingDay = "2026-03-15";
    const w = world({ archive: { SOL: days("2026-09-27", "2026-10-27") }, licences: [lic("a", "SOL", "2024-10-28")], missing: [missingDay] });
    const r = await acquireHistoricalPriceGaps({ accountIds: ["a"], deps: w.deps, yesterdayISO: YESTERDAY });
    const sol = w.archive.get("SOL")!;
    check("one bounded request for the gap below the archive", w.calls.length === 1 && w.calls[0].fromISO === PROVIDER_FLOOR && w.calls[0].toISO === "2026-09-26", JSON.stringify(w.calls));
    check("the archive now reaches the provider floor; valued-from = 1 yr", r.newlyPricedFromISO === PROVIDER_FLOOR
      && valuedFromISO("2024-10-28", [...sol].sort()[0]) === PROVIDER_FLOOR, JSON.stringify(r));
    check("a day the provider did not return STAYS MISSING (never carried or interpolated)", !sol.has(missingDay) && sol.has(minusDaysISO(missingDay, 1)) && sol.has(minusDaysISO(missingDay, -1)));
    check("nothing older than the provider window was requested or stored", ![...sol].some((d) => d < PROVIDER_FLOOR));
    check("rows reported match rows stored", r.inserted === days(PROVIDER_FLOOR, "2026-09-26").length - 1 && r.instruments[0].earliestBeforeISO === "2026-09-27");

    const r2 = await acquireHistoricalPriceGaps({ accountIds: ["a"], deps: w.deps, yesterdayISO: YESTERDAY });
    check("idempotent: a second run issues no request", w.calls.length === 1 && r2.acquired === 0 && r2.newlyPricedFromISO === null);

    // 5-year wallet, provider/archive already 10 years deep.
    const deep = world({ archive: { BTC: days("2016-10-28", "2016-11-05") }, licences: [lic("b", "BTC", "2021-10-28")], floor: "2013-04-28" });
    await acquireHistoricalPriceGaps({ accountIds: ["b"], deps: deep.deps, yesterdayISO: YESTERDAY });
    check("5-yr wallet + 10-yr prices ⇒ no request; valued from the licence", deep.calls.length === 0 && valuedFromISO("2021-10-28", "2016-10-28") === "2021-10-28");

    // Two customers, same instrument, one run: one acquisition.
    const two = world({ archive: { SOL: days("2026-09-27", "2026-10-27") }, licences: [lic("alice", "SOL", "2024-01-01"), lic("bob", "SOL", "2025-06-01")] });
    const attempted = new Map<string, string>();
    await acquireHistoricalPriceGaps({ accountIds: ["alice"], deps: two.deps, yesterdayISO: YESTERDAY, attempted });
    await acquireHistoricalPriceGaps({ accountIds: ["bob"], deps: two.deps, yesterdayISO: YESTERDAY, attempted });
    await acquireHistoricalPriceGaps({ accountIds: ["alice", "bob"], deps: two.deps, yesterdayISO: YESTERDAY, attempted });
    check("dedup across customers: alice's then bob's wallet then both ⇒ exactly ONE provider request for SOL", two.calls.length === 1, JSON.stringify(two.calls));

    // A provider that returns NOTHING moves no floor — the run's dedup still stops a repeat request.
    const dry = world({ archive: { SOL: ["2026-10-20"] }, licences: [lic("alice", "SOL", "2026-01-01"), lic("bob", "SOL", "2026-02-01")], missing: days("2025-01-01", "2026-10-27") });
    const dryAttempted = new Map<string, string>();
    await acquireHistoricalPriceGaps({ accountIds: ["alice"], deps: dry.deps, yesterdayISO: YESTERDAY, attempted: dryAttempted });
    const rd = await acquireHistoricalPriceGaps({ accountIds: ["bob"], deps: dry.deps, yesterdayISO: YESTERDAY, attempted: dryAttempted });
    check("…and when the provider returns nothing, the second customer's wallet does not re-request in the same run",
      dry.calls.length === 1 && rd.decisions[0]?.kind === "ALREADY_ATTEMPTED" && !dry.archive.get("SOL")!.has("2026-01-01"), JSON.stringify(rd.decisions));

    // Bounded per run across calls (the worker passes the remaining allowance).
    const ids = Array.from({ length: 7 }, (_, i) => `I${i}`);
    const many = world({ archive: Object.fromEntries(ids.map((id) => [id, ["2026-10-20"]])), licences: ids.map((id) => lic("x", id, "2026-01-01")) });
    const rm = await acquireHistoricalPriceGaps({ accountIds: ["x"], deps: many.deps, yesterdayISO: YESTERDAY, maxInstruments: 2 });
    check("the per-run instrument cap bounds requests", many.calls.length === 2 && rm.decisions.filter((d) => d.kind === "DEFERRED_RUN_CAP").length === 5);

    // Never throws.
    const broken: PriceGapDeps = { ...w.deps, licences: async () => { throw new Error("db down"); } };
    const rb = await acquireHistoricalPriceGaps({ accountIds: ["a"], deps: broken, yesterdayISO: YESTERDAY });
    check("a read failure is counted, never thrown", rb.failures === 1 && rb.acquired === 0);
    const failing = world({ archive: { SOL: ["2026-10-01"] }, licences: [lic("a", "SOL", "2026-01-01")] });
    const rf = await acquireHistoricalPriceGaps({ accountIds: ["a"], deps: { ...failing.deps, acquire: async () => { throw new Error("429"); } }, yesterdayISO: YESTERDAY });
    check("a provider failure is counted and moves nothing", rf.failures === 1 && rf.newlyPricedFromISO === null && rf.inserted === 0);
  }

  console.log("REVIEW FIX 4 — durable once-a-day marker for an unfillable gap");
  {
    const keys = new Set<string>();
    const dry = world({ archive: { SOL: ["2026-10-20"] }, licences: [lic("a", "SOL", "2026-01-01")], missing: days("2025-01-01", "2026-10-27") });
    const deps: PriceGapDeps = { ...dry.deps, attemptedOn: async (ks) => new Set(ks.filter((k) => keys.has(k))), markAttempted: async (k) => { keys.add(k); } };
    await acquireHistoricalPriceGaps({ accountIds: ["a"], deps, yesterdayISO: YESTERDAY });
    const r2 = await acquireHistoricalPriceGaps({ accountIds: ["a"], deps, yesterdayISO: YESTERDAY }); // a later run, same day
    check("the same never-filled floor is requested ONCE per day across runs (not every ~15 min)",
      dry.calls.length === 1 && r2.decisions[0]?.kind === "ALREADY_ATTEMPTED_TODAY" && keys.has(priceGapAttemptKey("coingecko", "SOL", "2026-10-20")), JSON.stringify(r2.decisions));
    keys.clear(); // the next UTC day: the marker is day-scoped (ApiUsageCounter day bucket)
    await acquireHistoricalPriceGaps({ accountIds: ["a"], deps, yesterdayISO: YESTERDAY });
    check("…and retried the next day", dry.calls.length === 2);
    const moved = planPriceGaps({ licences: [lic("a", "SOL", "2024-01-01")], facts: new Map([facts("SOL", "2026-09-01")]), yesterdayISO: YESTERDAY,
      attemptedToday: new Set([priceGapAttemptKey("coingecko", "SOL", "2026-10-20")]) });
    check("…a floor that MOVED is a different gap (not suppressed)", moved[0].kind === "ACQUIRE");
  }

  console.log("revaluation owed (state-derived)");
  {
    const one = (lic: string, floor: string | null, snap: string | null) => revaluationOwedFromISO({ licences: new Map([["SOL", lic]]), floors: new Map(floor ? [["SOL", floor]] : []), earliestSnapshotISO: snap });
    check("licence 2022, floor 2025-10-28, snapshots from 2026-09-27 ⇒ owed from 2025-10-28", one("2022-03-26", "2025-10-28", "2026-09-27")?.fromISO === "2025-10-28");
    check("snapshots already reach valued-from ⇒ nothing owed", one("2022-03-26", "2025-10-28", "2025-10-28") === null);
    check("no snapshots yet ⇒ nothing owed here (the initial build is the normal path's)", one("2022-03-26", "2025-10-28", null) === null);
    check("an unpriced blocking instrument ⇒ nothing owed (never valued at zero)", one("2022-03-26", null, "2026-09-27") === null);
    const two = revaluationOwedFromISO({ licences: new Map([["SOL", "2022-01-01"], ["ETH", "2021-01-01"]]), floors: new Map([["SOL", "2025-10-28"], ["ETH", "2026-02-01"]]), earliestSnapshotISO: "2026-09-27" });
    check("two blocking instruments ⇒ the LATER valued-from (a day needs both)", two?.fromISO === "2026-02-01" && two?.floorISO === "2026-02-01");
  }

  console.log("REVIEW FIX 2 (+ P1 2026-10-31) — bounded, kill-safe revaluation, keyed by evidence, over existing rows too");
  {
    const TODAY = "2026-10-31";
    const dayCount = (f: string, t: string) => Math.round((Date.parse(t) - Date.parse(f)) / 86_400_000) + 1;
    /** `perDayMs`: rebuild cost proportional to the batch (as real regeneration is); else a flat `regenMs` per call. */
    const mk = (o: { owed: HolderRevaluation[]; done?: string[]; regenMs?: number; perDayMs?: number;
      fail?: (n: number, from: string, to: string) => boolean; killAt?: (n: number) => boolean }) => {
      const regens: string[] = []; const marks: string[] = []; const tries = new Map<string, { single: number; batch: number }>(); let t = 0; let calls = 0;
      const stamped: string[] = [];
      const deps: RevaluationDeps = {
        acquireGaps: async () => ({ decisions: [], acquired: 1, inserted: 300, failures: 0, instruments: [], newlyPricedFromISO: "2025-10-28" }),
        owed: async (ids) => o.owed.filter((x) => ids.includes(x.accountId)),
        revaluedAlready: async (ks) => new Set(ks.filter((k) => o.done?.includes(k) || marks.includes(k))),
        markRevalued: async (k) => { marks.push(k); },
        attemptsOf: async (ks) => new Map(ks.filter((k) => tries.has(k)).map((k) => [k, { ...tries.get(k)! }])),
        markAttempt: async (k, kind) => { const c = tries.get(k) ?? { single: 0, batch: 0 }; if (kind === "dry_single") c.single--; else if (kind === "dry_batch") c.batch--; else c[kind]++; tries.set(k, c); },
        markUnavailable: async (id, from, to) => { stamped.push(`${id}:${from}..${to}`); return dayCount(from, to); },
        regenerate: async (id, from, to) => {
          calls++;
          regens.push(`${id}:${from}..${to}`);
          t += o.perDayMs !== undefined ? o.perDayMs * dayCount(from, to) : o.regenMs ?? 1_000;
          // A KILL: the process dies mid-rebuild (modelled as the clock running out, then the throw).
          if (o.killAt?.(calls)) { t = 1e12; throw new Error("killed mid-rebuild"); }
          if (o.fail?.(calls, from, to)) throw new Error("rebuild failed");
        },
        now: () => t,
      };
      return { deps, regens, marks, tries, stamped, at: () => t, reset: () => { t = 0; } };
    };
    const owe = (id: string, from = "2026-09-27"): HolderRevaluation => ({ accountId: id, windowFromISO: from, valuedFromISO: from, evidenceKey: `revaluation:v2:${id}:k` });
    const blocksOf = (h: HolderRevaluation) => revaluationBlocks(h.evidenceKey, h.windowFromISO, TODAY);
    const sweepIds = Array.from({ length: 40 }, (_, i) => `acct-${String(i).padStart(2, "0")}`);
    const w = mk({ owed: [owe("acct-03"), owe("acct-17"), owe("acct-29")] });
    const r = await revalueHoldersAfterPriceGaps({ accountIds: sweepIds, deps: w.deps, deadlineMs: 1e9, todayISO: TODAY });
    const capped = mk({ owed: [{ ...owe("cz"), windowToISO: "2026-10-28" }] });
    await revalueHoldersAfterPriceGaps({ accountIds: ["cz"], deps: capped.deps, deadlineMs: 1e9, todayISO: TODAY });
    check("the window ends at the writable CEILING (windowToISO), never past what the rebuild recomputes", capped.regens.join() === "cz:2026-09-27..2026-10-28", capped.regens.join());
    check("ONLY the owed holders are regenerated — through TODAY, existing rows included (not clamped to the earliest snapshot)",
      w.regens.join() === "acct-03:2026-09-27..2026-10-31,acct-17:2026-09-27..2026-10-31,acct-29:2026-09-27..2026-10-31" && r.revalued === 3, w.regens.join());
    const many = mk({ owed: Array.from({ length: 14 }, (_, i) => owe(`h${String(i).padStart(2, "0")}`)) });
    const rm = await revalueHoldersAfterPriceGaps({ accountIds: Array.from({ length: 14 }, (_, i) => `h${String(i).padStart(2, "0")}`), deps: many.deps, deadlineMs: 1e9, maxAccounts: 10, todayISO: TODAY });
    check("per-run account cap: 10 revalued, 4 deferred (still owed on disk, unmarked)",
      rm.revalued === 10 && rm.deferred === 4 && !many.marks.some((k) => /:h1[0-3]:/.test(k)) && many.marks.length === 10 * blocksOf(owe("h00")).length);
    const slow = mk({ owed: [owe("a"), owe("b"), owe("c")], regenMs: 50_000 });
    const rs = await revalueHoldersAfterPriceGaps({ accountIds: ["a", "b", "c"], deps: slow.deps, deadlineMs: 120_000, todayISO: TODAY });
    check("wake time: stops starting rebuilds with < 60 s left and defers the rest (unfinished holders stay owed)",
      slow.regens.length === 2 && rs.deferred === 3 && rs.revalued === 0 && slow.at() <= 120_000 + 50_000 && new Set(slow.regens.map((x) => x.split(":")[0])).size === 2, JSON.stringify({ rs, r: slow.regens }));
    const late = mk({ owed: [owe("a")] });
    const rl = await revalueHoldersAfterPriceGaps({ accountIds: ["a"], deps: late.deps, deadlineMs: REVALUATION_RESERVE_MS - 1, todayISO: TODAY });
    check("too little wake left ⇒ no gap request, no rebuild — but the owed window IS stamped first (review #183 P2)",
      rl.skippedForTime && rl.priceGaps === null && late.regens.length === 0 && late.stamped.length > 0 && rl.rowsStampedPending > 0, JSON.stringify(rl));
    const throwing = mk({ owed: [owe("g")] });
    const rg = await revalueHoldersAfterPriceGaps({ accountIds: ["g"], todayISO: TODAY, deadlineMs: 1e9,
      deps: { ...throwing.deps, acquireGaps: async () => { throw new Error("vendor down"); } } });
    check("a throw in the PAID gap fetch never skips the stamp nor the rebuild of held evidence",
      throwing.stamped.length > 0 && rg.revalued === 1 && throwing.regens.length === 1 && rg.failures === 1, JSON.stringify(rg));
    const again = mk({ owed: [owe("a"), owe("b")], done: blocksOf(owe("a")).map((x) => x.key) });
    const ra = await revalueHoldersAfterPriceGaps({ accountIds: ["a", "b"], deps: again.deps, deadlineMs: 1e9, todayISO: TODAY });
    check("a holder already revalued under the SAME evidence state is not rebuilt again (no churn, no loop)", ra.alreadyRevalued === 1 && again.regens.join() === "b:2026-09-27..2026-10-31");

    // REVIEW (MEDIUM): DONE only after the rebuild returns — a kill mid-batch leaves the blocks owed.
    const nBlocks = blocksOf(owe("k")).length;
    const killed = mk({ owed: [owe("k")], killAt: (n) => n === 1 });
    const k1 = await revalueHoldersAfterPriceGaps({ accountIds: ["k"], deps: killed.deps, deadlineMs: 1e9, todayISO: TODAY });
    check("killed mid-rebuild: NOT marked done (the blocks stay owed), no attempt CHARGED (only a batch try), never thrown",
      killed.marks.length === 0 && killed.tries.size === nBlocks && [...killed.tries.values()].every((c) => c.single === 0 && c.batch === 1) && k1.deferred === 1, JSON.stringify(k1));
    check("…and it is still pending", await revaluationPending(killed.deps, ["k"], TODAY));
    killed.reset();
    const k2 = await revalueHoldersAfterPriceGaps({ accountIds: ["k"], deps: killed.deps, deadlineMs: 1e9, todayISO: TODAY });
    const redone = killed.regens.slice(1);
    check("…the next run REDOES the same range (a once-killed batch is narrowed to ≤ 8 blocks, not split per block) and marks it done",
      k2.revalued === 1 && redone.length === 1 && redone[0] === killed.regens[0] && killed.marks.length === nBlocks, JSON.stringify(killed.regens));
    const k3 = await revalueHoldersAfterPriceGaps({ accountIds: ["k"], deps: killed.deps, deadlineMs: 1e9, todayISO: TODAY });
    check("…then a no-op", k3.alreadyRevalued === 1 && killed.regens.length === 2);

    // REVIEW: attempts are charged PER BLOCK — one bad day never burns its neighbours'.
    const BAD = "2026-10-15";
    const bad = mk({ owed: [owe("b")], fail: (_n, f, t) => f <= BAD && BAD <= t });
    const r1b = await revalueHoldersAfterPriceGaps({ accountIds: ["b"], deps: bad.deps, deadlineMs: 1e9, todayISO: TODAY });
    const badBlock = blocksOf(owe("b")).find((x) => x.fromISO <= BAD && BAD <= x.toISO)!;
    check("a failed batch is retried block by block in the same run: every GOOD block is rebuilt and done",
      bad.marks.length === nBlocks - 1 && !bad.marks.includes(badBlock.key) && r1b.failures === 1, JSON.stringify({ r: bad.regens, m: bad.marks.length }));
    check("…only the bad block is left with a FAILED attempt; each neighbour was tried once, alone, and is done",
      bad.tries.get(badBlock.key)?.single === 1
        && [...bad.tries.entries()].filter(([key]) => key !== badBlock.key).every(([key, c]) => bad.marks.includes(key) && c.single <= 1), JSON.stringify([...bad.tries.entries()]));
    for (let i = 1; i < REVALUATION_MAX_ATTEMPTS; i++) { bad.reset(); await revalueHoldersAfterPriceGaps({ accountIds: ["b"], deps: bad.deps, deadlineMs: 1e9, todayISO: TODAY }); }
    check(`…after ${REVALUATION_MAX_ATTEMPTS} failures ONLY the bad block is abandoned`, bad.tries.get(badBlock.key)?.single === REVALUATION_MAX_ATTEMPTS
      && bad.marks.length === nBlocks - 1, JSON.stringify({ t: bad.tries.get(badBlock.key) }));
    const regensBefore = bad.regens.length;
    const stampsBefore = bad.stamped.length;
    const r4b = await revalueHoldersAfterPriceGaps({ accountIds: ["b"], deps: bad.deps, deadlineMs: 1e9, todayISO: TODAY });
    check("…a later run never rebuilds it again (no poison loop), stamps ONLY the bad block unavailable (idempotent), owes nothing",
      bad.regens.length === regensBefore && r4b.abandonedBlocks === 1 && r4b.rowsStampedUnavailable > 0
        && bad.stamped.slice(stampsBefore).join() === `b:${badBlock.fromISO}..${badBlock.toISO}` && !(await revaluationPending(bad.deps, ["b"], TODAY)),
      JSON.stringify({ r4b, s: bad.stamped.slice(stampsBefore) }));

    // REVIEW #183 (P2): writes disabled ⇒ nothing stamped, attempted or marked; a dry-run rebuild never retires a block.
    {
      const off = mk({ owed: [owe("ks")] });
      const ro = await revalueHoldersAfterPriceGaps({ accountIds: ["ks"], deps: { ...off.deps, writesEnabled: () => false }, deadlineMs: 1e9, todayISO: TODAY });
      const so = await stampOwedHolders({ ...off.deps, writesEnabled: () => false }, ["ks"], TODAY);
      check("writes OFF: no stamp, no attempt, no rebuild, no done marker (and the stamp-only pass stamps nothing)",
        ro.writesDisabled === true && off.stamped.length === 0 && off.tries.size === 0 && off.regens.length === 0 && off.marks.length === 0 && so === 0, JSON.stringify(ro));
      const dry = mk({ owed: [owe("dr")] });
      const rd = await revalueHoldersAfterPriceGaps({ accountIds: ["dr"], todayISO: TODAY, deadlineMs: 1e9, deps: { ...dry.deps, regenerate: async () => false } });
      check("a rebuild that wrote nothing (writes went off) marks NO block done — the blocks stay owed",
        dry.marks.length === 0 && rd.writesDisabled === true && rd.revalued === 0 && rd.deferred === 1 && await revaluationPending(dry.deps, ["dr"], TODAY), JSON.stringify(rd));
      // The switch flips OFF mid-run (seen by the pre-charge check, or — a race — by the rebuild itself).
      for (const how of ["pre-check", "rebuild"] as const) {
        const ids = ["f1", "f2", "f3"];
        const flip = mk({ owed: ids.map((id) => owe(id, "2025-10-28")) });
        let checks = 0, calls = 0;
        const flipDeps: RevaluationDeps = { ...flip.deps,
          writesEnabled: how === "pre-check" ? () => ++checks <= 2 : () => true, // on for the run start + the first batch
          regenerate: async (id, f, t) => { calls++; flip.regens.push(`${id}:${f}..${t}`); return how === "rebuild" && calls >= 2 ? false : undefined; } };
        const before = JSON.stringify([...flip.tries.entries()]);
        const rf = await revalueHoldersAfterPriceGaps({ accountIds: ids, deps: flipDeps, deadlineMs: 1e9, todayISO: TODAY });
        const regensAtStop = flip.regens.length;
        const netSingles = [...flip.tries.values()].reduce((a, c) => a + c.single, 0);
        const netBatches = [...flip.tries.values()].reduce((a, c) => a + c.batch, 0);
        check(`switch flips off mid-run (${how}): the WHOLE pass stops at once — no loop of dry rebuilds`,
          rf.writesDisabled === true && regensAtStop === (how === "pre-check" ? 1 : 2), JSON.stringify({ rf, regens: flip.regens }));
        check(`…the dry rebuild is NOT counted: net attempts = only the one real rebuild, no single try charged, nothing abandoned (${how})`,
          netSingles === 0 && netBatches === flip.marks.length && rf.abandonedBlocks === 0 && before === "[]", JSON.stringify([...flip.tries.entries()]));
        // Re-enable: three more passes ⇒ normal progress, no block abandoned, every block done.
        for (let i = 0; i < 3; i++) await revalueHoldersAfterPriceGaps({ accountIds: ids, deps: { ...flip.deps, writesEnabled: () => true }, deadlineMs: 1e9, todayISO: TODAY });
        const total = ids.length * blocksOf(owe("f1", "2025-10-28")).length;
        check(`…after re-enable: normal progress — every block done, none abandoned (${how})`,
          flip.marks.length === total && !(await revaluationPending(flip.deps, ids, TODAY)), `${flip.marks.length}/${total}`);
      }
      const on = mk({ owed: [owe("ks")] });
      const rn = await revalueHoldersAfterPriceGaps({ accountIds: ["ks"], deps: { ...on.deps, writesEnabled: () => true }, deadlineMs: 1e9, todayISO: TODAY });
      check("writes ON: normal stamp, rebuild and done markers", on.stamped.length > 0 && rn.revalued === 1 && on.marks.length === blocksOf(owe("ks")).length);
      const src = readFileSync("lib/prices/price-gap.ts", "utf8");
      check("production: the rebuild returns false (a dry run) when WEALTH_REGENERATION_ENABLED is off, and writesEnabled reads the same switch",
        /if \(!wealthRegenerationEnabled\(\)\) return false;/.test(src) && /writesEnabled: \(\) => process\.env\.WEALTH_REGENERATION_ENABLED === "true"/.test(src));
    }

    // OWNER RULING (live 2026-10-31): an OWED window is off `supported` before any rebuild.
    {
      const events: string[] = [];
      const pend = mk({ owed: [owe("o1", "2026-08-01"), owe("o2", "2026-08-01")], done: blocksOf(owe("o1", "2026-08-01")).slice(0, 2).map((x) => x.key) });
      const d = { ...pend.deps,
        markUnavailable: async (id: string, f: string, t: string) => { events.push(`stamp:${id}:${f}..${t}`); return 1; },
        regenerate: async (id: string, f: string, t: string) => { events.push(`regen:${id}:${f}..${t}`); } };
      const rp = await revalueHoldersAfterPriceGaps({ accountIds: ["o1", "o2"], deps: d, deadlineMs: 1e9, maxAccounts: 1, todayISO: TODAY });
      const firstRegen = events.findIndex((e) => e.startsWith("regen:"));
      const stamps = events.filter((e) => e.startsWith("stamp:"));
      check("owed holders' `supported` rows are stamped BEFORE any rebuild in the pass — even a holder deferred by the cap",
        firstRegen > 0 && events.slice(0, firstRegen).every((e) => e.startsWith("stamp:")) && stamps.some((e) => e.includes(":o1:")) && stamps.some((e) => e.includes(":o2:"))
          && rp.rowsStampedPending === stamps.length && rp.deferred === 1, events.join(" | "));
      const o1Blocks = blocksOf(owe("o1", "2026-08-01"));
      check("…only the OWED blocks are stamped (a done block is not), one write per contiguous range",
        stamps.filter((e) => e.includes(":o1:")).join() === `stamp:o1:${o1Blocks[o1Blocks.length - 1].fromISO}..${o1Blocks[2].toISO}`, stamps.join(" | "));
      const quiet = mk({ owed: [owe("q1")], done: blocksOf(owe("q1")).map((x) => x.key) });
      await revalueHoldersAfterPriceGaps({ accountIds: ["q1"], deps: quiet.deps, deadlineMs: 1e9, todayISO: TODAY });
      check("…a holder with nothing owed is never stamped (no churn)", quiet.stamped.length === 0);
    }

    // FAIRNESS between holders (live: 12 passes rebuilt only the first holder).
    {
      const ids = ["h-a", "h-b", "h-c"];
      const rr = mk({ owed: ids.map((id) => owe(id, "2025-10-28")), perDayMs: 1_000 });
      const r1 = await revalueHoldersAfterPriceGaps({ accountIds: ids, deps: rr.deps, deadlineMs: 400_000, todayISO: TODAY });
      const by = (id: string) => rr.regens.filter((x) => x.startsWith(`${id}:`)).length;
      check("round-robin: EVERY owed holder gets a batch in the same pass (not only the first by id)", ids.every((id) => by(id) >= 1) && rr.at() <= 400_000, JSON.stringify({ r: rr.regens, r1 }));
      for (let i = 0; i < 12; i++) { rr.reset(); await revalueHoldersAfterPriceGaps({ accountIds: ids, deps: rr.deps, deadlineMs: 400_000, todayISO: TODAY }); }
      const doneBy = (id: string) => rr.marks.filter((k) => k.includes(`:${id}:`)).length;
      const n = blocksOf(owe("h-a", "2025-10-28")).length;
      check("…and over passes all three finish (none starved)", ids.every((id) => doneBy(id) === n), JSON.stringify(ids.map(doneBy)));
    }

    // THROUGHPUT (live: 12–13 weeks per pass, then exactly 1 week per pass).
    {
      check("estimator: one slow SMALL batch does not dominate (7 d in 121 s ⇒ ≪ 17 s/day)", estimateRebuildCost([{ days: 7, ms: 121_000 }], 1_500).msPerDay < 6_000);
      const fit = estimateRebuildCost([{ days: 7, ms: 121_000 }, { days: 91, ms: 373_000 }], 1_500);
      check("estimator: two batch sizes separate the per-call overhead from the per-day cost (≈ 100 s + 3 s/day)",
        Math.abs(fit.overheadMs - 100_000) < 1_000 && Math.abs(fit.msPerDay - 3_000) < 50, JSON.stringify(fit));
      check("batchDaysFor subtracts the overhead", batchDaysFor(130_000, { overheadMs: 100_000, msPerDay: 3_000 }) === 10 && batchDaysFor(50_000, { overheadMs: 100_000, msPerDay: 3_000 }) === 0);
      // A cost of 100 s per call + 3 s per day (the live laptop shape); the newest block is a suspect (rebuilt alone first).
      const h = owe("t", "2025-10-28");
      const tb = blocksOf(h);
      const slowDb = mk({ owed: [h] });
      let t = 0;
      const deps = { ...slowDb.deps, now: () => t,
        attemptsOf: async (ks: readonly string[]) => new Map(ks.filter((k) => k === tb[0].key).map((k) => [k, { single: 0, batch: REVALUATION_SUSPECT_HALVINGS }])),
        regenerate: async (id: string, f: string, to: string) => { slowDb.regens.push(`${id}:${f}..${to}`); t += 100_000 + 3_000 * dayCount(f, to); } };
      await revalueHoldersAfterPriceGaps({ accountIds: ["t"], deps, deadlineMs: 1_200_000, todayISO: TODAY });
      const sizes = slowDb.regens.map((x) => { const [f, to] = x.split(":")[1].split(".."); return dayCount(f, to); });
      check("no collapse: after a slow single-block rebuild the next batch is still large (≥ 4 weeks), and the run stays within its deadline",
        sizes[0] <= 7 && sizes.length >= 2 && sizes[1] >= 28 && t <= 1_200_000 + 100_000, JSON.stringify({ sizes, t }));
    }

    // CROSS-HOLDER CREDIT (live: SOL's rebuilds recomputed BTC/ETH days yet left their blocks owed).
    {
      const spacesOf: Record<string, string[]> = { "s-sol": ["qa"], "s-btc": ["qa"], "s-eth": ["qa", "other"] };
      const sp = (id: string): HolderRevaluation => ({ ...owe(id, "2025-10-28"), spaceIds: spacesOf[id] });
      const cr = mk({ owed: [sp("s-sol"), sp("s-btc"), sp("s-eth")], perDayMs: 1_000 });
      // The rebuild REPORTS the Spaces it rebuilt (the production shape).
      const report = (id: string) => ({ rebuiltSpaceIds: spacesOf[id] });
      const crDeps: RevaluationDeps = { ...cr.deps, regenerate: async (id, f, t) => { await cr.deps.regenerate(id, f, t); return report(id); } };
      const rc = await revalueHoldersAfterPriceGaps({ accountIds: ["s-sol", "s-btc", "s-eth"], deps: crDeps, deadlineMs: 1e12, todayISO: TODAY });
      const n = blocksOf(owe("x", "2025-10-28")).length;
      const done = (id: string) => cr.marks.filter((k) => k.includes(`:${id}:`)).length;
      const rebuiltBy = (id: string) => cr.regens.filter((x) => x.startsWith(`${id}:`)).length;
      check("a holder whose Spaces the rebuild REPORTS rebuilt is CREDITED (its blocks done without its own rebuild)",
        done("s-btc") === n && done("s-sol") === n && rc.blocksCredited >= n && Math.min(rebuiltBy("s-sol"), rebuiltBy("s-btc")) === 0, JSON.stringify({ rc, regens: cr.regens.length }));
      check("…a holder in an EXTRA Space the rebuild did not cover is never credited (it rebuilds itself)", done("s-eth") === n && rebuiltBy("s-eth") > 0);

      // REVIEW #185 P3 — no credit behind a swallowed failure, and a holder's own blocks are not "done" if one of its Spaces failed.
      const fl = mk({ owed: [sp("s-btc"), { ...owe("s-sol2", "2025-10-28"), spaceIds: ["qa"] }], perDayMs: 1_000 });
      const flDeps: RevaluationDeps = { ...fl.deps, regenerate: async (id, f, t) => { await fl.deps.regenerate(id, f, t); return { rebuiltSpaceIds: [] }; } }; // "qa" failed
      await revalueHoldersAfterPriceGaps({ accountIds: ["s-btc", "s-sol2"], deps: flDeps, deadlineMs: 1e12, todayISO: TODAY });
      check("a rebuild that REPORTS its Space failed: no credit for anyone, and its own blocks are NOT marked done",
        fl.marks.length === 0, JSON.stringify(fl.marks.slice(0, 3)));
      const vd = mk({ owed: [sp("s-btc"), { ...owe("s-sol3", "2025-10-28"), spaceIds: ["qa"] }], perDayMs: 1_000 }); // regenerate returns void
      await revalueHoldersAfterPriceGaps({ accountIds: ["s-btc", "s-sol3"], deps: vd.deps, deadlineMs: 1e12, todayISO: TODAY });
      check("a rebuild that reports NOTHING earns its own blocks only — never another holder's credit",
        vd.regens.some((x) => x.startsWith("s-btc:")) && vd.regens.some((x) => x.startsWith("s-sol3:")), vd.regens.slice(0, 4).join());

      const pgSrc = readFileSync("lib/prices/price-gap.ts", "utf8"), rhSrc = readFileSync("lib/snapshots/regenerate-history.ts", "utf8");
      check("production: the rebuild reports ONLY Spaces whose regeneration returned (rebuilt, never attempted)",
        /return \{ rebuiltSpaceIds: r\.rebuilt \};/.test(pgSrc) && /regenerateWealthHistoryForAccountsDetailed\(\[accountId\]/.test(pgSrc)
          && /await regenerateWealthHistory\(\{ spaceId[^}]*\}\);\s*rebuilt\.push\(spaceId\);/.test(rhSrc) && /failed\.push\(spaceId\);/.test(rhSrc));
      // Partial-block credit: the batch must CONTAIN the other holder's block, overlap is not enough.
      const pb = mk({ owed: [{ ...owe("a-thu", "2026-10-15"), spaceIds: ["qa"] }, { ...owe("b-mon", "2026-10-12"), spaceIds: ["qa"] }] });
      const pbDeps: RevaluationDeps = { ...pb.deps, regenerate: async (id, f, t) => { await pb.deps.regenerate(id, f, t); return { rebuiltSpaceIds: ["qa"] }; } };
      await revalueHoldersAfterPriceGaps({ accountIds: ["a-thu", "b-mon"], deps: pbDeps, deadlineMs: 1e12, todayISO: "2026-10-25" });
      check("a batch 10-15..10-25 credits B's CONTAINED block (10-19..10-25) but NOT the partly covered 10-12..10-18 — B rebuilds that itself",
        pb.regens[0] === "a-thu:2026-10-15..2026-10-25" && pb.regens.includes("b-mon:2026-10-12..2026-10-18") && !pb.regens.some((x) => x.startsWith("b-mon:2026-10-19")), pb.regens.join());

      // Empty spaceIds: never credited (every() over [] is vacuously true).
      const es = mk({ owed: [{ ...owe("a-q", "2026-10-12"), spaceIds: ["qa"] }, { ...owe("b-none", "2026-10-12"), spaceIds: [] }] });
      const esDeps: RevaluationDeps = { ...es.deps, regenerate: async (id, f, t) => { await es.deps.regenerate(id, f, t); return { rebuiltSpaceIds: ["qa"] }; } };
      await revalueHoldersAfterPriceGaps({ accountIds: ["a-q", "b-none"], deps: esDeps, deadlineMs: 1e12, todayISO: "2026-10-25" });
      check("a holder with EMPTY spaceIds is never credited (it rebuilds itself)", es.regens.some((x) => x.startsWith("b-none:")), es.regens.join());
    }

    // REVIEW #185 P1 — a STALE job-start plan: the rebuild re-plans and stamps the new key; the superseded key is never marked done.
    {
      for (const kase of ["licence-widened", "link-added"] as const) {
        let phase = 1;
        const st = mk({ owed: [] });
        const k1: HolderRevaluation = { accountId: "eth", windowFromISO: "2026-09-01", valuedFromISO: "2026-09-01", windowToISO: TODAY, evidenceKey: "K1", spaceIds: ["qa"] };
        const k2: HolderRevaluation = kase === "licence-widened"
          ? { ...k1, windowFromISO: "2025-11-01", valuedFromISO: "2025-11-01", evidenceKey: "K2" }
          : { ...k1, evidenceKey: "K2", spaceIds: ["qa", "new-space"] }; // a link added mid-pass: a new Space, a new key
        const deps: RevaluationDeps = { ...st.deps, owed: async () => [phase === 1 ? k1 : k2],
          regenerate: async (id, f, t) => { await st.deps.regenerate(id, f, t); return { rebuiltSpaceIds: (phase === 1 ? k1 : k2).spaceIds! }; } };
        const plan = await planRevaluation(deps, ["eth"], TODAY);
        await stampOwedHolders(deps, ["eth"], TODAY, plan);
        const atStart = st.stamped.length;
        phase = 2; // the history pass changed the evidence after the plan was read
        const r = await revalueHoldersAfterPriceGaps({ accountIds: ["eth"], deps, deadlineMs: 1e12, todayISO: TODAY, plan, alreadyStamped: true });
        const after = st.stamped.slice(atStart);
        check(`stale plan (${kase}): the NEW key's window is stamped before the rebuild`,
          after.length > 0 && r.rowsStampedPending > 0 && (kase === "link-added" || after.some((x) => x.startsWith("eth:2025-11-01"))), JSON.stringify({ after, r: r.rowsStampedPending }));
        check(`…and only the NEW key's blocks are marked done — never the superseded K1 (${kase})`,
          st.marks.length > 0 && st.marks.every((m) => m.startsWith("K2:")), JSON.stringify(st.marks.slice(0, 3)));
      }
    }

    // LARGE WINDOW: batches sized to the time left, newest first, progress across runs, nothing rebuilt twice.
    const big = mk({ owed: [owe("x", "2025-10-28")], perDayMs: 1_000 });
    const DEADLINE = 150_000;
    const r1 = await revalueHoldersAfterPriceGaps({ accountIds: ["x"], deps: big.deps, deadlineMs: DEADLINE, todayISO: TODAY });
    check("a batch is sized to fit the time left: the run never runs past its deadline", big.at() <= DEADLINE && big.regens.length >= 2, `${big.at()} ${big.regens.join()}`);
    check("…NEWEST first (the visible cliff first)", big.regens[0].endsWith(`..${TODAY}`), big.regens[0]);
    check("…stopped part-way: deferred, only finished blocks marked", r1.deferred === 1 && r1.chunksRebuilt === big.marks.length && big.marks.length < blocksOf(owe("x", "2025-10-28")).length, JSON.stringify(r1));
    big.reset();
    const r2 = await revalueHoldersAfterPriceGaps({ accountIds: ["x"], deps: big.deps, deadlineMs: 1e9, todayISO: TODAY });
    const covered = big.regens.reduce((n, x) => { const [f, t] = x.split(":")[1].split(".."); return n + dayCount(f, t); }, 0);
    check("…the next run finishes; every day of the 369 rebuilt exactly once", r2.revalued === 1 && covered === 369 && big.marks.length === blocksOf(owe("x", "2025-10-28")).length, `${covered} ${JSON.stringify(r2)}`);
    const n = big.regens.length;
    const r3 = await revalueHoldersAfterPriceGaps({ accountIds: ["x"], deps: big.deps, deadlineMs: 1e9, todayISO: TODAY });
    check("…and a third run is a no-op (idempotent)", r3.alreadyRevalued === 1 && r3.chunksRebuilt === 0 && big.regens.length === n);
    check("revaluationPending: true while a block is owed, false once all are",
      (await revaluationPending(mk({ owed: [owe("q")] }).deps, ["q"], TODAY)) === true && (await revaluationPending(big.deps, ["x"], TODAY)) === false);

    // REVIEW (optional): keys anchored to a fixed grid — a moved window start re-keys nothing it overlaps.
    const kA = revaluationBlocks("k", "2025-10-28", TODAY), kB = revaluationBlocks("k", "2025-06-01", TODAY);
    check("block keys sit on the fixed Monday grid and do not depend on the window start",
      kA.slice(0, -1).every((x) => kB.some((y) => y.key === x.key && y.fromISO === x.fromISO && y.toISO === x.toISO))
        && kA.every((x) => new Date(`${x.key.split(":").pop()}T00:00:00Z`).getUTCDay() === 1) && kA[kA.length - 1].fromISO === "2025-10-28");
    const batch = planRevaluationBatch(kA, 20);
    const iso = planRevaluationBatch(kA, 10_000, (x) => (x === kA[2] ? 1 : Infinity));
    check("planRevaluationBatch: an isolated block is never joined — the batch stops before it, and an isolated head goes alone",
      iso!.blocks.length === 2 && iso!.blocks[1] === kA[1] && planRevaluationBatch(kA.slice(2), 10_000, (x) => (x === kA[2] ? 1 : Infinity))!.blocks.length === 1);
    check("planRevaluationBatch: contiguous newest blocks within maxDays, at least one block", batch !== null && batch.toISO === TODAY && dayCount(batch.fromISO, batch.toISO) <= 20 && planRevaluationBatch(kA, 0)!.blocks.length === 1);
  }

  console.log("P1 2026-10-31 — the holder's evidence state decides; existing rows are in the window");
  {
    const base = {
      accountId: "btc", nativeLicences: new Map([["BTC", "2025-01-01"]]), allLicences: new Map([["BTC", "2025-01-01"]]),
      floors: new Map([["BTC", "2025-10-28"]]), snapshotMinBySpace: new Map([["qa", "2026-09-27"]]), spaceIds: ["qa"],
    };
    const h = holderRevaluationFor(base);
    check("the live case: valued-from 2025-10-28 before the earliest row ⇒ window from 2025-10-28 (prefix AND existing rows)",
      h?.windowFromISO === "2025-10-28" && h.valuedFromISO === "2025-10-28", JSON.stringify(h));
    const covered = holderRevaluationFor({ ...base, snapshotMinBySpace: new Map([["qa", "2025-10-28"]]) });
    check("…prefix already filled (the state after R1c): STILL owed — the stale interior rows are in the window (was: nothing owed)",
      covered !== null && covered.windowFromISO === "2025-10-28" && revaluationOwedFromISO({ licences: base.nativeLicences, floors: base.floors, earliestSnapshotISO: "2025-10-28" }) === null);
    const earlier = holderRevaluationFor({ ...base, snapshotMinBySpace: new Map([["qa", "2024-06-01"]]) });
    check("rows older than valued-from are in the window too (they must turn `unavailable`, not stay `supported`)", earlier?.windowFromISO === "2024-06-01");
    const unpriced = holderRevaluationFor({ ...base, floors: new Map() });
    check("an unpriced holder is NOT excused: its existing rows are re-decided (the day rule refuses them, never $0)",
      unpriced !== null && unpriced.valuedFromISO === null && unpriced.windowFromISO === "2026-09-27");
    check("no rows in its Spaces ⇒ not owed here (the initial build is the normal path's)", holderRevaluationFor({ ...base, snapshotMinBySpace: new Map() }) === null);
    check("no licence ⇒ not owed", holderRevaluationFor({ ...base, nativeLicences: new Map(), allLicences: new Map() }) === null);
    const k = (o: Partial<typeof base>) => holderRevaluationFor({ ...base, ...o })!.evidenceKey;
    const k0 = k({});
    check("same evidence ⇒ same key (re-run owes nothing)", k0 === k({}) && k0.startsWith("revaluation:v2:btc:"));
    check("licence widening ⇒ new key", k({ nativeLicences: new Map([["BTC", "2024-01-01"]]), allLicences: new Map([["BTC", "2024-01-01"]]) }) !== k0);
    check("new price coverage (floor moved) ⇒ new key", k({ floors: new Map([["BTC", "2025-06-01"]]) }) !== k0);
    check("new Space link ⇒ new key", k({ spaceIds: ["qa", "other"], snapshotMinBySpace: new Map([["qa", "2026-09-27"], ["other", "2026-01-01"]]) }) !== k0);
    check("a token licence (SPL/ERC-20) changes the key but never the native floor",
      k({ allLicences: new Map([["BTC", "2025-01-01"], ["usdc", "2026-03-01"]]) }) !== k0
        && holderRevaluationFor({ ...base, allLicences: new Map([["BTC", "2025-01-01"], ["usdc", "2026-03-01"]]) })!.valuedFromISO === "2025-10-28");
    const tokenOnly = holderRevaluationFor({ ...base, nativeLicences: new Map(), allLicences: new Map([["usdc", "2026-03-01"]]) });
    check("a token-only licence still owes the existing-row repair (native and token parity)", tokenOnly !== null && tokenOnly.windowFromISO === "2026-09-27");
    check("block keys are stable as today advances",
      revaluationBlocks("k", "2025-10-28", "2026-10-31").map((c) => c.key).slice(1).join() === revaluationBlocks("k", "2025-10-28", "2026-11-01").map((c) => c.key).slice(-revaluationBlocks("k", "2025-10-28", "2026-10-31").length + 1).join());
  }

  console.log("wiring");
  {
    const src = readFileSync("lib/prices/price-gap.ts", "utf8");
    check("acquires ONLY through the canonical backfill (no second fetcher, no direct archive write)",
      /backfillPricesForInstruments\(/.test(src) && !/writeBatch|priceObservation\.create/.test(src));
    check("reads RAW_CLOSE only for the floor", /basis: PriceBasis\.RAW_CLOSE/.test(src) && !/INTRADAY/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));
    check("licences come from the one licence reader", /licensedInterval\(coverage\)/.test(src));
    check("no global db import (client parameter)", !/from "@\/lib\/db"/.test(src));
    const job = readFileSync("jobs/sol-history-backfill.ts", "utf8");
    check("the worker runs the gap pass BEFORE its regeneration", job.indexOf("await priceGapsFor(w)") > 0 && job.indexOf("await priceGapsFor(w)") < job.indexOf("await deps.regenerate(w.accountId"));
    const sweep = readFileSync("jobs/sync-crypto.ts", "utf8");
    // REVIEW FIX 2: AFTER — a gap fill must never widen the sweep's measured window for every account.
    check("the sweep runs the gap pass AFTER its ordinary regeneration, bounded by the wake",
      sweep.indexOf("revalueHoldersAfterPriceGaps(") > sweep.indexOf("await regenerateWealthHistoryForAccounts(") && sweep.indexOf("await regenerateWealthHistoryForAccounts(") > 0
        // …the WAKE is the dispatcher's own instant, never another cron's JobRun (jobs/wake-deadline-anchor.test.ts).
        && /deadlineMs: revaluationDeadlineMs\(runStartedAt\.getTime\(\), currentBudgetStartedAtMs\(\)\)/.test(sweep) && !/acquireHistoricalPriceGaps\(/.test(sweep));
  }

  console.log("token licences never block native revaluation (#120 review)");
  {
    // A SOL wallet: native SOL licensed, plus an airdropped spam token whose SPL history licence committed.
    const rows = [
      { financialAccountId: "acct", instrumentId: "sol", token: false, kind: "COMPLETE", coveredFromDate: new Date("2026-01-01T00:00:00Z"), coveredToDate: new Date("2026-10-27T00:00:00Z"), caveats: [], source: "solana-rpc" },
      { financialAccountId: "acct", instrumentId: "spam", token: true, kind: "COMPLETE", coveredFromDate: new Date("2026-03-01T00:00:00Z"), coveredToDate: new Date("2026-10-27T00:00:00Z"), caveats: [], source: "solana-rpc-spl+account-continuity" },
    ];
    // Fake client honouring the relation filter the way Postgres would: NOT { aliases: { some: token } } drops token instruments.
    const fake = { positionCoverage: { findMany: async (q: { where: { instrument?: { NOT?: { aliases?: unknown } } } }) =>
      rows.filter((r) => !(q.where.instrument?.NOT?.aliases && r.token)) } };
    const lics = await cryptoHolderLicences(fake as unknown as Parameters<typeof cryptoHolderLicences>[0], ["acct"]);
    check("holder licences exclude token instruments (NOT_TOKEN_INSTRUMENT)", lics.length === 1 && lics[0].instrumentId === "sol", JSON.stringify(lics));
    // And what that protects: with the spam licence counted, the unpriced token leaves NO floor ⇒ no revaluation.
    const floors = new Map([["sol", "2025-11-01"]]); // the spam token has no RAW_CLOSE
    const owedNative = revaluationOwedFromISO({ licences: new Map(lics.map((l) => [l.instrumentId, l.licensedFromISO])), floors, earliestSnapshotISO: "2026-06-01" });
    const owedWithToken = revaluationOwedFromISO({ licences: new Map([["sol", "2026-01-01"], ["spam", "2026-03-01"]]), floors, earliestSnapshotISO: "2026-06-01" });
    check("…so the native wallet is still revalued when its price floor deepens (a token licence would block it)",
      owedNative !== null && owedWithToken === null, `${JSON.stringify(owedNative)} vs ${JSON.stringify(owedWithToken)}`);
  }

  console.log("holderRevaluations (I/O, fake client): token licences join the fingerprint, never the floor");
  {
    const cov = (acct: string, inst: string, token: boolean, from: string) => ({ financialAccountId: acct, instrumentId: inst, token, kind: "COMPLETE",
      coveredFromDate: new Date(`${from}T00:00:00Z`), coveredToDate: new Date("2026-10-30T00:00:00Z"), caveats: [], source: "rpc" });
    const mkClient = (rows: ReturnType<typeof cov>[]) => ({
      priceObservation: { groupBy: async (q: { where: { instrumentId: { in: string[] } } }) =>
        q.where.instrumentId.in.filter((id) => id === "eth").map((id) => ({ instrumentId: id, _min: { date: new Date("2025-10-28T00:00:00Z") } })) },
      spaceAccountLink: { findMany: async () => [{ financialAccountId: "w", spaceId: "qa" }] },
      spaceSnapshot: { groupBy: async () => [{ spaceId: "qa", _min: { date: new Date("2026-09-27T00:00:00Z") } }] },
      // resolveEvidenceFloor's reads (no evidence ⇒ no floor) and the contribution read (no rows ⇒ unknown ⇒ could contribute).
      transaction: { groupBy: async () => [] },
      investmentEvent: { groupBy: async () => [] },
      investmentEventCoverage: { groupBy: async () => [] },
      positionObservation: { groupBy: async () => [], findMany: async () => [] },
      positionCoverage: { groupBy: async () => [],
        findMany: async (q: { where: { financialAccountId: { in: string[] }; instrument?: { NOT?: { aliases?: unknown } } } }) =>
          rows.filter((r) => q.where.financialAccountId.in.includes(r.financialAccountId) && !(q.where.instrument?.NOT?.aliases && r.token)) },
    }) as unknown as Parameters<typeof holderRevaluations>[0];
    const nativeOnly = await holderRevaluations(mkClient([cov("w", "eth", false, "2025-01-01")]), ["w"]);
    const withToken = await holderRevaluations(mkClient([cov("w", "eth", false, "2025-01-01"), cov("w", "usdc", true, "2026-03-01")]), ["w"]);
    check("native only: window from valued-from (2025-10-28), keyed", nativeOnly.length === 1 && nativeOnly[0].windowFromISO === "2025-10-28" && nativeOnly[0].valuedFromISO === "2025-10-28", JSON.stringify(nativeOnly));
    check("a new (unpriced) token licence: NEW key — the rows are re-decided — but valued-from is unchanged",
      withToken.length === 1 && withToken[0].evidenceKey !== nativeOnly[0].evidenceKey && withToken[0].valuedFromISO === "2025-10-28", JSON.stringify(withToken));
  }

  console.log("production stamp (fake client): status only, estimate rows, supported AND null, membership-blocked days excluded");
  {
    const wheres: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const fake = {
      spaceAccountLink: { findMany: async (q: { where: { status?: string; financialAccountId?: string } }) => (q.where.financialAccountId ? [{ spaceId: "qa" }] : []) },
      spaceSnapshot: { updateMany: async (q: { where: Record<string, unknown>; data: Record<string, unknown> }) => { wheres.push(q); return { count: 3 }; } },
    } as unknown as Parameters<typeof prismaRevaluationDeps>[0];
    const n = await prismaRevaluationDeps(fake).markUnavailable!("a", "2026-01-05", "2026-01-11");
    const w = wheres[0];
    check("one write; estimate rows only; rows reading `supported` OR NULL (asserted `none`) qualify; ONLY the status column is written (values preserved)",
      n === 3 && wheres.length === 1 && w.where.isEstimated === true && w.where.spaceId === "qa"
        && JSON.stringify(w.where.OR) === '[{"cryptoValuationStatus":null},{"cryptoValuationStatus":{"not":"unavailable"}}]'
        && JSON.stringify(w.data) === '{"cryptoValuationStatus":"unavailable"}', JSON.stringify(wheres));
    const tryFake = { apiUsageCounter: { groupBy: async () => [
      { metric: "k1", unit: "revaluation_tries", _sum: { count: BigInt(2) } }, { metric: "k1", unit: "revaluation_dry_tries", _sum: { count: BigInt(1) } },
      { metric: "k1", unit: "revaluation_batch_tries", _sum: { count: BigInt(3) } }, { metric: "k1", unit: "revaluation_dry_batch_tries", _sum: { count: BigInt(3) } },
    ] } } as unknown as Parameters<typeof prismaRevaluationDeps>[0];
    const tc = (await prismaRevaluationDeps(tryFake).attemptsOf!(["k1"])).get("k1");
    check("production attempt counts: a dry rebuild's try is CANCELLED (single 2−1, batch 3−3)", tc?.single === 1 && tc?.batch === 0, JSON.stringify(tc));
    const blocked = new Set(["2026-01-07", "2026-01-08"]);
    check("unblockedRanges: a membership-blocked day is never stamped (the rebuild skips it, nothing would restore it)",
      JSON.stringify(unblockedRanges("2026-01-05", "2026-01-11", (d) => blocked.has(d))) === '[{"fromISO":"2026-01-05","toISO":"2026-01-06"},{"fromISO":"2026-01-09","toISO":"2026-01-11"}]');
    const src = readFileSync("lib/prices/price-gap.ts", "utf8");
    check("wiring: the production stamp excludes days via the binding's own membership rule", /unblockedRanges\(fromISO, toISO, \(d\) => membershipChangedOn\(windows, d\)\)/.test(src) && /loadRevokedLinkWindows\(/.test(src));
  }

  console.log("review #183: exact window, contribution spans, estimator floor, batch bound");
  {
    // An ETH wallet whose first evidence is 2026-06 linked to a SOL Space with rows since 2025-10.
    const h = holderRevaluationFor({ accountId: "eth", nativeLicences: new Map([["ETH", "2026-06-10"]]), allLicences: new Map([["ETH", "2026-06-10"]]),
      floors: new Map([["ETH", "2025-10-28"]]), snapshotMinBySpace: new Map([["qa", "2025-10-28"]]), spaceIds: ["qa"], evidenceFloorISO: "2026-06-10", ceilingISO: "2026-10-30" });
    check("the window starts at the holder's EVIDENCE floor (2026-06-10), not the Space's first row: 8 months of SOL rows are outside it",
      h?.windowFromISO === "2026-06-10" && h.windowToISO === "2026-10-30" && revaluationBlocks(h.evidenceKey, h.windowFromISO, h.windowToISO)[0].toISO === "2026-10-30", JSON.stringify(h));
    const spans = holderContributionSpans([
      { instrumentId: "eth", dateISO: "2026-06-10", quantity: 1 }, { instrumentId: "eth", dateISO: "2026-07-01", quantity: 0 }, { instrumentId: "eth", dateISO: "2026-08-01", quantity: 2 },
    ], "2026-06-10", "2026-08-10");
    check("contribution spans: a confirmed-zero period (drained) is excluded — never stamp a day the holder held nothing",
      JSON.stringify(spans) === '[{"fromISO":"2026-06-10","toISO":"2026-06-30"},{"fromISO":"2026-08-01","toISO":"2026-08-10"}]', JSON.stringify(spans));
    check("…a day before the first observation is unknown ⇒ could contribute; a token not yet observed contributes nothing",
      JSON.stringify(holderContributionSpans([{ instrumentId: "eth", dateISO: "2026-06-12", quantity: 0 }, { instrumentId: "tok", dateISO: "2026-06-14", quantity: 5 }], "2026-06-10", "2026-06-15"))
        === '[{"fromISO":"2026-06-10","toISO":"2026-06-11"},{"fromISO":"2026-06-14","toISO":"2026-06-15"}]');
    const hb = { ...h!, contributes: spans };
    const r = holderStampRanges(hb, revaluationBlocks(hb.evidenceKey, "2026-06-10", "2026-08-10"));
    check("stamp ranges = owed blocks ∩ contribution spans", JSON.stringify(r) === JSON.stringify(spans), JSON.stringify(r));

    const noisy = estimateRebuildCost([{ days: 7, ms: 140_000 }, { days: 14, ms: 120_000 }], 1_500);
    check("estimator: a noisy pair (negative slope) is floored at the shrunk prior, not 1 ms/day — the next batch is not the whole window",
      noisy.msPerDay >= 1_500 && batchDaysFor(200_000, noisy) < 200, JSON.stringify(noisy));

    // P3 — the per-pass bound is checked BEFORE an attempt is charged.
    const many = revaluationBlocks("revaluation:v2:m:k", "2014-01-01", TODAY_P3);
    let attempts = 0, rebuilt = 0;
    await revalueHoldersAfterPriceGaps({ accountIds: ["m", "m2", "m3"], todayISO: TODAY_P3, deadlineMs: 1e12, deps: {
      acquireGaps: async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null }),
      // three holders: a round of several holders must not overshoot the bound either
      owed: async () => ["m", "m2", "m3"].map((id) => ({ accountId: id, windowFromISO: "2014-01-01", valuedFromISO: "2014-01-01", evidenceKey: `revaluation:v2:${id}:k` })),
      revaluedAlready: async () => new Set(),
      markRevalued: async () => {},
      attemptsOf: async (ks) => new Map(ks.map((k) => [k, { single: 0, batch: REVALUATION_SUSPECT_HALVINGS }])), // every block rebuilt alone
      markAttempt: async () => { attempts++; },
      regenerate: async () => { rebuilt++; },
      now: () => 0,
    } });
    check(`the ${REVALUATION_MAX_BATCHES_PER_PASS}-call bound trips BEFORE charging: attempts === rebuilds === the bound (${many.length} blocks owed)`,
      many.length > REVALUATION_MAX_BATCHES_PER_PASS && attempts === REVALUATION_MAX_BATCHES_PER_PASS && rebuilt === REVALUATION_MAX_BATCHES_PER_PASS, `${attempts} ${rebuilt}`);
  }

  console.log("PERF 2026-10-31: planning reads are batched (constant in the number of holders) and match the canonical floor reader");
  {
    // An in-memory store for the five evidence sources; the fake HONOURS `where` (deletedAt, supersededById,
    // outcome, reconciliation, kind, token instrument), so a filter the batched reader drops is caught.
    type EvRow = { financialAccountId: string; d: string } & Record<string, unknown>;
    const ev: Record<string, EvRow[]> = {
      transaction: [{ financialAccountId: "a1", d: "2025-03-01", deletedAt: null }, { financialAccountId: "a2", d: "2026-06-10", deletedAt: null },
        { financialAccountId: "a2", d: "2020-01-01", deletedAt: new Date() }], // a DELETED tx must not count
      investmentEvent: [{ financialAccountId: "a1", d: "2024-11-05", deletedAt: null, supersededById: null },
        { financialAccountId: "a1", d: "2019-01-01", deletedAt: null, supersededById: "x" }], // a SUPERSEDED event must not count
      investmentEventCoverage: [{ financialAccountId: "a4", d: "2023-02-02", outcome: "PARTIAL", paginationReconciled: true }], // not COMPLETE ⇒ ignored
      positionObservation: [{ financialAccountId: "a2", d: "2026-05-01", deletedAt: null, supersededById: null },
        { financialAccountId: "a3", d: "2022-01-01", deletedAt: null, supersededById: null },
        { financialAccountId: "a3", d: "2018-01-01", deletedAt: new Date(), supersededById: null }],
      positionCoverage: [{ financialAccountId: "a3", d: "2021-06-01", kind: "COMPLETE", token: true },
        { financialAccountId: "a2", d: "2017-01-01", kind: "COMPLETE", token: false }], // a NATIVE licence is not a token licence
    };
    const field: Record<string, string> = { transaction: "date", investmentEvent: "date", investmentEventCoverage: "earliestReturnedDate", positionObservation: "date", positionCoverage: "coveredFromDate" };
    const matches = (r: EvRow, where: Record<string, unknown>, t: string): boolean => Object.entries(where).every(([k, v]) => {
      if (k === "financialAccountId") return (v as { in: string[] }).in.includes(r.financialAccountId);
      if (k === field[t]) return r.d !== null; // "{ not: null }" on the dated field
      if (k === "instrument") return r.token === true; // IS_TOKEN_INSTRUMENT
      if (v && typeof v === "object" && "in" in (v as object)) return (v as { in: unknown[] }).in.includes(r[k]);
      if (v === null) return r[k] === null || r[k] === undefined;
      return r[k] === v;
    });
    let queries = 0;
    const mkEv = () => Object.fromEntries(Object.keys(ev).map((t) => [t, {
      aggregate: async (q: { where: Record<string, unknown> }) => {
        queries++;
        const rows = ev[t].filter((r) => matches(r, q.where, t)).map((r) => r.d).sort();
        return { _min: { [field[t]]: rows[0] ? new Date(`${rows[0]}T00:00:00Z`) : null } };
      },
      groupBy: async (q: { where: Record<string, unknown> }) => {
        queries++;
        const rows = ev[t].filter((r) => matches(r, q.where, t));
        const ids = [...new Set(rows.map((r) => r.financialAccountId))];
        return ids.map((id) => ({ financialAccountId: id, _min: { [field[t]]: new Date(`${rows.filter((r) => r.financialAccountId === id).map((r) => r.d).sort()[0]}T00:00:00Z`) } }));
      },
    }]));
    const { resolveEvidenceFloor, resolveEvidenceFloorsByAccount } = await import("@/lib/snapshots/historical-work-window");
    const c = mkEv() as unknown as Parameters<typeof resolveEvidenceFloor>[0];
    const batched = await resolveEvidenceFloorsByAccount(c, ["a1", "a2", "a3", "a4"]);
    const batchQueries = queries;
    let same = true;
    for (const id of ["a1", "a2", "a3", "a4"]) if ((await resolveEvidenceFloor(c, [id])) !== batched.get(id)) same = false;
    check("resolveEvidenceFloorsByAccount: per account EQUAL to resolveEvidenceFloor (a1 2024-11-05, a2 2026-05-01, a3 2021-06-01, a4 none)",
      same && batched.get("a1") === "2024-11-05" && batched.get("a2") === "2026-05-01" && batched.get("a3") === "2021-06-01" && batched.get("a4") === null, JSON.stringify([...batched]));
    check("…in FIVE queries for four accounts (one per source), not five per account", batchQueries === 5, String(batchQueries));

    // holderRevaluations: query count does not grow with the number of holders.
    const countFor = async (n: number) => {
      let q = 0;
      const ids = Array.from({ length: n }, (_, i) => `w${i}`);
      const tick = <T,>(v: T) => { q++; return v; };
      const fake = {
        positionCoverage: {
          findMany: async () => tick(ids.map((id) => ({ financialAccountId: id, instrumentId: "eth", kind: "COMPLETE", coveredFromDate: new Date("2025-01-01T00:00:00Z"), coveredToDate: new Date("2026-10-30T00:00:00Z"), caveats: [], source: "rpc" }))),
          groupBy: async () => tick([]),
        },
        priceObservation: { groupBy: async () => tick([{ instrumentId: "eth", _min: { date: new Date("2025-10-28T00:00:00Z") } }]) },
        spaceAccountLink: { findMany: async () => tick(ids.map((id) => ({ financialAccountId: id, spaceId: "qa" }))) },
        spaceSnapshot: { groupBy: async () => tick([{ spaceId: "qa", _min: { date: new Date("2025-10-28T00:00:00Z") } }]) },
        transaction: { groupBy: async () => tick([]) }, investmentEvent: { groupBy: async () => tick([]) }, investmentEventCoverage: { groupBy: async () => tick([]) },
        positionObservation: { groupBy: async () => tick([]), findMany: async () => tick([]) },
      } as unknown as Parameters<typeof holderRevaluations>[0];
      const hs = await holderRevaluations(fake, ids);
      return { q, n: hs.length };
    };
    const c3 = await countFor(3), c30 = await countFor(30);
    check("holderRevaluations: the SAME number of queries for 3 holders and for 30 (no N+1)", c3.n === 3 && c30.n === 30 && c3.q === c30.q, JSON.stringify({ c3, c30 }));
  }

  if (failures > 0) { console.error(`\nprice-gap: ${failures} failed.`); process.exit(1); }
  console.log("\nprice-gap: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
