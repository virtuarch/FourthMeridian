/**
 * lib/accounts/disconnect.ts  (CONN-4A, authority split by RLS-C-S7)
 *
 * THE single connection-disconnect primitive (Model A — stop syncing, preserve
 * history). Extracted from DELETE /api/accounts/[id] so the account-level remove
 * AND the connection-level disconnect share ONE engine — no duplicated logic.
 *
 * It is NON-DESTRUCTIVE and reversible:
 *   - soft-delete the FinancialAccount(s) (deletedAt) — history preserved
 *   - soft-delete their AccountConnection(s)
 *   - revoke their ACTIVE SpaceAccountLinks (status=REVOKED) — revoke-don't-delete
 *   - regenerate TODAY's SpaceSnapshot per affected space (best-effort)
 *   - disconnectPlaidItemIfOrphaned per item (orphan-gated itemRemove + REVOKED)
 *
 * It does NOT hard-delete any row and does NOT touch historical snapshots
 * (deferred). Reconnect (exchange-token) revives the same rows via
 * identity/fingerprint — no duplicate accounts.
 *
 * ── RLS-C-S7 — IT NOW AUTHORIZES, BECAUSE THE DATABASE DOES ──────────────────
 * It used to authorize nothing: "every caller authorizes first" — the account
 * route via an ACTIVE SpaceAccountLink it added, the connection route via
 * connection ownership. Both still do, and both now do it on the tenant role, so
 * their `WHERE` clauses are backed by a policy rather than by review.
 *
 * But this primitive reaches `fm_system` (see the phase map below), and a
 * capability that wide may only ever be handed ids a tenant phase has PROVED.
 * "The caller remembered" is not a boundary. So the ids are re-proved here,
 * against `FinancialAccount` on the tenant client, and the ids that travel
 * onward are the ones that read returned — never the parameter. An id the actor
 * does not own now raises instead of being disconnected.
 *
 * ── THE PHASE MAP, AND WHY IT IS THREE PHASES AND NOT ONE ────────────────────
 *
 *   1. TENANT    (fm_app, withTenantDb)  prove ownership · capture the live
 *                Plaid items · soft-delete the accounts · soft-delete the
 *                connections
 *   2. SYSTEM    (fm_system, one narrow capability)  revoke the links in EVERY
 *                Space and report which Spaces were affected
 *   3. DISPATCH  (no transaction)  snapshot regeneration · provider revocation
 *
 * Phase 1 and phase 2 used to be ONE transaction (KD-4), and splitting them is a
 * real cost, stated rather than hidden: if phase 2 fails, the accounts are
 * soft-deleted while their links are still ACTIVE. That failure is LOUD (it
 * propagates and the route 500s) and the whole operation is IDEMPOTENT — a retry
 * re-proves the same ids, no-ops the soft-deletes, and revokes the links. The
 * alternative was to move the soft-deletes to `fm_system` too, which would have
 * made the capability the entire operation and `lib/accounts/` a `systemDb`
 * neighbourhood. One seam of the kind phase 3 has always had is the cheaper
 * price.
 *
 * ── ORDER IS LOAD-BEARING INSIDE PHASE 1 ─────────────────────────────────────
 * `AccountConnection.fm_app_upd` is `fm_account_visible("financialAccountId")`,
 * which is true only while an ACTIVE link exists in a Space the actor belongs to.
 * The connections MUST therefore be soft-deleted BEFORE the links are revoked.
 * Reversing it does not fail — it writes zero rows and says nothing.
 *
 * KD-4 still holds for what it was about: no external call ever happens inside a
 * transaction. `regenerateSpaceSnapshot` and `disconnectPlaidItemIfOrphaned` stay
 * in phase 3, outside every transaction, and must not be moved in.
 */

import { withTenantDb } from "@/lib/db/tenant-context";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";
import { regenerateSpaceSnapshot } from "@/lib/snapshots/regenerate";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import { revokeAccountLinksEverywhere } from "@/lib/accounts/links-everywhere";

export interface DisconnectAccountsResult {
  disconnectedAccountIds: string[];
  affectedSpaceIds:       string[];
  plaidItemDbIds:         string[];
}

/**
 * The actor does not own one of the accounts they asked to disconnect.
 *
 * Previously unreachable by construction (both callers authorized first) and
 * still expected to be unreachable. It exists because the deployment-wide
 * capability downstream must never be reached with an unproved id, and "expected
 * to be unreachable" is a claim a thrown error can make and a comment cannot.
 */
export class UnauthorizedDisconnectError extends Error {
  readonly requestedCount: number;
  readonly provenCount: number;

  constructor(requestedCount: number, provenCount: number) {
    super(
      `disconnectAccounts: ${requestedCount} account id(s) requested but only ${provenCount} proved owned by the actor on the tenant role. ` +
        `Refusing to proceed — the link revocation downstream runs on a deployment-wide authority and may only ever be given authorized ids.`,
    );
    this.name = "UnauthorizedDisconnectError";
    this.requestedCount = requestedCount;
    this.provenCount = provenCount;
  }
}

