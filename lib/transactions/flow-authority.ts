/**
 * lib/transactions/flow-authority.ts
 *
 * v2.6-OWN-1 — THE ownership authority for `Transaction.flowType`.
 *
 * Pure, deterministic, no I/O, no Prisma runtime dependency (structural types
 * only), so every write site — server route, sync worker, repair script, seed —
 * can consult the same rule without pulling in `@/lib/db`.
 *
 * ── The problem this closes ─────────────────────────────────────────────────
 *
 * `flowType` has four legitimate write paths and the column recorded only the
 * VALUE, never the AUTHOR:
 *
 *   lib/transactions/flow-classifier.ts   via buildFlowWriteFields — the Plaid
 *                                         sync, the CSV import, merchant
 *                                         corrections, backfill-flowtype
 *   lib/transactions/transfer-maturation.ts  applied by scripts/repair-*.ts
 *   lib/crypto/btc-sync.ts                the on-chain ledger
 *   prisma/seed.ts                        writes nothing — leaves it unclassified
 *
 * `classifierVersion` was doing double duty as ownership metadata and could not
 * carry it: two states, three authors, plus "nobody". So the transfer-authority
 * repairs wrote flow facts while leaving `classifierVersion = 4`, and their rows
 * became indistinguishable from classifier output. `audit:flow-desync` then
 * recomputed them, found 12 disagreements, failed, and printed a remediation
 * that would have reverted every approved repair.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 *   An authority may write a row that is UNOWNED, or that it already owns.
 *   Displacing another authority requires an EXPLICIT, DECLARED claim.
 *   Silence is refusal.
 *
 * That is the whole model. It is deliberately not a precedence lattice: a
 * ranking would let a "higher" authority silently overwrite a "lower" one, which
 * is the behaviour being removed. Ranking is a judgement about rows; this is a
 * statement about writers.
 *
 * `claims` is how an approved, reviewed act says out loud what it is displacing.
 * The transfer-authority repairs declare `claims: ["CLASSIFIER"]` — they exist
 * precisely to correct classifier output, and that is now written down at the
 * write site rather than inferred from a version number that meant something
 * else. A batch writer (backfill-flowtype) declares NO claims, so it can only
 * ever touch its own rows and the unowned backlog.
 *
 * ── Coupling ────────────────────────────────────────────────────────────────
 *
 *   (flowType IS NULL) == (flowAuthority IS NULL)
 *
 * An unclassified row is UNOWNED. That is distinct from "an authority looked and
 * declined", which is flowType = UNKNOWN WITH an owner. `isFlowOwnershipCoupled`
 * states it once; audit-flow-desync asserts it corpus-wide (INV-A).
 *
 * ── Adding an authority ─────────────────────────────────────────────────────
 *
 * Add the value to `enum FlowAuthority` in prisma/schema.prisma, add it to
 * FLOW_AUTHORITIES below, then label it in FLOW_AUTHORITY_LABEL and
 * FLOW_AUTHORITY_SOURCE. Both maps are `Record<FlowAuthorityName, …>`, so the
 * compiler refuses the change until the new authority says what it is and where
 * it lives. Then give it a write site that stamps itself.
 */

/** Every authority that may author `Transaction.flowType`. */
export const FLOW_AUTHORITIES = [
  "CLASSIFIER",
  "TRANSFER_AUTHORITY",
  "CRYPTO_LEDGER",
] as const;

export type FlowAuthorityName = (typeof FLOW_AUTHORITIES)[number];

/** Human-readable, for audit and dry-run output. Exhaustive by type. */
export const FLOW_AUTHORITY_LABEL: Record<FlowAuthorityName, string> = {
  CLASSIFIER:         "canonical flow classifier",
  TRANSFER_AUTHORITY: "transfer destination-evidence authority",
  CRYPTO_LEDGER:      "on-chain crypto ledger",
};

/** Where each authority's rule actually lives. Exhaustive by type, so a new
 *  authority cannot ship without naming its own module. */
