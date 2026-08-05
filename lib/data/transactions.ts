/**
 * lib/data/transactions.ts
 *
 * Server-only transaction queries.
 *
 * Transactions reach a space via the canonical path (see Transaction model
 * comment in prisma/schema.prisma):
 *  - financialAccount.spaceAccountLinks (D3 Step 4C read cutover — see
 *    docs/initiatives/d3/D3_STEP4C_CORE_DASHBOARD_REVIEW.md; replaces the prior
 *    financialAccount.workspaceShares query). Visibility is status: ACTIVE on
 *    the link; `kind` (HOME vs SHARED) is not filtered on — both confer
 *    visibility. This is the identical link/status shape lib/data/accounts.ts
 *    now uses, so accounts, holdings, and transactions cannot disagree on
 *    what's visible.
 * `accountId` on the returned DTOs is the FinancialAccount id, since callers
 * (e.g. AccountModal) match transactions to an account by this single id field.
 *
 * D2 Step 4D-R: every query below also filters Transaction.deletedAt: null,
 * excluding rows soft-deleted by an import rollback. This is the row's own
 * soft-delete and is independent of (ANDed with) the financialAccount.deletedAt
 * account-level guard above — both must hold for a transaction to be visible.
 * See docs/initiatives/d2/investigations/D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md.
 *
 * KD-15 (2026-07-02): the SpaceAccountLink path additionally requires a
 * visibilityLevel that grants transaction-level detail
 * (TRANSACTION_DETAIL_VISIBILITY, lib/ai/visibility.ts — currently FULL only).
 * This is the UI counterpart to KD-1, which fixed the AI-context queries in
 * lib/ai/assemblers/transactions.ts. Both paths import the SAME predicate so a
 * BALANCE_ONLY / SUMMARY_ONLY shared account can never leak its transaction
 * rows — the account still contributes a balance total via lib/account-privacy.ts
 * (the accounts path), but its rows, merchants, and amounts never reach these UI
 * lists. Fails closed: absence of a transaction-detail grant excludes the rows,
 * never leaks them.
 * KD-15 is tracked in STATUS.md (known defects register).
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import {
  Transaction,
  TransactionDetail,
  TransactionDetailAccount,
  TransactionDetailCounterparty,
  TransactionDetailProvenance,
  TransactionDetailReporting,
  TransactionProvenanceSource,
} from "@/types";
import { ShareStatus, FlowType, Prisma } from "@prisma/client";

import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
// TI-1: canonical row → DTO serialization (single derivation site — replaces
// the three inline mappings this file previously duplicated).
import { serializeTransactionRow } from "@/lib/transactions/serialize";
import { gatedCounterpartyId, chooseCounterpartyId } from "@/lib/transactions/counterparty-visibility";
import { transactionDetailWhere } from "@/lib/transactions/detail-query";
// TI5-2 — the pure read-time relationship engine. Candidate gathering stays in
// this data layer; the resolver receives (transaction, candidates) and nothing else.
import { resolveTransactionRelationships } from "@/lib/transactions/RelationshipResolver";
// TI4 Slice 1 — read-time owned-account transfer matching (Cash Flow liquidity axis).
// Projects a deterministically-matched counterparty id into the list DTO through
// the SAME KD-15 gate; never persists Transaction.counterpartyAccountId.
import {
  resolveTransferAssessments,
  filterVisibleCounterpartyAccounts,
} from "@/lib/transactions/transfer-resolution";
// TE-2B — semantic "needs classification" disclosure, derived server-side from
// canonical fields (never exposes the raw inputs). Read-only; no calculations change.
import { shouldSurfaceAsNeedsClassification } from "@/lib/transactions/needs-classification";
// CF-1 — per-row canonical context (transferDisposition + needsClassification) for
// the Cash Flow context section. Read-only projection; no calculation reads it.
import { deriveTransactionContext } from "@/lib/transactions/transaction-context";
import { convertMoney } from "@/lib/money/convert";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";
import { ECONOMIC_DATE_MAX_LAG_DAYS } from "@/lib/transactions/economic-date";

/**
 * P2-2 — the canonical banking-population WHERE fragment. FlowType (not provider
 * category) decides eligibility for canonical financial analysis: every row EXCEPT
 * pure investment security-activity (FlowType.INVESTMENT) belongs to the banking
 * semantic population that reaches Cash Flow / DayFacts, the Transactions
 * Perspective, exports, and the liquidity axis.
 *
 * Why `not: INVESTMENT` and not a flow allow-list: the ONLY structural split among
 * banking reads is banking vs. investment security-activity. Expressing the rule as
 * a single exclusion (a) keeps unclassified rows visible — Prisma scalar `not`
 * returns null/UNKNOWN rows too, so a row awaiting classification still surfaces to
 * review / needs-classification paths, never dropped by a taxonomy allow-list; and
 * (b) admits every legitimate banking flow (SPENDING/INCOME/REFUND/FEE/INTEREST/
 * TRANSFER/DEBT_PAYMENT/ADJUSTMENT) regardless of its provider category label. The
 * DayFacts fold already handles each of these canonically (UNKNOWN → unresolved
 * transparency total; ADJUSTMENT → NON_CASH context reason; neither enters net), so
 * widening the population changes no Cash-Flow math — it only stops the old
 * `category ∈ BANKING_CATEGORIES` allow-list from silently omitting rows whose
 * category fell outside 11 hand-listed values (e.g. cash Dividend income, card Fees,
 * newer/merchant PFC categories). This mirrors the AI assembler's already-migrated
 * `flowType: { in: BANKING_FLOWS }` cutover (lib/ai/assemblers/transactions.ts).
 *
 * Row-level statement of the same rule: isBankingPopulation (flow-predicates.ts).
 * Pinned in lockstep by lib/data/transactions.population.test.ts. Structural
 * filters (deletedAt, SpaceAccountLink visibility, date) are ANDed separately.
 */
