import {
  TRANSFER_MATCH_WINDOW_DAYS,
  resolveDestinationEvidenceFor,
  maturityForEvidence,
  isUnresolvedMaturity,
  type TransferLeg,
  type TransferMaturity,
  type DestinationEvidenceLevel,
  type TransferUnresolvedReason,
} from "@/lib/transactions/transfer-maturation";
import { admitTransferCandidate, type TransferAdmission } from "@/lib/transactions/transfer-admission";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";
import { plaidTransferEvidence } from "@/lib/transactions/plaid-transfer-evidence";
import { extractProviderLinks } from "@/lib/transactions/provider-link-extract";
/**
 * lib/transactions/RelationshipResolver.ts
 *
 * Transaction Intelligence — read-time Relationship Resolver (foundation).
 *
 * Per the ratified TI4 decision, transaction relationships are NOT persisted:
 * they are explanation/navigation context, cheap to recompute, and consumed by
 * the transaction-detail experience. This module resolves them at READ TIME
 * from a target row plus a small set of candidate rows the caller supplies.
 *
 * Design contract (mirrors buildTransactionFacts / serialize.ts):
 *  - PURE & DETERMINISTIC: same inputs → same output. No DB, no I/O, no
 *    Date.now, no env, no side effects. Never throws.
 *  - ZERO IMPORTS: structural row types (not Prisma types) and an inlined
 *    merchant normalizer, so this module — and its tsx test — never pull in
 *    @/lib/db (which lib/transactions/fingerprint.ts does), and run without
 *    `prisma generate`.
 *  - RETURNS FACTS, NOT PROSE: structured ids/roles only. Rendering (UI) and
 *    narration (AI) belong elsewhere and consume this shape.
 *
 * Scope of THIS slice — deterministic / low-risk relationships only:
 *  - pendingPosted : exact provider match on plaidTransactionId ↔ pendingTransactionRef.
 *  - duplicate     : exact fingerprint (same account/date/amount/pending + normalized
 *                    merchant) — the same deterministic keys lib/transactions/fingerprint.ts
 *                    uses for sync dedup; no fuzzy matching.
 *  - transferCandidate : TI4 Slice 1 — DETERMINISTIC owned-account two-leg transfer
 *                    matching. A transfer-like row resolves to the owned account on
 *                    the other side when EXACTLY ONE opposite leg matches on all of:
 *                    different owned account · same currency · equal |amount| (to
 *                    monetary precision) · opposite sign · both transfer-like · within
 *                    a narrow date window. Ambiguity (legs across >1 candidate account)
 *                    is REFUSED, never guessed. No descriptor / merchant heuristics, no
 *                    provider-specific logic — those are later slices. The counterparty
 *                    id this yields is projected into the DTO ONLY through the KD-15
 *                    visibility gate in the data layer; this pure module never persists.
 *
 * Deliberately NOT implemented (requires a ratified fuzzy heuristic — proposed,
 * not built): refundCandidate (opposite-amount + merchant + window). Reserved as
 * `null` in the output so the contract is stable when that slice lands.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Structural input — a subset of the Transaction row, Prisma-free.
// ─────────────────────────────────────────────────────────────────────────────

export interface RelationshipTransaction {
  id:                    string;
  /** Canonical FinancialAccount FK — the account identity. */
  financialAccountId:    string | null;
  /** Provider transaction id (unique). Anchor for the pending↔posted match. */
  plaidTransactionId:    string | null;
  /** Plaid pending_transaction_id (TI2 seed): the posted row's pointer to its pending row. */
  pendingTransactionRef: string | null;
  date:                  Date;
  amount:                number;
  merchant:              string;
  pending:               boolean;
  /** Soft-delete tombstone (the pending row is tombstoned once it posts). */
  deletedAt?:            Date | null;
  flowType?:             string | null;
  /** Native currency (ISO 4217) — TI4 transfer matching requires same-currency legs. */
  currency?:             string | null;

  // ── V27-TRUTH-2 — the facts the canonical transfer authority requires ──────
  // Required, not optional. A leg missing any of these cannot be matched
  // correctly, and an optional field production never passes is how the
  // read-time resolver came to disagree with the authority in the first place.
  /** The OWNING user of `financialAccountId`. Legs only pair within one owner. */
  ownerUserId:           string | null;
  /** Settlement state, for lifecycle supersession. */
  settlementState:       string | null;
  /** Plaid personal_finance_category.detailed — the movement-form evidence. */
  pfcDetailed:           string | null;
  /** V27-TRUTH-3 — provider classification FAMILY (Plaid pfcPrimary). The only
   *  evidence that separates a customer payment from an issuer credit on a
   *  liability inflow. Never a merchant string. */
  pfcPrimary:            string | null;
  /** V27-TRUTH-3 — a counterparty already persisted on the row. Proof of an
   *  owned funding source, which outranks the family. */
  persistedCounterpartyAccountId: string | null;

  // ── Financial Truth (Transfer Authority) — the facts the ladder now needs ───
  // All REQUIRED and nullable. An optional field here is how the read boundary
  // came to disagree with the authority twice already: a caller that forgets it
  // gets the weaker answer silently, and that is indistinguishable from an
  // institution that genuinely attests nothing.
  /** Fourth Meridian's own category — a movement signal admission consults when
   *  the provider supplies no family (imports, manual entry, CSV). */
  category: string | null;
  /** Provider counterparty class (Plaid `counterparties[].type`). Phase 4 reads
   *  it ONLY to decide whether an unmatched movement left the household. */
  counterpartyClass: string | null;
  /** The OWN account's stable institution id (Plaid `institution_id`), for the
   *  institution-scoped correlation extractors. Never a display name. */
  institutionId: string | null;
  /** The row's descriptor text (merchant + description), for identifier
   *  extraction ONLY. ⚠️ Never parsed for names, merchants or purpose — see
   *  provider-link-extract.ts. */
  descriptor: string | null;
  /**
   * L8-B — the persisted ECONOMIC date. THE chronology transfer matching runs on.
   *
   * ⚠️ REQUIRED and nullable, and `toTransferLeg` REFUSES a null rather than
   * falling back to `date`. A silent fallback would put one leg on the economic
   * chronology and another on posting, and mutual uniqueness across two
   * chronologies is not merely wrong — it is undefined. The column is guaranteed
   * non-null by the backfill, dual-write and `audit:economic-date`.
   *
   * Calibrated on this basis: ±5 window and tiers [0,5] were re-derived on
   * economic dates and landed in the same place.
   */
  economicDate: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output — structured relationship facts (no prose).
