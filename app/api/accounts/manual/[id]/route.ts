/**
 * PATCH /api/accounts/manual/[id]
 *
 * Updates the balance of a manually-entered asset account (syncStatus='manual').
 * Plaid-synced accounts are explicitly rejected — they update via the sync job.
 *
 * Body: { balance: number }
 *
 * Returns: { accountId, balance, lastUpdated }
 *
 * ── RLS-ACC-S3 — DELETE HAD THE DEFECT RLS-C-S7 FIXED NEXT DOOR ──────────────
 * `DELETE` revoked EVERY `SpaceAccountLink` pointing at the account with a bare
 * `db.spaceAccountLink.updateMany({ where: { financialAccountId: id } })` whose
 * count was DISCARDED. That is the identical defect b42e8e0 fixed in
 * `lib/accounts/disconnect.ts` and did not fix here, and it is the quietest
 * failure this programme has on record.
 *
 * `SpaceAccountLink.fm_app_sel` is `spaceId IN (SELECT fm_visible_space_ids())`.
 * A manual asset can be shared into several Spaces, and `POST /api/accounts/manual`
 * accepts a `spaceIds` list that does exactly that. So under the tenant role a
 * co-owner's link in a Space the actor has since left is INVISIBLE, the revoke
 * lands on one row of two, and NOTHING IS RAISED — `updateMany` just returns a
 * smaller count, into a variable nobody reads. A ZERO at least looks like nothing
 * happened. **1-of-2 looks exactly like success**, and the co-owner's Space is
 * then left holding an ACTIVE link to a soft-deleted account: it keeps narrating
 * a balance for an asset that no longer exists.
 *
 * The blast radius is deployment-wide, so the authority follows it: the link
 * write goes through `revokeAccountLinksEverywhere`
 * (lib/accounts/links-everywhere.ts), the ONE narrow `fm_system` opening, and the
 * shortfall is asserted with `assertEveryObservedRowWasWritten`. Authorization
 * happens FIRST, in a tenant phase, and the capability is handed only
 * `provenId` — a value computed inside that callback, never the path parameter.
 *
 * ⚠️ NOT `resolveConditionalWrite`. Its probe conflates "the policy hid the row"
 * with "the row is gone", and for an idempotent revoke the second is EXPECTED —
 * a repeat delete legitimately finds nothing to revoke. The bulk question is the
 * different and cheaper one: did I write every row I had already SEEN? That is
 * what the capability's observe-then-write pair answers, and the observation is
 * the GUARD, not an optimisation.
 *
 * ── AND THE ORDER WAS THE ONE RLS REFUSES, WHICH IS A SECOND FINDING ─────────
 * The route revoked the links FIRST and soft-deleted the `AccountConnection`
 * rows SECOND. `AccountConnection.fm_app_upd` is
 * `USING (fm_account_visible("financialAccountId"))`, true only while an ACTIVE
 * link exists in a visible Space — so once the links are revoked those rows are
 * invisible and their soft-delete is REFUSED SILENTLY (`updateMany` → count 0,
 * no error, no log). RLS-C-S7 recorded this exact ordering rule for disconnect:
 * CONNECTIONS FIRST, LINKS LAST. This route is a third site with the same shape
 * and it is now ordered the same way, with the same shortfall assertion on the
 * connection soft-delete.
 *
 * Deliberately NOT changed, so nobody re-derives it:
 *   · the revoke now filters `status: ACTIVE` (the capability does), where the
 *     old statement had NO status filter and re-stamped already-REVOKED links
 *     with a fresh `revokedAt` and a new `revokedByUserId`. That is a narrowing
 *     and it is the correct semantics — a revocation that already happened was
 *     not performed by this actor at this instant — and it matches
 *     `disconnect.ts`.
 *   · this route still does NOT regenerate the affected Spaces' snapshots.
 *     `disconnectAccounts` does; the manual-asset delete never has. The
 *     capability now RETURNS `affectedSpaceIds`, including Spaces the actor
 *     cannot see, so the information exists — but starting to regenerate them
 *     here would change product behaviour as a side effect of an authority
 *     migration, which is the drift this programme exists to prevent. Reported
 *     as a follow-up instead.
 */

import { NextRequest, NextResponse }   from "next/server";
import { requireUser }                 from "@/lib/session";
import { withTenantDb }                from "@/lib/db/tenant-context";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";
import { revokeAccountLinksEverywhere } from "@/lib/accounts/links-everywhere";
import { withApiHandler, getClientIp } from "@/lib/api";

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const body = await req.json() as { balance?: number };
  const { balance } = body;

  if (balance === undefined || balance === null)
    return NextResponse.json({ error: "balance is required" }, { status: 400 });
  if (typeof balance !== "number" || isNaN(balance) || balance < 0)
    return NextResponse.json({ error: "balance must be a non-negative number" }, { status: 400 });

  // ── Fetch + validate + write, as ONE short tenant phase ───────────────────
  // `FinancialAccount.fm_app_upd` admits `ownerUserId = me OR fm_account_visible(id)`
  // on both USING and WITH CHECK, so the owner arm carries this write even for an
  // account whose every link has been revoked — the pivot has that arm precisely
  // so an owner never loses their own account.
  const outcome = await withTenantDb(userId, async (tx) => {
    const fa = await tx.financialAccount.findUnique({
      where: { id },
      select: { id: true, ownerUserId: true, syncStatus: true, deletedAt: true },
    });

    if (!fa || fa.deletedAt) return { kind: "notFound" as const };
    if (fa.ownerUserId !== userId) return { kind: "forbidden" as const };
    if (fa.syncStatus !== "manual") return { kind: "notManual" as const };

    const updated = await tx.financialAccount.update({
      where: { id },
      data:  { balance, lastUpdated: new Date() },
      select: { id: true, balance: true, lastUpdated: true },
    });

    await tx.auditLog.create({
      data: {
        userId,
        action:    "MANUAL_ASSET_UPDATE",
        metadata:  { accountId: id, balance },
        ipAddress: getClientIp(req),
      },
    });

    return { kind: "ok" as const, updated };
  });

  if (outcome.kind === "notFound") {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (outcome.kind === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (outcome.kind === "notManual") {
    return NextResponse.json(
      { error: "Only manually-entered accounts can have their balance updated this way." },
      { status: 400 }
    );
  }

  return NextResponse.json({
    accountId:   outcome.updated.id,
    balance:     outcome.updated.balance,
    lastUpdated: outcome.updated.lastUpdated,
  });
}, "PATCH /api/accounts/manual/[id]");

