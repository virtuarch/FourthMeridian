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
 * (History: this route used to aggregate every Space the user belonged to, pick
 * the PERSONAL one as primary and build fixed rule sections from buildContext. The
 * AI-generated, persisted DailyBrief replaced that engine; see lib/ai/brief/.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { readBriefResponse } from '@/lib/ai/brief/view';

export const preferredRegion = 'sin1';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest): Promise<NextResponse> {
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  const spaceId = req.nextUrl.searchParams.get('spaceId');
  if (!spaceId) return NextResponse.json({ error: 'spaceId is required' }, { status: 400, headers: NO_STORE });

  try {
    const result = await readBriefResponse(user.id, spaceId);
    if (!result.ok) return NextResponse.json({ error: 'You don’t have access to that Space.' }, { status: 403, headers: NO_STORE });
    return NextResponse.json(result.body, { headers: NO_STORE });
  } catch (err) {
    console.error('[brief] read failed:', err);
    return NextResponse.json({ error: 'The brief is unavailable right now.' }, { status: 503, headers: NO_STORE });
  }
}