// ─────────────────────────────────────────────────────────────────────────────

export type PendingPostedRole =
  | 'POSTED_FROM_PENDING'   // the target row posted from a prior pending row
  | 'PENDING_AWAITING_POST'; // the target row is pending; a posted successor exists

export interface PendingPostedRelationship {
  role:          PendingPostedRole;
  /** The matched counterpart row's id (the pending row, or the posted successor). */
  transactionId: string;
}

export interface DuplicateRelationship {
  /** Ids of exact-fingerprint duplicates of the target (excludes the target itself). */
  transactionIds: string[];
}

/** Outcome of deterministic owned-account transfer matching (TI4 Slice 1). */
export type TransferMatchStatus =
  | 'RESOLVED'    // exactly one candidate account matched — safe to use
  | 'AMBIGUOUS'   // legs matched across >1 candidate account — refused, not guessed
  | 'NONE';       // target not transfer-like, or no matching opposite leg

export type TransferMatchReason =
  | 'PROVIDER_ASSERTED'            // the institution linked both legs itself
  | 'DETERMINISTIC_UNIQUE'         // one owned counterparty account, MUTUALLY unique
  | 'ACCOUNT_CERTAIN_LEG_AMBIGUOUS' // the account is a fact; the row is unknowable
  | 'AMBIGUOUS_MULTIPLE_ACCOUNTS'  // >1 distinct candidate account — refuse
  | 'NO_CANDIDATE'                 // no opposite leg matched
  | 'NOT_TRANSFER_LIKE'            // target is not a directional transfer row
  // ── V27-TRUTH-2 — outcomes the canonical authority can express and this
  //    resolver previously could not, which is why it over-resolved.
  | 'CASH_MOVEMENT_NO_COUNTERPARTY' // the money changed form; no account to find
  | 'TYPE_CERTAIN_ACCOUNT_AMBIGUOUS' // destination TYPE known, account is not
  | 'NOT_MUTUALLY_UNIQUE'           // one candidate leg, but that leg has rivals
  | 'EXTERNAL_TERMINAL';            // it left the household — a fact, not a refusal

