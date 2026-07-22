/**
 * scripts/backfill-position-observations.ts
 *
 * One-time, idempotent backfill of the CURRENT `Holding` rows into day-one
 * OBSERVED PositionObservations (Slice A1). Bootstraps identity from the
 * evidence stored on Holding (symbol/name/currency) — a WEAK ticker alias,
 * explicitly flagged `bootstrap: true` in InstrumentAlias.metadata so it is
 * upgraded to Plaid's real security_id the next time a live refresh runs.
 *
 * DRY-RUN by default. Pass --apply to write. Observations are dated to the
 * real backfill date (today) — NEVER a fabricated historical date. Idempotent:
 * re-running updates the same (account, instrument, today, OBSERVED, "plaid")
 * row rather than duplicating.
 *
 *   npx tsx scripts/backfill-position-observations.ts            # dry-run
 *   npx tsx scripts/backfill-position-observations.ts --apply    # write
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { PrismaClient, AssetClass, PositionOrigin } from "@prisma/client";

const db = new PrismaClient({ log: ["error"] });
const APPLY = process.argv.includes("--apply");
const PROVIDER = "plaid";

function normalizeToday(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function main() {
  console.log(`\n=== backfill-position-observations (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
  const today = normalizeToday();

  // Only Holding rows anchored to a FinancialAccount (the current data model).
  const holdings = await db.holding.findMany({
    where: { financialAccountId: { not: null } },
    select: { financialAccountId: true, symbol: true, name: true, currency: true, quantity: true, price: true, value: true, isCash: true },
  });

  const stats = {
    accounts: new Set<string>(), holdings: 0, instrumentsResolved: 0, instrumentsCreated: 0,
    observationsCreated: 0, observationsPresent: 0, skipped: 0, conflicts: 0,
  };

  for (const h of holdings) {
    if (!h.financialAccountId) { stats.skipped++; continue; }
    stats.accounts.add(h.financialAccountId);
    stats.holdings++;

    // Bootstrap identity by weak ticker alias (provider "plaid" is NOT used here
    // — these are pre-Plaid-security_id bootstraps under a distinct provider so
    // a real Plaid alias never collides with a bootstrap one).
    const bootstrapExternalId = `bootstrap:${h.symbol}`;
    const existingAlias = await db.instrumentAlias.findUnique({
      where: { provider_externalId: { provider: "bootstrap", externalId: bootstrapExternalId } },
      select: { instrumentId: true },
    });

    let instrumentId = existingAlias?.instrumentId ?? null;
    if (!instrumentId) {
      stats.instrumentsCreated++;
      if (APPLY) {
        const inst = await db.instrument.create({
          data: {
            tickerSymbol: h.symbol, name: h.name ?? h.symbol,
            assetClass: h.isCash ? AssetClass.CASH : AssetClass.UNKNOWN,
            currency: h.currency ?? null, isCashEquivalent: h.isCash ? true : null,
            aliases: { create: { provider: "bootstrap", externalId: bootstrapExternalId, metadata: { bootstrap: true, source: "holding" } } },
          },
          select: { id: true },
        });
        instrumentId = inst.id;
      }
    } else {
      stats.instrumentsResolved++;
    }

    if (!APPLY || !instrumentId) continue;

    const existing = await db.positionObservation.findUnique({
      where: {
        financialAccountId_instrumentId_date_origin_source: {
          financialAccountId: h.financialAccountId, instrumentId, date: today, origin: PositionOrigin.OBSERVED, source: PROVIDER,
        },
      },
      select: { id: true },
    });
    if (existing) { stats.observationsPresent++; continue; }

    await db.positionObservation.create({
      data: {
        financialAccountId: h.financialAccountId, instrumentId, date: today,
        origin: PositionOrigin.OBSERVED, source: PROVIDER,
        quantity: h.quantity, institutionPrice: h.price, institutionValue: h.value,
        currency: h.currency ?? null, isCash: h.isCash,
      },
    });
    stats.observationsCreated++;
  }

  console.log(`accounts processed:     ${stats.accounts.size}`);
  console.log(`holdings processed:     ${stats.holdings}`);
  console.log(`instruments resolved:   ${stats.instrumentsResolved}`);
  console.log(`instruments created:    ${stats.instrumentsCreated}${APPLY ? "" : " (would create)"}`);
  console.log(`observations created:   ${stats.observationsCreated}${APPLY ? "" : " (would create)"}`);
  console.log(`observations present:   ${stats.observationsPresent}`);
  console.log(`skipped/incomplete:     ${stats.skipped}`);
  console.log(`conflicts:              ${stats.conflicts}`);
  if (!APPLY) console.log(`\nDRY-RUN — no rows written. Re-run with --apply to persist.`);

  await db.$disconnect();
}

main().catch(async (e) => { console.error("backfill failed:", e); await db.$disconnect(); process.exit(1); });
