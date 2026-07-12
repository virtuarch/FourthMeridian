/**
 * lib/imports/investments/types.ts
 *
 * A7-3 — the pure investment-import contract. A SIBLING of the banking
 * lib/imports/csv.ts shapes, never a widening of them: the banking `CsvColumnMap`
 * (8 keys) stays load-bearing and untouched; investment files carry a different
 * column vocabulary (symbol, quantity, action, …), so they get their own map.
 *
 * Nothing here touches a database, a route, or React — this whole module family
 * is DB-free and unit-testable (investigation §3.4). The commit path (A7-4)
 * consumes `NormalizedInvestmentRow[]` and turns them into InvestmentEvent /
 * PositionObservation rows; this file only defines what a parsed, mapped,
 * deduped row looks like.
 */

import type { InvestmentEventType } from "@prisma/client";

/** A file row is either dated activity or a holdings-statement line. */
export type InvestmentRowKind = "TRANSACTION" | "POSITION";

/**
 * Canonical investment column contract (investigation §3.3). Each value is the
 * raw header name in the file that supplies that field (or null when absent).
 * Deliberately NOT the banking `CsvColumnMap` — see the module header.
 */
export interface InvestmentCsvColumnMap {
  rowKind:        string | null; // a column stating TRANSACTION|POSITION (else profile default)
  tradeDate:      string | null; // trade date (transactions) / statement date (positions)
  settlementDate: string | null;
  action:         string | null; // raw broker action string
  symbol:         string | null; // ticker
  cusip:          string | null;
  description:    string | null; // security name / institution text (verbatim)
  quantity:       string | null;
  price:          string | null;
  grossAmount:    string | null; // cash leg
  fees:           string | null;
  currency:       string | null;
  reference:      string | null; // broker confirm/txn number → externalEventId
  costBasis:      string | null; // positions / openings: aggregate basis
  lotData:        string | null; // preserved verbatim, NEVER interpreted
}

/** The keys the resolver/aliaser iterate over. */
export const INVESTMENT_COLUMN_KEYS: (keyof InvestmentCsvColumnMap)[] = [
  "rowKind", "tradeDate", "settlementDate", "action", "symbol", "cusip",
  "description", "quantity", "price", "grossAmount", "fees", "currency",
  "reference", "costBasis", "lotData",
];

/**
 * How a raw broker action string maps to a canonical type and the sign
 * conventions for that action. Signs are per-action because brokers export
 * unsigned magnitudes and let the action carry direction (Schwab "Buy" +shares /
 * cash out; "Sell" −shares / cash in).
 *   qty/cash: "in" ⇒ +|value|, "out" ⇒ −|value|, "signed" ⇒ keep the file's
 *   sign, "none" ⇒ this action has no quantity / no cash leg.
 */
export interface ActionRule {
  type: InvestmentEventType;
  qty:  "in" | "out" | "signed" | "none";
  cash: "in" | "out" | "signed" | "none";
}

/**
 * A broker profile is DATA, not code (investigation §3.2): header aliases + an
 * action→ActionRule table + a version. Each additional broker is a table +
 * fixtures, never a code branch.
 */
export interface InvestmentImportProfile {
  /** Profile-keyed source, e.g. "csv:schwab" — never a bare "csv" (dedupe keys). */
  key:            string;
  label:          string;
  profileVersion: number;
  /** Per-field header aliases (normalized, lowercased). */
  columnAliases:  Partial<Record<keyof InvestmentCsvColumnMap, string[]>>;
  /** Normalized raw-action string → canonical rule. Missing ⇒ UNKNOWN (total). */
  actionTable:    Record<string, ActionRule>;
  /** Default row kind when no rowKind column exists. */
  defaultRowKind: InvestmentRowKind;
}

/**
 * A parsed, mapped, sign-normalized investment row — the pure pipeline's output
 * unit. `importedRaw` preserves the COMPLETE original row verbatim (header→cell)
 * so re-interpretation and honest display are possible forever, and lot detail
 * we refuse to interpret rides here untouched. A row is NEVER dropped: an
 * unmappable action becomes type UNKNOWN with a warning and its raws intact.
 */
export interface NormalizedInvestmentRow {
  lineNumber:      number;              // 1-indexed data row
  rowKind:         InvestmentRowKind;
  date:            string | null;       // YYYY-MM-DD (trade/statement date)
  settlementDate:  string | null;
  /** Canonical event type for TRANSACTION rows; null for POSITION rows. */
  type:            InvestmentEventType | null;
  rawAction:       string | null;       // verbatim action string
  symbol:          string | null;
  cusip:           string | null;
  description:     string | null;
  quantity:        number | null;       // FM signed (+in / −out) per the action rule
  price:           number | null;
  amount:          number | null;       // cash leg, FM signed (+in / −out)
  fees:            number | null;       // ≥ 0 or null
  currency:        string | null;
  reference:       string | null;       // broker ref → externalEventId when present
  costBasis:       number | null;
  ratio:           number | null;       // corporate-action ratio when the file states one
  externalEventId: string;              // deterministic row identity (row-identity.ts)
  importedRaw:     Record<string, string>; // verbatim original row
  error:           string | null;       // parse failure ⇒ FAILED row
  warnings:        string[];            // e.g. "unmapped-action", "split-without-ratio"
}
