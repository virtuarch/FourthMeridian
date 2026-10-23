/**
 * GET /api/brief?spaceId=…
 *
 * The Daily Brief's state for the named (active) Space — cheap, and never a
 * model call. The Brief to show (today's, or a safe dated fallback), whether the
 * page should ask for generation, a retry delay after a failure, and the
 * deterministic metric row.
 *
 * Generation is POST /api/brief/generate. This handler does not import it.
 *
 * ── BETA A2 — BRIEF_VIEWED: A VIEW IS A BRIEF DELIVERED, NOT A REQUEST MADE ──
 * The page's controller (components/brief/brief-flow.ts) calls this GET for four
 * reasons and only one of them puts a Brief in front of a person for the first
 * time that day: the start read when the server-rendered state was missing or
 * stale, a visibility recheck when the tab returns, the 2-second POLL while a
 * generation is IN_PROGRESS, and the retry control. The request line is identical
 * in all four, so the rule is decided from what this handler RETURNS, not from
 * who asked:
 *
 *   a view is recorded iff the response carries a Brief (`body.brief !== null`),
 *   keyed by THAT Brief's day — because whatever rides `brief` is what the page
 *   paints, in every state (today's Brief, or a dated fallback while today's is
 *   being prepared or could not be).
 *
 * So a poll returning IN_PROGRESS with no Brief writes nothing; the final poll
 * that returns the generated Brief writes the view, because that is the moment
 * it appears; a poll or a visibility recheck that returns a Brief already
 * recorded is absorbed by the (user, Space, briefDay) dedupe. No prefetch reaches this handler (the Brief
 * page renders its first state server-side; see app/(shell)/dashboard/brief/page.tsx
 * for its own prefetch guard). Generation (POST /api/brief/generate, another
 * workstream's file) writes nothing: a Brief shown straight out of generation is
 * recorded on the next read that returns it FRESH — the coordinator may add the
 * one-line `recordBriefViewed(…, cached: false)` there on integration.
 * Pinned by lib/analytics/product-events.test.ts.
 *
 * (History: this route used to aggregate every Space the user belonged to, pick
 * the PERSONAL one as primary and build fixed rule sections from buildContext. The
 * AI-generated, persisted DailyBrief replaced that engine; see lib/ai/brief/.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { entitlementsForUser, refuseIfDisabled } from '@/lib/entitlements/consume';
import { readBriefResponse } from '@/lib/ai/brief/view';
import { withTenantDb } from '@/lib/db/tenant-context';
import { recordBriefViewed } from '@/lib/analytics/product-events';

export const preferredRegion = 'sin1';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest): Promise<NextResponse> {
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  // P1 — the Daily Brief is the `dailyBrief` entitlement (same gate as generation).
  const disabled = refuseIfDisabled(await entitlementsForUser(user.id), 'dailyBrief', 'The Daily Brief');
  if (disabled) return disabled;

  const spaceId = req.nextUrl.searchParams.get('spaceId');
  if (!spaceId) return NextResponse.json({ error: 'spaceId is required' }, { status: 400, headers: NO_STORE });

  try {
    const result = await readBriefResponse(user.id, spaceId);
    if (!result.ok) return NextResponse.json({ error: 'You don’t have access to that Space.' }, { status: 403, headers: NO_STORE });
    const shown = result.body.brief;
    if (shown) {
      await withTenantDb(user.id, (tx) =>
        recordBriefViewed(tx, { userId: user.id, spaceId, briefDay: shown.briefDay, cached: true }));
    }
    return NextResponse.json(result.body, { headers: NO_STORE });
  } catch (err) {
    console.error('[brief] read failed:', err);
    return NextResponse.json({ error: 'The brief is unavailable right now.' }, { status: 503, headers: NO_STORE });
  }
}
