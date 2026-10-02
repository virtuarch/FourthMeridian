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
 *
 * ── THIS IS THE BRIEF'S TENANT BOUNDARY (RLS SLICE A) ────────────────────────
 * Both entries take `userId` from an authenticated caller, so this is where that
 * identity becomes a database authority. Neither hands a client down: they hand
 * down a `BriefRuntime`, whose `asOwner` runs ONE phase inside
 * `withTenantDb(userId, …)` — the DailyBrief row read, the claim, the completion
 * write, the account-link check and the memory recall.
 *
 * ⚠️ AND NOT ONE TRANSACTION, BECAUSE GENERATION CALLS A MODEL. `ensureDailyBrief`
 * claims, then calls the model, then writes. A transaction spanning that would be
 * held open across an LLM request — the one use `withTenantDb` forbids — so the
 * boundary is entered per phase. The inspect path has no model call, so its phases
 * could be one transaction; they are still per-phase, because `inspectDailyBrief`
 * runs its row read and its watermark CONCURRENTLY and a single transaction would
 * serialise them.
 *
 * ⚠️ RLS-C-S3 — AND NOW THE THREE CANONICAL READ LEAVES TOO. The snapshot
 * boundary, the banking-population authority and the recent-activity pager all take
 * a client as of this slice, and each becomes its own `asOwnerReading` phase — the
 * same per-phase rule, through a separate runner because `BriefDbClient` is a
 * deliberate `Pick` and those leaves need a full read client. A Brief is already
 * per-(Space, OWNER) — `recall` and the per-source health read are viewer-scoped —
 * so a viewer-scoped history and population is the CONSISTENT choice here, not a
 * new one. Every account `bankingTransactionWhere(spaceId)` admits is ACTIVE-linked
 * into a Space the owner is an ACTIVE member of, so `fm_account_visible` admits it
 * too and the population is unchanged by construction.
 *
 * ⚠️ TWO READS STAY DEPLOYMENT-WIDE, ON PURPOSE AND IN ONE PLACE. The source
 * watermark and the per-source health read both hash `PlatformSetting`, which the
 * RLS migration revokes from fm_app outright; see `BriefPlatformClient` in store.ts
 * for why and for what has to be decided to close it.
 */

import 'server-only';
import { resolveSpaceContext, type SpaceContext } from '@/lib/space';
import { getSpaceNetWorthSummaries } from '@/lib/data/snapshots';
import { loadSpaceDataHealth } from '@/lib/connections/space-data-health';
import { todayUTCISO } from '@/lib/time/clock';
import type { BriefDataHealthView, BriefMetricsView, BriefResponse } from '@/lib/brief-types';
import { withTenantDb } from '@/lib/db/tenant-context';
import { ensureDailyBrief, inspectDailyBrief, type LifecycleDeps } from './lifecycle';
import type { BriefRuntime } from './store';
import { responseFromEnsure, responseFromInspection } from './view-model';

/**
 * The authority the Brief's phases run under, for ONE user.
 *
 * `asOwner` opens a transaction per phase and binds `app.user_id`, so the policies
 * on `DailyBrief` (a visible Space AND `ownerUserId = current_fm_user_id()`) and on
 * `SpaceMemory` apply on top of the application scope rather than instead of it.
 */
export function briefRuntimeFor(userId: string): BriefRuntime {
  return {
    asOwner: (fn) => withTenantDb(userId, (tx) => fn(tx)),
    // RLS-C-S3 — the same boundary, the same identity, a wider client. One short
    // read per call; never a model call inside one.
    asOwnerReading: (fn) => withTenantDb(userId, (tx) => fn(tx)),
  };
}

export type BriefViewResult = { ok: true; body: BriefResponse } | { ok: false; status: 403 };

async function resolveNamedSpace(userId: string, spaceId: string): Promise<SpaceContext | null> {
  const ctx = await resolveSpaceContext(userId, spaceId);
  return ctx.spaceId === spaceId ? ctx : null;
}

/**
 * The metric row, from the Space's snapshot series. Null when there is no admissible figure.
 *
 * RLS-C-S3 — ONE short phase on the tenant role, exactly like `loadDataHealth`
 * below. The Space has already been re-resolved for this user
 * (`resolveNamedSpace`), so `fm_visible_space_ids()` admits it and the policy and
 * the application scope agree. A single aggregate: no model call, nothing to hold
 * a transaction across.
 */
async function loadMetrics(userId: string, spaceId: string): Promise<BriefMetricsView | null> {
  try {
    const s = (await withTenantDb(userId,
      (tx) => getSpaceNetWorthSummaries(tx, [spaceId])))[spaceId];
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

/**
 * When each source behind the Space last delivered, for this viewer. Read on every
 * GET — never stored with the Brief — so a reconnect shows at once, before (and
 * whether or not) the Brief itself is reconsidered. Null when it cannot be read.
 */
async function loadDataHealth(spaceId: string, viewerUserId: string, now: Date): Promise<BriefDataHealthView | null> {
  try {
    // Deployment-wide: it hashes PlatformSetting's refresh cadence, which fm_app is
    // denied. See BriefPlatformClient. Read-only, and no row reaches the user.
    return await withTenantDb(viewerUserId, (tx) =>
      loadSpaceDataHealth(tx, { spaceId, viewerUserId, now }));
  } catch (err) {
    console.error('[brief] data health unavailable:', err);
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
  const [inspection, metrics, dataHealth] = await Promise.all([
    inspectDailyBrief({ spaceId, ownerUserId: userId },
      { now, runtime: briefRuntimeFor(userId),
        deps: { ...options.deps, resolveSpace: async () => spaceCtx } }),
    loadMetrics(userId, spaceId),
    loadDataHealth(spaceId, userId, now),
  ]);
  return { ok: true, body: responseFromInspection({ spaceId, inspection, now, metrics, dataHealth }) };
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
    { now, runtime: briefRuntimeFor(userId),
      deps: { ...options.deps, resolveSpace: async () => spaceCtx } });
  return { ok: true, body: responseFromEnsure({ spaceId, result, today: todayUTCISO(now), now }) };
}
