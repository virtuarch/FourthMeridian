/**
 * POST /api/brief/generate   { spaceId }
 *
 * Ensures today's Daily Brief for the named (active) Space: returns the stored
 * Brief when it is current, checks the evidence digest when sources moved, and
 * spends one model call only when the evidence warrants it and this request wins
 * the generation claim. A losing request returns IN_PROGRESS immediately; a
 * request inside a failure cooldown returns FAILED with retryAfterMs.
 *
 * No provider refresh happens here — the Brief reports freshness, it does not own it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { limitByUser } from '@/lib/rate-limit';
import { generateBriefResponse } from '@/lib/ai/brief/view';

export const preferredRegion = 'sin1';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Outlives the 90 s generation lease, which outlives the 60 s provider deadline. */
export const maxDuration = 120;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  if (user.role !== 'SYSTEM_ADMIN') {
    const limited = await limitByUser(user.id, 'ai-brief-generate', { limit: 20, windowSec: 60 });
    if (limited) return limited;
  }

  let spaceId: unknown;
  try {
    spaceId = ((await req.json()) as { spaceId?: unknown })?.spaceId;
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400, headers: NO_STORE });
  }
  if (typeof spaceId !== 'string' || spaceId.length === 0) {
    return NextResponse.json({ error: 'spaceId is required' }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await generateBriefResponse(user.id, spaceId);
    if (!result.ok) return NextResponse.json({ error: 'You don’t have access to that Space.' }, { status: 403, headers: NO_STORE });
    return NextResponse.json(result.body, { headers: NO_STORE });
  } catch (err) {
    console.error('[brief] generation request failed:', err);
    return NextResponse.json({ error: 'The brief could not be prepared right now.' }, { status: 503, headers: NO_STORE });
  }
}
