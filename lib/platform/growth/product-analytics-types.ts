/**
 * lib/platform/growth/product-analytics-types.ts  (BETA A1–A8 — the FROZEN DTO contract)
 *
 * The one shape GET /api/platform/growth-revenue/product-analytics returns.
 * Workstream W3 implements the reader and route; Workstream W4 renders it.
 * Client-safe (types only). Every figure is a projection over the ledgers;
 * nothing here is stored. Identity-minimised: no user ids, names, emails or
 * Space names ever appear — per-user tables live in Customer Success.
 *
 * Three strata, always kept apart on every surface:
 *   registration — an account exists (User rows)
 *   presence     — an authenticated session touched the day (SESSION_ACTIVE_DAY)
 *   engagement   — meaningful product activity (product events, chat/brief
 *                  invocations with a userId, connection actions). Never cron,
 *                  webhooks, operator actions or harness invocations.
 */

/** A count with a three-state rate: number | null (no denominator) | undefined (not measured). */
export interface RatedCount { count: number; rate?: number | null; }

export interface ActiveUsers {
  /** Distinct users with a SESSION_ACTIVE_DAY in the window. */
  present: number;
  /** Distinct users with ≥1 engagement fact in the window. */
  engaged: number;
  /** Distinct users with a credential sign-in (AuditLog LOGIN) in the window — NOT an activity metric. */
  signIns: number;
}

export interface RetentionCohort {
  /** ISO Monday of the first-visit week. */
  weekStart: string;
  /** Users whose first visit falls in the week. */
  cohortSize: number;
  /** Share engaged on first-visit day + 1; null when no denominator; undefined when the cohort is too young. */
  d1?: number | null;
  /** Share engaged at least once in days 1–7 after first visit (window form, primary). */
  d7Window?: number | null;
  /** Share engaged on day 7 exactly (strict form, reported beside). */
  d7Strict?: number | null;
}

export interface FunnelStage {
  key: "registered" | "verified" | "firstSession" | "firstConnection" | "firstAiTurn" | "firstBriefViewed" | "returned";
  label: string;
  count: number;
  /** Conversion from the previous stage; three-state. */
  rate?: number | null;
  /** Users who reached this stage but not the next within the abandonment horizon (days). */
  abandoned?: number;
}

export interface FeatureAdoption {
  key: "aiChat" | "dailyBrief" | "personalSpaces" | "transactions" | "connections" | "manualAssets" | "exports";
  label: string;
  /** Distinct users with ≥1 use in the window. */
  adopters: number;
  /** adopters ÷ registered (not ÷ engaged); three-state. */
  adoption?: number | null;
  /** Uses per engaged user per week in the window; three-state. */
  frequencyPerEngagedUserPerWeek?: number | null;
  /** Where the figure comes from (ledger/event names) — rendered in Technical details. */
  basis: string;
}

export interface CostPerEngagedUser {
  /** Estimated USD, AI customer surfaces (chat + brief) over the window; null when unpriced. */
  aiUsd: number | null;
  /** Estimated USD, Plaid Item-months for the current billing cycle; null when unpriced. */
  plaidUsd: number | null;
  /** The denominator: engaged users over the window. */
  engagedUsers: number;
  /** (aiUsd + plaidUsd) ÷ engagedUsers; null when either side is null or the denominator is 0. */
  perEngagedUserUsd: number | null;
  tier: "ESTIMATED";
  notes: string[];
}

export interface ProductAnalyticsResponse {
  /** ISO instant the projection was computed. */
  checkedAt: string;
  windowDays: 30;
  registrations: { total: number; deactivated: number; last7d: number; last30d: number; perDay: Array<{ day: string; count: number }> };
  active: { daily: ActiveUsers; weekly: ActiveUsers; monthly: ActiveUsers; perDay: Array<{ day: string; present: number; engaged: number }> };
  retention: { returningEver: RatedCount; cohorts: RetentionCohort[]; abandonmentHorizonDays: 7 };
  funnel: FunnelStage[];
  features: FeatureAdoption[];
  cost: CostPerEngagedUser;
  /** What this projection deliberately excludes — rendered as the surface footnote. */
  exclusions: string[];
}
