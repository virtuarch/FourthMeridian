/**
 * lib/imports/suggest.ts
 *
 * D2 Step 4D-5c-3 — Suggestions. Fuzzy best-guess column mapping for the
 * import preview route's unresolved case (no auto-detect hit, no explicit
 * mapping, no saved-profile match — see
 * docs/initiatives/d2/investigations/D2_STEP4D5C_PREVIEW_INVESTIGATION.md §11 and
 * docs/initiatives/d2/implementation/D2_STEP4D5C3_IMPLEMENTATION_PLAN.md).
 *
 * Pre-fill only. Never read by detectColumns(), resolveColumns(), or the
 * confirm route, and never auto-applied anywhere in this codebase. A caller
 * wanting to use a suggestion must explicitly resubmit it as
 * `columnMapping` on a later preview/confirm call, identically to any other
 * explicit mapping (D2 Step 4D-5a).
 *
 * Deterministic string similarity only — no ML, no trained classifier, no
 * new npm dependency (approved checklist constraint). Reuses csv.ts's
 * existing HEADER_ALIASES table and normalizeHeader() verbatim (both newly
 * exported for this purpose, D2 Step 4D-5c-3) — does not widen
 * HEADER_ALIASES and does not touch detectColumns()'s own exact-match
 * logic.
 */

import { CsvColumnMap, HEADER_ALIASES, normalizeHeader } from "@/lib/imports/csv";

/**
 * Best score (0–1) a header's normalized form must clear, against any
 * alias for a given field, to be suggested for that field. Below this, the
 * field is omitted from the result entirely (not null) — an unconfident
 * guess is worse than no guess for a pre-fill UI.
 */
const SUGGESTION_THRESHOLD = 0.6;

/**
 * Levenshtein edit distance between two strings. Local, dependency-free —
 * standard O(n*m) dynamic-programming implementation with a rolling
 * single-row array.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prevRow[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const currRow: number[] = new Array(b.length + 1);
    currRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,       // deletion
        currRow[j - 1] + 1,   // insertion
        prevRow[j - 1] + cost // substitution
      );
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

/**
 * Normalized similarity in [0, 1] — 1 means identical, 0 means maximally
 * different relative to the longer string's length.
 */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Best-guess column mapping for a file whose headers didn't resolve via
 * detectColumns()/explicitMapping/savedProfiles. For each CsvColumnMap
 * field, scores every raw header against that field's alias list
 * (HEADER_ALIASES) using normalized Levenshtein similarity, keeps the
 * best-scoring header, and includes it in the result only if that score
 * clears SUGGESTION_THRESHOLD.
 *
 * Fields are scored independently — the same header may end up suggested
 * for more than one field. That's a UI/caller concern to resolve via
 * explicit mapping, not a data-integrity one, since nothing returned here
 * is ever auto-applied.
 */
export function suggestColumnMapping(rawHeaders: string[]): Partial<CsvColumnMap> {
  const result: Partial<CsvColumnMap> = {};
  if (rawHeaders.length === 0) return result;

  const normalizedHeaders = rawHeaders.map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  for (const field of Object.keys(HEADER_ALIASES) as (keyof CsvColumnMap)[]) {
    let bestHeader: string | null = null;
    let bestScore = 0;

    for (const alias of HEADER_ALIASES[field]) {
      for (const header of normalizedHeaders) {
        const score = similarity(header.norm, alias);
        if (score > bestScore) {
          bestScore = score;
          bestHeader = header.raw;
        }
      }
    }

    if (bestHeader !== null && bestScore >= SUGGESTION_THRESHOLD) {
      result[field] = bestHeader;
    }
  }

  return result;
}
