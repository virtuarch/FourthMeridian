/**
 * lib/ai/pacing.ts  (SEC-AI-004 — the AI pacing windows fail CLOSED)
 *
 * `limitByUser` (lib/rate-limit.ts) fails OPEN on a store error: the right
 * default for an ordinary endpoint, and the wrong one in front of a paid model
 * call, where the allowance reservation a few lines later fails CLOSED. During
 * a rate-limit store outage the per-minute and per-hour windows — the bound on
 * a script or a stolen session — silently disappeared while the reservation
 * stayed up. The limiter's strict variant (`checkStrict`, added for the login
 * path) already reports "could not check" as a verdict instead of swallowing
 * it; this is that verdict mapped to the AI routes' responses.
 *
 * ⚠️ THE SAME STORE, THE SAME WINDOWS, THE PUBLIC KEY BUILDER. `checkKeyLimitStrict`
 * keys on `key:<name>:<userId>`; the subject is still the authenticated user id
 * and the limits are still the customer's effective entitlement. Counters that
 * lived under the `user:` prefix age out within their window.
 *
 * ⚠️ RATE_LIMIT_ENABLED and RATE_LIMIT_SHADOW are honoured by the limiter itself
 * (disabled ⇒ "ok" with no store call), so local dev and the unit suite are
 * unchanged; "unavailable" is reported only for a genuine store failure.
 */

import 'server-only';
import { NextResponse } from 'next/server';
import { checkKeyLimitStrict, type LimitVerdict, type RateLimitConfig } from '@/lib/rate-limit';
import { PACING_LIMITED_SENTENCE, pacingUnavailableSentence } from '@/lib/ai/conversation/refusal-sentences';

export const PACING_UNAVAILABLE_CODE = 'PACING_UNAVAILABLE' as const;
/** Seconds a client should wait before retrying a refusal the store could not judge. */
export const PACING_RETRY_AFTER_SECONDS = 15;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** PURE — the response for a verdict, or null to proceed. */
export function pacingResponse(verdict: LimitVerdict, surfaceLabel: string): NextResponse | null {
  if (verdict.status === 'ok') return null;
  if (verdict.status === 'limited') {
    return NextResponse.json(
      { error: PACING_LIMITED_SENTENCE },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(verdict.retryAfterSec) } },
    );
  }
  // FAIL CLOSED — the store could not be consulted, so the window cannot be trusted.
  return NextResponse.json(
    { error: pacingUnavailableSentence(surfaceLabel),
      code: PACING_UNAVAILABLE_CODE, retryable: true, retryAfterSeconds: PACING_RETRY_AFTER_SECONDS },
    { status: 503, headers: { ...NO_STORE, 'Retry-After': String(PACING_RETRY_AFTER_SECONDS) } },
  );
}

/**
 * Pace one AI request for one user: null to proceed, else the refusal (429 when
 * over the window, 503 + Retry-After when the store could not be consulted).
 * `judge` is the injection seam for tests; the product uses the strict limiter.
 */
export async function paceAiRequest(
  userId: string, name: string, cfg: RateLimitConfig, surfaceLabel: string,
  judge: (key: string, name: string, cfg: RateLimitConfig) => Promise<LimitVerdict> = checkKeyLimitStrict,
): Promise<NextResponse | null> {
  const verdict = await judge(userId, name, cfg);
  if (verdict.status === 'unavailable') console.error(`[ai/pacing] limiter unavailable for ${name}; refusing (fail closed)`);
  return pacingResponse(verdict, surfaceLabel);
}
