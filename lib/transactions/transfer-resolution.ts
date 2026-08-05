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
  type TransferCandidateRelationship,
} from "@/lib/transactions/RelationshipResolver";
import { TRANSFER_MATCH_WINDOW_DAYS, isTransferPrefilterCandidate } from "@/lib/transactions/transfer-maturation";
import { ECONOMIC_DATE_MAX_LAG_DAYS } from "@/lib/transactions/economic-date";

/** ± window (whole days) for a matched opposite leg — the ONE evidence-derived
 *  bound, from lib/transactions/transfer-maturation.ts (5 days; see its header
 *  for the skew-vs-recurrence measurement that chose it). */
const TRANSFER_WINDOW_DAYS = TRANSFER_MATCH_WINDOW_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * DB gather window, padded by a day over the matcher window for date-boundary
 * safety — and, since L8-B, by ECONOMIC_DATE_MAX_LAG_DAYS as well.
 *
 * ⚠️ The gather bounds are computed from the TARGETS' economic dates but applied
 * to a column whose values can sit up to the lag bound LATER. A leg whose
 * economic date is inside the ±window can therefore have a posting date outside
 * it, and a window sized for the economic distance alone would never load it —
 * a silent starvation, invisible to any probe that only inspects matcher output.
 * This was the calibration's R1 and it is corrected here.
 *
 * Over-fetching is free of semantic risk: the matcher still applies the real
 * ±TRANSFER_MATCH_WINDOW_DAYS to the economic dates it was handed.
 */
const GATHER_WINDOW_MS = (TRANSFER_WINDOW_DAYS + 1 + ECONOMIC_DATE_MAX_LAG_DAYS) * DAY_MS;
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
  // ── Financial Truth (Transfer Authority) ────────────────────────────────
  /** Fourth Meridian's own category — the movement signal for rows whose
   *  provider supplies no PFC family (imports, manual entry, CSV). */
  category:           string | null;
  /** Provider counterparty class, for the Phase 4 external terminal leaves. */
  counterpartyType:   string | null;
  /** Descriptor text, for IDENTIFIER extraction only. */
  description:        string | null;
  /** L8-B — the persisted economic chronology; the basis matching runs on. */
  economicDate:       Date | null;
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
function toRel(
  r: TransferLegLike,
  ownerByAccount: ReadonlyMap<string, string>,
  institutionByAccount: ReadonlyMap<string, string | null>,
): RelationshipTransaction {
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
    category:              r.category,
    counterpartyClass:     r.counterpartyType,
    institutionId:         institutionByAccount.get(r.financialAccountId ?? "") ?? null,
    // The descriptor the extractor reads. `merchant` alone is not enough: Chase
    // puts the correlation token in `description`, and Amex puts the mask there.
    descriptor:            `${r.merchant ?? ""} ${r.description ?? ""}`,
    economicDate:          r.economicDate,
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
  const full = await resolveTransferAssessments(rows, ctx);
  const out = new Map<string, string>();
  for (const [id, a] of full) if (a.counterpartyAccountId) out.set(id, a.counterpartyAccountId);
  return out;
}

/**
 * The FULL per-row assessment — the canonical read-boundary entry point.
 *
 * Phase 6 — `resolveOwnedTransferCounterparties` above is now a PROJECTION of
 * this, not a sibling computation. A consumer that needs only the id keeps its
 * signature; a consumer that needs the maturity, the evidence level or the named
 * limitation reads this and does not re-run anything. There is one query, one
 * matcher call, and one answer per row.
 *
 * The KD-15 gate applies to the ACCOUNT ID only: an invisible counterparty
 * removes the id while leaving the movement's NAME intact, because "this was a
 * savings transfer" discloses nothing about an account the Space may not see.
 */
