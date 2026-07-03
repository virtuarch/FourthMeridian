/**
 * lib/transactions/plaid-flow-input.ts
 *
 * FlowType P2 — Plaid import fidelity (pure, no DB, no side effects).
 *
 * Turns a Plaid `Transaction` into (a) a `FlowClassificationInput` the P1
 * classifier already understands and (b) a captured-metadata sidecar for the
 * fields the classifier does not yet consume but P3 will persist. It also
 * provides a pure, non-PII shadow accumulator used by the sync path's
 * observability (FLOWTYPE_SHADOW) — no value produced here is ever written to
 * the database or used for any decision in P2.
 *
 * Rules honored (see docs/initiatives/flowtype/P2_IMPORT_FIDELITY_IMPLEMENTATION_CHECKLIST.md):
 *  - Prisma-free: Plaid types are structural; no generated-client import.
 *  - Never flips sign: `amount`/`category` are passed through from the caller
 *    (the sign flip stays in lib/plaid/syncTransactions.ts).
 *  - Deny-lists `counterparties[].account_numbers` — it is never read, never
 *    copied, and therefore can never reach a struct or a log.
 *  - Does not modify or re-implement flow-classifier.ts; it only feeds it.
 */

import type { Transaction as PlaidTransaction } from "plaid";
import type {
  FlowClassificationInput,
  FlowClassification,
  FlowType,
  FlowDirection,
  FlowReason,
} from "./flow-classifier";
// Type-only imports — erased at runtime, so this module stays Prisma-free at
// runtime (the pure tests run without the generated engine). They exist purely
// to compile-guard the classifier→Postgres-enum mapping below: if the two ever
// drift, tsc fails.
import type {
  FlowType as PrismaFlowType,
  FlowDirection as PrismaFlowDirection,
  FlowClassificationReason as PrismaFlowClassificationReason,
} from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Captured metadata (P3 will persist this; P2 only holds it in memory)
// ─────────────────────────────────────────────────────────────────────────────

/** One counterparty, with the sensitive `account_numbers` field deny-listed. */
export interface CapturedCounterparty {
  name:            string;
  entityId:        string | null;
  type:            string;
  website:         string | null;
  logoUrl:         string | null;
  confidenceLevel: string | null;
  // NOTE: Plaid's `account_numbers` is intentionally NOT represented here.
}

export interface CapturedPlaidMetadata {
  /** personal_finance_category.confidence_level (VERY_HIGH..UNKNOWN). */
  pfcConfidenceLevel: string | null;
  merchantEntityId:   string | null;
  counterparties:     CapturedCounterparty[];
}

export interface PlaidFlowInputResult {
  input:    FlowClassificationInput;
  captured: CapturedPlaidMetadata;
}

