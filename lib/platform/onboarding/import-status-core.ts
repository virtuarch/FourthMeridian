/**
 * lib/platform/onboarding/import-status-core.ts  (PB-7 — new-connection import health, pure)
 *
 * THE ONE DEFINITION of "how did this connection's first history import go?",
 * folded by both readers so they cannot disagree:
 *
 *   • Customer Success — the audited profile's Onboarding timeline (per
 *     connection) and the overview's "Recently joined (14 d)" panel (one dot per
 *     customer: the worst of their connections);
 *   • Platform Ops — the identity-free "New-connection imports (7 d)" tile
 *     (counts per status, no owner).
 *
 * From EXISTING facts only (no schema): the PlaidItem's own import markers
 * (syncIncompleteAt, historyBuildStartedAt, completedSyncCount,
 * syncImportedCount, status/errorCode) and the item's RefreshExecution rows in
 * its first IMPORT_WINDOW_MS (via the refresh projection seam).
 *
 * STATUSES (disjoint — every linked item is exactly one):
 *   in_progress  the import markers are still set (importing, or the wealth
 *                rebuild is running) and nothing says it failed. `interrupted`
 *                when the newest execution so far FAILED (a resume is pending).
 *   complete     the markers cleared after ≥1 completed sync, with no
 *                interruption on the way.
 *   recovered    complete, but the way there was interrupted: a FAILED/PARTIAL
 *                execution (a reaped "process ended mid-run" row included)
 *                followed by a later SUCCEEDED one, or the import was finished
 *                by a RESUME (the resume-stale-imports backstop / client resume
 *                only runs because the first pass did not finish).
 *                The Production case of 2026-11-01 (killed 20:44Z, resumed to
 *                completion 20:55Z, reaped 21:00Z) is exactly this.
 *   failed       the import did not land: the item needs re-authentication or is
 *                in ERROR while its import is incomplete, or it has been
 *                incomplete for more than STALL_AFTER_MS.
 *   removed      the item was REVOKED (the customer removed it).
 *
 * Counts, kinds and timestamps only — nothing here sees a transaction.
 * Pure: no I/O, no clock (`now` is handed in).
 */

import { isReapedStaleExecution } from "@/lib/plaid/stale-execution.core";

/** Executions this long after linking count as the item's onboarding import. */
export const IMPORT_WINDOW_MS = 48 * 3_600_000;
/** An import still incomplete this long after its marker is a failure, not "in progress". */
export const STALL_AFTER_MS = 24 * 3_600_000;

/**
 * The measurement windows in words — shown in the Platform Ops tile's "how
 * measured" note. PINNED (import-status-core.test.ts): the test also checks the
 * 48 h / 24 h figures still match IMPORT_WINDOW_MS / STALL_AFTER_MS.
 */
export const IMPORT_MEASUREMENT_NOTE =
  "An import counts runs in the first 48 h after linking; it reads Failed if still incomplete 24 h after it began; a run reaped as stale reads Recovered when a later run for the same connection succeeded.";

