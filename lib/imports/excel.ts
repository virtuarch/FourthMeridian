/**
 * lib/imports/excel.ts
 *
 * D2 Step 4D-2 — Excel import. Provides the Excel-specific Parse stage
 * (workbook/worksheet loading, header coercion) and a typed-value-aware row
 * normalizer that produces the same `NormalizedTransaction` shape
 * `lib/imports/csv.ts` already produces for CSV — see
 * docs/initiatives/d2/D2_STEP4D2_EXCEL_IMPORT_INVESTIGATION.md.
 *
 * Deliberately reuses, unmodified, the source-agnostic pieces of csv.ts:
 * `detectColumns`, `mapCategory`, `parseDate`, `parseAmount`, and the shared
 * `NormalizedTransaction`/`CsvColumnMap`/`SignConvention` types (investigation
 * §3 option (ii), §4 option (i) — csv.ts itself is not touched by this file).
 * `resolveFingerprintOutcome` is not called here at all — it's
 * source-agnostic and is called directly by the route for both formats.
 *
 * D2 Step 4D-5a added an optional `explicitMapping` parameter to
 * `parseExcelFile()` — when supplied, `csv.ts`'s `applyExplicitMapping()` is
 * used in place of `detectColumns()` for header resolution, all-or-nothing,
 * identically to how the CSV branch of the import route uses it. `csv.ts`'s
 * `NormalizedRow` was also renamed to `NormalizedTransaction` in that same
 * step (mechanical, compile-time-only) — see
 * docs/initiatives/d2/D2_STEP4D5A_IMPLEMENTATION_PLAN.md.
 *
 * Scope notes (see the investigation doc for full rationale):
 * - First worksheet only (`workbook.worksheets[0]`) — no multi-sheet
 *   selection in this slice (investigation §8).
 * - `.xlsx` (OOXML) only. Legacy binary `.xls` is NOT supported — exceljs
 *   itself only reads/writes the OOXML format, so a `.xls` upload is
 *   rejected by the route's format-sniffing branch before it ever reaches
 *   this module, rather than being silently mis-parsed.
 * - No modifications to lib/transactions/fingerprint.ts or lib/imports/csv.ts.
 * - Synchronous, single-request `workbook.xlsx.load(buffer)` — no streaming
 *   reader, consistent with 4D-1's synchronous CSV precedent (investigation
 *   §12's zip-bomb/byte-size-ceiling follow-up is explicitly deferred, not
 *   solved here).
 */

import ExcelJS from "exceljs";
import {
  detectColumns,
  applyExplicitMapping,
  mapCategory,
  parseDate,
  parseAmount,
  type SignConvention,
  type NormalizedTransaction,
} from "@/lib/imports/csv";

// ── Typed-cell helpers ──────────────────────────────────────────────────────

/**
 * True if a cell's (possibly nested, e.g. a formula `.result`) value is
 * exceljs's error-shape `{ error: "#REF!" }` etc. (ValueType.Error /
 * CellErrorValue in exceljs's own types). Both `cellRawDate` and
 * `cellRawNumber` check this first so an errored formula cell is treated as
 * unparseable (→ FAILED row) rather than crashing or being coerced into 0/NaN.
 */
function isCellErrorValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && "error" in value;
}

/**
 * Coerces a header-row cell's value to a trimmed string for `detectColumns`,
 * which only knows how to compare plain strings. Mirrors
 * `normalizeHeader()`'s existing trim/lowercase discipline in csv.ts —
 * lowercasing itself still happens inside `detectColumns`, this only handles
 * the Excel-specific possibility that a header cell isn't a plain string at
 * all (a number, a rich-text run, or empty) per investigation §8.
 */
function cellToHeaderString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return ""; // a date as a header is not a recognizable alias either way
  if (typeof value === "object") {
    if (isCellErrorValue(value)) return "";
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((t) => t.text).join("").trim();
    }
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value) return cellToHeaderString(value.result as ExcelJS.CellValue);
    return "";
  }
  return String(value).trim();
}

