/**
 * lib/imports/investments/columns.ts
 *
 * A7-3 — investment header aliases + column resolution. Mirrors the banking
 * csv.ts `HEADER_ALIASES` / `detectColumns` pattern (normalizeHeader reused from
 * there, read-only) in a sibling module over the investment column vocabulary.
 * Pure: no DB, no file IO.
 */

import { normalizeHeader } from "@/lib/imports/csv";
import { INVESTMENT_COLUMN_KEYS, type InvestmentCsvColumnMap, type InvestmentImportProfile } from "./types";

/** Canonical generic aliases — the fallback when a profile doesn't override. */
export const INVESTMENT_HEADER_ALIASES: Record<keyof InvestmentCsvColumnMap, string[]> = {
  rowKind:        ["row kind", "record type", "type of record"],
  tradeDate:      ["trade date", "date", "run date", "as of date", "as-of date", "statement date", "activity date"],
  settlementDate: ["settlement date", "settle date"],
  action:         ["action", "transaction type", "activity", "description of activity"],
  symbol:         ["symbol", "ticker", "ticker symbol"],
  cusip:          ["cusip"],
  description:    ["description", "security description", "security name", "name"],
  quantity:       ["quantity", "shares", "qty", "amount of shares"],
  price:          ["price", "price (usd)", "share price"],
  grossAmount:    ["amount", "amount (usd)", "gross amount", "net amount", "total"],
  fees:           ["fees", "fees & comm", "commission", "fees and commissions"],
  currency:       ["currency", "ccy"],
  reference:      ["reference", "reference number", "transaction id", "confirmation number", "confirm number"],
  costBasis:      ["cost basis", "cost basis (usd)", "total cost"],
  lotData:        ["lot", "lots", "lot detail", "tax lot"],
};

export interface ResolvedInvestmentColumns {
  columns: InvestmentCsvColumnMap;
  /** Required fields that could not be resolved (file-level failure when non-empty). */
  missing: (keyof InvestmentCsvColumnMap)[];
}

/**
 * Resolve a file's headers to the canonical investment columns using the
 * profile's aliases first, then the generic table. `symbol` and `tradeDate` are
 * the only hard requirements (a positions statement still has both). `action`
 * and `quantity` are strongly expected for transactions but their absence is a
 * per-row concern (a missing action ⇒ UNKNOWN), not a file-level reject.
 */
export function resolveInvestmentColumns(
  headers: string[],
  profile: InvestmentImportProfile,
): ResolvedInvestmentColumns {
  const norm = headers.map((h) => ({ raw: h, n: normalizeHeader(h) }));
  const find = (aliases: string[] | undefined): string | null => {
    if (!aliases) return null;
    for (const a of aliases) {
      const hit = norm.find((h) => h.n === normalizeHeader(a));
      if (hit) return hit.raw;
    }
    return null;
  };

  const columns = {} as InvestmentCsvColumnMap;
  for (const key of INVESTMENT_COLUMN_KEYS) {
    columns[key] = find(profile.columnAliases[key]) ?? find(INVESTMENT_HEADER_ALIASES[key]);
  }

  const missing: (keyof InvestmentCsvColumnMap)[] = [];
  if (!columns.tradeDate) missing.push("tradeDate");
  if (!columns.symbol)    missing.push("symbol");
  return { columns, missing };
}
