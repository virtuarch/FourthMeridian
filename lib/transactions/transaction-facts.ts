/**
 * lib/transactions/transaction-facts.ts
 *
 * Transaction Intelligence — durable single-row facts (TI2).
 *
 * TI2-3 adds the PURE fact builder `buildTransactionFacts` — the TI analogue of
 * `buildFlowWriteFields` (lib/transactions/plaid-flow-input.ts). It derives the
 * approved TI2 facts from captured metadata + context. It is NOT wired into any
 * write path yet (TI2-4/5). No DB, no IO, no logging, no Date.now, never throws.
 *
 * Design contract (mirrors buildFlowWriteFields / flow-classifier.ts):
 *  - PURE & DETERMINISTIC: same input → same output; no side effects.
 *  - PRISMA-FREE AT RUNTIME: Prisma enum types are imported type-only (erased),
 *    values are string literals compile-guarded by `Record<…, PrismaEnum>` maps,
 *    so the module — and its tsx test — needs no `prisma generate`.
 *  - NEVER THROWS: unmappable/absent inputs degrade to null (unknown provenance)
 *    or the enum's UNKNOWN member (captured but out of vocabulary) — never an
 *    exception, mirroring the classifier's honesty valve.
 */

import type {
  PaymentChannel as PrismaPaymentChannel,
  PaymentMethod as PrismaPaymentMethod,
  SettlementState as PrismaSettlementState,
  CounterpartyType as PrismaCounterpartyType,
} from "@prisma/client";
import type { CapturedPlaidMetadata } from "./plaid-flow-input";

/**
 * Version of the TI2 durable-fact computation. Persisted on each stamped row
 * (Transaction.tiFactsVersion) so a later, improved fact builder can re-run over
 * only stale rows (`WHERE tiFactsVersion < TI_FACTS_VERSION`) without disturbing
 * higher-version ones — the same selective-backfill pattern as
 * FLOW_CLASSIFIER_VERSION (lib/transactions/flow-classifier.ts). Bump this
 * whenever the fact-derivation rules change.
 *   1 = TI2 initial ruleset.
 */
export const TI_FACTS_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Output shape — the exact TI2 columns the write path (TI2-4/5) will persist.
// ─────────────────────────────────────────────────────────────────────────────

/** The exact subset of Transaction columns TI2 writes. All nullable. */
export interface TransactionFactFields {
  paymentChannel:        PrismaPaymentChannel | null;
  paymentMethod:         PrismaPaymentMethod | null;
  settlementState:       PrismaSettlementState | null;
  authorizedAt:          Date | null;
  counterpartyType:      PrismaCounterpartyType | null;
  fxApplied:             boolean | null;
  pendingTransactionRef: string | null;
  tiFactsVersion:        number | null;
}

/**
 * All-null facts — the degradation fallback (mirrors NULL_FLOW_WRITE_FIELDS), so
 * a write can persist the row with no TI facts and never block. `tiFactsVersion`
 * is null here: "no facts computed", distinct from a stamped row.
 */
