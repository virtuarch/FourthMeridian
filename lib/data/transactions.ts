/**
 * lib/data/transactions.ts
 *
 * Server-only transaction queries.
 *
 * Transactions reach a space via two paths (see Transaction model comment
 * in prisma/schema.prisma):
 *  - legacy rows: account.spaceId (the old Account model)
 *  - Plaid-synced rows: financialAccount.spaceAccountLinks (D3 Step 4C read
 *    cutover — see docs/initiatives/d3/D3_STEP4C_CORE_DASHBOARD_REVIEW.md; replaces the prior
 *    financialAccount.workspaceShares query). Visibility is status: ACTIVE on
 *    the link; `kind` (HOME vs SHARED) is not filtered on — both confer
 *    visibility. This is the identical link/status shape lib/data/accounts.ts
 *    now uses, so accounts, holdings, and transactions cannot disagree on
 *    what's visible.
 * Every query below matches both so newly-synced Plaid transactions show up
 * alongside legacy/manual ones. `accountId` on the returned objects is
 * normalized to whichever FK is actually set, since callers (e.g. AccountModal)
 * match transactions to an account by this single id field.
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
 * lists. The legacy Account path (account.spaceId) is the Space's own accounts
 * and is FULL by definition, so it is left unfiltered. Fails closed: absence of
 * a transaction-detail grant excludes the rows, never leaks them.
 * KD-15 is tracked in STATUS.md (known defects register).
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import {
  Transaction,
  InvestmentTransaction,
  TransactionDetail,
  TransactionDetailAccount,
  TransactionDetailCounterparty,
  TransactionDetailProvenance,
  TransactionDetailReporting,
} from "@/types";
import { ShareStatus, FlowType } from "@prisma/client";

import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
// TI-1: canonical row → DTO serialization (single derivation site — replaces
// the three inline mappings this file previously duplicated).
import {
  serializeTransactionRow,
  serializeInvestmentTransactionRow,
} from "@/lib/transactions/serialize";
import { gatedCounterpartyId, chooseCounterpartyId } from "@/lib/transactions/counterparty-visibility";
import { transactionDetailWhere } from "@/lib/transactions/detail-query";
// TI5-2 — the pure read-time relationship engine. Candidate gathering stays in
// this data layer; the resolver receives (transaction, candidates) and nothing else.
import { resolveTransactionRelationships } from "@/lib/transactions/RelationshipResolver";
// TI4 Slice 1 — read-time owned-account transfer matching (Cash Flow liquidity axis).
// Projects a deterministically-matched counterparty id into the list DTO through
// the SAME KD-15 gate; never persists Transaction.counterpartyAccountId.
import {
  resolveOwnedTransferCounterparties,
  filterVisibleCounterpartyAccounts,
} from "@/lib/transactions/transfer-resolution";
import { convertMoney } from "@/lib/money/convert";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";

const BANKING_CATEGORIES = [
  "Income","Transfer","Groceries","Dining","Shopping","Travel",
  "Subscriptions","Utilities","Interest","Payment","Other",
];

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

/** Banking transactions only (excludes investment activity), newest first. */
export async function getTransactions(ctx?: { spaceId: string }): Promise<Transaction[]> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account:          { spaceId } },
        // deletedAt: null guards against an archived account's transactions
        // surfacing in a shared Space if its link were ever left ACTIVE —
        // same defensive filter getAccounts()/getHoldings() already apply.
        // visibilityLevel (KD-15): only links granting transaction detail
        // (FULL) contribute rows; BALANCE_ONLY / SUMMARY_ONLY are excluded.
        { financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } } } },
      ],
      // Transaction.deletedAt: null — D2 Step 4D-R: excludes rows soft-deleted
      // by an import rollback. See module header above for rationale.
      deletedAt: null,
      category: { in: BANKING_CATEGORIES as never[] },
    },
    orderBy: { date: "desc" },
    // MI M6 read cutover — resolved Merchant presentation (additive join).
    // + KD-15 counterparty visibility for the Cash Flow liquidity axis.
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } }, ...counterpartyVisibilityInclude(spaceId) },
  });

  // TI4 Slice 1 — read-time owned-account transfer matches, already KD-15-gated.
  const resolvedCp = await resolveOwnedTransferCounterparties(rows, { spaceId });
  // TI-1: canonical serialization. counterpartyAccountId is KD-15-gated here
  // (nulled unless the counterparty account is visible to this Space) before it
  // ever reaches the serializer / client. Persisted (provider-confirmed) links win;
  // a read-time transfer match fills in only where no persisted link exists.
  return rows.map((r) =>
    serializeTransactionRow({
      ...r,
      counterpartyAccountId: chooseCounterpartyId(gatedCounterpartyId(r), resolvedCp.get(r.id) ?? null),
    }),
  );
}

