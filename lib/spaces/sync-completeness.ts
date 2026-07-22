/**
 * lib/spaces/sync-completeness.ts
 *
 * PRE-BETA-OPS-CLOSE final pass — THE Space-scoped answer to one question:
 *
 *   "Is any provider connection behind the accounts in THIS Space currently
 *    mid-sync, such that balances may be ahead of transactions and history?"
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The cursor-safety invariant deliberately HOLDS a Plaid page rather than lose a
 * transaction. That is the correct trade, but it creates a partial-convergence
 * state the product previously did not admit to: `refreshPlaidItem` writes
 * balances BEFORE transaction sync, so when transaction sync throws, the balance
 * is fresh while transactions, reconciliation and the snapshot are not. Nothing
 * is wrong — the balance is true — but a user reading a current balance beside a
 * lagging chart would reasonably assume both had converged.
 *
 * ── SCOPE IS THE WHOLE POINT ─────────────────────────────────────────────────
 * Deliberately NOT "does this user have any stalled item anywhere". A Space
 * shows a specific set of shared accounts; a stall on an institution that is not
 * in this Space says nothing about the numbers on this screen, and warning about
 * it would be noise that teaches people to ignore the indicator. The traversal
 * is therefore the SAME one every other Space read uses —
 * SpaceAccountLink(ACTIVE) → FinancialAccount(live) → AccountConnection(live) →
 * PlaidItem — so an account's presence here can never disagree with its presence
 * in the accounts list.
 *
 * Conversely, if the same stalled account IS shared into several Spaces, every
 * one of them warns. That is correct: they are all showing figures derived from it.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────
 * Returns a BOOLEAN and nothing else. No item id, institution, error code,
 * SyncIssue detail, runId, or attempt count crosses into customer-facing code —
 * that operational evidence belongs to Platform Ops. The customer signal is a
 * trust caveat, not an incident console.
 */

import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";

/**
 * True when at least one Plaid item backing an ACTIVE, live account in this
 * Space is mid-sync (`syncIncompleteAt != null`).
 *
 * `syncIncompleteAt` is the existing completion marker (lib/sync/status.ts):
 * set at connect and on any failed run, cleared only when a full transaction
 * sync completes. It therefore covers BOTH the new cursor-held stall and the
 * pre-existing "history still importing" case — which is right, because the
 * user-facing consequence is identical in both: balances may be ahead of
 * transactions and history.
 *
 * NEVER throws. See `resolveSpaceSyncCompleteness` for the failure contract.
 */
export async function spaceHasSyncIncompleteProviderData(spaceId: string): Promise<boolean> {
  const link = await db.spaceAccountLink.findFirst({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: {
        deletedAt: null,
        connections: {
          some: {
            deletedAt: null,
            plaidItem: { syncIncompleteAt: { not: null } },
          },
        },
      },
    },
    select: { id: true },
  });
  return link !== null;
}

/**
 * The value the trust layer consumes. `null` is NOT "everything is fine" — it
 * is "we could not determine this", and it is what a failed lookup returns.
 *
 * The distinction matters: silently reporting `false` on a failed query would
 * assert full convergence we never verified, which is precisely the class of
 * quiet false-reassurance this initiative exists to remove. Consumers treat
 * `null` as "no claim" — the warning is simply absent rather than asserted
 * either way, matching how the envelope already handles an absent lens result
 * (an inert placeholder, never invented detail).
 */
export type SpaceSyncCompleteness = boolean | null;

/** Best-effort resolver: never throws, returns `null` when it cannot tell. */
export async function resolveSpaceSyncCompleteness(spaceId: string): Promise<SpaceSyncCompleteness> {
  try {
    return await spaceHasSyncIncompleteProviderData(spaceId);
  } catch (e) {
    console.error(`[space-sync-completeness] lookup failed for space ${spaceId} (non-fatal):`, e);
    return null;
  }
}
