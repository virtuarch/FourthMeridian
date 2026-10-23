/**
 * lib/transactions/transfer-chain.ts   (v2.6-TRUTH-4)
 *
 * Owned-money journeys across MORE than one hop: savings → checking → card,
 * checking → brokerage → purchase, and so on.
 *
 * Pure: no DB, no React, no clock. Derived only. Composes the pairwise leg
 * authority (`resolveDestinationEvidenceFor`) — it does not reimplement leg
 * matching, and a standing probe enforces that.
 *
 * ── What the corpus actually says (2026-08-04) ──────────────────────────────
 *
 * This authority was built after measuring, and the measurement matters more
 * than the code: **the corpus contains ZERO deterministic multi-leg chains.**
 *
 *   139 resolved owned-account hops (117 live).
 *   Two-hop candidates at EXACT amount:  0 at ≤1d, ≤2d, ≤3d, ≤5d, ≤7d, ≤14d.
 *                                        1 at ≤30d.
 *
 * The journeys one expects — "savings tops up checking, checking pays the card"
 * — do happen as behaviour but not as traceable amounts: the corpus has 14
 * savings→checking hops and 76 checking→card hops, and no pair of them shares an
 * amount within two weeks. Money entering checking is fungible, and the
 * arrival-to-departure gap histogram is FLAT out to 30 days (83·54·18·30·37·34·
 * 20·38·…) with none of the decay a causal succession shows. Flat means
 * co-occurrence, not causation.
 *
 * Relaxing to "the onward amount is ≤ the arrival" produces 8 live candidates
 * and immediately double-counts: one $997.37 arrival funds two different card
 * payments, and one card payment is claimed by both a $9,000 and a $1,000
 * arrival. That is the many-to-many collapse this authority exists to refuse, so
 * partial forwarding is NOT an admitted rule.
 *
 * The authority is therefore built to be correct and to find nothing today.
 * That is the honest outcome: it will resolve chains when a corpus contains
 * them, and it fabricates none while a corpus does not.
 *
 * ── The rules, and why each is necessary ───────────────────────────────────
 *
 *  1. Both hops must ALREADY be pairwise ACCOUNT_CERTAIN. A chain of guesses is
 *     a bigger guess.
 *  2. The intermediate must be PARKABLE. Money arriving at a liability
 *     extinguishes debt; it does not wait there to move on, so a card can be a
 *     terminus but never a middle.
 *  3. Amounts must be EQUAL, not merely sufficient (see the double-counting).
 *  4. The continuation must be MUTUALLY unique — one onward hop for this
 *     arrival, and one arrival for that onward hop. Same discipline as
 *     v2.6-TRUTH-1's leg matching, applied one level up.
 *  5. No revisited account: A→B→A is a round trip, and A→B→C→A is a cycle.
 *     Both are represented honestly rather than silently linearised.
 *  6. Deterministic: hops are ordered by (economic ms, leg id) before linking,
 *     so the same corpus always yields the same graph.
 */

import {
  resolveDestinationEvidenceFor,
  TRANSFER_AMOUNT_EPSILON,
  TRANSFER_MATCH_WINDOW_DAYS,
  type TransferLeg,
} from "@/lib/transactions/transfer-maturation";

