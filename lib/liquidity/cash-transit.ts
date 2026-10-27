/**
 * lib/liquidity/cash-transit.ts   (v2.7-P2 — cash in transit, DISCLOSURE ONLY)
 *
 * Pure: no DB, no React, no clock (the caller passes `now`). Classifies recent
 * OUTGOING transfer legs on the Space's cash accounts by what the existing
 * evidence can prove about where the money is, and words a conservative
 * disclosure. It changes NO balance, NO total and NO classification: total cash
 * is still Σ adjusted balance (lib/balances/account-balances.ts), and nothing
 * here is ever added back to it.
 *
 * ── What the evidence can and cannot prove (assessment, 2026-10-27) ─────────
 *
 * The transfer authority (lib/transactions/transfer-resolution.ts →
 * RelationshipResolver.matchTransferCandidate) pairs an outgoing leg with an
 * opposite leg that EXISTS on another owned account (equal magnitude, same
 * currency, ±TRANSFER_MATCH_WINDOW_DAYS). Every rung that names a destination
 * account (PROVIDER_LINKED, ACCOUNT_CERTAIN, ACCOUNT_CERTAIN_LEG_AMBIGUOUS)
 * requires that leg to be present; the descriptor mask tier can only REMOVE
 * candidates, never name an account on its own. So:
 *
 *   · "left the source, the destination credit is ABSENT" is never a fact the
 *     authority produces — an unmatched leg is NO_COUNTERPART_EVIDENCE, which the
 *     authority itself says may be an unsynced destination OR money that left
 *     the household. A definitive "In transit $X" is therefore never shown.
 *   · What CAN be stated honestly: a recent outgoing transfer, already deducted
 *     from total cash at the source, that is not yet matched to any destination
 *     — as a neutral, counted uncertainty line.
 *   · A matched destination leg that is still PENDING on an account whose
 *     adjusted basis does not count its pending (UNPROVEN) may or may not be in
 *     that balance — also a neutral line, never a claim either way.
 *
 * ── States (one per outgoing leg) ────────────────────────────────────────────
 *
 *   CONFIRMED_INTERNAL      both legs present and the destination credit is in
 *                           total cash (posted, or pending on a destination whose
 *                           basis counts pending) — counted once. Nothing shown.
 *   DESTINATION_PENDING     matched; the destination credit is pending and the
 *                           destination's basis cannot prove it is counted.
 *                           Neutral line.
 *   UNMATCHED_OUTGOING      deducted at the source, no destination evidence at
 *                           all, still inside the match window. Neutral line.
 *   EXTERNAL                the authority attests it left the household (a
 *                           payment-app person, an unconnected brokerage /
 *                           exchange venue, a non-owned counterparty class, or
 *                           cash). Not transit. Nothing shown. (A generic
 *                           EXTERNAL_DEPOSITORY_TRANSFER with no owned leg is
 *                           NOT treated as external — see cash-transit-read.)
 *   DESTINATION_AMBIGUOUS   a destination exists among owned accounts but which
 *                           one (or which leg) is not established — a credit is
 *                           present somewhere, so it is not missing. Nothing shown.
 *   NOT_DEDUCTED_AT_SOURCE  the source debit is pending on an account whose
 *                           basis does not deduct it (UNPROVEN / no claim): the
 *                           money is still counted at the source. Nothing shown.
 *   POSSIBLY_COUNTED_TWICE  owner ruling (PR #63): the source debit is pending on
 *                           an account whose basis cannot prove it is deducted
 *                           (UNPROVEN / no claim) AND the matched destination
 *                           credit is already in total cash (posted, or pending
 *                           on a destination whose basis counts pending). The
 *                           same money may be in both balances until the source
 *                           posts. Neutral line; totals are NOT altered.
 *   STALE                   older than the match window — "not yet matched" no
 *                           longer applies (the authority cannot pair it any
 *                           more). Nothing shown.
 *   SUPERSEDED              a pending observation whose posted twin is live —
 *                           the twin carries the event. Never counted twice.
 */

import type { AdjustedBalanceBasis } from "@/lib/balances/account-balances";

