/**
 * app/api/accounts/[id]/import/route.ts
 *
 * id refers to a FinancialAccount.id.
 *
 * POST — D2 Step 4D-1 CSV import MVP, extended in D2 Step 4D-2 to also accept
 * Excel (.xlsx) files. Accepts a file (multipart/form-data), parses +
 * classifies each row against existing Transaction history, and writes an
 * ImportBatch + any newly-created Transaction rows.
 *
 * Format is sniffed from the uploaded file's name/MIME type — see
 * docs/initiatives/d2/D2_STEP4D2_EXCEL_IMPORT_INVESTIGATION.md §5:
 *   - `.xlsx` extension, or the OOXML spreadsheet MIME type → Excel branch
 *     (lib/imports/excel.ts).
 *   - Legacy binary `.xls` → rejected with a 400 (exceljs, the parsing
 *     library this route depends on, only reads the modern OOXML `.xlsx`
 *     format — see lib/imports/excel.ts's module header).
 *   - Everything else → CSV branch (lib/imports/csv.ts), unchanged from
 *     4D-1 — this is not a new restriction, it's the same permissive
 *     fallback the route always had (no file-type check existed before
 *     4D-2; only a positive Excel match is carved out of that fallback).
 * Both branches converge on the same NormalizedTransaction[]-driven
 * batch-create/loop/finalize body below.
 *
 * Body (multipart/form-data):
 *   file:           File   — required, the CSV or .xlsx file to import
 *   signConvention: string — optional, "creditPositive" (default) | "debitPositive"
 *                    Only used when the file has a single signed Amount
 *                    column (not a Debit/Credit pair, which is
 *                    sign-unambiguous). "creditPositive" matches this app's
 *                    own convention (positive = money in) — see
 *                    lib/plaid/syncTransactions.ts's sign-flip comment.
 *   columnMapping:  string — optional, D2 Step 4D-5a. JSON-encoded object
 *                    mapping CsvColumnMap field names (date, merchant,
 *                    description, amount, debit, credit, category,
 *                    reference) to this file's actual header strings, e.g.
 *                    {"date":"Posting Date","debit":"Debit Amount"}. When
 *                    present, used all-or-nothing in place of
 *                    detectColumns()'s alias-based auto-detection — see
 *                    lib/imports/csv.ts's applyExplicitMapping(). Absent →
 *                    auto-detection behavior is unchanged from 4D-1/4D-2.
 *   source:         string — optional, D2 Step 4D-4. "QUICKBOOKS" asserts
 *                    this file is a QuickBooks export — caller-asserted,
 *                    never content-detected; format-sniffing below is
 *                    unaffected (see lib/imports/pipeline.ts's
 *                    sourceOverride). Any other value, or absent, behaves
 *                    exactly as before (source is sniffed from the file as
 *                    CSV or EXCEL). Only "QUICKBOOKS" combined with an exact
 *                    externalTransactionId match (matchedVia: "externalId")
 *                    triggers update-on-match below — never a fingerprint
 *                    fallback match, regardless of source.
 *
 * D2 Step 4D-5b — column resolution for both branches now goes through
 * lib/imports/csv.ts's resolveColumns(), which adds a third source after
 * explicitMapping/detectColumns: this Space's saved ImportMappingProfile
 * rows, trial-applied in recency order. Every ImportBatch now also records
 * resolvedColumnMapping (the actual CsvColumnMap used, regardless of source)
 * and mappingProfileId (set only when a saved profile matched). A matched
 * profile's lastUsedAt/useCount are bumped after the import completes. No
 * request shape change — there is still no route to create/edit/list
 * profiles in this slice; see
 * docs/initiatives/d2/D2_STEP4D5B_IMPLEMENTATION_PLAN.md.
 *
 * D2 Step 4D-5c-1 — the format-sniff → parse → resolveColumns() → normalize
 * sequence above has been extracted into lib/imports/pipeline.ts's
 * runImportPipeline(), called once below instead of being inlined per
 * CSV/Excel branch. Zero behavior change: same error strings/status codes
 * (including the legacy-.xls rejection, now surfaced as a normal
 * runImportPipeline() `{ error }` instead of a dedicated early return), same
 * resolvedColumnMapping/mappingProfileId stamping. Done so the future
 * preview route (D2 Step 4D-5c-2) can call the same pipeline instead of
 * duplicating it. Classification (resolveFingerprintOutcome, below) and all
 * persistence deliberately stay here, unmodified — see
 * docs/initiatives/d2/D2_STEP4D5C1_IMPLEMENTATION_PLAN.md §3 on why
 * classification can't be hoisted into that helper without breaking the
 * sequential within-file duplicate-detection invariant documented in the
 * paragraph below.
 *
 * D2 Step 4D-5c-2 — the account-resolution/authorization check below (was
 * inlined here) is now lib/imports/authorize.ts's
 * resolveImportableFinancialAccount(), shared verbatim with the new, purely
 * read-only `POST .../import/preview` route
 * (app/api/accounts/[id]/import/preview/route.ts), which calls
 * runImportPipeline() and resolveFingerprintOutcome() exactly as this route
 * does but never creates an ImportBatch/Transaction or bumps a profile's
 * usage counters. Zero behavior change here. See
 * docs/initiatives/d2/D2_STEP4D5C2_IMPLEMENTATION_PLAN.md.
 *
 * Per-row outcome (see lib/imports/csv.ts for the classification logic,
 * shared unmodified by the Excel branch):
 *   CREATED — no existing match found; a new Transaction was written.
 *   MATCHED — resolved to an already-existing Transaction (exact
 *             externalTransactionId, or an unambiguous fingerprint match).
 *             No write, except: D2 Step 4D-4 — a QUICKBOOKS-sourced batch
 *             whose match was via externalId (never a fingerprint match)
 *             overwrites the existing row's allow-listed fields (date,
 *             amount, merchant, description, category) when they differ
 *             from the incoming row — see lib/imports/csv.ts's
 *             computeQuickBooksUpdateDiff(). Otherwise the existing row
 *             (possibly Plaid-sourced, or from a prior CSV/Excel import) is
 *             left untouched.
 *   SKIPPED — ambiguous fingerprint match (more than one existing row could
 *             be "the same" transaction). Recorded in errorSummary.
 *   FAILED  — row could not be parsed (bad date/amount, missing
 *             merchant/description). Recorded in errorSummary.
 *
 * Explicitly out of scope for this slice (see
 * docs/initiatives/d2/D2_STEP4D2_EXCEL_IMPORT_INVESTIGATION.md):
 * rollback, any UI, background/async processing, a generic
 * provider-adapter abstraction, multi-sheet selection. Rows are processed
 * sequentially (not Promise.all) — later rows must see earlier rows'
 * commits so within-file duplicates land on the fingerprint-match path
 * instead of racing past each other and double-creating; see the
 * dualWriteSpaceAccountLink comment in app/api/accounts/manual/route.ts for
 * the same race lesson on a different table.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { ImportBatchStatus, ImportSource, Prisma } from "@prisma/client";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import {
  resolveFingerprintOutcome,
  computeQuickBooksUpdateDiff,
  type SignConvention,
  type SavedMappingProfileLite,
} from "@/lib/imports/csv";
import { runImportPipeline } from "@/lib/imports/pipeline";
import { resolveImportableFinancialAccount } from "@/lib/imports/authorize";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  const { spaceId } = await getSpaceContext();

  // Resolve + authorize the target account — D2 Step 4D-5c-2 extracted this
  // check into lib/imports/authorize.ts's resolveImportableFinancialAccount()
  // so the new preview route shares it verbatim instead of duplicating it.
  // Zero behavior change here — same two db reads, same NextResponse
  // bodies/status codes. See that module's header for the
  // SpaceAccountLink-first/legacy-Account-fallback rationale.
  const access = await resolveImportableFinancialAccount(spaceId, id);
  if (!access.ok) return access.response;
  const { financialAccountId } = access;

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

  // ── Source override (D2 Step 4D-4) ───────────────────────────────────────
  // Caller-asserted only — never inferred from file content. See module
  // header's `source` field doc and lib/imports/pipeline.ts's
  // sourceOverride. Any value other than "QUICKBOOKS" (including absent)
  // leaves source exactly as today's format-sniffing produces it.
  const sourceRaw = formData.get("source");
  const sourceOverride: ImportSource | undefined =
    sourceRaw === "QUICKBOOKS" ? ImportSource.QUICKBOOKS : undefined;

  // ── Explicit column mapping (D2 Step 4D-5a) ──────────────────────────────
  // Optional caller-supplied mapping, JSON-encoded in a form field. Present →
  // validated here at the shape level (object, string|null values), then
  // used all-or-nothing in place of detectColumns()'s alias-based
  // auto-detection by applyExplicitMapping() below (field-name/header
  // validation happens there, not here). Absent → today's exact behavior,
  // unchanged. See docs/initiatives/d2/D2_STEP4D5A_IMPLEMENTATION_PLAN.md.
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

  // ── Saved column-mapping profiles (D2 Step 4D-5b) ────────────────────────
  // Fetched once per request, passed into runImportPipeline() below rather
  // than fetched by it — the pipeline helper is deliberately DB-free (D2
  // Step 4D-5c-1, see
  // docs/initiatives/d2/D2_STEP4D5C1_IMPLEMENTATION_PLAN.md §2). Sorted
  // lastUsedAt desc (nulls last) then createdAt desc so the most-recently-
  // used matching profile wins when more than one of this Space's profiles
  // would trial-apply successfully — see
  // docs/initiatives/d2/D2_STEP4D5B_IMPLEMENTATION_PLAN.md §5's tie-break.
  // Every Space with zero saved profiles (every Space today — no route
  // creates one yet) gets an empty array here, which makes the saved-profile
  // branch of resolveColumns() a no-op — identical to pre-4D-5b behavior.
  const savedProfileRows = await db.importMappingProfile.findMany({
    where:   { spaceId },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select:  { id: true, mapping: true },
  });
  const savedProfilesLite: SavedMappingProfileLite[] = savedProfileRows.map((p) => ({
    id:      p.id,
    // Json column at the Prisma layer is looser (Prisma.JsonValue) than this
    // module's CsvColumnMap-shaped assumption — every row here was written
    // either by applyExplicitMapping()'s own output (route-created profiles,
    // once 4D-5c adds that) or by a validation script seeding rows directly
    // in that exact shape (4D-5b has no CRUD route yet). See
    // D2_STEP4D5B_IMPLEMENTATION_PLAN.md §3.
    mapping: p.mapping as Record<string, string | null>,
  }));

  // ── Format-sniffed parse / resolve / normalize (D2 Step 4D-5c-1) ────────
  // Converges on the same NormalizedTransaction[] shape regardless of source
  // format — see module header and
  // D2_STEP4D2_EXCEL_IMPORT_INVESTIGATION.md §3/§5. Extracted into
  // runImportPipeline() so the future preview route (D2 Step 4D-5c-2) can
  // call the identical logic instead of duplicating it — see
  // docs/initiatives/d2/D2_STEP4D5C1_IMPLEMENTATION_PLAN.md. Deliberately
  // does not classify rows against existing Transaction history or write
  // anything — that stays below, in the sequential loop, unchanged (see
  // this route's module header above on why classification can't be
  // hoisted into a batch pre-pass without breaking within-file duplicate
  // detection).
  const pipelineResult = await runImportPipeline(file, {
    signConvention,
    explicitMapping,
    savedProfiles: savedProfilesLite,
    sourceOverride,
  });
  if ("error" in pipelineResult) {
    return NextResponse.json({ error: pipelineResult.error }, { status: 400 });
  }
  const { source, rows, resolvedColumnMapping, matchedProfileId } = pipelineResult;

  // ── Create the batch ─────────────────────────────────────────────────────
  // Only created once the file shape is known-valid — a file with the wrong
  // columns never becomes an ImportBatch row (see module header).
  const batch = await db.importBatch.create({
    data: {
      financialAccountId,
      createdByUserId:  user.id,
      source,
      originalFilename: file.name || null,
      status:           ImportBatchStatus.PROCESSING,
      rowCount:         rows.length,
      // D2 Step 4D-5b — written on every batch regardless of which
      // resolveColumns() branch (now inside runImportPipeline(), D2 Step
      // 4D-5c-1) produced resolvedColumnMapping; mappingProfileId stays null
      // unless the saved-profile branch matched.
      //
      // Cast (not a behavior change): CsvColumnMap is a plain, JSON-
      // compatible interface (string | null fields only), but Prisma's Json
      // input type (Prisma.InputJsonObject) requires a string index
      // signature for assignability, which a named interface doesn't carry
      // automatically — TS won't bridge that gap with a direct cast either
      // ("neither type sufficiently overlaps"), so this goes through
      // `unknown` first, same as the pre-existing exceljs Buffer-typing cast
      // in lib/imports/excel.ts's parseExcelFile(). The values written are
      // unaffected — this only satisfies the type checker at this one call
      // site.
      resolvedColumnMapping: resolvedColumnMapping as unknown as Prisma.InputJsonValue,
      mappingProfileId:      matchedProfileId,
    },
  });

  let created = 0;
  let matched = 0;
  let skipped = 0;
  let failed  = 0;
  const errors: { row: number; reason: string }[] = [];
  // D2 Step 4D-4 — ids of rows actually overwritten by update-on-match.
  // Drives the single batch-level audit entry below; not a new ImportBatch
  // counter (see D2_STEP4D4_QUICKBOOKS_IMPLEMENTATION_CHECKLIST.md §5).
  const updatedTransactionIds: string[] = [];

  for (const row of rows) {
    const lineNumber = row.lineNumber; // data-row index, 1-indexed, header row excluded

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
        matched++;
        // D2 Step 4D-4 — update-on-match. Gate: QUICKBOOKS source + an
        // exact externalId match only — never a fingerprint-fallback
        // match, regardless of source. This `source === QUICKBOOKS` check
        // is intentionally temporary: it is expected to migrate to an
        // adapter-capability check during D2 Step 5 (not implemented now).
        if (source === ImportSource.QUICKBOOKS && result.matchedVia === "externalId") {
          const existing = await db.transaction.findUnique({
            where:  { id: result.transactionId },
            select: { date: true, amount: true, merchant: true, description: true, category: true },
          });
          if (existing) {
            const diff = computeQuickBooksUpdateDiff(existing, {
              date:        row.date,
              amount:      row.amount,
              merchant:    row.merchant,
              description: row.description,
              category:    row.category,
            });
            if (diff) {
              await db.transaction.update({ where: { id: result.transactionId }, data: diff });
              updatedTransactionIds.push(result.transactionId);
            }
          }
        }
      } else {
        skipped++;
        errors.push({ row: lineNumber, reason: result.reason });
      }
    } catch (rowErr) {
      failed++;
      errors.push({ row: lineNumber, reason: "unexpected error writing row" });
      console.error(`[import] batch ${batch.id} row ${lineNumber} failed:`, rowErr);
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

  // D2 Step 4D-4 — one batch-level audit event, written only if at least
  // one row was actually overwritten (diff was non-empty for at least one
  // row). Mirrors the existing IMPORT_BATCH_ROLLED_BACK pattern exactly:
  // single row, structured metadata, no per-row spam, no before/after
  // snapshots, no versioning. Non-fatal — a failure here must not turn an
  // otherwise-successful import response into an error.
  if (updatedTransactionIds.length > 0) {
    try {
      await db.auditLog.create({
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
      });
    } catch (auditErr) {
      console.error(
        `[import] batch ${batch.id} failed to write update-on-match audit log:`,
        auditErr
      );
    }
  }

  // D2 Step 4D-5b — a "successful import" here means the batch ran to
  // completion (COMPLETED or COMPLETED_WITH_ERRORS, set just above), not
  // that every row succeeded; a request that 400'd earlier never created a
  // batch and never reaches this point. Atomic increment ({ increment: 1 })
  // rather than read-then-write, so concurrent imports against the same
  // profile can't lose an update. Non-fatal: a failure here must not turn an
  // otherwise-successful import response into an error.
  if (matchedProfileId) {
    try {
      await db.importMappingProfile.update({
        where: { id: matchedProfileId },
        data:  { useCount: { increment: 1 }, lastUsedAt: new Date() },
      });
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
