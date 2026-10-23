/**
 * lib/data/account-coverage.core.ts
 *
 * THE account historical-coverage policy. Pure: no DB, no clock, no prices.
 *
 * ── The problem this fixes ───────────────────────────────────────────────────
 * The as-of resolver floored every account at max(account.createdAt,
 * link.createdAt) — the date Fourth Meridian CONNECTED it. That is an INGESTION
 * fact. It says when we learned about the account, not when the account existed
 * or from when its history can be defended.
 *
 * Meanwhile the snapshot writers (`computeAccountFloors`) already floor at the
 * earliest real transaction. So two authorities disagreed, and the parent chart
 * showed defensible history while an account drill-down returned nothing.
 *
 * ── Four floors, because they are four different questions ───────────────────
 *
 *   EXISTENCE   earliest dated evidence proving the account EXISTED.
 *   REPLAY      earliest date its balance/value can be RECONSTRUCTED under the
 *               canonical rules. Never earlier than the anchor those rules need.
 *   VALUATION   earliest date a value can be DEFENDED (quantities, prices,
 *               provider capability). Resolved by the valuation authorities, not
 *               here — this module only reports what it can bound.
 *   DISPLAY     where a value may actually appear = the latest of the above.
 *
 * Collapsing them is what makes an engine lie. A transaction dated 2024 proves
 * the account existed in 2024; it does NOT prove every earlier balance can be
 * reconstructed, and it says nothing at all about whether a price existed.
 *
 * ── The rule that keeps widening safe ────────────────────────────────────────
 * WIDER EXISTENCE NEVER WIDENS REPLAY. An account whose balance the canonical
 * ladder cannot walk (an installment loan, an investment account, a wallet with
 * an incomplete ledger) keeps the connection fallback as its REPLAY floor, so
 * nothing carries today's balance backward merely because we learned the account
 * is older. Existence widens what we can SAY; only replay widens what we can
 * COMPUTE.
 *
 * This module performs NO valuation and reads NO balances. It resolves licensing
 * intervals and reasons for the canonical account-series authorities.
 */

/** What established a floor. Provenance the caller can show. */
export type CoverageEvidenceKind =
  | "POSTED_TRANSACTION"
  | "POSITION_OBSERVATION"
  | "POSITION_RECONSTRUCTION_ANCHOR"
  | "INVESTMENT_EVENT"
  | "WALLET_LEDGER"
  | "CONNECTION_FALLBACK";

export interface CoverageEvidence {
  kind:    CoverageEvidenceKind;
  dateISO: string;
}

/**
 * How the account's history is reconstructed — which decides whether a wider
 * existence floor may become a wider REPLAY floor.
 */
export type CoverageClass =
  /** checking / savings / revolving card: the posted-ledger walk-back applies. */
  | "BALANCE_WALK"
  /** investment: quantities come from the position spine, not a balance walk. */
  | "POSITION_SPINE"
  /** crypto wallet: quantity carry, gated by ledger completeness. */
  | "WALLET_LEDGER"
  /** installment loans, manual assets: no replay exists at all. */
  | "HELD_FLAT";

/**
 * Candidate evidence, ALREADY SCOPED TO ONE ACCOUNT by the binding.
 *
 * Every field is a date the binding proved belongs to THIS account. Passing
 * dates rather than rows keeps this module free of schema types and makes the
 * scoping predicates the binding's documented responsibility — the same posture
 * `quantity-carry.core` and `ledger-completeness.core` take.
 */
export interface AccountCoverageInput {
  accountId: string;
  coverageClass: CoverageClass;
  /** max(account.createdAt, link.createdAt) — provenance, and the fallback. */
  connectionFloorISO: string;
  /** Earliest POSTED, non-deleted transaction on THIS account. */
  earliestPostedTxISO: string | null;
  /** Earliest position observation on THIS account. */
  earliestPositionObservationISO: string | null;
  /** Earliest `PositionReconstruction.earliestDefensibleDate` on THIS account. */
  earliestReconstructionAnchorISO: string | null;
  /** Earliest investment event on THIS account. */
  earliestInvestmentEventISO: string | null;
  /**
   * Does the wallet's movement ledger account for its observed balance?
   * Undefined for non-wallets. A wallet whose ledger does not reconcile cannot
   * have its quantity carried backward, so it gets no replay floor.
   */
  walletLedgerComplete?: boolean;
}

export interface AccountHistoricalCoverage {
  accountId: string;
  /** Earliest date we can prove the account existed. Null when nothing proves it. */
  existenceFromISO: string | null;
  /** Earliest date the canonical ladder can reconstruct. Null when it cannot. */
  replayFromISO: string | null;
  /**
   * Earliest date a value may appear — the intersection. Never null: it falls
   * back to the connection date, which is always defensible.
   */
  displayFromISO: string;
  /** Did evidence move the floor, or is this still the ingestion date? */
  state: "EVIDENCED" | "CONNECTION_FALLBACK";
  /** Coded, never prose. */
  reasons: string[];
  evidence: CoverageEvidence[];
}

/** Earliest non-null date, with the evidence that carried it. */
function earliest(
  candidates: readonly (readonly [CoverageEvidenceKind, string | null])[],
): CoverageEvidence | null {
  let best: CoverageEvidence | null = null;
  for (const [kind, dateISO] of candidates) {
    if (!dateISO) continue;
    if (best === null || dateISO < best.dateISO) best = { kind, dateISO };
  }
  return best;
}

