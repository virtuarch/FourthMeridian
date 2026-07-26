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
      // `auth_stage`, not `stage`: "stage" is also the SyncIssue operation
      // vocabulary (lib/platform/incidents), and two unrelated meanings under one
      // tag name makes Sentry filtering ambiguous.
      tags:  { area: "auth", auth_stage: stage },
      level: "error",
    });
  } catch {
    // Monitoring must never take down the request it is observing.
  }
}

// ── Session-revocation degradation (PROD-POOLER-AUTH-INCIDENT-1) ──────────────
//
// WHY THIS EXISTS. The `"session"` stage above was declared when PS-4A hardened
// the LOGIN path, but never wired: the session-RESUME leg had no capture at all.
// So when the two production incidents (2026-07-25 14:57:38Z, 2026-07-26
// 11:40:08Z) drove `userSession.findFirst()` into P2024 and NextAuth responded by
// deleting users' session cookies, Sentry received NOTHING. The only trace was a
// `[next-auth][error][JWT_SESSION_ERROR]` line in Vercel's 1-hour log window —
// which is why a hard logout took a user report to surface.
//
// This is the missing capture. It fires on BOTH degraded dispositions, because
// they answer different questions: STALE_HIT says "pressure is happening and the
// bounded stale window absorbed it", INDETERMINATE says "pressure exceeded what
// the window could absorb and a request was denied". A monitor that only saw the
// second would think the first was healthy.

/** Cache disposition tag values — mirrors RevocationDisposition's degraded arm. */
export type RevocationDegradation = "STALE_HIT" | "INDETERMINATE";

/**
 * Prisma's connection-pool-exhaustion signatures, kept separate from every other
 * database error. This distinction is the whole diagnostic value: P2024 means
 * "the pool could not hand out a connection in time" (capacity/contention),
 * while P1001/P1002 mean "the database was unreachable" (connectivity). Those
 * have different fixes, so they must not share a fingerprint.
 */
export function classifyDbError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("Timed out fetching a new connection")) return "P2024";
  if (message.includes("ECHECKOUTTIMEOUT"))                    return "ECHECKOUTTIMEOUT";
  return "UNKNOWN";
}

/** True for the pool-exhaustion codes — the class this incident was made of. */
export function isPoolTimeoutCode(code: string): boolean {
  return code === "P2024" || code === "ECHECKOUTTIMEOUT";
}

/**
 * Build the Sentry payload for a degraded revocation check.
 *
 * Split out as a PURE function so the fingerprint, tags and — critically — the
 * absence of any credential are provable in a unit test without a Sentry double.
 * The same reason decideAdminApiAccess() is pure.
 */
export function buildSessionRevocationCapture(args: {
  error:       unknown;
  disposition: RevocationDegradation;
  route?:      string | null;
}): {
  tags:     Record<string, string>;
  contexts: Record<string, Record<string, unknown>>;
  level:    "warning" | "error";
} {
  const dbErrorCode = classifyDbError(args.error);
  return {
    tags: {
      area: "auth",
      // NOTE: this is an AuthInfraStage, NOT a SyncIssue operation stage — two
      // unrelated vocabularies that share the word "stage".
      auth_stage:    "session" satisfies AuthInfraStage,
      disposition:   args.disposition,
      db_error_code: dbErrorCode,
      pool_timeout:  String(isPoolTimeoutCode(dbErrorCode)),
      // The deployment is NOT tagged here on purpose. Sentry's `release` is
      // already set from currentDeploymentSha() in lib/monitoring/sentry-options.ts,
      // so every event carries it, and OPS-2B′ keeps that resolver sole-sourced —
      // a second read here would be exactly the drift that authority forbids.
    },
    contexts: {
      session_revocation: {
        disposition: args.disposition,
        route:       args.route ?? null,
        // Names the outcome in the words of the incident this prevents, so an
        // alert reads as a decision rather than as a stack trace.
        effect: args.disposition === "STALE_HIT"
          ? "served bounded-stale revocation result; session preserved"
          : "denied this request as temporarily unavailable; session preserved",
      },
    },
    // A degraded-but-absorbed check is a warning; a denied request is an error.
    level: args.disposition === "STALE_HIT" ? "warning" : "error",
  };
}

/**
 * Capture a session-revocation check that could not be answered from the
 * database.
 *
 * SAFE CONTEXT ONLY — and note what is deliberately ABSENT: no sessionToken, no
 * JWT, no cookie, no user id, no connection string. A session token is a live
 * credential; putting one in an error report would turn monitoring into a
 * credential leak. `route` is the coarse pathname only (never the query string,
 * which carries deep-link state), and scrubEvent (lib/monitoring/sentry-options.ts)
 * strips body/cookies/query from every event as a second line of defence.
 *
 * Never throws.
 */
export function captureSessionRevocationFailure(args: {
  error:       unknown;
  disposition: RevocationDegradation;
  /** Coarse pathname, no query string. Omit when not resolvable. */
  route?:      string | null;
}): void {
  try {
    Sentry.captureException(args.error, buildSessionRevocationCapture(args));
  } catch {
    // Monitoring must never take down the request it is observing.
  }
}
