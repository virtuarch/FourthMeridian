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
import { redactedErrorForLog } from "@/lib/plaid/errors";
import type { SyncIssueKind, Prisma } from "@prisma/client";

export interface SyncIssueInput {
  kind:                SyncIssueKind;
  plaidItemId?:        string | null;
  financialAccountId?: string | null;
  plaidTransactionId?: string | null;
  plaidAccountId?:     string | null;
  detail?:             Prisma.InputJsonValue;
}

/**
 * Records a SyncIssue. Never throws.
 *
 * @param client PRE-V26-PLAID-CLOSE Phase 2 — the Prisma client to write
 * through, defaulting to the real `db`. Callers that already thread an injected
 * client through their operation MUST pass it here.
 *
 * Why this parameter exists: this function used to resolve `db` from module
 * scope unconditionally, so it escaped every caller's injected client. A unit
 * test that passed a mocked client and hit an error path wrote a REAL row into
 * the developer's database — that is the documented origin of the eight
 * `stage: "opening-position-repair"` rows sitting in the local dev DB, whose
 * `financialAccountId` is the test fixture id `"fa1"`. The leak was invisible
 * because this function swallows its own failures by design.
 *
 * Injection is preferred over a `NODE_ENV === "test"` no-op precisely so sync
 * tests can still ASSERT that an issue was recorded (Phase 1B needs exactly
 * that) rather than having the behaviour disabled underneath them.
 */
/**
 * PRE-V26-PLAID-CLOSE Phase 4 — close the cursor-blocking issues for one item
 * after a sync run has provably persisted everything. Returns how many rows were
 * resolved. Never throws (mirrors `recordSyncIssue`).
 *
 * ── WHY THIS IS SOUND, AND WHY IT IS SO NARROW ───────────────────────────────
 * Under the Phase 1 invariant a Plaid cursor advances past a page ONLY when
 * every canonical persistence obligation for that page succeeded. So a completed
 * `syncTransactionsForItem` is PROOF that the previously-held page replayed and
 * its rows landed. That proof is what licenses resolving those issues — not the
 * passage of time, and not the absence of a new failure.
 *
 * The proof covers EXACTLY the rows Phase 1 created, which is why the filter
 * requires `detail.cursorBlocking = true`:
 *
 *   • A PRE-Phase-1 failure advanced its cursor at the time. Plaid will never
 *     re-deliver that row, so a later successful sync says NOTHING about whether
 *     its data ever landed. Auto-resolving it would produce a "resolved" issue
 *     that still represents missing canonical financial data — the exact thing
 *     this initiative forbids. Those rows stay open for manual triage.
 *   • Non-cursor-blocking kinds (REMOVED_TOMBSTONE, BALANCE_TX_MISMATCH) are
 *     point-in-time EVENTS with no lifecycle; they are never "resolved" at all.
 *
 * Scoped to ONE plaidItemId — a successful Chase sync says nothing about Amex.
 */
export async function resolveCursorBlockingIssues(
  plaidItemId: string,
  client: Pick<typeof db, "syncIssue"> = db,
): Promise<number> {
  try {
    const { count } = await client.syncIssue.updateMany({
      where: {
        plaidItemId,
        resolved: false,
        // Json-path equality — the same idiom lib/security/anomaly-alerts.ts
        // already uses against AuditLog.metadata.
        detail: { path: ["cursorBlocking"], equals: true },
      },
      data: { resolved: true },
    });
    if (count > 0) {
      console.log(
        `[syncIssue] item ${plaidItemId} — resolved ${count} cursor-blocking issue(s): the held page replayed and every row persisted.`,
      );
    }
    return count;
  } catch (e) {
    console.error(`[syncIssue] failed to resolve cursor-blocking issues for item ${plaidItemId} (non-fatal):`, redactedErrorForLog(e));
    return 0;
  }
}

export async function recordSyncIssue(
  input: SyncIssueInput,
  client: Pick<typeof db, "syncIssue"> = db,
): Promise<void> {
  try {
    await client.syncIssue.create({
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
    console.error(`[syncIssue] failed to record ${input.kind} (non-fatal):`, redactedErrorForLog(e));
  }
}
