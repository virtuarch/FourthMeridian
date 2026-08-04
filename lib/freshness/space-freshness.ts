/**
 * lib/freshness/space-freshness.ts   (V27-L1 — FRESHNESS TRUTH)
 *
 * THE Space-level freshness presentation. Pure. The clock enters exactly once, as
 * the required `now` on resolveSpaceFreshness.
 *
 * ── What this replaces, and why not simply MIN ───────────────────────────────
 *
 * The Space header reduced with a MAX:
 *
 *     accounts.reduce((best, a) => a.lastUpdated > best ? a.lastUpdated : best, …)
 *
 * which is the single most optimistic claim the data permits. Measured on the
 * live corpus (2026-08-04): newest account observation 16 hours old, oldest 56
 * days old, 24 of 35 accounts past 7 days, and **96.4% of $974,231 sitting behind
 * a stale balance** — under a header reading "Updated 16 hr ago".
 *
 * MIN is honest but, alone, it is a different lie by omission. A Space where 34
 * accounts were refreshed this morning and one dormant manual asset was last
 * touched a year ago would read "Updated 1 year ago", and the user would discount
 * 34 current balances. Freshness is a DISTRIBUTION, and a single scalar cannot
 * carry it.
 *
 * So the presentation is: **anchor on the oldest observation, then disclose the
 * distribution that the anchor alone hides.**
 *
 *     anchor       the OLDEST observation — the claim can never overstate
 *     qualifier    what the anchor hides: how many accounts are stale, how much
 *                  VALUE sits behind them, how wide the spread is, how many
 *                  accounts have no freshness evidence at all
 *     claim        UNIFORM / PARTIAL / STALE / UNKNOWN — lets a surface decide
 *                  how loudly to disclose without re-deriving thresholds
 *
 * Value weighting is the part that matters most: 24 stale accounts out of 35 is a
 * countable annoyance, but 96.4% of the money is the actual finding. A count-only
 * qualifier would have understated the live corpus by an order of magnitude.
 */

import {
  type AccountFreshness,
  type AccountFreshnessInput,
  type FreshnessBand,
  type FreshnessBasis,
  isStaleBand,
  resolveAccountFreshness,
  STALE_AFTER_DAYS,
} from "./observation";

/** How loudly a surface should disclose. */
export type SpaceFreshnessClaim =
  /** One age honestly describes every account: no stale value, no spread, no unknowns. */
  | "UNIFORM"
  /** A real spread, or accounts with no freshness evidence — disclose it. */
  | "PARTIAL"
  /** At least one account is past the stale cut. Value share rides in the qualifier. */
  | "STALE"
  /** Nothing observable — never rendered as an age. */
  | "UNKNOWN";

/**
 * An account holding at least this share of the Space's total |value| is
 * "material": its staleness cannot be dismissed as rounding. Used only to name
 * `oldestMaterial`; the anchor is the global oldest regardless, so materiality
 * can never soften the headline claim.
 */
export const MATERIAL_VALUE_SHARE = 0.01;

/** Below this share, the stale-value clause is noise and is omitted. */
const STALE_VALUE_DISCLOSURE_FLOOR = 0.005;

/** Spread below this reads as "the same moment" and is not called out. */
const SPREAD_DISCLOSURE_FLOOR_DAYS = 1;

export interface SpaceFreshness {
  accountCount: number;
  /** Accounts with any balance observation at all. */
  observedCount: number;
  /** Accounts with NO freshness evidence. Never folded into an age. */
  unknownCount: number;

  /**
   * THE claim. Always the OLDEST observation across the Space — a header rendered
   * from this can never be newer than its stalest input.
   */
  anchor: {
    accountId: string | null;
    observedAt: string | null;
    ageDays: number | null;
    /**
     * PROVIDER_ATTESTED only when EVERY observed account is provider-attested.
     * A single ingestion-only account degrades the whole claim — an aggregate
     * cannot be more certain than its weakest member.
     */
    basis: FreshnessBasis;
    band: FreshnessBand;
  };

  /** The newest observation — reported as a fact, never as the claim. */
  newestObservedAt: string | null;
  /** Newest minus oldest, in days. Null when fewer than two observations. */
  spreadDays: number | null;

