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
 *
 * ── RLS-T1: THIS MODULE'S READS NO LONGER CHOOSE THEIR OWN AUTHORITY ────────
 *
 * Every read leaf below takes its client as a REQUIRED, LEADING parameter typed
 * `ReadClient` (the idiom RLS-C-S2 d98ec57 / RLS-C-S3 ece4bf3 / RLS-AI-S6
 * de85df7 established). There is deliberately NO `client = db` default: an
 * OPTIONAL authority is an AMBIENT one, and the call sites that forget it are
 * exactly the ones nobody reviews. `ReadClient` carries no `$transaction`, so a
 * leaf here is structurally incapable of opening a phase of its own — the phase
 * always belongs to the caller that earned the identity.
 *
 * TABLES REACHED, CLASSIFIED (nothing is waved through):
 *   · Transaction, FinancialAccount, ImportBatch — TENANT. RLS section 14/15:
 *     `fm_account_visible("financialAccountId")` (and `ownerUserId =
 *     current_fm_user_id() OR fm_account_visible("id")` for the account itself).
 *     Under `fm_app` the POLICY is what refuses a foreign id; the application
 *     `where` narrows further but is no longer the only thing standing there.
 *   · Space — TENANT. RLS section 11: membership, or a PlatformGrant arm.
 *   · Merchant (`resolvedMerchant`) — GLOBAL REFERENCE. RLS section 5: granted
 *     to fm_app with NO row-level security, because one vendor answer serves
 *     every tenant. It is reached as a relation of a tenant row, so it is
 *     already keyed by a row the policy admitted.
 *   · FxRate — GLOBAL REFERENCE, and reached INDIRECTLY: `lib/money/*` builds
 *     the conversion context through the FX archive, which holds its own client.
 *     Classified here rather than silently inherited; converting that archive
 *     is not this slice's file.
 *
 * ⚠️ ONE READ IN THIS MODULE IS STILL UNCONVERTED AND SAYS SO: see
 * `getDebtPaymentRows`.
 */

import type { ReadClient } from "@/lib/db/tenant-context";
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";
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
import { assertOneRowPerEvent } from "@/lib/transactions/event-projection";
// v2.6-OWN-2 — the canonical population fragment now lives in a `server-only`-free
// module so read-only audits can measure the SAME population the UI reads. Moved
// verbatim; re-exported here so every existing importer is unchanged.
export { BANKING_POPULATION, bankingTransactionWhere } from "@/lib/data/banking-population";
import { bankingTransactionWhere } from "@/lib/data/banking-population";
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
import { convertMoney, identityContext } from "@/lib/money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { buildSpaceConversionContext } from "@/lib/money/server-context";
import { ECONOMIC_DATE_MAX_LAG_DAYS } from "@/lib/transactions/economic-date";


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
async function loadAccountTypes(
  client: ReadClient, ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => x != null))];
  if (unique.length === 0) return new Map();
  const rows = await client.financialAccount.findMany({
    where: { id: { in: unique } }, select: { id: true, type: true },
  });
  return new Map(rows.map((a) => [a.id, a.type as string]));
}

/**
 * RLS-C-S3 — `client` is REQUIRED and leading, because the DTO and the rows it
 * projects must come from ONE authority. `queryTransactions` reads a page and then
 * asks this function to finish it; if the page were read as the tenant and the
 * account-type lookup as the migration principal, a row could be enriched by a
 * fact the reader is not entitled to.
 *
 * RLS-AI-S6 completed the reach downwards: `resolveTransferAssessments` and
 * `filterVisibleCounterpartyAccounts` now require their authority too, and it
 * recorded the consequence this comment used to defer — under `fm_app` a
 * co-member's accounts NOT linked into a visible Space drop out of candidate
 * gathering, so the far leg of such a transfer becomes unresolvable and the row
 * reports NO counterparty. A NARROWING, never a widening.
 */
