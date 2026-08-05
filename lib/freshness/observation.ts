/**
 * lib/freshness/observation.ts   (v2.6-L1 — FRESHNESS TRUTH)
 *
 * THE canonical per-account freshness authority. Pure: no DB, no React, no
 * ambient clock — `now` is a REQUIRED argument on every entry point so a caller
 * can never accidentally resolve freshness against a clock nobody chose.
 *
 * ── The fact this module exists to protect ────────────────────────────────────
 *
 * A balance is an OBSERVATION, and an observation has two clocks that are not
 * the same fact:
 *
 *   providerBalanceAt   the institution's own attestation of when IT computed
 *                       the balance (Plaid `AccountBalance.last_updated_datetime`,
 *                       stored as FinancialAccount.balanceLastUpdatedAt). Null on
 *                       every institution that does not send it — which today is
 *                       ALL 35 accounts in the local corpus.
 *
 *   ingestedAt          when Fourth Meridian wrote the row
 *                       (FinancialAccount.lastUpdated). This is OUR clock. It says
 *                       "we asked at this instant", never "the institution's
 *                       number was current at this instant".
 *
 * Conflating them is the whole defect. `basis` names which clock produced the
 * instant being reported, and a surface that shows an age without showing the
 * basis is making a claim it cannot support. When the provider clock is unknown
 * the honest verb is "last checked", not "as of".
 *
 * ── The third dimension: ledger coverage ─────────────────────────────────────
 *
 * The balance feed and the transaction feed advance INDEPENDENTLY (investigation
 * §5: BTC balance 31 days ahead of its ledger; Schwab and Robinhood have no
 * transaction feed at all; seed institutions run 32–39 days the other way). So
 * "how fresh is this account" has no single answer.
 *
 * Ledger coverage is deliberately NOT folded into the balance band, and is
 * deliberately NOT called "staleness": the newest transaction we hold is a
 * statement about how far the ledger REACHES, not about when the feed was last
 * checked. A quiet account with no recent spending has an old coverage date and
 * a perfectly current feed. Reporting reach as staleness would invent a defect;
 * reporting nothing would hide the BTC wallet whose ledger stops in 2023.
 */

// ── Vocabulary ────────────────────────────────────────────────────────────────

/**
 * Which clock produced the instant being reported. Never a display detail —
 * PROVIDER_ATTESTED and INGESTION answer different questions and a consumer that
 * treats them alike is overstating one of them.
 */
export type FreshnessBasis =
  /** The institution told us when it computed this balance. */
  | "PROVIDER_ATTESTED"
  /** We know only when Fourth Meridian wrote the row. The institution's own
   *  computation time is UNKNOWN and must not be implied. */
  | "INGESTION"
  /** No timestamp evidence at all. */
  | "UNOBSERVED";

/**
 * Coarse age band. Bands exist so surfaces can decide *whether* to disclose
 * without re-deriving thresholds; the exact `ageDays` always travels alongside.
 */
export type FreshnessBand = "LIVE" | "RECENT" | "STALE" | "VERY_STALE" | "UNKNOWN";

/** An observation older than this is STALE. Matches the investigation's cut. */
export const STALE_AFTER_DAYS = 7;
/** An observation older than this is VERY_STALE. */
export const VERY_STALE_AFTER_DAYS = 30;
/** Younger than this reads as live. */
export const LIVE_WITHIN_DAYS = 1;

/**
 * Clock skew we tolerate before calling the provider clock and our own clock
 * contradictory. A provider cannot have computed a balance meaningfully AFTER we
 * fetched it; a few minutes is timezone/rounding noise, an hour is a disagreement.
 */
export const PROVIDER_CLOCK_SKEW_TOLERANCE_MINUTES = 60;

// ── Shapes ────────────────────────────────────────────────────────────────────

