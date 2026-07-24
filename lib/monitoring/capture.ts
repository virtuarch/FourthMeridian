/**
 * lib/monitoring/capture.ts  (PS-4A)
 *
 * Server-side operational-error capture authority.
 *
 * The only pre-existing Sentry call site was app/global-error.tsx (client render
 * errors). Server-side infrastructure failures during authentication were never
 * captured — which is precisely why the PS-3D "invalid password" masking took a
 * user report to surface rather than an alert. This is the one chokepoint for
 * capturing those, so tests can assert it fires exactly once with safe context.
 *
 * SAFE CONTEXT ONLY. We attach a stage tag and let the SDK send the error's
 * class + message. Prisma pool errors (P2024 / ECHECKOUTTIMEOUT) carry model
 * names, connection_limit and timeout values — NOT secrets — and scrubEvent
 * (lib/monitoring/sentry-options.ts) already strips request body / cookies /
 * query from every event. We deliberately attach NO credentials, password hash,
 * TOTP value, connection string, or token.
 *
 * NO-OP WITHOUT A DSN. Sentry is initialised `enabled: !!DSN`, so in
 * dev/test/preview this makes no network call and is safe to invoke
 * unconditionally.
 */

import "server-only";

import * as Sentry from "@sentry/nextjs";

/**
 * The authentication stage an infrastructure failure occurred in. Kept coarse
 * and non-secret — enough to route an alert, nothing that identifies a user.
 */
export type AuthInfraStage = "rate-limit" | "user-lookup" | "totp-config" | "session";

/**
 * Capture an infrastructure failure that occurred while authenticating. Records
 * WHERE (stage) and the underlying error's class/message via the SDK. Never
 * throws — capture must not become a second failure on the auth path.
 */
export function captureAuthInfraFailure(stage: AuthInfraStage, error: unknown): void {
  try {
    Sentry.captureException(error, {
      tags:  { area: "auth", stage },
      level: "error",
    });
  } catch {
    // Monitoring must never take down the request it is observing.
  }
}
