/**
 * lib/ai/brief/state.ts
 *
 * WHAT THE STORED BRIEF IS WORTH RIGHT NOW — a pure decision over rows and clocks.
 *
 *   today's Brief + same watermark     → FRESH           serve it; read nothing else
 *   today's Brief + moved watermark    → CHECK_MATERIAL  assemble, compare digests
 *   no successful Brief today          → NEEDS_GENERATION, with the best fallback
 *
 * ⚠️ A NEW DAY ALWAYS NEEDS ITS OWN BRIEF. "Nothing meaningful changed" is itself
 * today's Brief, so yesterday's is never promoted to today's on an equal digest.
 * Digest equality suppresses regeneration WITHIN a day only.
 *
 * ⚠️ A FALLBACK IS RETURNED AS WHAT IT IS. Its day, its age and whether it may
 * stand in are stated; its content is never rewritten to look current. It may
 * stand in when it is at most STALE_FALLBACK_MAX_DAYS old AND the balance anchor
 * it described has not aged into STALE or worse since it was written — a Brief
 * that called balances fresh must not lead once those same balances are stale.
 * (LIVE turning RECENT overnight is the ordinary life of yesterday's Brief, not
 * a degradation.)
 */

import { ageInDays, bandForAge, type FreshnessBand } from '@/lib/freshness/observation';
import { GENERATION_LEASE_MS, STALE_FALLBACK_MAX_DAYS } from './policy';

/** The persisted row, in the shape decisions need. `briefDay` is YYYY-MM-DD. */
export interface BriefRow {
  id: string;
  spaceId: string;
  ownerUserId: string;
  briefDay: string;
  content: unknown | null;
  generatedAt: Date | null;
  balancesAsOf: Date | null;
  historyThrough: string | null;
  sourceWatermark: string | null;
  materialDigest: string | null;
  model: string | null;
  promptVersion: string | null;
  correlationId: string | null;
  generationStartedAt: Date | null;
  lastFailedAt: Date | null;
  lastFailureReason: string | null;
}

export interface BriefFallback {
  row: BriefRow;
  briefDay: string;
  /** Whole UTC days between the fallback's day and today. 0 = today's own Brief. */
  ageDays: number;
  usable: boolean;
  /** Why it may not stand in, when it may not. */
  unusableBecause?: 'TOO_OLD' | 'FRESHNESS_DEGRADED';
}

export type ArtifactState =
  | { kind: 'FRESH'; row: BriefRow }
  | { kind: 'CHECK_MATERIAL'; row: BriefRow; fallback: BriefFallback }
  | { kind: 'NEEDS_GENERATION'; row: BriefRow | null; fallback: BriefFallback | null };

export interface ArtifactDecision {
  state: ArtifactState;
  /** Another caller holds an unexpired claim on today's row. */
  claimActive: boolean;
  /** The latest attempt for today failed after the last success (or with none). */
  lastFailure: { at: Date; reason: string | null } | null;
}

const BAND_RANK: Record<FreshnessBand, number> = { LIVE: 0, RECENT: 1, STALE: 2, VERY_STALE: 3, UNKNOWN: 4 };
const DAY_MS = 86_400_000;
const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

export function claimIsActive(row: BriefRow | null, now: Date): boolean {
  return !!row?.generationStartedAt && now.getTime() - row.generationStartedAt.getTime() < GENERATION_LEASE_MS;
}

export function fallbackFrom(row: BriefRow, today: string, now: Date): BriefFallback {
  const ageDays = dayDiff(today, row.briefDay);
  if (ageDays > STALE_FALLBACK_MAX_DAYS) return { row, briefDay: row.briefDay, ageDays, usable: false, unusableBecause: 'TOO_OLD' };
  if (row.balancesAsOf && row.generatedAt) {
    const then = bandForAge(ageInDays(row.balancesAsOf, row.generatedAt));
    const nowBand = bandForAge(ageInDays(row.balancesAsOf, now));
    if (BAND_RANK[nowBand] >= BAND_RANK.STALE && BAND_RANK[nowBand] > BAND_RANK[then]) {
      return { row, briefDay: row.briefDay, ageDays, usable: false, unusableBecause: 'FRESHNESS_DEGRADED' };
    }
  }
  return { row, briefDay: row.briefDay, ageDays, usable: true };
}

export function decideArtifactState(args: {
  today: string;
  now: Date;
  /** Today's row, with or without content. */
  todayRow: BriefRow | null;
  /** The newest earlier row that holds a successful Brief. */
  latestPrior: BriefRow | null;
  watermark: string;
}): ArtifactDecision {
  const { today, now, todayRow, latestPrior, watermark } = args;
  const claimActive = claimIsActive(todayRow, now);
  const lastFailure = todayRow?.lastFailedAt
    && (!todayRow.generatedAt || todayRow.lastFailedAt > todayRow.generatedAt)
    ? { at: todayRow.lastFailedAt, reason: todayRow.lastFailureReason } : null;

  if (todayRow?.generatedAt && todayRow.content !== null) {
    if (todayRow.sourceWatermark === watermark) {
      return { state: { kind: 'FRESH', row: todayRow }, claimActive, lastFailure };
    }
    return { state: { kind: 'CHECK_MATERIAL', row: todayRow, fallback: fallbackFrom(todayRow, today, now) },
      claimActive, lastFailure };
  }

  return {
    state: { kind: 'NEEDS_GENERATION', row: todayRow,
      fallback: latestPrior ? fallbackFrom(latestPrior, today, now) : null },
    claimActive, lastFailure,
  };
}
