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

import { timingSafeEqual } from "node:crypto";

export function isAuthorizedCronRequest(authorizationHeader: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  if (typeof authorizationHeader !== "string") return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(authorizationHeader, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
