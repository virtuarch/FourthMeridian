/**
 * lib/plaid/syncIssues.ts
 *
 * D2.x Financial Data Integrity Gate (M1) — best-effort recorder for
 * transaction-sync integrity issues. A SyncIssue write must NEVER fail a sync:
 * every call is wrapped so a persistence error degrades to a console log.
 *
 * Purely additive/observational — writing a SyncIssue changes no balance,
 * transaction, snapshot, or sync result.
 */

import { db } from "@/lib/db";
import type { SyncIssueKind, Prisma } from "@prisma/client";

export interface SyncIssueInput {
  kind:                SyncIssueKind;
  plaidItemId?:        string | null;
  financialAccountId?: string | null;
  plaidTransactionId?: string | null;
  plaidAccountId?:     string | null;
  detail?:             Prisma.InputJsonValue;
}

/** Records a SyncIssue. Never throws. */
export async function recordSyncIssue(input: SyncIssueInput): Promise<void> {
  try {
    await db.syncIssue.create({
      data: {
        kind:               input.kind,
        plaidItemId:        input.plaidItemId ?? null,
        financialAccountId: input.financialAccountId ?? null,
        plaidTransactionId: input.plaidTransactionId ?? null,
        plaidAccountId:     input.plaidAccountId ?? null,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
      },
    });
  } catch (e) {
    console.error(`[syncIssue] failed to record ${input.kind} (non-fatal):`, e);
  }
}
