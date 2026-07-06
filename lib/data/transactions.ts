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
import { ShareStatus } from "@prisma/client";

import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
// TI-1: canonical row → DTO serialization (single derivation site — replaces
// the three inline mappings this file previously duplicated).
import {
  serializeTransactionRow,
  serializeInvestmentTransactionRow,
} from "@/lib/transactions/serialize";
import { transactionDetailWhere } from "@/lib/transactions/detail-query";
import { convertMoney } from "@/lib/money/convert";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";

const BANKING_CATEGORIES = [
  "Income","Transfer","Groceries","Dining","Shopping","Travel",
  "Subscriptions","Utilities","Interest","Payment","Other",
];

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
  });

  // TI-1: canonical serialization — byte-identical to the previous inline
  // mapping (pinned by lib/transactions/serialize.golden.test.ts).
  return rows.map(serializeTransactionRow);
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
  });

  // TI-1: canonical serialization — byte-identical to the previous inline
  // mapping (pinned by lib/transactions/serialize.golden.test.ts).
  return rows.map(serializeTransactionRow);
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
      account: {
        select: { id: true, name: true, institution: true, type: true },
      },
      financialAccount: {
        select: {
          id: true, name: true, displayName: true, officialName: true,
          plaidName: true, institution: true, mask: true, type: true,
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

  return {
    ...serializeTransactionRow(row),
    pfcPrimary:         row.pfcPrimary ?? null,
    pfcDetailed:        row.pfcDetailed ?? null,
    pfcConfidenceLevel: row.pfcConfidenceLevel ?? null,
    createdAt:          row.createdAt.toISOString(),
    account,
    provenance,
    counterparty,
    reporting,
  };
}