/**
 * ± whole days between an arrival and the onward departure that continues it.
 *
 * ── This bound MUST exceed TRANSFER_MATCH_WINDOW_DAYS, and that is a theorem ─
 *
 * Building this authority proved something the corpus census alone did not.
 * Every leg of a fully-forwarded chain carries the SAME amount, so if the second
 * hop lands within the first leg's ±match window, the first leg's candidate set
 * contains BOTH the intermediate arrival and the terminal arrival — two
 * candidates, so the pairwise authority correctly refuses ACCOUNT_CERTAIN and
 * there is no hop to chain. If instead the second hop lands outside that window,
 * the first leg resolves cleanly but a continuation window of the same size
 * rejects it.
 *
 * With both windows equal, a multi-leg chain is therefore not merely absent from
 * this corpus — it is UNREPRESENTABLE. The two windows answer different
 * questions and must not share a number: the leg window bounds provider
 * settlement skew ("are these two sides of one movement?"), while this one
 * bounds human behaviour ("did money that arrived move on?").
 *
 * **14**, reusing `ECONOMIC_DATE_MAX_LAG_DAYS` — a bound this repository already
 * derived from the corpus (a smooth decay to 8 days, then a 30-day empty gap;
 * 14 sits inside that gap). Reusing a measured constant is preferable to
 * inventing a second unmeasured one, and the measured continuation histogram is
 * FLAT (83·54·18·30·37·34·20·38·…), so it offers no bound of its own — flatness
 * is the signature of co-occurrence, not causation. The real protection against
 * false chains is not the window but the equal-amount, parkable-intermediate and
 * mutual-uniqueness rules below; at 30 days with those applied the live corpus
 * still yields zero.
 */
export const CHAIN_CONTINUATION_WINDOW_DAYS = 14;

// The theorem above, enforced rather than trusted: if this ever stops holding,
// chains become silently unrepresentable and every journey degrades to a single
// hop with no error anywhere.
if (CHAIN_CONTINUATION_WINDOW_DAYS <= TRANSFER_MATCH_WINDOW_DAYS) {
  throw new Error(
    "transfer-chain: CHAIN_CONTINUATION_WINDOW_DAYS must exceed TRANSFER_MATCH_WINDOW_DAYS, " +
    "or a fully-forwarded chain cannot be resolved at all (see the note above).",
  );
}

/** Account types money can PARK in and move on from. A liability is never one. */
export const PARKABLE_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  "checking", "savings", "investment", "crypto", "other",
]);

/** What a completed journey was FOR. Named by the TERMINAL account's type. */
export type ChainPurpose =
  | "SAVINGS_MOVEMENT"      // terminates in a savings account
  | "DEBT_FUNDING"          // terminates in a liability
  | "BROKERAGE_FUNDING"     // terminates in an investment / crypto account
  | "CASH_MOVEMENT"         // terminates as cash (form change), or in checking
  | "OWNED_TRANSFER_CHAIN"  // owned end-to-end, terminal type names no purpose
  | "UNRESOLVED_CHAIN";     // no terminus established

export type ChainState =
  /** A single hop. Present so every leg has an assessment, not only chained ones. */
  | "SINGLE_HOP"
  /** Two or more hops, linked mutually and unambiguously. */
  | "LINKED"
  /** Continuation candidates exist but more than one qualifies. Refused. */
  | "BRANCHED"
  /** The journey revisits an account. Refused as a linear chain. */
  | "CYCLIC"
  /** No hop at all — the leg is not part of any owned journey we can see. */
  | "UNLINKED";

/** One adjacent, pairwise-certain hop: an outflow leg and where it landed. */
export interface ChainHop {
  legId: string;
  fromAccountId: string;
  toAccountId: string;
  toAccountType: string;
  amount: number;
  dateMs: number;
}

export interface TransferChainAssessment {
  /** Deterministic and DERIVED — never persisted. See `chainIdFor`. */
  chainId: string;
  state: ChainState;
  /** Every leg in the journey, in travel order. */
  legIds: string[];
  sourceAccountId: string;
  terminalAccountId: string | null;
  terminalAccountType: string | null;
  purpose: ChainPurpose;
  /**
   * The IMMEDIATE counterparty of each leg, and only the immediate one.
   * A non-adjacent hop NEVER appears here: knowing money eventually reached a
   * card does not make the card this leg's counterparty, and writing it as one
   * would be the fabrication the whole arc has been removing.
   */
  immediateCounterpartyByLeg: Record<string, string>;
  /** How far the journey is established. */
  evidenceLevel: "CHAIN_CERTAIN" | "HOP_CERTAIN" | "NONE";
  /** Present whenever a longer chain was possible but refused, with the reason. */
  refusalReason: string | null;
}