  bandCounts: Record<FreshnessBand, number>;
  basisCounts: Record<FreshnessBasis, number>;

  /** Σ|balance| across all accounts. */
  totalValue: number;
  /** Σ|balance| behind observations past the stale cut (and behind unknowns). */
  staleValue: number;
  /** staleValue / totalValue, or null when totalValue is 0. */
  staleValueShare: number | null;
  staleAccountCount: number;

  /**
   * The oldest observation among accounts holding a material share of value.
   * Exists so a surface can say "the money that matters was last seen N days ago"
   * without the anchor being dragged by a $0 dormant row.
   */
  oldestMaterial: {
    accountId: string;
    observedAt: string | null;
    ageDays: number | null;
  } | null;

  claim: SpaceFreshnessClaim;
  /** Primary wording, e.g. "Last checked" — append the relative time at the edge. */
  label: string;
  /** What the anchor hides, or null when it hides nothing. Deterministic. */
  qualifier: string | null;

  /** The per-account answers, so any surface can drill from the aggregate. */
  accounts: AccountFreshness[];
}

const EMPTY_BANDS = (): Record<FreshnessBand, number> => ({
  LIVE: 0, RECENT: 0, STALE: 0, VERY_STALE: 0, UNKNOWN: 0,
});
const EMPTY_BASES = (): Record<FreshnessBasis, number> => ({
  PROVIDER_ATTESTED: 0, INGESTION: 0, UNOBSERVED: 0,
});

/**
 * Summarize a Space's freshness from already-resolved per-account answers.
 *
 * Deliberately takes NO clock: every age it reports was already resolved against
 * the clock passed to resolveAccountFreshness, and accepting a second one here
 * would let a caller age the summary against a different instant than its
 * members. The clock enters this module exactly once, at resolveSpaceFreshness.
 */
export function summarizeSpaceFreshness(
  accounts: AccountFreshness[],
): SpaceFreshness {
  const bandCounts = EMPTY_BANDS();
  const basisCounts = EMPTY_BASES();

  let totalValue = 0;
  let staleValue = 0;
  let staleAccountCount = 0;
  let unknownCount = 0;

  let oldest: AccountFreshness | null = null;
  let newest: AccountFreshness | null = null;

  for (const a of accounts) {
    bandCounts[a.balance.band]++;
    basisCounts[a.balance.basis]++;
    totalValue += a.absValue;

    if (a.balance.observedAt === null) {
      unknownCount++;
      // Value behind an UNOBSERVED balance is not defensible either — it counts
      // as unverified value, which is what the stale-value clause is for.
      staleValue += a.absValue;
      continue;
    }
    if (isStaleBand(a.balance.band)) {
      staleAccountCount++;
      staleValue += a.absValue;
    }
    if (oldest === null || a.balance.observedAt < oldest.balance.observedAt!) oldest = a;
    if (newest === null || a.balance.observedAt > newest.balance.observedAt!) newest = a;
  }

  const observedCount = accounts.length - unknownCount;

  // Aggregate basis: the WEAKEST among observed accounts. An aggregate is never
  // more certain than its least-attested member.
  const aggregateBasis: FreshnessBasis =
    observedCount === 0
      ? "UNOBSERVED"
      : basisCounts.INGESTION > 0
        ? "INGESTION"
        : "PROVIDER_ATTESTED";

  const spreadDays =
    oldest && newest && oldest !== newest
      ? (new Date(newest.balance.observedAt!).getTime() -
         new Date(oldest.balance.observedAt!).getTime()) / 86_400_000
      : accounts.length > 0 && observedCount > 0 ? 0 : null;

  const staleValueShare = totalValue > 0 ? staleValue / totalValue : null;

  // Materiality is measured against total value, so a Space of tiny balances has
  // no "immaterial" rows to hide behind.
  const materialFloor = totalValue * MATERIAL_VALUE_SHARE;
  let oldestMaterial: SpaceFreshness["oldestMaterial"] = null;
  for (const a of accounts) {
    if (a.absValue < materialFloor) continue;
    if (a.balance.observedAt === null) {
      // Material value with NO freshness evidence outranks any dated row: it is
      // the least defensible thing in the Space.
      oldestMaterial = { accountId: a.accountId, observedAt: null, ageDays: null };
      break;
    }
    if (
      oldestMaterial === null ||
      (oldestMaterial.observedAt !== null && a.balance.observedAt < oldestMaterial.observedAt)
    ) {
      oldestMaterial = {
        accountId: a.accountId,
        observedAt: a.balance.observedAt,
        ageDays: a.balance.ageDays,
      };
    }
  }

  const claim: SpaceFreshnessClaim =
    accounts.length === 0 || observedCount === 0
      ? "UNKNOWN"
      : staleAccountCount > 0 || unknownCount > 0
        ? (staleAccountCount > 0 ? "STALE" : "PARTIAL")
        : (spreadDays !== null && spreadDays >= SPREAD_DISCLOSURE_FLOOR_DAYS)
          ? "PARTIAL"
          : "UNIFORM";

  return {
    accountCount: accounts.length,
    observedCount,
    unknownCount,
    anchor: {
      accountId: oldest?.accountId ?? null,
      observedAt: oldest?.balance.observedAt ?? null,
      ageDays: oldest?.balance.ageDays ?? null,
      basis: aggregateBasis,
      band: oldest?.balance.band ?? "UNKNOWN",
    },
    newestObservedAt: newest?.balance.observedAt ?? null,
    spreadDays,
    bandCounts,
    basisCounts,
    totalValue,
    staleValue,
    staleValueShare,
    staleAccountCount,
    oldestMaterial,
    claim,
    label: spaceClaimLabel(aggregateBasis),
    qualifier: buildQualifier({
      accountCount: accounts.length,
      staleAccountCount,
      unknownCount,
      staleValueShare,
      spreadDays,
      claim,
    }),
    accounts,
  };
}

