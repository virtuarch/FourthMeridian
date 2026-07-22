/**
 * lib/activity/normalize-import-batch.ts
 *
 * Pure producer: ImportBatch row → normalized TimelineEvent (or null).
 *
 * Part of the Activity Tab event-feed Phase 1 (see
 * FOURTH_MERIDIAN_ACTIVITY_TAB_EVENT_FEED_IMPLEMENTATION_PLAN_2026-07-12.md §2.5).
 * This is the "medium" tier of that plan: a new producer over an EXISTING table
 * — no new writes anywhere. The impure Space-scoping query lives in the activity
 * route; this function stays pure and fixture-testable, matching the house split
 * (pure logic / thin DB binding) that normalizeLog() already follows.
 *
 * Honesty contract:
 *   - Only COMPLETED batches are events. A PENDING/PROCESSING/FAILED/ROLLED_BACK
 *     batch is not a "thing that happened" the member should see in the feed.
 *   - Zero-count clauses never render. "0 skipped" / "0 matched" is noise the
 *     vision explicitly warns against — the skipped/matched clauses appear only
 *     when their count is > 0.
 *   - date comes from completedAt, never createdAt: an in-progress batch has no
 *     completedAt, and the feed orders by when the import actually finished.
 *   - id is namespaced (`importbatch:<id>`) so it can never collide with an
 *     AuditLog id in the merged, de-duplicated feed.
 */

import type { TimelineEvent } from "@/lib/timeline-types";

/**
 * The minimal ImportBatch shape this normalizer needs. Matches the fields the
 * activity route `select`s. `status`/`kind` are the Prisma enum string values
 * (assignable from the generated enums); typing them as string unions keeps
 * this module dependency-free and its tests trivial to write.
 */
export interface ImportBatchRow {
  id:            string;
  kind:          "TRANSACTIONS" | "INVESTMENT_HISTORY";
  /** ImportBatchStatus — only "COMPLETED" produces an event. */
  status:        string;
  importedCount: number;
  skippedCount:  number;
  matchedCount:  number;
  /** Set only once the batch finished; the event date and the COMPLETED guard. */
  completedAt:   Date | null;
}

export function normalizeImportBatchEvent(batch: ImportBatchRow): TimelineEvent | null {
  // Only a finished import is an event. Guard on both status and completedAt so
  // a mis-set status can never produce an event dated `null`.
  if (batch.status !== "COMPLETED" || !batch.completedAt) return null;

  const isInvestment = batch.kind === "INVESTMENT_HISTORY";

  // importedCount is the always-present lead (§2.5). skipped/matched are additive
  // clauses shown ONLY when > 0 — never a zero clause.
  const parts: string[] = [`${batch.importedCount} imported`];
  if (batch.skippedCount > 0) parts.push(`${batch.skippedCount} skipped`);
  if (batch.matchedCount > 0) parts.push(`${batch.matchedCount} matched`);

  return {
    id:       `importbatch:${batch.id}`,
    type:     "IMPORT_BATCH_COMPLETED",
    date:     batch.completedAt.toISOString(),
    icon:     "FileDown",
    tone:     "positive",
    category: "connection",
    title:    isInvestment ? "Investment history imported" : "Transactions imported",
    subtitle: parts.join(", "),
  };
}