export const NULL_TRANSACTION_FACTS: TransactionFactFields = {
  paymentChannel:        null,
  paymentMethod:         null,
  settlementState:       null,
  authorizedAt:          null,
  counterpartyType:      null,
  fxApplied:             null,
  pendingTransactionRef: null,
  tiFactsVersion:        null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Input shape
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the pure builder needs; all already in memory on the write path. */
export interface TransactionFactsInput {
  /** The TI2-2 captured metadata sidecar (may be sparse / absent fields). */
  captured:        CapturedPlaidMetadata;
  /** Transaction.pending — the settlement state input. */
  pending:         boolean;
  /** Transaction.currency (row denomination), for fxApplied. */
  rowCurrency:     string | null;
  /** Parent account's currency, for fxApplied. */
  accountCurrency: string | null;
  /** Already-computed flow classification, for the INTERNAL_TRANSFER method rule. */
  flowType?:       string | null;
  flowDirection?:  string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

// ── paymentChannel ────────────────────────────────────────────────────────────
// Plaid payment_channel values are "online" / "in store" / "other".
function derivePaymentChannel(raw: string | null | undefined): PrismaPaymentChannel | null {
  const v = norm(raw);
  if (v === "") return null;                 // not captured → unknown provenance
  if (v === "online")   return "ONLINE";
  if (v === "in store") return "IN_STORE";
  if (v === "other")    return "OTHER";
  return "UNKNOWN";                          // captured but out of vocabulary
}

// ── counterpartyType ──────────────────────────────────────────────────────────
// Provider subset only (Plaid counterparties[].type). "owned account" is TI4.
const COUNTERPARTY_TYPE_MAP: Record<string, PrismaCounterpartyType> = {
  merchant:               "MERCHANT",
  financial_institution:  "FINANCIAL_INSTITUTION",
  income_source:          "INCOME_SOURCE",
  payment_app:            "PAYMENT_APP",
  marketplace:            "MARKETPLACE",
  payment_terminal:       "PAYMENT_TERMINAL",
};

function deriveCounterpartyType(captured: CapturedPlaidMetadata): PrismaCounterpartyType | null {
  const first = captured.counterparties?.[0];
  if (!first) return null;                   // no counterparty captured → unknown
  return COUNTERPARTY_TYPE_MAP[norm(first.type)] ?? "UNKNOWN";
}

// ── settlementState ───────────────────────────────────────────────────────────
// TI2 owns pending/posted only. REVERSED/VOIDED are TI4 (not derivable here).
function deriveSettlementState(pending: boolean): PrismaSettlementState {
  return pending ? "PENDING" : "POSTED";
}

// ── authorizedAt ──────────────────────────────────────────────────────────────
// Pass through captured Plaid authorized_date ("YYYY-MM-DD"). Pure, guarded so a
// malformed value degrades to null instead of an Invalid Date.
function deriveAuthorizedAt(raw: string | null | undefined): Date | null {
  const v = (raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

// ── fxApplied ─────────────────────────────────────────────────────────────────
// Intrinsic FX event: row currency vs its account's currency. Unknown → null.
function deriveFxApplied(rowCurrency: string | null, accountCurrency: string | null): boolean | null {
  const a = norm(rowCurrency);
  const b = norm(accountCurrency);
  if (a === "" || b === "") return null;     // can't compare → honest null
  return a !== b;
}

// ── paymentMethod ─────────────────────────────────────────────────────────────
// Approved, deliberately conservative precedence. Never fabricates certainty:
// anything unrecognized falls through to UNKNOWN.
function derivePaymentMethod(input: TransactionFactsInput): PrismaPaymentMethod {
  const c = input.captured;
  const check = (c.checkNumber ?? "").trim();
  const meta  = norm(c.paymentMetaMethod);
  const code  = norm(c.transactionCode);
  const chan  = derivePaymentChannel(c.paymentChannel);

  // 1. A check number present → CHECK.
  if (check !== "") return "CHECK";

  // 2. Explicit instrument from payment_meta.payment_method / transaction_code.
  if (meta.includes("ach") || code === "direct debit")          return "ACH";
  if (meta.includes("wire") || code === "wire")                 return "WIRE";
  if (meta.includes("check") || meta.includes("cheque") || code === "cheque") return "CHECK";
  if (meta.includes("cash") || code === "cash" || code === "atm" || code === "cashback") return "CASH";

  // 3. INTERNAL_TRANSFER only when the flow context clearly says so.
  if ((input.flowType === "TRANSFER" || input.flowType === "DEBT_PAYMENT") &&
      input.flowDirection === "INTERNAL") {
    return "INTERNAL_TRANSFER";
  }

  // 4. CARD when a provider signal supports it (explicit card method, a purchase
  //    code, or an in-store channel). ONLINE alone is NOT enough (could be ACH).
  if (meta.includes("card") || meta.includes("debit") || meta.includes("credit") ||
      code === "purchase" || chan === "IN_STORE") {
    return "CARD";
  }

  // 5. Otherwise honestly UNKNOWN.
  return "UNKNOWN";
}

// ─────────────────────────────────────────────────────────────────────────────
// buildTransactionFacts — the single authoritative TI2 fact builder.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the approved TI2 durable facts from captured metadata + context.
 * Pure, deterministic, never throws. NOT wired into any write path yet (TI2-4/5).
 */
export function buildTransactionFacts(input: TransactionFactsInput): TransactionFactFields {
  const c = input.captured;
  return {
    paymentChannel:        derivePaymentChannel(c.paymentChannel),
    paymentMethod:         derivePaymentMethod(input),
    settlementState:       deriveSettlementState(input.pending),
    authorizedAt:          deriveAuthorizedAt(c.authorizedDate),
    counterpartyType:      deriveCounterpartyType(c),
    fxApplied:             deriveFxApplied(input.rowCurrency, input.accountCurrency),
    pendingTransactionRef: c.pendingTransactionRef ?? null,
    tiFactsVersion:        TI_FACTS_VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TI3 — historical backfill (row-backed).
//
// Historical rows have NO captured provider metadata (payment_channel etc. were
// never stored), so only the facts derivable from EXISTING stored columns can be
// reconstructed: settlementState (from `pending`), fxApplied (row vs account
// currency), and the version stamp. Provider-only facts are NOT part of the
// return type — they stay NULL forever unless a future re-sync captures them.
// Reuses buildTransactionFacts so the derivation logic is never duplicated.
// ─────────────────────────────────────────────────────────────────────────────

/** An empty capture sidecar — a historical row carries no provider metadata. */
const EMPTY_CAPTURED: CapturedPlaidMetadata = {
  pfcConfidenceLevel: null,
  merchantEntityId:   null,
  counterparties:     [],
};

/** Stored-row inputs the backfill can honestly read. */
export interface BackfillFactRow {
  pending:         boolean;
  /** Transaction.currency (row denomination). */
  currency:        string | null;
  /** Parent account's currency (FinancialAccount or legacy Account). */
  accountCurrency: string | null;
}

/** The ONLY columns TI3 writes — provider-only facts are excluded by design. */
export interface BackfillFactFields {
  settlementState: TransactionFactFields["settlementState"];
  fxApplied:       TransactionFactFields["fxApplied"];
  tiFactsVersion:  TransactionFactFields["tiFactsVersion"];
}

/**
 * Derives the backfillable TI facts from a stored row. Pure, deterministic,
 * never throws. The provider-only facts buildTransactionFacts also computes
 * (paymentMethod → UNKNOWN, etc.) are deliberately dropped here — the backfill
 * must never write them, so they are not returned.
 */
export function buildBackfillFacts(row: BackfillFactRow): BackfillFactFields {
  const facts = buildTransactionFacts({
    captured:        EMPTY_CAPTURED,
    pending:         row.pending,
    rowCurrency:     row.currency,
    accountCurrency: row.accountCurrency,
  });
  return {
    settlementState: facts.settlementState,
    fxApplied:       facts.fxApplied,
    tiFactsVersion:  facts.tiFactsVersion,
  };
}
