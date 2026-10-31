/**
 * jobs/purge-trash.ts
 *
 * W2 — the goals purge arm (its ONLY arm) was deleted with the Goals
 * retirement. DB-side FK cascades (SpaceGoal→Space, GoalContribution→
 * SpaceGoal/FinancialAccount, GoalCheckIn→SpaceGoal, all onDelete: Cascade)
 * own goal-row cleanup — so code-side goal-row deletion is redundant by
 * doctrine and must not return.
 *
 * The job REGISTRATION was intentionally kept (07:30 UTC slot) because the
 * scheduler, dispatch ledger, platform-ops registry and health widgets all
 * reference the job by name — "when a future retention arm lands, it goes
 * here." PRIV-003 / DB-001 (2026-10-22) is that arm: the operational-ledger
 * and identity-table retention schedule (jobs/data-retention.ts). No registry
 * entry is added or renamed.
 *
 * DECIDED NOT TO IMPLEMENT a trashed-Space / trashed-account hard purge here:
 * Space/FinancialAccount `deletedAt` is "moved to trash, restorable", and the
 * product's permanent-delete routes are the user's explicit erasure. An
 * automatic time-based hard delete of financial data is an owner policy
 * decision (window, notice), not a code default — recorded in the Agent C
 * report as an open decision.
 */

import { runDataRetention, type DataRetentionResult } from "@/jobs/data-retention";

export interface PurgeTrashResult {
  /** Trashed goals permanently deleted this run — always 0 since W2 (see header). */
  purgedGoals: number;
  /** PRIV-003 / DB-001 — rows deleted per retention rule. */
  retention: DataRetentionResult;
}

/**
 * `dryRun` (R2) counts what the retention schedule WOULD delete/minimise and
 * writes nothing. The registered job never passes it; it exists for operator
 * scripts and tests.
 */
export async function purgeTrash(opts: { dryRun?: boolean } = {}): Promise<PurgeTrashResult> {
  return { purgedGoals: 0, retention: await runDataRetention(undefined, new Date(), { dryRun: !!opts.dryRun }) };
}
