/**
 * lib/transactions/merchant-corrections.ts
 *
 * Merchant Intelligence — M5 user-correction workflow (MI1).
 *
 * The correction loop IS the intelligence: a user's explicit correction to a
 * transaction becomes durable Merchant Intelligence that automatically applies
 * to FUTURE transactions (via the M4 write path + M2 resolver), while only the
 * edited row is changed now (no historical bulk rewrite).
 *
 * Three corrections:
 *   • merchant identity — reassign the row to an existing Merchant, or a
 *     confirmed-new one; (re)point the descriptor's MerchantAlias so future
 *     occurrences resolve automatically.
 *   • category rule — create/update a USER MerchantRule for the merchant; the
 *     edited row is stamped USER_RULE and future rows inherit it (M4 injects
 *     owner-scoped USER rules through the M2 resolver).
 *   • transaction-only override — stamp this row USER_OVERRIDE without changing
 *     the merchant globally.
 *
 * ── Confirmed-create rule (never mint a Merchant from free text alone) ───────
 * A raw typed name is a PROPOSAL, not truth. `planMerchantIdentityCorrection`
 * only yields a create/select action when the caller made an EXPLICIT choice —
 * an existing `selectMerchantId`, or `createDisplayName` WITH `confirmCreate`.
 * A bare proposed name yields `needs-confirmation` (the endpoint returns the
 * normalized identity + existing candidates for the user to choose). This keeps
 * typos (Walmary / Uver / Netflx) out of the merchant graph.
 *
 * ── FlowType safety ──────────────────────────────────────────────────────────
 * Whenever a category changes (category rule / override), flow is re-derived
 * from the new category through the authoritative pipeline (buildFlowInputFromRow
 * → classifyFlow → buildFlowWriteFields), so category and flowType never desync.
 */

import type { CategorySource, MerchantAliasSource, Prisma, TransactionCategory } from "@prisma/client";
import { normalizeMerchantIdentity } from "@/lib/transactions/merchant-resolver";
import { buildFlowInputFromRow, buildFlowWriteFields } from "@/lib/transactions/plaid-flow-input";
import { classifyFlow, FLOW_CLASSIFIER_VERSION } from "@/lib/transactions/flow-classifier";

/** A PrismaClient or a $transaction client. */
export type CorrectionClient = Prisma.TransactionClient;

/** The row being corrected (MI + flow-relevant columns only). */
export interface CorrectionRow {
  id: string;
  merchant: string;
  description: string | null;
  category: TransactionCategory;
  amount: number;
  merchantId: string | null;
  categorySource: CategorySource | null;
  merchantEntityId: string | null;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  pfcConfidenceLevel: string | null;
}

/** Account context for the authoritative flow re-derivation. */
export interface CorrectionAcct {
  accountType: string | null;
  debtSubtype: string | null;
}

// ── Confirmed-create planner (PURE) ───────────────────────────────────────────

export interface MerchantCandidate {
  id: string;
  canonicalKey: string;
  displayName: string;
}

/** The caller's merchant-identity intent. */
export type MerchantIdentityInput =
  | { selectMerchantId: string }
  | { createDisplayName: string; confirmCreate: true }
  | { proposedName: string };

export type MerchantIdentityDecision =
  | { kind: "select"; merchantId: string }
  | { kind: "create"; displayName: string; canonicalKey: string }
  | { kind: "needs-confirmation"; normalized: { canonicalKey: string; displayName: string } };

/**
 * Decide what a merchant-identity correction should do — PURELY from the caller's
 * intent. A `select` (existing id) or a `create` WITH `confirmCreate` is an
 * explicit action; anything else (a bare proposed name) is a proposal that needs
 * confirmation. Never yields `create` from free text without `confirmCreate`.
 */
export function planMerchantIdentityCorrection(input: MerchantIdentityInput): MerchantIdentityDecision {
  if ("selectMerchantId" in input && input.selectMerchantId) {
    return { kind: "select", merchantId: input.selectMerchantId };
  }
  if ("createDisplayName" in input && input.confirmCreate === true) {
    const norm = normalizeMerchantIdentity(input.createDisplayName);
    return { kind: "create", displayName: norm.displayName, canonicalKey: norm.canonicalKey };
  }
  const proposed =
    "proposedName" in input ? input.proposedName
    : "createDisplayName" in input ? input.createDisplayName
    : "";
  return { kind: "needs-confirmation", normalized: normalizeMerchantIdentity(proposed) };
}

// ── Flow re-derivation (authoritative pipeline) ───────────────────────────────

/** Re-derive the flow write-columns for a row's (possibly new) category. Pure. */
export function recomputeFlowFields(row: CorrectionRow, acct: CorrectionAcct, category: TransactionCategory) {
  // CCPAY-2C-5 — no merchant/description: the classifier is descriptor-blind by
  // contract. CorrectionRow still carries them for the merchant-identity work
  // below; they simply never reach the flow layer.
  const { input, captured } = buildFlowInputFromRow(
    {
      category,
      amount: row.amount,
      pfcPrimary: row.pfcPrimary,
      pfcDetailed: row.pfcDetailed,
      pfcConfidenceLevel: row.pfcConfidenceLevel,
      merchantEntityId: row.merchantEntityId,
    },
    acct,
  );
  return buildFlowWriteFields(classifyFlow(input), input, captured, FLOW_CLASSIFIER_VERSION);
}

