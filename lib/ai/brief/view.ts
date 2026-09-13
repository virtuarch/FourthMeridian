/**
 * lib/ai/brief/view.ts
 *
 * THE BRIEF'S TWO SERVER ENTRIES — read (GET, the page) and generate (POST).
 *
 * ⚠️ ONE SPACE, THE ONE THE USER IS IN. The page resolves the active Space
 * (cookie → preferred → personal) and names it; both entries RE-RESOLVE that name
 * for the session's user and refuse a Space that does not come back as itself —
 * `resolveSpaceContext` falls back to PERSONAL by design, and a Brief written about
 * a different Space than the one on screen is a Brief about the wrong money. The
 * chat route refuses the same mismatch the same way.
 *
 * ⚠️ READING NEVER SPENDS. `readBriefResponse` calls `inspectDailyBrief` — a row
 * read and a watermark — and the deterministic metric summary. It cannot claim,
 * assemble or generate; brief-authority.test.ts pins that by source.
 */

import 'server-only';
import { resolveSpaceContext, type SpaceContext } from '@/lib/space';
import { getSpaceNetWorthSummaries } from '@/lib/data/snapshots';
import { todayUTCISO } from '@/lib/time/clock';
import type { BriefMetricsView, BriefResponse } from '@/lib/brief-types';
import { ensureDailyBrief, inspectDailyBrief, type LifecycleDeps } from './lifecycle';
import { responseFromEnsure, responseFromInspection } from './view-model';

export type BriefViewResult = { ok: true; body: BriefResponse } | { ok: false; status: 403 };

async function resolveNamedSpace(userId: string, spaceId: string): Promise<SpaceContext | null> {
  const ctx = await resolveSpaceContext(userId, spaceId);
  return ctx.spaceId === spaceId ? ctx : null;
}

/** The metric row, from the Space's snapshot series. Null when there is no admissible figure. */
async function loadMetrics(spaceId: string): Promise<BriefMetricsView | null> {
  try {
    const s = (await getSpaceNetWorthSummaries([spaceId]))[spaceId];
    if (!s || !s.asOf) return null;
    return {
      // The summary stamps the point's instant; the contract promises its day
      // (dogfood caught "as of Invalid Date" when the page treated it as one).
      currency: s.currency, netWorth: s.netWorth, asOf: s.asOf.slice(0, 10), estimated: s.estimated,
      monthChange: s.change ? { abs: s.change.abs, pct: s.change.pct, fromDate: s.change.fromDate } : null,
    };
  } catch (err) {
    console.error('[brief] metrics unavailable:', err);
    return null;
  }
}

/** GET /api/brief and the page's first render. Never a model call. */
export async function readBriefResponse(
  userId: string, spaceId: string,
  options: { now?: Date; deps?: Partial<LifecycleDeps> } = {},
): Promise<BriefViewResult> {
  const spaceCtx = await resolveNamedSpace(userId, spaceId);
  if (!spaceCtx) return { ok: false, status: 403 };
  const now = options.now ?? new Date();
  const [inspection, metrics] = await Promise.all([
    inspectDailyBrief({ spaceId, ownerUserId: userId },
      { now, deps: { ...options.deps, resolveSpace: async () => spaceCtx } }),
    loadMetrics(spaceId),
  ]);
  return { ok: true, body: responseFromInspection({ spaceId, inspection, now, metrics }) };
}

/** POST /api/brief/generate. At most one model call, and only when the evidence warrants it. */
export async function generateBriefResponse(
  userId: string, spaceId: string,
  options: { now?: Date; deps?: Partial<LifecycleDeps> } = {},
): Promise<BriefViewResult> {
  const spaceCtx = await resolveNamedSpace(userId, spaceId);
  if (!spaceCtx) return { ok: false, status: 403 };
  const now = options.now ?? new Date();
  const result = await ensureDailyBrief({ spaceId, ownerUserId: userId },
    { now, deps: { ...options.deps, resolveSpace: async () => spaceCtx } });
  return { ok: true, body: responseFromEnsure({ spaceId, result, today: todayUTCISO(now), now }) };
}
