/**
 * lib/ai/brief/store.ts
 *
 * THE DAILY BRIEF ARTIFACT STORE — read, claim, complete, fail, refresh.
 *
 * ⚠️ THE CLAIM IS ONE CONDITIONAL UPDATE. `generationStartedAt` is set only where
 * it is null or older than the lease, in a single UPDATE; Postgres re-checks that
 * predicate under the row lock, so of any number of concurrent callers exactly one
 * matches. The first row for a day is created WITH the claim set by an insert that
 * does nothing on conflict (`createMany … skipDuplicates`, i.e. ON CONFLICT DO
 * NOTHING); a caller whose insert inserted nothing retries the conditional update
 * once — against a row another caller just claimed, so it loses. The unique key
 * decides the first-row race without an exception: a thrown P2002 was the first
 * design, and Prisma logged every handled race as an error.
 * No advisory lock, no job table, no cleanup worker.
 *
 * ⚠️ THE CLAIM TIMESTAMP IS THE FENCING TOKEN. Completion and failure apply only
 * where `generationStartedAt` still equals the token the caller was given. A
 * caller whose lease expired while it was still working cannot overwrite the
 * Brief or the claim of whoever took over; its write simply matches nothing.
 * (Tokens are millisecond timestamps: two claims on one row in the same
 * millisecond after an expiry are not a real-world case.)
 *
 * ⚠️ FAILURE NEVER TOUCHES CONTENT. It releases the claim and stamps
 * `lastFailedAt`; whatever Brief the row held survives, and the next caller may
 * retry immediately. A process that dies mid-generation writes nothing; its claim
 * expires after GENERATION_LEASE_MS and the next caller takes it.
 *
 * ⚠️ REFRESHING THE WATERMARK IS CONDITIONAL ON THE DIGEST. It records "sources
 * moved, nothing material" only onto the Brief whose digest was compared — never
 * onto one a concurrent generation has just replaced.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { GENERATION_LEASE_MS } from './policy';
import type { BriefRow } from './state';

export interface BriefScope { spaceId: string; ownerUserId: string }
export interface BriefKey extends BriefScope { briefDay: string }

export interface BriefCompletion {
  content: unknown;
  generatedAt: Date;
  balancesAsOf: Date | null;
  historyThrough: string | null;
  sourceWatermark: string;
  materialDigest: string;
  model: string;
  promptVersion: string;
  correlationId: string | null;
}

export type ClaimResult = { won: true; token: Date } | { won: false };

export interface BriefStore {
  /** Today's row (with or without content) and the newest earlier successful Brief. */
  read(scope: BriefScope, today: string): Promise<{ todayRow: BriefRow | null; latestPrior: BriefRow | null }>;
  claim(key: BriefKey, now: Date): Promise<ClaimResult>;
  complete(key: BriefKey, token: Date, data: BriefCompletion): Promise<boolean>;
  fail(key: BriefKey, token: Date, reason: string, at: Date): Promise<boolean>;
  refreshWatermark(key: BriefKey, expectedDigest: string, watermark: string): Promise<boolean>;
}

const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

type DailyBriefRecord = Prisma.DailyBriefGetPayload<Record<string, never>>;

export function toBriefRow(r: DailyBriefRecord): BriefRow {
  return {
    id: r.id, spaceId: r.spaceId, ownerUserId: r.ownerUserId, briefDay: dayOf(r.briefDay),
    content: r.content ?? null, generatedAt: r.generatedAt, balancesAsOf: r.balancesAsOf,
    historyThrough: r.historyThrough ? dayOf(r.historyThrough) : null,
    sourceWatermark: r.sourceWatermark, materialDigest: r.materialDigest,
    model: r.model, promptVersion: r.promptVersion, correlationId: r.correlationId,
    generationStartedAt: r.generationStartedAt, lastFailedAt: r.lastFailedAt,
    lastFailureReason: r.lastFailureReason,
  };
}

export function prismaBriefStore(client: Pick<PrismaClient, 'dailyBrief'>): BriefStore {
  const fields = (k: BriefKey) => ({ spaceId: k.spaceId, ownerUserId: k.ownerUserId, briefDay: dayDate(k.briefDay) });

  return {
    async read(scope, today) {
      const [todayRow, latestPrior] = await Promise.all([
        client.dailyBrief.findUnique({ where: { spaceId_ownerUserId_briefDay: fields({ ...scope, briefDay: today }) } }),
        client.dailyBrief.findFirst({
          where: { spaceId: scope.spaceId, ownerUserId: scope.ownerUserId,
            briefDay: { lt: dayDate(today) }, generatedAt: { not: null } },
          orderBy: { briefDay: 'desc' },
        }),
      ]);
      return { todayRow: todayRow ? toBriefRow(todayRow) : null, latestPrior: latestPrior ? toBriefRow(latestPrior) : null };
    },

    async claim(key, now) {
      const token = new Date(now.getTime());
      const expiredBefore = new Date(now.getTime() - GENERATION_LEASE_MS);
      const take = async () => (await client.dailyBrief.updateMany({
        where: { ...fields(key), OR: [{ generationStartedAt: null }, { generationStartedAt: { lte: expiredBefore } }] },
        data: { generationStartedAt: token },
      })).count === 1;

      if (await take()) return { won: true, token };
      const { count } = await client.dailyBrief.createMany({
        data: [{ ...fields(key), generationStartedAt: token }], skipDuplicates: true,
      });
      if (count === 1) return { won: true, token };
      // Someone created the row between our update and our insert. It is claimed
      // (or was just released) — one more conditional update decides, atomically.
      return (await take()) ? { won: true, token } : { won: false };
    },

    async complete(key, token, d) {
      const { count } = await client.dailyBrief.updateMany({
        where: { ...fields(key), generationStartedAt: token },
        data: {
          content: d.content as Prisma.InputJsonValue,
          generatedAt: d.generatedAt,
          balancesAsOf: d.balancesAsOf,
          historyThrough: d.historyThrough ? dayDate(d.historyThrough) : null,
          sourceWatermark: d.sourceWatermark,
          materialDigest: d.materialDigest,
          model: d.model,
          promptVersion: d.promptVersion,
          correlationId: d.correlationId,
          generationStartedAt: null,
        },
      });
      return count === 1;
    },

    async fail(key, token, reason, at) {
      const { count } = await client.dailyBrief.updateMany({
        where: { ...fields(key), generationStartedAt: token },
        data: { generationStartedAt: null, lastFailedAt: at, lastFailureReason: reason },
      });
      return count === 1;
    },

    async refreshWatermark(key, expectedDigest, watermark) {
      const { count } = await client.dailyBrief.updateMany({
        where: { ...fields(key), materialDigest: expectedDigest, generatedAt: { not: null } },
        data: { sourceWatermark: watermark },
      });
      return count === 1;
    },
  };
}