const BANKING_POPULATION = { flowType: { not: FlowType.INVESTMENT } } as const;

/**
 * KD-15 counterparty-visibility include for the list reads (Cash Flow liquidity
 * axis). Loads only the counterparty's deletion state + its links FILTERED to
 * this Space's ACTIVE, transaction-detail-granting (FULL) links — so
 * gatedCounterpartyId() can decide whether the id is safe to expose. Mirrors the
 * transaction-detail route's counterparty seam exactly. No name/detail loaded.
 */
function counterpartyVisibilityInclude(spaceId: string) {
  return {
    counterpartyAccount: {
      select: {
        deletedAt: true,
        spaceAccountLinks: {
          where: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } },
          select: { id: true },
        },
      },
    },
  } as const;
}

/**
 * TX-3.0 — the ONE include for a banking LIST read (resolved merchant + KD-15
 * counterparty visibility). Exported so the keyset explorer authority
 * (lib/data/transaction-query.ts) fetches the identical row shape as getTransactions
 * — the DTO can never diverge between the two reads.
 */
export function transactionListInclude(spaceId: string) {
  return {
    resolvedMerchant: { select: { displayName: true, logoUrl: true } },
    ...counterpartyVisibilityInclude(spaceId),
  } as const;
}

/** The Prisma payload a `transactionListInclude` findMany returns (all scalar
 *  Transaction fields + the two visibility-gated relations). Derived FROM the
 *  include builder (not a hand-written shape) so the KD-15 visibility predicate
 *  lives in exactly one place — the counterparty include — and the privacy
 *  source-scan sees no unguarded spaceAccountLinks literal here. */
export type TransactionListRow = Prisma.TransactionGetPayload<{
  include: ReturnType<typeof transactionListInclude>;
}>;

/**
 * TX-3.0 — the ONE list-row → DTO projection: read-time owned-account transfer
 * matching (KD-15-gated) → canonical serialize → CF-1 context fields → provenance
 * source. Extracted verbatim from getTransactions so getTransactions AND the keyset
 * explorer authority produce byte-identical `Transaction` DTOs (no second builder).
 */
/** Account id → type, for the page's rows only. Bounded by the page size. */
async function loadAccountTypes(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => x != null))];
  if (unique.length === 0) return new Map();
  const rows = await db.financialAccount.findMany({
    where: { id: { in: unique } }, select: { id: true, type: true },
  });
  return new Map(rows.map((a) => [a.id, a.type as string]));
}

export async function projectTransactionListRows(
  rows: TransactionListRow[],
  spaceId: string,
): Promise<Transaction[]> {
  // Phase 6 — ONE call, ONE answer. The id and the maturity come from the same
  // assessment, so the counterparty the DTO shows and the name the DTO gives the
  // movement can never disagree.
  const assessments = await resolveTransferAssessments(rows, { spaceId });
  // V27-TRUTH-4 — the canonical income authority decides partly from the OWNING
  // account's type (interest on a deposit account vs a credit on a liability),
  // and that is not a Transaction column. One bounded lookup over the page's
  // distinct account ids, rather than a join on every list read.
  const accountTypeById = await loadAccountTypes(rows.map((r) => r.financialAccountId));
  return rows.map((r) => ({
    ...serializeTransactionRow({
      ...r,
      counterpartyAccountId: chooseCounterpartyId(
        gatedCounterpartyId(r), assessments.get(r.id)?.counterpartyAccountId ?? null),
      accountType: accountTypeById.get(r.financialAccountId ?? "") ?? null,
    }),
    ...contextFields(r, assessments),
    source: deriveSource(r),
    // TX-3.1b (review M6) — the resolved Merchant id. The explorer's `merchantId`
    // filter was previously unusable: it filtered on a real, indexed, persisted
    // authority (Merchant) that no row ever exposed, so no consumer could supply a
    // value. One additive field turns "more from this merchant" into a real pivot.
    // Null for an unresolved row; the display NAME stays the presentation field.
    merchantId: r.merchantId,
  }));
}

