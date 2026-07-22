/**
 * lib/investments/crypto-instrument.test.ts
 *
 * P2-6 — canonical crypto Instrument identity: pure precedence tests + source-scan
 * invariants proving ONE deterministic BTC identity rule with NO duplicate /
 * per-wallet Instrument.
 *
 *     npx tsx lib/investments/crypto-instrument.test.ts
 *
 * PART A exercises the PURE decision core. PART B source-scans the DB-touching
 * bindings (which pull @/lib/db and can't import under bare tsx).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { decideCryptoResolution, BTC_ASSET, CRYPTO_PROVIDER } from "./crypto-instrument";

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
  JSON.stringify(decideCryptoResolution({ aliasInstrumentId: "inst_A", legacyInstrumentId: null }))
    === JSON.stringify({ action: "use", instrumentId: "inst_A" }));

// Alias takes precedence over a legacy price Instrument (never forks off it).
check("alias precedence over legacy",
  decideCryptoResolution({ aliasInstrumentId: "inst_A", legacyInstrumentId: "inst_legacy" }).action === "use");

// No alias yet, but btc-price already minted the pricing Instrument → ADOPT it,
// so the position spine and the price series share ONE row (no duplicate).
check("no alias + legacy price Instrument → adopt (converge, never duplicate)",
  JSON.stringify(decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: "inst_legacy" }))
    === JSON.stringify({ action: "adopt", instrumentId: "inst_legacy" }));

// Nothing to reuse → create exactly one canonical Instrument.
check("no alias + no legacy → create",
  decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: null }).action === "create");

// Determinism: identical inputs, identical decision.
check("deterministic (same input → same decision)",
  JSON.stringify(decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: "x" }))
    === JSON.stringify(decideCryptoResolution({ aliasInstrumentId: null, legacyInstrumentId: "x" })));

check("BTC_ASSET is the canonical BTC descriptor",
  BTC_ASSET.symbol === "BTC" && BTC_ASSET.currency === "USD" && CRYPTO_PROVIDER === "crypto");

// ── PART B — source-scan invariants ───────────────────────────────────────────

const resolver = code(read("lib", "investments", "crypto-instrument.ts"));

// Identity keyed on the InstrumentAlias unique — the structural no-duplicate guard.
check("resolver keys canonical identity on alias (provider=crypto, externalId=symbol)",
  /provider:\s*CRYPTO_PROVIDER/.test(resolver) && resolver.includes("provider_externalId"));

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

console.log(`\ncrypto-instrument: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