/** Account context the sync path resolves per row (read-only). */
export interface PlaidFlowAccountContext {
  category:     string;          // the already-mapped TransactionCategory value
  amount:       number;          // FM sign convention (already flipped by the caller)
  accountType?: string | null;   // FinancialAccount.type
  debtSubtype?: string | null;   // FinancialAccount.debtSubtype
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the classifier input + captured-metadata sidecar from a Plaid
 * transaction. Pure; never throws on missing/null fields.
 */
export function buildPlaidFlowInput(
  txn: PlaidTransaction,
  ctx: PlaidFlowAccountContext,
): PlaidFlowInputResult {
  const pfc = txn.personal_finance_category ?? null;

  const input: FlowClassificationInput = {
    category:    ctx.category,
    amount:      ctx.amount,
    accountType: ctx.accountType ?? null,
    debtSubtype: ctx.debtSubtype ?? null,
    merchant:    txn.merchant_name ?? txn.name ?? null,
    pfcPrimary:  pfc?.primary ?? null,
    pfcDetailed: pfc?.detailed ?? null,
  };

  const counterparties: CapturedCounterparty[] = (txn.counterparties ?? []).map((c) => ({
    name:            c.name,
    entityId:        c.entity_id ?? null,
    type:            String(c.type),
    website:         c.website ?? null,
    logoUrl:         c.logo_url ?? null,
    confidenceLevel: c.confidence_level ?? null,
    // c.account_numbers intentionally dropped — deny-listed.
  }));

  const captured: CapturedPlaidMetadata = {
    pfcConfidenceLevel: pfc?.confidence_level ?? null,
    merchantEntityId:   txn.merchant_entity_id ?? null,
    counterparties,
  };

  return { input, captured };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow observability (pure, non-PII) — FLOWTYPE_SHADOW
//
// Measures the classifier against real Plaid data without persisting anything.
// "Legacy-bucket agreement" reproduces the AI assembler's income/expense/
// transfer/debtPayment partition (lib/ai/assemblers/transactions.ts:290-314)
// and the P1 fold, and counts how often the classifier lands in the same
// coarse bucket — the P3 go/no-go signal. No merchant/counterparty/amount
// values are retained; only counts.
// ─────────────────────────────────────────────────────────────────────────────

export type LegacyBucket = "income" | "expense" | "debtPayment" | "transfer" | "none";

const LEGACY_INCOME_CATEGORIES = new Set(["Income", "Interest"]);

/**
 * Verbatim reproduction of the assembler's inline partition (read-only).
 * Exported so diagnostic tooling can flag exactly the rows where the classifier
 * fold disagrees with this legacy bucket — the same comparison accumulateShadow
 * counts. No behavior change from exporting.
 */
export function legacyBucket(category: string, amount: number): LegacyBucket {
  if (category === "Transfer") return "transfer";
  if (category === "Payment")  return amount < 0 ? "debtPayment" : "none";
  if (LEGACY_INCOME_CATEGORIES.has(category) && amount > 0) return "income";
  if (amount < 0) return "expense";
  return "none";
}

/** The documented fold from classifier flowType back onto the coarse buckets. */
export function classifierBucket(c: FlowClassification, amount: number): LegacyBucket {
  if (c.flowType === "TRANSFER")     return "transfer";
  if (c.flowType === "DEBT_PAYMENT") return amount < 0 ? "debtPayment" : "none";
  if ((c.flowType === "INCOME" || c.flowType === "INTEREST") && amount > 0) return "income";
  if (amount < 0) return "expense";
  return "none";
}

export interface ShadowStats {
  total:                   number;
  unknown:                 number;
  byFlowType:              Partial<Record<FlowType, number>>;
  byReason:                Partial<Record<FlowReason, number>>;
  legacyBucketComparisons: number;
  legacyBucketAgreements:  number;
}

export function createShadowStats(): ShadowStats {
  return {
    total: 0,
    unknown: 0,
    byFlowType: {},
    byReason: {},
    legacyBucketComparisons: 0,
    legacyBucketAgreements: 0,
  };
}

/** Folds one classified row into the running stats. Pure (mutates + returns acc). */
export function accumulateShadow(
  acc: ShadowStats,
  classification: FlowClassification,
  category: string,
  amount: number,
): ShadowStats {
  acc.total += 1;
  if (classification.flowType === "UNKNOWN") acc.unknown += 1;
  acc.byFlowType[classification.flowType] = (acc.byFlowType[classification.flowType] ?? 0) + 1;
  acc.byReason[classification.reason]     = (acc.byReason[classification.reason] ?? 0) + 1;

  acc.legacyBucketComparisons += 1;
  if (legacyBucket(category, amount) === classifierBucket(classification, amount)) {
    acc.legacyBucketAgreements += 1;
  }
  return acc;
}

/**
 * Renders a single non-PII summary line for FLOWTYPE_SHADOW=count. Contains
 * only counts and rates — no merchant, counterparty, or amount values.
 */
export function summarizeShadow(acc: ShadowStats): string {
  const agreementPct = acc.legacyBucketComparisons > 0
    ? Math.round((acc.legacyBucketAgreements / acc.legacyBucketComparisons) * 1000) / 10
    : 0;
  const flowParts = Object.entries(acc.byFlowType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return (
    `[flowtype-shadow] total=${acc.total} unknown=${acc.unknown} ` +
    `legacyBucketAgreement=${acc.legacyBucketAgreements}/${acc.legacyBucketComparisons} (${agreementPct}%) ` +
    `flowType{${flowParts}}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow write-fields (P3 Phase B) — maps classifier output to the Postgres
// enum-valued Transaction columns for persistence on the sync write path.
//
// Compile-guarded parity: each map is `Record<classifierUnion, PrismaEnum>`, so
// (a) the key set forces every classifier value to be mapped and (b) each value
// must be assignable to the Prisma enum type — drift in either direction is a
// tsc error. Values are string literals (not `Prisma.FlowType.X`) so the module
// keeps no runtime dependency on the generated client.
// ─────────────────────────────────────────────────────────────────────────────

const FLOW_TYPE_TO_PRISMA: Record<FlowType, PrismaFlowType> = {
  SPENDING:     "SPENDING",
  INCOME:       "INCOME",
  REFUND:       "REFUND",
  DEBT_PAYMENT: "DEBT_PAYMENT",
  TRANSFER:     "TRANSFER",
  INVESTMENT:   "INVESTMENT",
  FEE:          "FEE",
  INTEREST:     "INTEREST",
  ADJUSTMENT:   "ADJUSTMENT",
  UNKNOWN:      "UNKNOWN",
};

const FLOW_DIRECTION_TO_PRISMA: Record<FlowDirection, PrismaFlowDirection> = {
  INFLOW:   "INFLOW",
  OUTFLOW:  "OUTFLOW",
  INTERNAL: "INTERNAL",
  UNKNOWN:  "UNKNOWN",
};

const REASON_TO_PRISMA: Record<FlowReason, PrismaFlowClassificationReason> = {
  PLAID_PFC_DETAILED:        "PLAID_PFC_DETAILED",
  PLAID_PFC_PRIMARY:         "PLAID_PFC_PRIMARY",
  CATEGORY_FLOW_VALUE:       "CATEGORY_FLOW_VALUE",
  CATEGORY_INVESTMENT_VALUE: "CATEGORY_INVESTMENT_VALUE",
  ACCOUNT_TYPE_CONTEXT:      "ACCOUNT_TYPE_CONTEXT",
  SIGN_DEFAULT_SPENDING:     "SIGN_DEFAULT_SPENDING",
  SIGN_DEFAULT_INFLOW:       "SIGN_DEFAULT_INFLOW",
  AMBIGUOUS_UNKNOWN:         "AMBIGUOUS_UNKNOWN",
};

/** The exact subset of Transaction columns Phase B writes. All nullable. */
export interface FlowWriteFields {
  flowType:                 PrismaFlowType | null;
  flowDirection:            PrismaFlowDirection | null;
  counterpartyAccountId:    string | null;
  classificationConfidence: number | null;
  classificationReason:     PrismaFlowClassificationReason | null;
  classifierVersion:        number | null;
  pfcPrimary:               string | null;
  pfcDetailed:              string | null;
  pfcConfidenceLevel:       string | null;
  merchantEntityId:         string | null;
}

/**
 * All-null flow columns — written when classification fails, so the row still
 * persists with its original fields and never blocks the sync.
 */
export const NULL_FLOW_WRITE_FIELDS: FlowWriteFields = {
  flowType:                 null,
  flowDirection:            null,
  counterpartyAccountId:    null,
  classificationConfidence: null,
  classificationReason:     null,
  classifierVersion:        null,
  pfcPrimary:               null,
  pfcDetailed:              null,
  pfcConfidenceLevel:       null,
  merchantEntityId:         null,
};

/**
 * Builds the Transaction flow columns from a classification + its inputs.
 * `counterpartyAccountId` is deliberately null in Phase B — deterministic
 * destination attribution is a read-side rollup and source-side attribution is
 * deferred (P4/P5); writing a guess would invent data.
 */
export function buildFlowWriteFields(
  classification: FlowClassification,
  input: FlowClassificationInput,
  captured: CapturedPlaidMetadata,
  version: number,
): FlowWriteFields {
  return {
    flowType:                 FLOW_TYPE_TO_PRISMA[classification.flowType],
    flowDirection:            FLOW_DIRECTION_TO_PRISMA[classification.flowDirection],
    counterpartyAccountId:    null,
    classificationConfidence: classification.confidence,
    classificationReason:     REASON_TO_PRISMA[classification.reason],
    classifierVersion:        version,
    pfcPrimary:               input.pfcPrimary ?? null,
    pfcDetailed:              input.pfcDetailed ?? null,
    pfcConfidenceLevel:       captured.pfcConfidenceLevel,
    merchantEntityId:         captured.merchantEntityId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Row-sourced flow input (P4 backfill, Slice 1)
//
// The Phase B write path builds classifier inputs from a live Plaid txn
// (buildPlaidFlowInput). The historical backfill has no Plaid payload — it must
// assemble the SAME FlowClassificationInput + CapturedPlaidMetadata from the
// Transaction's own stored columns + its owning account's type/debtSubtype. This
// is pure marshalling only: it contains NO classification logic (classifyFlow
// and buildFlowWriteFields are reused verbatim), invents nothing, and preserves
// any stored pfc/merchant values by reading them straight off the row. See
// docs/initiatives/flowtype/P4_BACKFILL_CHECKLIST.md §2.2.
// ─────────────────────────────────────────────────────────────────────────────

/** The Transaction columns the classifier consumes, as stored on the row. */
export interface FlowRowInput {
  category:           string;
  amount:             number;
  merchant:           string | null;
  description:        string | null;
  pfcPrimary:         string | null;
  pfcDetailed:        string | null;
  pfcConfidenceLevel: string | null;
  merchantEntityId:   string | null;
}

/** Account context resolved from whichever FK the row uses (FinancialAccount or legacy Account). */
export interface FlowRowAccountContext {
  accountType: string | null;   // FinancialAccount.type or Account.type
  debtSubtype: string | null;   // FinancialAccount.debtSubtype only; null for legacy Account
}

/**
 * Assembles classifier input + captured-metadata from a stored Transaction row.
 * Mirrors buildPlaidFlowInput but sources from the DB row instead of a Plaid
 * object. Pure; never throws. `counterparties` is always empty — counterparty
 * data was never persisted (deny-listed in P2), so there is nothing to
 * reconstruct, and no counterparty is ever inferred.
 */
export function buildFlowInputFromRow(
  row:  FlowRowInput,
  acct: FlowRowAccountContext,
): PlaidFlowInputResult {
  const input: FlowClassificationInput = {
    category:    row.category,
    amount:      row.amount,
    accountType: acct.accountType ?? null,
    debtSubtype: acct.debtSubtype ?? null,
    merchant:    row.merchant ?? null,
    description: row.description ?? null,
    pfcPrimary:  row.pfcPrimary ?? null,
    pfcDetailed: row.pfcDetailed ?? null,
  };

  const captured: CapturedPlaidMetadata = {
    pfcConfidenceLevel: row.pfcConfidenceLevel ?? null,
    merchantEntityId:   row.merchantEntityId ?? null,
    counterparties:     [],
  };

  return { input, captured };
}