/**
 * A derived, stable chain id. Content-addressed by the ordered leg ids, so the
 * same journey always yields the same id and two different journeys cannot
 * collide. Deliberately NOT a persisted key — there is no chain table and this
 * slice does not propose one.
 */
export function chainIdFor(legIds: readonly string[]): string {
  return `chain:${legIds.join(">")}`;
}

function purposeForTerminal(type: string | null): ChainPurpose {
  switch (type) {
    case "savings":    return "SAVINGS_MOVEMENT";
    case "debt":       return "DEBT_FUNDING";
    case "investment":
    case "crypto":     return "BROKERAGE_FUNDING";
    case "checking":   return "CASH_MOVEMENT";
    case null:         return "UNRESOLVED_CHAIN";
    default:           return "OWNED_TRANSFER_CHAIN";
  }
}

/**
 * Build every adjacent hop the PAIRWISE authority already certifies.
 *
 * This is the composition seam: the chain authority asks the leg authority
 * "where did this one leg land?" and never answers that question itself.
 */
export function resolveChainHops(corpus: readonly TransferLeg[]): ChainHop[] {
  const byId = new Map(corpus.map((l) => [l.id, l]));
  const hops: ChainHop[] = [];
  for (const leg of corpus) {
    if (leg.amount >= 0) continue;                       // hops are named by their OUTFLOW
    const e = resolveDestinationEvidenceFor(leg, corpus);
    if (e.level !== "ACCOUNT_CERTAIN" || !e.accountId) continue;
    hops.push({
      legId: leg.id,
      fromAccountId: leg.accountId,
      toAccountId: e.accountId,
      toAccountType: byId.get(e.legId ?? "")?.accountType ?? "other",
      amount: Math.abs(leg.amount),
      dateMs: leg.dateMs,
    });
  }
  // Determinism: a stable total order before any linking happens.
  hops.sort((a, b) => a.dateMs - b.dateMs || (a.legId < b.legId ? -1 : a.legId > b.legId ? 1 : 0));
  return hops;
}

/** Whether `next` continues `prev`: same parkable account, equal amount, in window. */
function continues(prev: ChainHop, next: ChainHop): boolean {
  if (next.legId === prev.legId) return false;
  if (next.fromAccountId !== prev.toAccountId) return false;
  if (!PARKABLE_ACCOUNT_TYPES.has(prev.toAccountType)) return false;
  if (Math.abs(next.amount - prev.amount) > TRANSFER_AMOUNT_EPSILON) return false;
  const days = (next.dateMs - prev.dateMs) / 86_400_000;
  return days >= 0 && days <= CHAIN_CONTINUATION_WINDOW_DAYS;
}

/**
 * Assess the journey each leg belongs to.
 *
 * Returns one assessment per HOP (keyed by leg id). Legs with no certified hop
 * get an UNLINKED assessment, so a caller always has an answer and never has to
 * infer one from an absence.
 */