/** Which evidence establishes EXISTENCE, per class. */
function existenceCandidates(
  i: AccountCoverageInput,
): (readonly [CoverageEvidenceKind, string | null])[] {
  switch (i.coverageClass) {
    case "BALANCE_WALK":
    case "HELD_FLAT":
      return [["POSTED_TRANSACTION", i.earliestPostedTxISO]];
    case "WALLET_LEDGER":
      return [
        ["WALLET_LEDGER", i.earliestPostedTxISO],
        ["POSITION_OBSERVATION", i.earliestPositionObservationISO],
      ];
    case "POSITION_SPINE":
      // NOT InvestmentEventCoverage. That row records what we ASKED an ITEM for
      // and what the ITEM returned — two accounts on one Plaid item carry the
      // same `earliestReturnedDate` and the same `fetchedCount`. Using it would
      // license one account with its sibling's history. It is coverage
      // provenance, never per-account existence evidence.
      return [
        ["POSITION_OBSERVATION", i.earliestPositionObservationISO],
        ["POSITION_RECONSTRUCTION_ANCHOR", i.earliestReconstructionAnchorISO],
        ["INVESTMENT_EVENT", i.earliestInvestmentEventISO],
      ];
  }
}

/**
 * Resolve one account's coverage. Deterministic; never throws.
 *
 * Widening is EVIDENCE-DRIVEN and one-directional: a floor only ever moves
 * EARLIER than the connection date, and only when dated evidence carries it
 * there. An account with no evidence keeps the connection date, which is the
 * safe answer rather than a silent widening.
 */
export function resolveAccountCoverage(
  input: AccountCoverageInput,
): AccountHistoricalCoverage {
  const reasons: string[] = [];
  const evidence: CoverageEvidence[] = [];

  const existenceHit = earliest(existenceCandidates(input));
  // Evidence dated AFTER connection tells us nothing new about how far back we
  // can go. The floor is the earlier of the two, never the later.
  const existenceFromISO = existenceHit && existenceHit.dateISO < input.connectionFloorISO
    ? existenceHit.dateISO
    : null;

  if (existenceHit) evidence.push(existenceHit);
  evidence.push({ kind: "CONNECTION_FALLBACK", dateISO: input.connectionFloorISO });

  if (existenceFromISO === null) {
    reasons.push(existenceHit ? "NO_EVIDENCE_PRECEDES_CONNECTION" : "NO_DATED_EVIDENCE");
  }

  // ── REPLAY ────────────────────────────────────────────────────────────────
  //
  // The question is no longer "did it exist" but "can the canonical ladder
  // produce a number". Existence alone never answers that.
  let replayFromISO: string | null = null;
  switch (input.coverageClass) {
    case "BALANCE_WALK":
      // The walk anchors on today's posted balance and subtracts posted rows
      // backward. It reaches exactly as far as the posted ledger does.
      replayFromISO = existenceFromISO;
      if (replayFromISO) reasons.push("REPLAY_FROM_POSTED_LEDGER");
      break;

    case "POSITION_SPINE":
      // Quantities come from the reconstruction anchor, never from a balance.
      // The anchor is what bounds the replay — an observation without one is
      // evidence the account existed, not a licence to reconstruct before it.
      replayFromISO = input.earliestReconstructionAnchorISO ?? input.earliestPositionObservationISO;
      if (replayFromISO && replayFromISO >= input.connectionFloorISO) replayFromISO = null;
      reasons.push(replayFromISO ? "REPLAY_FROM_POSITION_SPINE" : "NO_POSITION_SPINE_BEFORE_CONNECTION");
      break;

    case "WALLET_LEDGER":
      // A wallet's quantity may only be carried backward across a ledger that
      // accounts for its observed balance. An incomplete ledger is not a
      // smaller window — it is no window.
      if (input.walletLedgerComplete === true) {
        replayFromISO = existenceFromISO;
        if (replayFromISO) reasons.push("REPLAY_FROM_COMPLETE_WALLET_LEDGER");
      } else {
        reasons.push("WALLET_LEDGER_INCOMPLETE");
      }
      break;

    case "HELD_FLAT":
      // THE SAFETY RULE. An installment loan has no ledger the walk can use, so
      // knowing it is older changes nothing about what it was WORTH. Widening
      // its floor would carry today's balance backward across years and present
      // a fabricated series — the failure mode this whole policy exists to
      // avoid. Existence may widen; replay does not.
      reasons.push("NO_REPLAY_FOR_HELD_FLAT_ACCOUNT");
      break;
  }

  return {
    accountId: input.accountId,
    existenceFromISO,
    replayFromISO,
    // The intersection: a value may appear only where the ladder can produce
    // one. Valuation may narrow this further (prices, ownership) — that is the
    // valuation authorities' call, made per date, not this module's.
    displayFromISO: replayFromISO ?? input.connectionFloorISO,
    state: existenceFromISO !== null ? "EVIDENCED" : "CONNECTION_FALLBACK",
    reasons,
    evidence,
  };
}

/** The coverage class for an account type, given the revolving-card verdict. */
export function coverageClassFor(
  type: string,
  isReconstructableCard: boolean,
): CoverageClass {
  if (type === "checking" || type === "savings") return "BALANCE_WALK";
  if (type === "investment") return "POSITION_SPINE";
  if (type === "crypto") return "WALLET_LEDGER";
  if (type === "debt") return isReconstructableCard ? "BALANCE_WALK" : "HELD_FLAT";
  return "HELD_FLAT";
}