// ── TX-2 — bounded transaction read contract ────────────────────────────────
// Transaction is RAW financial-event data. A consumer must not accidentally load
// a user's entire multi-year history. Every list loader below is bounded by a
// default row cap with a truncation sentinel (the same discipline the AI
// assembler already uses), plus an optional date window. For a population at or
// under the cap the result is byte-identical to the old unbounded read
// (`truncated: false`, same rows) — so DayFacts / Cash Flow / FlowType folds over
// the returned rows are UNCHANGED. Above the cap, `truncated: true` is an honest
// signal (no silent fake completeness); consumers get the most-recent `limit` rows.

// The pure bounding primitives live in a server-only-free module so they can be
// unit-tested in isolation; imported for local use + re-exported for callers.
import { DEFAULT_TX_LIMIT, capFetched, windowFloorDate } from "./transaction-bounds";
export { DEFAULT_TX_LIMIT, capFetched, windowFloorDate };

export interface BoundedTransactions {
  /** The transaction DTOs, newest first, at most `limit` rows. */
  rows:       Transaction[];
  /** True iff more rows matched than `limit` — the returned set is the most-recent slice. */
  truncated:  boolean;
  /** The row cap applied. */
  limit:      number;
  /** The date-window (in days) applied, or null for no window. */
  windowDays: number | null;
}

/** The ONE canonical banking-population `where` (KD-15 visibility + deletedAt +
 *  FlowType population). Shared by the list loaders AND cheap aggregate readers
 *  (e.g. view-context) so they can never disagree on the population. */
export function bankingTransactionWhere(spaceId: string, opts?: { debtOnly?: boolean }): Prisma.TransactionWhereInput {
  return {
    // deletedAt: null guards an archived account's rows; visibilityLevel (KD-15)
    // admits only transaction-detail (FULL) links. debtOnly narrows to debt accounts.
    financialAccount: {
      ...(opts?.debtOnly ? { type: "debt" } : {}),
      deletedAt: null,
      spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } },
    },
    deletedAt: null,
    ...BANKING_POPULATION,
  };
}

/**
 * Banking transactions (excludes investment activity), newest first — BOUNDED.
 * @param ctx.windowDays optional date floor (days back from today)
 * @param ctx.limit      row cap (default DEFAULT_TX_LIMIT); `limit + 1` is fetched
 *                        to detect truncation.
 */
export async function getTransactions(
  ctx?: { spaceId?: string; windowDays?: number; limit?: number },
): Promise<BoundedTransactions> {
  const spaceId    = ctx?.spaceId ?? (await getSpaceContext()).spaceId;
  const limit      = ctx?.limit ?? DEFAULT_TX_LIMIT;
  const windowDays = ctx?.windowDays ?? null;
  const floor      = windowFloorDate(windowDays);

  const fetched = await db.transaction.findMany({
    // L8-B — the bounded list reads on the ECONOMIC chronology, like the
    // explorer. A floor applied to posting while the page is ordered by economic
    // would silently drop rows whose economic date is inside the window.
    where: { ...bankingTransactionWhere(spaceId), ...(floor ? { economicDate: { gte: floor } } : {}) },
    orderBy: { economicDate: { sort: "desc", nulls: "last" } },
    take: limit + 1, // +1 sentinel to detect truncation without a second query
    // MI M6 read cutover — resolved Merchant presentation (additive join).
    // + KD-15 counterparty visibility for the Cash Flow liquidity axis.
    include: transactionListInclude(spaceId),
  });
  const { rows: capped, truncated } = capFetched(fetched, limit);

  // TI4 Slice 1 + TI-1 — read-time owned-account transfer match (KD-15-gated) →
  // canonical serialization → CF-1 context → provenance source. Shared projection
  // so the keyset explorer authority (transaction-query.ts) can never diverge.
  const rows = await projectTransactionListRows(capped, spaceId);
  return { rows, truncated, limit, windowDays };
}

/**
 * The single provenance-source precedence used by BOTH the list read
 * (getTransactions) and the detail read (getTransactionDetail): an import batch
 * wins, else a Plaid-synced row, else manual entry. Pure, derived from flat
 * columns already selected on every row — no new query, no new column. This is
 * the ONE definition of "source"; the two callers must not diverge.
 */
