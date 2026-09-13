/**
 * lib/ai/brief/watermark.ts
 *
 * THE SOURCE WATERMARK — "something the Brief reads may have changed."
 *
 * ⚠️ NOT MATERIALITY. An unchanged watermark lets a stored Brief be served without
 * assembling anything. A changed one only means the package must be assembled and
 * its material digest compared (digest.ts); most changes end there, with no model
 * call.
 *
 * ⚠️ THE INPUTS ARE THE PACKAGE'S ACTUAL READS (traced from 0e1cf1e), not a guess:
 *
 *   SpaceAccountLink        count, max(updatedAt)          visibility, revocation
 *   FinancialAccount        count, max(updatedAt)          balances, clocks, debt columns, sync status —
 *                                                         over the linked accounts AND their owners'
 *                                                         other accounts, which transfer matching reads
 *   DebtProfile             max(updatedAt)                 APR / minimum payment (knowledge gaps)
 *   AccountConnection       max(updatedAt)                 connection ownership, soft delete
 *   PlaidItem               max(updatedAt)                 NEEDS_REAUTH
 *   Connection              max(updatedAt)                 wallet sync
 *   Transaction             count, max(updatedAt)          new, reclassified, posted, soft-deleted rows
 *   TransactionEvent        max(updatedAt)                 which row represents an event
 *   PositionObservation     count, max(createdAt), superseded count, deleted count
 *                                                         (append-only, no updatedAt — the counts
 *                                                         are the workaround), and a hash of the
 *                                                         last 7 days' rows: a same-day capture
 *                                                         UPSERTS quantity and value in place,
 *                                                         which moves none of the counts
 *   PositionReconstruction  hash of rows                   upserted with no moving timestamp
 *   Instrument              max(updatedAt)                 held instruments' metadata
 *   PriceObservation        max(createdAt), last 14 days   held instruments' prices
 *   FxRate                  max(fetchedAt), last 14 days   conversion
 *   SpaceSnapshot           hash of the newest 1,100 rows  upserted with no updatedAt: a value
 *                                                         rewrite moves nothing else
 *   Space                   updatedAt                      reporting currency
 *   SpaceDashboardSection   updatedAt                      declared monthly expenses
 *   SpaceMemory             count, ACTIVE count, max(createdAt) — for THIS OWNER in THIS Space only
 *   PlatformSetting         hash of the refresh-cadence rows the expected refresh cadence that decides
 *                                                         "overdue" — a policy change moves health
 *                                                         with no financial row changing
 *   clock                   floor(now / 1 h)               freshness bands that move with time alone
 *
 * ⚠️ DELIBERATELY NOT INPUTS. Merchant renames and the names of users who added a
 * link can change package TEXT but no material field, so they cannot make a Brief
 * deserve reconsideration. A pending successor matched without account scope is
 * not covered (it sits on a covered account in practice).
 *
 * ⚠️ SAFE TO PERSIST. The stored value is a SHA-256 of counts, timestamps and row
 * hashes — no balance, name, id or number that could be read back out of it.
 *
 * ⚠️ CURRENT-DAY ONLY. Every clock here is the source's present state; there is no
 * retrospective watermark, and the persisted lifecycle never runs retrospectively.
 */

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { REFRESH_CADENCE_SETTING_KEY } from '@/lib/platform/refresh-policy.core';
import { WATERMARK_CLOCK_BUCKET_MS } from './policy';

export const WATERMARK_VERSION = 'brief-source-v3';

/** What the watermark is computed from. Counts, clocks and opaque row hashes only. */
export interface WatermarkInputs {
  linkCount: number; linkUpdatedAt: Date | null;
  accountCount: number; accountUpdatedAt: Date | null;
  debtProfileUpdatedAt: Date | null;
  accountConnectionUpdatedAt: Date | null;
  plaidItemUpdatedAt: Date | null;
  connectionUpdatedAt: Date | null;
  transactionCount: number; transactionUpdatedAt: Date | null;
  transactionEventUpdatedAt: Date | null;
  positionCount: number; positionCreatedAt: Date | null;
  positionSupersededCount: number; positionDeletedCount: number;
  recentPositionHash: string | null;
  reconstructionHash: string | null;
  instrumentUpdatedAt: Date | null;
  priceCreatedAt: Date | null;
  fxFetchedAt: Date | null;
  snapshotHash: string | null;
  spaceUpdatedAt: Date | null;
  expenseSectionUpdatedAt: Date | null;
  memoryCount: number; memoryActiveCount: number; memoryCreatedAt: Date | null;
  refreshPolicyHash: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Pure: inputs + the clock bucket → the watermark. */
export function computeWatermark(inputs: WatermarkInputs, now: Date): string {
  const fields = Object.keys(inputs).sort().map((k) => {
    const v = (inputs as unknown as Record<string, unknown>)[k];
    return `${k}=${v instanceof Date ? iso(v) : v === null ? '' : String(v)}`;
  });
  fields.push(`clock=${Math.floor(now.getTime() / WATERMARK_CLOCK_BUCKET_MS)}`);
  return `${WATERMARK_VERSION}:${createHash('sha256').update(fields.join('\n')).digest('hex').slice(0, 40)}`;
}

/** The narrow client surface the read needs — injectable, and the DB check uses the real one. */
export interface WatermarkClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0);
const date = (v: unknown) => (v instanceof Date ? v : null);
const text = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * One read-only round trip. Every subquery is scoped to the Space's links (or the
 * owners of the linked accounts, for the transfer-matching universe), to this
 * owner's memory, or — for the two global archives — to a 14-day recency floor.
 */