/** Transactions for debt accounts only (credit card activity), newest first. */
export async function getDebtTransactions(ctx?: { spaceId: string }): Promise<Transaction[]> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account:          { spaceId, type: "debt" } },
        // deletedAt: null + visibilityLevel (KD-15) — see getTransactions() above.
        { financialAccount: { type: "debt", deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } } } },
      ],
      // Transaction.deletedAt: null — D2 Step 4D-R, see getTransactions() above.
      deletedAt: null,
      category: { in: BANKING_CATEGORIES as never[] },
    },
    orderBy: { date: "desc" },
    // MI M6 read cutover — resolved Merchant presentation (additive join).
    // + KD-15 counterparty visibility for the Cash Flow liquidity axis.
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } }, ...counterpartyVisibilityInclude(spaceId) },
  });

  // TI4 Slice 1 — read-time owned-account transfer matches, already KD-15-gated;
  // persisted (provider-confirmed) links take precedence via chooseCounterpartyId.
  const resolvedCp = await resolveOwnedTransferCounterparties(rows, { spaceId });
  // TI-1: canonical serialization. counterpartyAccountId KD-15-gated here.
  return rows.map((r) =>
    serializeTransactionRow({
      ...r,
      counterpartyAccountId: chooseCounterpartyId(gatedCounterpartyId(r), resolvedCp.get(r.id) ?? null),
    }),
  );
}

/** Investment transactions (Buy/Sell/Dividend/Split/Fee), newest first. */
export async function getInvestmentTransactions(): Promise<InvestmentTransaction[]> {
  const { spaceId } = await getSpaceContext();

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account:          { spaceId } },
        // deletedAt: null + visibilityLevel (KD-15) — see getTransactions() above.
        { financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } } } },
      ],
      // Transaction.deletedAt: null — D2 Step 4D-R, see getTransactions() above.
      deletedAt: null,
      category: { in: ["Buy","Sell","Dividend","Split","Fee"] as never[] },
    },
    orderBy: { date: "desc" },
  });

  // TI-1: canonical serialization — byte-identical to the previous inline
  // mapping (pinned by lib/transactions/serialize.golden.test.ts).
  return rows.map(serializeInvestmentTransactionRow);
}

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
      account: {
        select: { id: true, name: true, institution: true, type: true },
      },
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
  let account: TransactionDetailAccount;
  if (row.financialAccount) {
    const fa = row.financialAccount;
    account = {
      id:          fa.id,
      name:        resolveAccountName(fa),
      institution: fa.institution,
      mask:        fa.mask ?? null,
      type:        fa.type,
      legacy:      false,
    };
  } else if (row.account) {
    account = {
      id:          row.account.id,
      name:        row.account.name,
      institution: row.account.institution,
      mask:        null,
      type:        row.account.type,
      legacy:      true,
    };
  } else {
    // Unreachable by the WHERE construction (one parent path must have
    // matched); fail closed rather than fabricate context.
    return null;
  }

  // ── Provenance (display-safe; raw ids stay internal) ───────────────────────
  const provenance: TransactionDetailProvenance = row.importBatch
    ? {
        source:         "import",
        importSource:   row.importBatch.source,
        importFilename: row.importBatch.originalFilename ?? null,
        importedAt:     (row.importBatch.completedAt ?? row.importBatch.createdAt).toISOString(),
      }
    : row.plaidTransactionId
      ? { source: "plaid" }
      : { source: "manual" };

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
          amount:           conv.amount,
          currency:         conv.currency,
          estimated:        conv.estimated,
          rate:             conv.conversion?.rate ?? null,
          effectiveDateISO: conv.conversion?.effectiveDateISO ?? null,
        };

  // ── TI5-2 / TI4 Slice 1 — read-time relationship resolution ────────────────
  // Same-account rows within a bounded window resolve pending→posted + duplicate.
  // TI4 Slice 1 additionally gathers the owner's OTHER owned accounts' TRANSFER
  // legs so transferCandidate (deterministic owned-account matching) can resolve.
  // deletedAt is NOT filtered (a tombstoned pending row must still resolve; the
  // resolvers exclude tombstoned rows from duplicate/transfer matching themselves).
  const RELATIONSHIP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const ownerUserId = row.financialAccount?.ownerUserId ?? null;
  const ownedAccountIds = ownerUserId
    ? (await db.financialAccount.findMany({
        where: { ownerUserId, deletedAt: null },
        select: { id: true },
      })).map((a) => a.id)
    : [];
  const candidates = await db.transaction.findMany({
    where: {
      OR: [
        // Same-account candidates — pending→posted + duplicate (unchanged behavior).
        row.financialAccountId
          ? { financialAccountId: row.financialAccountId }
          : { accountId: row.accountId },
        // Owned cross-account TRANSFER legs — the transferCandidate population.
        ...(ownedAccountIds.length
          ? [{ financialAccountId: { in: ownedAccountIds }, flowType: FlowType.TRANSFER }]
          : []),
      ],
      id:   { not: row.id },
      date: {
        gte: new Date(row.date.getTime() - RELATIONSHIP_WINDOW_MS),
        lte: new Date(row.date.getTime() + RELATIONSHIP_WINDOW_MS),
      },
    },
    select: {
      id: true, accountId: true, financialAccountId: true,
      plaidTransactionId: true, pendingTransactionRef: true,
      date: true, amount: true, merchant: true, pending: true,
      deletedAt: true, flowType: true, currency: true,
    },
    take: 300, // safety cap; same-account sets are tiny, owned ±window sets are small
  });
  let relationships = resolveTransactionRelationships(row, candidates);

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

  return {
    ...serializeTransactionRow(row),
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
  };
}