export const IMPORT_STATUSES = ["in_progress", "complete", "recovered", "failed", "removed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Why an import failed (or was interrupted) — a closed category, never free text. */
export type ImportReasonCategory =
  | "REAUTH_REQUIRED" | "PROVIDER_ERROR" | "INTERRUPTED" | "STALLED"
  // RefreshExecution.failureCategory (lib/plaid/refresh-verdict.core.ts), passed through:
  | "PROVIDER_TIMEOUT" | "PROVIDER_RATE_LIMITED" | "PROVIDER_AUTH" | "CONFIGURATION" | "INPUT" | "UNSUPPORTED" | "INTERNAL" | "UNKNOWN";

const PASSTHROUGH = new Set(["PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED", "PROVIDER_AUTH", "PROVIDER_ERROR", "CONFIGURATION", "INPUT", "UNSUPPORTED", "INTERNAL", "UNKNOWN"]);

export const IMPORT_REASON_LABELS: Readonly<Record<ImportReasonCategory, string>> = {
  REAUTH_REQUIRED: "the bank asked the customer to sign in again",
  PROVIDER_ERROR: "the provider returned an error",
  INTERRUPTED: "the import process ended mid-run (time limit)",
  STALLED: "no progress for over 24 h",
  PROVIDER_TIMEOUT: "the provider timed out",
  PROVIDER_RATE_LIMITED: "the provider rate-limited us",
  PROVIDER_AUTH: "provider authentication failed",
  CONFIGURATION: "a configuration problem",
  INPUT: "the provider rejected the request",
  UNSUPPORTED: "the institution does not support this",
  INTERNAL: "an internal error",
  UNKNOWN: "an unclassified failure",
};

/**
 * PB-7 Preview nit (a) — the reason as a short noun phrase, for the RECOVERED
 * wording: an import that completed is not "an unclassified failure"; its
 * EARLIER ATTEMPT was. Pinned in import-status-core.test.ts.
 */
export const IMPORT_REASON_SHORT: Readonly<Record<ImportReasonCategory, string>> = {
  REAUTH_REQUIRED: "bank sign-in required",
  PROVIDER_ERROR: "provider error",
  INTERRUPTED: "process ended mid-run",
  STALLED: "no progress for over 24 h",
  PROVIDER_TIMEOUT: "provider timeout",
  PROVIDER_RATE_LIMITED: "provider rate limit",
  PROVIDER_AUTH: "provider authentication failure",
  CONFIGURATION: "configuration problem",
  INPUT: "request rejected by the provider",
  UNSUPPORTED: "not supported by the institution",
  INTERNAL: "internal error",
  UNKNOWN: "unclassified failure",
};

/** "Recovered after an interruption (earlier attempt: <reason>)" — the one wording every surface uses for a recovered import. */
export function recoveredPhrase(reason: ImportReasonCategory | null): string {
  return reason ? `Recovered after an interruption (earlier attempt: ${IMPORT_REASON_SHORT[reason]})` : "Recovered after an interruption";
}

/** The PlaidItem facts the rule reads — no token, no cursor, no owner. */
export interface ImportItemFacts {
  id: string;
  createdAt: Date;
  status: string;
  errorCode: string | null;
  syncIncompleteAt: Date | null;
  historyBuildStartedAt: Date | null;
  completedSyncCount: number;
  syncImportedCount: number;
}

/** One RefreshExecution of the item in its import window (from the projection seam). */
export interface ImportExecutionFact {
  id: string;
  trigger: string;
  profile: string;
  startedAt: Date;
  completedAt: Date | null;
  overallStatus: string;
  failureCategory: string | null;
  /** True when the stale-execution reaper finalised the row (isReapedStaleExecution). */
  reaped: boolean;
}

export interface ImportEvidence {
  executions: readonly ImportExecutionFact[];
  /** completedAt of the first SUCCEEDED REGENERATION stage (wealth history rebuilt), or null when none is recorded. */
  firstWealthRegenAt: Date | null;
}

export interface ImportVerdict {
  status: ImportStatus;
  /** in_progress only: the newest execution so far FAILED and a resume is pending. */
  interrupted: boolean;
  /** failed (why), or recovered / interrupted (what interrupted it); null otherwise. */
  reason: ImportReasonCategory | null;
  /** Transactions imported for the item (PlaidItem.syncImportedCount) — a count, never content. */
  transactions: number;
  /** When the import was observed to complete (the earliest SUCCEEDED execution's completion after which nothing failed), or null. */
  completedAt: Date | null;
  firstWealthRegenAt: Date | null;
  /** Executions in the import window, and how many were reaped (process ended mid-run). */
  executions: number;
  reapedExecutions: number;
}

/** One linked item with its verdict, as the shared loader (import-facts.ts) returns it. */
export interface ImportedItem extends ImportItemFacts {
  institutionName: string;
  /** Only when the caller asked for owners (Customer Success). */
  userId?: string;
  verdict: ImportVerdict;
}

/** Map an execution row (the projection's facts) to the import fact the rule reads. */
export function importExecutionFact(row: {
  id: string; trigger: string; profile: string; startedAt: Date; completedAt: Date | null;
  overallStatus: string; failureCategory: string | null; errorSummary: string | null;
}): ImportExecutionFact {
  return {
    id: row.id, trigger: row.trigger, profile: row.profile, startedAt: row.startedAt, completedAt: row.completedAt,
    overallStatus: row.overallStatus, failureCategory: row.failureCategory, reaped: isReapedStaleExecution(row),
  };
}

function categoryOf(e: ImportExecutionFact | undefined): ImportReasonCategory | null {
  if (!e) return null;
  if (e.reaped) return "INTERRUPTED";
  if (e.failureCategory && PASSTHROUGH.has(e.failureCategory)) return e.failureCategory as ImportReasonCategory;
  return "UNKNOWN";
}

const isFail = (e: ImportExecutionFact) => e.overallStatus === "FAILED" || e.overallStatus === "PARTIAL";

export function deriveImportStatus(item: ImportItemFacts, evidence: ImportEvidence | null, now: Date): ImportVerdict {
  const windowEnd = item.createdAt.getTime() + IMPORT_WINDOW_MS;
  const execs = [...(evidence?.executions ?? [])]
    .filter((e) => e.startedAt.getTime() >= item.createdAt.getTime() - 60_000 && e.startedAt.getTime() <= windowEnd)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : 1));
  const base = {
    transactions: item.syncImportedCount,
    firstWealthRegenAt: evidence?.firstWealthRegenAt ?? null,
    executions: execs.length,
    reapedExecutions: execs.filter((e) => e.reaped).length,
  };

  const firstFailure = execs.find(isFail);
  const succeededAfterFailure = firstFailure ? execs.find((e) => e.overallStatus === "SUCCEEDED" && e.startedAt > firstFailure.startedAt) : undefined;
  const resumed = execs.find((e) => e.overallStatus === "SUCCEEDED" && e.trigger === "RESUME");
  const lastSuccess = [...execs].reverse().find((e) => e.overallStatus === "SUCCEEDED");
  // A SKIPPED run (lock held by another sync, or a policy refusal) did no work, so it
  // neither progresses nor clears an interruption: "newest" is the newest run that RAN
  // (the 2026-11-01 Production read has a SKIPPED resume between the reaped run and the real one).
  const newest = [...execs].reverse().find((e) => e.overallStatus !== "SKIPPED");
  const latestFailure = [...execs].reverse().find(isFail);

  if (item.status === "REVOKED") {
    return { status: "removed", interrupted: false, reason: null, completedAt: null, ...base };
  }

  const incomplete = item.syncIncompleteAt !== null || item.historyBuildStartedAt !== null || item.completedSyncCount < 1;
  if (incomplete) {
    if (item.status === "NEEDS_REAUTH") return { status: "failed", interrupted: false, reason: "REAUTH_REQUIRED", completedAt: null, ...base };
    if (item.status === "ERROR") return { status: "failed", interrupted: false, reason: "PROVIDER_ERROR", completedAt: null, ...base };
    const since = (item.syncIncompleteAt ?? item.createdAt).getTime();
    if (now.getTime() - since > STALL_AFTER_MS && item.historyBuildStartedAt === null) {
      return { status: "failed", interrupted: false, reason: categoryOf(latestFailure) ?? "STALLED", completedAt: null, ...base };
    }
    const interrupted = newest !== undefined && isFail(newest);
    return { status: "in_progress", interrupted, reason: interrupted ? categoryOf(newest) : null, completedAt: null, ...base };
  }

  // Complete. Was the way there interrupted?
  const recoveredBy = succeededAfterFailure ?? resumed;
  if (recoveredBy) {
    const why = firstFailure ? categoryOf(firstFailure) : "INTERRUPTED";
    return { status: "recovered", interrupted: false, reason: why, completedAt: lastSuccess?.completedAt ?? null, ...base };
  }
  return { status: "complete", interrupted: false, reason: null, completedAt: lastSuccess?.completedAt ?? null, ...base };
}

/** Per-status tally (every status present, zeros included) — the Platform Ops tile and the cross-reader consistency test. */
export function tallyImportStatuses(verdicts: readonly Pick<ImportVerdict, "status">[]): Record<ImportStatus, number> {
  const out = Object.fromEntries(IMPORT_STATUSES.map((s) => [s, 0])) as Record<ImportStatus, number>;
  for (const v of verdicts) out[v.status] += 1;
  return out;
}

/** The Recently-joined dot: red any failed · amber any in progress / recovered · green all complete · none without a live connection. */
export type ImportHealthDot = "green" | "amber" | "red" | "none";

export function importHealthDot(verdicts: readonly Pick<ImportVerdict, "status">[]): ImportHealthDot {
  const live = verdicts.filter((v) => v.status !== "removed");
  if (live.length === 0) return "none";
  if (live.some((v) => v.status === "failed")) return "red";
  if (live.some((v) => v.status === "in_progress" || v.status === "recovered")) return "amber";
  return "green";
}
