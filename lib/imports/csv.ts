/**
 * lib/imports/csv.ts
 *
 * D2 Step 4D-1 — CSV import MVP. Pure parsing/normalization/classification
 * helpers for app/api/accounts/[id]/import/route.ts. Deliberately CSV-only
 * and deliberately not a generic "ImportAdapter" — see
 * docs/initiatives/d2/D2_STEP4D1_CSV_IMPORT_MVP_INVESTIGATION.md. A future
 * Excel/QuickBooks source (D2 Step 4D-2+) is expected to get its own
 * sibling module, not a forced shared interface bolted on here. (In
 * practice, lib/imports/excel.ts reuses detectColumns()/applyExplicitMapping()
 * directly rather than duplicating them — see that file's own header.)
 *
 * D2 Step 4D-5a added applyExplicitMapping() — a caller-supplied alternative
 * to detectColumns() for the same column-resolution stage, used all-or-
 * nothing when supplied — and renamed NormalizedRow to NormalizedTransaction
 * (mechanical, compile-time-only; see
 * docs/initiatives/d2/D2_STEP4D5A_IMPLEMENTATION_PLAN.md). No change to
 * HEADER_ALIASES, detectColumns()'s own logic, or normalizeRow()'s body.
 *
 * Scope notes:
 * - No modifications to lib/transactions/fingerprint.ts. findByFingerprint()
 *   is called as-is for the MATCH path; normalizeMerchantKey() is reused
 *   as-is for the SKIP (ambiguous match) refinement findByFingerprint()
 *   doesn't itself expose. See resolveFingerprintOutcome() below.
 * - No rollback path, no background jobs, no provider abstraction layer.
 */

import Papa from "papaparse";
import { TransactionCategory } from "@prisma/client";
import { db } from "@/lib/db";
import { findByFingerprint, normalizeMerchantKey } from "@/lib/transactions/fingerprint";

export type SignConvention = "creditPositive" | "debitPositive";

// ── Header detection ──────────────────────────────────────────────────────────

export interface CsvColumnMap {
  date:        string;
  merchant:    string | null; // merchant or description — at least one required
  description: string | null;
  amount:      string | null; // single signed-amount column
  debit:       string | null; // paired debit/credit columns (sign-unambiguous)
  credit:      string | null;
  category:    string | null;
  reference:   string | null; // externalTransactionId source
}

