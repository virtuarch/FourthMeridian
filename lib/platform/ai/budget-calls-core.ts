/**
 * lib/platform/ai/budget-calls-core.ts  (AI & Costs — the 24 h budget KPI's records)
 *
 * PURE half of the per-call drilldown behind the "Budget used" KPI and the
 * Budget utilisation card: the query parser, the page shape, and per-call
 * pricing. The loader (budget-calls.ts) reads the SAME grouped query and the
 * SAME fold the KPI reads (readUserSpendGroups → buildFleetWindow →
 * fleetSpendStatus), so the drilldown's summary IS the KPI; the rows are the
 * calls that fold counted, listed one by one.
 *
 * POPULATION — customer surfaces (chat, brief) in [since, until]. The fold
 * prices RETURNED rows only; failure facts (FAILED / TIMEOUT / RATE_LIMITED /
 * QUOTA) carry zero tokens and are listed with their outcome as "not counted",
 * never $0. An unpriced RETURNED call is "unpriced", never $0.
 *
 * IDENTITY — Platform Ops is identity-free: a row carries the opaque customer
 * reference (`user …abc123`, opaqueUserRef) or null, never an email, name or
 * full id. No prompt, message, conversation id or request id is selected.
 */

import { CUSTOMER_SURFACES, priceSpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import type { FleetSpendStatus } from "@/lib/platform/ai/fleet-spend-status";

export const BUDGET_CALLS_PAGE_SIZE = 25;
export const BUDGET_CALLS_MAX_PAGE = 400;
/** How far back a deep-linked window end may sit (a stale link past this reads "now"). */
export const BUDGET_CALLS_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Clock skew tolerated on a window end from the client. */
const FUTURE_SKEW_MS = 60 * 1000;

/** The surfaces the fleet fold counts — the drilldown lists exactly these. */
export const BUDGET_CALL_SURFACES = CUSTOMER_SURFACES;

/** One AiInvocation row as the list query selects it (no identity beyond the soft userId, reduced below). */
export interface BudgetCallSource {
  id: string;
  occurredAt: Date;
  provider: string;
  model: string;
  surface: string | null;
  outcome: string;
  errorCode: string | null;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  userId: string | null;
}

/** What a row's cost cell says. Never a $0 for anything but a priced call. */
export type BudgetCallPricing = "PRICED" | "UNPRICED" | "NO_TOKENS" | "NOT_COUNTED";

export interface BudgetCallRow {
  id: string;
  occurredAt: string;
  surface: string;
  provider: string;
  model: string;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  /** "RETURNED" | "FAILED" | "TIMEOUT" | "RATE_LIMITED" | "QUOTA" … */
  outcome: string;
  /** A provider error CODE for a failure fact, never a message. */
  errorCode: string | null;
  /** Opaque customer reference, or null when the call carried no user. */
  customerRef: string | null;
  pricing: BudgetCallPricing;
  /** Estimated USD — set only when pricing is PRICED. */
  costUsd: number | null;
}

export interface BudgetCallsQuery {
  /** Window end (ms). The window is [until − hours, until]. */
  untilMs: number;
  page: number;
}

export interface BudgetCallsResponse {
  window: { since: string; until: string; hours: number };
  /** THE KPI's status over this exact window (the same fold). */
  summary: FleetSpendStatus & { customers: number };
  page: { rows: BudgetCallRow[]; total: number; page: number; pageSize: number };
  /** Calls in the window by what the fold did with them. returned === summary.invocations. */
  counts: { returned: number; notCounted: number };
  estimateNote: string;
}

/**
 * Parse `until` (ISO instant or epoch ms) and `page`. An absent, malformed,
 * future or too-old `until` falls back to `nowMs` (never an error page — a
 * stale deep link opens the current window); a bad page is page 1.
 */
export function parseBudgetCallsQuery(params: URLSearchParams, nowMs: number): BudgetCallsQuery {
  const raw = params.get("until");
  let untilMs = nowMs;
  if (raw) {
    const t = /^\d{10,14}$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (Number.isFinite(t) && t <= nowMs + FUTURE_SKEW_MS && t >= nowMs - BUDGET_CALLS_MAX_LOOKBACK_MS) untilMs = Math.min(t, nowMs);
  }
  const p = Number(params.get("page") ?? "1");
  const page = Number.isInteger(p) && p >= 1 && p <= BUDGET_CALLS_MAX_PAGE ? p : 1;
  return { untilMs, page };
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Price ONE call through the fold's own pricer (priceSpendGroup — a group of
 * one, on its UTC day). RETURNED only; a failure fact is NOT_COUNTED.
 */
export function priceCall(r: Pick<BudgetCallSource, "occurredAt" | "provider" | "model" | "surface" | "outcome" | "promptTokens" | "cachedPromptTokens" | "completionTokens">): { pricing: BudgetCallPricing; costUsd: number | null } {
  if (r.outcome !== "RETURNED") return { pricing: "NOT_COUNTED", costUsd: null };
  const priced = priceSpendGroup({
    provider: r.provider, model: r.model, surface: r.surface, day: dayOf(r.occurredAt), invocations: 1,
    promptTokens: r.promptTokens, cachedPromptTokens: r.cachedPromptTokens, completionTokens: r.completionTokens,
  });
  if (priced.unpriced) return { pricing: "UNPRICED", costUsd: null };
  if (priced.usd === null) return { pricing: "NO_TOKENS", costUsd: null };
  return { pricing: "PRICED", costUsd: priced.usd };
}

/** Project a source row: opaque ref through the injected reducer, the cost through priceCall. */
export function projectCall(r: BudgetCallSource, refOf: (userId: string) => string): BudgetCallRow {
  const { pricing, costUsd } = priceCall(r);
  return {
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    surface: r.surface ?? "other",
    provider: r.provider,
    model: r.model,
    promptTokens: r.promptTokens,
    cachedPromptTokens: r.cachedPromptTokens,
    completionTokens: r.completionTokens,
    outcome: r.outcome,
    errorCode: r.outcome === "RETURNED" ? null : r.errorCode,
    customerRef: r.userId ? refOf(r.userId) : null,
    pricing,
    costUsd,
  };
}
