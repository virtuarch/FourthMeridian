/**
 * lib/platform/growth/acquisition-types.ts  (Platform Spaces 2.0 — Growth)
 *
 * The DTO GET /api/platform/growth-revenue/acquisition returns: the acquisition,
 * conversion-by-cohort and time-of-week facts the Growth dashboard draws, as a
 * pure projection over the ledgers (lib/platform/growth/acquisition-core.ts).
 * Client-safe (types only). Identity-free: counts and clocks only — no email,
 * user id, name or Space name ever appears.
 *
 * Honesty contract (owner directive, Heatmaps addendum):
 *   - a day/period the source cannot vouch for is `null` / `noData` — never 0;
 *   - a period that has not finished is `immature` — never a low rate;
 *   - every rate travels with its numerator and denominator.
 */

/** One UTC day. `count: null` = outside the source's coverage (not zero). */
export interface AcquisitionDay { day: string; count: number | null }

/** One heat cell with its denominator, or a state that is not a value. */
export type CohortCell =
  | { state: "value"; num: number; den: number }
  | { state: "immature" }
  | { state: "noData" };

export interface CohortRow {
  /** ISO Monday of the registration week (UTC). */
  weekStart: string;
  /** Accounts registered in the week — every cell's denominator. */
  size: number;
  cells: CohortCell[];
}

export type OnboardingStageKey = "verified" | "firstSession" | "firstConnection" | "firstAiTurn" | "firstBriefViewed";

export interface AcquisitionResponse {
  checkedAt: string;
  /** The window the per-day series and time-of-week grids cover. */
  windowDays: 30 | 90;
  /** Inclusive UTC days of the window. */
  from: string;
  to: string;
  coverage: {
    /** First UTC day beta-request submissions are recorded for (source start or retention edge); null = none. */
    requestsFrom: string | null;
    /** First UTC day engagement facts exist for; null = none. */
    engagementFrom: string | null;
    /** First UTC day an AI chat turn is retained for (90-day ledger); null = none. */
    chatFrom: string | null;
  };
  requests: {
    /** Distinct requesting emails per UTC day (a resubmission the same day counts once). */
    perDay: AcquisitionDay[];
    /** Σ perDay over observed days. */
    total: number;
  };
  registrations: { perDay: AcquisitionDay[]; total: number };
  /** The waitlist as it stands now (current state; status is overwritten in place). */
  waitlist: { pending: number; invited: number; invitedExpired: number; redeemed: number; declined: number };
  /** Where requesters in the window came from (first submission's allowlisted source). */
  sources: { label: string; count: number }[];
  /** Requesters in the window whose submission carried no source. */
  sourcesUnrecorded: number;
  /** Weekday (Mon=0) × UTC hour counts over the window. */
  timeOfWeek: {
    signIns: number[][];
    signInTotal: number;
    chatTurns: number[][];
    chatTotal: number;
  };
  /** Registration-week cohorts × week k after registration: engaged in week k ÷ cohort size. */
  retention: { offsets: number; rows: CohortRow[] };
  /** Registration-week cohorts × onboarding stage: got through the stage (strict funnel) ÷ cohort size. */
  onboarding: { stages: { key: OnboardingStageKey; label: string }[]; rows: CohortRow[] };
  /** One-line limits the surface renders beside the charts. */
  notes: string[];
}
