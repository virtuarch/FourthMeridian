/**
 * POST /api/accounts/[id]/import  — CSV / XLSX banking import.
 *
 * ── IDEMP-001 / SEC-007 / OPS-007 (2026-10-22) ────────────────────────────────
 * The runtime audit submitted one 6-row file twice concurrently and got 12
 * rows (both 201, two COMPLETED batches): the fingerprint dedupe is a READ, so
 * two overlapping requests never saw each other. A simulated crash left a
 * PROCESSING batch the rollback route refused (409) with its rows live. The
 * route had no maxDuration and no caps.
 *
 * The order now:
 *   1. authorize the account (unchanged);
 *   2. read the upload — refuse over IMPORT_MAX_BYTES (413) BEFORE hashing;
 *   3. CLAIM: create the ImportBatch (PENDING) with sha256(bytes). The partial
 *      unique index ImportBatch_account_file_live_key refuses a second live
 *      batch for the same account + file ⇒ 409 with the existing batch id;
 *   4. parse; refuse over IMPORT_MAX_ROWS (400) — the claimed batch is marked
 *      FAILED so the slot frees (FAILED is outside the index predicate);
 *   5. write rows in CHUNKS: each chunk of IMPORT_CHUNK_ROWS runs inside ONE
 *      tenant phase (fast path). A chunk that throws is re-run row by row with
 *      the original per-row tenant phases, so one bad row still only costs
 *      that row (the fallback path is the pre-remediation loop, verbatim);
 *   6. complete the batch (unchanged); a batch whose lambda died stays
 *      PROCESSING and becomes rollback-eligible after the budget
 *      (lib/imports/claim.ts rollbackClaimWhere).
 *
 * `maxDuration = 300` matches the dispatcher's budget. Reads go through the
 * tenant client only (no `@/lib/db` here — RLS-PREP-C).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { createNotification } from "@/lib/notifications/create";
import { getSpaceContext } from "@/lib/space";
import { ImportBatchStatus, ImportSource, Prisma, type CategorySource } from "@prisma/client";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import {
  resolveFingerprintOutcome,
  computeQuickBooksUpdateDiff,
  type SignConvention,
  type SavedMappingProfileLite,
  type NormalizedTransaction,
} from "@/lib/imports/csv";
import { runImportPipeline } from "@/lib/imports/pipeline";
import { resolveImportableFinancialAccount } from "@/lib/imports/authorize";
import {
  claimImportBatch, findLiveImportBatch, chunkRows, sha256Hex, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS,
} from "@/lib/imports/claim";
import { withTenantDb, type TenantClient } from "@/lib/db/tenant-context";
import { getImportProviderCapabilities } from "@/lib/imports/provider-capabilities";
import { classifyFlow, FLOW_CLASSIFIER_VERSION } from "@/lib/transactions/flow-classifier";
import { buildFlowInputFromRow, buildFlowWriteFields } from "@/lib/transactions/plaid-flow-input";
import { mayWriteFlow } from "@/lib/transactions/flow-authority";
import { resolveLiabilityPaymentCategory } from "@/lib/transactions/liability-payment";
import { resolvePayrollIncomeCategory } from "@/lib/transactions/descriptor-evidence";
import { buildTransactionFacts } from "@/lib/transactions/transaction-facts";
import { resolveMerchantWrite } from "@/lib/transactions/merchant-write";
import { economicDateFor } from "@/lib/transactions/economic-date-write";
import { recordTransactionObservation } from "@/lib/transactions/event-write";

export const maxDuration = 300;

/** A tenant phase runner: the per-row fallback passes `tenant`; the chunk fast path passes `(fn) => fn(tx)`. */
type Run = <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;

