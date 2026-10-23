/**
 * lib/investments/crypto-instrument.test.ts
 *
 * P2-6 / W-M1a — canonical crypto Instrument identity: pure precedence tests +
 * source-scan invariants proving ONE deterministic identity rule per ASSET, with
 * no duplicate and no per-wallet Instrument.
 *
 * W-M1a moved identity off the ticker and onto `assetKey` (CAIP-19), and closed
 * legacy ticker adoption to a grandfather set of one. The tests that matter most
 * here are the NEGATIVE ones: a token that merely shares a native asset's ticker
 * must never be adopted as that asset.
 *
 *     npx tsx lib/investments/crypto-instrument.test.ts
 *
 * PART A exercises the PURE decision core. PART B source-scans the DB-touching
 * bindings (which pull @/lib/db and can't import under bare tsx).
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  decideCryptoResolution, legacyTickerAdoptionPermitted, LEGACY_TICKER_ADOPTABLE,
  BTC_ASSET, ETH_ASSET, SOL_ASSET, CRYPTO_PROVIDER, type CryptoAsset,
} from "./crypto-instrument";
import { BTC_NATIVE, ETH_NATIVE, SOL_NATIVE, NATIVE_ASSETS } from "@/lib/crypto/native-asset";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(...seg: string[]): string {
  return readFileSync(join(process.cwd(), ...seg), "utf8");
}
/** strip comments so scans match real code, not prose/doc-comments. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

// ── PART A — pure precedence ──────────────────────────────────────────────────

// Canonical alias wins — deterministic O(1) repeats, the same asset every time.
check("alias hit → use (canonical fast path)",
  JSON.stringify(decideCryptoResolution({ aliasInstrumentId: "inst_A", legacyInstrumentId: null, legacyAdoptionPermitted: true }))
    === JSON.stringify({ action: "use", instrumentId: "inst_A" }));

// Alias takes precedence over a legacy price Instrument (never forks off it).
check("alias precedence over legacy",
  decideCryptoResolution({ aliasInstrumentId: "inst_A", legacyInstrumentId: "inst_legacy", legacyAdoptionPermitted: true }).action === "use");

// No alias yet, but btc-price already minted the pricing Instrument → ADOPT it,
// so the position spine and the price series share ONE row (no duplicate).
check("no alias + legacy price Instrument + PERMITTED → adopt (converge, never duplicate)",
  JSON.stringify(decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: "inst_legacy", legacyAdoptionPermitted: true }))
    === JSON.stringify({ action: "adopt", instrumentId: "inst_legacy" }));

// ── W-M1a — THE REFUSAL THAT MAKES TICKERS SAFE ─────────────────────────────
// A ticker match is NOT a reason to adopt. Without this, minting an ERC-20
// tickered "SOL" and then resolving native Solana would have found it by ticker
// and repointed every Solana wallet at a scam contract's price series.
check("no alias + legacy match + NOT permitted → create (never adopt on ticker alone)",
  JSON.stringify(decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: "inst_token_SOL", legacyAdoptionPermitted: false }))
    === JSON.stringify({ action: "create" }));

// The permission is carried explicitly and cannot be inferred from the shape of
// the inputs: identical instrument ids, opposite decisions.
check("the ONLY difference between adopt and create is the explicit permission",
  decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: "same", legacyAdoptionPermitted: true }).action === "adopt"
    && decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: "same", legacyAdoptionPermitted: false }).action === "create");

// Nothing to reuse → create exactly one canonical Instrument.
check("no alias + no legacy → create",
  decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: null, legacyAdoptionPermitted: true }).action === "create");

// Determinism: identical inputs, identical decision.
check("deterministic (same input → same decision)",
  JSON.stringify(decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: "x", legacyAdoptionPermitted: true }))
    === JSON.stringify(decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: "x", legacyAdoptionPermitted: true })));

// ── PART A2 — W-M1a identity: assetKey, and the closed grandfather set ───────

check("CRYPTO_PROVIDER is the alias namespace", CRYPTO_PROVIDER === "crypto");

// The descriptors ARE the native-asset registry entries, not copies. One
// declaration, so the ticker that mints the Instrument cannot drift from the one
// that scopes the ledger or keys the price map.
check("BTC/ETH/SOL descriptors are the native-asset registry entries themselves",
  BTC_ASSET === BTC_NATIVE && ETH_ASSET === ETH_NATIVE && SOL_ASSET === SOL_NATIVE);

const ALL: CryptoAsset[] = [BTC_ASSET, ETH_ASSET, SOL_ASSET];

check("every native asset carries a chain-qualified CAIP-19 assetKey",
  ALL.every((a) => /^[a-z0-9]+:[A-Za-z0-9]+\/slip44:\d+$/.test(a.assetKey)));
check("the assetKeys are the expected stable values",
  BTC_ASSET.assetKey === "bip122:000000000019d6689c085ae165831e93/slip44:0"
    && ETH_ASSET.assetKey === "eip155:1/slip44:60"
    && SOL_ASSET.assetKey === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501");

// EXACTLY ONE canonical identity per asset, and identity ≠ ticker.
check("exactly one canonical assetKey per native asset (no collisions)",
  new Set(NATIVE_ASSETS.map((a) => a.assetKey)).size === NATIVE_ASSETS.length);
// The key is never the ticker, and is always CHAIN-QUALIFIED — which is what
// makes two same-ticker assets on different chains distinguishable. (A namespace
// may legitimately begin with the ticker's letters — Solana's CAIP-2 namespace
// is literally "solana" — so the test is the structure, not a substring taboo.)
check("assetKey is never merely the ticker, and always names a chain first",
  ALL.every((a) => a.assetKey !== a.symbol
    && a.assetKey.split("/")[0].includes(":")
    && a.assetKey.split("/").length === 2));
check("resolution by assetKey is deterministic (same key → same descriptor)",
  ALL.every((a) => NATIVE_ASSETS.find((x) => x.assetKey === a.assetKey) === a));

// DUPLICATE SYMBOLS CANNOT BECOME IDENTITY. Two descriptors that share a ticker
// remain two distinct identities, which is the entire point of the change.
{
  const spoofToken: CryptoAsset = {
    assetKey: "eip155:1/erc20:0x0000000000000000000000000000000000000bad",
    symbol: "SOL", name: "Not Solana", currency: "USD",
  };
  check("a token sharing the ticker SOL is a DIFFERENT identity from native SOL",
    spoofToken.symbol === SOL_ASSET.symbol && spoofToken.assetKey !== SOL_ASSET.assetKey);
  check("…and it is NOT permitted to adopt a ticker-matched Instrument",
    !legacyTickerAdoptionPermitted(spoofToken));
  check("…so resolving it CREATES its own row rather than seizing native SOL's",
    decideCryptoResolution({
      aliasInstrumentId: null, legacyInstrumentId: "inst_native_SOL",
      legacyAdoptionPermitted: legacyTickerAdoptionPermitted(spoofToken),
    }).action === "create");

  const spoofEth: CryptoAsset = { ...spoofToken, symbol: "ETH", assetKey: "eip155:1/erc20:0xdead" };
  check("the same holds for a token tickered ETH", !legacyTickerAdoptionPermitted(spoofEth));
}

// The grandfather set is CLOSED and contains exactly the one historical asset.
check("only BTC may adopt a ticker-matched pre-alias Instrument",
  legacyTickerAdoptionPermitted(BTC_ASSET)
    && !legacyTickerAdoptionPermitted(ETH_ASSET)
    && !legacyTickerAdoptionPermitted(SOL_ASSET));
check("the grandfather set holds exactly ONE entry, and it is BTC's assetKey",
  LEGACY_TICKER_ADOPTABLE.size === 1 && LEGACY_TICKER_ADOPTABLE.has(BTC_ASSET.assetKey));

// Legacy BTC data is absorbed, not duplicated: the pre-W-M1a corpus has a BTC
// Instrument reachable only by ticker, and BTC resolves onto THAT row.
check("legacy BTC adoption yields the EXISTING instrument, never a second one",
  JSON.stringify(decideCryptoResolution({
    aliasInstrumentId: null, legacyInstrumentId: "inst_btc_378_prices",
    legacyAdoptionPermitted: legacyTickerAdoptionPermitted(BTC_ASSET),
  })) === JSON.stringify({ action: "adopt", instrumentId: "inst_btc_378_prices" }));

// ── PART B — source-scan invariants ───────────────────────────────────────────

const resolver = code(read("lib", "investments", "crypto-instrument.ts"));

// Identity keyed on the InstrumentAlias unique — the structural no-duplicate guard.
check("resolver keys canonical identity on alias (provider=crypto, externalId=assetKey)",
  /provider:\s*CRYPTO_PROVIDER/.test(resolver) && resolver.includes("provider_externalId"));

// W-M1a — the alias externalId is the assetKey EVERYWHERE (lookup, adopt-upsert,
// create, and the lost-race re-read). A single surviving symbol-keyed write
// would fork identity for exactly the assets this change protects.
check("EVERY alias externalId in the resolver is asset.assetKey — none is asset.symbol",
  /externalId:\s*asset\.assetKey/.test(resolver)
    && !/externalId:\s*asset\.symbol/.test(resolver));
// FIVE sites, and every one of them must be the assetKey: the canonical lookup,
// the adopt-upsert's `where` and its `create`, the fresh Instrument's nested
// alias, and the lost-create-race re-read. One survivor keyed on the ticker
// would fork identity for precisely the assets this change protects.
check("all FIVE alias key sites use assetKey",
  (resolver.match(/externalId:\s*asset\.assetKey/g) ?? []).length === 5,
  `found ${(resolver.match(/externalId:\s*asset\.assetKey/g) ?? []).length}`);
check("the ticker is written only as Instrument.tickerSymbol (display)",
  /tickerSymbol:\s*asset\.symbol/.test(resolver));

// The ticker query must be GATED, not merely out-ranked: a non-grandfathered
// asset must never even LOOK for a ticker match.
check("the legacy ticker lookup is gated on the grandfather set",
  /legacyTickerAdoptionPermitted\(asset\)/.test(resolver)
    && /alias \|\| !adoptionPermitted/.test(resolver));
check("the pure rule ALSO refuses independently (two refusals, not one)",
  /legacyAdoptionPermitted/.test(resolver));

// The asset symbol, not the wallet/account, is the identity → never per-wallet.
check("resolver does NOT key identity on financialAccountId (asset identity, not custody)",
  !/financialAccountId/.test(resolver));

// New canonical Instrument is CRYPTO, matching btc-price's findFirst predicate so
// the price backfill adopts it rather than minting a second row.
check("resolver creates assetClass CRYPTO (converges with the price Instrument)",
  /assetClass:\s*AssetClass\.CRYPTO/.test(resolver));

// Legacy adoption is deterministic (oldest first) even if a prior duplicate exists.
check("legacy adoption ordered by createdAt (deterministic under pre-existing dup)",
  /orderBy:\s*\{\s*createdAt:\s*["']asc["']\s*\}/.test(resolver));

// Concurrent-create race is handled by re-reading the alias (no orphan Instrument).
check("resolver recovers from a lost create race via the alias",
  /catch\s*\(/.test(resolver) && /findUnique/.test(resolver));

// btc-price is now a SINGLE-minter delegate — it no longer mints its own BTC row.
const btcPrice = code(read("lib", "crypto", "btc-price.ts"));
check("btc-price delegates to the canonical resolver",
  btcPrice.includes("resolveCanonicalBtcInstrumentId"));
check("btc-price no longer runs its own instrument.create (single minter)",
  !/instrument\.create/.test(btcPrice) && !/instrument\.findFirst/.test(btcPrice));
// W-M1a — the BTC-only valuation read is DELETED, not wrapped. See
// lib/prices/provider-unification.test.ts for the stronger paired guard.
check("btc-price carries no BTC-specific valuation read",
  !btcPrice.includes("readBtcUsdWindow"));

// The read-only price lookup must mirror the minter's precedence EXACTLY,
// grandfather gate included — otherwise the read would resolve native SOL to a
// ticker-matched token while the minter refused.
const priceWindow = code(read("lib", "crypto", "crypto-price-window.ts"));
check("the price lookup keys on assetKey",
  /externalId:\s*asset\.assetKey/.test(priceWindow));
check("the price lookup enforces the SAME grandfather gate as the minter",
  /legacyTickerAdoptionPermitted\(asset\)/.test(priceWindow));
check("the price lookup never creates an Instrument (a read makes no identity claim)",
  !/instrument\.create/.test(priceWindow) && !/instrumentAlias\.(create|upsert)/.test(priceWindow));

console.log(`\ncrypto-instrument: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