function deriveSource(r: { importBatchId: string | null; plaidTransactionId: string | null }): TransactionProvenanceSource {
  if (r.importBatchId != null) return "import";
  if (r.plaidTransactionId != null) return "plaid";
  return "manual";
}

/** CF-1 — derive the read-time context fields (transferDisposition + needsClassification)
 *  for a list row. Provider-neutral, read-only; no calculation consumes these. */
function contextFields(
  r: {
    id: string; flowType: string | null; classificationReason: string | null;
    transferRail: string | null; transferMovementForm: string | null; transferVenueClass: string | null;
    transferEvidenceConfidence: number | null; transferEvidenceReason: string | null;
    transferEvidenceSource: string | null; transferEvidenceVersion: string | null;
    merchantId: string | null; counterpartyAccountId: string | null;
  },
  assessments: Map<string, { counterpartyAccountId: string | null; maturity: string }>,
) {
  const a = assessments.get(r.id);
  const c = deriveTransactionContext({
    flowType:                   r.flowType,
    classificationReason:       r.classificationReason,
    transferRail:               r.transferRail,
    transferMovementForm:       r.transferMovementForm,
    transferVenueClass:         r.transferVenueClass,
    transferEvidenceConfidence: r.transferEvidenceConfidence,
    transferEvidenceReason:     r.transferEvidenceReason,
    transferEvidenceSource:     r.transferEvidenceSource,
    transferEvidenceVersion:    r.transferEvidenceVersion,
    hasResolvedMerchant:        r.merchantId != null,
    isOwnedCounterparty:        r.counterpartyAccountId != null || a?.counterpartyAccountId != null,
    // Phase 6 — the ladder decides the disposition where it ran.
    transferMaturity:           a?.maturity ?? null,
  });
  return { transferDisposition: c.transferDisposition, needsClassification: c.needsClassification };
}

/**
 * Transactions for debt accounts only (credit-card activity), newest first —
 * BOUNDED (TX-2). Same bounding contract as getTransactions; the debt-payment
 * folds (lib/debt.ts) additionally filter on isDebtPayment(flowType), so the cap
 * never changes their totals within the returned window. The AI debt-payments
 * intelligence consumer inherits this bound automatically.
 */
export async function getDebtTransactions(
  ctx?: { spaceId?: string; windowDays?: number; limit?: number },
): Promise<BoundedTransactions> {
  const spaceId    = ctx?.spaceId ?? (await getSpaceContext()).spaceId;
  const limit      = ctx?.limit ?? DEFAULT_TX_LIMIT;
  const windowDays = ctx?.windowDays ?? null;
  const floor      = windowFloorDate(windowDays);

  const fetched = await db.transaction.findMany({
    where: { ...bankingTransactionWhere(spaceId, { debtOnly: true }), ...(floor ? { economicDate: { gte: floor } } : {}) },
    orderBy: { economicDate: { sort: "desc", nulls: "last" } },
    take: limit + 1,
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } }, ...counterpartyVisibilityInclude(spaceId) },
  });
  const { rows: capped, truncated } = capFetched(fetched, limit);

  const assessments = await resolveTransferAssessments(capped, { spaceId });
  const rows = capped.map((r) => ({
    ...serializeTransactionRow({
      ...r,
      counterpartyAccountId: chooseCounterpartyId(
        gatedCounterpartyId(r), assessments.get(r.id)?.counterpartyAccountId ?? null),
    }),
    ...contextFields(r, assessments),
  }));
  return { rows, truncated, limit, windowDays };
}

/**
 * V27-TRUTH-7 — the rows the debt-payment authority selects from.
 *
 * `getDebtTransactions` is LIABILITY-scoped, so it can only ever see the leg
 * that arrives on a card. The counted leg is the CASH leg, which lives on the
 * checking account the money left — measured on the live corpus, 26 of those
 * ($50,150) have no liability leg at all, because the liability is not connected
 * to this app. A liability-scoped read cannot see them, and a total built from
 * one silently under-reports.
 *
 * So this read spans the whole banking population and narrows to DEBT_PAYMENT.
 * It does NOT choose the leg — `selectDebtPaymentCashLegs` does, from the tiers.
 * Same Space scoping, same KD-15 visibility, same bound as its sibling.
 */
