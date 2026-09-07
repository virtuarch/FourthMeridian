/**
 * POST /api/ai/chat
 *
 * ⚠️ INTENTIONALLY UNAVAILABLE. The conversational AI layer was removed in the
 * AI conversation reset and no replacement has been designed yet. See
 * docs/plans/AI-CONVERSATION-RESET.md.
 *
 * ── Why this endpoint answers instead of disappearing ───────────────────────
 * The route stays so the client contract stays: `AnalyzeClient` posts here and
 * renders `error` from a non-OK response as the assistant's turn, so a 503 with
 * a plain sentence tells the user the truth in the place they asked the
 * question. Deleting the route would give them a 404 and a "Network error".
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 * It does not fall back to an earlier prompt pipeline, it does not assemble a
 * context, it does not call a model, and it holds no half of the removed
 * architecture behind a flag. The previous handler orchestrated context
 * assembly, a lexical router, a retrieval planner, a forecast surface, three
 * prose guards, a typed answer boundary, a verifier, a repair loop and a
 * deterministic figure-dump fallback; all of it is gone rather than dormant.
 *
 * ── What survives underneath, for whatever comes next ───────────────────────
 * `buildContext` (lib/ai/context-builder), the assemblers, the coverage
 * envelope, the deterministic assessment (lib/ai/intelligence), the forecast
 * engine (lib/forecast + lib/ai/forecast) and the provider boundary
 * (lib/ai/provider) are all untouched and independently tested. None of them
 * needs this route to exist.
 *
 * Auth and rate limiting are kept: an unavailable endpoint should still refuse
 * anonymous callers and should still be cheap to be hammered.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUser }               from '@/lib/session';
import { limitByUser }               from '@/lib/rate-limit';

export const preferredRegion = 'sin1';
export const runtime         = 'nodejs';

/**
 * The sentence the user sees in the conversation surface. Plain, honest, and
 * not an apology for a transient fault — this is a deliberate state, and saying
 * "try again" would be false.
 */
const UNAVAILABLE_MESSAGE =
  'Fourth Meridian’s assistant is being rebuilt. The previous conversation layer has been '
  + 'removed and a new one has not shipped yet, so I can’t answer questions here right now. '
  + 'Your accounts, transactions, balances, history and every other part of the product are '
  + 'unaffected.';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  if (user.role !== 'SYSTEM_ADMIN') {
    const limited = await limitByUser(user.id, 'ai-chat', { limit: 30, windowSec: 60 });
    if (limited) return limited;
  }

  return NextResponse.json(
    { error: UNAVAILABLE_MESSAGE, status: 'AWAITING_REDESIGN' },
    { status: 503 },
  );
}
