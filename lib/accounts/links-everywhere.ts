/**
 * lib/accounts/links-everywhere.ts  (RLS-C-S7)
 *
 * DISCONNECT IS A DEPLOYMENT-WIDE OPERATION. THIS IS THE ONLY OPENING IT GETS.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * Disconnecting an account soft-deletes it and closes its connections, and then
 * revokes EVERY `SpaceAccountLink` pointing at it — including a co-owner's link
 * in a Space the actor is not a member of. That is not an accident of the
 * migration principal; it is the only coherent meaning the operation has. A
 * co-owner's ACTIVE link to a soft-deleted account is a dangling reference whose
 * Space would keep narrating a balance for an account that no longer syncs.
 *
 * `SpaceAccountLink.fm_app_sel` is `spaceId IN (SELECT fm_visible_space_ids())`,
 * so under the tenant role the co-owner's link is INVISIBLE. The revoke would
 * then land on one row of two, their snapshot would never be regenerated, and
 * **nothing would be raised** — `updateMany` would simply return a smaller
 * count. One-of-two looks exactly like success. That is silent data corruption
 * introduced as a side effect of an infrastructure migration, which is precisely
 * the drift this programme exists to prevent.
 *
 * So the authority follows the operation's true blast radius: the link write and
 * the affected-Space capture run on `fm_system`. No policy is weakened, and the
 * product semantics are unchanged — disconnect revoked everywhere before this
 * module existed and revokes everywhere after it.
 *
 * Full reasoning: docs/plans/RLS-DISCONNECT-BLAST-RADIUS.md.
 *
 * ── THE THREE CONSTRAINTS, SO fm_system DOES NOT BECOME AN ESCAPE HATCH ───────
 *
 *  1. AUTHORIZATION HAPPENS BEFORE THIS MODULE IS REACHED, IN A TENANT PHASE.
 *     Every function here takes ids a `withTenantDb` phase has already proved
 *     the actor owns (lib/accounts/disconnect.ts). It performs NO authorization
 *     of its own and must never be given a caller's raw input. Enforced by
 *     lib/accounts/links-everywhere.test.ts, which asserts that every call site
 *     passes a value computed inside a `withTenantDb` callback.
 *
 *  2. IT TAKES ALREADY-AUTHORIZED ACCOUNT IDS AND RETURNS COUNTS AND SPACE IDS,
 *     NEVER ROWS. There is no `spaceId` argument and no `userId` SELECTOR —
 *     `actorUserId` is written into `revokedByUserId` and never appears in a
 *     `where` clause, so there is no argument through which a caller could ask
 *     this module about somebody else. This is the `lib/users/availability.ts`
 *     idiom: the widest authority in the system reached through the narrowest
 *     possible opening. The test asserts the `where` clauses mention only
 *     `financialAccountId` and `status`.
 *
 *  3. IT IS LISTED IN scripts/audit-db-authority.ts AS A FILE, NOT A DIRECTORY.
 *     `lib/accounts/` must not become a `systemDb` neighbourhood. One module,
 *     two functions, reviewable in one sitting.
 *
 * ── AND THE PARTIAL COUNT IS NOT ALLOWED TO BE SILENT ────────────────────────
 * Each function OBSERVES the eligible links and then writes them, and reports
 * both numbers. The caller asserts the second against the first
 * (`assertEveryObservedRowWasWritten`, lib/db/conditional-write.ts). On
 * `fm_system` the policy is `USING (true)`, so the two can only disagree through
 * concurrent modification — which is exactly why a disagreement is an alarm and
 * not a business outcome. The observation is the guard, not an optimisation:
 * delete it and a partial write becomes indistinguishable from a complete one.
 *
 * ── ORDERING IS LOAD-BEARING, AND THE TWO OPERATIONS RUN OPPOSITE WAYS ───────
 * `AccountConnection`'s policy is `fm_account_visible("financialAccountId")`,
 * which is true only while an ACTIVE link exists in a visible Space. So:
 *
 *   DISCONNECT  soft-delete the connections FIRST, revoke the links LAST.
 *               Revoking first makes the connections invisible and their
 *               soft-delete is then refused — silently.
 *   RESTORE     reactivate the links FIRST, un-delete the connections LAST.
 *               Un-deleting first is refused — also silently — because the
 *               links that confer visibility are still REVOKED.
 *
 * Both orders are enforced by source scan in the test, because both failures are
 * invisible at runtime and neither changes a single test's outcome today (local
 * development has no role URLs, so every client falls back to one principal).
 */

import "server-only";

import { Prisma, ShareStatus } from "@prisma/client";

import { systemDb } from "@/lib/db";

/**
 * What a deployment-wide link write reports back. Counts and Space ids only —
 * never a row, never a `userId`, never an account's contents.
 *
 * `affectedSpaceIds` is the one thing that must cross the boundary as data: the
 * caller regenerates a snapshot per Space, and the whole point of reaching
 * `fm_system` is that this list includes the Spaces the actor cannot see.
 */
export interface EverywhereLinkResult {
  /** Links that were eligible, as the deployment-wide authority counted them. */
  readonly observedLinkCount: number;
  /** Links the write actually changed. A deficit is a defect — see the header. */
  readonly changedLinkCount: number;
  /** Distinct Spaces whose snapshot must be regenerated. Ids only. */
  readonly affectedSpaceIds: readonly string[];
}

