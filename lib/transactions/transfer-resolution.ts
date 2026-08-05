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
import { TRANSFER_MATCH_WINDOW_DAYS, isTransferCandidate } from "@/lib/transactions/transfer-maturation";

/** ± window (whole days) for a matched opposite leg — the ONE evidence-derived
 *  bound, from lib/transactions/transfer-maturation.ts (5 days; see its header
 *  for the skew-vs-recurrence measurement that chose it). */
const TRANSFER_WINDOW_DAYS = TRANSFER_MATCH_WINDOW_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;
/** DB gather window is padded by a day over the matcher window for date-boundary safety. */
const GATHER_WINDOW_MS = (TRANSFER_WINDOW_DAYS + 1) * DAY_MS;
/** Safety backstop on the candidate set — owned transfer legs in a ±window are tiny. */
const CANDIDATE_CAP = 5000;

/** The fields a transfer LEG contributes to matching (a target or a candidate).
 *
 *  V27-TRUTH-2 — `pending`, `settlementState` and `pfcDetailed` are REQUIRED.
 *  The canonical authority needs lifecycle supersession and movement form, and a
 *  leg that cannot supply them cannot be matched honestly. Optional would mean a
 *  caller that forgot them silently gets the old, over-resolving answer. */
export interface TransferLegLike {
  id:                 string;
  financialAccountId: string | null;
  date:               Date;
  amount:             number;
  currency:           string | null;
  flowType:           string | null;
  deletedAt?:         Date | null;
  pending:            boolean;
  settlementState:    string | null;
  pfcDetailed:        string | null;
  merchant?:          string | null;
  /** V27-TRUTH-3 — the provider FAMILY, for the liability-inflow authority. */
  pfcPrimary:         string | null;
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

/**
 * Adapt a DB leg to the pure matcher's structural type.
 *
 * V27-TRUTH-2 — `pending`/`settlementState`/`pfcDetailed` are now carried through
 * instead of being stubbed. The old version hard-coded `pending: false` and
 * `merchant: ""`, which meant the matcher could not see supersession or movement
 * form at all — one of the two reasons the read path over-resolved. `ownerUserId`
 * comes from the account graph the caller already loaded.
 */
function toRel(r: TransferLegLike, ownerByAccount: ReadonlyMap<string, string>): RelationshipTransaction {
  return {
    id:                    r.id,
    financialAccountId:    r.financialAccountId,
    plaidTransactionId:    null,
    pendingTransactionRef: null,
    date:                  r.date,
    amount:                r.amount,
    merchant:              r.merchant ?? "",
    pending:               r.pending,
    deletedAt:             r.deletedAt ?? null,
    flowType:              r.flowType ?? null,
    currency:              r.currency ?? null,
    ownerUserId:           ownerByAccount.get(r.financialAccountId ?? "") ?? null,
    settlementState:       r.settlementState,
    pfcDetailed:           r.pfcDetailed,
    pfcPrimary:            r.pfcPrimary,
    // A candidate leg carries no persisted-counterparty claim of its own here;
    // targets supply theirs from the row (see TransferResolutionRow).
    persistedCounterpartyAccountId:
      (r as { counterpartyAccountId?: string | null }).counterpartyAccountId ?? null,
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
  // V27-L4C — candidacy is the shared authority, not an inline `=== "TRANSFER"`.
  // DEBT_PAYMENT rows now ENTER the resolver; that is the whole point.
  const targets = rows.filter(
    (r) => isTransferCandidate(r.flowType) && r.counterpartyAccountId == null && r.financialAccountId != null,
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
    select: { id: true, type: true, ownerUserId: true },
  });
  const ownedIds = owned.map((a) => a.id);
  if (ownedIds.length === 0) return new Map();

  // V27-TRUTH-2 — the authority decides from ACCOUNT TYPE and OWNER, so both are
  // loaded here once and handed in. They are not re-derived per row and never
  // guessed: an account missing from this map contributes type "other", which
  // reaches no leaf.
  const accountTypeById = new Map(owned.map((a) => [a.id, a.type as string]));
  const ownerByAccount = new Map(
    owned.filter((a) => a.ownerUserId != null).map((a) => [a.id, a.ownerUserId as string]),
  );
  const matchCtx = { accountTypeById };

  // 2 — One bounded cross-account candidate query over the union date window.
  const times = targets.map((t) => t.date.getTime());
  const gte = new Date(Math.min(...times) - GATHER_WINDOW_MS);
  const lte = new Date(Math.max(...times) + GATHER_WINDOW_MS);
  const candidates = await db.transaction.findMany({
    where: {
      financialAccountId: { in: ownedIds },
      // V27-L4C — the opposite leg may itself be filed as DEBT_PAYMENT or carry
      // no flowType at all, so the candidate query admits the same set the
      // maturation authority does. `null` is included explicitly: a NOT-IN over
      // a nullable column would drop null rows under three-valued logic.
      OR: [
        { flowType: { in: [FlowType.TRANSFER, FlowType.DEBT_PAYMENT, FlowType.UNKNOWN] } },
        { flowType: null },
      ],
      deletedAt: null,
      date: { gte, lte },
    },
    select: {
      id: true, financialAccountId: true,
      date: true, amount: true, currency: true, flowType: true, deletedAt: true,
      // V27-TRUTH-2 — supersession + movement-form evidence. Without these the
      // matcher cannot apply the cash veto or drop a superseded leg.
      pending: true, settlementState: true, pfcDetailed: true, merchant: true,
      pfcPrimary: true, counterpartyAccountId: true,
    },
    take: CANDIDATE_CAP,
  });

  // 3 — Bucket by (currency, |amount|) so each target scans only its bucket.
  //
  // The bucket is also exactly the set the authority's REVERSE direction needs:
  // `legsQualify` can only pair rows of equal magnitude and currency, so every
  // rival funding row for a candidate leg is in the same bucket. The mutual count
  // computed over it is complete, not a sample.
  const index = new Map<string, RelationshipTransaction[]>();
  for (const c of candidates) {
    const key = bucketKey(c.currency, c.amount);
    const bucket = index.get(key);
    if (bucket) bucket.push(toRel(c, ownerByAccount));
    else index.set(key, [toRel(c, ownerByAccount)]);
  }

  const resolvedByRow = new Map<string, string>();
  const resolvedAccountIds = new Set<string>();
  for (const t of targets) {
    const bucket = index.get(bucketKey(t.currency, t.amount)) ?? [];
    const match = matchTransferCandidate(toRel(t, ownerByAccount), bucket, matchCtx);
    // Only ACCOUNT_CERTAIN reaches the DTO as an id. Every refusal — cash,
    // non-mutual, type-certain, ambiguous — resolves to nothing, by construction:
    // `counterpartyAccountId` is null on every non-RESOLVED branch.
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
