/**
 * lib/investments/investment-import-preview.ts
 *
 * A7-6 — the single validation gate both the preview route and the commit route
 * run, so the UI can never bypass a block. Ties together: the pure pipeline
 * (parse/normalize), the safety core (source detection, connection compatibility,
 * file assessment, account mapping — lib/imports/investments/import-validation),
 * and the dedupe classification (previewInvestmentImport). Produces one
 * ImportPreview with `canCommit` + the reasons, all name-free and masked-safe.
 *
 * `connectionInstitution` and `targetMask` are resolved server-side from the
 * account row (never trusted from the client), so compatibility is judged on
 * authoritative identity.
 */

import type { PrismaClient } from "@prisma/client";
import { runInvestmentImportPipelineFromCsv } from "@/lib/imports/investments/pipeline";
import {
  detectInvestmentSource, checkImportCompatibility, assessImportRows, assessAccountMapping,
  type SourceDetection, type CompatibilityResult, type FileAssessment, type AccountAssessment,
} from "@/lib/imports/investments/import-validation";
import { previewInvestmentImport, type ClassifiedRow, type ImportCounts } from "@/lib/investments/investment-import-commit";

export interface ImportPreviewParams {
  csvText:               string;
  profileKey:            string;
  rowKindOverride?:      "POSITION";
  financialAccountId:    string;
  /** Authoritative institution of the target account's connection (from DB). */
  connectionInstitution: string;
  /** Target account last-4 mask (FinancialAccount.mask), server-resolved. */
  targetMask:            string | null;
  client?:               PrismaClient;
}

export interface ImportPreview {
  detection:      SourceDetection;
  compatibility:  CompatibilityResult;
  account:        AccountAssessment;
  file:           FileAssessment;
  counts:         ImportCounts;
  rows:           ClassifiedRow[];
  resolvedColumnMapping: { profileKey: string; profileVersion: number; columns: Record<string, string | null> };
  dateRange:      { from: string | null; to: string | null };
  /** Commit is allowed only when true (no blocking mismatch / file / account). */
  canCommit:      boolean;
  /** True ⇒ commit requires an explicit user acknowledgement flag. */
  requiresConfirmation: boolean;
  blockingReasons: string[];
}

function dateRangeOf(rows: ClassifiedRow[], allDates: (string | null)[]): { from: string | null; to: string | null } {
  const ds = allDates.filter((d): d is string => !!d);
  if (ds.length === 0) return { from: null, to: null };
  return { from: ds.reduce((a, b) => (a < b ? a : b)), to: ds.reduce((a, b) => (a > b ? a : b)) };
}

/**
 * Build the full preview + verdict. Pure enough to unit-test with a fake client
 * (the only DB touch is the dedupe candidate fetch inside previewInvestmentImport).
 */
export async function buildImportPreview(params: ImportPreviewParams): Promise<ImportPreview> {
  const pipeline = runInvestmentImportPipelineFromCsv(params.csvText, { profileKey: params.profileKey, rowKindOverride: params.rowKindOverride });
  const detection = detectInvestmentSource(pipeline.rawHeaders ?? []);
  const compatibility = checkImportCompatibility(detection, { connectionId: params.financialAccountId, institution: params.connectionInstitution });
  // The pipeline parses no per-row account column today, so the file states no
  // account identity ⇒ `unverified` (explicit confirmation, never silent commit).
  const account = assessAccountMapping({ fileAccountIdentifiers: [], targetMask: params.targetMask });

  let counts: ImportCounts = { create: 0, match: 0, skip: 0, failed: 0 };
  let rows: ClassifiedRow[] = [];
  if (!pipeline.error) {
    const preview = await previewInvestmentImport({
      financialAccountId: params.financialAccountId, profileKey: params.profileKey, rows: pipeline.rows, client: params.client,
    });
    counts = preview.counts;
    rows = preview.rows;
  }

  const file = assessImportRows({
    parseError:      pipeline.error ?? null,
    investmentLike:  detection.investmentLike,
    missingRequired: pipeline.missing ?? [],
    totalRows:       pipeline.rows.length,
    invalidRows:     pipeline.rows.filter((r) => r.error).length,
    createRows:      counts.create,
    matchRows:       counts.match,
  });

  const blockingReasons: string[] = [];
  if (compatibility.blockingMismatch) blockingReasons.push(compatibility.reason);
  if (file.blocking) blockingReasons.push(file.reason);
  if (account.blocking) blockingReasons.push(account.reason);

  const canCommit = blockingReasons.length === 0;
  const requiresConfirmation = canCommit && (compatibility.requiresConfirmation || account.requiresConfirmation);

  return {
    detection, compatibility, account, file, counts, rows,
    resolvedColumnMapping: pipeline.resolvedColumnMapping,
    dateRange: dateRangeOf(rows, pipeline.rows.map((r) => r.date)),
    canCommit, requiresConfirmation, blockingReasons,
  };
}
