/**
 * lib/prices/service.test.ts
 *
 * A8-1 — price-resolution engine tests. Standalone tsx script (house pattern —
 * no jest/vitest):
 *
 *     npx tsx lib/prices/service.test.ts
 *
 * Exercises createPriceService over an in-memory PriceArchiveReader fake (no DB,
 * mirroring lib/fx/service.test.ts). Covers: exact hit, weekend walk-back,
 * holiday-style gap, within-bound estimated, beyond-bound miss, never-priced
 * miss, basis isolation, per-basis uniqueness, deterministic memoization, and
 * delisted-tail behavior.
 */

import { PriceBasis } from "@prisma/client";
import { createPriceService } from "./service";
import { PRICE_MAX_STALE_DAYS } from "./config";
import type { PriceArchiveReader, PriceResult, ResolvedPrice, PriceMiss } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/**
 * In-memory archive reader with the SAME walk-back + basis-isolation semantics
 * the Prisma archive enforces in SQL: latest row for (instrumentId, basis) with
 * date in [asked − maxStaleDays, asked]. `reads` counts round-trips so the memo
 * test can prove a second identical query costs zero reads.
 */
function fakeArchive(rows: PriceResult[]): PriceArchiveReader & { reads: number } {
  const self = {
    reads: 0,
    async readLatestOnOrBefore(instrumentId: string, basis: PriceBasis, dateISO: string, maxStaleDays: number) {
      self.reads++;
      const floor = new Date(Date.parse(`${dateISO}T00:00:00Z`) - maxStaleDays * 86_400_000)
        .toISOString().slice(0, 10);
      const candidates = rows
        .filter((r) => r.instrumentId === instrumentId && r.basis === basis && r.dateISO <= dateISO && r.dateISO >= floor)
        .sort((a, b) => b.dateISO.localeCompare(a.dateISO));
      const row = candidates[0];
      return row ? { dateISO: row.dateISO, price: row.price, currency: row.currency } : null;
    },
  };
  return self;
}

const r = (instrumentId: string, dateISO: string, price: number, basis: PriceBasis = PriceBasis.RAW_CLOSE, currency = "USD"): PriceResult =>
  ({ instrumentId, dateISO, basis, price, currency });

