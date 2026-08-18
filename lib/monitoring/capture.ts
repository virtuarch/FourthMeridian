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

// ── Operational-ledger write failures (SCHEDULER-DISPATCH-RESTORE-1) ─────────
//
// WHY THIS EXISTS. Both append-only execution ledgers write best-effort and
// swallow their own failures on purpose — "the ledger must never break the job
// it observes" (lib/jobs/run.ts) and the identical contract in
// lib/plaid/refresh-execution.ts. That contract is correct and is NOT changed
// here. What was missing is that a swallowed failure went only to console.error,
// so a ledger that had gone completely write-dead stayed invisible: the
// dispatcher still returned 200, the Vercel cron dashboard stayed green, and the
// only visible symptom was every job drifting to "overdue" on a surface nobody
// watches minute-to-minute.
//
// That is exactly what happened on 2026-07-26: the deploy shipped OPS-2B′
// (JobRun.deploymentSha) without its migration, so every jobRun.create() failed
// P2022 for ten hours while every job body ran normally. RefreshExecution was
// worse — its table was absent entirely, so the DF-2 ledger had been write-dead
// since 07-24 and nothing reported it.
//
// So: still swallowed, still non-fatal, but now escalated. A write-dead ledger
// reports itself instead of hiding behind a 200.

/** The append-only execution ledgers whose writes are best-effort. */
export type OperationalLedger = "JobRun" | "RefreshExecution";

/** Which of the two writes failed. Start failures suppress the completion write. */
export type LedgerWritePhase = "start" | "completion";

/**
 * Prisma's schema-drift signatures: the deployed code references a column
 * (P2022) or a table (P2021) that the target database does not have. Kept
 * distinct from the pool-exhaustion codes above for the same reason those are
 * kept distinct from each other — drift and contention have different fixes, so
 * they must not share a fingerprint. P2022 IS the 2026-07-26 fingerprint.
 */
export function isSchemaDriftCode(code: string): boolean {
  return code === "P2021" || code === "P2022";
}

/**
 * Build the Sentry payload for a swallowed operational-ledger write failure.
 *
 * Split out as a PURE function for the same reason buildSessionRevocationCapture
 * is: the tags, the drift fingerprint and — critically — the absence of any
 * credential are then provable in a unit test without a Sentry double.
 *
 * Reuses classifyDbError() rather than reading `.code` locally; a second, blinder
 * Prisma-code reader in this file would be exactly the drift that a single
 * classification authority exists to prevent.
 */
export function buildLedgerWriteCapture(args: {
  ledger:   OperationalLedger;
  phase:    LedgerWritePhase;
  error:    unknown;
  /** Static registry identifier (lib/jobs/registry.ts). Never user content. */
  jobName?: string;
}): {
  tags:     Record<string, string>;
  contexts: Record<string, Record<string, unknown>>;
  level:    "error";
} {
  const dbErrorCode = classifyDbError(args.error);
  return {
    tags: {
      area:          "operational-ledger",
      ledger:        args.ledger,
      // `phase`, not `stage`: "stage" is the SyncIssue operation vocabulary
      // (lib/platform/incidents) and the auth surface already had to rename away
      // from it. Two unrelated meanings under one tag name makes filtering
      // ambiguous.
      phase:         args.phase,
      db_error_code: dbErrorCode,
      schema_drift:  String(isSchemaDriftCode(dbErrorCode)),
      ...(args.jobName ? { jobName: args.jobName } : {}),
      // The deployment is NOT tagged here, for the reason given above: Sentry's
      // `release` already carries currentDeploymentSha() and OPS-2B′ keeps that
      // resolver sole-sourced.
    },
    contexts: {
      ledger_write: {
        ledger: args.ledger,
        phase:  args.phase,
        // Names the outcome in the words of the incident this prevents, so an
        // alert reads as a consequence rather than as a stack trace.
        effect: args.phase === "start"
          ? "run left NO row in this ledger; the completion write is skipped"
          : "row left permanently 'running'; the work itself succeeded",
      },
    },
    // Always an error: either shape makes a successful run unreadable afterwards.
    level: "error",
  };
}

/**
 * Capture a swallowed operational-ledger write failure.
 *
 * SAFE CONTEXT ONLY — and note what is deliberately ABSENT: no summary, no row,
 * no connection string, no user content. The job name is a static registry
 * identifier, and the db error code is a static Prisma code. Never throws:
 * capture must not become a second failure on a path whose whole contract is
 * that it cannot fail the work it observes.
 */
export function captureLedgerWriteFailure(
  ledger: OperationalLedger,
  phase: LedgerWritePhase,
  error: unknown,
  jobName?: string,
): void {
  try {
    Sentry.captureException(error, buildLedgerWriteCapture({ ledger, phase, error, jobName }));
  } catch {
    // Monitoring must never take down the request it is observing.
  }
}