/** The match window, in whole days — the transfer authority's own bound
 *  (lib/transactions/transfer-maturation.ts TRANSFER_MATCH_WINDOW_DAYS = 5).
 *  Re-declared as a literal so this module stays import-light and client-safe;
 *  cash-transit.test.ts pins the two equal. */
export const CASH_TRANSIT_WINDOW_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CashTransitState =
  | "CONFIRMED_INTERNAL"
  | "DESTINATION_PENDING"
  | "UNMATCHED_OUTGOING"
  | "EXTERNAL"
  | "DESTINATION_AMBIGUOUS"
  | "NOT_DEDUCTED_AT_SOURCE"
  | "POSSIBLY_COUNTED_TWICE"
  | "STALE"
  | "SUPERSEDED";

export type LegLifecycle = "PENDING" | "POSTED";

/**
 * One outgoing transfer leg, as the server read projects it. No names, no
 * descriptors, no transaction ids — only what the classification needs.
 */
export interface CashTransitLeg {
  /** The source cash account (visible to the Space at transaction-detail tier). */
  sourceAccountId: string;
  /** Signed native amount — NEGATIVE (money out), FM convention. */
  amount:    number;
  currency:  string | null;
  /** The leg's economic date (falls back to the posting date), ISO YYYY-MM-DD. */
  date:      string;
  lifecycle: LegLifecycle;
  /** A pending observation whose posted successor is live. */
  superseded: boolean;
  /**
   * The transfer authority's verdict, projected:
   *   MATCHED     a destination ACCOUNT is a fact (persistableCounterparty).
   *   AMBIGUOUS   destination legs exist but the account / leg is not unique,
   *               or a provider-persisted link names an account without a leg.
   *   EXTERNAL    a terminal external / cash leaf.
   *   UNMATCHED   NO_COUNTERPART_EVIDENCE — nothing on any owned account.
   *   OTHER       anything else (not admitted, liability inflow, …).
   */
  match: "MATCHED" | "AMBIGUOUS" | "EXTERNAL" | "UNMATCHED" | "OTHER";
  /** MATCHED only: the destination account and, when the leg is established,
   *  its lifecycle (null = account certain, leg ambiguous). */
  destination: { accountId: string; lifecycle: LegLifecycle | null } | null;
}

/** Bases that COUNT an account's pending rows in its adjusted balance. */
const COUNTS_PENDING: ReadonlySet<AdjustedBalanceBasis> = new Set(["PENDING_EXCLUDED", "PENDING_INCLUDED"]);

/**
 * Classify one leg. `basisOf` reads the SAME adjusted-balance basis the Cash
 * ledger and total cash use (currentState.basis per account; null = no claim).
 */
export function classifyCashTransitLeg(
  leg: CashTransitLeg,
  basisOf: (accountId: string) => AdjustedBalanceBasis | null,
  now: Date,
): CashTransitState {
  if (leg.superseded) return "SUPERSEDED";

  // Is the source debit already out of total cash? Posted ⇒ inside C. Pending ⇒
  // only where the source's own basis counts its pending (C + P, or C that
  // already includes P). Otherwise the money is still counted at the source.
  if (leg.lifecycle === "PENDING") {
    const b = basisOf(leg.sourceAccountId);
    if (b === null || !COUNTS_PENDING.has(b)) {
      // Still (possibly) counted at the source. If the matched destination has
      // ALREADY counted the credit, the same money may be in both balances.
      const d = leg.match === "MATCHED" ? leg.destination : null;
      if (d && d.lifecycle !== null) {
        const counted = d.lifecycle === "POSTED" || (() => { const db = basisOf(d.accountId); return db !== null && COUNTS_PENDING.has(db); })();
        if (counted) return "POSSIBLY_COUNTED_TWICE";
      }
      return "NOT_DEDUCTED_AT_SOURCE";
    }
  }

  switch (leg.match) {
    case "EXTERNAL":  return "EXTERNAL";
    case "AMBIGUOUS": return "DESTINATION_AMBIGUOUS";
    case "MATCHED": {
      const d = leg.destination;
      if (!d || d.lifecycle === null) return "DESTINATION_AMBIGUOUS";
      if (d.lifecycle === "POSTED") return "CONFIRMED_INTERNAL";
      const db = basisOf(d.accountId);
      return db !== null && COUNTS_PENDING.has(db) ? "CONFIRMED_INTERNAL" : "DESTINATION_PENDING";
    }
    case "UNMATCHED": {
      // Whole UTC calendar days since the leg, padded by one day exactly as the
      // transfer authority pads its gather window.
      const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
      const days = Math.round((today - Date.parse(`${leg.date}T00:00:00Z`)) / DAY_MS);
      return days > CASH_TRANSIT_WINDOW_DAYS + 1 ? "STALE" : "UNMATCHED_OUTGOING";
    }
    default:
      return "DESTINATION_AMBIGUOUS";
  }
}