export interface TransferCandidateRelationship {
  status: TransferMatchStatus;
  /** The matched opposite-leg transaction id — only when status === 'RESOLVED' AND a
   *  single leg matched; null when the account is certain but the exact leg is not. */
  transactionId:         string | null;
  /** The owned counterparty account id — set only when status === 'RESOLVED'. */
  counterpartyAccountId: string | null;
  /** 1 for a unique deterministic match; 0 otherwise. Durable field for future UI. */
  confidence:            number;
  reason:                TransferMatchReason;
  /**
   * V27-TRUTH-2 — what the evidence DOES support when it does not support an
   * account. Set at TYPE_CERTAIN_ACCOUNT_AMBIGUOUS so a surface can say "a debt
   * payment, destination account unknown" instead of either fabricating an
   * account or falling silent. Null whenever the type is unknown.
   */
  destinationAccountType: string | null;
  /** The canonical maturity for this row, straight from the authority. */
  maturity:               TransferMaturity;
  /** The authority's own evidence level, carried through unchanged for audit. */
  evidenceLevel:          DestinationEvidenceLevel;
  /**
   * Phase 3 — whether `counterpartyAccountId` above may be PERSISTED.
   *
   * ⚠️ Deliberately separate from `status === 'RESOLVED'`. At
   * ACCOUNT_CERTAIN_LEG_AMBIGUOUS the account is a persistable fact while
   * `transactionId` is null and must stay null, so a consumer that inferred
   * "resolved ⇒ I have a leg" would be wrong. Two booleans, because they answer
   * two questions.
   */
  persistableCounterparty: boolean;
  /** Phase 3 — whether the OPPOSING ROW is established. False whenever the leg
   *  is unknowable, even though the account is known. */
  persistableLeg:          boolean;
  /**
   * Phase 2 — the specific known limitation when this row is still unresolved,
   * or null when the ladder has an answer (including every external leaf).
   * A surface must never print "unresolved" without rendering this.
   */
  unresolvedReason:       TransferUnresolvedReason | null;
  /** Phase 1 — why the row was, or was not, admitted to the corpus at all. */
  admission:              TransferAdmission;
}

export interface TransactionRelationships {
  pendingPosted:   PendingPostedRelationship | null;
  duplicate:       DuplicateRelationship | null;
  /** Reserved — requires a ratified fuzzy heuristic. Always null in this slice. */
  refundCandidate:   null;
  /** TI4 Slice 1 — the RESOLVED deterministic owned-account transfer match, or null
   *  when NONE/AMBIGUOUS (unresolved is honest; the match is never guessed). Callers
   *  that need the AMBIGUOUS/NONE reason read `transferAssessment`. */
  transferCandidate: TransferCandidateRelationship | null;
  /** V27-TRUTH-2 — the FULL assessment, always present, including the refusals.
   *  Carries `maturity` and `destinationAccountType` but never a fabricated id. */
  transferAssessment: TransferCandidateRelationship;
}

/**
 * V27-TRUTH-2 — the context a transfer match needs that a row cannot carry.
 *
 * There are no window/epsilon "tunables" any more, deliberately. They were the
 * seam through which this module became a second authority: a caller could set a
 * different window here than `TRANSFER_MATCH_WINDOW_DAYS`, and the read boundary
 * would then disagree with the repair boundary about what a transfer even is.
 * The one evidence-derived bound lives in the authority; this module imports it
 * and cannot override it.
 */
