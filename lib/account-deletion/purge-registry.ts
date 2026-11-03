/**
 * lib/account-deletion/purge-registry.ts  (PB-1 Phase 1 — the subject-reference registry)
 *
 * Every column that ties a row to a CUSTOMER or to one of their subjects —
 * `userId`, `subjectUserId`, `plaidItemId` / `plaidItemDbId`,
 * `financialAccountId`, any `subject…Id` — has an explicit disposition on
 * account deletion. purge-registry.test.ts GENERATES the column list from the
 * Prisma DMMF and fails CI for any column that is neither an FK whose cascade
 * the purge triggers nor listed here. A future table (an AI retrieval index,
 * say) therefore cannot ship holding a customer reference nobody sorted.
 *
 *   DELETE   the purge deletes the row (lib/account-deletion/purge.ts, or a
 *            module it calls inside the destructive tail)
 *   NULL     the purge (or an FK SetNull) nulls the column; the row survives
 *   RETAIN   kept on purpose — the reason is the decision
 *
 * FK columns with onDelete: Cascade from a parent the purge hard-deletes (User,
 * FinancialAccount, PlaidItem) are classified CASCADE by the test itself and
 * need no entry.
 */

export type PurgeDisposition = "DELETE" | "NULL" | "RETAIN";

export interface PurgeRegistryEntry {
  disposition: PurgeDisposition;
  /** Where it happens, or why it is kept. */
  reason: string;
}

export const PURGE_REGISTRY: Record<string, PurgeRegistryEntry> = {
  // ── PB-1 Phase 1 — incident data (lib/platform/incidents/purge.ts, inside the tail) ──
  "SyncIssue.subjectUserId":         { disposition: "DELETE", reason: "incident purge: rows matched by subjectUserId are deleted" },
  "SyncIssue.plaidItemId":           { disposition: "DELETE", reason: "incident purge: rows on the user's Items are deleted (legacy rows have no subjectUserId)" },
  "SyncIssue.financialAccountId":    { disposition: "DELETE", reason: "incident purge: rows on the user's accounts are deleted (legacy rows have no subjectUserId)" },
  "SyncIssueOccurrence.subjectAccountId": { disposition: "DELETE", reason: "incident purge matches episodes by it; the occurrence cascades with its SyncIssue" },
  "SyncIssueArchive.subjectUserId":  { disposition: "DELETE", reason: "incident purge: archive rows matched by subjectUserId are deleted" },
  "SyncIssueArchive.plaidItemId":    { disposition: "DELETE", reason: "incident purge: archive rows on the user's Items are deleted" },
  "SyncIssueArchive.financialAccountId": { disposition: "DELETE", reason: "incident purge: archive rows on the user's accounts are deleted" },

  // ── Pre-existing soft references, sorted on purpose ─────────────────────────
  "AiInvocation.userId":             { disposition: "NULL", reason: "DB-002 scrub in the tail (aiInvocation.updateMany → userId: null); the cost ledger survives" },
  "AuditLog.userId":                 { disposition: "NULL", reason: "FK SetNull; security / audit rows survive anonymised (privacy policy §6)" },
  "AccountConnection.plaidItemDbId": { disposition: "DELETE", reason: "the connection row cascades with its FinancialAccount / User; SetNull only covers an Item deleted first" },
  "TransactionObservation.financialAccountId": { disposition: "DELETE", reason: "cascades with its TransactionEvent, which cascades with the deleted FinancialAccount" },
  "SnapshotAmendment.financialAccountId": { disposition: "DELETE", reason: "cascades with its Space (deleted with the user) or its requesting User" },
  "RefreshExecution.plaidItemId":    { disposition: "RETAIN", reason: "operational ledger, ids only; ages out at 60 days (jobs/data-retention.ts); privacy policy §6 operational records" },
  "RefreshEndpointAccountCoverage.financialAccountId": { disposition: "RETAIN", reason: "child of RefreshExecution (cascade), ages out with it at 60 days" },
  "PlaidWebhookEvent.plaidItemId":   { disposition: "RETAIN", reason: "webhook ledger, ids only; ages out at 30 days (jobs/data-retention.ts)" },
};
