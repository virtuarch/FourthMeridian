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
 * D2 Step 4D-4 — QuickBooks update-on-match overwrites an existing
 * Transaction's allow-listed fields in place (see the confirm route's MATCH
 * branch); it never assigns importBatchId to the row it updates (only
 * CREATE does that). This rollback route's soft-delete, scoped to
 * importBatchId + deletedAt: null, was already structurally incapable of
 * reaching those rows before update-on-match existed — that fact doesn't
 * change here. Documenting it explicitly: rolling back a QuickBooks batch
 * that performed updates removes the rows it created, but leaves any
 * updated rows in their post-update state. There is no revert capability for
 * those overwrites — no snapshot table, no versioning, no schema change.
 * This is a known, accepted limitation (see
 * docs/initiatives/d2/implementation/D2_STEP4D4_QUICKBOOKS_IMPLEMENTATION_CHECKLIST.md §7),
 * not a gap introduced by this file.
 *
 * Implements the design in
 * docs/initiatives/d2/investigations/D2_STEP4D3_IMPORT_ROLLBACK_INVESTIGATION.md exactly:
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
 *   - The caller's active Space (getSpaceContext()) must resolve the batch's own
 *     financialAccountId through resolveImportableFinancialAccount — the SAME
 *     shared guard POST .../accounts/[id]/import and its four siblings use,
 *     just read from the batch row instead of a client-supplied path param. A
 *     batch in a Space the caller can't see returns the same 404 as a
 *     missing batch, so existence is never leaked.
 *
 *     RLS Slice 2 — THIS ROUTE HAD DRIFTED. It used to perform its own inline
 *     spaceAccountLink.findFirst({ spaceId, financialAccountId, status: ACTIVE
 *     }) and that query OMITTED the visibilityLevel FULL gate (and the
 *     financialAccount.deletedAt filter) which lib/imports/authorize.ts applies
 *     for every other import route. Rollback is the most destructive operation
 *     in the import feature — it soft-deletes every Transaction a batch
 *     created — yet it was the ONE import route an OWNER/ADMIN holding only a
 *     BALANCE_ONLY / SUMMARY_ONLY link could reach, erasing transaction detail
 *     they were never permitted to READ. Two copies of one authority rule is
 *     how that happens; there is now one copy. See
 *     docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md §17.1 item 7.
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
 *
 * RLS-C-S8 — THREE TENANT PHASES, AND WHY THREE AND NOT ONE.
 *
 *   1. RESOLVE the batch. A row this identity cannot see is now indistinguishable
 *      from a missing one AT THE DATABASE, not merely at the guard below. The
 *      `fm_app` policy on ImportBatch is `fm_account_visible("financialAccountId")`,
 *      which is strictly WIDER than this route's authorization rule (any Space the
 *      caller is an ACTIVE member of, vs. the active Space at FULL visibility with
 *      a permitted role), so the guard still decides and its 404/403 behaviour is
 *      unchanged. The database just stops being the thing that trusted us.
 *   2. CLAIM + soft-delete + audit, all-or-nothing. Unchanged in shape; it is the
 *      SAME transaction it always was, now opened by `withTenantDb` so the
 *      identity the policies read is bound transaction-locally for its duration.
 *   3. REPAIR, in its own phase, deliberately NOT folded into 2. The repair is
 *      best-effort and non-fatal by contract — a failure must never un-roll-back
 *      a completed rollback — and a failure inside phase 2 would do exactly that.
 *      Keeping it separate also keeps the destructive transaction short.
 *
 * `withTenantDb` is a SECURITY BOUNDARY, not a request-lifetime container. The
 * authorization read and the SyncIssue fallback both sit OUTSIDE every phase: the
 * first because `lib/imports/authorize.ts` is not yet converted, the second
 * because `fm_app` holds only a column-level READ grant on SyncIssue and a
 * telemetry write that failed inside a phase would abort the phase it was
 * reporting on. No phase here spans a provider call, a model call or streaming.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";