export const FLOW_AUTHORITY_SOURCE: Record<FlowAuthorityName, string> = {
  CLASSIFIER:         "lib/transactions/flow-classifier.ts",
  TRANSFER_AUTHORITY: "lib/transactions/transfer-maturation.ts (applied by scripts/repair-*.ts)",
  CRYPTO_LEDGER:      "lib/crypto/btc-sync.ts",
};

/**
 * Does a row authored by this authority carry BANKING semantics?
 *
 * v2.6-CRYPTO-1 — the ONE separation rule.
 *
 *     CRYPTO_LEDGER rows must not enter banking populations or banking meanings.
 *
 * ── The doctrine ────────────────────────────────────────────────────────────
 *
 *   An on-chain receipt is not automatically INCOME.
 *   An on-chain send is not automatically SPENDING.
 *   A wallet-to-wallet movement is not automatically a banking TRANSFER.
 *
 * Fees, swaps, staking rewards, mining rewards, airdrops and exchange movements
 * are real economic events with real meanings — and every one of those meanings
 * belongs to a crypto-domain authority that does not exist yet. Until it does,
 * the banking domain REFUSES to assign one. Refusal is the correct answer, not a
 * gap: a confident wrong number is worse than an absent one.
 *
 * ── Why the AUTHORITY is the signal ─────────────────────────────────────────
 *
 * Not the account name, the institution, the ticker, the descriptor, the
 * currency, `classifierVersion`, or the wallet address. Every one of those is a
 * heuristic that a new chain, a new custodian or a renamed account breaks — and
 * naming a thing from its descriptor is the error class this codebase has spent
 * an entire arc removing (v2.6-TRUTH-9, v2.6-TRUTH-10).
 *
 * The authority that WROTE the row names itself (v2.6-OWN-1). That is a fact
 * about provenance, it is already on every row, and a future Solana/EVM/XRP
 * syncer inherits the separation the moment it stamps its own authority —
 * without this predicate changing at all.
 *
 * ── What "banking semantics" means here ─────────────────────────────────────
 *
 * The banking population and everything derived from it: Cash Flow, income,
 * spending, refunds, debt payments, banking transfers, the liquidity axis, the
 * AI's banking summaries, banking exports, and any Assessment input drawn from
 * them. It does NOT mean the row is hidden from the product — balances,
 * quantities, ledger reconciliation, snapshots, prices and historical valuation
 * are a different domain, computed from the wallet ledger, and are untouched.
 *
 * ⚠️ Returns TRUE for `null` (unowned). An unclassified row is a banking row
 * nobody has classified yet — it stays visible for review (v2.6-POP-1). Absence
 * of an owner is not evidence of being on-chain.
 */
export function carriesBankingSemantics(authority: FlowAuthorityName | null | undefined): boolean {
  return authority !== "CRYPTO_LEDGER";
}

/**
 * Can the classifier be re-run over this row to certify it?
 *
 * ONLY for CLASSIFIER-owned rows. `classifyFlow` is pure over stored columns, so
 * recomputing a row it wrote must reproduce the stored value — that is what
 * `audit:flow-desync` proves. Recomputing a row it did NOT write proves nothing
 * about that row and asserts ownership the classifier does not have.
 */
export function isClassifierCertifiable(authority: FlowAuthorityName | null | undefined): boolean {
  return authority === "CLASSIFIER";
}

/** Type guard for a value arriving from the DB / a CLI flag. */
export function isFlowAuthority(v: unknown): v is FlowAuthorityName {
  return typeof v === "string" && (FLOW_AUTHORITIES as readonly string[]).includes(v);
}

/**
 * The coupling invariant, stated once.
 *
 * True iff the row's ownership matches its classification: an unclassified row
 * is unowned, a classified row has exactly one owner.
 */
export function isFlowOwnershipCoupled(row: {
  flowType?: string | null;
  flowAuthority?: FlowAuthorityName | null;
}): boolean {
  return (row.flowType == null) === (row.flowAuthority == null);
}

// ─────────────────────────────────────────────────────────────────────────────
// The write rule
// ─────────────────────────────────────────────────────────────────────────────

