/**
 * lib/imports/investments/pipeline.ts
 *
 * A7-3 — the DB-free investment import pipeline: parse → resolve columns →
 * normalize. Zero DB, zero writes, zero routes (all of those are A7-4). Mirrors
 * the banking runImportPipeline shape but over the investment contract; CSV text
 * is parsed with the banking parseCsvText (read-only reuse). XLSX converges onto
 * the same `Record<string,string>[]` via the banking excel path at the route
 * layer (A7-4) — the normalizer is format-neutral, so an OFX producer slots in
 * with zero downstream change (investigation §3.2).
 */

import { parseCsvText } from "@/lib/imports/csv";
import { resolveInvestmentColumns } from "./columns";
import { normalizeInvestmentRows } from "./normalize";
import { getInvestmentProfile } from "./profiles";
import type { InvestmentRowKind, NormalizedInvestmentRow } from "./types";

export interface InvestmentPipelineOptions {
  profileKey?: string | null;
  /** Force every row to POSITION for a holdings-statement import with no kind column. */
  rowKindOverride?: InvestmentRowKind;
}

export interface InvestmentPipelineResult {
  rows: NormalizedInvestmentRow[];
  /** Snapshot written to ImportBatch.resolvedColumnMapping (A7-4). */
  resolvedColumnMapping: {
    profileKey:     string;
    profileVersion: number;
    columns:        Record<string, string | null>;
  };
  error?: string;
  rawHeaders?: string[];
  /** Required columns that could not be resolved (present on the error path). */
  missing?: string[];
}

/** Run the pure pipeline over CSV text. */
export function runInvestmentImportPipelineFromCsv(
  text: string,
  opts: InvestmentPipelineOptions = {},
): InvestmentPipelineResult {
  const profile = getInvestmentProfile(opts.profileKey);
  let parsed: { headers: string[]; rows: Record<string, string>[] };
  try {
    parsed = parseCsvText(text);
  } catch (e) {
    return {
      rows: [],
      resolvedColumnMapping: { profileKey: profile.key, profileVersion: profile.profileVersion, columns: {} },
      error: e instanceof Error ? e.message : "Could not parse the file.",
    };
  }

  const { columns, missing } = resolveInvestmentColumns(parsed.headers, profile);
  const mapping = {
    profileKey: profile.key,
    profileVersion: profile.profileVersion,
    columns: { ...columns } as Record<string, string | null>,
  };

  if (missing.length > 0) {
    return {
      rows: [],
      resolvedColumnMapping: mapping,
      error: `Could not resolve required column(s): ${missing.join(", ")}. Map them explicitly or pick a matching broker profile.`,
      rawHeaders: parsed.headers,
      missing,
    };
  }

  const rows = normalizeInvestmentRows(parsed.rows, columns, profile, opts.rowKindOverride);
  return { rows, resolvedColumnMapping: mapping, rawHeaders: parsed.headers };
}