export async function resolveTransferAssessments(
  rows: TransferResolutionRow[],
  ctx: { spaceId: string },
): Promise<Map<string, TransferCandidateRelationship>> {
  // 1 — Targets: transfer-like rows on an owned FinancialAccount with no persisted link.
  // V27-L4C — candidacy is the shared authority, not an inline `=== "TRANSFER"`.
  // DEBT_PAYMENT rows now ENTER the resolver; that is the whole point.
  // The PREFILTER, not the admission rule: the real gate needs the account type
  // and the attested axes, which are loaded below. Filtering twice would be a
  // second authority; filtering broadly here and precisely there is not.
  const targets = rows.filter(
    (r) => isTransferPrefilterCandidate(r.flowType) && r.counterpartyAccountId == null && r.financialAccountId != null,
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
    // Phase 5 — `mask` and `institutionId` are the identifier tier's inputs.
    // Both are already columns on the account; neither is a new provider read.
    select: { id: true, type: true, ownerUserId: true, mask: true, institutionId: true },
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
  const institutionByAccount = new Map(owned.map((a) => [a.id, a.institutionId ?? null]));
  // Phase 5 — mask → owned accounts, PER OWNER. A mask carried by more than one
  // of an owner's accounts is present with all of them so the extractor abstains;
  // it must never resolve to whichever came first.
  const maskToAccountIds = new Map<string, string[]>();
  for (const a of owned) {
    if (!a.mask) continue;
    const list = maskToAccountIds.get(a.mask);
    if (list) list.push(a.id); else maskToAccountIds.set(a.mask, [a.id]);
  }
  const matchCtx = { accountTypeById, maskToAccountIds };

  // 2 — One bounded cross-account candidate query over the union date window.
  // Bounds from the ECONOMIC dates (what the matcher compares), widened above so
  // the POSTING column they are applied to cannot starve the match.
  const times = targets.map((t) => (t.economicDate ?? t.date).getTime());
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
      // Financial Truth — admission needs `category`; the external leaves need
      // `counterpartyType`; identifier extraction needs `description`.
      category: true, counterpartyType: true, description: true,
      // L8-B — the matching chronology.
      economicDate: true,
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
    const rel = toRel({ ...c, category: c.category as string | null, counterpartyType: c.counterpartyType as string | null, economicDate: c.economicDate }, ownerByAccount, institutionByAccount);
    if (bucket) bucket.push(rel);
    else index.set(key, [rel]);
  }

  const assessmentByRow = new Map<string, TransferCandidateRelationship>();
  const resolvedAccountIds = new Set<string>();
  for (const t of targets) {
    const bucket = index.get(bucketKey(t.currency, t.amount)) ?? [];
    const match = matchTransferCandidate(toRel(t, ownerByAccount, institutionByAccount), bucket, matchCtx);
    assessmentByRow.set(t.id, match);
    // Only a level where the destination ACCOUNT is a fact reaches the DTO as an
    // id — PROVIDER_LINKED, ACCOUNT_CERTAIN, or ACCOUNT_CERTAIN_LEG_AMBIGUOUS.
    // `persistableCounterparty` is the authority's own verdict, consulted rather
    // than re-derived from the status: at ACCOUNT_CERTAIN_LEG_AMBIGUOUS the
    // account is persistable while the LEG is not, and only the authority knows
    // that. Every refusal still resolves to nothing by construction.
    if (match.persistableCounterparty && match.counterpartyAccountId) {
      resolvedAccountIds.add(match.counterpartyAccountId);
    }
  }
  if (resolvedAccountIds.size === 0) return assessmentByRow;

  // 4 — KD-15 gate. An invisible counterparty loses its ID and its persistability;
  // the MATURITY survives, because naming a movement "savings transfer" discloses
  // nothing about an account this Space may not see. Failing closed on the id
  // while keeping the name is strictly more truthful than dropping both.
  const visible = await filterVisibleCounterpartyAccounts([...resolvedAccountIds], ctx.spaceId);
  for (const [rowId, a] of assessmentByRow) {
    if (a.counterpartyAccountId && !visible.has(a.counterpartyAccountId)) {
      assessmentByRow.set(rowId, {
        ...a,
        counterpartyAccountId: null,
        transactionId: null,
        persistableCounterparty: false,
        persistableLeg: false,
      });
    }
  }
  return assessmentByRow;
}