/**
 * Coerces a data cell's value to trimmed text for merchant/description/
 * category/reference fields — the Excel analog of reading a raw CSV string
 * field. Returns null for empty/unusable values (never throws).
 */
function cellToText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return null; // not a text field's shape — callers needing dates use cellRawDate
  if (typeof value === "object") {
    if (isCellErrorValue(value)) return null;
    if ("richText" in value && Array.isArray(value.richText)) {
      const text = value.richText.map((t) => t.text).join("").trim();
      return text || null;
    }
    if ("text" in value && typeof value.text === "string") {
      const text = value.text.trim();
      return text || null;
    }
    if ("result" in value) return cellToText(value.result as ExcelJS.CellValue);
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

/**
 * Converts an Excel date serial number (days since Excel's conventional
 * 1900 epoch) into a UTC-midnight Date — investigation §6 case 3, the
 * highest-risk path. Excel (for Lotus 1-2-3 compatibility) believes 1900 was
 * a leap year, so it counts a fictitious 1900-02-29 as serial 60; every real
 * serial from 61 onward is one day "ahead" of where a correct proleptic
 * count would put it. This implementation anchors on the real calendar date
 * 1899-12-31 (serial 0 in a *correct* count) and subtracts 1 from any serial
 * above the phantom day before adding it as a day offset, which has been
 * verified against known serial/date pairs (see the 4D-2 fixture validation
 * — serials 1, 59, 60, and 61 map to 1900-01-01, 1900-02-28, 1900-02-28
 * (the phantom day collapses onto the last real day before it, since it has
 * no real calendar date to map to), and 1900-03-01 respectively).
 * Returns null for non-positive or non-finite input.
 */
function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const adjusted = serial > 59 ? serial - 1 : serial;
  const epochUtcMs = Date.UTC(1899, 11, 31); // 1899-12-31, real calendar date
  return new Date(epochUtcMs + adjusted * 24 * 60 * 60 * 1000);
}

/**
 * Resolves a date cell to a Date, branching on the cell's *typed* value per
 * investigation §6:
 *   1. Already a `Date` — exceljs only produces this when a recognized
 *      date/time number format is applied; re-anchored to UTC midnight from
 *      its own UTC calendar fields rather than assumed already-correct, per
 *      §6's timezone caveat.
 *   2. A `string` — reuses `parseDate()` from csv.ts as-is (identical to the
 *      CSV case).
 *   3. A bare `number` — an unformatted serial; converted via
 *      `excelSerialToDate`.
 *   4. A formula result — recurses into `.result` (or null if errored).
 * Returns null for anything else (FAILED row), never throws.
 */
function cellRawDate(value: ExcelJS.CellValue): Date | null {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === "string") return parseDate(value);
  if (typeof value === "number") return excelSerialToDate(value);
  if (value && typeof value === "object") {
    if (isCellErrorValue(value)) return null;
    if ("result" in value) return cellRawDate(value.result as ExcelJS.CellValue);
  }
  return null;
}

/**
 * Resolves an amount/debit/credit cell to its raw numeric magnitude
 * (signConvention is applied by the caller, exactly as `normalizeRow` does
 * for the CSV single-Amount-column case — see investigation §7):
 *   1. A `number` — used directly; a genuinely numeric Excel cell already
 *      holds the true signed value regardless of display format (no
 *      $/comma/parens stripping needed, unlike CSV strings).
 *   2. A `string` — reuses `parseAmount()` from csv.ts as-is.
 *   3. A formula result — recurses into `.result`; an errored formula
 *      (`#REF!` etc.) returns null (FAILED row), never coerced into 0/NaN.
 * Returns null for anything else.
 */
function cellRawNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseAmount(value);
  if (value && typeof value === "object") {
    if (isCellErrorValue(value)) return null;
    if ("result" in value) return cellRawNumber(value.result as ExcelJS.CellValue);
  }
  return null;
}