export type FlowWriteVerdictKind =
  /** The row has no owner — any authority may adopt it. */
  | "UNOWNED"
  /** The writer already owns the row; this is a refresh, not a takeover. */
  | "SAME_AUTHORITY"
  /** A different authority owns it, and the writer declared that claim up front. */
  | "DECLARED_CLAIM"
  /** A different authority owns it and no claim was declared. Refused. */
  | "REFUSED_FOREIGN";

export interface FlowWriteVerdict {
  allowed: boolean;
  kind:    FlowWriteVerdictKind;
  /** One sentence, safe to print in a dry-run or an error. Contains no PII. */
  reason:  string;
}

/**
 * May `next` write the flow columns of a row currently owned by `current`?
 *
 * @param current the row's persisted `flowAuthority` (null = unowned)
 * @param next    the authority about to write
 * @param claims  authorities `next` has EXPLICITLY declared it may displace.
 *                Empty (the default) means "my own rows and unowned rows only".
 */
export function mayWriteFlow(
  current: FlowAuthorityName | null | undefined,
  next:    FlowAuthorityName,
  claims:  readonly FlowAuthorityName[] = [],
): FlowWriteVerdict {
  if (current == null) {
    return { allowed: true, kind: "UNOWNED", reason: `unowned row adopted by ${next}` };
  }
  if (current === next) {
    return { allowed: true, kind: "SAME_AUTHORITY", reason: `${next} refreshing its own row` };
  }
  if (claims.includes(current)) {
    return {
      allowed: true,
      kind:    "DECLARED_CLAIM",
      reason:  `${next} claims a ${current} row under a declared claim`,
    };
  }
  return {
    allowed: false,
    kind:    "REFUSED_FOREIGN",
    reason:
      `${next} may not overwrite a ${current} row — ${FLOW_AUTHORITY_SOURCE[current]} owns it. ` +
      `Declare the claim explicitly if displacing it is intended.`,
  };
}

/** Thrown when a write path attempts a silent cross-authority overwrite. */
export class FlowOwnershipError extends Error {
  readonly verdict: FlowWriteVerdict;
  constructor(verdict: FlowWriteVerdict, context: string) {
    super(`flow ownership refused (${context}): ${verdict.reason}`);
    this.name = "FlowOwnershipError";
    this.verdict = verdict;
  }
}

/**
 * `mayWriteFlow`, but throws instead of returning false.
 *
 * For write paths where refusal is a programming error rather than a row to
 * report — i.e. anywhere the caller has no branch for "skipped". A path that
 * legitimately skips foreign rows (the Plaid sync's update arm, the flowType
 * backfill's selection predicate) should call `mayWriteFlow` and preserve.
 */
export function assertMayWriteFlow(
  current: FlowAuthorityName | null | undefined,
  next:    FlowAuthorityName,
  context: string,
  claims:  readonly FlowAuthorityName[] = [],
): void {
  const v = mayWriteFlow(current, next, claims);
  if (!v.allowed) throw new FlowOwnershipError(v, context);
}

/**
 * The ownership columns a NON-CLASSIFIER authority stamps alongside its flow
 * write. One import, so a repair cannot forget half of it.
 *
 * `classifierVersion: null` is the load-bearing half. Once another authority has
 * overwritten the flow columns, "the classifier at version N produced these" is
 * no longer a true statement about the row, and leaving the number behind is
 * exactly what made the repairs look like classifier output. Nulling it also
 * means the pre-OWN-1 audit logic (`classifierVersion == null ⇒ not certified`)
 * reaches the same verdict as the new column — the two agree by construction
 * rather than by luck.
 *
 * The CLASSIFIER does NOT use this helper: it stamps `flowAuthority` and its own
 * version together in `buildFlowWriteFields`, which is the one place its version
 * is known.
 */
export function foreignFlowOwnershipFields(authority: Exclude<FlowAuthorityName, "CLASSIFIER">): {
  flowAuthority:     FlowAuthorityName;
  classifierVersion: null;
} {
  return { flowAuthority: authority, classifierVersion: null };
}
