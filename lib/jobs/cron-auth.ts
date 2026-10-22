/**
 * lib/jobs/cron-auth.ts  (SEC-009 adoption, Agent C)
 *
 * Timing-safe CRON_SECRET check for the /api/jobs/* routes. The routes
 * compared `authorization !== \`Bearer ${secret}\`` with a short-circuiting
 * string compare. Agent A is creating the shared lib/security/cron-secret.ts;
 * this local helper has the same contract so the integration is a one-line
 * import swap: unset/empty secret ⇒ refuse; constant-time compare over equal-
 * length buffers (a length mismatch is refused without comparing contents).
 */

import { verifyCronAuthorization } from "@/lib/security/cron-secret";

// SEC-009 consolidation (integration, 2026-10-22): ONE comparison. This wrapper
// keeps the boolean call shape the six job routes use; the decision is
// lib/security/cron-secret.ts's (fixed-width digests, so neither the length nor
// a prefix of CRON_SECRET leaks through timing; unset secret refuses).
export function isAuthorizedCronRequest(authorizationHeader: string | null, secret: string | undefined): boolean {
  return verifyCronAuthorization(authorizationHeader, secret) === "AUTHORIZED";
}
