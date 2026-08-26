/**
 * lib/prices/provider-unification.test.ts
 *
 * V26-PRICE-PROVIDER-UNIFICATION — acceptance fixtures. Standalone tsx script:
 *
 *     npx tsx lib/prices/provider-unification.test.ts
 *
 * The claim under test: historical price acquisition is provider-agnostic, and
 * supporting a new crypto asset needs only an adapter, a registry entry, and
 * instrument configuration — no new price service, no regeneration branch, no
 * asset-specific archive-writing path.
 *
 * Section 4 is the Solana-readiness test. It registers a fixture adapter for a
 * SECOND crypto asset and shows it is served by the same routing, through the
 * same fetch orchestration, returning the same PriceResult shape the shared
 * archive writer consumes — with nothing in lib/prices changed to accommodate it.
 *
 * NO PROVIDER IS CONTACTED. The CoinGecko adapter is exercised through its
 * injectable fetch seam; every other adapter is a fixture or a fake that throws
 * if called when routing should not have selected it.
 */

import { readFileSync } from "node:fs";

import { PriceBasis } from "@prisma/client";
import { createPriceRegistry, resolveProviderForInstrument } from "./registry";
import { fetchInstrumentWindow } from "./fetch";
import {
  createCoinGeckoPriceProvider,
  coinIdForSymbol,
  COINGECKO_COIN_IDS,
  type CoinGeckoHttpResponse,
} from "./providers/coingecko";
import { createTiingoPriceProvider } from "./providers/tiingo";
import type {
  PriceFetchRequest, PriceProviderAdapter, PriceResult, ProviderRoutingKey,
} from "./types";

/**
 * Read a module's CODE, with comments removed.
 *
 * These structural assertions are about what the code does, and the comments
 * legitimately discuss the very names being asserted absent (e.g. "removed
 * backfillBtcPrices from this module"). Scanning raw text would fail on the
 * documentation of the removal — the classic strip-comments-first trap.
 *
 * Block comments are removed wholesale; line comments only when the line is
 * entirely a comment, so a code line containing "https://" survives intact and
 * cannot be truncated into a false pass.
 */
