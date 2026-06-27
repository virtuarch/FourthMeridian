/**
 * app/api/accounts/[id]/import/preview/route.ts
 *
 * id refers to a FinancialAccount.id.
 *
 * POST — D2 Step 4D-5c-2. Read-only preview of what
 * `POST /api/accounts/[id]/import` (the confirm route, unmodified by this
 * file) would do with the same file/options, without persisting anything.
 * Accepts the exact same multipart/form-data fields as the confirm route
 * (file, signConvention?, columnMapping?), reuses the confirm route's parse
 * → resolve → normalize pipeline (lib/imports/pipeline.ts's
 * runImportPipeline(), unmodified) and per-row classification
 * (lib/imports/csv.ts's resolveFingerprintOutcome(), unmodified — it only
 * ever reads), and returns an aggregate summary plus a capped row-level
 * preview instead of writing an ImportBatch/Transaction or bumping a saved
 * mapping profile's usage counters.
 *
 * This route never calls db.importBatch.create, db.transaction.create, or
 * db.importMappingProfile.update — by construction, not by a runtime guard.
 * See docs/initiatives/d2/D2_STEP4D5C2_IMPLEMENTATION_PLAN.md (approved
 * checklist this route implements) and
 * docs/initiatives/d2/D2_STEP4D5C_PREVIEW_INVESTIGATION.md (architecture
 * investigation this step is sequenced from).
 *
 * Body (multipart/form-data) — identical to the confirm route:
 *   file:           File   — required, the CSV or .xlsx file to preview
 *   signConvention: string — optional, "creditPositive" (default) | "debitPositive"
 *   columnMapping:  string — optional, JSON-encoded CsvColumnMap-shaped object
 *
 * Resolution failure (no auto-detect, no explicit mapping, no saved-profile
 * match) returns the exact same `{ error }` / 400 the confirm route returns
 * today — approved decision, deferred from the investigation's richer
 * `resolved: false` / rawHeaders / suggestedMapping shape, which depends on
 * 4D-5c-3 (fuzzy suggestions, not built yet). Shipping that shape now with
 * an always-empty suggestion would be a half-built contract 4D-5c-3 would
 * then have to change.
 *
 * Per-row classification (identical semantics to the confirm route's loop,
 * see that route's module header):
 *   CREATE — no existing match found; this row would create a new
 *            Transaction if confirmed. Nothing is written here.
 *   MATCH  — resolves to an already-existing Transaction. No
 *            matchedTransactionId is included in this slice's payload —
 *            approved decision; the confirm route's loop never reads that
 *            id off resolveFingerprintOutcome()'s result either, so
 *            exposing it here would mean changing that function's return
 *            shape, which conflicts with "no fingerprint behavior changes."
 *   SKIP   — ambiguous fingerprint match. Included in `errors` with the
 *            same reason string the confirm route's errorSummary would use.
 *   FAILED — row could not be parsed. Included in `errors`, same as above.
 *
 * Known, documented behavior difference from confirm, not a bug: two
 * identical rows within the same previewed file will both classify as
 * CREATE here, because preview never writes the first one, so the second
 * never finds it as a MATCH. Confirming the same file still correctly
 * classifies the second row as MATCH against the Transaction the confirm
 * route's loop just created for the first — that sequential
 * within-file-duplicate-detection invariant lives entirely in the confirm
 * route's loop and is untouched by this file. Preview is a snapshot;
 * confirm remains authoritative (see the investigation's §10 risk #1 on
 * preview/confirm staleness generally).
 *
 * `summary` counts are computed over every row in the file — classification
 * already has to touch every row to produce accurate aggregate counts. Only
 * the `rows` and `errors` arrays are capped, to PREVIEW_ROW_CAP entries each,
 * in file order.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { withApiHandler } from "@/lib/api";
import {
  resolveFingerprintOutcome,
  type SignConvention,
  type SavedMappingProfileLite,
  type NormalizedTransaction,
} from "@/lib/imports/csv";
import { runImportPipeline } from "@/lib/imports/pipeline";
import { resolveImportableFinancialAccount } from "@/lib/imports/authorize";

const PREVIEW_ROW_CAP = 50;

type PreviewClassification = "CREATE" | "MATCH" | "SKIP" | "FAILED";

interface ImportPreviewRow {
  lineNumber:            number;
  date:                  string | null;
  merchant:              string | null;
  description:           string | null;
  category:              NormalizedTransaction["category"];
  amount:                number | null;
  externalTransactionId: string | null;
  classification:        PreviewClassification;
  reason:                string | null;
}

function toIsoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [, err] = await requireUser();
  if (err) return err;

  const { spaceId } = await getSpaceContext();

  // Same shared check the confirm route uses — see
  // lib/imports/authorize.ts and this route's module header.
  const access = await resolveImportableFinancialAccount(spaceId, id);
  if (!access.ok) return access.response;
  const { financialAccountId } = access;

  // ── Parse request — identical to the confirm route ──────────────────────
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

  // ── Explicit column mapping — identical to the confirm route ────────────
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

  // ── Saved column-mapping profiles — fetched exactly as the confirm route
  // does (read-only; this preview route never bumps useCount/lastUsedAt) ──
  const savedProfileRows = await db.importMappingProfile.findMany({
    where:   { spaceId },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select:  { id: true, mapping: true },
  });
  const savedProfilesLite: SavedMappingProfileLite[] = savedProfileRows.map((p) => ({
    id:      p.id,
    mapping: p.mapping as Record<string, string | null>,
  }));

  // ── Format-sniffed parse / resolve / normalize — same pipeline the
  // confirm route calls (lib/imports/pipeline.ts, unmodified) ─────────────
  const pipelineResult = await runImportPipeline(file, {
    signConvention,
    explicitMapping,
    savedProfiles: savedProfilesLite,
  });
  if ("error" in pipelineResult) {
    // Approved decision: same plain { error } / 400 the confirm route
    // returns for an unresolvable file — no resolved:false/suggestion
    // shape in this slice (4D-5c-3).
    return NextResponse.json({ error: pipelineResult.error }, { status: 400 });
  }
  const { source, rows, resolvedColumnMapping, matchedProfileId } = pipelineResult;

  // ── Read-only classification loop — never writes ─────────────────────────
  // Sequential, mirroring the confirm route's loop shape for consistency
  // (no within-file-duplicate race to protect against here, since nothing
  // is ever written — see this route's module header on the resulting,
  // expected CREATE/CREATE-vs-CREATE/MATCH difference from confirm).
  let willCreate = 0;
  let willMatch  = 0;
  let willSkip   = 0;
  let willFail   = 0;
  const previewRows: ImportPreviewRow[] = [];
  const errors: { row: number; reason: string }[] = [];
  let earliest: Date | null = null;
  let latest:   Date | null = null;

  for (const row of rows) {
    const lineNumber = row.lineNumber;

    if (row.date) {
      if (!earliest || row.date < earliest) earliest = row.date;
      if (!latest || row.date > latest) latest = row.date;
    }

    let classification: PreviewClassification = "FAILED";
    let reason: string | null = null;

    if (row.error || !row.date || row.amount === null || !row.merchant) {
      willFail++;
      reason = row.error ?? "missing required field";
      errors.push({ row: lineNumber, reason });
    } else {
      try {
        const result = await resolveFingerprintOutcome(
          financialAccountId,
          row.date,
          row.amount,
          row.merchant,
          row.externalTransactionId
        );

        if (result.outcome === "CREATE") {
          willCreate++;
          classification = "CREATE";
        } else if (result.outcome === "MATCH") {
          willMatch++;
          classification = "MATCH";
        } else {
          willSkip++;
          classification = "SKIP";
          reason = result.reason;
          errors.push({ row: lineNumber, reason: result.reason });
        }
      } catch (rowErr) {
        willFail++;
        classification = "FAILED";
        reason = "unexpected error classifying row";
        errors.push({ row: lineNumber, reason });
        console.error(`[import-preview] account ${financialAccountId} row ${lineNumber} failed:`, rowErr);
      }
    }

    if (previewRows.length < PREVIEW_ROW_CAP) {
      previewRows.push({
        lineNumber,
        date: toIsoDate(row.date),
        merchant: row.merchant,
        description: row.description,
        category: row.category,
        amount: row.amount,
        externalTransactionId: row.externalTransactionId,
        classification,
        reason,
      });
    }
  }

  return NextResponse.json({
    source,
    resolvedColumnMapping,
    matchedProfileId,
    signConvention,
    summary: {
      totalRows: rows.length,
      willCreate,
      willMatch,
      willSkip,
      willFail,
    },
    dateRange: {
      earliest: toIsoDate(earliest),
      latest:   toIsoDate(latest),
    },
    rows:   previewRows,
    errors: errors.slice(0, PREVIEW_ROW_CAP),
  });
}, "POST /api/accounts/[id]/import/preview");