/** The balance-feed observation for one account. */
export interface BalanceObservation {
  /** The instant being reported, ISO-8601. Null when nothing was observed. */
  observedAt: string | null;
  /** Which clock `observedAt` came from. */
  basis: FreshnessBasis;
  /** Age of `observedAt` in days at `now`. Null when unobserved. Never clamped. */
  ageDays: number | null;
  band: FreshnessBand;
  /**
   * True when the institution never told us its own computation time. The age we
   * report is then a LOWER BOUND on the true age of the number — the institution
   * may have computed it long before we fetched it.
   */
  providerClockUnknown: boolean;
  /**
   * Our own write instant, always carried separately so no consumer has to
   * reconstruct it and no consumer can mistake it for the provider's.
   */
  ingestedAt: string | null;
  /** The provider's attestation, carried separately for the same reason. */
  providerAttestedAt: string | null;
  /**
   * True when the provider's attested instant is later than our write instant by
   * more than the skew tolerance — the two clocks disagree. We then report the
   * OLDER of the two (never the more flattering one) and say so.
   */
  contradictory: boolean;
}

/**
 * How far this account's transaction ledger reaches. NOT a staleness claim.
 *
 * Three states, and the distinction between the last two is the honest part: we
 * can attest that WE hold no transactions for an account, but we cannot attest
 * that the PROVIDER has no feed for it — Plaid simply does not deliver
 * transactions for the brokerage accounts in this corpus, and "we hold none" is
 * the strongest statement the evidence supports.
 */
export type LedgerCoverage =
  /** We hold transactions; the newest is dated `throughDate` (YYYY-MM-DD). */
  | { kind: "OBSERVED"; throughDate: string; ageDays: number }
  /** We looked and hold zero transactions for this account. */
  | { kind: "NONE_ON_FILE" }
  /** Nobody looked — the caller supplied no ledger evidence. We decline to guess. */
  | { kind: "UNKNOWN" };

/** The canonical freshness answer for one account. */
export interface AccountFreshness {
  accountId: string;
  balance: BalanceObservation;
  ledger: LedgerCoverage;
  /**
   * |balance| — carried ONLY so Space-level aggregation can weight staleness by
   * value. Never a financial output of this module.
   */
  absValue: number;
}

