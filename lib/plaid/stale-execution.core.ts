/**
 * lib/plaid/stale-execution.core.ts  (PB-7 — the reaper's vocabulary, pure)
 *
 * The errorSummary the stale-execution reaper (refresh-ledger.ts
 * `reapStaleRefreshExecutions`) writes on a RefreshExecution whose process
 * ended without a completion write. It lives here, import-free, so the READERS
 * that must recognise a reaped row (lib/platform/refresh/recovery-core.ts) can
 * do so without importing the ledger door (server-only, Prisma). The door
 * re-exports it unchanged: one literal, one place.
 *
 * A reaped row is the ONLY FAILED execution with this exact summary: every
 * other FAILED row is written by the execution's own completion, whose summary
 * is the thrown error's message.
 */

/** The errorSummary a reaped row carries — the JobRun finaliser's vocabulary word, with its reason. */
export const STALE_EXECUTION_ERROR_SUMMARY =
  "stale: no completion was recorded within the function's maximum duration (the process ended mid-run)";

/** True when this execution row was finalised by the stale-execution reaper, not by its own completion. */
export function isReapedStaleExecution(row: { overallStatus: string; errorSummary: string | null }): boolean {
  return row.overallStatus === "FAILED" && row.errorSummary === STALE_EXECUTION_ERROR_SUMMARY;
}
