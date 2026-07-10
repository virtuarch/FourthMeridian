/**
 * lib/transactions/transfer-resolution.ts
 *
 * TI4 Slice 1 — read-time, deterministic owned-account transfer matching for the
 * transaction LIST reads (the Cash Flow liquidity axis). SERVER-ONLY: this is the
 * impure candidate-gathering + KD-15 gating layer around the PURE matcher
 * (lib/transactions/RelationshipResolver.ts `matchTransferCandidate`). It NEVER
 * writes Transaction.counterpartyAccountId — resolution is projected into the DTO
 * only, and self-heals as accounts are linked/unlinked.
 *
 * Pipeline:
 *   1. Pick targets — transfer-like rows with NO persisted counterparty link
 *      (persisted provider-confirmed links, e.g. BTC, are higher authority and are
 *      left untouched; see chooseCounterpartyId).
 *   2. Gather candidates — ONE bounded, user-scoped, cross-account query over the
 *      requesting user's owned FinancialAccounts, flowType TRANSFER, within the
 *      union date window. Indexed/bounded by ownership + date + flowType; capped.
 *   3. Match — bucket candidates by (currency, |amount|) so each target scans only
 *      its bucket (no O(targets × candidates) full scan), then run the pure matcher.
 *   4. Gate — KD-15: a resolved id is exposed only when its account is visible to
 *      THIS Space at a transaction-detail-granting tier (same predicate as
 *      gatedCounterpartyId). Otherwise it is dropped (row stays Unresolved here).
 */