const HEADER_ALIASES: Record<keyof Omit<CsvColumnMap, never>, string[]> = {
  date:        ["date", "transaction date", "posted date", "post date"],
  merchant:    ["merchant", "payee"],
  description: ["description", "memo", "details", "name"],
  amount:      ["amount", "transaction amount"],
  debit:       ["debit", "withdrawal", "money out", "debit amount"],
  credit:      ["credit", "deposit", "money in", "credit amount"],
  category:    ["category", "type"],
  reference:   ["reference", "reference number", "transaction id", "check number", "ref no", "id"],
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolves a parsed CSV's headers against known aliases. Returns an error
 * (file-level, not row-level) if the minimum required columns are missing:
 * a date column, an amount source (single amount OR a debit/credit pair),
 * and a merchant-or-description column. This check happens before any
 * ImportBatch row is created — a file with the wrong shape never becomes a
 * batch (see D2_STEP4D1_CSV_IMPORT_MVP_INVESTIGATION.md §8).
 */
export function detectColumns(headers: string[]): CsvColumnMap | { error: string } {
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  function find(aliases: string[]): string | null {
    for (const alias of aliases) {
      const hit = normalized.find((h) => h.norm === alias);
      if (hit) return hit.raw;
    }
    return null;
  }

  const date        = find(HEADER_ALIASES.date);
  const merchant    = find(HEADER_ALIASES.merchant);
  const description = find(HEADER_ALIASES.description);
  const amount      = find(HEADER_ALIASES.amount);
  const debit       = find(HEADER_ALIASES.debit);
  const credit      = find(HEADER_ALIASES.credit);
  const category    = find(HEADER_ALIASES.category);
  const reference    = find(HEADER_ALIASES.reference);

  if (!date) {
    return { error: "Could not find a date column. Expected one of: " + HEADER_ALIASES.date.join(", ") + "." };
  }
  if (!merchant && !description) {
    return { error: "Could not find a merchant or description column." };
  }
  if (!amount && !(debit || credit)) {
    return { error: "Could not find an amount column (or a Debit/Credit pair)." };
  }

  return { date, merchant, description, amount, debit, credit, category, reference };
}

// ── Explicit column mapping (D2 Step 4D-5a) ─────────────────────────────────────

/**
 * The CsvColumnMap fields a caller-supplied mapping may target in 4D-5a.
 * Deliberately the same 8 fields CsvColumnMap already has — transactionType/
 * balanceAfter/currency/rawMetadata are NOT supported here: they don't exist
 * on NormalizedTransaction yet, and nothing downstream reads them, so wiring
 * mapping support for them now would be dead plumbing. See
 * docs/initiatives/d2/D2_STEP4D5A_IMPLEMENTATION_PLAN.md §3. Kept as an
 * explicit list (not derived from HEADER_ALIASES) so the accepted key set is
 * visible at a glance and decoupled from HEADER_ALIASES's own shape.
 */
const MAPPABLE_FIELDS = [
  "date", "merchant", "description", "amount", "debit", "credit", "category", "reference",
] as const;
type MappableField = (typeof MAPPABLE_FIELDS)[number];

/**
 * Resolves a caller-supplied explicit column mapping against a file's real
 * headers, as an alternative to detectColumns()'s alias-based auto-
 * detection — same return shape (CsvColumnMap | { error }), same required-
 * field rules, so callers (the import route, parseExcelFile()) can use
 * either interchangeably without any other code changing.
 *
 * All-or-nothing by construction: there is no fallback to HEADER_ALIASES
 * inside this function for an unmapped field — a field the caller didn't
 * map simply resolves to null, exactly as if detectColumns() hadn't found
 * an alias for it either. Callers decide whether to call this function or
 * detectColumns(), never both for the same request (D2_STEP4D5A_
 * IMPLEMENTATION_PLAN.md §2).
 *
 * Validates, in order:
 *   1. every key in `mapping` is a recognized field name (MAPPABLE_FIELDS);
 *   2. every non-null mapped value matches one of `headers` (same
 *      normalizeHeader() comparison detectColumns() uses — case/whitespace-
 *      insensitive, exact match, not substring);
 *   3. the same required-field rules detectColumns() enforces: date; at
 *      least one of merchant/description; at least one of amount or a
 *      debit/credit pair.
 *
 * Resolved values are the file's actual header strings (not the caller's
 * copy of them) — normalizeRow()/normalizeExcelRow() look up raw row values
 * by exact header string, so this must match detectColumns()'s own
 * resolved-value convention exactly.
 */
export function applyExplicitMapping(
  headers: string[],
  mapping: Record<string, string | null | undefined>
): CsvColumnMap | { error: string } {
  for (const key of Object.keys(mapping)) {
    if (!(MAPPABLE_FIELDS as readonly string[]).includes(key)) {
      return { error: `Unrecognized column mapping field: "${key}".` };
    }
  }

  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const resolved: Record<MappableField, string | null> = {
    date: null, merchant: null, description: null, amount: null,
    debit: null, credit: null, category: null, reference: null,
  };

  for (const field of MAPPABLE_FIELDS) {
    const requested = mapping[field];
    if (!requested || !requested.trim()) continue; // not mapped — stays null, same as a detectColumns() miss
    const hit = normalizedHeaders.find((h) => h.norm === normalizeHeader(requested));
    if (!hit) {
      return { error: `Mapped column "${requested}" for field "${field}" was not found in the file's headers.` };
    }
    resolved[field] = hit.raw;
  }

  const date = resolved.date;
  if (!date) {
    return { error: "Column mapping did not specify a date column." };
  }
  if (!resolved.merchant && !resolved.description) {
    return { error: "Column mapping did not specify a merchant or description column." };
  }
  if (!resolved.amount && !(resolved.debit || resolved.credit)) {
    return { error: "Column mapping did not specify an amount column, or a debit/credit pair." };
  }

  return { ...resolved, date };
}

// ── File parsing ──────────────────────────────────────────────────────────────

export interface ParsedCsv {
  headers: string[];
  rows:    Record<string, string>[];
}

/**
 * Wraps Papa.parse for the synchronous, in-memory MVP case (no streaming —
 * see investigation §4 on file-size scope). Throws if the file has no
 * recognizable header row at all; a header-only file (zero data rows) is
 * NOT an error here — that's a valid, empty import handled by the caller.
 */
export function parseCsvText(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text, {
    header:          true,
    skipEmptyLines:  true,
    transformHeader: (h) => h.trim(),
  });

  const headers = result.meta.fields ?? [];
  if (headers.length === 0) {
    throw new Error("No header row found.");
  }

  return { headers, rows: result.data };
}