function readCode(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const key = (assetClass: string, providerSymbol: string): ProviderRoutingKey =>
  ({ assetClass, providerSymbol, basis: PriceBasis.RAW_CLOSE });

const request = (over: Partial<PriceFetchRequest> = {}): PriceFetchRequest => ({
  instrumentId: "inst_btc", assetClass: "CRYPTO", providerSymbol: "BTC",
  basis: PriceBasis.RAW_CLOSE, fromISO: "2026-06-01", toISO: "2026-06-03", ...over,
});

/** A CoinGecko HTTP stub — no network, and it records the URL it was given. */
function coinGeckoStub(seen: { url?: string }) {
  return async (url: string): Promise<CoinGeckoHttpResponse> => {
    seen.url = url;
    return {
      ok: true, status: 200,
      async json() {
        return {
          prices: [
            [Date.parse("2026-06-01T23:00:00Z"), 60000],
            [Date.parse("2026-06-02T23:00:00Z"), 61000],
            [Date.parse("2026-06-03T23:00:00Z"), 62000],
          ],
        };
      },
    };
  };
}

/** An adapter that fails the suite if routing ever reaches it. */
function mustNotBeCalled(source: string, serves: (k: ProviderRoutingKey) => boolean): PriceProviderAdapter {
  return {
    source, historicalDepth: "1970-01-01",
    supportedBases: () => [PriceBasis.RAW_CLOSE],
    supportsInstrument: serves,
    async fetchDailyCloses() { throw new Error(`[test] routing wrongly selected "${source}"`); },
  };
}

/**
 * A FURTHER crypto asset, supported the way the criterion says it must be: an
 * adapter implementation plus a registry entry plus instrument configuration.
 * Nothing in lib/prices is edited to accommodate it.
 *
 * W-M1a — this fixture used to serve SOL, back when SOL was the illustrative
 * "asset we do not support yet". SOL is now really registered to CoinGecko, so
 * a fixture also claiming it would make routing AMBIGUOUS — which is the
 * registry behaving correctly, and would have turned this extensibility proof
 * into a false failure. It therefore serves a ticker no adapter maps (DOGE),
 * which is what the proof actually needs: an asset arriving from OUTSIDE the
 * registered set.
 */
function createUnregisteredAssetFixtureProvider(): PriceProviderAdapter {
  const COIN_IDS: Record<string, string> = { DOGE: "dogecoin" };
  return {
    source: "unregistered-asset-fixture",
    historicalDepth: "2020-04-10",
    supportedBases: () => [PriceBasis.RAW_CLOSE],
    supportsInstrument: (k) =>
      k.assetClass === "CRYPTO" && k.basis === PriceBasis.RAW_CLOSE && COIN_IDS[k.providerSymbol] !== undefined,
    async fetchDailyCloses(req: PriceFetchRequest): Promise<PriceResult[]> {
      return [{
        instrumentId: req.instrumentId, dateISO: req.fromISO,
        basis: PriceBasis.RAW_CLOSE, price: 150, currency: "USD",
      }];
    },
  };
}

async function main(): Promise<void> {
  const tiingo = createTiingoPriceProvider("fake-key", { fetchImpl: async () => { throw new Error("[test] Tiingo was called"); } });

  // ── 1. CoinGecko is a normal adapter ──────────────────────────────────────
  console.log("1. CoinGecko is a normal PriceProviderAdapter");
  {
    const seen: { url?: string } = {};
    const cg = createCoinGeckoPriceProvider("k", { fetchImpl: coinGeckoStub(seen) });

    check("declares a stable source", cg.source === "coingecko");
    check("declares a historical depth", /^\d{4}-\d{2}-\d{2}$/.test(cg.historicalDepth));
    check("serves RAW_CLOSE, matching where BTC is actually stored",
      cg.supportedBases().length === 1 && cg.supportedBases()[0] === PriceBasis.RAW_CLOSE);
    check("declares capability for BTC", cg.supportsInstrument(key("CRYPTO", "BTC")));
    check("declines equities", !cg.supportsInstrument(key("EQUITY", "AAPL")));
    check("declines an unmapped coin", !cg.supportsInstrument(key("CRYPTO", "DOGE")));
    check("declines a non-RAW_CLOSE basis",
      !cg.supportsInstrument({ assetClass: "CRYPTO", providerSymbol: "BTC", basis: PriceBasis.NAV }));

    const rows = await cg.fetchDailyCloses(request());
    check("returns PriceResult rows keyed by the requested instrument",
      rows.length === 3 && rows.every((r) => r.instrumentId === "inst_btc"));
    check("stamps RAW_CLOSE and USD", rows.every((r) => r.basis === PriceBasis.RAW_CLOSE && r.currency === "USD"));
    check("the coin id is resolved from the ticker, not hardcoded in the URL",
      (seen.url ?? "").includes("/coins/bitcoin/"), seen.url);
  }

  // ── 2. Instrument configuration ───────────────────────────────────────────
  console.log("2. instrument configuration");
  {
    check("BTC maps to the CoinGecko coin id", coinIdForSymbol("BTC") === "bitcoin");
    check("mapping is case-insensitive and trims", coinIdForSymbol(" btc ") === "bitcoin");
    // W-M1a — ETH and SOL are registered. This is the whole of "adding a native
    // asset" on the pricing side; nothing else in lib/prices changed.
    check("ETH maps to the CoinGecko coin id", coinIdForSymbol("ETH") === "ethereum");
    check("SOL maps to the CoinGecko coin id", coinIdForSymbol("SOL") === "solana");
    check("an unconfigured ticker still maps to null", coinIdForSymbol("DOGE") === null);
    check("the mapping table is the single configuration point",
      "BTC" in COINGECKO_COIN_IDS && "ETH" in COINGECKO_COIN_IDS && "SOL" in COINGECKO_COIN_IDS);
  }

  // ── 3. BTC uses the same registry path as equities ────────────────────────
  console.log("3. BTC travels the equities path");
  {
    const seen: { url?: string } = {};
    const cg = createCoinGeckoPriceProvider("k", { fetchImpl: coinGeckoStub(seen) });
    const registry = createPriceRegistry([tiingo, cg]);

    const btc = resolveProviderForInstrument(registry, key("CRYPTO", "BTC"));
    check("BTC routes to CoinGecko", btc.kind === "provider" && btc.adapter.source === "coingecko");
    const eq = resolveProviderForInstrument(registry, key("EQUITY", "AAPL"));
    check("an equity routes to Tiingo", eq.kind === "provider" && eq.adapter.source === "tiingo");

    // Tiingo throws if called; reaching this line proves it was never asked.
    const res = await fetchInstrumentWindow(request(), registry);
    check("BTC acquisition runs through the shared fetch orchestration", res.source === "coingecko");
    check("…returning validated rows the shared archive writer consumes", res.rows.length === 3);

    const reversed = createPriceRegistry([cg, tiingo]);
    const btcReversed = resolveProviderForInstrument(reversed, key("CRYPTO", "BTC"));
    check("REGISTRATION ORDER CANNOT CHANGE ROUTING",
      btcReversed.kind === "provider" && btcReversed.adapter.source === "coingecko");
  }

  // ── 4. MULTI-ASSET REALITY (was: SOLANA READINESS) ────────────────────────
  console.log("4. ETH and SOL are registered; a further asset still needs only adapter + registration + config");
  {
    const cg = createCoinGeckoPriceProvider("k", { fetchImpl: coinGeckoStub({}) });
    const extra = createUnregisteredAssetFixtureProvider();
    const registry = createPriceRegistry([tiingo, cg, extra]);

    // W-M1a — the readiness claim is now cashed: ETH and SOL route for real,
    // to the real vendor, through the same orchestration, with no ambiguity.
    for (const sym of ["BTC", "ETH", "SOL"]) {
      const route = resolveProviderForInstrument(registry, key("CRYPTO", sym));
      check(`${sym} routes UNAMBIGUOUSLY to CoinGecko`,
        route.kind === "provider" && route.adapter.source === "coingecko",
        JSON.stringify(route));
    }
    const eq = resolveProviderForInstrument(registry, key("EQUITY", "AAPL"));
    check("…without disturbing the equities route",
      eq.kind === "provider" && eq.adapter.source === "tiingo");

    for (const [instrumentId, providerSymbol] of [["inst_eth", "ETH"], ["inst_sol", "SOL"]]) {
      const res = await fetchInstrumentWindow(request({ instrumentId, providerSymbol }), registry);
      check(`${providerSymbol} flows through the SAME fetch orchestration`, res.source === "coingecko");
      check(`…producing the PriceResult shape the shared writer consumes (${providerSymbol})`,
        res.rows.length === 3 && res.rows.every((r) => r.basis === PriceBasis.RAW_CLOSE && r.currency === "USD"));
    }

    // The extensibility criterion itself, proved with an asset from OUTSIDE the
    // registered set: adapter + registry entry + config, nothing in lib/prices.
    const dogeRoute = resolveProviderForInstrument(registry, key("CRYPTO", "DOGE"));
    check("an UNREGISTERED asset routes to its own adapter",
      dogeRoute.kind === "provider" && dogeRoute.adapter.source === "unregistered-asset-fixture");
    const dogeRes = await fetchInstrumentWindow(
      request({ instrumentId: "inst_doge", providerSymbol: "DOGE" }), registry);
    check("…through the SAME fetch orchestration", dogeRes.source === "unregistered-asset-fixture");

    // The negative half of the criterion: no asset-specific machinery exists.
    const priceSrc = readCode("lib/prices/fetch.ts")
      + readCode("lib/prices/backfill.ts")
      + readCode("lib/prices/registry.ts");
    check("fetch/backfill/registry contain no per-coin branching",
      !/\bBTC\b|bitcoin|\bETH\b|ethereum|\bSOL\b|solana|\bDOGE\b|dogecoin/i.test(priceSrc));

    const adapterSrc = readCode("lib/prices/providers/coingecko.ts");
    check("the adapter never writes to the archive itself (writes stay centralized)",
      !adapterSrc.includes("priceArchive") && !adapterSrc.includes("writeBatch"));

    // ── W-M1a — NO BTC-SPECIFIC PRICE PATH SURVIVES, ACQUISITION OR VALUATION ─
    //
    // This previously pinned the OPPOSITE for the read half: "the BTC VALUATION
    // read is deliberately retained until PRICE-5". W-M0 generalised it anyway,
    // because a multi-asset valuation core cannot be fed by a reader that can
    // only answer for Bitcoin, and W-M1a deleted the original rather than
    // leaving a delegating wrapper with no caller. The invariant is now the
    // stronger one, and it is pinned in both directions.
    const btcSrc = readCode("lib/crypto/btc-price.ts");
    check("no BTC-specific ACQUISITION function survives",
      !btcSrc.includes("backfillBtcPrices") && !btcSrc.includes("fetchCoinDailyClosesUsd"));
    check("no BTC-specific VALUATION read survives (readBtcUsdWindow is DELETED)",
      !btcSrc.includes("readBtcUsdWindow"));
    check("…and btc-price reads no price archive at all",
      !btcSrc.includes("priceArchive") && !btcSrc.includes("readRange") && !btcSrc.includes("PriceBasis"));
    check("the crypto valuation read is the per-asset one, keyed by assetKey",
      readCode("lib/crypto/crypto-price-window.ts").includes("readCryptoUsdWindows")
        && /externalId:\s*asset\.assetKey/.test(readCode("lib/crypto/crypto-price-window.ts")));

    // Nothing anywhere may resurrect the deleted reader.
    for (const f of ["lib/snapshots/regenerate-history.ts", "lib/history/account-series.ts"]) {
      check(`${f} does not call the deleted BTC reader`, !readCode(f).includes("readBtcUsdWindow"));
    }
  }

  // ── 5. Removal is a stated outcome, never a fall-through ──────────────────
  console.log("5. removing an adapter");
  {
    // Only an equities vendor registered: BTC has no capable provider.
    const registry = createPriceRegistry([tiingo]);
    const btc = resolveProviderForInstrument(registry, key("CRYPTO", "BTC"));
    check("removing the crypto adapter → deterministic unsupported, not a fall-through",
      btc.kind === "unsupported");
    check("…naming what was considered",
      btc.kind === "unsupported" && btc.sourcesConsidered.includes("tiingo"));

    const res = await fetchInstrumentWindow(request(), registry);
    check("fetch yields source null and zero rows (Tiingo is never tried)",
      res.source === null && res.rows.length === 0);
    check("…and says why", res.notes.some((n) => n.includes("no capable provider")));

    const empty = resolveProviderForInstrument(createPriceRegistry([]), key("CRYPTO", "BTC"));
    check("an empty registry is unsupported, not an error", empty.kind === "unsupported");
  }

  // ── 6. Ambiguity is reported, not resolved by position ────────────────────
  console.log("6. ambiguity");
  {
    const a = createCoinGeckoPriceProvider("k", { source: "cg-a", fetchImpl: coinGeckoStub({}) });
    const b = createCoinGeckoPriceProvider("k", { source: "cg-b", fetchImpl: coinGeckoStub({}) });
    const registry = createPriceRegistry([a, b]);
    const r1 = resolveProviderForInstrument(registry, key("CRYPTO", "BTC"));
    check("two adapters claiming BTC → ambiguous", r1.kind === "ambiguous");
    check("…listing both, in deterministic order",
      r1.kind === "ambiguous" && JSON.stringify(r1.sources) === JSON.stringify(["cg-a", "cg-b"]));

    const r2 = resolveProviderForInstrument(createPriceRegistry([b, a]), key("CRYPTO", "BTC"));
    check("ambiguity is order-independent too", JSON.stringify(r1) === JSON.stringify(r2));
  }

  // ── 7. Routing never calls a provider to decide ───────────────────────────
  console.log("7. routing asks, never tries");
  {
    const registry = createPriceRegistry([
      mustNotBeCalled("crypto-only", (k) => k.assetClass === "CRYPTO"),
      mustNotBeCalled("nav-only", () => true),
    ]);
    const eq = resolveProviderForInstrument(registry, key("EQUITY", "AAPL"));
    check("resolution consults declared capability without invoking any adapter",
      eq.kind === "provider" && eq.adapter.source === "nav-only");
  }

  console.log(failures === 0 ? "\nAll provider-unification checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