import { getSpaceContext } from "@/lib/space";
import { ImportBatchStatus, ImportBatchKind } from "@prisma/client";
import { resolveImportableFinancialAccount } from "@/lib/imports/authorize";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { rollbackInvestmentBatchRows, type InvestmentRollbackResult } from "@/lib/investments/investment-import-rollback";
import { repairReconstructionForAccount } from "@/lib/investments/reconstruction-runner";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";

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

  // ── Phase 1 — resolve the batch under the caller's own identity ───────────
  const batch = await withTenantDb(user.id, (tx) => tx.importBatch.findUnique({ where: { id } }));
  if (!batch) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // ── Authorize: the ONE shared import guard, never a second copy of it ─────
  //    resolveImportableFinancialAccount applies the full contract the other
  //    five import routes get: an ACTIVE, non-deleted-account SpaceAccountLink
  //    in the caller's active Space (404 otherwise — a batch in a Space the
  //    caller can't see is indistinguishable from a missing batch), then the
  //    write-authority check, with the FULL visibility tier required on the
  //    non-owner path. The inline lookup this replaces omitted that tier (see
  //    module header, RLS Slice 2).
  const { spaceId, permissions } = await getSpaceContext();
  const access = await resolveImportableFinancialAccount(
    user.id, spaceId, batch.financialAccountId);
  if (!access.ok) return access.response;

  // ── Permission: the batch's own creator, or a canManage member ───────────
  //    ADDITIONAL to the guard above, not a substitute for it: rollback can
  //    erase another member's history, so passing the import guard is necessary
  //    but not sufficient. Both must hold.
  const isCreator = batch.createdByUserId === user.id;
  if (!isCreator && !permissions.canManage) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Phase 2 — claim + soft-delete + audit, all-or-nothing ─────────────────
  const result = await withTenantDb(user.id, async (tx) => {
    const claim = await tx.importBatch.updateMany({
      where: { id: batch.id, status: { in: ROLLBACK_ELIGIBLE_STATUSES } },
      data:  { status: ImportBatchStatus.ROLLED_BACK },
    });

    if (claim.count === 0) {
      // Either already rolled back (idempotent success) or still
      // PENDING/PROCESSING (not eligible yet) — re-read to tell which.
      //
      // RLS-C-S8 — THIS ZERO IS DETERMINATE, AND BY DESIGN RATHER THAN BY LUCK.
      // S6a recorded that a zero-row conditional write under a tenant role is
      // INDETERMINATE unless the row's visibility was established in the same
      // phase, and noted that this site was already loud "by accident": the
      // re-read is `findUniqueOrThrow`, which RAISES on a row the policy hides.
      // It is kept, and it is kept in this exact form, because it is STRICTLY
      // STRONGER than `resolveConditionalWrite` here — one statement both
      // establishes visibility and discriminates the two business outcomes,
      // where the helper would add a second round trip and still need this read
      // afterwards. Converting it would be a regression dressed as consistency.
      // Do not replace it with `findUnique` + a null check: that is the exact
      // edit that turns a policy refusal back into "already rolled back".
      const current = await tx.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
      if (current.status === ImportBatchStatus.ROLLED_BACK) {
        return { kind: "already_rolled_back" as const, batch: current };
      }
      return { kind: "ineligible" as const, batch: current };
    }

    // This request won the claim — it is the one that performs the
    // soft-delete. Deliberately scoped by importBatchId + deletedAt: null
    // only, never financialAccountId — see module header.
    const now = new Date();
    // RLS-C-S8 — `rolledBackCount` is reported to the user, so it is measured
    // rather than trusted: observe the eligible rows through THIS authority, in
    // THIS phase, immediately before the statement, and refuse to report a
    // rollback that fell short of what it had just seen. One indexed count on the
    // rarest destructive path in the feature.
    //
    // ⚠️ RESIDUAL, RECORDED RATHER THAN HIDDEN. The `where` is deliberately
    // `importBatchId` only, never `financialAccountId` (see the module header: a
    // merge re-points Transaction.financialAccountId without updating the
    // batch's). The policy, however, IS keyed on financialAccountId — so a row a
    // merge relocated onto an account outside the caller's visible set is absent
    // from the observation and from the write alike, and no shortfall can be
    // raised for it. Establishing a batch's TRUE population needs an authority
    // that can see all of it; that reconciliation is named as a follow-up and is
    // not silently assumed away here.
    const eligibleTransactions = await tx.transaction.count({
      where: { importBatchId: batch.id, deletedAt: null },
    });
    const softDeleted = await tx.transaction.updateMany({
      where: { importBatchId: batch.id, deletedAt: null },
      data:  { deletedAt: now },
    });
    assertEveryObservedRowWasWritten(
      { table: "Transaction", operation: "update", scope: "one import batch's live rows" },
      eligibleTransactions,
      softDeleted.count,
    );

    // A7-5 — INVESTMENT_HISTORY batches additionally soft-delete their
    // InvestmentEvent / PositionObservation rows and un-supersede the assertions
    // they had outranked. Banking (TRANSACTIONS) batches skip this entirely, so
    // their rollback stays byte-identical.
    const investment: InvestmentRollbackResult | null =
      batch.kind === ImportBatchKind.INVESTMENT_HISTORY
        ? await rollbackInvestmentBatchRows(tx, batch.id, now)
        : null;

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
          ...(investment
            ? { investmentEventsRolledBack: investment.eventsDeleted, positionObservationsRolledBack: investment.observationsDeleted, supersessionPointersCleared: investment.pointersCleared }
            : {}),
        },
        ipAddress: getClientIp(req),
      },
    });

    return { kind: "rolled_back" as const, batch: updatedBatch, rolledBackCount: softDeleted.count, investment };
  });

  // ── Bounded reconstruction repair (outside the tx, non-fatal) ──────────────
  //    Residuals re-widen through gatherReconstructionInputs' deletedAt/
  //    superseded filters with zero core changes. Never fails the rollback.
  if (result.kind === "rolled_back" && result.investment) {
    try {
      // Phase 3 — its own tenant phase, so the repair's per-account instrument
      // set stays atomic (reconstructAccount joins THIS transaction rather than
      // opening its own) without putting a best-effort write inside the
      // destructive one.
      await withTenantDb(user.id, (tx) => repairReconstructionForAccount(tx, {
        financialAccountId: batch.financialAccountId,
        affectedInstrumentIds: result.investment!.affectedInstrumentIds,
        affectedCash: result.investment!.affectedCash,
        now: new Date(),
      }));
    } catch (e) {
      console.warn(`[import-rollback] reconstruction repair for account ${batch.financialAccountId} failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      await recordSyncIssue({ kind: "IMPORT_ROLLBACK_FAILED", financialAccountId: batch.financialAccountId, detail: { stage: "import-rollback-repair", importBatchId: batch.id, error: e instanceof Error ? e.message : String(e) } });
    }
  }

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
    ...(result.kind === "rolled_back" && result.investment
      ? {
          investmentEventsRolledBack:     result.investment.eventsDeleted,
          positionObservationsRolledBack: result.investment.observationsDeleted,
          supersessionPointersCleared:    result.investment.pointersCleared,
        }
      : {}),
  });
}, "POST /api/imports/[id]/rollback");