export interface TransferMatchContext {
  /** FinancialAccount id → its type (checking | savings | debt | …). */
  accountTypeById: ReadonlyMap<string, string>;
  /**
   * Phase 5 — account MASK → the owned account ids carrying it, within one owner.
   *
   * A corpus-level fact the caller already holds (it loaded the owned-account
   * graph to build `accountTypeById`). A mask appearing against MORE THAN ONE
   * account must be present with all of them, so the extractor abstains instead
   * of picking: 4-digit masks collide within one user with probability 0.45% at
   * 10 accounts and 4.3% at 30, and picking would be a coin flip wearing an
   * identifier's authority.
   *
   * Optional, and this is the one place that is right: a caller with no mask
   * data (the pure unit tests, the chain authority) genuinely has none, and the
   * consequence is only that mask evidence does not apply. Unlike the leg fields,
   * absence here cannot produce a WRONG answer — only a weaker one.
   */
  maskToAccountIds?: ReadonlyMap<string, readonly string[]>;
}

/** Re-exported so a caller can assert the read path and the authority agree. */
export { TRANSFER_MATCH_WINDOW_DAYS };

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors lib/transactions/fingerprint.ts `normalizeMerchantKey` (inlined to keep
 * this module DB-free; fingerprint.ts imports @/lib/db). Kept trivial and in sync
 * with that canonical source; a future slice may extract a shared pure normalizer.
 */
function normalizeMerchantKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** The account identity — the canonical FinancialAccount FK. */
function accountKey(t: RelationshipTransaction): string | null {
  return t.financialAccountId;
}

/** Same calendar day (Transaction.date is @db.Date — day granularity). */
function sameDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

// V27-TRUTH-2 — `dayDistance` was DELETED. It existed only for this module's own
// copy of the ±window check, which is now the authority's `legsQualify`. Leaving
// it would leave a working second implementation of a rule that must have one.

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic resolvers
// ─────────────────────────────────────────────────────────────────────────────

function resolvePendingPosted(
  tx: RelationshipTransaction,
  candidates: readonly RelationshipTransaction[],
): PendingPostedRelationship | null {
  // The target posted FROM a pending row: its pendingTransactionRef points at the
  // pending row's plaidTransactionId (exact, provider-supplied). The pending row
  // is typically tombstoned — deletedAt is NOT filtered here on purpose.
  if (tx.pendingTransactionRef) {
    const pendingRow = candidates.find(
      (c) => c.id !== tx.id && c.plaidTransactionId != null && c.plaidTransactionId === tx.pendingTransactionRef,
    );
    if (pendingRow) return { role: 'POSTED_FROM_PENDING', transactionId: pendingRow.id };
  }
  // The reverse: the target is a pending row and a posted successor points back.
  if (tx.pending && tx.plaidTransactionId) {
    const postedRow = candidates.find(
      (c) => c.id !== tx.id && c.pendingTransactionRef != null && c.pendingTransactionRef === tx.plaidTransactionId,
    );
    if (postedRow) return { role: 'PENDING_AWAITING_POST', transactionId: postedRow.id };
  }
  return null;
}

function resolveDuplicate(
  tx: RelationshipTransaction,
  candidates: readonly RelationshipTransaction[],
): DuplicateRelationship | null {
  const key = normalizeMerchantKey(tx.merchant);
  const acct = accountKey(tx);
  if (acct == null) return null;

  const ids = candidates
    .filter(
      (c) =>
        c.id !== tx.id &&
        c.deletedAt == null &&               // never flag a tombstoned row
        accountKey(c) === acct &&            // same account
        c.amount === tx.amount &&            // exact amount
        c.pending === tx.pending &&          // same settlement state (fingerprint key)
        sameDay(c.date, tx.date) &&          // same day
        normalizeMerchantKey(c.merchant) === key, // same normalized merchant
    )
    .map((c) => c.id);

  return ids.length > 0 ? { transactionIds: ids } : null;
}

