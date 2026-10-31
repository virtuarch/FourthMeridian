/**
 * lib/crypto/spl-history.store.ts
 *
 * The database half of SPL token history (spl-history.ts): the token state in
 * the SOL checkpoint (Connection.cursor, compare-and-swapped exactly as the
 * native store does), and — for a mint whose verdict is in — its DERIVED rows
 * and its PositionCoverage licence, written in the SAME transaction as the
 * checkpoint. One Instrument per token across all customers
 * (`resolveTokenInstrumentId`, CAIP-19 alias, ticker NULL).
 *
 * The client is the CALLER's authority (never a module default — audit-db-authority).
 */

import { PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { persistPositionCoverage } from "./position-coverage";
import { resolveTokenInstrumentId, loadTokenAliasMetadata } from "./token-instrument";
import { splTokenAssetKey } from "./token-asset";
import { CheckpointConflictError } from "./sol-history-backfill";
import { SPL_HISTORY_SOURCE, SPL_CHAIN_STATED_BASIS, SPL_RECONSTRUCTION_VERSION } from "./spl-history.core";
import type { SplHistoryStore } from "./spl-history";
import { readTokenQuoteMarker } from "@/lib/prices/current-quotes";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Kill switch for the whole token-history step (off unless SPL_HISTORY_ENABLED=true). */
export function splHistoryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SPL_HISTORY_ENABLED === "true";
}

/** Token-history requests one wallet SYNC may send (the worker brings its own allowance). Default 25, clamped 0..200. */
export function splSyncRequestLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SPL_HISTORY_SYNC_REQUEST_LIMIT);
  return Number.isInteger(n) && n >= 0 && n <= 200 ? n : 25;
}

export function prismaSplHistoryStore(accountId: string, connectionId: string, db: PrismaClient): SplHistoryStore {
  return {
    async readCursor() {
      const c = await db.connection.findUnique({ where: { id: connectionId }, select: { cursor: true } });
      return c?.cursor ?? null;
    },

    async commit(c) {
      await db.$transaction(async (tx: Prisma.TransactionClient) => {
        const swapped = await tx.connection.updateMany({ where: { id: connectionId, cursor: c.expectedCursor }, data: { cursor: c.nextCursor } });
        if (swapped.count !== 1) throw new CheckpointConflictError();
        const m = c.mint;
        if (!m) return;
        const instrumentId = await resolveTokenInstrumentId({
          assetKey: splTokenAssetKey(m.mint), standard: "SPL", contract: m.mint, decimals: m.decimals,
          symbol: null, name: null, ...(m.program ? { program: m.program } : {}),
        }, { client: tx });
        const scope = { financialAccountId: accountId, instrumentId, origin: PositionOrigin.DERIVED, source: SPL_HISTORY_SOURCE };
        if (m.replaceAll) {
          await tx.positionObservation.deleteMany({ where: scope });
        } else {
          if (m.deleteBeforeISO) await tx.positionObservation.deleteMany({ where: { ...scope, date: { lt: day(m.deleteBeforeISO) } } });
          if (m.deleteFromISO && m.deleteToISO) {
            await tx.positionObservation.deleteMany({ where: { ...scope, date: { gte: day(m.deleteFromISO), lte: day(m.deleteToISO) } } });
          }
        }
        if (m.rows.length > 0) {
          await tx.positionObservation.createMany({
            data: m.rows.map((r) => ({
              financialAccountId: accountId, instrumentId,
              date: day(r.dateISO), quantity: r.quantity,
              origin: PositionOrigin.DERIVED, source: SPL_HISTORY_SOURCE,
              completeness: SPL_CHAIN_STATED_BASIS, reconstructionVersion: SPL_RECONSTRUCTION_VERSION, isCash: false,
            })),
            skipDuplicates: true,
          });
        }
        await persistPositionCoverage(tx, accountId, instrumentId, m.coverage);
      });
    },

    async pricedMints(mints) {
      const keys = mints.map(splTokenAssetKey);
      const meta = await loadTokenAliasMetadata(db, keys);
      const aliasRows = keys.length === 0 ? [] : await db.instrumentAlias.findMany({
        where: { provider: "crypto", externalId: { in: keys } }, select: { externalId: true, metadata: true },
      });
      const out = new Set<string>();
      for (const a of aliasRows) {
        const q = readTokenQuoteMarker(a.metadata);
        // A thin or unlisted token is never valued, so it is never "priced" for ordering.
        if (q?.pricedAt && q.outcome === "PRICED") out.add(a.externalId.slice(a.externalId.lastIndexOf(":") + 1));
      }
      const ids = [...meta.values()].map((m) => m.instrumentId);
      if (ids.length) {
        const withPrice = await db.priceObservation.groupBy({ by: ["instrumentId"], where: { instrumentId: { in: ids } } });
        const priced = new Set(withPrice.map((p) => p.instrumentId));
        for (const [k, m] of meta) if (priced.has(m.instrumentId) && readTokenQuoteMarker(aliasRows.find((a) => a.externalId === k)?.metadata)?.outcome !== "THIN") out.add(m.contract);
      }
      return out;
    },

    async acquirePrices(m) {
      // The first-time quote probe (sold mints) + THE shared token price path — spl-history-prices.ts.
      const { acquireSplHistoricalPrices } = await import("./spl-history-prices");
      return acquireSplHistoricalPrices({ client: db, accountId, mint: m.mint, fromISO: m.fromISO, toISO: m.toISO, enabled: splHistoryEnabled() });
    },
  };
}
