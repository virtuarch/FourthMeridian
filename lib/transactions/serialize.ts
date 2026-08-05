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
import { resolveLifecycle } from "@/lib/transactions/lifecycle";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";
import { attributeIncome } from "@/lib/transactions/income-source";
import { liabilityInflowIsCustomerPayment } from "@/lib/transactions/liability-inflow";
import { isIncome } from "@/lib/transactions/flow-predicates";

/**
 * The scalar fields the serializers read, shaped exactly like a
 * `Transaction` row returned by Prisma (extra fields are ignored, so a full
 * row — including relations from `include` — is always assignable).
 */
export interface TransactionRowLike {
  id:                 string;
  financialAccountId: string | null;
  /** The POSTING date — `Transaction.date`. Provenance, not the headline. */
  date:               Date;
  /**
   * L8-B — the persisted ECONOMIC date. Becomes the DTO's `date`, i.e. THE
   * canonical financial date every surface renders, groups and buckets by.
   *
   * ⚠️ Optional at the TYPE level only because golden fixtures and a few narrow
   * reads construct rows by hand. A live row always carries it — backfill,
   * dual-write and `audit:economic-date` guarantee that — and `financialDate()`
   * below records exactly when the fallback is legitimate.
   */
  economicDate?:      Date | null;
  /** L8-B1 — the logical event this row projects. Absent on reads that did not
   *  select it, and null for rows outside the banking event domain (crypto). */
  transactionEventId?: string | null;
  merchant:           string;
  description:        string | null;
  category:           string;
  amount:             number;
  pending:            boolean;
  // v2.6-L4A/B — the evidence the derived authorities read. All OPTIONAL: a read
  // that omits them gets no derived block rather than a fabricated one.
  settlementState?:          string | null;
  deletedAt?:                Date | null;
  authorizedAt?:             Date | null;
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
  // v2.6-TRUTH-4 — the evidence the canonical income authority reads. Optional
  // on the same principle: a read that omits them gets no income attribution
  // rather than one resting on columns nobody selected.
  pfcPrimary?:               string | null;
  pfcDetailed?:              string | null;
  /** The OWNING account's type (checking | savings | debt | …). Not a Transaction
   *  column — a caller with the account joined supplies it. */
  accountType?:              string | null;
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
/**
 * L8-B — THE canonical financial date of a row.
 *
 * ── Why the DTO's `date` changed meaning ───────────────────────────────────
 *
 * `date` is the field every surface reads: the list groups by it, Cash Flow
 * buckets by it, exports emit it, the AI narrates it. Migrating each of those
 * to a differently-named field would have left the cutover one missed call site
 * away from a mixed chronology — and a mixed chronology is invisible until a
 * month boundary moves 147 rows into the wrong period.
 *
 * So the DTO's `date` now carries the ECONOMIC date, and `postingDate` carries
 * the posting date explicitly beside it. Both facts ship; the one named "date"
 * on a financial record is the one that answers "when did this happen".
 *
 * ⚠️ The fallback to `r.date` fires only for a row constructed WITHOUT the
 * column — golden fixtures and hand-built rows. Live reads select it, so this is
 * never a silent posting-chronology fallback in production.
 */
function financialDate(r: TransactionRowLike): Date {
  return r.economicDate ?? r.date;
}

export function serializeTransactionRow(r: TransactionRowLike): Transaction {
  return {
    id:          r.id,
    accountId:   r.financialAccountId as string,
    // L8-B1 — the LOGICAL EVENT this row projects. A surface that needs to speak
    // about the event (rather than the row observing it) addresses this. Null for
    // rows outside the banking event domain; absent when the read did not select
    // it, which is honest absence, not a claim of "no event".
    ...(r.transactionEventId !== undefined ? { transactionEventId: r.transactionEventId } : {}),
    // L8-B — ECONOMIC. `postingDate` rides in the derived block as provenance.
    date:        financialDate(r).toISOString().split("T")[0],
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
    // ── v2.6-L4 derived read-model (never persisted) ────────────────────────
    // `date` above is UNCHANGED — it is the POSTING date and the historical
    // engine depends on it. `economicDate` is derived alongside it, so a
    // surface can show when the activity happened without either date moving.
    ...deriveLifecycleAndEconomicDate(r),
  };
}

/**
 * v2.6-L4 — the derived lifecycle + economic-date block for a list row.
 *
 * Emitted only when the read supplied the evidence: a caller that did not select
 * `settlementState`/`authorizedAt` gets `lifecycle: undefined` and
 * `economicDate: undefined`, which is honest — the alternative would be a
 * derived claim resting on columns nobody read.
 *
 * `hasLivePostedSuccessor` is deliberately NOT passed here: a pure row
 * serializer cannot know it (it is a cross-row fact), so a tombstoned row
 * resolves UNKNOWN rather than being guessed at. List reads filter tombstones
 * out anyway.
 */
function deriveLifecycleAndEconomicDate(r: TransactionRowLike): Partial<Transaction> {
  if (r.settlementState === undefined && r.authorizedAt === undefined) return {};
  const lifecycle = resolveLifecycle({
    settlementState: r.settlementState,
    pending:         r.pending,
    deletedAt:       r.deletedAt,
  });
  // L8-B — the persisted column is the authority now. `resolveEconomicDate` is
  // still called because the BASIS, STATE and LAG stay derived (they were never
  // persisted, deliberately — see the migration note), but the DATE itself comes
  // from the column so the DTO and the SQL ordering can never disagree.
  const econ = resolveEconomicDate({
    postingDate:  r.date,
    authorizedAt: r.authorizedAt ?? null,
  });
  const persistedEconomic = r.economicDate
    ? r.economicDate.toISOString().split("T")[0]
    : econ.economicDate;
  // v2.6-TRUTH-4 — the canonical income attribution rides the same derived block.
  // Emitted only for INFLOWS, and only where the read supplied the evidence: an
  // outflow has no income class, and inventing one would put a zero-amount
  // "OTHER_INCOME" on every purchase in the ledger.
  // v2.6-TRUTH-6 — attributed ONLY over the population income is drawn from.
  //
  // This was `r.amount > 0`, which attributed every positive row — transfers in,
  // refunds, debt-payment inflows. Each fell through to UNRESOLVED_INCOME and so
  // to OTHER_INCOME, and the moment a surface summed the field, "Other income"
  // read $380,127.32 over 252 rows. An attribution on a transfer is not merely
  // unused, it is a false statement about the row.
  //
  // `isIncome` is the same predicate the economic fold uses, so the attributed
  // set and the summed set are the same set by construction. A row outside it
  // gets NO attribution — honest absence, not a misleading class.
  const income = r.amount > 0 && isIncome(r.flowType ?? null)
    ? attributeIncome({
        flowType:       r.flowType ?? null,
        providerFamily: r.pfcPrimary ?? null,
        providerDetail: r.pfcDetailed ?? null,
        accountType:    r.accountType ?? "other",
        amount:         r.amount,
        // A persisted counterparty is proof the money came from an owned
        // account. The read-time match is NOT consulted here — this serializer
        // is per-row and cannot see the corpus, and guessing would be worse
        // than declining.
        isOwnedInternalTransfer: r.counterpartyAccountId != null,
        sourceAccountId: r.financialAccountId ?? null,
        // v2.6-TRUTH-3's verdict, consulted rather than re-derived. Without it,
        // four live rows that Plaid tagged INCOME_SALARY / INCOME_CONTRACTOR /
        // INCOME_GIG_ECONOMY — but which are merchant credits landing on a
        // CREDIT CARD — stay inside earned income. Structural evidence (a
        // positive movement on a liability from a non-payment family) outranks
        // the provider's label, which is the whole point of the precedence.
        liabilityInflowIsIssuerCredit:
          (r.accountType ?? null) === "debt" &&
          liabilityInflowIsCustomerPayment({
            providerFamily: r.pfcPrimary ?? null,
            persistedCounterpartyAccountId: r.counterpartyAccountId ?? null,
          }).verdict === "NO",
      })
    : null;

  return {
    lifecycleState:      lifecycle.state,
    lifecycleBasis:      lifecycle.basis,
    economicDate:        persistedEconomic,
    postingDate:         econ.postingDate,
    economicDateBasis:   econ.basis,
    economicDateState:   econ.state,
    economicDateLagDays: econ.lagDays,
    ...(income
      ? {
          incomeClass:           income.incomeClass,
          incomeSubtype:         income.subtype,
          incomeInstrumentId:    income.instrumentId,
          incomeSourceAccountId: income.sourceAccountId,
        }
      : {}),
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
    // L8-B — the same canonical chronology as the banking DTO. An investment
    // row's trade date is its economic date; leaving this on posting would make
    // the Investments activity list disagree with the transactions list about
    // the day a trade happened.
    date:        financialDate(r).toISOString().split("T")[0],
    ticker:      r.merchant,
    description: r.description ?? "",
    category:    r.category as InvestmentTransaction["category"],
    amount:      r.amount,
  };
}
