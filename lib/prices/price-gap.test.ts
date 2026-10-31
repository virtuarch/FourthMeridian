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
  type HolderLicence, type HolderRevaluation, type InstrumentPriceFacts, type PriceGapDeps, type RevaluationDeps,
} from "./price-gap";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const YESTERDAY = "2026-10-27";
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
        markAttempt: async (k, kind) => { const c = tries.get(k) ?? { single: 0, batch: 0 }; c[kind]++; tries.set(k, c); },
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
    check("ONLY the owed holders are regenerated — through TODAY, existing rows included (not clamped to the earliest snapshot)",
      w.regens.join() === "acct-03:2026-09-27..2026-10-31,acct-17:2026-09-27..2026-10-31,acct-29:2026-09-27..2026-10-31" && r.revalued === 3, w.regens.join());
    const many = mk({ owed: Array.from({ length: 14 }, (_, i) => owe(`h${String(i).padStart(2, "0")}`)) });
    const rm = await revalueHoldersAfterPriceGaps({ accountIds: Array.from({ length: 14 }, (_, i) => `h${String(i).padStart(2, "0")}`), deps: many.deps, deadlineMs: 1e9, maxAccounts: 10, todayISO: TODAY });
    check("per-run account cap: 10 revalued, 4 deferred (still owed on disk, unmarked)",
      rm.revalued === 10 && rm.deferred === 4 && !many.marks.some((k) => /:h1[0-3]:/.test(k)) && many.marks.length === 10 * blocksOf(owe("h00")).length);
    const slow = mk({ owed: [owe("a"), owe("b"), owe("c")], regenMs: 50_000 });
    const rs = await revalueHoldersAfterPriceGaps({ accountIds: ["a", "b", "c"], deps: slow.deps, deadlineMs: 120_000, todayISO: TODAY });
    check("wake time: stops starting rebuilds with < 60 s left and defers the rest", rs.revalued === 2 && rs.deferred === 1, JSON.stringify(rs));
    const late = mk({ owed: [owe("a")] });
    const rl = await revalueHoldersAfterPriceGaps({ accountIds: ["a"], deps: late.deps, deadlineMs: REVALUATION_RESERVE_MS - 1, todayISO: TODAY });
    check("too little wake left ⇒ the whole pass is skipped (no gap request, no rebuild)", rl.skippedForTime && rl.priceGaps === null && late.regens.length === 0);
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
    check("…the next run REDOES the same range — block by block (each charged to itself) — and marks it done",
      k2.revalued === 1 && redone.length === nBlocks && redone[0].endsWith(`..${TODAY}`) && redone[redone.length - 1].startsWith("k:2026-09-27..")
        && killed.marks.length === nBlocks, JSON.stringify(killed.regens));
    const k3 = await revalueHoldersAfterPriceGaps({ accountIds: ["k"], deps: killed.deps, deadlineMs: 1e9, todayISO: TODAY });
    check("…then a no-op", k3.alreadyRevalued === 1 && killed.regens.length === nBlocks + 1);

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
    check(`…after ${REVALUATION_MAX_ATTEMPTS} failures ONLY the bad block is abandoned and its rows stamped unavailable (never left supported)`,
      bad.stamped.length >= 1 && bad.stamped.every((x) => x === `b:${badBlock.fromISO}..${badBlock.toISO}`) && bad.tries.get(badBlock.key)?.single === REVALUATION_MAX_ATTEMPTS,
      JSON.stringify({ s: bad.stamped, t: bad.tries.get(badBlock.key) }));
    const regensBefore = bad.regens.length;
    const r4b = await revalueHoldersAfterPriceGaps({ accountIds: ["b"], deps: bad.deps, deadlineMs: 1e9, todayISO: TODAY });
    check("…a later run never rebuilds it again (no poison loop), reports it abandoned, re-stamps idempotently, owes nothing",
      bad.regens.length === regensBefore && r4b.abandonedBlocks === 1 && r4b.rowsStampedUnavailable > 0 && !(await revaluationPending(bad.deps, ["b"], TODAY)), JSON.stringify(r4b));

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
    const iso = planRevaluationBatch(kA, 10_000, (x) => x === kA[2]);
    check("planRevaluationBatch: an isolated block is never joined — the batch stops before it, and an isolated head goes alone",
      iso!.blocks.length === 2 && iso!.blocks[1] === kA[1] && planRevaluationBatch(kA.slice(2), 10_000, (x) => x === kA[2])!.blocks.length === 1);
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
        && /deadlineMs: \(wake \? wake\.startedAt\.getTime\(\) : runStartedAt\.getTime\(\)\) \+ WAKE_SAFE_MS/.test(sweep) && !/acquireHistoricalPriceGaps\(/.test(sweep));
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
      positionCoverage: { findMany: async (q: { where: { financialAccountId: { in: string[] }; instrument?: { NOT?: { aliases?: unknown } } } }) =>
        rows.filter((r) => q.where.financialAccountId.in.includes(r.financialAccountId) && !(q.where.instrument?.NOT?.aliases && r.token)) },
      priceObservation: { groupBy: async (q: { where: { instrumentId: { in: string[] } } }) =>
        q.where.instrumentId.in.filter((id) => id === "eth").map((id) => ({ instrumentId: id, _min: { date: new Date("2025-10-28T00:00:00Z") } })) },
      spaceAccountLink: { findMany: async () => [{ financialAccountId: "w", spaceId: "qa" }] },
      spaceSnapshot: { groupBy: async () => [{ spaceId: "qa", _min: { date: new Date("2026-09-27T00:00:00Z") } }] },
    }) as unknown as Parameters<typeof holderRevaluations>[0];
    const nativeOnly = await holderRevaluations(mkClient([cov("w", "eth", false, "2025-01-01")]), ["w"]);
    const withToken = await holderRevaluations(mkClient([cov("w", "eth", false, "2025-01-01"), cov("w", "usdc", true, "2026-03-01")]), ["w"]);
    check("native only: window from valued-from (2025-10-28), keyed", nativeOnly.length === 1 && nativeOnly[0].windowFromISO === "2025-10-28" && nativeOnly[0].valuedFromISO === "2025-10-28", JSON.stringify(nativeOnly));
    check("a new (unpriced) token licence: NEW key — the rows are re-decided — but valued-from is unchanged",
      withToken.length === 1 && withToken[0].evidenceKey !== nativeOnly[0].evidenceKey && withToken[0].valuedFromISO === "2025-10-28", JSON.stringify(withToken));
  }

  if (failures > 0) { console.error(`\nprice-gap: ${failures} failed.`); process.exit(1); }
  console.log("\nprice-gap: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