// ── Row normalization ────────────────────────────────────────────────────

interface ResolvedColumnIndexes {
  dateCol:        number;
  merchantCol:    number | null;
  descriptionCol: number | null;
  amountCol:      number | null;
  debitCol:       number | null;
  creditCol:      number | null;
  categoryCol:    number | null;
  referenceCol:   number | null;
}

/**
 * Normalizes one Excel data row into a `NormalizedTransaction` — the typed-
 * cell analog of csv.ts's `normalizeRow()`. Field-for-field, this mirrors
 * `normalizeRow()`'s logic exactly (same debit/credit-vs-single-amount
 * branch, same signConvention application point, same merchant-or-
 * description fallback, same error precedence), just sourcing each value
 * from a typed cell via `cellRawDate`/`cellRawNumber`/`cellToText` instead
 * of a raw string field.
 */
function normalizeExcelRow(
  row: ExcelJS.Row,
  cols: ResolvedColumnIndexes,
  signConvention: SignConvention,
  lineNumber: number
): NormalizedTransaction {
  const date = cellRawDate(row.getCell(cols.dateCol).value);

  const merchantRaw    = cols.merchantCol    !== null ? cellToText(row.getCell(cols.merchantCol).value)    : null;
  const descriptionRaw = cols.descriptionCol !== null ? cellToText(row.getCell(cols.descriptionCol).value) : null;
  const merchant = merchantRaw || descriptionRaw || null;
  const description = descriptionRaw || null;

  let amount: number | null = null;
  if (cols.debitCol !== null || cols.creditCol !== null) {
    const debitVal  = cols.debitCol  !== null ? cellRawNumber(row.getCell(cols.debitCol).value)  : null;
    const creditVal = cols.creditCol !== null ? cellRawNumber(row.getCell(cols.creditCol).value) : null;
    if (debitVal === null && creditVal === null) {
      amount = null; // both blank/unparseable — treat as unparseable, not zero
    } else {
      amount = (creditVal ?? 0) - (debitVal ?? 0);
    }
  } else if (cols.amountCol !== null) {
    const parsed = cellRawNumber(row.getCell(cols.amountCol).value);
    if (parsed !== null) {
      amount = signConvention === "debitPositive" ? -parsed : parsed;
    }
  }

  const category = mapCategory(
    cols.categoryCol !== null ? cellToText(row.getCell(cols.categoryCol).value) ?? undefined : undefined
  );
  const externalTransactionId =
    cols.referenceCol !== null ? cellToText(row.getCell(cols.referenceCol).value) : null;

  let error: string | null = null;
  if (!date) error = "unparseable date";
  else if (!merchant) error = "missing merchant/description";
  else if (amount === null) error = "unparseable amount";

  return { lineNumber, date, merchant, description, category, amount, externalTransactionId, error };
}

// ── File parsing ─────────────────────────────────────────────────────────

export interface ParsedExcel {
  rows: NormalizedTransaction[];
}

/**
 * Parses an `.xlsx` workbook buffer into the same `NormalizedTransaction[]`
 * shape CSV import produces, or a file-level `{ error }` for the same class
 * of "wrong shape" problems `detectColumns`/`parseCsvText` already return for
 * CSV (investigation §8/§11): no worksheets, an empty first sheet, no
 * header row, or a header row missing a required column.
 *
 * First-worksheet-only (investigation §8) — `workbook.worksheets[1+]` are
 * never read. Header-row cells are coerced to strings and handed to
 * `detectColumns` (or, when `explicitMapping` is supplied, to
 * `applyExplicitMapping` instead — D2 Step 4D-5a, all-or-nothing, never
 * both) unmodified; the recognized header *names* either function returns
 * are then resolved back to this sheet's actual column indexes via a
 * name→index map built from the same header row — "look up by name, not
 * position," the same discipline `detectColumns` already requires of CSV,
 * called out explicitly here because it's also what makes merged header
 * cells harmless (investigation §8's structural-risk note).
 *
 * Fully empty rows (every cell empty) are skipped without being counted at
 * all — `eachRow({ includeEmpty: false })` — mirroring `Papa.parse`'s
 * `skipEmptyLines: true` behavior for CSV exactly; a row that has some
 * cells filled but is missing a required field is NOT skipped and instead
 * flows through to be classified FAILED, same as CSV.
 *
 * @param explicitMapping D2 Step 4D-5a — optional caller-supplied column
 *   mapping (same shape `csv.ts`'s `applyExplicitMapping()` accepts). When
 *   present, used instead of `detectColumns()` for this file's header
 *   resolution; absent, behavior is unchanged from 4D-2.
 */
