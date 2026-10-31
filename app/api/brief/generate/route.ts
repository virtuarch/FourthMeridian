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
import { randomUUID } from 'crypto';
import { requireUser } from '@/lib/session';
import { paceAiRequest } from '@/lib/ai/pacing';
import { entitlementsForUser, refuseIfDisabled, refuseIfFailClosed } from '@/lib/entitlements/consume';
import { dailyAiAllowanceFor, allowanceRefusal } from '@/lib/ai/allowance';
import { readPaidRequestsAdmission, paidRequestsPausedResponse } from '@/lib/platform/ai/paid-requests-admission';
import { assertPricedModel, UnpricedModelError, AiPausedError, UNPRICED_MODEL_CODE } from '@/lib/ai/provider';
import { runWithAiInvocationContext } from '@/lib/ai/invocation-context';
import { BRIEF_MODEL } from '@/lib/ai/brief/daily-brief';
import { generateBriefResponse } from '@/lib/ai/brief/view';

export const preferredRegion = 'sin1';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Outlives the 90 s generation lease, which outlives the 60 s provider deadline. */
export const maxDuration = 120;

const NO_STORE = { 'Cache-Control': 'no-store' };

// BETA C7 — the customer's sentence when the Brief's model cannot be priced.
const UNPRICED_BRIEF = 'The Daily Brief is paused: the model in use can’t be priced yet, so your '
  + 'daily AI allowance can’t be checked. Nothing was changed. Please try again later.';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  // P1 — the Daily Brief is the `dailyBrief` entitlement; a customer whose
  // Policy Group turns it off gets a plain 403 and no claim, no model call. The
  // 20/min pacing below is an ABUSE CONTROL, not a plan quota, and it now applies
  // to everyone: the old SYSTEM_ADMIN exemption exempted nobody who can reach
  // this route (the role wall keeps SYSTEM_ADMIN off /dashboard).
  const entitlements = await entitlementsForUser(user.id);
  const disabled = refuseIfDisabled(entitlements, 'dailyBrief', 'The Daily Brief');
  if (disabled) return disabled;
  // FAIL CLOSED (owner ruling, 2026-10-30) — a missing/invalid policy assignment
  // keeps `dailyBrief` ON so GET /api/brief still serves the stored Brief, but a
  // NEW generation is paid work: refused here (403, "plan needs attention")
  // before pacing, the claim or any model call. The $0 allowance would refuse it
  // too; this says why honestly instead of "you've used today's allowance".
  // BETA LIFECYCLE (owner decision 2026-10-31) — the same seam refuses NEW
  // generation when the plan's group is paused, ended or cost-frozen, or its
  // state is unreadable — explicitly, whether or not `ai_daily_allowance_enforced`
  // is on (reading the stored Brief via GET /api/brief stays allowed).
  const failClosed = refuseIfFailClosed(entitlements, 'The Daily Brief');
  if (failClosed) return failClosed;
  // SEC-AI-004 — fails closed on a limiter store error (lib/ai/pacing.ts), like the allowance.
  {
    const limited = await paceAiRequest(user.id, 'ai-brief-generate', { limit: 20, windowSec: 60 }, 'The Daily Brief');
    if (limited) return limited;
  }
  // AI COST CONTROLS — the kill switch OR maintenance_mode (either refuses), before the allowance (after
  // authentication, entitlement and pacing). 503 `{ error, code: "AI_PAUSED" }`.
  // No claim is taken and no row is written; the stored Brief stays readable.
  {
    const admission = await readPaidRequestsAdmission();
    if (admission.paused) {
      // Reason code only — never the prompt, the user, or any figure.
      console.warn('[brief] refused before the provider: paid AI paused (' + (admission.cause ?? admission.state) + ')');
      return paidRequestsPausedResponse();
    }
  }
  // BETA C7 — the daily allowance, after the pacing window and before any claim
  // or model call. The same verdict and the same refusal body as Conversations
  // (`{ error, code: "AI_ALLOWANCE", spentUsd, allowanceUsd }`): the allowance is
  // ONE bound across both surfaces. Fail closed when today's usage has an
  // unpriceable invocation. The stored Brief stays readable through GET /api/brief.
  // AI COST CONTROLS — reserved under the per-customer lock; released in `finally`.
  const allowance = await dailyAiAllowanceFor(user.id, entitlements);
  {
    const refused = allowanceRefusal(allowance, 'The Daily Brief');
    if (refused) return refused;
  }
  try {
    let spaceId: unknown;
    try {
      spaceId = ((await req.json()) as { spaceId?: unknown })?.spaceId;
    } catch {
      return NextResponse.json({ error: 'Malformed request.' }, { status: 400, headers: NO_STORE });
    }
    if (typeof spaceId !== 'string' || spaceId.length === 0) {
      return NextResponse.json({ error: 'spaceId is required' }, { status: 400, headers: NO_STORE });
    }

    // BETA C7 — THE MODEL MUST BE PRICEABLE BEFORE A CLAIM IS TAKEN. Generation
    // runs inside the lifecycle, which types a provider throw as PROVIDER_ERROR
    // ("Couldn't update" on the page — no sentence of its own reaches the customer)
    // and a failed claim starts the generation cooldown. So the provider
    // chokepoint's own check runs here first, under the Brief's attribution: an
    // unpriceable model refuses with a clear 503 and ONE FAILED / UNPRICED_MODEL
    // fact, and nothing is claimed. (Conversations answers the same gap from the
    // turn loop's recorded error — app/api/ai/chat.) A priced model costs nothing here.
    // Attributed to the AUTHENTICATED user only: the Space named in the body is not
    // yet proven to be theirs (generateBriefResponse resolves membership), and an
    // unverified id is not written onto a ledger row.
    try {
      runWithAiInvocationContext(
        { correlationId: randomUUID(), turnIndex: 0, surface: 'brief', subSurface: 'brief:preflight', userId: user.id },
        () => assertPricedModel(BRIEF_MODEL));
    } catch (err) {
      if (err instanceof UnpricedModelError) {
        return NextResponse.json({ error: UNPRICED_BRIEF, code: UNPRICED_MODEL_CODE }, { status: 503, headers: NO_STORE });
      }
      if (err instanceof AiPausedError) return paidRequestsPausedResponse();
      console.error('[brief] pricing pre-flight failed:', err);
      return NextResponse.json({ error: 'The brief could not be prepared right now.' }, { status: 503, headers: NO_STORE });
    }

    try {
      const result = await generateBriefResponse(user.id, spaceId);
      if (!result.ok) return NextResponse.json({ error: 'You don’t have access to that Space.' }, { status: 403, headers: NO_STORE });
      return NextResponse.json(result.body, { headers: NO_STORE });
    } catch (err) {
      console.error('[brief] generation request failed:', err);
      return NextResponse.json({ error: 'The brief could not be prepared right now.' }, { status: 503, headers: NO_STORE });
    }
  } finally {
    await allowance.release();
  }
}