/** Everything the authority needs, in provider-neutral terms. */
export interface AccountFreshnessInput {
  accountId: string;
  /** FinancialAccount.lastUpdated — OUR write clock. */
  ingestedAt: string | Date | null | undefined;
  /**
   * FinancialAccount.balanceLastUpdatedAt — the INSTITUTION's clock. Pass null
   * (or omit) when the provider did not supply it; do NOT substitute ingestedAt.
   */
  providerBalanceAt?: string | Date | null;
  /** Newest transaction date held for this account (YYYY-MM-DD or ISO). */
  ledgerThroughDate?: string | Date | null;
  /**
   * True when the caller actually queried this account's transactions. Only then
   * can an absent `ledgerThroughDate` mean NONE_ON_FILE rather than UNKNOWN —
   * an absent date from a caller who never looked is not evidence of anything.
   */
  ledgerQueried?: boolean;
  /** Account balance, any sign. Absolute value is used for weighting only. */
  balance?: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toInstant(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MS_PER_DAY = 86_400_000;

/** Exact fractional day age. Negative when the instant is in the future — kept
 *  negative rather than clamped, so a future-dated observation is visible. */
export function ageInDays(instant: Date, now: Date): number {
  return (now.getTime() - instant.getTime()) / MS_PER_DAY;
}

export function bandForAge(ageDays: number | null): FreshnessBand {
  if (ageDays === null) return "UNKNOWN";
  if (ageDays < LIVE_WITHIN_DAYS) return "LIVE";
  if (ageDays < STALE_AFTER_DAYS) return "RECENT";
  if (ageDays < VERY_STALE_AFTER_DAYS) return "STALE";
  return "VERY_STALE";
}

/** STALE and VERY_STALE both count as stale; UNKNOWN deliberately does not —
 *  unknown is its own disclosure and must never be laundered into a band. */
export function isStaleBand(band: FreshnessBand): boolean {
  return band === "STALE" || band === "VERY_STALE";
}

// ── The authority ─────────────────────────────────────────────────────────────

/**
 * Resolve one account's freshness. `now` is required — see the header note.
 *
 * Resolution of the reported instant:
 *   1. provider attestation, when supplied and not contradicted;
 *   2. our ingestion instant, reported as INGESTION;
 *   3. nothing — UNOBSERVED, and `ageDays` stays null. An unknown age is never
 *      rendered as a large age or a zero age.
 */
export function resolveAccountFreshness(
  input: AccountFreshnessInput,
  now: Date,
): AccountFreshness {
  const ingested = toInstant(input.ingestedAt);
  const attested = toInstant(input.providerBalanceAt);

  // The two clocks disagree when the institution claims to have computed the
  // balance meaningfully after we fetched it. Report the older instant.
  const contradictory =
    ingested !== null &&
    attested !== null &&
    attested.getTime() - ingested.getTime() >
      PROVIDER_CLOCK_SKEW_TOLERANCE_MINUTES * 60_000;

  let observed: Date | null;
  let basis: FreshnessBasis;
  if (attested !== null && !contradictory) {
    observed = attested;
    basis = "PROVIDER_ATTESTED";
  } else if (attested !== null && ingested !== null) {
    // Contradiction: the older of the two, never the flattering one.
    observed = attested.getTime() < ingested.getTime() ? attested : ingested;
    basis = observed === attested ? "PROVIDER_ATTESTED" : "INGESTION";
  } else if (ingested !== null) {
    observed = ingested;
    basis = "INGESTION";
  } else {
    observed = null;
    basis = "UNOBSERVED";
  }

  const ageDays = observed === null ? null : ageInDays(observed, now);

  const balance: BalanceObservation = {
    observedAt: observed === null ? null : observed.toISOString(),
    basis,
    ageDays,
    band: bandForAge(ageDays),
    providerClockUnknown: attested === null,
    ingestedAt: ingested === null ? null : ingested.toISOString(),
    providerAttestedAt: attested === null ? null : attested.toISOString(),
    contradictory,
  };

  return {
    accountId: input.accountId,
    balance,
    ledger: resolveLedgerCoverage(input, now),
    absValue: Math.abs(input.balance ?? 0),
  };
}

function resolveLedgerCoverage(input: AccountFreshnessInput, now: Date): LedgerCoverage {
  const through = toInstant(input.ledgerThroughDate);
  if (through !== null) {
    return {
      kind: "OBSERVED",
      throughDate: through.toISOString().slice(0, 10),
      ageDays: ageInDays(through, now),
    };
  }
  // No newest-transaction date. Only the caller knows whether that means "we hold
  // nothing for this account" or "we did not look" — we never infer it.
  if (input.ledgerQueried === true) return { kind: "NONE_ON_FILE" };
  return { kind: "UNKNOWN" };
}

/**
 * The honest primary label for a balance observation. The relative time itself is
 * NOT rendered here — `formatRelativeTime` is client-local and unsafe during SSR,
 * so surfaces append it from `observedAt`. This keeps the wording (the part that
 * makes the claim) in the pure authority and the formatting at the edge.
 */
export function balanceClaimLabel(basis: FreshnessBasis): string {
  switch (basis) {
    // The institution attested when it computed the number, so "as of" is earned.
    case "PROVIDER_ATTESTED": return "Balances as of";
    // We know only when we asked. "As of" would claim the institution's clock.
    case "INGESTION":         return "Last checked";
    case "UNOBSERVED":        return "Freshness unknown";
  }
}

/** Row-level version of the above — singular, for one account's balance. */
export function accountBalanceClaimLabel(basis: FreshnessBasis): string {
  switch (basis) {
    case "PROVIDER_ATTESTED": return "Balance as of";
    case "INGESTION":         return "Balance checked";
    case "UNOBSERVED":        return "Balance freshness";
  }
}

/**
 * The sentence that stops a reader mistaking our fetch clock for the
 * institution's. Null when there is nothing to caveat.
 */
export function balanceBasisCaveat(o: BalanceObservation): string | null {
  if (o.basis === "UNOBSERVED") {
    return "No timestamp evidence for this balance.";
  }
  if (o.contradictory) {
    return "The institution's timestamp is later than our fetch — the two disagree, so the older is shown.";
  }
  if (o.providerClockUnknown) {
    return "This is when Fourth Meridian fetched the balance. The institution does not report when it computed the figure, so the balance may be older.";
  }
  return null;
}

/** Human phrasing for ledger reach. Never worded as staleness. */
export function describeLedgerCoverage(l: LedgerCoverage): string {
  switch (l.kind) {
    case "OBSERVED":     return `Transactions through ${l.throughDate}`;
    case "NONE_ON_FILE": return "No transactions on file";
    case "UNKNOWN":      return "Transaction coverage not evaluated";
  }
}