/**
 * TI4 Slice 1 — deterministic owned-account transfer matcher. Pure; the CALLER
 * gathers candidates (bounded, user-scoped cross-account query) and owns the
 * KD-15 visibility gate applied to the id this returns.
 *
 * Resolves the target transfer-like row to the OWNED account on the other side
 * when EXACTLY ONE candidate account matches on ALL required facts:
 *   - different owned account (candidate's account ≠ target's account)
 *   - same currency (null currency matches only null currency)
 *   - equal |amount| within `amountEpsilon` (monetary precision)
 *   - opposite sign (one leg in, one leg out; zero amounts never match)
 *   - both rows transfer-like (flowType TRANSFER)
 *   - candidate date within ±`windowDays` of the target
 *   - candidate not soft-deleted (a tombstoned leg is never paired)
 *
 * Ambiguity doctrine: matches are grouped by counterparty ACCOUNT. Many legs in
 * ONE account still name a single unambiguous counterparty → RESOLVED (the
 * liquidity axis needs the account, not the exact leg). Legs across MORE THAN ONE
 * account are a genuine ambiguity → AMBIGUOUS (refused; the id is left null and
 * the row stays unresolved). Never chooses arbitrarily.
 */
export function matchTransferCandidate(
  tx: RelationshipTransaction,
  candidates: readonly RelationshipTransaction[],
  ctx: TransferMatchContext,
): TransferCandidateRelationship {
  const admission = admitTransferCandidate(admissionInput(tx, ctx));

  const refuse = (
    reason: TransferMatchReason,
    level: DestinationEvidenceLevel,
    maturity: TransferMaturity,
    destinationAccountType: string | null = null,
    unresolvedReason: TransferUnresolvedReason | null = null,
  ): TransferCandidateRelationship => ({
    status: reason === 'AMBIGUOUS_MULTIPLE_ACCOUNTS' || reason === 'TYPE_CERTAIN_ACCOUNT_AMBIGUOUS' || reason === 'NOT_MUTUALLY_UNIQUE'
      ? 'AMBIGUOUS' : 'NONE',
    transactionId: null, counterpartyAccountId: null, confidence: 0,
    reason, destinationAccountType, maturity, evidenceLevel: level,
    persistableCounterparty: false, persistableLeg: false,
    unresolvedReason, admission,
  });

  // Phase 1 — the canonical admission gate. A row that is not a transfer
  // candidate is not "an unresolved transfer"; it was never a transfer at all,
  // and the assessment says which of the seven reasons applies.
  if (admission !== 'ADMITTED') {
    return refuse('NOT_TRANSFER_LIKE', 'NO_DESTINATION_EVIDENCE', 'UNRESOLVED_TRANSFER');
  }

  const self = toTransferLeg(tx, ctx);
  // The corpus is this row plus its candidate bucket. The bucket is scoped by
  // (currency, |amount|), which is exactly the set `legsQualify` can pair with —
  // so the REVERSE count the authority computes over it is complete, not a sample.
  //
  // ⚠️ It is also exactly the set the STRATIFIED tiers need: a day-0 claim can
  // only ever remove a leg of equal magnitude and currency, so the tier ordering
  // computed over one bucket is identical to the one a full-corpus pass would
  // compute. Bucketing is a performance decision that changes no answer.
  const corpus: TransferLeg[] = [self];
  for (const c of candidates) {
    if (c.id === tx.id) continue;
    if (admitTransferCandidate(admissionInput(c, ctx)) !== 'ADMITTED') continue;
    corpus.push(toTransferLeg(c, ctx));
  }

  const e = resolveDestinationEvidenceFor(self, corpus);
  // V27-TRUTH-3 — a positive liability-side movement needs the provider FAMILY
  // and any persisted counterparty, or the liability-inflow authority cannot
  // tell a customer payment from an issuer credit. Supplied, never re-derived.
  // Phase 4 — the attested axes decide the EXTERNAL leaves when nothing owned
  // qualified. Supplied for the same reason: never re-derived here.
  const evidence = plaidTransferEvidence({
    pfcDetailed: tx.pfcDetailed, amount: tx.amount, name: tx.merchant,
  });
  const maturity = maturityForEvidence(e, {
    accountType: self.accountType,
    amount: tx.amount,
    providerFamily: tx.pfcPrimary,
    persistedCounterpartyAccountId: tx.persistedCounterpartyAccountId ?? null,
    railType: evidence.railType ?? null,
    venueClass: evidence.venueClass ?? null,
    counterpartyClass: tx.counterpartyClass,
  });
  const unresolved = isUnresolvedMaturity(maturity)
    ? (e.unresolvedReason ?? (maturity === 'UNRESOLVED_LIABILITY_INFLOW'
        ? 'LIABILITY_INFLOW_UNATTESTED' : 'NO_COUNTERPART_EVIDENCE'))
    : null;

  switch (e.level) {
    // Phase 5 + the original certain rung. Both establish the ROW on the other
    // side; they differ in WHO established it, which `reason` records.
    case 'PROVIDER_LINKED':
    case 'ACCOUNT_CERTAIN':
      return {
        status: 'RESOLVED',
        transactionId:          e.legId,
        counterpartyAccountId:  e.accountId,
        confidence:             1,
        reason:                 e.level === 'PROVIDER_LINKED' ? 'PROVIDER_ASSERTED' : 'DETERMINISTIC_UNIQUE',
        destinationAccountType: e.accountType,
        maturity,
        evidenceLevel:          e.level,
        persistableCounterparty: true, persistableLeg: true,
        unresolvedReason: null, admission,
      };
    // Phase 3 — RESOLVED for the ACCOUNT, with `transactionId` null. The status
    // and the leg are independent facts here, which is why `persistableLeg`
    // exists as its own field rather than being inferred from the status.
    case 'ACCOUNT_CERTAIN_LEG_AMBIGUOUS':
      return {
        status: 'RESOLVED',
        transactionId:          null,
        counterpartyAccountId:  e.accountId,
        confidence:             1,
        reason:                 'ACCOUNT_CERTAIN_LEG_AMBIGUOUS',
        destinationAccountType: e.accountType,
        maturity,
        evidenceLevel:          e.level,
        persistableCounterparty: true, persistableLeg: false,
        unresolvedReason: null, admission,
      };
    case 'CASH_NO_COUNTERPARTY':
      return refuse('CASH_MOVEMENT_NO_COUNTERPARTY', e.level, maturity);
    case 'TYPE_CERTAIN_ACCOUNT_AMBIGUOUS':
      // The type is TRUE and is surfaced; the account is not, and is not invented.
      // `NOT_MUTUALLY_UNIQUE` distinguishes "one leg with rivals" from "many legs",
      // because the two demand different follow-up evidence.
      return refuse(
        e.candidateAccountIds.length === 1 ? 'NOT_MUTUALLY_UNIQUE' : 'TYPE_CERTAIN_ACCOUNT_AMBIGUOUS',
        e.level, maturity, e.accountType, unresolved,
      );
    case 'TYPE_AMBIGUOUS':
      return refuse('AMBIGUOUS_MULTIPLE_ACCOUNTS', e.level, maturity, null, unresolved);
    case 'NO_DESTINATION_EVIDENCE':
      // Phase 4 — an EXTERNAL leaf is an answer, not a refusal. `NO_CANDIDATE`
      // stays for the genuinely unresolved case, so the two never blur.
      return refuse(
        unresolved === null ? 'EXTERNAL_TERMINAL' : 'NO_CANDIDATE',
        e.level, maturity, null, unresolved,
      );
  }
}