async function main(): Promise<void> {
  // Friday 2026-06-05 and Monday 2026-06-08 closes; weekend 06-06/06-07 absent.
  const AAPL = "inst_aapl";
  const archive = fakeArchive([
    r(AAPL, "2026-06-05", 200),
    r(AAPL, "2026-06-08", 210),
    r(AAPL, "2026-06-05", 199, PriceBasis.ADJUSTED_CLOSE), // distinct series, same date
  ]);

  // ── 1. Exact hit ──────────────────────────────────────────────────────────
  console.log("1. Exact hit");
  {
    const svc = createPriceService(archive);
    const res = await svc.getPriceAsOf(AAPL, "2026-06-05", PriceBasis.RAW_CLOSE) as ResolvedPrice;
    check("exact date → price kind", res.kind === "price");
    check("exact date → tier observed", res.tier === "observed");
    check("exact date → staleDays 0", res.staleDays === 0);
    check("exact date → the requested date's price", res.price === 200);
    check("exact date → effectiveDateISO == requested", res.effectiveDateISO === "2026-06-05");
    check("quote currency carried through", res.currency === "USD");
  }

  // ── 2. Weekend walk-back (Saturday → Friday close) ────────────────────────
  console.log("2. Weekend walk-back");
  {
    const svc = createPriceService(archive);
    const res = await svc.getPriceAsOf(AAPL, "2026-06-06", PriceBasis.RAW_CLOSE) as ResolvedPrice;
    check("weekend → walked back to Friday", res.kind === "price" && res.effectiveDateISO === "2026-06-05");
    check("weekend → tier estimated", res.tier === "estimated");
    check("weekend → staleDays 1", res.staleDays === 1);
    check("weekend → Friday's price, not interpolated", res.price === 200);
  }

  // ── 3. Holiday-style gap within bound (still estimated) ───────────────────
  console.log("3. Holiday-style gap within bound");
  {
    // A 3-day close (e.g. holiday Mon–Wed): ask Wed 2026-06-10, latest is 06-08.
    const svc = createPriceService(archive);
    const res = await svc.getPriceAsOf(AAPL, "2026-06-10", PriceBasis.RAW_CLOSE) as ResolvedPrice;
    check("gap within bound → estimated from latest prior close", res.kind === "price" && res.tier === "estimated");
    check("gap within bound → staleDays 2", res.staleDays === 2);
    check("gap within bound → uses 06-08 (210), never averaged", res.price === 210);
  }

  // ── 4. Beyond-bound miss (delisted tail) ──────────────────────────────────
  console.log("4. Beyond-bound miss / delisted tail");
  {
    const svc = createPriceService(archive);
    // Ask well past the last close (06-08) — beyond PRICE_MAX_STALE_DAYS.
    const far = "2026-06-30";
    const res = await svc.getPriceAsOf(AAPL, far, PriceBasis.RAW_CLOSE) as PriceMiss;
    check(`beyond ${PRICE_MAX_STALE_DAYS}d → miss`, res.kind === "miss");
    check("miss carries instrument + basis + requested date",
      res.instrumentId === AAPL && res.basis === PriceBasis.RAW_CLOSE && res.requestedDateISO === far);
    check("miss reason is deterministic + name-free",
      res.reason === `No RAW_CLOSE price within ${PRICE_MAX_STALE_DAYS} days of ${far}.`);
    // Exactly at the bound is still a hit; one day past is a miss.
    const atBound = await svc.getPriceAsOf(AAPL, "2026-06-15", PriceBasis.RAW_CLOSE); // 7d after 06-08
    const pastBound = await svc.getPriceAsOf(AAPL, "2026-06-16", PriceBasis.RAW_CLOSE); // 8d after 06-08
    check("exactly at staleness bound → still resolves", atBound.kind === "price");
    check("one day past the bound → miss", pastBound.kind === "miss");
  }

  // ── 5. Never-priced instrument → miss ─────────────────────────────────────
  console.log("5. Never-priced instrument");
  {
    const svc = createPriceService(archive);
    const res = await svc.getPriceAsOf("inst_unknown", "2026-06-05", PriceBasis.RAW_CLOSE);
    check("no rows for instrument → miss (never a fabricated 0)", res.kind === "miss");
  }

  // ── 6. Basis isolation + per-basis uniqueness ─────────────────────────────
  console.log("6. Basis isolation");
  {
    const svc = createPriceService(archive);
    const raw = await svc.getPriceAsOf(AAPL, "2026-06-05", PriceBasis.RAW_CLOSE) as ResolvedPrice;
    const adj = await svc.getPriceAsOf(AAPL, "2026-06-05", PriceBasis.ADJUSTED_CLOSE) as ResolvedPrice;
    check("RAW_CLOSE returns the RAW row (200)", raw.price === 200);
    check("ADJUSTED_CLOSE returns the ADJUSTED row (199) — never mixes", adj.price === 199);
    // NAV has no rows → miss even though RAW/ADJUSTED exist for the date.
    const nav = await svc.getPriceAsOf(AAPL, "2026-06-05", PriceBasis.NAV);
    check("NAV never falls through to RAW_CLOSE", nav.kind === "miss");
  }

  // ── 7. Deterministic memoization ──────────────────────────────────────────
  console.log("7. Deterministic memoization");
  {
    const memoArchive = fakeArchive([r(AAPL, "2026-06-05", 200)]);
    const svc = createPriceService(memoArchive);
    const a = await svc.getPriceAsOf(AAPL, "2026-06-06", PriceBasis.RAW_CLOSE);
    const readsAfterFirst = memoArchive.reads;
    const b = await svc.getPriceAsOf(AAPL, "2026-06-06", PriceBasis.RAW_CLOSE);
    check("identical query → byte-identical JSON", JSON.stringify(a) === JSON.stringify(b));
    check("second identical query costs zero archive reads (memo hit)", memoArchive.reads === readsAfterFirst);
    // A miss is memoized too.
    const m1 = await svc.getPriceAsOf(AAPL, "2026-08-01", PriceBasis.RAW_CLOSE);
    const readsAfterMiss = memoArchive.reads;
    const m2 = await svc.getPriceAsOf(AAPL, "2026-08-01", PriceBasis.RAW_CLOSE);
    check("misses are memoized (value, not throw)", m1.kind === "miss" && JSON.stringify(m1) === JSON.stringify(m2));
    check("repeated miss costs zero reads", memoArchive.reads === readsAfterMiss);
  }

  // ── 8. Malformed date is a programmer error (throws) ──────────────────────
  console.log("8. Malformed date guard");
  {
    const svc = createPriceService(archive);
    let threw = false;
    try { await svc.getPriceAsOf(AAPL, "2026/06/05", PriceBasis.RAW_CLOSE); } catch { threw = true; }
    check("non-ISO date throws (programmer error, not a value)", threw);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll price service checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error("Test harness crashed:", err); process.exit(1); });