export interface CashTransitSummary {
  /** Recent outgoing transfers with no destination evidence. */
  unmatched:          { count: number; total: number | null };
  /** Matched transfers whose destination credit is pending and unconfirmed. */
  destinationPending: { count: number; total: number | null };
  /** Matched transfers that may currently be counted at BOTH ends (see state). */
  possiblyCountedTwice: { count: number; total: number | null };
  /** Every leg's state, in input order (diagnostics / tests). */
  states: CashTransitState[];
}

/**
 * Summarise legs into the two disclosure buckets. `toDisplay` converts a native
 * magnitude into the display currency through the ledger's own conversion; a
 * null conversion makes that bucket's total null (count still disclosed).
 * Totals are MAGNITUDES (positive) and are never part of total cash.
 */
export function summarizeCashTransit(
  legs: CashTransitLeg[],
  basisOf: (accountId: string) => AdjustedBalanceBasis | null,
  now: Date,
  toDisplay: (amount: number, currency: string | null) => number | null = (a) => a,
): CashTransitSummary {
  const unmatched = { count: 0, total: 0 as number | null };
  const destinationPending = { count: 0, total: 0 as number | null };
  const possiblyCountedTwice = { count: 0, total: 0 as number | null };
  const states = legs.map((leg) => {
    const s = classifyCashTransitLeg(leg, basisOf, now);
    const bucket = s === "UNMATCHED_OUTGOING" ? unmatched
      : s === "DESTINATION_PENDING" ? destinationPending
      : s === "POSSIBLY_COUNTED_TWICE" ? possiblyCountedTwice
      : null;
    if (bucket) {
      bucket.count += 1;
      const v = toDisplay(Math.abs(leg.amount), leg.currency);
      bucket.total = bucket.total === null || v === null ? null : bucket.total + v;
    }
    return s;
  });
  return { unmatched, destinationPending, possiblyCountedTwice, states };
}

/**
 * The disclosure sentences, or [] when there is nothing to say. Wording is
 * deliberately neutral: "not yet matched" / "not yet confirmed", never "in
 * transit" as a fact. Amounts are formatted by the caller.
 */
export function cashTransitDisclosure(s: CashTransitSummary, fmt: (n: number) => string): string[] {
  const out: string[] = [];
  const amt = (t: number | null) => (t === null ? "" : ` (${fmt(t)})`);
  if (s.unmatched.count > 0) {
    const n = s.unmatched.count;
    out.push(
      `${n} outgoing transfer${n === 1 ? "" : "s"}${amt(s.unmatched.total)} — destination not yet confirmed; not added to total cash.`,
    );
  }
  if (s.destinationPending.count > 0) {
    const n = s.destinationPending.count;
    out.push(
      `${n} transfer${n === 1 ? "" : "s"}${amt(s.destinationPending.total)} still pending at the destination — not yet confirmed in that account's balance.`,
    );
  }
  if (s.possiblyCountedTwice.count > 0) {
    const n = s.possiblyCountedTwice.count;
    out.push(
      `${n} transfer${n === 1 ? "" : "s"}${amt(s.possiblyCountedTwice.total)} may be counted in both accounts until the sending bank posts ${n === 1 ? "it" : "them"} — totals are not adjusted.`,
    );
  }
  return out;
}
