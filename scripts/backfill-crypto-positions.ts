/**
 * scripts/backfill-crypto-positions.ts
 *
 * P2-6 — one-time, idempotent bootstrap of legacy crypto `Holding` rows onto the
 * canonical spine as OBSERVED `PositionObservation`s, so a local DB with BTC
 * wallets that predate the dual-write (btc-sync.ts) is visible to
 * getCurrentPositions() without re-syncing every wallet.
 *
 * Safety contract (P2-6 Part 7):
 *   - DRY-RUN by default; pass --apply to write.
 *   - Resolves the ONE canonical BTC Instrument (alias provider="crypto",
 *     externalId="BTC" → adopt the legacy btc-price Instrument → create) BEFORE
 *     writing — never a duplicate BTC Instrument, never a per-wallet Instrument.
 *   - Preserves FinancialAccount identity: one observation per (wallet account,
 *     BTC Instrument, date).
 *   - QUANTITY ONLY: no institution anchor, no invented cost basis, no invented
 *     transaction events — identical doctrine to the live wallet writer.
 *   - Dated to the Holding's last-observed date (updatedAt), NOT a fabricated
 *     history date and NOT necessarily today.
 *   - Idempotent: re-running updates the same (account, BTC, date, OBSERVED,
 *     "wallet") row rather than duplicating.
 *
 * This is the crypto-specific bootstrap. The general
 * scripts/backfill-position-observations.ts must NOT be run against crypto
 * Holdings — its weak "bootstrap:<symbol>" alias + assetClass UNKNOWN + source
 * "plaid" would mint a BTC identity DISJOINT from the canonical CRYPTO Instrument.
 *
 *   npx tsx scripts/backfill-crypto-positions.ts            # dry-run
 *   npx tsx scripts/backfill-crypto-positions.ts --apply    # write
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { PrismaClient, AssetClass, PositionOrigin } from "@prisma/client";

const db = new PrismaClient({ log: ["error"] });
const APPLY = process.argv.includes("--apply");

// Canonical crypto identity — mirrors lib/investments/crypto-instrument.ts
// (replicated inline so this script runs standalone under bare tsx, the same
// self-contained convention as scripts/backfill-position-observations.ts).
const CRYPTO_PROVIDER = "crypto";
const BTC_ASSET = { symbol: "BTC", name: "Bitcoin", currency: "USD" } as const;
const WALLET_SOURCE = "wallet";
const BTC_CHAIN = "BTC";

function truncToUtcDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Resolve (or, on --apply, create) the ONE canonical BTC Instrument id. */
async function resolveBtcInstrumentId(): Promise<string | null> {
  const alias = await db.instrumentAlias.findUnique({
    where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: BTC_ASSET.symbol } },
    select: { instrumentId: true },
  });
  if (alias) return alias.instrumentId;

  const legacy = await db.instrument.findFirst({
    where:   { tickerSymbol: BTC_ASSET.symbol, assetClass: AssetClass.CRYPTO },
    orderBy: { createdAt: "asc" },
    select:  { id: true },
  });
  if (legacy) {
    if (APPLY) {
      await db.instrumentAlias.upsert({
        where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: BTC_ASSET.symbol } },
        create: { instrumentId: legacy.id, provider: CRYPTO_PROVIDER, externalId: BTC_ASSET.symbol, metadata: { adopted: true } },
        update: {},
      });
    }
    return legacy.id;
  }

  if (!APPLY) return null; // would create — reported, not written
  const created = await db.instrument.create({
    data: {
      tickerSymbol: BTC_ASSET.symbol, name: BTC_ASSET.name, assetClass: AssetClass.CRYPTO,
      currency: BTC_ASSET.currency, isCashEquivalent: false,
      aliases: { create: { provider: CRYPTO_PROVIDER, externalId: BTC_ASSET.symbol, metadata: {} } },
    },
    select: { id: true },
  });
  return created.id;
}

async function main() {
  console.log(`\n=== backfill-crypto-positions (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);

  // Legacy BTC wallet Holdings: rows on a self-custodied BTC FinancialAccount.
  const holdings = await db.holding.findMany({
    where: {
      symbol: BTC_ASSET.symbol,
      financialAccountId: { not: null },
      financialAccount: { walletChain: BTC_CHAIN, deletedAt: null },
    },
    select: { financialAccountId: true, quantity: true, updatedAt: true },
  });

  const stats = {
    wallets: new Set<string>(), holdings: 0,
    observationsWritten: 0, observationsPresent: 0, wouldWrite: 0, skipped: 0,
  };

  const instrumentId = await resolveBtcInstrumentId();
  if (holdings.length > 0 && instrumentId == null && !APPLY) {
    console.log("(no canonical BTC Instrument yet — would create on --apply)");
  }

  for (const h of holdings) {
    if (!h.financialAccountId) { stats.skipped++; continue; }
    stats.wallets.add(h.financialAccountId);
    stats.holdings++;

    if (!APPLY || instrumentId == null) { stats.wouldWrite++; continue; }

    const date = truncToUtcDate(h.updatedAt);
    const existing = await db.positionObservation.findUnique({
      where: {
        financialAccountId_instrumentId_date_origin_source: {
          financialAccountId: h.financialAccountId, instrumentId, date,
          origin: PositionOrigin.OBSERVED, source: WALLET_SOURCE,
        },
      },
      select: { id: true },
    });
    if (existing) { stats.observationsPresent++; continue; }

    // Quantity only — no institution anchor, no cost basis, no events.
    await db.positionObservation.create({
      data: {
        financialAccountId: h.financialAccountId, instrumentId, date,
        origin: PositionOrigin.OBSERVED, source: WALLET_SOURCE,
        quantity: h.quantity, currency: BTC_ASSET.currency, isCash: false,
        institutionPrice: null, institutionValue: null, costBasis: null,
      },
    });
    stats.observationsWritten++;
  }

  console.log(`BTC wallets processed:  ${stats.wallets.size}`);
  console.log(`BTC holdings processed: ${stats.holdings}`);
  console.log(`canonical instrument:   ${instrumentId ?? "(would create)"}`);
  console.log(`observations written:   ${stats.observationsWritten}`);
  console.log(`observations present:   ${stats.observationsPresent}`);
  if (!APPLY) console.log(`observations to write:  ${stats.wouldWrite} (would write)`);
  console.log(`skipped/incomplete:     ${stats.skipped}`);
  if (!APPLY) console.log(`\nDRY-RUN — no rows written. Re-run with --apply to persist.`);

  await db.$disconnect();
}

main().catch(async (e) => { console.error("backfill-crypto-positions failed:", e); await db.$disconnect(); process.exit(1); });
