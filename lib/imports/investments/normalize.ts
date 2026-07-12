/**
 * lib/imports/investments/normalize.ts
 *
 * A7-3 — the TOTAL row normalizer. Given a parsed raw row (header→cell strings),
 * a resolved column map, and a profile, produce a NormalizedInvestmentRow:
 *   - the raw action mapped to a canonical type via the profile's table, with FM
 *     sign applied to quantity and the cash leg;
 *   - an UNMAPPABLE action ⇒ type UNKNOWN + a "unmapped-action" warning, NEVER a
 *     dropped row (totality);
 *   - the COMPLETE original row preserved verbatim in importedRaw (incl. lot
 *     detail, which is preserved and NEVER interpreted);
 *   - a parse failure (bad date, unparseable quantity where required) ⇒ a FAILED
 *     row (error set), still returned, never silently dropped.
 *
 * Pure: reuses parseAmount/parseDate from the banking csv.ts (read-only), no DB.
 */

import { InvestmentEventType } from "@prisma/client";
import { parseAmount, parseDate } from "@/lib/imports/csv";
import { deriveExternalEventIds, type RowIdentityInput } from "./row-identity";
import type {
  ActionRule, InvestmentCsvColumnMap, InvestmentImportProfile,
  InvestmentRowKind, NormalizedInvestmentRow,
} from "./types";

const normAction = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

/** Apply an FM sign convention to a magnitude/signed value. */
function applySign(kind: "in" | "out" | "signed" | "none", value: number | null): number | null {
  if (kind === "none" || value == null) return null;
  if (kind === "signed") return value;
  const mag = Math.abs(value);
  return kind === "in" ? mag : -mag;
}

const cell = (row: Record<string, string>, header: string | null): string =>
  (header && row[header] != null ? String(row[header]) : "").trim();

/** Resolve a row's kind from an explicit column, else the profile default. */
function rowKindOf(raw: string, columns: InvestmentCsvColumnMap, profile: InvestmentImportProfile): InvestmentRowKind {
  const v = cell({ [columns.rowKind ?? ""]: raw }, columns.rowKind).toUpperCase();
  if (v === "POSITION" || v === "HOLDING") return "POSITION";
  if (v === "TRANSACTION" || v === "ACTIVITY") return "TRANSACTION";
  return profile.defaultRowKind;
}

/**
 * Normalize a whole parsed file (the ordinal in row-identity needs the file-wide
 * view). `rowKindOverride` lets the caller force POSITION for a statement import
 * that has no per-row kind column.
 */
export function normalizeInvestmentRows(
  rawRows: Record<string, string>[],
  columns: InvestmentCsvColumnMap,
  profile: InvestmentImportProfile,
  rowKindOverride?: InvestmentRowKind,
): NormalizedInvestmentRow[] {
  const idInputs: RowIdentityInput[] = rawRows.map((row) => ({
    tradeDate:   cell(row, columns.tradeDate),
    rawAction:   cell(row, columns.action),
    symbol:      cell(row, columns.symbol),
    quantity:    cell(row, columns.quantity),
    grossAmount: cell(row, columns.grossAmount),
    price:       cell(row, columns.price),
    reference:   cell(row, columns.reference),
  }));
  const externalIds = deriveExternalEventIds(idInputs);

  return rawRows.map((row, i) => {
    const warnings: string[] = [];
    const rowKind = rowKindOverride ?? (columns.rowKind
      ? rowKindOf(cell(row, columns.rowKind), columns, profile)
      : profile.defaultRowKind);

    const rawDate = cell(row, columns.tradeDate);
    const parsedDate = rawDate ? parseDate(rawDate) : null;
    let error: string | null = null;
    if (rawDate && !parsedDate) { error = `Unparseable date "${rawDate}".`; warnings.push("bad-date"); }
    if (!rawDate) { error = "Missing date."; }

    const rawAction = cell(row, columns.action) || null;
    const symbol = cell(row, columns.symbol) || null;

    const rawQty = parseAmount(cell(row, columns.quantity));
    const rawAmount = parseAmount(cell(row, columns.grossAmount));
    const price = parseAmount(cell(row, columns.price));
    const feesRaw = parseAmount(cell(row, columns.fees));
    const costBasis = parseAmount(cell(row, columns.costBasis));
    const currency = cell(row, columns.currency) || null;
    const cusip = cell(row, columns.cusip) || null;
    const description = cell(row, columns.description) || null;
    const reference = cell(row, columns.reference) || null;

    let type: InvestmentEventType | null = null;
    let quantity: number | null = rawQty;
    let amount: number | null = rawAmount;

    if (rowKind === "TRANSACTION") {
      const rule: ActionRule | undefined = rawAction ? profile.actionTable[normAction(rawAction)] : undefined;
      if (rule) {
        type = rule.type;
        quantity = applySign(rule.qty, rawQty);
        amount = applySign(rule.cash, rawAmount);
        if (type === InvestmentEventType.SPLIT) warnings.push("split-without-ratio");
      } else {
        type = InvestmentEventType.UNKNOWN;
        // Preserve the file's own signs verbatim — we could not interpret it.
        quantity = rawQty;
        amount = rawAmount;
        warnings.push("unmapped-action");
      }
    } else {
      // POSITION rows are holdings anchors (observations), not events — no type,
      // quantity is the unsigned held amount, no cash leg.
      quantity = rawQty != null ? Math.abs(rawQty) : null;
      amount = null;
    }

    if (cell(row, columns.lotData)) warnings.push("lot-data-preserved");

    return {
      lineNumber: i + 1,
      rowKind,
      date: parsedDate ? ymd(parsedDate) : null,
      settlementDate: (() => { const s = cell(row, columns.settlementDate); const d = s ? parseDate(s) : null; return d ? ymd(d) : null; })(),
      type,
      rawAction,
      symbol,
      cusip,
      description,
      quantity,
      price,
      amount,
      fees: feesRaw != null ? Math.abs(feesRaw) : null,
      currency,
      reference,
      costBasis,
      ratio: null, // a simple CSV states no split ratio; corporate-action depth is A7-7
      externalEventId: externalIds[i],
      importedRaw: { ...row },
      error,
      warnings,
    };
  });
}
