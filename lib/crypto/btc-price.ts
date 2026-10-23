/**
 * lib/crypto/btc-price.ts
 *
 * A8-3B (crypto) — what remains of the BTC-specific price module.
 *
 * V26-PRICE-PROVIDER-UNIFICATION removed `backfillBtcPrices` from here. BTC
 * ACQUISITION travels the same registry path as equities
 * (backfillPricesForInstruments → capability routing → CoinGecko adapter →
 * priceArchive), so no asset-specific acquisition code exists anywhere.
 *
 * ── W-M1a — `readBtcUsdWindow` IS GONE, AND THAT IS THE POINT ────────────────
 * This module also carried the BTC VALUATION read, retained with a note saying
 * generalising it belonged to a later slice. W-M0 generalised it anyway, because
 * a multi-asset valuation core cannot be fed by a reader that can only answer
 * for one asset: `readCryptoUsdWindows` (lib/crypto/crypto-price-window.ts)
 * takes a set of canonical assets, resolves each by `assetKey`, and reads the
 * whole window in one archive call. Both former call sites moved.
 *
 * It is DELETED rather than kept as a delegating convenience. A wrapper with no
 * production caller is not compatibility, it is a second way to ask the same
 * question — and this module's own history is the argument: the last time BTC
 * had a private path to the price archive, it became a second acquisition
 * pipeline that bypassed the registry entirely and made "add Solana" mean
 * editing an adapter. The guard in lib/prices/provider-unification.test.ts now
 * pins the ABSENCE: no BTC-specific valuation read survives.
 *
 * What is left is one line of identity, and it is here rather than in
 * crypto-instrument.ts only because `resolveBtcInstrumentId` is the name the
 * price backfill has always called. It delegates to the ONE canonical crypto
 * minter; nothing in this file mints, reads or writes a price.
 */

import { resolveCanonicalBtcInstrumentId } from "@/lib/investments/crypto-instrument";

/**
 * Provenance stamped on BTC price rows, and the provider identity the capability
 * reconciliation in jobs/sync-crypto.ts is keyed on. Still exported for readers
 * that key on it; the WRITER is the shared archive path, not this module.
 */
export const BTC_PRICE_SOURCE = "coingecko";

/**
 * The single global BTC Instrument (assetClass CRYPTO) the RAW_CLOSE price
 * series is written against. Delegates to the ONE canonical crypto Instrument
 * resolver (P2-6), which since W-M1a keys identity on `assetKey`, so the price
 * series and the position spine share ONE row by construction. Idempotent and
 * dedupe-safe.
 */
export async function resolveBtcInstrumentId(): Promise<string> {
  return resolveCanonicalBtcInstrumentId();
}
