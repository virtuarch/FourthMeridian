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
  type HolderLicence, type InstrumentPriceFacts, type PriceGapDeps,
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
    check("the sweep runs the gap pass before resolving its history window", sweep.indexOf("acquireHistoricalPriceGaps(") > 0 && sweep.indexOf("acquireHistoricalPriceGaps(") < sweep.indexOf("await resolveHistoricalWorkWindow({\n              financialAccountIds: historyAccountIds"));
  }

  if (failures > 0) { console.error(`\nprice-gap: ${failures} failed.`); process.exit(1); }
  console.log("\nprice-gap: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