export async function getDebtPaymentRows(
  ctx?: { spaceId?: string; windowDays?: number; limit?: number },
): Promise<BoundedTransactions> {
  const spaceId    = ctx?.spaceId ?? (await getSpaceContext()).spaceId;
  const limit      = ctx?.limit ?? DEFAULT_TX_LIMIT;
  const windowDays = ctx?.windowDays ?? null;
  const floor      = windowFloorDate(windowDays);

  const fetched = await db.transaction.findMany({
    where: {
      ...bankingTransactionWhere(spaceId),
      flowType: FlowType.DEBT_PAYMENT,
      ...(floor ? { economicDate: { gte: floor } } : {}),
    },
    orderBy: { economicDate: { sort: "desc", nulls: "last" } },
    take: limit + 1,
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } }, ...counterpartyVisibilityInclude(spaceId) },
  });
  const { rows: capped, truncated } = capFetched(fetched, limit);

  const assessments = await resolveTransferAssessments(capped, { spaceId });
  const rows = capped.map((r) => ({
    ...serializeTransactionRow({
      ...r,
      counterpartyAccountId: chooseCounterpartyId(
        gatedCounterpartyId(r), assessments.get(r.id)?.counterpartyAccountId ?? null),
    }),
    ...contextFields(r, assessments),
    // The tier resolver needs the owning account; the list DTO does not carry it.
    financialAccountId: r.financialAccountId,
  }));
  return { rows, truncated, limit, windowDays };
}

/**
 * TX-4 — `getInvestmentTransactions()` was DELETED here.
 *
 * It had no consumer (dead since P2-2) and, unlike every other transaction read in
 * this file, it was UNBOUNDED — no `take`, no window. TX-1 flagged it as the one
 * remaining unbounded loader and TX-2/CLEAN-0 both deferred its removal. Wiring it
 * up would have reintroduced exactly the unbounded read this whole arc removed, so
 * the dead code is gone rather than left as a loaded gun.
 *
 * The pure `serializeInvestmentTransactionRow` it used is deliberately KEPT: it is
 * side-effect-free, has frozen golden coverage, and is owned by the concurrent
 * investment truth-spine track (P2-5/P2-6), whose canonical migration will retire or
 * re-express it. Recoverable at cd28478 if that track wants the loader back.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TI-1 — single-transaction detail read
// ─────────────────────────────────────────────────────────────────────────────

/** Resolved account display name — the schema-documented resolution order. */
function resolveAccountName(fa: {
  name: string;
  displayName: string | null;
  officialName: string | null;
  plaidName: string | null;
}): string {
  return fa.displayName ?? fa.officialName ?? fa.plaidName ?? fa.name;
}

/**
 * The canonical single-transaction detail read (TI-1).
 *
 * Visibility: transactionDetailWhere() (lib/transactions/detail-query.ts) —
 * the row-scoped form of the exact KD-15 predicate the list reads above
 * apply. Returns null (→ caller 404s) for: nonexistent id, soft-deleted row,
 * row outside the Space, non-FULL share, soft-deleted FinancialAccount.
 * Fails closed; "not found" and "not yours" are indistinguishable.
 *
 * Stored-data-only: every field is read from existing columns/relations —
 * no new capture, no writes. Internal/provider identifiers are resolved into
 * display-safe blocks and never exposed raw (see TransactionDetail in
 * types/index.ts).
 *
 * Counterparty (KD-18 seam): resolved by NAME only when the counterparty
 * account itself is visible to this Space at a transaction-detail-granting
 * tier — the SAL sub-query below carries the same shared predicate, so the
 * KD-15 tripwires cover it. Otherwise `{ visible: false }` (rendered as
 * "another account", never by name).
 *
 * Reporting conversion (MC1): read-time, at the row's own date, into the
 * Space's reporting currency via the canonical server context. Pure
 * presentation — never mutates or persists anything. Omitted (null) on the
 * clean identity path so all-native-currency Spaces see no conversion block.
 */