// ── DB executors ──────────────────────────────────────────────────────────────

/** Candidate lookup for a proposed name — DETERMINISTIC (exact canonical key / alias; no fuzzy). */
export async function findMerchantCandidates(
  client: CorrectionClient,
  proposedName: string,
): Promise<MerchantCandidate[]> {
  const { canonicalKey } = normalizeMerchantIdentity(proposedName);
  const byKey = await client.merchant.findUnique({
    where: { canonicalKey },
    select: { id: true, canonicalKey: true, displayName: true },
  });
  if (byKey) return [byKey];
  const alias = await client.merchantAlias.findUnique({
    where: { aliasKey: canonicalKey },
    select: { merchant: { select: { id: true, canonicalKey: true, displayName: true } } },
  });
  return alias?.merchant ? [alias.merchant] : [];
}

/** (Re)point the row's descriptor alias to a merchant — explicit user action, idempotent. */
async function pointAlias(client: CorrectionClient, aliasKey: string, merchantId: string): Promise<void> {
  await client.merchantAlias.upsert({
    where: { aliasKey },
    create: { aliasKey, source: "USER" as MerchantAliasSource, merchantId },
    // A correction is an explicit teach: re-point an existing alias to the chosen
    // merchant (the automatic M4 path never re-points; only a user correction does).
    update: { merchantId, source: "USER" as MerchantAliasSource },
    select: { id: true },
  });
}

/**
 * Reassign a transaction to an existing merchant, or a confirmed-new one, and
 * (re)point the descriptor alias so future occurrences resolve automatically.
 * Only the edited row's merchantId changes.
 */
export async function applyMerchantIdentityCorrection(
  client: CorrectionClient,
  row: CorrectionRow,
  decision: Extract<MerchantIdentityDecision, { kind: "select" | "create" }>,
): Promise<{ merchantId: string }> {
  const aliasKey = normalizeMerchantIdentity(row.merchant).canonicalKey;
  let merchantId: string;
  if (decision.kind === "select") {
    const m = await client.merchant.findUnique({ where: { id: decision.merchantId }, select: { id: true } });
    if (!m) throw new Error("selected merchant not found");
    merchantId = m.id;
  } else {
    // Confirmed create — upsert by canonicalKey so an accidental collision reuses
    // rather than erroring; this is the ONLY create path, and it is confirm-gated.
    const m = await client.merchant.upsert({
      where: { canonicalKey: decision.canonicalKey },
      create: { canonicalKey: decision.canonicalKey, displayName: decision.displayName },
      update: {},
      select: { id: true },
    });
    merchantId = m.id;
  }
  await pointAlias(client, aliasKey, merchantId);
  await client.transaction.update({ where: { id: row.id }, data: { merchantId } });
  return { merchantId };
}

/**
 * Create/update a USER MerchantRule for the row's merchant and stamp the edited
 * row USER_RULE (flow re-derived). Future transactions of this merchant inherit
 * the rule via the M4 write path. Requires the row to already have a merchantId.
 */
export async function applyCategoryRuleCorrection(
  client: CorrectionClient,
  row: CorrectionRow,
  acct: CorrectionAcct,
  ownerUserId: string,
  category: TransactionCategory,
): Promise<{ ruleId: string }> {
  if (!row.merchantId) throw new Error("cannot create a merchant rule for a row without a merchant");
  // Find-or-update the owner's USER rule for this merchant (idempotent edits).
  const existingRule = await client.merchantRule.findFirst({
    where: { merchantId: row.merchantId, scope: "USER", ownerUserId },
    select: { id: true },
  });
  const rule = existingRule
    ? await client.merchantRule.update({ where: { id: existingRule.id }, data: { category }, select: { id: true } })
    : await client.merchantRule.create({
        data: { merchantId: row.merchantId, scope: "USER", ownerUserId, category },
        select: { id: true },
      });

  const flow = recomputeFlowFields(row, acct, category);
  await client.transaction.update({
    where: { id: row.id },
    data: { category, categorySource: "USER_RULE", categoryRuleId: rule.id, ...flow },
  });
  return { ruleId: rule.id };
}

/**
 * Transaction-only override: stamp this row USER_OVERRIDE (flow re-derived)
 * without creating a rule or changing the merchant globally.
 */
export async function applyTransactionOverride(
  client: CorrectionClient,
  row: CorrectionRow,
  acct: CorrectionAcct,
  category: TransactionCategory,
): Promise<void> {
  const flow = recomputeFlowFields(row, acct, category);
  await client.transaction.update({
    where: { id: row.id },
    data: { category, categorySource: "USER_OVERRIDE", categoryRuleId: null, ...flow },
  });
}
