/**
 * lib/plaid/disconnect.ts
 *
 * Extracted from app/api/accounts/[id]/route.ts (DELETE handler) — no
 * behavior change, just a named seam. When a FinancialAccount is removed,
 * the caller soft-deletes its AccountConnection row(s) first, then calls
 * this for each PlaidItem those connections pointed at. If zero non-deleted
 * AccountConnections remain on that PlaidItem, it's orphaned: revoke it at
 * Plaid (itemRemove) and mark it REVOKED in our DB so it stops syncing.
 *
 * This is intentionally Plaid-specific today (calls plaidClient.itemRemove
 * directly). It exists as a single named function so a future provider-
 * agnostic dispatcher (e.g. disconnectProviderConnectionIfOrphaned, keyed by
 * a provider enum) has one obvious call site to swap in, instead of inline
 * logic duplicated across every route that can delete an account.
 *
 * ── RLS-C-S7 — WHY THE ORPHAN GATE IS SAFE, SO NOBODY RE-DERIVES IT ──────────
 * This runs on `fm_system`: it is a post-commit, provider-facing dispatch step
 * (`itemRemove` is an external HTTP call and must never be inside a transaction),
 * and it is reached from jobs and webhooks as well as from request paths.
 *
 * The interesting question was whether a NARROWED view would make `remaining ===
 * 0` fire the destructive `itemRemove` for an item a co-owner still uses. **It
 * would not, and this is checked rather than assumed.** `PlaidItem`'s tenant
 * policy is `"userId" = current_fm_user_id()`, so an item belongs to the single
 * user who connected it, and that user owns every FinancialAccount hanging off
 * it — so every one of its `AccountConnection` rows is reachable by them and the
 * count is accurate under `fm_app` too. Unlike `SpaceAccountLink`, there is no
 * second tenant whose row could be hidden from the count. The authority here is
 * about the EXECUTION PHASE (background, post-commit), not about blast radius.
 * See docs/plans/RLS-DISCONNECT-BLAST-RADIUS.md, "Not a finding".
 *
 * ⚠️ `remaining !== 0` is a plain read, NOT a conditional write, so it is not an
 * instance of the RLS-C-S6a count-as-business-answer defect — and on `fm_system`
 * (`USING (true)`) an empty count is determinate in any case.
 */

import { systemDb } from "@/lib/db";
import { redactedErrorForLog, getPlaidErrorCode } from "@/lib/plaid/errors";
import { AuditAction } from "@/lib/audit-actions";
import { classifyRevocationFailure } from "@/lib/account-deletion/revocation";
import { PlaidItemStatus } from "@prisma/client";
import { plaidClient } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";

/**
 * A narrow injection seam, defaulting to the real singletons so production is
 * byte-identical. It exists because this function resolved `systemDb` and
 * `plaidClient` from module scope, which meant THERE WAS NO WAY TO MAKE THE
 * PROVIDER CALL FAIL — and the failure path is the whole subject of
 * lib/plaid/disconnect-revocation.test.ts. Same seam, same reason, as
 * `syncTransactionsForItem`'s `{ db, plaid }`.
 */
export type DisconnectDeps = {
  db?: typeof systemDb;
  plaid?: Pick<typeof plaidClient, "itemRemove">;
  /** The health chokepoint. Injected only so the test can observe the write. */
  setHealth?: typeof setPlaidItemHealth;
};

