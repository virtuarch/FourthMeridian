/**
 * app/api/accounts/[id]/import/route.ts
 *
 * id refers to a FinancialAccount.id.
 *
 * POST — D2 Step 4D-1 CSV import MVP. Accepts a CSV file (multipart/form-data),
 * parses + classifies each row against existing Transaction history, and
 * writes an ImportBatch + any newly-created Transaction rows.
 *
 * Body (multipart/form-data):
 *   file:           File   — required, the CSV to import
 *   signConvention: string — optional, "creditPositive" (default) | "debitPositive"
 *                    Only used when the file has a single signed Amount
 *                    column (not a Debit/Credit pair, which is
 *                    sign-unambiguous). "creditPositive" matches this app's
 *                    own convention (positive = money in) — see
 *                    lib/plaid/syncTransactions.ts's sign-flip comment.
 *
 * Per-row outcome (see lib/imports/csv.ts for the classification logic):
 *   CREATED — no existing match found; a new Transaction was written.
 *   MATCHED — resolved to an already-existing Transaction (exact
 *             externalTransactionId, or an unambiguous fingerprint match).
 *             No write — the existing row (possibly Plaid-sourced) is left
 *             untouched.
 *   SKIPPED — ambiguous fingerprint match (more than one existing row could
 *             be "the same" transaction). Recorded in errorSummary.
 *   FAILED  — row could not be parsed (bad date/amount, missing
 *             merchant/description). Recorded in errorSummary.
 *
 * Explicitly out of scope for this slice (see
 * docs/initiatives/d2/D2_STEP4D1_CSV_IMPORT_MVP_INVESTIGATION.md):
 * Excel, QuickBooks, rollback, any UI, background/async processing, a
 * generic provider-adapter abstraction. Rows are processed sequentially
 * (not Promise.all) — later rows must see earlier rows' commits so
 * within-file duplicates land on the fingerprint-match path instead of
 * racing past each other and double-creating; see the dualWriteSpaceAccountLink
 * comment in app/api/accounts/manual/route.ts for the same race lesson on a
 * different table.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { ShareStatus, ImportSource, ImportBatchStatus } from "@prisma/client";
import { withApiHandler } from "@/lib/api";
import {
  parseCsvText,
  detectColumns,
  normalizeRow,
  resolveFingerprintOutcome,
  type SignConvention,
} from "@/lib/imports/csv";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  const { spaceId } = await getSpaceContext();

  // Resolve + authorize the target account — same SpaceAccountLink-first,
  // legacy-Account-fallback pattern as GET .../transactions. Unlike that
  // read route, import specifically requires a FinancialAccount: ImportBatch
  // .financialAccountId is a required FK to FinancialAccount, not the legacy
  // Account model, and the two id spaces never overlap. A legacy-only match
  // (no FinancialAccount counterpart) is therefore a real "can't do this"
  // case, not just a fallback to try.
  const link = await db.spaceAccountLink.findFirst({
    where:  { spaceId, financialAccountId: id, status: ShareStatus.ACTIVE },
    select: { id: true },
  });

  if (!link) {
    const legacyAccount = await db.account.findFirst({ where: { id, spaceId }, select: { id: true } });
    if (!legacyAccount) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "This account does not support transaction import." },
      { status: 400 }
    );
  }
  const financialAccountId = id;

  // ── Parse request ────────────────────────────────────────────────────────
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

  const signConventionRaw = formData.get("signConvention");
  const signConvention: SignConvention =
    signConventionRaw === "debitPositive" ? "debitPositive" : "creditPositive";

  const text = await file.text();

  let parsed;
  try {
    parsed = parseCsvText(text);
  } catch {
    return NextResponse.json({ error: "Could not parse file as CSV." }, { status: 400 });
  }

  const columns = detectColumns(parsed.headers);
  if ("error" in columns) {
    return NextResponse.json({ error: columns.error }, { status: 400 });
  }

  // ── Create the batch ─────────────────────────────────────────────────────
  // Only created once the file shape is known-valid — a file with the wrong
  // columns never becomes an ImportBatch row (see module header).
  const batch = await db.importBatch.create({
    data: {
      financialAccountId,
      createdByUserId:  user.id,
      source:           ImportSource.CSV,
      originalFilename: file.name || null,
      status:           ImportBatchStatus.PROCESSING,
      rowCount:         parsed.rows.length,
    },
  });

  let created = 0;
  let matched = 0;
  let skipped = 0;
  let failed  = 0;
  const errors: { row: number; reason: string }[] = [];

  for (let i = 0; i < parsed.rows.length; i++) {
    const lineNumber = i + 1; // data-row index, 1-indexed, header row excluded
    const row = normalizeRow(parsed.rows[i], columns, signConvention, lineNumber);

    if (row.error || !row.date || row.amount === null || !row.merchant) {
      failed++;
      errors.push({ row: lineNumber, reason: row.error ?? "missing required field" });
      continue;
    }

    try {
      const result = await resolveFingerprintOutcome(
        financialAccountId,
        row.date,
        row.amount,
        row.merchant,
        row.externalTransactionId
      );

      if (result.outcome === "CREATE") {
        await db.transaction.create({
          data: {
            financialAccountId,
            date:                  row.date,
            merchant:              row.merchant,
            description:           row.description,
            category:              row.category,
            amount:                row.amount,
            pending:               false,
            externalTransactionId: row.externalTransactionId,
            importBatchId:         batch.id, // only set on rows this batch creates — never on MATCH
          },
        });
        created++;
      } else if (result.outcome === "MATCH") {
        matched++; // no write
      } else {
        skipped++;
        errors.push({ row: lineNumber, reason: result.reason });
      }
    } catch (rowErr) {
      failed++;
      errors.push({ row: lineNumber, reason: "unexpected error writing row" });
      console.error(`[csv import] batch ${batch.id} row ${lineNumber} failed:`, rowErr);
    }
  }

  const finalStatus = failed > 0 ? ImportBatchStatus.COMPLETED_WITH_ERRORS : ImportBatchStatus.COMPLETED;

  const updated = await db.importBatch.update({
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
  });

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