export function resolveTransferChains(
  corpus: readonly TransferLeg[],
): Map<string, TransferChainAssessment> {
  const hops = resolveChainHops(corpus);
  const byLeg = new Map(hops.map((h) => [h.legId, h]));
  const out = new Map<string, TransferChainAssessment>();

  // Forward and backward continuation sets, for MUTUAL uniqueness.
  const forward = new Map<string, ChainHop[]>();
  const backward = new Map<string, ChainHop[]>();
  for (const a of hops) {
    for (const b of hops) {
      if (!continues(a, b)) continue;
      (forward.get(a.legId) ?? forward.set(a.legId, []).get(a.legId)!).push(b);
      (backward.get(b.legId) ?? backward.set(b.legId, []).get(b.legId)!).push(a);
    }
  }

  const single = (h: ChainHop): TransferChainAssessment => ({
    chainId: chainIdFor([h.legId]),
    state: "SINGLE_HOP",
    legIds: [h.legId],
    sourceAccountId: h.fromAccountId,
    terminalAccountId: h.toAccountId,
    terminalAccountType: h.toAccountType,
    purpose: purposeForTerminal(h.toAccountType),
    immediateCounterpartyByLeg: { [h.legId]: h.toAccountId },
    evidenceLevel: "HOP_CERTAIN",
    refusalReason: null,
  });

  const claimed = new Set<string>();
  for (const start of hops) {
    if (claimed.has(start.legId)) continue;
    // A chain STARTS where nothing continues into it.
    if ((backward.get(start.legId) ?? []).length > 0) continue;

    const path: ChainHop[] = [start];
    const visitedAccounts = new Set([start.fromAccountId, start.toAccountId]);
    let refusal: string | null = null;
    let state: ChainState = "SINGLE_HOP";

    for (;;) {
      const head = path[path.length - 1];
      const nexts = forward.get(head.legId) ?? [];
      if (nexts.length === 0) break;
      if (nexts.length > 1) {
        state = "BRANCHED";
        refusal = `${nexts.length} onward hops qualify from ${head.toAccountId}; the journey branches and is not linearised.`;
        break;
      }
      const next = nexts[0];
      // Mutual: that onward hop must be continued by THIS one and nothing else.
      const rivals = backward.get(next.legId) ?? [];
      if (rivals.length !== 1) {
        state = "BRANCHED";
        refusal = `The onward hop ${next.legId} is claimed by ${rivals.length} arrivals, so the continuation is not mutually unique.`;
        break;
      }
      if (visitedAccounts.has(next.toAccountId)) {
        state = "CYCLIC";
        refusal = `The journey returns to ${next.toAccountId}, which it has already visited; a cycle is reported, never flattened into a linear chain.`;
        break;
      }
      path.push(next);
      visitedAccounts.add(next.toAccountId);
      state = "LINKED";
    }

    if (path.length === 1 && state !== "BRANCHED" && state !== "CYCLIC") {
      out.set(start.legId, single(start));
      claimed.add(start.legId);
      continue;
    }

    const legIds = path.map((h) => h.legId);
    const terminal = path[path.length - 1];
    const assessment: TransferChainAssessment = {
      chainId: chainIdFor(legIds),
      state,
      legIds,
      sourceAccountId: path[0].fromAccountId,
      terminalAccountId: terminal.toAccountId,
      terminalAccountType: terminal.toAccountType,
      purpose: purposeForTerminal(terminal.toAccountType),
      immediateCounterpartyByLeg: Object.fromEntries(path.map((h) => [h.legId, h.toAccountId])),
      evidenceLevel: path.length > 1 ? "CHAIN_CERTAIN" : "HOP_CERTAIN",
      refusalReason: refusal,
    };
    for (const id of legIds) { out.set(id, assessment); claimed.add(id); }
  }

  // Any hop not reached above (mid-chain starts already claimed; the rest are
  // their own single hops).
  for (const h of hops) if (!out.has(h.legId)) out.set(h.legId, single(h));

  // Legs with no certified hop at all — answered explicitly, never by absence.
  for (const leg of corpus) {
    if (out.has(leg.id) || byLeg.has(leg.id)) continue;
    out.set(leg.id, {
      chainId: chainIdFor([leg.id]),
      state: "UNLINKED",
      legIds: [leg.id],
      sourceAccountId: leg.accountId,
      terminalAccountId: null,
      terminalAccountType: null,
      purpose: "UNRESOLVED_CHAIN",
      immediateCounterpartyByLeg: {},
      evidenceLevel: "NONE",
      refusalReason: null,
    });
  }
  return out;
}

/** Presentation wording. One place; React composes nothing. */
export const CHAIN_PURPOSE_LABEL: Record<ChainPurpose, string> = {
  SAVINGS_MOVEMENT:     "Part of a savings transfer chain",
  DEBT_FUNDING:         "Funds later reached a credit-card account",
  BROKERAGE_FUNDING:    "Funds later reached an investment account",
  CASH_MOVEMENT:        "Intermediate transfer between owned accounts",
  OWNED_TRANSFER_CHAIN: "Intermediate transfer between owned accounts",
  UNRESOLVED_CHAIN:     "Chain unresolved",
};