/**
 * The narrow slice of the `SpaceAccountLink` delegate these two functions use.
 *
 * Deliberately NOT a `PrismaClient` and NOT a `DbClient`: a type that admitted a
 * whole client would let a future caller hand this module a TENANT client, which
 * would silently reinstate the exact defect the module exists to remove (and
 * would do so with the counts agreeing, because a narrowed read and a narrowed
 * write agree with each other). Following the house injection-seam pattern —
 * lib/snapshots/regenerate.ts#SpaceSnapshotClient,
 * lib/plaid/sync-lock.ts#PlaidItemSyncLockClient.
 */
export interface SpaceAccountLinkLifecycleDelegate {
  findMany(args: {
    where: Prisma.SpaceAccountLinkWhereInput;
    select: { spaceId: true };
  }): Promise<Array<{ spaceId: string }>>;
  updateMany(args: {
    where: Prisma.SpaceAccountLinkWhereInput;
    // The UNCHECKED variant too, because `revokedByUserId` is a RELATION's
    // scalar (`revokedByUser`, onDelete SetNull) and Prisma only exposes a
    // relation's raw foreign key on the unchecked input. Narrowing this to the
    // checked variant alone does not make the write safer; it makes the write
    // impossible.
    data: Prisma.SpaceAccountLinkUpdateManyMutationInput | Prisma.SpaceAccountLinkUncheckedUpdateManyInput;
  }): Promise<{ count: number }>;
}

/**
 * Runs one unit of link-lifecycle work atomically against SOME authority.
 *
 * A function rather than a client, so the only way to substitute an authority is
 * to write an adapter — visible, deliberate, and not something a call site can
 * do by passing an object it already has in hand. Production never passes it:
 * the default below is the whole point of the module.
 */
export type AtomicLinkLifecycle =
  <R>(run: (links: SpaceAccountLinkLifecycleDelegate) => Promise<R>) => Promise<R>;

/**
 * THE deployment-wide authority, and the only `systemDb` reference anywhere in
 * `lib/accounts/`. One transaction per call so the observation and the write
 * cannot be separated by a commit boundary.
 */
const DEPLOYMENT_WIDE: AtomicLinkLifecycle = (run) =>
  systemDb.$transaction((tx) => run(tx.spaceAccountLink));

/**
 * REVOKE EVERY ACTIVE LINK TO THESE ACCOUNTS, IN EVERY SPACE, AND REPORT WHICH
 * SPACES WERE AFFECTED.
 *
 * @param authorizedFinancialAccountIds accounts a TENANT PHASE has already
 *        proved the actor owns. Never a caller's raw input — see constraint 1.
 * @param actorUserId recorded as `revokedByUserId`. NOT a selector: it never
 *        appears in a `where` clause, so it cannot be used to reach another
 *        user's rows.
 * @param revokedAt the disconnect's single clock, shared with the soft-deletes.
 */
export async function revokeAccountLinksEverywhere(
  authorizedFinancialAccountIds: readonly string[],
  actorUserId: string,
  revokedAt: Date,
  atomically: AtomicLinkLifecycle = DEPLOYMENT_WIDE,
): Promise<EverywhereLinkResult> {
  if (authorizedFinancialAccountIds.length === 0) {
    return { observedLinkCount: 0, changedLinkCount: 0, affectedSpaceIds: [] };
  }
  const ids = [...authorizedFinancialAccountIds];

  return atomically(async (links) => {
    // The affected-Space capture. It runs BEFORE the revoke and observes
    // pre-revocation state — after the write there is no ACTIVE link left to
    // read, so this read is not re-derivable later. It is also the guard that
    // makes the partial audible.
    const observed = await links.findMany({
      where:  { financialAccountId: { in: ids }, status: ShareStatus.ACTIVE },
      select: { spaceId: true },
    });

    const { count } = await links.updateMany({
      where: { financialAccountId: { in: ids }, status: ShareStatus.ACTIVE },
      data:  { status: ShareStatus.REVOKED, revokedAt, revokedByUserId: actorUserId },
    });

    return {
      observedLinkCount: observed.length,
      changedLinkCount:  count,
      affectedSpaceIds:  [...new Set(observed.map((l) => l.spaceId))],
    };
  });
}

/**
 * REACTIVATE EVERY REVOKED LINK TO THESE ACCOUNTS, IN EVERY SPACE — the exact
 * inverse, and deployment-wide for the exact same reason.
 *
 * A restore that reactivated only the links the restoring user can see would
 * leave a co-owner's Space holding a REVOKED link to a live account: the account
 * syncs again, its balance moves again, and their net worth silently never hears
 * about it. Same blast radius, same silence, same authority.
 *
 * It needs no `actorUserId` at all — a reactivation CLEARS `revokedByUserId` —
 * so this one is narrower still.
 */
export async function reactivateAccountLinksEverywhere(
  authorizedFinancialAccountIds: readonly string[],
  atomically: AtomicLinkLifecycle = DEPLOYMENT_WIDE,
): Promise<EverywhereLinkResult> {
  if (authorizedFinancialAccountIds.length === 0) {
    return { observedLinkCount: 0, changedLinkCount: 0, affectedSpaceIds: [] };
  }
  const ids = [...authorizedFinancialAccountIds];

  return atomically(async (links) => {
    const observed = await links.findMany({
      where:  { financialAccountId: { in: ids }, status: ShareStatus.REVOKED },
      select: { spaceId: true },
    });

    const { count } = await links.updateMany({
      where: { financialAccountId: { in: ids }, status: ShareStatus.REVOKED },
      data:  { status: ShareStatus.ACTIVE, revokedAt: null, revokedByUserId: null },
    });

    return {
      observedLinkCount: observed.length,
      changedLinkCount:  count,
      affectedSpaceIds:  [...new Set(observed.map((l) => l.spaceId))],
    };
  });
}