export async function parseExcelFile(
  buffer: Buffer,
  signConvention: SignConvention,
  explicitMapping?: Record<string, string | null | undefined>
): Promise<ParsedExcel | { error: string }> {
  const workbook = new ExcelJS.Workbook();
  try {
    // Cast needed: exceljs's own dependency fast-csv pins @types/node@^14 as a
    // (non-dev) dependency, so npm nests a second, older @types/node copy
    // under node_modules/@fast-csv/{parse,format} alongside this repo's
    // top-level @types/node@^20. That makes the ambient `Buffer` type
    // exceljs's .d.ts resolves to structurally diverge from the one our own
    // Buffer.from() produces (it isn't a simple "wrong generic arg" —
    // `buffer as unknown as Buffer` still resolves to the same divergent
    // type, since the literal token `Buffer` elaborates identically on both
    // sides). skipLibCheck doesn't help: the mismatch surfaces at this call
    // site, not inside a .d.ts. `any` is the narrowest way to bypass it.
    // Buffer.from() above is a real Node Buffer at runtime regardless — this
    // only satisfies the type checker. Root cause is upstream (fast-csv); not
    // worth a tree-wide @types/node override for one call site.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
    await workbook.xlsx.load(buffer as any);
  } catch {
    return { error: "Could not parse file as an Excel (.xlsx) workbook." };
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { error: "Workbook contains no worksheets." };
  }

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  const headerIndex = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cellToHeaderString(cell.value);
    if (text) {
      headers.push(text);
      if (!headerIndex.has(text)) headerIndex.set(text, colNumber); // first occurrence wins on duplicate header text
    }
  });

  if (headers.length === 0) {
    return { error: "No header row found." };
  }

  const columns = explicitMapping
    ? applyExplicitMapping(headers, explicitMapping)
    : detectColumns(headers);
  if ("error" in columns) return columns;

  const dateCol = headerIndex.get(columns.date);
  if (dateCol === undefined) {
    // Defensive only — detectColumns returns one of the raw strings we just
    // put into headerIndex, so this should be unreachable in practice.
    return { error: "Could not locate the date column in the worksheet." };
  }

  const resolved: ResolvedColumnIndexes = {
    dateCol,
    merchantCol:    columns.merchant    ? headerIndex.get(columns.merchant)    ?? null : null,
    descriptionCol: columns.description ? headerIndex.get(columns.description) ?? null : null,
    amountCol:      columns.amount      ? headerIndex.get(columns.amount)      ?? null : null,
    debitCol:       columns.debit       ? headerIndex.get(columns.debit)       ?? null : null,
    creditCol:      columns.credit      ? headerIndex.get(columns.credit)      ?? null : null,
    categoryCol:    columns.category    ? headerIndex.get(columns.category)    ?? null : null,
    referenceCol:   columns.reference   ? headerIndex.get(columns.reference)   ?? null : null,
  };

  const rows: NormalizedTransaction[] = [];
  let dataRowIndex = 0; // 1-indexed, header row excluded — matches NormalizedTransaction.lineNumber's CSV convention
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header row, already consumed above
    dataRowIndex++;
    rows.push(normalizeExcelRow(row, resolved, signConvention, dataRowIndex));
  });

  return { rows };
}