// ─── DELETE ───────────────────────────────────────────────────────────────────

/**
 * DELETE /api/accounts/manual/[id]
 *
 * Soft-deletes a manually-entered asset account (syncStatus='manual', type='other').
 * Plaid-synced accounts are explicitly rejected.
 *
 * Actions (in order — and the order is POLICY-FORCED, see the module header):
 *   1. Verify caller owns the account, on the tenant role
 *   2. Verify type === 'other' && syncStatus === 'manual'
 *   3. Soft-delete the FinancialAccount (deletedAt = now)
 *   4. Soft-delete all AccountConnection rows (deletedAt = now) — BEFORE the
 *      links, because revoking first makes these rows invisible and their
 *      soft-delete is then refused silently
 *   5. Revoke every SpaceAccountLink, IN EVERY SPACE, through the one narrow
 *      deployment-wide capability, asserting no row was left behind
 *   6. Audit log
 *
 * Returns: { ok: true, accountId }
 */
export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const now = new Date();

  // ── PHASE 1 — THE TENANT PHASE: prove ownership, then close the subtree ───
  // The proof must be a TENANT read. It is the gate in front of a
  // deployment-wide link revocation, and a check that cannot see the row it is
  // checking is not a check.
  const gated = await withTenantDb(userId, async (tx) => {
    const fa = await tx.financialAccount.findUnique({
      where:  { id },
      select: { id: true, name: true, ownerUserId: true, type: true, syncStatus: true, deletedAt: true },
    });

    if (!fa || fa.deletedAt) return { kind: "notFound" as const };
    if (fa.ownerUserId !== userId) return { kind: "forbidden" as const };
    if (fa.type !== "other") return { kind: "notAsset" as const };
    if (fa.syncStatus !== "manual") return { kind: "notManual" as const };

    // `provenId` is computed INSIDE this callback from a read that required
    // OWNERSHIP, not from the path parameter. It is the only thing the
    // deployment-wide capability below is given.
    const provenId = fa.id;

    // ── 1. Soft-delete the FinancialAccount ─────────────────────────────────
    await tx.financialAccount.update({
      where: { id: provenId },
      data:  { deletedAt: now },
    });

    // ── 2. Soft-delete AccountConnection rows — BEFORE the link revoke ──────
    // Observed first, in this same phase, so the write's count means something:
    // a deficit is a refused row, not an absence of work. (The observation IS
    // the guard — delete it because "the updateMany's where already says that"
    // and a partial write becomes indistinguishable from a complete one.)
    const liveConns = await tx.accountConnection.findMany({
      where:  { financialAccountId: provenId, deletedAt: null },
      select: { id: true },
    });
    const closed = await tx.accountConnection.updateMany({
      where: { financialAccountId: provenId, deletedAt: null },
      data:  { deletedAt: now },
    });
    assertEveryObservedRowWasWritten(
      { table: "AccountConnection", operation: "update", scope: "1 authorized account id" },
      liveConns.length,
      closed.count,
    );

    return { kind: "ok" as const, provenId, name: fa.name };
  });

  if (gated.kind === "notFound") {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (gated.kind === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (gated.kind === "notAsset") {
    return NextResponse.json(
      { error: "Only asset accounts (type=other) can be deleted this way." },
      { status: 400 }
    );
  }
  if (gated.kind === "notManual") {
    return NextResponse.json(
      { error: "Only manually-entered accounts can be deleted this way." },
      { status: 400 }
    );
  }

  // ── PHASE 2 — THE DEPLOYMENT-WIDE REVOKE ──────────────────────────────────
  // Every ACTIVE link to this account, in EVERY Space, including ones the actor
  // is not a member of — which is the only coherent meaning this operation has,
  // and the thing a tenant client cannot express. A shortfall is not contention
  // and not idempotence: the links were observed eligible one statement earlier
  // under this very authority, so fewer writes than observations is a defect.
  const revocation = await revokeAccountLinksEverywhere([gated.provenId], userId, now);
  assertEveryObservedRowWasWritten(
    { table: "SpaceAccountLink", operation: "update", scope: "1 authorized account id" },
    revocation.observedLinkCount,
    revocation.changedLinkCount,
  );

  // ── PHASE 3 — Audit log ───────────────────────────────────────────────────
  await withTenantDb(userId, (tx) => tx.auditLog.create({
    data: {
      userId,
      action:    "MANUAL_ASSET_DELETE",
      metadata:  { accountId: gated.provenId, name: gated.name },
      ipAddress: getClientIp(req),
    },
  }));

  return NextResponse.json({ ok: true, accountId: gated.provenId });
}, "DELETE /api/accounts/manual/[id]");
