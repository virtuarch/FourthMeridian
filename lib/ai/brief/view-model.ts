/**
 * lib/ai/brief/view-model.ts
 *
 * SERVER STATE → CLIENT-SAFE RESPONSE, field by field.
 *
 * ⚠️ PURE, AND AN ALLOWLIST. Every field in the response is written here by name.
 * Nothing is spread from a row or from stored content, so a key added to either
 * later cannot leak into the browser by accident — and view-model.test.ts walks
 * every response for the cache and generation internals.
 *
 * ⚠️ ONLY SAFE FALLBACKS ARE SHOWN. A stale fallback the Slice 2 policy marks
 * unusable (too old, or its balances have since gone stale) becomes `brief: null`
 * — the page shows a skeleton, never an unsafe Brief as today's lead.
 */

import type {
  BriefArtifactView, BriefMetricsView, BriefObservationView, BriefResponse,
} from '@/lib/brief-types';
import { ageInDays, bandForAge, isStaleBand } from '@/lib/freshness/observation';
import type { BriefInspection, EnsureResult } from './lifecycle';
import type { BriefFallback, BriefRow } from './state';
import type { DailyBrief } from './types';

function observations(content: DailyBrief): BriefObservationView[] {
  return (Array.isArray(content.observations) ? content.observations : []).map((o) => ({
    kind: String(o.kind), title: String(o.title), body: String(o.body),
    importance: o.importance === 'NOTABLE' ? 'NOTABLE' : 'CONTEXT',
  }));
}

function artifact(args: {
  content: DailyBrief; briefDay: string; generatedAt: Date; balancesAsOf: Date | null; today: string; now: Date;
}): BriefArtifactView {
  const { content, briefDay, generatedAt, balancesAsOf, today, now } = args;
  return {
    briefDay,
    fromPriorDay: briefDay < today,
    generatedAt: generatedAt.toISOString(),
    balancesAsOf: balancesAsOf ? balancesAsOf.toISOString() : null,
    balancesMayBeStale: balancesAsOf ? isStaleBand(bandForAge(ageInDays(balancesAsOf, now))) : false,
    headline: String(content.headline),
    quiet: content.quiet === true,
    observations: observations(content),
  };
}

export function artifactFromRow(row: BriefRow, today: string, now: Date): BriefArtifactView | null {
  if (!row.generatedAt || row.content === null || typeof row.content !== 'object') return null;
  return artifact({ content: row.content as DailyBrief, briefDay: row.briefDay, generatedAt: row.generatedAt,
    balancesAsOf: row.balancesAsOf, today, now });
}

const usable = (f: BriefFallback | null, today: string, now: Date) =>
  f && f.usable ? artifactFromRow(f.row, today, now) : null;

/** GET: the inspected state. */
export function responseFromInspection(args: {
  spaceId: string; inspection: BriefInspection; now: Date; metrics: BriefMetricsView | null;
}): BriefResponse {
  const { spaceId, inspection, now, metrics } = args;
  const { decision, today, retryAfterMs, hasData } = inspection;
  const base = { spaceId, metrics, checkedAt: now.toISOString() };

  if (!hasData) return { ...base, state: 'NO_DATA', brief: null, needsGeneration: false };

  const { state, claimActive } = decision;
  if (state.kind === 'FRESH') {
    return { ...base, state: 'FRESH', brief: artifactFromRow(state.row, today, now), needsGeneration: false };
  }
  if (state.kind === 'CHECK_MATERIAL') {
    const brief = artifactFromRow(state.row, today, now);
    return claimActive
      ? { ...base, state: 'IN_PROGRESS', brief, needsGeneration: false }
      // Even in a failure cooldown: the server's digest check spends nothing, and
      // generation itself is refused by the lifecycle until the cooldown ends.
      : { ...base, state: 'CHECK_REQUIRED', brief, needsGeneration: true };
  }
  const brief = usable(state.fallback, today, now);
  if (claimActive) return { ...base, state: 'IN_PROGRESS', brief, needsGeneration: false };
  if (retryAfterMs > 0) return { ...base, state: 'FAILED', brief, needsGeneration: false, retryAfterMs };
  return { ...base, state: brief ? 'STALE' : 'ABSENT', brief, needsGeneration: true };
}

/** POST: what the lifecycle did. */
export function responseFromEnsure(args: {
  spaceId: string; result: EnsureResult; today: string; now: Date;
}): BriefResponse {
  const { spaceId, result, today, now } = args;
  const base = { spaceId, checkedAt: now.toISOString() };
  switch (result.status) {
    case 'NO_DATA':
      return { ...base, state: 'NO_DATA', brief: null, needsGeneration: false };
    case 'FRESH':
      return { ...base, state: 'FRESH', brief: artifactFromRow(result.row, today, now), needsGeneration: false };
    case 'GENERATED':
      return { ...base, state: 'FRESH', needsGeneration: false,
        brief: artifact({ content: result.brief, briefDay: result.brief.briefDay,
          generatedAt: new Date(result.brief.generatedAt), balancesAsOf: result.balancesAsOf, today, now }) };
    case 'IN_PROGRESS':
      return { ...base, state: 'IN_PROGRESS', brief: usable(result.fallback, today, now), needsGeneration: false };
    case 'COOLING_DOWN':
    case 'FAILED':
      return { ...base, state: 'FAILED', brief: usable(result.fallback, today, now), needsGeneration: false,
        retryAfterMs: result.retryAfterMs };
  }
}
