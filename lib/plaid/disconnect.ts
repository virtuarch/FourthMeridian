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
import { redactedErrorForLog } from "@/lib/plaid/errors";
import { PlaidItemStatus } from "@prisma/client";
import { plaidClient } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";

export async function disconnectPlaidItemIfOrphaned(plaidItemDbId: string): Promise<void> {
  // Count remaining non-deleted connections on this PlaidItem
  const remaining = await systemDb.accountConnection.count({
    where: {
      plaidItemDbId,
      deletedAt: null,
    },
  });

  if (remaining !== 0) return;

  const item = await systemDb.plaidItem.findUnique({ where: { id: plaidItemDbId } });
  if (!item) return;

  try {
    const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
    await plaidClient.itemRemove({ access_token: accessToken });
  } catch (plaidErr) {
    console.error("[disconnectPlaidItemIfOrphaned] Plaid itemRemove failed:", redactedErrorForLog(plaidErr));
  }

  // CH-2 — revoke through the chokepoint: writes status REVOKED (unchanged) and
  // records a durable transition row only when the item wasn't already REVOKED.
  // errorCode is left untouched (omitted) — a revoke shouldn't clear a prior
  // error, matching the previous inline update's behavior.
  await setPlaidItemHealth(plaidItemDbId, { status: PlaidItemStatus.REVOKED });
}