// ── Field-level parsing ────────────────────────────────────────────────────────

/**
 * Parses a date in either ISO (YYYY-MM-DD) or US (M/D/YYYY or MM/DD/YYYY)
 * form into a UTC midnight Date. Manual Date.UTC construction rather than
 * `new Date(str)` — the latter is timezone-ambiguous for the US-slash form
 * (parsed in the server's local timezone) while being UTC for the ISO form,
 * which would silently shift dates near midnight depending on which format
 * a given file happens to use. Returns null for anything else (FAILED row).
 */
export function parseDate(raw: string): Date | null {
  const value = raw.trim();

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/**
 * Parses a currency-formatted amount string: strips $ and thousands
 * separators, treats parenthesized values as negative (common accounting
 * export convention, e.g. "(12.34)" = -12.34). Returns null if not a
 * parseable number (FAILED row).
 */
export function parseAmount(raw: string): number | null {
  let value = raw.trim();
  if (value === "") return null;

  let negative = false;
  if (value.startsWith("(") && value.endsWith(")")) {
    negative = true;
    value = value.slice(1, -1);
  }

  value = value.replace(/[$,\s]/g, "");
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }

  if (value === "" || !/^\d*\.?\d+$/.test(value)) return null;

  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) return null;

  return negative ? -parsed : parsed;
}

const CATEGORY_ALIASES: { match: string[]; category: TransactionCategory }[] = [
  { match: ["income", "payroll", "deposit", "salary"],        category: TransactionCategory.Income },
  { match: ["transfer"],                                       category: TransactionCategory.Transfer },
  { match: ["groceries", "grocery", "supermarket"],            category: TransactionCategory.Groceries },
  { match: ["dining", "restaurant", "food"],                   category: TransactionCategory.Dining },
  { match: ["shopping", "merchandise", "retail"],               category: TransactionCategory.Shopping },
  { match: ["travel"],                                          category: TransactionCategory.Travel },
  { match: ["subscription"],                                    category: TransactionCategory.Subscriptions },
  { match: ["utilities", "utility", "rent"],                    category: TransactionCategory.Utilities },
  { match: ["interest"],                                        category: TransactionCategory.Interest },
  { match: ["payment", "loan"],                                 category: TransactionCategory.Payment },
];

/**
 * Maps a free-text category string to TransactionCategory via substring
 * matching, falling back to Other for anything unrecognized or absent.
 * Mirrors mapPlaidCategory()'s legacy-fallback philosophy in
 * lib/plaid/syncTransactions.ts — an unmapped category should never block
 * an import, only fall back to a safe default.
 */
export function mapCategory(raw: string | undefined): TransactionCategory {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return TransactionCategory.Other;

  for (const { match, category } of CATEGORY_ALIASES) {
    if (match.some((m) => value.includes(m))) return category;
  }
  return TransactionCategory.Other;
}

// ── Row normalization ─────────────────────────────────────────────────────────

export interface NormalizedTransaction {
  lineNumber:            number; // 1-indexed data row, header row excluded (line 1 = first data row)
  date:                  Date | null;
  merchant:              string | null;
  description:           string | null;
  category:              TransactionCategory;
  amount:                number | null;
  externalTransactionId: string | null;
  error:                 string | null;
}

/**
 * Normalizes one raw CSV row into typed fields, or sets `.error` (and leaves
 * date/merchant/amount as null) if the row is unusable. The caller treats
 * any row with `.error` set, or with date/merchant/amount still null, as
 * FAILED — it never throws, consistent with "never abort the whole batch
 * over one bad row" (investigation §8).
 */