/** The row's facts, as the admission authority sees them. One place, so the
 *  target gate and the candidate gate can never drift apart. */
function admissionInput(r: RelationshipTransaction, ctx: TransferMatchContext) {
  const evidence = plaidTransferEvidence({
    pfcDetailed: r.pfcDetailed, amount: r.amount, name: r.merchant,
  });
  return {
    flowType:      r.flowType ?? null,
    amount:        r.amount,
    accountType:   r.financialAccountId ? ctx.accountTypeById.get(r.financialAccountId) ?? null : null,
    accountId:     r.financialAccountId,
    category:      r.category,
    providerFamily: r.pfcPrimary,
    movementForm:  evidence.movementForm ?? null,
    railType:      evidence.railType ?? null,
    venueClass:    evidence.venueClass ?? null,
  };
}

/**
 * Adapt a relationship row to the authority's leg shape.
 *
 * Every field the authority needs comes from the ROW or from `ctx`; nothing is
 * re-derived. `superseded` goes through `resolveLifecycle` and `movementForm`
 * through `plaidTransferEvidence`, so this module holds no second copy of either
 * rule.
 *
 * `hasLivePostedSuccessor` is deliberately false here: it is a cross-row fact a
 * bucket-scoped matcher cannot establish (a posted successor usually differs in
 * amount, so it need not be in the bucket at all). Supersession therefore rests
 * on the tombstone, which the write path always sets when a pending row posts —
 * claiming more would be guessing.
 */
