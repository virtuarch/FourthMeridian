/**
 * app/api/imports/[id]/rollback/route.ts
 *
 * id refers to an ImportBatch.id.
 *
 * POST — D2 Step 4D-3. Rolls back a completed CSV/Excel import batch:
 * soft-deletes every Transaction row the batch created and transitions
 * ImportBatch.status to ROLLED_BACK. Matched rows never carry importBatchId
 * (see app/api/accounts/[id]/import/route.ts's CREATE/MATCH branch — only
 * CREATE writes importBatchId) and are therefore never touched by this
 * route; rollback only ever removes rows a batch itself created.
 *
 * Implements the design in
 * docs/initiatives/d2/D2_STEP4D3_IMPORT_ROLLBACK_INVESTIGATION.md exactly:
 *   - The Transaction soft-delete is filtered by importBatchId +
 *     deletedAt: null only — never financialAccountId. An account merge
 *     (lib/accounts/reconcile.ts's mergeArchivedDuplicateIntoCanonical)
 *     re-points Transaction.financialAccountId without updating the
 *     ImportBatch's own financialAccountId, so a financialAccountId filter
 *     here would silently miss rows a merge already relocated. See §4 of
 *     the investigation doc.
 *   - No SpaceSnapshot regeneration — import/rollback never touches
 *     FinancialAccount.balance, the only field SpaceSnapshot derives from
 *     (lib/snapshots/regenerate.ts). See §11.
 *   - ImportBatch.completedAt and the rowCount/importedCount/matchedCount/
 *     skippedCount/failedCount counters are left untouched — they are
 *     immutable historical facts about what the import did, not live
 *     counters of what's currently still alive. See §7.
 *   - Only IMPORT_BATCH_ROLLED_BACK is added to AuditAction in this slice —
 *     IMPORT_BATCH_CREATED/COMPLETED are deliberately deferred. See §8.
 *
 * Authorization:
 *   - requireFreshUser() — this is a destructive, state-changing action;
 *     see lib/session.ts's doc comment on why sensitive actions should not
 *     trust the cached revocation check.
 *   - The caller's active Space (getSpaceContext()) must have an ACTIVE
 *     SpaceAccountLink for the batch's own financialAccountId — the same
 *     lookup POST .../accounts/[id]/import performs for the same id, just
 *     read from the batch row instead of a client-supplied path param. A
 *     batch in a Space the caller can't see returns the same 404 as a
 *     missing batch, so existence is never leaked.
 *   - The caller must be either the batch's own creator (createdByUserId)
 *     or a canManage (OWNER/ADMIN) member of that Space — undoing your own
 *     import is unrestricted; undoing someone else's requires management
 *     rights, since rollback can erase a different member's history in a
 *     shared Space.
 *
 * Status behavior:
 *   - Eligible source statuses: COMPLETED, COMPLETED_WITH_ERRORS, FAILED.
 *   - PENDING/PROCESSING are rejected with 409 — the batch hasn't started,
 *     or is still mid-run (see investigation doc §3 for the known
 *     PROCESSING-stuck-batch gap, pre-existing in 4D-1 and not addressed
 *     here).
 *   - Already ROLLED_BACK is an idempotent success, not an error — no
 *     second AuditLog row is written and no Transaction row is re-touched.
 *   - The status transition is claimed via a conditional updateMany (not a
 *     plain update) inside the transaction below, so two concurrent rollback
 *     requests for the same batch can never both "win" — whichever commits
 *     first flips the status; the second sees a non-eligible status and
 *     falls into the idempotent-success path.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshUser } from "@/lib/session";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { ShareStatus, ImportBatchStatus } from "@prisma/client";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

const ROLLBACK_ELIGIBLE_STATUSES: ImportBatchStatus[] = [
  ImportBatchStatus.COMPLETED,
  ImportBatchStatus.COMPLETED_WITH_ERRORS,
  ImportBatchStatus.FAILED,
];

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing import batch id" }, { status: 400 });

  const [user, err] = await requireFreshUser();
  if (err) return err;

  // ── Resolve the batch ─────────────────────────────────────────────────────
  const batch = await db.importBatch.findUnique({ where: { id } });
  if (!batch) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // ── Authorize: caller's active Space must have an ACTIVE SpaceAccountLink
  //    for the batch's own financialAccountId — same lookup
  //    POST .../accounts/[id]/import performs for the same FinancialAccount.
  //    A batch in a Space the caller can't see returns the same 404 as a
  //    missing batch, avoiding an existence-enumeration signal.
  const { spaceId, permissions } = await getSpaceContext();
  const link = await db.spaceAccountLink.findFirst({
    where:  { spaceId, financialAccountId: batch.financialAccountId, status: ShareStatus.ACTIVE },
    select: { id: true },
  });
  if (!link) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // ── Permission: the batch's own creator, or a canManage member ───────────
  const isCreator = batch.createdByUserId === user.id;
  if (!isCreator && !permissions.canManage) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Claim + soft-delete + audit, all-or-nothing ───────────────────────────
  const result = await db.$transaction(async (tx) => {
    const claim = await tx.importBatch.updateMany({
      where: { id: batch.id, status: { in: ROLLBACK_ELIGIBLE_STATUSES } },
      data:  { status: ImportBatchStatus.ROLLED_BACK },
    });

    if (claim.count === 0) {
      // Either already rolled back (idempotent success) or still
      // PENDING/PROCESSING (not eligible yet) — re-read to tell which.
      const current = await tx.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
      if (current.status === ImportBatchStatus.ROLLED_BACK) {
        return { kind: "already_rolled_back" as const, batch: current };
      }
      return { kind: "ineligible" as const, batch: current };
    }

    // This request won the claim — it is the one that performs the
    // soft-delete. Deliberately scoped by importBatchId + deletedAt: null
    // only, never financialAccountId — see module header.
    const softDeleted = await tx.transaction.updateMany({
      where: { importBatchId: batch.id, deletedAt: null },
      data:  { deletedAt: new Date() },
    });

    const updatedBatch = await tx.importBatch.findUniqueOrThrow({ where: { id: batch.id } });

    await tx.auditLog.create({
      data: {
        userId:    user.id,
        spaceId,
        action:    AuditAction.IMPORT_BATCH_ROLLED_BACK,
        metadata:  {
          importBatchId:      batch.id,
          financialAccountId: batch.financialAccountId,
          source:             batch.source,
          rolledBackCount:    softDeleted.count,
        },
        ipAddress: getClientIp(req),
      },
    });

    return { kind: "rolled_back" as const, batch: updatedBatch, rolledBackCount: softDeleted.count };
  });

  if (result.kind === "ineligible") {
    return NextResponse.json(
      {
        error: `Import batch is ${result.batch.status} and cannot be rolled back. Only COMPLETED, COMPLETED_WITH_ERRORS, or FAILED batches are eligible.`,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({
    importBatchId:     result.batch.id,
    status:            result.batch.status,
    rolledBackCount:   result.kind === "rolled_back" ? result.rolledBackCount : 0,
    alreadyRolledBack: result.kind === "already_rolled_back",
    rowCount:          result.batch.rowCount,
    importedCount:     result.batch.importedCount,
    matchedCount:      result.batch.matchedCount,
    skippedCount:      result.batch.skippedCount,
    failedCount:       result.batch.failedCount,
  });
}, "POST /api/imports/[id]/rollback");