export function normalizeRow(
  raw: Record<string, string>,
  columns: CsvColumnMap,
  signConvention: SignConvention,
  lineNumber: number
): NormalizedTransaction {
  const dateRaw = raw[columns.date] ?? "";
  const date = parseDate(dateRaw);

  const merchantRaw    = columns.merchant ? raw[columns.merchant]?.trim() : "";
  const descriptionRaw = columns.description ? raw[columns.description]?.trim() : "";
  const merchant = merchantRaw || descriptionRaw || null;
  const description = descriptionRaw || null;

  let amount: number | null = null;
  if (columns.debit || columns.credit) {
    const debitVal  = columns.debit  ? parseAmount(raw[columns.debit]  ?? "") : null;
    const creditVal = columns.credit ? parseAmount(raw[columns.credit] ?? "") : null;
    if (debitVal === null && creditVal === null) {
      amount = null; // both blank — treat as unparseable, not zero
    } else {
      amount = (creditVal ?? 0) - (debitVal ?? 0);
    }
  } else if (columns.amount) {
    const parsed = parseAmount(raw[columns.amount] ?? "");
    if (parsed !== null) {
      amount = signConvention === "debitPositive" ? -parsed : parsed;
    }
  }

  const category = mapCategory(columns.category ? raw[columns.category] : undefined);
  const externalTransactionId = columns.reference ? (raw[columns.reference]?.trim() || null) : null;

  let error: string | null = null;
  if (!date)      error = `unparseable date "${dateRaw}"`;
  else if (!merchant) error = "missing merchant/description";
  else if (amount === null) error = "unparseable amount";

  return { lineNumber, date, merchant, description, category, amount, externalTransactionId, error };
}

// ── Fingerprint classification ────────────────────────────────────────────────

export type FingerprintOutcome =
  | { outcome: "CREATE" }
  | { outcome: "MATCH"; transactionId: string }
  | { outcome: "SKIP"; reason: string };

/**
 * Resolves what should happen with one normalized row against existing
 * Transaction history:
 *
 *   1. Exact externalTransactionId match (scoped to this account — no
 *      unique constraint exists on this column yet, see schema comment on
 *      Transaction.externalTransactionId from D2 Step 4B).
 *   2. lib/transactions/fingerprint.ts's findByFingerprint() — the same
 *      helper Plaid sync uses (D2 Step 4C). Used as-is, unmodified.
 *   3. CSV-specific refinement findByFingerprint() doesn't expose: is the
 *      match ambiguous (more than one existing row shares
 *      date+amount+pending+normalized-merchant)? findByFingerprint() picks
 *      the first deterministically and logs a warning; for an import we'd
 *      rather surface that ambiguity as a SKIPPED row than silently treat
 *      it as a clean match. Reuses normalizeMerchantKey() (the same
 *      normalization findByFingerprint() applies internally) rather than
 *      re-deriving equality a different way — see
 *      D2_STEP4D1_CSV_IMPORT_MVP_INVESTIGATION.md §7, option (ii), but
 *      implemented as new code here rather than as a change to
 *      fingerprint.ts itself.
 */
export async function resolveFingerprintOutcome(
  financialAccountId: string,
  date: Date,
  amount: number,
  merchant: string,
  externalTransactionId: string | null
): Promise<FingerprintOutcome> {
  if (externalTransactionId) {
    // deletedAt: null — D2 Step 4D-R: a row soft-deleted by an import
    // rollback must not be treated as an exact match, or re-importing the
    // same file after a rollback would silently no-op instead of recreating
    // the row. See
    // docs/initiatives/d2/D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md §3.
    const exact = await db.transaction.findFirst({
      where:  { financialAccountId, externalTransactionId, deletedAt: null },
      select: { id: true },
    });
    if (exact) return { outcome: "MATCH", transactionId: exact.id };
  }

  const fpMatch = await findByFingerprint(financialAccountId, date, amount, merchant, false);
  if (!fpMatch) return { outcome: "CREATE" };

  // deletedAt: null — same rationale as above. This candidate set must agree
  // with findByFingerprint()'s own (also deletedAt: null, D2 Step 4D-R)
  // candidate set, or the two could disagree on whether a match is
  // ambiguous.
  const candidates = await db.transaction.findMany({
    where:  { financialAccountId, date, amount, pending: false, deletedAt: null },
    select: { id: true, merchant: true },
  });
  const target  = normalizeMerchantKey(merchant);
  const matches = candidates.filter((c) => normalizeMerchantKey(c.merchant) === target);

  if (matches.length > 1) {
    return { outcome: "SKIP", reason: `ambiguous fingerprint match (${matches.length} existing rows)` };
  }
  return { outcome: "MATCH", transactionId: fpMatch.id };
}