export async function readWatermarkInputs(
  client: WatermarkClient, scope: { spaceId: string; ownerUserId: string },
): Promise<WatermarkInputs> {
  const { spaceId, ownerUserId } = scope;
  const rows = await client.$queryRaw<Row[]>(Prisma.sql`
    WITH links AS (
      SELECT "financialAccountId" AS id, "updatedAt" FROM "SpaceAccountLink" WHERE "spaceId" = ${spaceId}
    ),
    owners AS (
      SELECT DISTINCT "ownerUserId" AS uid FROM "FinancialAccount"
      WHERE id IN (SELECT id FROM links) AND "ownerUserId" IS NOT NULL
    ),
    universe AS (
      SELECT id FROM "FinancialAccount"
      WHERE id IN (SELECT id FROM links) OR "ownerUserId" IN (SELECT uid FROM owners)
    ),
    held AS (
      SELECT DISTINCT "instrumentId" AS id FROM "PositionObservation" WHERE "financialAccountId" IN (SELECT id FROM links)
    )
    SELECT
      (SELECT count(*) FROM links) AS "linkCount",
      (SELECT max("updatedAt") FROM links) AS "linkUpdatedAt",
      (SELECT count(*) FROM universe) AS "accountCount",
      (SELECT max("updatedAt") FROM "FinancialAccount" WHERE id IN (SELECT id FROM universe)) AS "accountUpdatedAt",
      (SELECT max("updatedAt") FROM "DebtProfile" WHERE "financialAccountId" IN (SELECT id FROM links)) AS "debtProfileUpdatedAt",
      (SELECT max("updatedAt") FROM "AccountConnection" WHERE "financialAccountId" IN (SELECT id FROM links)) AS "accountConnectionUpdatedAt",
      (SELECT max(p."updatedAt") FROM "PlaidItem" p WHERE p.id IN (
        SELECT "plaidItemDbId" FROM "AccountConnection" WHERE "financialAccountId" IN (SELECT id FROM links))) AS "plaidItemUpdatedAt",
      (SELECT max(c."updatedAt") FROM "Connection" c WHERE c.id IN (
        SELECT "connectionId" FROM "AccountConnection" WHERE "financialAccountId" IN (SELECT id FROM links))) AS "connectionUpdatedAt",
      (SELECT count(*) FROM "Transaction" WHERE "financialAccountId" IN (SELECT id FROM universe)) AS "transactionCount",
      (SELECT max("updatedAt") FROM "Transaction" WHERE "financialAccountId" IN (SELECT id FROM universe)) AS "transactionUpdatedAt",
      (SELECT max("updatedAt") FROM "TransactionEvent" WHERE "financialAccountId" IN (SELECT id FROM universe)) AS "transactionEventUpdatedAt",
      (SELECT count(*) FROM "PositionObservation" WHERE "financialAccountId" IN (SELECT id FROM links)) AS "positionCount",
      (SELECT max("createdAt") FROM "PositionObservation" WHERE "financialAccountId" IN (SELECT id FROM links)) AS "positionCreatedAt",
      (SELECT count(*) FROM "PositionObservation" WHERE "financialAccountId" IN (SELECT id FROM links) AND "supersededById" IS NOT NULL) AS "positionSupersededCount",
      (SELECT count(*) FROM "PositionObservation" WHERE "financialAccountId" IN (SELECT id FROM links) AND "deletedAt" IS NOT NULL) AS "positionDeletedCount",
      (SELECT md5(string_agg(md5(concat_ws('|', p.id, p.quantity, p."institutionValue", p."institutionPrice", p."costBasis",
          p."deletedAt", p."supersededById")), '' ORDER BY p.id)) FROM "PositionObservation" p
        WHERE p."financialAccountId" IN (SELECT id FROM links) AND p.date >= current_date - 7) AS "recentPositionHash",
      (SELECT md5(string_agg(md5(row_to_json(r)::text), '' ORDER BY r.id)) FROM "PositionReconstruction" r
        WHERE r."financialAccountId" IN (SELECT id FROM links)) AS "reconstructionHash",
      (SELECT max("updatedAt") FROM "Instrument" WHERE id IN (SELECT id FROM held)) AS "instrumentUpdatedAt",
      (SELECT max("createdAt") FROM "PriceObservation"
        WHERE "instrumentId" IN (SELECT id FROM held) AND date >= current_date - 14) AS "priceCreatedAt",
      (SELECT max("fetchedAt") FROM "FxRate" WHERE date >= current_date - 14) AS "fxFetchedAt",
      (SELECT md5(string_agg(md5(row_to_json(s)::text), '' ORDER BY s.date)) FROM (
        SELECT * FROM "SpaceSnapshot" WHERE "spaceId" = ${spaceId} ORDER BY date DESC LIMIT 1100) s) AS "snapshotHash",
      (SELECT "updatedAt" FROM "Space" WHERE id = ${spaceId}) AS "spaceUpdatedAt",
      (SELECT "updatedAt" FROM "SpaceDashboardSection" WHERE "spaceId" = ${spaceId} AND key = 'emergency_fund_progress') AS "expenseSectionUpdatedAt",
      (SELECT count(*) FROM "SpaceMemory" WHERE "spaceId" = ${spaceId} AND "ownerUserId" = ${ownerUserId}) AS "memoryCount",
      (SELECT count(*) FROM "SpaceMemory" WHERE "spaceId" = ${spaceId} AND "ownerUserId" = ${ownerUserId} AND status = 'ACTIVE') AS "memoryActiveCount",
      (SELECT max("createdAt") FROM "SpaceMemory" WHERE "spaceId" = ${spaceId} AND "ownerUserId" = ${ownerUserId}) AS "memoryCreatedAt",
      (SELECT md5(string_agg(key || '=' || value || '@' || "updatedAt"::text, ',' ORDER BY key)) FROM "PlatformSetting"
        WHERE key IN (${REFRESH_CADENCE_SETTING_KEY.BANK}, ${REFRESH_CADENCE_SETTING_KEY.WALLET})) AS "refreshPolicyHash"
  `);
  const r = rows[0] ?? {};
  return {
    linkCount: num(r.linkCount), linkUpdatedAt: date(r.linkUpdatedAt),
    accountCount: num(r.accountCount), accountUpdatedAt: date(r.accountUpdatedAt),
    debtProfileUpdatedAt: date(r.debtProfileUpdatedAt),
    accountConnectionUpdatedAt: date(r.accountConnectionUpdatedAt),
    plaidItemUpdatedAt: date(r.plaidItemUpdatedAt),
    connectionUpdatedAt: date(r.connectionUpdatedAt),
    transactionCount: num(r.transactionCount), transactionUpdatedAt: date(r.transactionUpdatedAt),
    transactionEventUpdatedAt: date(r.transactionEventUpdatedAt),
    positionCount: num(r.positionCount), positionCreatedAt: date(r.positionCreatedAt),
    positionSupersededCount: num(r.positionSupersededCount), positionDeletedCount: num(r.positionDeletedCount),
    recentPositionHash: text(r.recentPositionHash),
    reconstructionHash: text(r.reconstructionHash),
    instrumentUpdatedAt: date(r.instrumentUpdatedAt),
    priceCreatedAt: date(r.priceCreatedAt),
    fxFetchedAt: date(r.fxFetchedAt),
    snapshotHash: text(r.snapshotHash),
    spaceUpdatedAt: date(r.spaceUpdatedAt),
    expenseSectionUpdatedAt: date(r.expenseSectionUpdatedAt),
    memoryCount: num(r.memoryCount), memoryActiveCount: num(r.memoryActiveCount), memoryCreatedAt: date(r.memoryCreatedAt),
    refreshPolicyHash: text(r.refreshPolicyHash),
  };
}

/** Read and compute, with how long the read took. */
export async function sourceWatermark(
  client: WatermarkClient, scope: { spaceId: string; ownerUserId: string }, now: Date,
): Promise<{ watermark: string; inputs: WatermarkInputs; readMs: number }> {
  const t0 = Date.now();
  const inputs = await readWatermarkInputs(client, scope);
  return { watermark: computeWatermark(inputs, now), inputs, readMs: Date.now() - t0 };
}
