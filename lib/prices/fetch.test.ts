/**
 * lib/prices/fetch.test.ts
 *
 * A8-3A — fetch-orchestration + registry tests. Standalone tsx script:
 *
 *     npx tsx lib/prices/fetch.test.ts
 *
 * Covers: provider contract via the fixture adapter, failover (throwing /
 * empty / basis-unsupported adapters), source + basis mapping, delisted-tail
 * (empty ⇒ source null), no interpolation, and registry duplicate-source guard.
 */

import { PriceBasis } from "@prisma/client";
import { createPriceRegistry, defaultPriceRegistry } from "./registry";
import { fetchInstrumentWindow } from "./fetch";
import { createFixturePriceProvider, type FixturePrice } from "./providers/fixture";
import type { PriceFetchRequest, PriceProviderAdapter, PriceResult } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const seed: FixturePrice[] = [
  { instrumentId: "i1", basis: PriceBasis.RAW_CLOSE, dateISO: "2026-06-05", price: 200 },
  { instrumentId: "i1", basis: PriceBasis.RAW_CLOSE, dateISO: "2026-06-08", price: 210 },
];

const req = (over: Partial<PriceFetchRequest> = {}): PriceFetchRequest => ({
  instrumentId: "i1", providerSymbol: "SYM", basis: PriceBasis.RAW_CLOSE,
  fromISO: "2026-06-01", toISO: "2026-06-30", ...over,
});

/** An adapter that always throws (rate-limit / outage simulation). */
function throwingAdapter(source: string): PriceProviderAdapter {
  return {
    source, historicalDepth: "1970-01-01",
    supportedBases: () => [PriceBasis.RAW_CLOSE],
    async fetchDailyCloses() { throw new Error("429 rate limited"); },
  };
}
/** An adapter that returns an off-window row (bad shape → whole batch discarded). */
function badShapeAdapter(source: string): PriceProviderAdapter {
  return {
    source, historicalDepth: "1970-01-01",
    supportedBases: () => [PriceBasis.RAW_CLOSE],
    async fetchDailyCloses(r): Promise<PriceResult[]> {
      return [{ instrumentId: r.instrumentId, dateISO: "2020-01-01", basis: r.basis, price: 5, currency: "USD" }];
    },
  };
}

async function main(): Promise<void> {
  const fixture = createFixturePriceProvider(seed, { source: "fixture" });

  // ── 1. Provider contract via fixture ──────────────────────────────────────
  console.log("1. Fixture provider fetch");
  {
    const reg = createPriceRegistry([fixture]);
    const res = await fetchInstrumentWindow(req(), reg);
    check("winning source stamped", res.source === "fixture");
    check("basis carried on the result", res.basis === PriceBasis.RAW_CLOSE);
    check("returns exactly the seeded in-window rows", res.rows.length === 2 && res.rows[0].price === 200 && res.rows[1].price === 210);
    check("no interpolation — absent 06-06/06-07 never appear", !res.rows.some((r) => r.dateISO === "2026-06-06" || r.dateISO === "2026-06-07"));
  }

  // ── 2. Failover: throwing adapter → next adapter wins ─────────────────────
  console.log("2. Failover on error");
  {
    const reg = createPriceRegistry([throwingAdapter("flaky"), fixture]);
    const res = await fetchInstrumentWindow(req(), reg);
    check("failed adapter is skipped, fixture wins", res.source === "fixture" && res.rows.length === 2);
    check("failure is noted (rate-limit/error behavior)", res.notes.some((n) => n.includes("flaky") && n.includes("FAILED")));
  }

  // ── 3. Bad-shape batch is discarded whole, then failover ──────────────────
  console.log("3. Off-window batch discarded");
  {
    const reg = createPriceRegistry([badShapeAdapter("bad"), fixture]);
    const res = await fetchInstrumentWindow(req(), reg);
    check("off-window row → whole batch rejected, next adapter used", res.source === "fixture");
    check("rejection noted", res.notes.some((n) => n.includes("bad") && n.includes("FAILED")));
  }

  // ── 4. Basis-unsupported adapter skipped ──────────────────────────────────
  console.log("4. Basis support");
  {
    const navOnly: PriceProviderAdapter = {
      source: "navonly", historicalDepth: "1970-01-01",
      supportedBases: () => [PriceBasis.NAV],
      async fetchDailyCloses() { throw new Error("should not be called"); },
    };
    const reg = createPriceRegistry([navOnly, fixture]);
    const res = await fetchInstrumentWindow(req({ basis: PriceBasis.RAW_CLOSE }), reg);
    check("adapter that doesn't serve the basis is skipped, not called", res.source === "fixture");
    check("skip noted", res.notes.some((n) => n.includes("navonly") && n.includes("does not serve")));
  }

  // ── 5. Delisted tail / no data → source null (never fabricated) ───────────
  console.log("5. No data window");
  {
    const reg = createPriceRegistry([fixture]);
    const res = await fetchInstrumentWindow(req({ fromISO: "2026-07-01", toISO: "2026-07-31" }), reg);
    check("window past last close → source null, zero rows", res.source === null && res.rows.length === 0);
    check("empty is 'no data', noted (not a failure)", res.notes.some((n) => n.includes("no data")));
  }

  // ── 6. Empty (default) registry → clean no-op ─────────────────────────────
  console.log("6. Default (vendor-less) registry");
  {
    const res = await fetchInstrumentWindow(req(), defaultPriceRegistry());
    check("no vendor selected → source null, zero rows (deferred, not fabricated)", res.source === null && res.rows.length === 0);
  }

  // ── 7. Registry duplicate-source guard ────────────────────────────────────
  console.log("7. Registry guard");
  {
    let threw = false;
    try { createPriceRegistry([fixture, createFixturePriceProvider(seed, { source: "fixture" })]); } catch { threw = true; }
    check("duplicate adapter source throws", threw);
    check("defaultPriceRegistry is empty (vendor deferred)", defaultPriceRegistry().adapters.length === 0);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll price fetch/registry checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error("Test harness crashed:", err); process.exit(1); });
