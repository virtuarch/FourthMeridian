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
  FlowReason,
} from "./flow-classifier";

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

type LegacyBucket = "income" | "expense" | "debtPayment" | "transfer" | "none";

const LEGACY_INCOME_CATEGORIES = new Set(["Income", "Interest"]);

/** Verbatim reproduction of the assembler's inline partition (read-only). */
function legacyBucket(category: string, amount: number): LegacyBucket {
  if (category === "Transfer") return "transfer";
  if (category === "Payment")  return amount < 0 ? "debtPayment" : "none";
  if (LEGACY_INCOME_CATEGORIES.has(category) && amount > 0) return "income";
  if (amount < 0) return "expense";
  return "none";
}

/** The documented fold from classifier flowType back onto the coarse buckets. */
function classifierBucket(c: FlowClassification, amount: number): LegacyBucket {
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
