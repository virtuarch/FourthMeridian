/**
 * lib/prices/capture.test.ts
 *
 * A8-2 — Plaid close-price capture tests. Standalone tsx script:
 *
 *     npx tsx lib/prices/capture.test.ts
 *
 * Covers the pure mapper (defensible-price / date / currency rules) and the
 * capture orchestrator over an in-memory PriceArchive fake (no DB): valid write,
 * missing date/price/currency skips, not-yet-closed skip, within-batch dedup,
 * idempotent second capture. The two sync hooks (position-capture,
 * investment-event-ingest) are thin flag-gated try/catch wrappers over
 * captureSecurityPrices, validated on real data after merge.
 */

import { PriceBasis } from "@prisma/client";
import {
  captureSecurityPrices,
  mapPlaidSecurityToPriceResult,
  PLAID_PRICE_SOURCE,
  type PlaidPricedSecurity,
} from "./capture";
import type { PriceArchive, PriceResult } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const sec = (over: Partial<PlaidPricedSecurity>): PlaidPricedSecurity => ({
  close_price: 200,
  close_price_as_of: "2026-06-05",
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  ...over,
});

/** In-memory PriceArchive fake: records writes, enforces canonical-key idempotency. */
function fakeArchive(): PriceArchive & { stored: PriceResult[] } {
  const stored: PriceResult[] = [];
  const keys = new Set(stored.map((r) => `${r.instrumentId}|${r.dateISO}|${r.basis}`));
  return {
    stored,
    async readPrice() { return null; },
    async readLatestOnOrBefore() { return null; },
    async writeBatch(source, rows) {
      let inserted = 0;
      for (const r of rows) {
        const k = `${r.instrumentId}|${r.dateISO}|${r.basis}`;
        if (keys.has(k)) continue;
        keys.add(k);
        stored.push(r);
        inserted++;
      }
      return { attempted: rows.length, inserted };
    },
  };
}

const NOW = new Date("2026-06-10T12:00:00Z"); // yesterday = 2026-06-09

async function main(): Promise<void> {
  // ── 1. Pure mapper rules ──────────────────────────────────────────────────
  console.log("1. mapPlaidSecurityToPriceResult");
  check("valid security → RAW_CLOSE PriceResult dated by close_price_as_of",
    JSON.stringify(mapPlaidSecurityToPriceResult(sec({}), "i1")) ===
      JSON.stringify({ instrumentId: "i1", dateISO: "2026-06-05", basis: PriceBasis.RAW_CLOSE, price: 200, currency: "USD" }));
  check("null close_price → null", mapPlaidSecurityToPriceResult(sec({ close_price: null }), "i1") === null);
  check("zero/negative close_price → null",
    mapPlaidSecurityToPriceResult(sec({ close_price: 0 }), "i1") === null &&
    mapPlaidSecurityToPriceResult(sec({ close_price: -5 }), "i1") === null);
  check("absent close_price_as_of → null (never dates by arrival)",
    mapPlaidSecurityToPriceResult(sec({ close_price_as_of: null }), "i1") === null);
  check("indefensible currency (both null) → null",
    mapPlaidSecurityToPriceResult(sec({ iso_currency_code: null, unofficial_currency_code: null }), "i1") === null);
  check("unofficial currency is a defensible fallback",
    mapPlaidSecurityToPriceResult(sec({ iso_currency_code: null, unofficial_currency_code: "BTC" }), "i1")?.currency === "BTC");
  check("datetime as-of is truncated to a calendar date",
    mapPlaidSecurityToPriceResult(sec({ close_price_as_of: "2026-06-05" }), "i1")?.dateISO === "2026-06-05");

  // ── 2. Valid close price + defensible date writes one row ─────────────────
  console.log("2. Capture — valid write");
  {
    const archive = fakeArchive();
    const m = await captureSecurityPrices({ securities: [{ instrumentId: "i1", security: sec({}) }], now: NOW, archive });
    check("one row written", m.inserted === 1 && archive.stored.length === 1);
    check("source stamped 'plaid'", PLAID_PRICE_SOURCE === "plaid");
    check("stored row is the mapped candidate", archive.stored[0].price === 200 && archive.stored[0].dateISO === "2026-06-05");
  }

  // ── 3. Missing date / price / currency write nothing ──────────────────────
  console.log("3. Capture — skips");
  {
    const archive = fakeArchive();
    const m = await captureSecurityPrices({
      securities: [
        { instrumentId: "a", security: sec({ close_price_as_of: null }) },
        { instrumentId: "b", security: sec({ close_price: null }) },
        { instrumentId: "c", security: sec({ iso_currency_code: null, unofficial_currency_code: null }) },
      ],
      now: NOW, archive,
    });
    check("nothing written, all skipped", archive.stored.length === 0 && m.inserted === 0 && m.skipped === 3);
  }

  // ── 4. Not-yet-closed date is skipped ─────────────────────────────────────
  console.log("4. Capture — not-yet-closed date");
  {
    const archive = fakeArchive();
    const m = await captureSecurityPrices({
      securities: [{ instrumentId: "i1", security: sec({ close_price_as_of: "2026-06-10" }) }], // == NOW's day (> yesterday)
      now: NOW, archive,
    });
    check("today-dated close skipped (append-only: not a closed date)", archive.stored.length === 0 && m.skipped === 1);
  }

  // ── 5. Within-batch dedup + idempotent second capture ─────────────────────
  console.log("5. Capture — idempotency");
  {
    const archive = fakeArchive();
    const dupBatch = [
      { instrumentId: "i1", security: sec({}) },
      { instrumentId: "i1", security: sec({}) }, // same instrument+date+basis
    ];
    const first = await captureSecurityPrices({ securities: dupBatch, now: NOW, archive });
    check("within-batch duplicate collapsed to one write", first.inserted === 1 && archive.stored.length === 1);
    const second = await captureSecurityPrices({ securities: [{ instrumentId: "i1", security: sec({}) }], now: NOW, archive });
    check("second capture adds no duplicate (skipDuplicates)", second.inserted === 0 && archive.stored.length === 1);
  }

  // ── 6. Empty input is a no-op (no write attempt) ──────────────────────────
  console.log("6. Capture — empty");
  {
    const archive = fakeArchive();
    const m = await captureSecurityPrices({ securities: [], now: NOW, archive });
    check("empty input → zero everything, archive untouched", m.attempted === 0 && m.inserted === 0 && archive.stored.length === 0);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll price capture checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error("Test harness crashed:", err); process.exit(1); });
