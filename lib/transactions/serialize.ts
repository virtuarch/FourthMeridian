/**
 * lib/transactions/serialize.ts
 *
 * Canonical transaction row → DTO serialization (TI-1 — Transaction
 * Intelligence Phase 1). Pure, deterministic, no I/O, no DB, no Prisma
 * runtime dependency — mirroring the lib/transactions/merchant.ts /
 * fingerprint.ts extraction pattern, so it is testable with plain `tsx`
 * and importable from anywhere without pulling in @/lib/db.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Before TI-1 the row → `Transaction` (types/index.ts) mapping was
 * copy-pasted FOUR times and had already drifted:
 *   - lib/data/transactions.ts        getTransactions()            (full)
 *   - lib/data/transactions.ts        getDebtTransactions()        (full)
 *   - lib/data/transactions.ts        getInvestmentTransactions()  (investment shape)
 *   - app/api/accounts/[id]/transactions/route.ts                  (DRIFTED —
 *     omitted `currency`, so the account modal never received the MC1
 *     Phase 0 native-currency stamp the dashboard lists carry)
 * This module is now the single derivation site (KD-10/KD-11 discipline).
 * See docs/investigations/TRANSACTION_INTELLIGENCE_DETAIL_VIEW_INVESTIGATION_2026-07-06.md §2.
 *
 * ── Byte-identity contract ───────────────────────────────────────────────────
 * serializeTransactionRow() reproduces the lib/data/transactions.ts mapping
 * EXACTLY — same fields, same fallbacks (`??`), same key insertion order —
 * so JSON serialization of the list DTOs is byte-identical before/after the
 * extraction. Pinned by lib/transactions/serialize.golden.test.ts. The one
 * deliberate change anywhere is the account-modal route gaining `currency`
 * (the drift FIX, not drift).
 *
 * Input types are structural (shaped like the Prisma row) rather than Prisma
 * types, the same convention types/index.ts follows for enums, so this module
 * compiles and tests without `prisma generate`.
 */

import type { Transaction, InvestmentTransaction } from "@/types";
import { merchantDisplayName, merchantLogoUrl, type ResolvedMerchantLike } from "@/lib/transactions/merchant-display";

/**
 * The scalar fields the serializers read, shaped exactly like a
 * `Transaction` row returned by Prisma (extra fields are ignored, so a full
 * row — including relations from `include` — is always assignable).
 */
export interface TransactionRowLike {
  id:                 string;
  financialAccountId: string | null;
  date:               Date;
  merchant:           string;
  description:        string | null;
  category:           string;
  amount:             number;
  pending:            boolean;
  currency?:                 string | null;
  flowType?:                 string | null;
  flowDirection?:            string | null;
  classificationConfidence?: number | null;
  classificationReason?:     string | null;
  classifierVersion?:        number | null;
  // Cash Flow liquidity axis — the counterparty's owned-account id. MUST be
  // PRE-GATED by the data layer (KD-15: only set when the counterparty is
  // visible to the reading Space). This pure serializer emits whatever it is
  // handed; it has no Space context and does NOT enforce visibility.
  counterpartyAccountId?:    string | null;
  // MI M6 — the resolved Merchant, from `include: { resolvedMerchant: { select:
  // { displayName, logoUrl } } }`. Optional: reads that omit the join fall back
  // to the raw `merchant` and a null logo (icon).
  resolvedMerchant?:         ResolvedMerchantLike | null;
}

/**
 * Canonical list-row DTO serialization — the single source for every
 * banking/debt list read and the account-modal route.
 *
 * `accountId` on the DTO is the canonical `financialAccountId` — the single-id
 * contract callers like AccountModal rely on to match transactions to an
 * account. Every row carries a FinancialAccount FK (Transaction model comment,
 * prisma/schema.prisma); the cast documents that invariant.
 */
export function serializeTransactionRow(r: TransactionRowLike): Transaction {
  return {
    id:          r.id,
    accountId:   r.financialAccountId as string,
    date:        r.date.toISOString().split("T")[0],
    merchant:    r.merchant,
    // MI M6 read cutover — resolved presentation (additive; raw `merchant` kept).
    merchantDisplayName: merchantDisplayName(r.merchant, r.resolvedMerchant),
    merchantLogoUrl:     merchantLogoUrl(r.resolvedMerchant),
    description: r.description ?? undefined,
    category:    r.category as Transaction["category"],
    amount:      r.amount,
    pending:     r.pending,
    // MC1 Phase 0 native-currency stamp (null = pre-provenance residue).
    currency:    r.currency ?? null,
    // FlowType metadata (v2.5.5 P5) — consumed by the Banking/Space flow
    // totals and the debt rollup.
    flowType:                 (r.flowType ?? null) as Transaction["flowType"],
    flowDirection:            (r.flowDirection ?? null) as Transaction["flowDirection"],
    classificationConfidence: r.classificationConfidence ?? null,
    classificationReason:     (r.classificationReason ?? null) as Transaction["classificationReason"],
    classifierVersion:        r.classifierVersion ?? null,
    // Cash Flow liquidity axis — pre-gated by the data layer (KD-15). Null when
    // absent or the counterparty is not visible to the reading Space.
    counterpartyAccountId:    r.counterpartyAccountId ?? null,
  };
}

/**
 * Investment list-row DTO serialization (Buy/Sell/Dividend/Split/Fee).
 * The ticker lives in the `merchant` column — a pre-existing storage
 * convention this serializer preserves, not endorses.
 */
export function serializeInvestmentTransactionRow(
  r: TransactionRowLike,
): InvestmentTransaction {
  return {
    id:          r.id,
    accountId:   r.financialAccountId as string,
    date:        r.date.toISOString().split("T")[0],
    ticker:      r.merchant,
    description: r.description ?? "",
    category:    r.category as InvestmentTransaction["category"],
    amount:      r.amount,
  };
}