export async function disconnectPlaidItemIfOrphaned(
  plaidItemDbId: string,
  deps: DisconnectDeps = {},
): Promise<void> {
  const database = deps.db ?? systemDb;
  const plaid = deps.plaid ?? plaidClient;
  const setHealth = deps.setHealth ?? setPlaidItemHealth;

  // Count remaining non-deleted connections on this PlaidItem
  const remaining = await database.accountConnection.count({
    where: {
      plaidItemDbId,
      deletedAt: null,
    },
  });

  if (remaining !== 0) return;

  const item = await database.plaidItem.findUnique({ where: { id: plaidItemDbId } });
  if (!item) return;

  // ── THE PROVIDER ATTEMPT, AND WHAT ITS OUTCOME IS ALLOWED TO MEAN ─────────
  // Previously: catch → log → fall through, so a transport failure and a
  // confirmed removal were indistinguishable afterwards. Now the outcome is
  // CLASSIFIED, by the classifier that already exists for the deletion path
  // (lib/account-deletion/revocation.ts) rather than a second one invented here.
  //
  // ⚠️ `already-gone` IS ITEM_NOT_FOUND AND NOTHING ELSE. That set is a REPO
  // ASSERTION, not a vendored fact — the Plaid SDK types contain zero
  // occurrences of ITEM_NOT_FOUND or INVALID_ACCESS_TOKEN, and the only vendored
  // statement is that the token "is no longer valid" after a successful remove.
  // `revocation.ts` reasons the mapping out and deliberately EXCLUDES
  // INVALID_ACCESS_TOKEN, because that code can equally mean a malformed or
  // rotated token and treating it as success would claim a revocation we never
  // made. Three operator scripts disagree with it; they are NOT the authority
  // and are not changed here. Unknown codes, network failures and a decrypt
  // failure all land in `retryable`, i.e. still owed.
  let confirmed: "REMOVED" | "ALREADY_GONE" | null = null;
  let plaidErrorCode: string | undefined;
  try {
    const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
    await plaid.itemRemove({ access_token: accessToken });
    confirmed = "REMOVED";
  } catch (plaidErr) {
    console.error("[disconnectPlaidItemIfOrphaned] Plaid itemRemove failed:", redactedErrorForLog(plaidErr));
    plaidErrorCode = getPlaidErrorCode(plaidErr);
    if (classifyRevocationFailure(plaidErrorCode) === "already-gone") confirmed = "ALREADY_GONE";
  }

  // CH-2 — revoke through the chokepoint: writes status REVOKED (unchanged) and
  // records a durable transition row only when the item wasn't already REVOKED.
  // errorCode is left untouched (omitted) — a revoke shouldn't clear a prior
  // error, matching the previous inline update's behavior.
  //
  // ⚠️ STILL UNCONDITIONAL, AND THAT IS DELIBERATE. This is the PRODUCT
  // lifecycle: the user disconnected, and an upstream failure must not make the
  // institution reappear on the Connections hub, which loads with
  // `status: { not: REVOKED }`. Holding at ACTIVE until confirmation would
  // render a ghost card with zero accounts the instant Disconnect was pressed —
  // the regression lib/connections/health-transitions.ts records having already
  // fixed once. The thing that was missing was never the status; it was any
  // record of whether cleanup is still owed.
  await setHealth(plaidItemDbId, { status: PlaidItemStatus.REVOKED });

  // ── THE PROVIDER-CLEANUP LIFECYCLE, DURABLY ──────────────────────────────
  // Read newest-first, an item owes cleanup when its latest marker is
  // UNCONFIRMED. Both rows are additive: a later CONFIRMED resolves the owed
  // cleanup WITHOUT deleting the evidence that it once failed, so the history
  // survives and `scripts/cleanup-orphaned-plaid-items.ts` can discover every
  // item that still needs a provider call. Best-effort: a marker write must
  // never turn a completed disconnect into a failed request — but note the
  // asymmetry, which is the safe direction. Losing a CONFIRMED row leaves an
  // item eligible for a cleanup that will harmlessly re-confirm; losing an
  // UNCONFIRMED row only returns us to today's behaviour.
  try {
    await database.auditLog.create({
      data: {
        userId: item.userId,
        action: confirmed
          ? AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED
          : AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED,
        metadata: {
          provider:    "PLAID",
          plaidItemId: plaidItemDbId,
          ...(confirmed ? { outcome: confirmed } : {}),
          // The provider's own code, so an operator can tell a 500 from a
          // rotated token without re-running anything. Omitted when absent
          // rather than written as null, so "no code" stays distinguishable.
          ...(plaidErrorCode ? { plaidErrorCode } : {}),
        },
      },
    });
  } catch (auditErr) {
    console.error(
      `[disconnectPlaidItemIfOrphaned] revocation marker write failed for item ${plaidItemDbId} (non-fatal):`,
      redactedErrorForLog(auditErr),
    );
  }
}