export async function getTransactionDetail(
  id: string,
  ctx?: { spaceId: string },
): Promise<TransactionDetail | null> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const row = await db.transaction.findFirst({
    where: transactionDetailWhere(id, spaceId),
    include: {
      // MI M6 read cutover — resolved Merchant presentation (additive join).
      resolvedMerchant: { select: { displayName: true, logoUrl: true } },
      financialAccount: {
        select: {
          id: true, name: true, displayName: true, officialName: true,
          plaidName: true, institution: true, mask: true, type: true,
          // TI4 Slice 1 — owner anchor for cross-account transfer candidate gathering.
          ownerUserId: true,
        },
      },
      importBatch: {
        select: {
          source: true, originalFilename: true,
          completedAt: true, createdAt: true,
        },
      },
      counterpartyAccount: {
        select: {
          id: true, name: true, displayName: true, officialName: true,
          plaidName: true, deletedAt: true,
          // Name-exposure gate: visible only through an ACTIVE link granting
          // transaction detail (same predicate as every other read here).
          spaceAccountLinks: {
            where: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } },
            select: { id: true },
          },
        },
      },
    },
  });
  if (!row) return null;

  // ── Resolved account context (never raw FKs) ───────────────────────────────
  if (!row.financialAccount) {
    // Unreachable by the WHERE construction (the canonical FinancialAccount
    // path must have matched); fail closed rather than fabricate context.
    return null;
  }
  const fa = row.financialAccount;
  const account: TransactionDetailAccount = {
    id:          fa.id,
    name:        resolveAccountName(fa),
    institution: fa.institution,
    mask:        fa.mask ?? null,
    type:        fa.type,
  };

  // ── Provenance (display-safe; raw ids stay internal) ───────────────────────
  // Source value comes from the shared deriveSource precedence (identical to the
  // list read); the import branch additionally carries the batch's display facts.
  const source = deriveSource(row);
  const provenance: TransactionDetailProvenance = source === "import" && row.importBatch
    ? {
        source,
        importSource:   row.importBatch.source,
        importFilename: row.importBatch.originalFilename ?? null,
        importedAt:     (row.importBatch.completedAt ?? row.importBatch.createdAt).toISOString(),
      }
    : { source };

  // ── Counterparty (fails closed on name exposure) ───────────────────────────
  let counterparty: TransactionDetailCounterparty | null = null;
  if (row.counterpartyAccountId) {
    const cp = row.counterpartyAccount;
    counterparty =
      cp && cp.deletedAt === null && cp.spaceAccountLinks.length > 0
        ? { visible: true, accountId: cp.id, name: resolveAccountName(cp) }
        : { visible: false };
  }

  // ── MC1 reporting conversion (read-time, row's own date) ───────────────────
  const dateISO = row.date.toISOString().split("T")[0];
  const moneyCtx = await buildSpaceConversionContextById(spaceId, {
    currencies: [row.currency ?? null],
    dates:      [dateISO],
  });
  const conv = convertMoney(
    { amount: row.amount, currency: row.currency ?? null },
    dateISO,
    moneyCtx,
  );
  const reporting: TransactionDetailReporting | null =
    conv.conversion === null && !conv.estimated
      ? null // clean identity — the block adds no information
      : {
          // V25-FINAL-1 — null when unavailable (no rate); never a native magnitude
          // relabeled as the reporting currency.
          amount:           conv.amount,
          currency:         conv.currency,
          estimated:        conv.estimated,
          unavailable:      conv.amount === null,
          rate:             conv.conversion?.rate ?? null,
          effectiveDateISO: conv.conversion?.effectiveDateISO ?? null,
        };

  // ── TI5-2 / TI4 Slice 1 — read-time relationship resolution ────────────────
  // Same-account rows within a bounded window resolve pending→posted + duplicate.
  // TI4 Slice 1 additionally gathers the owner's OTHER owned accounts' TRANSFER
  // legs so transferCandidate (deterministic owned-account matching) can resolve.
  // deletedAt is NOT filtered (a tombstoned pending row must still resolve; the
  // resolvers exclude tombstoned rows from duplicate/transfer matching themselves).
  // L8-B — the gather window filters the STORED POSTING column (economicDate is
  // now persisted, but this window also serves pending↔posted and duplicate
  // matching, which are posting-shaped). Because a leg's economic date can sit up
  // to ECONOMIC_DATE_MAX_LAG_DAYS BEFORE its posting date, a window sized for the
  // economic distance would starve the matcher of rows it must see. Widened by
  // exactly that bound: a bounded over-fetch, never a semantic change — the
  // matcher still refuses anything outside the real ±window.
  const RELATIONSHIP_WINDOW_MS = (7 + ECONOMIC_DATE_MAX_LAG_DAYS) * 24 * 60 * 60 * 1000;
  const ownerUserId = row.financialAccount?.ownerUserId ?? null;
  const ownedAccounts = ownerUserId
    ? await db.financialAccount.findMany({
        where: { ownerUserId, deletedAt: null },
        select: { id: true, type: true, mask: true, institutionId: true },
      })
    : [];
  const ownedAccountIds = ownedAccounts.map((a) => a.id);
  // V27-TRUTH-2 — the canonical authority decides from account TYPE, so the
  // detail read supplies the same context the list read does.
  // Phase 5 — the mask index, from the SAME owned-account graph. Present with
  // every account carrying a given mask, so an ambiguous mask abstains.
  const maskToAccountIds = new Map<string, string[]>();
  for (const a of ownedAccounts) {
    if (!a.mask) continue;
    const list = maskToAccountIds.get(a.mask);
    if (list) list.push(a.id); else maskToAccountIds.set(a.mask, [a.id]);
  }
  const institutionByAccount = new Map(ownedAccounts.map((a) => [a.id, a.institutionId ?? null]));
  const matchCtx = {
    accountTypeById: new Map(ownedAccounts.map((a) => [a.id, a.type as string])),
    maskToAccountIds,
  };
  const candidates = await db.transaction.findMany({
    where: {
      OR: [
        // Same-account candidates — pending→posted + duplicate (unchanged behavior).
        { financialAccountId: row.financialAccountId },
        // Owned cross-account transfer legs — the transferCandidate population.
        // V27-TRUTH-2 — this was `flowType: TRANSFER` alone, NARROWER than the
        // list read's `isTransferCandidate` set, so the drawer and the list could
        // disagree about the same row. Both now admit the same population; `null`
        // is spelled out because a NOT-IN over a nullable column drops nulls.
        ...(ownedAccountIds.length
          ? [{
              financialAccountId: { in: ownedAccountIds },
              OR: [
                { flowType: { in: [FlowType.TRANSFER, FlowType.DEBT_PAYMENT, FlowType.UNKNOWN] } },
                { flowType: null },
              ],
            }]
          : []),
      ],
      id:   { not: row.id },
      date: {
        gte: new Date(row.date.getTime() - RELATIONSHIP_WINDOW_MS),
        lte: new Date(row.date.getTime() + RELATIONSHIP_WINDOW_MS),
      },
    },
    select: {
      id: true, financialAccountId: true,
      plaidTransactionId: true, pendingTransactionRef: true,
      date: true, economicDate: true, amount: true, merchant: true, pending: true,
      deletedAt: true, flowType: true, currency: true,
      settlementState: true, pfcDetailed: true, pfcPrimary: true,
      counterpartyAccountId: true,
      // Financial Truth (Transfer Authority) — admission reads `category`, the
      // external leaves read `counterpartyType`, identifier extraction reads
      // `description`. The DRAWER must admit the same facts as the LIST or the
      // two disagree about one row — the exact defect V27-TRUTH-2 closed once.
      category: true, counterpartyType: true, description: true,
    },
    take: 300, // safety cap; same-account sets are tiny, owned ±window sets are small
  });
  // Every candidate is on an account owned by the SAME user (the query scopes it
  // that way), so one owner id covers the whole set.
  // V27-TRUTH-3 — `persistedCounterpartyAccountId` is spelled out rather than
  // spread: the liability-inflow authority must read the row's OWN persisted
  // link, and a silently-absent field would resolve every card credit as
  // UNDETERMINED instead of consulting the proof that is right there.
  const withOwner = <T extends {
    financialAccountId: string | null; counterpartyAccountId?: string | null;
    pfcPrimary?: string | null; category?: unknown; counterpartyType?: unknown;
    description?: string | null; merchant?: string;
  }>(r: T) => ({
    ...r,
    ownerUserId,
    pfcPrimary: r.pfcPrimary ?? null,
    persistedCounterpartyAccountId: r.counterpartyAccountId ?? null,
    category:          (r.category as string | null) ?? null,
    counterpartyClass: (r.counterpartyType as string | null) ?? null,
    institutionId:     institutionByAccount.get(r.financialAccountId ?? "") ?? null,
    descriptor:        `${r.merchant ?? ""} ${r.description ?? ""}`,
  });
  let relationships = resolveTransactionRelationships(
    withOwner(row),
    candidates.map(withOwner),
    matchCtx,
  );

  // KD-15 — transferCandidate names an owned account id; expose it only when that
  // account is visible to this Space (same gate as counterpartyAccountId). Fails
  // closed: an unresolvable/invisible counterparty leaves the row unmatched.
  let resolvedTransferCpId: string | null = null;
  if (relationships.transferCandidate?.counterpartyAccountId) {
    const visible = await filterVisibleCounterpartyAccounts(
      [relationships.transferCandidate.counterpartyAccountId],
      spaceId,
    );
    if (visible.has(relationships.transferCandidate.counterpartyAccountId)) {
      resolvedTransferCpId = relationships.transferCandidate.counterpartyAccountId;
    } else {
      relationships = { ...relationships, transferCandidate: null };
    }
  }

  // L8 — the logical event this row projects, for verification. One bounded
  // lookup on the detail read only; the LIST never pays for it.
  const eventIdentity = row.transactionEventId
    ? await (async () => {
        const ev = await db.transactionEvent.findUnique({
          where: { id: row.transactionEventId as string },
          select: {
            id: true, lifecycle: true, economicDate: true, currentAmount: true,
            currentTransactionId: true, observationCount: true,
            firstObservedAt: true, lastObservedAt: true,
            firstPendingObservedAt: true, postedObservedAt: true,
            observations: {
              select: { id: true, lifecycle: true, amount: true, postingDate: true, economicDate: true, observedAt: true },
              orderBy: { observedAt: "asc" },
            },
          },
        });
        if (!ev) return null;
        return {
          eventId: ev.id,
          lifecycle: ev.lifecycle,
          economicDate: ev.economicDate.toISOString().slice(0, 10),
          currentAmount: ev.currentAmount,
          isCurrentProjection: ev.currentTransactionId === row.id,
          observationCount: ev.observationCount,
          firstObservedAt: ev.firstObservedAt.toISOString(),
          lastObservedAt: ev.lastObservedAt.toISOString(),
          firstPendingObservedAt: ev.firstPendingObservedAt?.toISOString() ?? null,
          postedObservedAt: ev.postedObservedAt?.toISOString() ?? null,
          observations: ev.observations.map((o) => ({
            lifecycle: o.lifecycle,
            amount: o.amount,
            // Both dates, explicitly labelled — an observation records what the
            // provider said, and posting is provenance beside the economic date.
            postingDate: o.postingDate.toISOString().slice(0, 10),
            economicDate: o.economicDate.toISOString().slice(0, 10),
            observedAt: o.observedAt.toISOString(),
          })),
        };
      })()
    : null;

  // TE-2B — derive the needs-classification disclosure from canonical fields. The
  // raw inputs (transferRail, merchantId, classificationReason) stay server-side;
  // only the boolean + a provider-neutral reason reach the DTO. A resolved owned
  // counterparty (persisted OR read-time matched) counts as a stronger known meaning.
  const needs = shouldSurfaceAsNeedsClassification({
    flowType:                row.flowType ?? null,
    classificationReason:    row.classificationReason ?? null,
    transferRail:            row.transferRail ?? null,
    hasResolvedMerchant:     row.merchantId != null,
    hasResolvedCounterparty: row.counterpartyAccountId != null || resolvedTransferCpId != null,
  });

  return {
    // V27-TRUTH-7 — `accountType` MUST be supplied here, exactly as the list read
    // supplies it (see loadAccountTypes above).
    //
    // Without it the serializer fell through to "other", so
    // `liabilityInflowIsIssuerCredit` — which requires accountType === "debt" —
    // was always false on this path. The drawer therefore attributed the four
    // live issuer credits (Microsoft, Uber, HungerStation, EasyTime) as EARNED
    // income while the list, reading the same authority WITH the account type,
    // called them ISSUER_CREDIT. Same row, two answers, decided by which read
    // happened to pass the evidence.
    ...serializeTransactionRow({ ...row, accountType: row.financialAccount?.type ?? null }),
    // KD-15: override the serializer's raw value with the gated id (the detail's
    // counterpartyAccount already carries the same Space-filtered links), so the
    // detail DTO never exposes a non-visible counterparty's id — consistent with
    // the resolved `counterparty` block below. TI4 Slice 1: a persisted (provider-
    // confirmed) link wins; otherwise a KD-15-gated read-time transfer match fills in.
    counterpartyAccountId: chooseCounterpartyId(gatedCounterpartyId(row), resolvedTransferCpId),
    pfcPrimary:         row.pfcPrimary ?? null,
    pfcDetailed:        row.pfcDetailed ?? null,
    pfcConfidenceLevel: row.pfcConfidenceLevel ?? null,
    createdAt:          row.createdAt.toISOString(),
    // TI5-1 — expose the already-persisted TI2 durable facts (detail-only; the
    // list serializer and list DTOs are untouched). authorizedAt is rendered as
    // an ISO date, mirroring how `date` is serialized.
    paymentChannel:        row.paymentChannel ?? null,
    paymentMethod:         row.paymentMethod ?? null,
    settlementState:       row.settlementState ?? null,
    authorizedAt:          row.authorizedAt ? row.authorizedAt.toISOString().split("T")[0] : null,
    counterpartyType:      row.counterpartyType ?? null,
    fxApplied:             row.fxApplied ?? null,
    pendingTransactionRef: row.pendingTransactionRef ?? null,
    tiFactsVersion:        row.tiFactsVersion ?? null,
    account,
    provenance,
    counterparty,
    reporting,
    relationships,
    // TE-2B — disclosure only; no calculation consumes these.
    needsClassification:       needs.needsClassification,
    needsClassificationReason: needs.reason,
    // ── L8 — event identity, as PROVENANCE ONLY ────────────────────────────
    //
    // The narrow verification surface the L8 slice permits: enough to confirm a
    // pending row and its posted successor share one event, and nothing more.
    //
    // ⚠️ DISCLOSURE, not behaviour. No total, ordering, grouping, classification
    // or projection consults it, and a standing probe asserts that the
    // behavioural readers (query core, count, cash flow, exports, AI, the
    // serializer) still do not. The reader cutover is a separate slice.
    ...(eventIdentity ? { eventIdentity } : {}),
  };
}