function toTransferLeg(r: RelationshipTransaction, ctx: TransferMatchContext): TransferLeg {
  const lifecycle = resolveLifecycle({
    settlementState: r.settlementState,
    pending:         r.pending,
    deletedAt:       r.deletedAt ?? null,
    hasLivePostedSuccessor: false,
  });
  // Phase 5 — identifier extraction. Only the OPAQUE key crosses this boundary;
  // the raw provider token never leaves `provider-link-extract.ts`, and a
  // mask's digits are consumed there and discarded.
  const evidence = plaidTransferEvidence({
    pfcDetailed: r.pfcDetailed, amount: r.amount, name: r.merchant,
  });
  const links = extractProviderLinks(r.descriptor ?? r.merchant, {
    institutionId:    r.institutionId,
    maskToAccountIds: ctx.maskToAccountIds ?? EMPTY_MASK_INDEX,
    selfAccountId:    r.financialAccountId as string,
  });
  return {
    id:          r.id,
    accountId:   r.financialAccountId as string,
    accountType: ctx.accountTypeById.get(r.financialAccountId as string) ?? 'other',
    ownerId:     r.ownerUserId ?? '',
    amount:      r.amount,
    currency:    r.currency ?? null,
    // L8-B — the ECONOMIC chronology. Posting dates separated two same-amount
    // card payments only by coincidence; authorization dates separate them by
    // evidence (see the calibration report §5).
    dateMs:      economicMs(r),
    superseded:  lifecycle.superseded,
    movementForm: evidence.movementForm ?? null,
    // The RAIL, for the payment-app ⊥ liability veto. Same adapter call as the
    // form, so the two axes can never come from different evaluations.
    railType: evidence.railType ?? null,
    providerLinkKey: links.correlation?.linkKey ?? null,
    maskedDestinationAccountId: links.maskedAccountId,
  };
}

const EMPTY_MASK_INDEX: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * The leg's timestamp, from the persisted economic chronology.
 *
 * ⚠️ Throws on a null rather than substituting the posting date. Requirement 10
 * of the cutover: no surface may silently fall back to posting chronology — and
 * a matcher comparing an economic date against a posting date would produce
 * confident, wrong pairings with nothing to show for it.
 */
function economicMs(r: RelationshipTransaction): number {
  if (r.economicDate == null) {
    throw new Error(
      `transfer leg ${r.id}: no economicDate. Transfer matching runs on the economic ` +
      `chronology; run npm run backfill:economic-date and npm run audit:economic-date.`,
    );
  }
  return r.economicDate.getTime();
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the deterministic relationship facts for one transaction against a
 * caller-supplied candidate set (e.g. same account, near date). Pure; the caller
 * owns fetching — the resolver never touches the DB.
 */
export function resolveTransactionRelationships(
  transaction: RelationshipTransaction,
  candidates: readonly RelationshipTransaction[],
  ctx: TransferMatchContext,
): TransactionRelationships {
  const transfer = matchTransferCandidate(transaction, candidates, ctx);
  return {
    pendingPosted:     resolvePendingPosted(transaction, candidates),
    duplicate:         resolveDuplicate(transaction, candidates),
    refundCandidate:   null,
    // Only a RESOLVED, deterministic match surfaces; NONE/AMBIGUOUS stay null
    // (unresolved is honest). The full outcome is available via matchTransferCandidate.
    transferCandidate: transfer.status === 'RESOLVED' ? transfer : null,
    // V27-TRUTH-2 — the refused outcome is carried rather than discarded, so a
    // surface can say what IS known (a debt payment whose account is unresolved)
    // instead of only "no match". Never carries an account id.
    transferAssessment: transfer,
  };
}
