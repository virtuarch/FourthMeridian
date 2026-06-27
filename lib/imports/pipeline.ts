/**
 * lib/imports/pipeline.ts
 *
 * D2 Step 4D-5c-1 — Import pipeline extraction. Pure orchestration: given an
 * uploaded file, sniffs its format, parses it, resolves its columns, and
 * normalizes its rows — the exact parse → resolve → normalize sequence
 * app/api/accounts/[id]/import/route.ts previously inlined directly across
 * its CSV/Excel branches. Extracted so the future preview route (D2 Step
 * 4D-5c-2) can call this identical logic instead of duplicating it. See
 * docs/initiatives/d2/D2_STEP4D5C1_IMPLEMENTATION_PLAN.md.
 *
 * Deliberately excludes (left in route.ts, unchanged):
 *   - Saved ImportMappingProfile loading. This module receives
 *     `opts.savedProfiles` already fetched (Space-scoped, caller-sorted by
 *     recency) and never touches `db` itself — the fetch has nothing to do
 *     with which file was uploaded, so it stays at the route layer beside
 *     spaceId resolution, exactly where it already lived. Keeping this
 *     module DB-free also keeps its primary surface fixture-testable the
 *     same way csv.ts's pure functions already are. See the implementation
 *     plan §2.
 *   - Fingerprint classification (`resolveFingerprintOutcome`). route.ts's
 *     own module header documents that rows are classified and written
 *     sequentially, not via a batch-wide pre-pass, specifically so a
 *     duplicate row later in the same file sees the Transaction an earlier
 *     row in the same file already created and lands on MATCH instead of
 *     racing into a second CREATE. Hoisting classification into this helper
 *     would turn it into a stateless pre-pass and break that invariant —
 *     see the implementation plan §3. Classification stays inside route.ts's
 *     existing sequential write loop, untouched.
 *   - ImportBatch/Transaction creation, the profile usage-counter bump, and
 *     rollback — all persistence stays in route.ts.
 *
 * CSV and Excel are deliberately NOT forced into a symmetric internal shape
 * here. Excel's resolve+normalize already lives inside parseExcelFile()
 * (its typed-cell complexity justifies that encapsulation); CSV's three
 * steps (parse, resolve, normalize) stay inline below, exactly as route.ts
 * called them before this extraction. See the implementation plan §5 and
 * csv.ts's own module header on why a forced shared adapter interface
 * between formats is deliberately avoided.
 *
 * D2 Step 4D-5c-3 — when column resolution fails but the header row itself
 * parsed successfully, the returned error now also carries `rawHeaders` so
 * the preview route's suggestion engine (lib/imports/suggest.ts) has
 * something to score. See docs/initiatives/d2/D2_STEP4D5C3_IMPLEMENTATION_PLAN.md.
 * Additive only — the confirm route only ever reads `.error` off this same
 * return value, so it is unaffected.
 */

import { ImportSource } from "@prisma/client";
import {
  parseCsvText,
  resolveColumns,
  normalizeRow,
  type SignConvention,
  type NormalizedTransaction,
  type CsvColumnMap,
  type SavedMappingProfileLite,
} from "@/lib/imports/csv";
import { parseExcelFile } from "@/lib/imports/excel";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const LEGACY_XLS_MIME_TYPE = "application/vnd.ms-excel";

/**
 * Format sniff — relocated verbatim from route.ts (D2 Step 4D-2
 * investigation §5). Extension is checked first (the more reliable signal
 * in practice; browsers/OSes are inconsistent about the MIME type they
 * attach to a multipart file part), MIME type as a fallback for a file
 * whose name was changed or stripped. Anything not positively identified as
 * Excel (xlsx or legacy xls) falls through to the CSV branch, preserving the
 * route's original permissive default exactly.
 */
function detectExcelFormat(file: File): "xlsx" | "legacy-xls" | null {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx")) return "xlsx";
  if (name.endsWith(".xls")) return "legacy-xls";
  if (file.type === XLSX_MIME_TYPE) return "xlsx";
  if (file.type === LEGACY_XLS_MIME_TYPE) return "legacy-xls";
  return null;
}

export interface ImportPipelineResult {
  source:                ImportSource;
  rows:                  NormalizedTransaction[];
  resolvedColumnMapping: CsvColumnMap;
  matchedProfileId:      string | null;
}

export interface ImportPipelineOptions {
  signConvention:   SignConvention;
  explicitMapping?: Record<string, string | null | undefined>;
  /** Already fetched by the caller — this module never queries `db`. */
  savedProfiles:    SavedMappingProfileLite[];
}

/**
 * Parses + resolves + normalizes an uploaded file into the shared
 * NormalizedTransaction[] shape, regardless of source format. Returns a
 * file-level `{ error }` for any "wrong shape" problem — legacy .xls, an
 * unparseable CSV, a malformed/empty workbook, or columns that don't
 * resolve via explicitMapping/detectColumns/savedProfiles — using the exact
 * same error strings route.ts returned directly before this extraction, so
 * callers can map every failure to a 400 response uniformly.
 *
 * Never touches `db`, never classifies rows against existing Transaction
 * history, and never writes anything — see this module's header for why
 * those responsibilities stay in route.ts.
 */
export async function runImportPipeline(
  file: File,
  opts: ImportPipelineOptions
): Promise<ImportPipelineResult | { error: string; rawHeaders?: string[] }> {
  const excelFormat = detectExcelFormat(file);

  if (excelFormat === "legacy-xls") {
    return { error: "Legacy .xls files are not supported. Please save the file as .xlsx and re-upload." };
  }

  if (excelFormat === "xlsx") {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = await parseExcelFile(buffer, opts.signConvention, opts.explicitMapping, opts.savedProfiles);
    if ("error" in parsed) {
      return parsed;
    }
    return {
      source:                ImportSource.EXCEL,
      rows:                  parsed.rows,
      resolvedColumnMapping: parsed.columns,
      matchedProfileId:      parsed.matchedProfileId,
    };
  }

  const text = await file.text();

  let parsed;
  try {
    parsed = parseCsvText(text);
  } catch {
    return { error: "Could not parse file as CSV." };
  }

  const resolved = resolveColumns(parsed.headers, {
    explicitMapping: opts.explicitMapping,
    savedProfiles:   opts.savedProfiles,
  });
  if ("error" in resolved) {
    // D2 Step 4D-5c-3 — header row parsed; resolution failed. Surface the
    // raw headers for the preview route's suggestion engine.
    return { ...resolved, rawHeaders: parsed.headers };
  }

  const rows = parsed.rows.map((raw, i) => normalizeRow(raw, resolved.columns, opts.signConvention, i + 1));

  return {
    source:                ImportSource.CSV,
    rows,
    resolvedColumnMapping: resolved.columns,
    matchedProfileId:      resolved.matchedProfileId,
  };
}