/** Convenience: resolve + summarize in one pass. `now` required. */
export function resolveSpaceFreshness(
  inputs: AccountFreshnessInput[],
  now: Date,
): SpaceFreshness {
  return summarizeSpaceFreshness(inputs.map((i) => resolveAccountFreshness(i, now)));
}

/**
 * Wording for the aggregate claim. Mirrors balanceClaimLabel but is phrased for a
 * set of accounts — "Balances as of" only when every one of them is attested.
 */
function spaceClaimLabel(basis: FreshnessBasis): string {
  switch (basis) {
    case "PROVIDER_ATTESTED": return "Balances as of";
    case "INGESTION":         return "Last checked";
    case "UNOBSERVED":        return "Freshness unknown";
  }
}

function buildQualifier(a: {
  accountCount: number;
  staleAccountCount: number;
  unknownCount: number;
  staleValueShare: number | null;
  spreadDays: number | null;
  claim: SpaceFreshnessClaim;
}): string | null {
  if (a.claim === "UNIFORM") return null;
  if (a.claim === "UNKNOWN") {
    return a.accountCount > 0
      ? `${a.accountCount} account${a.accountCount === 1 ? "" : "s"} with no freshness evidence`
      : null;
  }

  const parts: string[] = [];

  if (a.staleAccountCount > 0) {
    parts.push(
      `${a.staleAccountCount} of ${a.accountCount} account${a.accountCount === 1 ? "" : "s"} older than ${STALE_AFTER_DAYS} days`,
    );
  }
  if (a.unknownCount > 0) {
    parts.push(
      `${a.unknownCount} with no freshness evidence`,
    );
  }
  // The value clause is the finding. Rounded to a whole percent — a decimal
  // implies a precision the underlying balances do not have.
  if (a.staleValueShare !== null && a.staleValueShare >= STALE_VALUE_DISCLOSURE_FLOOR) {
    parts.push(`${Math.round(a.staleValueShare * 100)}% of value unverified`);
  }
  if (
    parts.length === 0 &&
    a.spreadDays !== null &&
    a.spreadDays >= SPREAD_DISCLOSURE_FLOOR_DAYS
  ) {
    const d = Math.round(a.spreadDays);
    parts.push(`observations span ${d} day${d === 1 ? "" : "s"}`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}