export async function projectTransactionListRows(
  client: ReadClient,
  rows: TransactionListRow[],
  spaceId: string,
): Promise<Transaction[]> {
  // Phase 6 — ONE call, ONE answer. The id and the maturity come from the same
  // assessment, so the counterparty the DTO shows and the name the DTO gives the
  // movement can never disagree.
  const assessments = await resolveTransferAssessments(client, rows, { spaceId });
  // v2.6-TRUTH-4 — the canonical income authority decides partly from the OWNING
  // account's type (interest on a deposit account vs a credit on a liability),
  // and that is not a Transaction column. One bounded lookup over the page's
  // distinct account ids, rather than a join on every list read.
  const accountTypeById = await loadAccountTypes(client, rows.map((r) => r.financialAccountId));
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


/**
 * RLS-C-S1 — the bounded-read scope. `spaceId` is REQUIRED and the ambient
 * ambient space-context fallback is gone, so no read in this module can name its own
 * tenant. `windowDays` / `limit` stay optional: they are bounding policy, not
 * identity.
 */
interface BoundedReadScope {
  spaceId:     string;
  windowDays?: number;
  limit?:      number;
}

/**
 * Banking transactions (excludes investment activity), newest first — BOUNDED.
 *
 * RLS-T1 — `client` is REQUIRED and LEADING. The page and the DTO projected from
 * it come from ONE authority: if the rows were read as the tenant and the
 * account-type / transfer-candidate enrichment as the migration principal, a row
 * could be enriched by a fact the reader is not entitled to.
 *
 * @param client           REQUIRED — the authority this read executes through.
 * @param scope.spaceId    REQUIRED — the Space whose banking population to read.
 * @param scope.windowDays optional date floor (days back from today)
 * @param scope.limit      row cap (default DEFAULT_TX_LIMIT); `limit + 1` is fetched
 *                          to detect truncation.
 */
export async function getTransactions(
  client: ReadClient,
  scope: BoundedReadScope,
): Promise<BoundedTransactions> {
  const spaceId    = scope.spaceId;
  const limit      = scope.limit ?? DEFAULT_TX_LIMIT;
  const windowDays = scope.windowDays ?? null;
  const floor      = windowFloorDate(windowDays);

  const fetched = await client.transaction.findMany({
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
  // L8-B1 — the filter should make this unreachable. It is here so that if the
  // projection filter is ever dropped from the population, this read breaks
  // instead of the numbers.
  assertOneRowPerEvent(capped, "getTransactions");

  // TI4 Slice 1 + TI-1 — read-time owned-account transfer match (KD-15-gated) →
  // canonical serialization → CF-1 context → provenance source. Shared projection
  // so the keyset explorer authority (transaction-query.ts) can never diverge.
  // RLS-T1 — the projection runs on the SAME client the page was read with, so
  // the page and its DTO cannot be assembled by two different roles.
  const rows = await projectTransactionListRows(client, capped, spaceId);
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
  // v2.6-TRUTH-8 — the maturity is the transfer authority's VERDICT about the
  // destination, and it was computed here and thrown away. Presentation then had
  // only `flowType` (often the provider's category) to go on, so a movement the
  // authority had called SAVINGS_TRANSFER still rendered "Debt payment".
  return {
    transferDisposition: c.transferDisposition,
    needsClassification: c.needsClassification,
    transferMaturity:    a?.maturity ?? null,
  };
}

/**
 * Transactions for debt accounts only (credit-card activity), newest first —
 * BOUNDED (TX-2). Same bounding contract as getTransactions; the debt-payment
 * folds (lib/debt.ts) additionally filter on isDebtPayment(flowType), so the cap
 * never changes their totals within the returned window. The AI debt-payments
 * intelligence consumer inherits this bound automatically.
 *
 * RLS-T1 — `client` is REQUIRED and LEADING, for the reason stated on
 * `getTransactions`: the page and the transfer assessments projected onto it must
 * come from one authority.
 */
export async function getDebtTransactions(
  client: ReadClient,
  scope: BoundedReadScope,
): Promise<BoundedTransactions> {
  const spaceId    = scope.spaceId;
  const limit      = scope.limit ?? DEFAULT_TX_LIMIT;
  const windowDays = scope.windowDays ?? null;
  const floor      = windowFloorDate(windowDays);

  const fetched = await client.transaction.findMany({
    where: { ...bankingTransactionWhere(spaceId, { debtOnly: true }), ...(floor ? { economicDate: { gte: floor } } : {}) },
    orderBy: { economicDate: { sort: "desc", nulls: "last" } },
    take: limit + 1,
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } }, ...counterpartyVisibilityInclude(spaceId) },
  });
  const { rows: capped, truncated } = capFetched(fetched, limit);
  // L8-B1 — the filter should make this unreachable. It is here so that if the
  // projection filter is ever dropped from the population, this read breaks
  // instead of the numbers.
  assertOneRowPerEvent(capped, "getDebtTransactions");

  // RLS-T1 — the assessments run on the SAME client the page was read with.
  const assessments = await resolveTransferAssessments(client, capped, { spaceId });
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
 * v2.6-TRUTH-7 — the rows the debt-payment authority selects from.
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
 *
 * ── RLS-T1a — AND THE SECOND CALLER TURNED OUT NOT TO EXIST ─────────────────
 *
 * RLS-T1 left this one read on the migration principal and said why: a required
 * parameter enumerates its callers through the compiler, and a SECOND caller sat
 * in `lib/ai/intelligence/debt-payments.ts`, outside that slice's ownership. It
 * named the exact unblocking edit — add a `db` import there and pass it — and
 * requested it rather than reaching across the boundary. That was the right call
 * and the right stopping point.
 *
 * The edit was not made, because doing it would have ADDED a file to the
 * authority ratchet in order to keep an unreferenced function compiling. The
 * module was dead: no static importer, no dynamic `import()`, no `require`, no
 * barrel re-export, and both of its exports referenced in zero other files —
 * checked that way rather than by a bare grep, because a bare grep has already
 * been wrong once in this programme. 97 lines, deleted.
 *
 * So the conversion completes and this module leaves the ratchet. The lesson is
 * the shape of the stop, not the deletion: "a required client cannot be added
 * without editing that file" was a true statement about a file that should not
 * have existed, and the compiler is what made the question visible at all.
 */
export async function getDebtPaymentRows(
  client: ReadClient,
  scope: BoundedReadScope,
): Promise<BoundedTransactions> {
  const spaceId    = scope.spaceId;
  const limit      = scope.limit ?? DEFAULT_TX_LIMIT;
  const windowDays = scope.windowDays ?? null;
  const floor      = windowFloorDate(windowDays);

  const fetched = await client.transaction.findMany({
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
  // L8-B1 — the filter should make this unreachable. It is here so that if the
  // projection filter is ever dropped from the population, this read breaks
  // instead of the numbers.
  assertOneRowPerEvent(capped, "getDebtPaymentRows");

  // RLS-T1 — `resolveTransferAssessments` requires its authority. This read is
  // the one in this module still holding `db` (see the header above for why and
  // for the exact edit that unblocks it), so it passes it EXPLICITLY. That is the
  // point of the required parameter: an unconverted caller stays legible instead
  // of looking converted.
  const assessments = await resolveTransferAssessments(client, capped, { spaceId });
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
  // v2.6-TRUTH-10 — the ONE identity authority.
  return accountDisplayName(fa);
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
 *
 * ── RLS-T1: `id` IS CLIENT-SUPPLIED, AND THAT IS NOW THE POLICY'S PROBLEM ────
 *
 * This is the one read in this module whose row key comes straight off the wire:
 * `GET /api/transactions/[id]` and `POST /api/transactions/[id]/correct` take it
 * from the URL path, so a caller can name ANY transaction id in the deployment.
 * Nothing stops them guessing one.
 *
 * Until this slice, the ONLY thing that refused a foreign id was
 * `transactionDetailWhere(id, spaceId)` — an application `where`. It is a good
 * predicate and it is KEPT, but it was load-bearing alone: delete one clause of
 * it and the read answers for somebody else's row. Executed through
 * `withTenantDb`, the refusal is now ALSO a database one, and strictly stronger:
 *
 *   Transaction  →  USING (fm_account_visible("financialAccountId"))
 *   fm_account_visible(acct)  →  EXISTS (SELECT 1 FROM "SpaceAccountLink"
 *                                 WHERE "financialAccountId" = acct
 *                                   AND status = 'ACTIVE'
 *                                   AND "spaceId" IN (SELECT fm_visible_space_ids()))
 *   fm_visible_space_ids()    →  the ACTIVE SpaceMember rows of current_fm_user_id()
 *
 * The two gates ask DIFFERENT questions and both must pass. The policy asks "is
 * this row in a Space this IDENTITY belongs to?" — it does not read `spaceId`
 * from the request at all, so a tampered or stale active-Space cookie cannot
 * widen it. The application `where` asks "does the Space named by the request
 * hold this account at a TRANSACTION-DETAIL tier?" — the KD-15 redaction tier,
 * which RLS deliberately does not reproduce (migration §Q1: "RLS ENFORCES
 * TENANCY ONLY", so one question never has two authorities). Neither gate
 * subsumes the other, and a foreign id now has to defeat both.
 *
 * ⚠️ TWO NARROWINGS, BOTH FAIL-CLOSED, BOTH RECORDED RATHER THAN DISCOVERED:
 *   · `importBatch` is in the account subtree (RLS §15), keyed on its OWN
 *     `financialAccountId`. A batch whose account is no longer ACTIVE-linked
 *     into a visible Space becomes invisible, and `provenance` degrades from the
 *     full import block to a bare `{ source: "import" }`. The source verdict
 *     itself is derived from a column on the row, so it never changes.
 *   · owned-account candidate gathering (`ownerUserId`) is narrowed exactly as
 *     RLS-AI-S6 recorded for `resolveTransferAssessments`: a co-member's account
 *     not linked into a visible Space drops out, so the far leg of such a
 *     transfer stops resolving and the row reports NO counterparty.
 */
export async function getTransactionDetail(
  client: ReadClient,
  id: string,
  scope: { spaceId: string },
): Promise<TransactionDetail | null> {
  // RLS-C-S1 — REQUIRED. A detail read that resolved its own Space could answer
  // for a tenant the caller's client is not bound to.
  const { spaceId } = scope;

  const row = await client.transaction.findFirst({
    where: transactionDetailWhere(id, spaceId),
    include: {
      // MI M6 read cutover — resolved Merchant presentation (additive join).
      resolvedMerchant: { select: { displayName: true, logoUrl: true } },
      financialAccount: {
        select: {
          // v2.6-TRUTH-10 — the authority's own select, spread rather than
          // hand-listed. The four columns were complete here; a hand-written list
          // is complete until someone edits it, and an omitted column downgrades
          // the identity silently — which is how this defect started.
          id: true, ...ACCOUNT_NAME_SELECT,
          institution: true, mask: true, type: true,
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
          id: true, ...ACCOUNT_NAME_SELECT, deletedAt: true,
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
  //
  // ⚠️ PERSISTED counterparties only. The READ-TIME match the transfer authority
  // resolves is folded in further down, once it has passed its own KD-15 gate —
  // see the `resolvedTransferCpId` block. Keeping the two apart is deliberate:
  // this one reads a relation already loaded by the query above, that one costs
  // a lookup and must not run when a persisted link already answers.
  let counterparty: TransactionDetailCounterparty | null = null;
  if (row.counterpartyAccountId) {
    const cp = row.counterpartyAccount;
    counterparty =
      cp && cp.deletedAt === null && cp.spaceAccountLinks.length > 0
        ? { visible: true, accountId: cp.id, name: resolveAccountName(cp) }
        : { visible: false };
  }

  // ── MC1 reporting conversion (read-time, row's own date) ───────────────────
  //
  // RLS-T1 — this was `buildSpaceConversionContextById(spaceId, …)`, which does
  // its OWN `db.space.findUnique` three files away. Calling it from a tenant
  // phase would have read the Space row as the migration principal while
  // everything around it ran as the caller — the split-authority shape RLS-AI-S6
  // closed for `buildSpaceConversionContextById` on the assembler paths, closed
  // here the same way: the Space row is read on THIS phase's client and the FX
  // context is built from it by the sibling that "performs no Space reads
  // itself" (its own header). The `identityContext` fallback for a Space row that
  // vanished mid-request is preserved verbatim.
  //
  // `FxRate` beneath `buildSpaceConversionContext` is GLOBAL REFERENCE DATA
  // (RLS §5: granted to fm_app, no row-level security at all, because an
  // exchange rate belongs to no tenant). It is reached through the FX archive's
  // own client, which is not this slice's file — classified here explicitly
  // rather than left to be inherited silently.
  const dateISO = row.date.toISOString().split("T")[0];
  const spaceRow = await client.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  const moneyCtx = spaceRow
    ? await buildSpaceConversionContext(spaceRow, {
        currencies: [row.currency ?? null],
        dates:      [dateISO],
      })
    : identityContext(DEFAULT_DISPLAY_CURRENCY);
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
    ? await client.financialAccount.findMany({
        where: { ownerUserId, deletedAt: null },
        select: { id: true, type: true, mask: true, institutionId: true },
      })
    : [];
  const ownedAccountIds = ownedAccounts.map((a) => a.id);
  // v2.6-TRUTH-2 — the canonical authority decides from account TYPE, so the
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
  const candidates = await client.transaction.findMany({
    where: {
      OR: [
        // Same-account candidates — pending→posted + duplicate (unchanged behavior).
        { financialAccountId: row.financialAccountId },
        // Owned cross-account transfer legs — the transferCandidate population.
        // v2.6-TRUTH-2 — this was `flowType: TRANSFER` alone, NARROWER than the
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
      // two disagree about one row — the exact defect v2.6-TRUTH-2 closed once.
      category: true, counterpartyType: true, description: true,
      // W1 (D6) — the candidate's EVENT identity. Without it the resolver
      // structurally could not consult the read-side identity authority, so the
      // drawer rendered "possible duplicate" for provider-distinct rows (two
      // events). The similarity evidence excludes cross-event candidates.
      transactionEventId: true,
    },
    take: 300, // safety cap; same-account sets are tiny, owned ±window sets are small
  });
  // Every candidate is on an account owned by the SAME user (the query scopes it
  // that way), so one owner id covers the whole set.
  // v2.6-TRUTH-3 — `persistedCounterpartyAccountId` is spelled out rather than
  // spread: the liability-inflow authority must read the row's OWN persisted
  // link, and a silently-absent field would resolve every card credit as
  // UNDETERMINED instead of consulting the proof that is right there.
  const withOwner = <T extends {
    financialAccountId: string | null; counterpartyAccountId?: string | null;
    pfcPrimary?: string | null; category?: unknown; counterpartyType?: unknown;
    description?: string | null; merchant?: string;
    transactionEventId?: string | null;
  }>(r: T) => ({
    ...r,
    ownerUserId,
    pfcPrimary: r.pfcPrimary ?? null,
    persistedCounterpartyAccountId: r.counterpartyAccountId ?? null,
    category:          (r.category as string | null) ?? null,
    counterpartyClass: (r.counterpartyType as string | null) ?? null,
    institutionId:     institutionByAccount.get(r.financialAccountId ?? "") ?? null,
    descriptor:        `${r.merchant ?? ""} ${r.description ?? ""}`,
    // W1 (D6) — spelled out rather than left to the spread, for the same reason
    // as `persistedCounterpartyAccountId` above: the similarity evidence MUST
    // consult event identity, and a silently-absent field would quietly disable
    // the cross-event exclusion (the exact defect this wave closes).
    description:        r.description ?? null,
    transactionEventId: r.transactionEventId ?? null,
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
      client, // RLS-T1 — the phase's own authority; same client as the row read.
      [relationships.transferCandidate.counterpartyAccountId],
      spaceId,
    );
    if (visible.has(relationships.transferCandidate.counterpartyAccountId)) {
      resolvedTransferCpId = relationships.transferCandidate.counterpartyAccountId;
    } else {
      relationships = { ...relationships, transferCandidate: null };
    }
  }

  // ── v2.6-XFER-2 — the READ-TIME counterparty reaches the drawer ────────────
  //
  // `counterparty` above keys on the PERSISTED column, so a match the transfer
  // authority resolves at read time never reached it: the DTO carried the
  // resolved id (`counterpartyAccountId`, via chooseCounterpartyId) while the
  // block that holds the NAME stayed null, and the drawer fell back to the
  // provider's counterparty CLASS — "Financial institution" — for a movement the
  // authority had already resolved to a named owned account.
  //
  // Live: three AMEX savings→checking transfers ($6,500) resolved to Rewards
  // Checking by v2.6-XFER-1 and still read "Financial institution".
  //
  // Same KD-15 gate, reused rather than repeated: `resolvedTransferCpId` is
  // already null unless `filterVisibleCounterpartyAccounts` admitted it, so this
  // cannot widen name exposure. One bounded lookup, only when a persisted link
  // did NOT already answer, and only on the detail read.
  if (!counterparty && resolvedTransferCpId) {
    const resolved = await client.financialAccount.findFirst({
      where:  { id: resolvedTransferCpId, deletedAt: null },
      select: { id: true, ...ACCOUNT_NAME_SELECT },
    });
    // v2.6-TRUTH-10 — the ONE identity authority, never a local name order.
    counterparty = resolved
      ? { visible: true, accountId: resolved.id, name: accountDisplayName(resolved) }
      : { visible: false };
  }

  // REVIEW-3 (§2.A) — the `eventIdentity` DTO block was DELETED here. It
  // fetched the row's TransactionEvent + every observation on EACH drawer open,
  // yet no component rendered it and the field was never in the
  // TransactionDetail type — a query per detail read buying nothing. The
  // decision is consistent with the B-6 event-chronology rule: the event's
  // economicDate is now MATERIALIZED into Transaction.economicDate
  // (reprojectEvent), and the serializer discloses the pin's basis
  // (FIRST_PENDING_OBSERVATION) — so the chronology the block existed to let a
  // developer verify is on the row itself, with its provenance, in the fields
  // the drawer already renders. Recoverable at c1036dd if a surface ever wants
  // to render the observation history.

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

  // v2.6-TRUTH-8 — the transfer authority's DESTINATION verdict, from the same
  // canonical entry point the list read uses. The detail read resolves a
  // counterparty through RelationshipResolver but never asked what KIND of
  // movement that made, so the drawer rendered "Debt payment" for a movement the
  // authority had already called SAVINGS_TRANSFER. One bounded assessment for
  // this row — not a second derivation.
  const detailMaturity =
    (await resolveTransferAssessments(client, [row] as never, { spaceId })).get(row.id)?.maturity ?? null;

  return {
    // v2.6-TRUTH-7 — `accountType` MUST be supplied here, exactly as the list read
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
    transferMaturity:   detailMaturity,
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
  };
}
