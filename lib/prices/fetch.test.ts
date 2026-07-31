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
  instrumentId: "i1", assetClass: "EQUITY", providerSymbol: "SYM", basis: PriceBasis.RAW_CLOSE,
  fromISO: "2026-06-01", toISO: "2026-06-30", ...over,
});

/** Declared capability helpers — routing consults these, never a trial call. */
const servesEquity = (k: { assetClass: string }): boolean => k.assetClass === "EQUITY" || k.assetClass === "ETF";
const servesCrypto = (k: { assetClass: string }): boolean => k.assetClass === "CRYPTO";

/** An adapter that always throws (rate-limit / outage simulation). */
function throwingAdapter(source: string, serves = servesEquity): PriceProviderAdapter {
  return {
    source, historicalDepth: "1970-01-01",
    supportedBases: () => [PriceBasis.RAW_CLOSE],
    supportsInstrument: serves,
    async fetchDailyCloses() { throw new Error("429 rate limited"); },
  };
}
/** An adapter that returns an off-window row (bad shape → whole batch discarded). */
function badShapeAdapter(source: string, serves = servesEquity): PriceProviderAdapter {
  return {
    source, historicalDepth: "1970-01-01",
    supportedBases: () => [PriceBasis.RAW_CLOSE],
    supportsInstrument: serves,
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

  // ── 2. Adapter error → stated failure, never a silent substitution ────────
  // V26-PRICE-PROVIDER-UNIFICATION: cross-adapter failover is GONE. Routing
  // resolves ONE capable provider; when it errors the window yields no rows and
  // coverage still reports those dates missing, so the next run retries. Nothing
  // is fabricated and nothing is silently re-sourced under a different vendor.
  console.log("2. Adapter error");
  {
    const reg = createPriceRegistry([throwingAdapter("flaky")]);
    const res = await fetchInstrumentWindow(req(), reg);
    check("error → source null, zero rows (never a fabricated or substituted answer)",
      res.source === null && res.rows.length === 0);
    check("the outcome is classified, not merely 'failed'", res.outcome === "PROVIDER_ERROR");
    check("failure is noted", res.notes.some((n) => n.includes("flaky") && n.includes("PROVIDER_ERROR")));
  }

  // ── 3. Bad-shape batch discarded whole ────────────────────────────────────
  console.log("3. Off-window batch discarded");
  {
    const reg = createPriceRegistry([badShapeAdapter("bad")]);
    const res = await fetchInstrumentWindow(req(), reg);
    check("off-window row → whole batch rejected, source null", res.source === null && res.rows.length === 0);
    check("an unusable batch is INVALID_DATA, distinct from a vendor outage", res.outcome === "INVALID_DATA");
    check("rejection noted", res.notes.some((n) => n.includes("bad") && n.includes("INVALID_DATA")));
  }

  // ── 4. Capability routing ─────────────────────────────────────────────────
  console.log("4. Capability routing");
  {
    const cryptoOnly = throwingAdapter("cryptovendor", servesCrypto);
    const equityFixture = createFixturePriceProvider(seed, { source: "fixture", supports: servesEquity });

    // An adapter that declines the instrument is never called — the throwing
    // crypto vendor proves it, since reaching it would fail the suite.
    const reg = createPriceRegistry([cryptoOnly, equityFixture]);
    const res = await fetchInstrumentWindow(req(), reg);
    check("a declining adapter is not called; the capable one serves", res.source === "fixture");

    // THE POINT: registration order cannot change routing.
    const reversed = createPriceRegistry([equityFixture, cryptoOnly]);
    const res2 = await fetchInstrumentWindow(req(), reversed);
    check("REGISTRATION ORDER CANNOT CHANGE ROUTING",
      res2.source === res.source && JSON.stringify(res2.rows) === JSON.stringify(res.rows));

    // Removing the capable adapter is a STATED outcome, not a fall-through.
    const withoutEquity = createPriceRegistry([cryptoOnly]);
    const res3 = await fetchInstrumentWindow(req(), withoutEquity);
    check("removing the capable adapter → source null, deterministically unsupported",
      res3.source === null && res3.rows.length === 0);
    check("unsupported is explained, naming what was considered",
      res3.notes.some((n) => n.includes("no capable provider") && n.includes("cryptovendor")));

    // Two adapters claiming one instrument is a config defect, reported not guessed.
    const ambiguous = createPriceRegistry([
      createFixturePriceProvider(seed, { source: "a", supports: servesEquity }),
      createFixturePriceProvider(seed, { source: "b", supports: servesEquity }),
    ]);
    const res4 = await fetchInstrumentWindow(req(), ambiguous);
    check("two capable adapters → refuses to guess", res4.source === null);
    check("ambiguity is named", res4.notes.some((n) => n.includes("AMBIGUOUS ROUTING")));

    // Basis is still part of capability.
    const navOnly: PriceProviderAdapter = {
      source: "navonly", historicalDepth: "1970-01-01",
      supportedBases: () => [PriceBasis.NAV],
      supportsInstrument: servesEquity,
      async fetchDailyCloses() { throw new Error("should not be called"); },
    };
    const reg5 = createPriceRegistry([navOnly, equityFixture]);
    const res5 = await fetchInstrumentWindow(req({ basis: PriceBasis.RAW_CLOSE }), reg5);
    check("an adapter that doesn't serve the basis is not routed to", res5.source === "fixture");
  }

  // ── 5. Delisted tail / no data → source null (never fabricated) ───────────
  console.log("5. No data window");
  {
    const reg = createPriceRegistry([fixture]);
    const res = await fetchInstrumentWindow(req({ fromISO: "2026-07-01", toISO: "2026-07-31" }), reg);
    check("window past last close → source null, zero rows", res.source === null && res.rows.length === 0);
    // Empty INSIDE servable depth is suspicious (EMPTY_RESPONSE); empty before
    // depth is explicable (NO_DATA). Collapsing both hides a vendor that has
    // quietly stopped answering.
    check("empty within servable depth is EMPTY_RESPONSE, not a bare 'no data'",
      res.outcome === "EMPTY_RESPONSE");
    check("the outcome is noted", res.notes.some((n) => n.includes("EMPTY_RESPONSE")));

    const beforeDepth = await fetchInstrumentWindow(
      req({ fromISO: "2020-01-01", toISO: "2020-01-31" }), reg);
    check("empty BEFORE the adapter's depth is NO_DATA, an expected outcome",
      beforeDepth.outcome === "NO_DATA");
  }

  // ── 6. Default registry — vendor gate on TIINGO_API_KEY ───────────────────
  console.log("6. Default registry (Tiingo when keyed, empty otherwise)");
  {
    const saved = process.env.TIINGO_API_KEY;
    try {
      delete process.env.TIINGO_API_KEY;
      const empty = defaultPriceRegistry();
      check("no key → empty registry (no-op, not fabricated)", empty.adapters.length === 0);
      const res = await fetchInstrumentWindow(req(), empty);
      check("empty registry → source null, zero rows", res.source === null && res.rows.length === 0);

      process.env.TIINGO_API_KEY = "test-key";
      const keyed = defaultPriceRegistry();
      check("key set → registers the tiingo adapter",
        keyed.adapters.length === 1 && keyed.adapters[0].source === "tiingo");
    } finally {
      if (saved === undefined) delete process.env.TIINGO_API_KEY;
      else process.env.TIINGO_API_KEY = saved;
    }
  }

  // ── 7. Registry duplicate-source guard ────────────────────────────────────
  console.log("7. Registry guard");
  {
    let threw = false;
    try { createPriceRegistry([fixture, createFixturePriceProvider(seed, { source: "fixture" })]); } catch { threw = true; }
    check("duplicate adapter source throws", threw);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll price fetch/registry checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error("Test harness crashed:", err); process.exit(1); });
