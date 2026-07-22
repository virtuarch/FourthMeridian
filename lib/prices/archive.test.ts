/**
 * lib/prices/archive.test.ts
 *
 * A8-1 — archive doctrine tests. Standalone tsx script:
 *
 *     npx tsx lib/prices/archive.test.ts
 *
 * The Prisma binding itself needs a database and is validated on real data, but
 * its idempotency-by-canonical-key and closed-date doctrine are pure and tested
 * here: canonicalizePriceBatch (the within-batch dedup + price validation that
 * pairs with the DB's skipDuplicates) and the config guards (closed-date,
 * ISO-date, walk-back arithmetic). No DB import.
 */

import { PriceBasis } from "@prisma/client";
import { canonicalizePriceBatch } from "./archive";
import {
  assertClosedDateISO,
  assertISODate,
  daysBetweenISO,
  minusDaysISO,
  yesterdayUTCISO,
} from "./config";
import type { PriceResult } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const r = (instrumentId: string, dateISO: string, price: number, basis: PriceBasis = PriceBasis.RAW_CLOSE, currency = "USD"): PriceResult =>
  ({ instrumentId, dateISO, basis, price, currency });

function main(): void {
  // ── 1. Idempotent archive writes: dedup by canonical key ──────────────────
  console.log("1. canonicalizePriceBatch — duplicates skipped by canonical key");
  {
    const out = canonicalizePriceBatch([
      r("i1", "2026-06-05", 200),
      r("i1", "2026-06-05", 200),           // exact duplicate — collapsed
      r("i1", "2026-06-05", 201),           // same key, different price — first wins
      r("i1", "2026-06-05", 199, PriceBasis.ADJUSTED_CLOSE), // different basis — kept
      r("i2", "2026-06-05", 50),            // different instrument — kept
    ]);
    check("one row per (instrument, date, basis)", out.length === 3);
    check("first value wins on a key collision", out.find((x) => x.instrumentId === "i1" && x.basis === PriceBasis.RAW_CLOSE)?.price === 200);
    check("distinct basis on the same date is preserved", out.some((x) => x.basis === PriceBasis.ADJUSTED_CLOSE && x.price === 199));
    check("distinct instrument is preserved", out.some((x) => x.instrumentId === "i2"));
  }

  // ── 2. Non-defensible prices dropped (never stored as a real price) ───────
  console.log("2. Price validation (positive-finite only)");
  {
    const out = canonicalizePriceBatch([
      r("i1", "2026-06-05", 0),          // zero — not a price
      r("i1", "2026-06-06", -5),         // negative — provider noise
      r("i1", "2026-06-07", NaN),        // NaN
      r("i1", "2026-06-08", Infinity),   // non-finite
      r("i1", "2026-06-09", 210),        // the only defensible row
    ]);
    check("zero/negative/NaN/Infinity prices are dropped", out.length === 1 && out[0].price === 210);
  }

  // ── 3. Closed-date doctrine ───────────────────────────────────────────────
  console.log("3. Closed-date guard");
  {
    const now = new Date("2026-06-10T12:00:00Z");
    const yesterday = yesterdayUTCISO(now); // 2026-06-09
    let ok = true, threw = false;
    try { assertClosedDateISO(yesterday, now); } catch { ok = false; }
    check("yesterday UTC is an accepted closed date", ok);
    try { assertClosedDateISO("2026-06-10", now); } catch { threw = true; }
    check("today throws (append-only: a close cannot be dated by arrival)", threw);
    let futureThrew = false;
    try { assertClosedDateISO("2026-06-11", now); } catch { futureThrew = true; }
    check("a future date throws", futureThrew);
  }

  // ── 4. ISO-date + walk-back arithmetic ────────────────────────────────────
  console.log("4. Date helpers");
  {
    let threw = false;
    try { assertISODate("2026-6-5"); } catch { threw = true; }
    check("assertISODate rejects a non-padded date", threw);
    check("minusDaysISO handles month/UTC boundaries", minusDaysISO("2026-06-01", 1) === "2026-05-31");
    check("daysBetweenISO computes the whole-day gap", daysBetweenISO("2026-06-05", "2026-06-08") === 3);
    check("daysBetweenISO is 0 for the same date", daysBetweenISO("2026-06-05", "2026-06-05") === 0);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll price archive checks passed.");
  process.exit(0);
}

main();
