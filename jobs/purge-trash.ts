/**
 * jobs/purge-trash.ts
 *
 * W2 — the goals purge arm (its ONLY arm) was deleted with the Goals
 * retirement. This job existed to make the 7-day goal-trash retention promise
 * true: SpaceGoal rows soft-deleted (deletedAt) for more than 7 days were
 * permanently removed. With Goals retired there is no surface that can trash
 * a goal, zero goal rows exist anywhere, and DB-side FK cascades
 * (SpaceGoal→Space, GoalContribution→SpaceGoal/FinancialAccount,
 * GoalCheckIn→SpaceGoal, all onDelete: Cascade) own goal-row cleanup — so
 * code-side goal-row deletion is redundant by doctrine and must not return.
 *
 * The job REGISTRATION is intentionally kept (lib/jobs/registry.ts 07:30 UTC
 * slot): the scheduler, dispatch ledger, platform-ops registry, and health
 * widgets all reference the job by name, and deregistering it is scheduler
 * surgery that belongs to its own slice. Each run is now an honest no-op that
 * records a zero count in the JobRun ledger. When a future trash-retention
 * arm lands (any model), it goes here.
 */

export interface PurgeTrashResult {
  /** Trashed goals permanently deleted this run — always 0 since W2 (see header). */
  purgedGoals: number;
}

export async function purgeTrash(): Promise<PurgeTrashResult> {
  // W2 — no purge arms remain; see the file header.
  return { purgedGoals: 0 };
}