/**
 * Soft-disconnect the given FinancialAccounts together. Idempotent-safe: accounts
 * already soft-deleted are skipped by the `deletedAt: null` filters.
 *
 * @param financialAccountIds  accounts to disconnect (the caller has authorized
 *                             these; phase 1 re-proves them against the policy)
 * @param actorUserId          the user performing the disconnect, from
 *                             server-side session state only — never a body, a
 *                             query string, a header, or the active-Space cookie
 */
export async function disconnectAccounts(
  financialAccountIds: string[],
  actorUserId: string,
): Promise<DisconnectAccountsResult> {
  if (financialAccountIds.length === 0) {
    return { disconnectedAccountIds: [], affectedSpaceIds: [], plaidItemDbIds: [] };
  }
  const now = new Date();

  // ── PHASE 1 — THE TENANT PHASE ────────────────────────────────────────────
  const { provenIds, plaidItemDbIds } = await withTenantDb(actorUserId, async (tx) => {
    // THE PROOF. `FinancialAccount.fm_app_sel` admits `ownerUserId = me OR
    // fm_account_visible(id)`; the second arm would admit an account the actor
    // can merely SEE through a shared Space, so ownership is required on top.
    // deletedAt is deliberately NOT filtered — a repeat disconnect must stay a
    // no-op rather than a 403.
    const proven = await tx.financialAccount.findMany({
      where:  { id: { in: financialAccountIds }, ownerUserId: actorUserId },
      select: { id: true, deletedAt: true },
    });
    // The request's own order is preserved, so `disconnectedAccountIds` reads
    // back the way the caller asked rather than the way Postgres returned.
    const ownedIds = new Set(proven.map((a) => a.id));
    const requested = [...new Set(financialAccountIds)];
    const provenIds = requested.filter((id) => ownedIds.has(id));
    if (provenIds.length !== requested.length) {
      throw new UnauthorizedDisconnectError(requested.length, provenIds.length);
    }

    // Plaid items to consider for orphan-revocation — captured from LIVE
    // connections BEFORE the soft-delete (after which the orphan-gate sees zero
    // live links). The same read is the eligibility count the soft-delete below
    // is checked against, so a refusal cannot masquerade as "nothing to close".
    const liveConns = await tx.accountConnection.findMany({
      where:  { financialAccountId: { in: provenIds }, deletedAt: null },
      select: { id: true, plaidItemDbId: true },
    });
    const plaidItemDbIds = [...new Set(
      liveConns.map((c) => c.plaidItemDbId).filter((v): v is string => !!v),
    )];

    const liveAccountCount = proven.filter((a) => a.deletedAt === null).length;
    const softDeleted = await tx.financialAccount.updateMany({
      where: { id: { in: provenIds }, deletedAt: null },
      data:  { deletedAt: now },
    });
    assertEveryObservedRowWasWritten(
      { table: "FinancialAccount", operation: "update", scope: `${provenIds.length} authorized account id(s)` },
      liveAccountCount,
      softDeleted.count,
    );

    const closed = await tx.accountConnection.updateMany({
      where: { financialAccountId: { in: provenIds }, deletedAt: null },
      data:  { deletedAt: now },
    });
    assertEveryObservedRowWasWritten(
      { table: "AccountConnection", operation: "update", scope: `${provenIds.length} authorized account id(s)` },
      liveConns.length,
      closed.count,
    );

    return { provenIds, plaidItemDbIds };
  });

  // ── PHASE 2 — THE DEPLOYMENT-WIDE REVOKE ──────────────────────────────────
  // Revoke-don't-delete: ShareStatus.REVOKED, in every Space, including the ones
  // the actor cannot see. See lib/accounts/links-everywhere.ts for why this is
  // the only honest authority for it, and docs/plans/RLS-DISCONNECT-BLAST-RADIUS.md
  // for the decision. A shortfall is NOT contention and NOT idempotence: the
  // links were observed eligible one statement earlier, under this very
  // authority, so fewer writes than observations is a defect and raises.
  const revocation = await revokeAccountLinksEverywhere(provenIds, actorUserId, now);
  assertEveryObservedRowWasWritten(
    { table: "SpaceAccountLink", operation: "update", scope: `${provenIds.length} authorized account id(s)` },
    revocation.observedLinkCount,
    revocation.changedLinkCount,
  );
  const affectedSpaceIds = [...revocation.affectedSpaceIds];

  // ── PHASE 3 — DISPATCH, OUTSIDE EVERY TRANSACTION (KD-4) ──────────────────
  // Today's row only — historical correction is deferred (CONN-4 doctrine).
  // This is the step that makes a co-owner's net worth stop counting the
  // account, so it runs over the fm_system-captured Space list, not the actor's.
  for (const spaceId of affectedSpaceIds) {
    try {
      await regenerateSpaceSnapshot(spaceId);
    } catch (e) {
      console.warn(`[disconnectAccounts] snapshot regen failed for space ${spaceId} (non-fatal):`, e);
    }
  }

  // Revoke provider access when the item is now fully orphaned (best-effort).
  for (const plaidItemDbId of plaidItemDbIds) {
    await disconnectPlaidItemIfOrphaned(plaidItemDbId);
  }

  return { disconnectedAccountIds: provenIds, affectedSpaceIds, plaidItemDbIds };
}