interface RowTally {
  created: number;
  matched: number;
  skipped: number;
  failed: number;
  errors: { row: number; reason: string }[];
  updatedTransactionIds: string[];
}
const emptyTally = (): RowTally => ({ created: 0, matched: 0, skipped: 0, failed: 0, errors: [], updatedTransactionIds: [] });
function mergeTally(into: RowTally, from: RowTally): void {
  into.created += from.created; into.matched += from.matched; into.skipped += from.skipped; into.failed += from.failed;
  into.errors.push(...from.errors); into.updatedTransactionIds.push(...from.updatedTransactionIds);
}

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id; // captured: closures below lose the narrowing

  const { spaceId } = await getSpaceContext();

  const access = await withTenantDb(
    user.id, (tx) => resolveImportableFinancialAccount(tx, user.id, spaceId, id));
  if (!access.ok) return access.response;
  const { financialAccountId } = access;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with a file field." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file." }, { status: 400 });
  }

  // ── 2. Byte cap BEFORE the bytes are read into memory for hashing ──────────
  if (file.size > IMPORT_MAX_BYTES) {
    return NextResponse.json(
      { error: `File is too large to import (limit ${Math.floor(IMPORT_MAX_BYTES / (1024 * 1024))} MB).` },
      { status: 413 },
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > IMPORT_MAX_BYTES) {
    return NextResponse.json({ error: "File is too large to import." }, { status: 413 });
  }
  const fileSha256 = sha256Hex(bytes);

  const signConventionRaw = formData.get("signConvention");
  const signConvention: SignConvention =
    signConventionRaw === "debitPositive" ? "debitPositive" : "creditPositive";

  const sourceRaw = formData.get("source");
  const sourceOverride: ImportSource | undefined =
    sourceRaw === "QUICKBOOKS" ? ImportSource.QUICKBOOKS : undefined;

  const columnMappingRaw = formData.get("columnMapping");
  let explicitMapping: Record<string, string | null | undefined> | undefined;
  if (typeof columnMappingRaw === "string" && columnMappingRaw.trim() !== "") {
    let parsedMapping: unknown;
    try {
      parsedMapping = JSON.parse(columnMappingRaw);
    } catch {
      return NextResponse.json({ error: "Could not parse columnMapping as JSON." }, { status: 400 });
    }
    if (typeof parsedMapping !== "object" || parsedMapping === null || Array.isArray(parsedMapping)) {
      return NextResponse.json({ error: "columnMapping must be a JSON object." }, { status: 400 });
    }
    for (const value of Object.values(parsedMapping as Record<string, unknown>)) {
      if (value !== null && value !== undefined && typeof value !== "string") {
        return NextResponse.json(
          { error: "columnMapping values must be strings or null." },
          { status: 400 }
        );
      }
    }
    explicitMapping = parsedMapping as Record<string, string | null | undefined>;
  }

  const tenant = <T,>(fn: (tx: TenantClient) => Promise<T>) => withTenantDb(user.id, fn);

  // ── 3. CLAIM the (account, file) slot BEFORE parsing ───────────────────────
  // The provisional source mirrors the pipeline's own detection (an .xlsx is
  // EXCEL, anything else CSV, QUICKBOOKS when the client says so); the parsed
  // source is written back at completion.
  const provisionalSource = sourceOverride
    ?? ((file.name || "").toLowerCase().endsWith(".xlsx") ? ImportSource.EXCEL : ImportSource.CSV);
  const claim = await tenant((tx) => claimImportBatch(tx, {
    financialAccountId,
    createdByUserId:  user.id,
    source:           provisionalSource,
    originalFilename: file.name || null,
    fileSha256,
  }));
  if (!claim.ok) {
    // J-D6 — the losing claim's transaction is aborted by the unique violation,
    // so the winner is read in a fresh phase. Best-effort: the 409 stands even
    // if this read fails.
    const existing = await tenant((tx) => findLiveImportBatch(tx, { financialAccountId, fileSha256 })).catch(() => null);
    return NextResponse.json(
      {
        error:         "duplicate-import",
        message:       "This file has already been imported into this account. Roll back the earlier import to import it again.",
        importBatchId: existing?.id ?? null,
        status:        existing?.status ?? null,
      },
      { status: 409 },
    );
  }
  const batchId = claim.batchId;
  const failBatch = (reason: string) => tenant((tx) => tx.importBatch.update({
    where: { id: batchId },
    data:  { status: ImportBatchStatus.FAILED, errorSummary: [{ row: 0, reason }], completedAt: new Date() },
  })).catch((e) => console.error(`[import] batch ${batchId} could not be marked FAILED:`, e));

  // ── 4. Parse, then the row cap ─────────────────────────────────────────────
  const savedProfileRows = await tenant((tx) => tx.importMappingProfile.findMany({
    where:   { spaceId },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select:  { id: true, mapping: true },
  }));
  const savedProfilesLite: SavedMappingProfileLite[] = savedProfileRows.map((p) => ({
    id:      p.id,
    mapping: p.mapping as Record<string, string | null>,
  }));

  const pipelineResult = await runImportPipeline(new File([bytes], file.name, { type: file.type }), {
    signConvention,
    explicitMapping,
    savedProfiles: savedProfilesLite,
    sourceOverride,
  });
  if ("error" in pipelineResult) {
    await failBatch(pipelineResult.error);
    return NextResponse.json({ error: pipelineResult.error }, { status: 400 });
  }
  const { source, rows, resolvedColumnMapping, matchedProfileId } = pipelineResult;
  if (rows.length > IMPORT_MAX_ROWS) {
    const reason = `File has ${rows.length} rows; the limit is ${IMPORT_MAX_ROWS} per import. Split the file and import the parts.`;
    await failBatch(reason);
    return NextResponse.json({ error: reason }, { status: 400 });
  }

  const flowAcct = await tenant(async (tx) => {
    await tx.importBatch.update({
      where: { id: batchId },
      data: {
        source,
        status:                ImportBatchStatus.PROCESSING,
        rowCount:              rows.length,
        resolvedColumnMapping: resolvedColumnMapping as unknown as Prisma.InputJsonValue,
        mappingProfileId:      matchedProfileId,
      },
    });
    return tx.financialAccount.findUnique({
      where:  { id: financialAccountId },
      select: { type: true, debtSubtype: true, currency: true },
    });
  });
  const batch = { id: batchId };

  const flowAccountContext = {
    accountType: (flowAcct?.type as string | null) ?? null,
    debtSubtype: flowAcct?.debtSubtype ?? null,
  };
  function computeFlowFields(rowLike: {
    category:           string;
    amount:             number;
    pfcPrimary:         string | null;
    pfcDetailed:        string | null;
    pfcConfidenceLevel: string | null;
    merchantEntityId:   string | null;
  }) {
    const { input, captured } = buildFlowInputFromRow(rowLike, flowAccountContext);
    return buildFlowWriteFields(classifyFlow(input), input, captured, FLOW_CLASSIFIER_VERSION);
  }
  function computeFactFields(rowCurrency: string | null) {
    const facts = buildTransactionFacts({
      captured:        { pfcConfidenceLevel: null, merchantEntityId: null, counterparties: [] },
      pending:         false,
      rowCurrency,
      accountCurrency: flowAcct?.currency ?? null,
    });
    return { ...facts, paymentMethod: null };
  }

  /**
   * ONE row, against whichever phase runner the caller supplies. On the fast
   * path `run` is the chunk's shared tenant transaction; on the fallback path
   * it is `tenant` (a phase per write, the pre-remediation shape). A thrown
   * error propagates to the caller, which decides what isolation it buys.
   */
  async function importRow(run: Run, row: NormalizedTransaction, tally: RowTally): Promise<void> {
    const lineNumber = row.lineNumber; // data-row index, 1-indexed, header row excluded
    if (row.error || !row.date || row.amount === null || !row.merchant) {
      tally.failed++;
      tally.errors.push({ row: lineNumber, reason: row.error ?? "missing required field" });
      return;
    }
    const vrow = { ...row, date: row.date, amount: row.amount, merchant: row.merchant };
    const paymentRescuedCategory = resolveLiabilityPaymentCategory(vrow.category, "Payment", {
      ...flowAccountContext,
      amount:      vrow.amount,
      merchant:    vrow.merchant,
      description: vrow.description,
    });
    const rescuedCategory = resolvePayrollIncomeCategory(paymentRescuedCategory, "Income", {
      amount:      vrow.amount,
      merchant:    vrow.merchant,
      description: vrow.description,
    });

    const result = await run((tx) => resolveFingerprintOutcome(
      financialAccountId,
      vrow.date,
      vrow.amount,
      vrow.merchant,
      vrow.externalTransactionId,
      vrow.description, // DF-4 — fingerprint on the raw descriptor
      tx,
    ));

    if (result.outcome === "CREATE") {
      let finalCategory: typeof vrow.category = rescuedCategory;
      let finalFlow = computeFlowFields({
        category:           rescuedCategory,
        amount:             vrow.amount,
        pfcPrimary:         null,
        pfcDetailed:        null,
        pfcConfidenceLevel: null,
        merchantEntityId:   null,
      });
      const mi: { merchantId?: string; categorySource?: CategorySource; categoryRuleId?: string } = {};
      try {
        const miResult = await run((tx) => resolveMerchantWrite(tx, {
          merchant:        vrow.merchant,
          description:     vrow.description,
          currentCategory: rescuedCategory,
          ownerUserId:     userId,
        }));
        if (miResult.setMerchantId && miResult.merchantId) mi.merchantId = miResult.merchantId;
        if (miResult.category) {
          finalCategory = miResult.category;
          finalFlow = computeFlowFields({
            category: finalCategory, amount: vrow.amount,
            pfcPrimary: null, pfcDetailed: null, pfcConfidenceLevel: null, merchantEntityId: null,
          });
          mi.categorySource = "USER_RULE";
          if (miResult.categoryRuleId) mi.categoryRuleId = miResult.categoryRuleId;
        } else if (miResult.categorySource) {
          mi.categorySource = miResult.categorySource;
        }
      } catch (miErr) {
        console.warn(`[merchant-intelligence] import resolution skipped for row ${lineNumber} — writing null MI columns:`, miErr);
      }

      const createdRow = await run((tx) => tx.transaction.create({
        data: {
          financialAccountId,
          date:                  vrow.date,
          economicDate:          economicDateFor({ postingDate: vrow.date, authorizedAt: null }),
          merchant:              vrow.merchant,
          description:           vrow.description,
          category:              finalCategory,
          amount:                vrow.amount,
          pending:               false,
          externalTransactionId: vrow.externalTransactionId,
          importBatchId:         batch.id, // only set on rows this batch creates — never on MATCH
          currency:              flowAcct?.currency ?? null,
          ...finalFlow,
          ...computeFactFields(flowAcct?.currency ?? null),
          ...mi,
        },
        select: { id: true },
      }));
      try {
        await run((tx) => recordTransactionObservation(tx, {
          transactionId:      createdRow.id,
          financialAccountId,
          provider:           "CSV",
          providerRowId:      vrow.externalTransactionId ?? null,
          providerPendingRef: null,
          lifecycle:          "POSTED",
          amount:             vrow.amount,
          postingDate:        vrow.date,
          economicDate:       economicDateFor({ postingDate: vrow.date, authorizedAt: null }),
          authorizedAt:       null,
          transactionIsLive:  true,
          observedAt:         new Date(),
        }));
      } catch (e) {
        console.warn(`[l8] observation skipped for imported row ${lineNumber} — event identity is additive and non-blocking:`, e);
      }
      tally.created++;
    } else if (result.outcome === "MATCH") {
      tally.matched++;
      if (getImportProviderCapabilities(source).supportsUpdateOnMatch && result.matchedVia === "externalId") {
        const matchedId = result.transactionId;
        const didUpdate = await run(async (tx) => {
          const existing = await tx.transaction.findUnique({
            where:  { id: matchedId },
            select: {
              date: true, amount: true, merchant: true, description: true, category: true,
              pfcPrimary: true, pfcDetailed: true, pfcConfidenceLevel: true, merchantEntityId: true,
              currency: true,
              flowAuthority: true,
            },
          });
          if (!existing) return false;
          const diff = computeQuickBooksUpdateDiff(existing, {
            date:        vrow.date,
            amount:      vrow.amount,
            merchant:    vrow.merchant,
            description: vrow.description,
            category:    rescuedCategory,
          });
          if (!diff) return false;
          const flowFields = mayWriteFlow(existing.flowAuthority, "CLASSIFIER").allowed
            ? computeFlowFields({
                category:           rescuedCategory,
                amount:             vrow.amount,
                pfcPrimary:         existing.pfcPrimary,
                pfcDetailed:        existing.pfcDetailed,
                pfcConfidenceLevel: existing.pfcConfidenceLevel,
                merchantEntityId:   existing.merchantEntityId,
              })
            : {};
          await tx.transaction.update({
            where: { id: matchedId },
            data:  { ...diff, ...flowFields, ...computeFactFields(existing.currency ?? flowAcct?.currency ?? null), currency: existing.currency ?? flowAcct?.currency ?? null },
          });
          return true;
        });
        if (didUpdate) tally.updatedTransactionIds.push(matchedId);
      }
    } else {
      tally.skipped++;
      tally.errors.push({ row: lineNumber, reason: result.reason });
    }
  }

  // ── 5. Chunked write: one tenant phase per chunk, per-row fallback ─────────
  const total = emptyTally();
  for (const chunk of chunkRows(rows)) {
    const fast = emptyTally();
    try {
      await tenant(async (tx) => {
        const inTx: Run = (fn) => fn(tx);
        for (const row of chunk) await importRow(inTx, row, fast);
      });
      mergeTally(total, fast);
      continue;
    } catch (chunkErr) {
      // The chunk's transaction rolled back: none of its rows exist. Re-run
      // the chunk one row at a time, each phase its own tenant transaction, so
      // a refusal on one row looks like a bad row and costs only that row.
      console.warn(`[import] batch ${batch.id}: chunk of ${chunk.length} rows fell back to per-row writes:`, chunkErr);
    }
    const slow = emptyTally();
    for (const row of chunk) {
      try {
        await importRow(tenant, row, slow);
      } catch (rowErr) {
        slow.failed++;
        slow.errors.push({ row: row.lineNumber, reason: "unexpected error writing row" });
        console.error(`[import] batch ${batch.id} row ${row.lineNumber} failed:`, rowErr);
      }
    }
    mergeTally(total, slow);
  }
  const { created, matched, skipped, failed, errors, updatedTransactionIds } = total;

  // ── 6. Complete ────────────────────────────────────────────────────────────
  const finalStatus = failed > 0 ? ImportBatchStatus.COMPLETED_WITH_ERRORS : ImportBatchStatus.COMPLETED;
  const updated = await tenant((tx) => tx.importBatch.update({
    where: { id: batch.id },
    data: {
      importedCount: created,
      matchedCount:  matched,
      skippedCount:  skipped,
      failedCount:   failed,
      errorSummary:  errors.length > 0 ? errors : undefined,
      status:        finalStatus,
      completedAt:   new Date(),
    },
  }));

  await createNotification(
    finalStatus === ImportBatchStatus.COMPLETED_WITH_ERRORS
      ? {
          type: "IMPORT_COMPLETED_WITH_ERRORS",
          userId: user.id,
          data: { batchId: batch.id, errorCount: failed, rowCount: created },
        }
      : {
          type: "IMPORT_COMPLETED",
          userId: user.id,
          data: { batchId: batch.id, rowCount: created },
        },
  );

  if (updatedTransactionIds.length > 0) {
    try {
      await tenant((tx) => tx.auditLog.create({
        data: {
          userId:    user.id,
          spaceId,
          action:    AuditAction.IMPORT_BATCH_UPDATED_ON_MATCH,
          metadata:  {
            importBatchId: batch.id,
            financialAccountId,
            updatedTransactionIds,
          },
          ipAddress: getClientIp(req),
        },
      }));
    } catch (auditErr) {
      console.error(
        `[import] batch ${batch.id} failed to write update-on-match audit log:`,
        auditErr
      );
    }
  }

  if (matchedProfileId) {
    try {
      await tenant((tx) => tx.importMappingProfile.update({
        where: { id: matchedProfileId },
        data:  { useCount: { increment: 1 }, lastUsedAt: new Date() },
      }));
    } catch (profileErr) {
      console.error(
        `[import] batch ${batch.id} failed to bump mapping profile ${matchedProfileId} usage:`,
        profileErr
      );
    }
  }

  return NextResponse.json(
    {
      importBatchId: updated.id,
      status:        updated.status,
      rowCount:      updated.rowCount,
      importedCount: updated.importedCount,
      matchedCount:  updated.matchedCount,
      skippedCount:  updated.skippedCount,
      failedCount:   updated.failedCount,
      errorSummary:  updated.errorSummary,
    },
    { status: 201 }
  );
}, "POST /api/accounts/[id]/import");
