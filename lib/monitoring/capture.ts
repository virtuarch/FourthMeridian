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

// ── Operational-ledger write failures (SCHEDULER-DISPATCH-RESTORE-1) ──────────
//
// WHY THIS EXISTS. Both operational ledgers write best-effort and swallow their
// own failures on purpose — "the ledger must never break the job it observes"
// (lib/jobs/run.ts) and the identical contract in lib/plaid/refresh-execution.ts.
// That contract is correct and is NOT being changed here. What was missing is
// that a swallowed failure went only to console.error, so a ledger that had gone
// completely write-dead stayed invisible: the dispatcher still returned 200, the
// Vercel cron dashboard stayed green, and the only visible symptom was every job
// drifting to "overdue" on a surface nobody watches minute-to-minute.
//
// That is exactly what happened on 2026-07-26: the production deploy shipped
// OPS-2B′ (JobRun.deploymentSha) without its migration, so every jobRun.create()
// failed P2022 for ten hours while every job body ran normally.
//
// So: still swallowed, still non-fatal, but now escalated. A write-dead ledger
// pages instead of hiding behind a 200.

/** The append-only execution ledgers whose writes are best-effort. */
export type OperationalLedger = "JobRun" | "RefreshExecution";

/** Which of the two writes failed. Start failures suppress the completion write. */
export type LedgerWritePhase = "start" | "completion";

/**
 * Extract a Prisma error code (e.g. "P2022" — column does not exist) when the
 * error carries one. This is the schema-drift fingerprint and the single most
 * useful routing tag on the event; it is a static error code, never user data.
 */
function prismaCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Capture a swallowed operational-ledger write failure. Records WHICH ledger,
 * WHICH write, and the Prisma error code when present. Never throws — capture
 * must not become a second failure on a path whose whole contract is that it
 * cannot fail the work it observes.
 *
 * SAFE CONTEXT ONLY, same rules as above: a tag set plus the error's own
 * class/message. The job name is a static registry identifier (lib/jobs/registry.ts),
 * not user content; no summary, row, or connection string is attached.
 */
export function captureLedgerWriteFailure(
  ledger: OperationalLedger,
  phase: LedgerWritePhase,
  error: unknown,
  jobName?: string,
): void {
  try {
    const code = prismaCode(error);
    Sentry.captureException(error, {
      tags: {
        area: "operational-ledger",
        ledger,
        phase,
        ...(code ? { prismaCode: code } : {}),
        ...(jobName ? { jobName } : {}),
      },
      level: "error",
    });
  } catch {
    // Monitoring must never take down the request it is observing.
  }
}