import { FlowType, ShareStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
import {
  matchTransferCandidate,
  type RelationshipTransaction,
} from "@/lib/transactions/RelationshipResolver";

/** ± window (whole days) for a matched opposite leg — mirrors the pure matcher default. */
const TRANSFER_WINDOW_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
/** DB gather window is padded by a day over the matcher window for date-boundary safety. */
const GATHER_WINDOW_MS = (TRANSFER_WINDOW_DAYS + 1) * DAY_MS;
/** Safety backstop on the candidate set — owned transfer legs in a ±window are tiny. */
const CANDIDATE_CAP = 5000;

/** The fields a transfer LEG contributes to matching (a target or a candidate). */
export interface TransferLegLike {
  id:                 string;
  accountId:          string | null;
  financialAccountId: string | null;
  date:               Date;
  amount:             number;
  currency:           string | null;
  flowType:           string | null;
  deletedAt?:         Date | null;
}

/** A list-read row eligible to be a target: a leg plus its PERSISTED link (which,
 *  when set, disqualifies it as a target — persisted provider-confirmed links win). */
export interface TransferResolutionRow extends TransferLegLike {
  counterpartyAccountId: string | null;
}

/** Bucket key so opposite legs of equal magnitude/currency land together. */
function bucketKey(currency: string | null, amount: number): string {
  return `${currency ?? ""}|${Math.round(Math.abs(amount) * 100)}`;
}

/** Adapt a DB leg to the pure matcher's structural type (unused fields are inert). */
function toRel(r: TransferLegLike): RelationshipTransaction {
  return {
    id:                    r.id,
    accountId:             r.accountId,
    financialAccountId:    r.financialAccountId,
    plaidTransactionId:    null,
    pendingTransactionRef: null,
    date:                  r.date,
    amount:                r.amount,
    merchant:              "",
    pending:               false,
    deletedAt:             r.deletedAt ?? null,
    flowType:              r.flowType ?? null,
    currency:              r.currency ?? null,
  };
}

/**
 * KD-15 — of the given account ids, which are visible to `spaceId` at a
 * transaction-detail-granting tier. Same predicate gatedCounterpartyId enforces
 * on the persisted path (ACTIVE link, FULL visibility, account not soft-deleted).
 */
export async function filterVisibleCounterpartyAccounts(
  accountIds: string[],
  spaceId: string,
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const rows = await db.financialAccount.findMany({
    where: {
      id: { in: accountIds },
      deletedAt: null,
      spaceAccountLinks: {
        some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } },
      },
    },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Resolve owned-account transfer counterparties for a set of list rows.
 * Returns a Map rowId → counterpartyAccountId containing ONLY rows that
 * deterministically matched AND whose counterparty is visible to this Space
 * (KD-15). Rows absent from the map stay Unresolved on the liquidity axis.
 */
export async function resolveOwnedTransferCounterparties(
  rows: TransferResolutionRow[],
  ctx: { spaceId: string },
): Promise<Map<string, string>> {
  // 1 — Targets: transfer-like rows on an owned FinancialAccount with no persisted link.
  const targets = rows.filter(
    (r) => r.flowType === "TRANSFER" && r.counterpartyAccountId == null && r.financialAccountId != null,
  );
  if (targets.length === 0) return new Map();

  // Ownership anchor: the owned-account graph of whoever OWNS the target accounts.
  // Both legs of an internal transfer share an ownerUserId, so scope candidate
  // gathering to those owners' accounts. This is user-scoped (by owning user) and
  // works when a Space member reads another member's shared account. Cross-space
  // exposure is prevented downstream by the KD-15 gate, never by this scope.
  const targetAccountIds = [...new Set(targets.map((t) => t.financialAccountId as string))];
  const ownerRows = await db.financialAccount.findMany({
    where: { id: { in: targetAccountIds } },
    select: { ownerUserId: true },
  });
  const ownerUserIds = [...new Set(ownerRows.map((o) => o.ownerUserId).filter((x): x is string => x != null))];
  if (ownerUserIds.length === 0) return new Map();

  const owned = await db.financialAccount.findMany({
    where: { ownerUserId: { in: ownerUserIds }, deletedAt: null },
    select: { id: true },
  });
  const ownedIds = owned.map((a) => a.id);
  if (ownedIds.length === 0) return new Map();

  // 2 — One bounded cross-account candidate query over the union date window.
  const times = targets.map((t) => t.date.getTime());
  const gte = new Date(Math.min(...times) - GATHER_WINDOW_MS);
  const lte = new Date(Math.max(...times) + GATHER_WINDOW_MS);
  const candidates = await db.transaction.findMany({
    where: {
      financialAccountId: { in: ownedIds },
      flowType: FlowType.TRANSFER,
      deletedAt: null,
      date: { gte, lte },
    },
    select: {
      id: true, accountId: true, financialAccountId: true,
      date: true, amount: true, currency: true, flowType: true, deletedAt: true,
    },
    take: CANDIDATE_CAP,
  });

  // 3 — Bucket by (currency, |amount|) so each target scans only its bucket.
  const index = new Map<string, RelationshipTransaction[]>();
  for (const c of candidates) {
    const key = bucketKey(c.currency, c.amount);
    const bucket = index.get(key);
    if (bucket) bucket.push(toRel(c));
    else index.set(key, [toRel(c)]);
  }

  const resolvedByRow = new Map<string, string>();
  const resolvedAccountIds = new Set<string>();
  for (const t of targets) {
    const bucket = index.get(bucketKey(t.currency, t.amount)) ?? [];
    const match = matchTransferCandidate(toRel(t), bucket, { windowDays: TRANSFER_WINDOW_DAYS });
    if (match.status === "RESOLVED" && match.counterpartyAccountId) {
      resolvedByRow.set(t.id, match.counterpartyAccountId);
      resolvedAccountIds.add(match.counterpartyAccountId);
    }
  }
  if (resolvedAccountIds.size === 0) return new Map();

  // 4 — KD-15 gate; drop any resolved id whose account is not visible to this Space.
  const visible = await filterVisibleCounterpartyAccounts([...resolvedAccountIds], ctx.spaceId);
  const gated = new Map<string, string>();
  for (const [rowId, acctId] of resolvedByRow) {
    if (visible.has(acctId)) gated.set(rowId, acctId);
  }
  return gated;
}
