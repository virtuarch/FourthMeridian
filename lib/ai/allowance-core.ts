/**
 * lib/ai/allowance-core.ts  (BETA C7 — the per-customer daily AI allowance, pure)
 *
 * WHAT A CUSTOMER MAY STILL SPEND TODAY, AND WHY NOT. The `aiDailyUsdAllowance`
 * entitlement (catalogue: BETA $5, FOUNDER overlay $20, ceiling $20, whole USD)
 * is an estimated-dollar bound on the model calls a customer may cause per UTC
 * day across Conversations and the Daily Brief. This module holds the two pure
 * halves: the fold of today's ledger rows into a spent figure, and the verdict.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 * An invocation on a model with no rate in force CANNOT be priced, so the
 * customer's spend today is UNKNOWN — and an unknown spend is not "under the
 * allowance". The verdict refuses with `UNPRICED_MODEL` whenever any of today's
 * invocations is unpriced, whatever the priced part sums to (owner rule,
 * 2026-10-15: an unpriceable model never counts as zero and never bypasses a
 * safeguard). The provider chokepoint refuses such a model before the call,
 * so this branch is the belt to that brace: it covers rows written before a
 * rate was retired, or by a path that bypassed the chokepoint.
 *
 * ── The comparison ──────────────────────────────────────────────────────────
 * Refused when spent ≥ allowance. The NEXT turn is what is being decided and it
 * will cost something, so a customer who has reached the line is over it. An
 * allowance of 0 therefore refuses every turn (the ceiling's floor is a
 * boolean dimension's job, but 0 must still mean 0, never "unlimited").
 *
 * ── AI COST CONTROLS (2026-10-15) ───────────────────────────────────────────
 * Two additions, both pure:
 *   · `enforced` — PlatformSetting `ai_daily_allowance_enforced`. While OFF the
 *     ALLOWANCE_EXHAUSTED refusal is withheld; the UNPRICED_MODEL refusal
 *     stays (pricing validation is not the allowance) and everything is still
 *     recorded. The verdict carries the flag so logs and tests can see it.
 *   · the IN-FLIGHT RESERVATION (`reservedAllowanceVerdict`). The ledger is
 *     written after the provider returns, so N simultaneous turns would each
 *     pass `spent < allowance` on the same stale sum. The loader judges the
 *     decision under a per-customer advisory lock together with the count of
 *     turns admitted but not yet returned, and refuses when
 *         spent + inFlight × RESERVE_USD ≥ allowance.
 *     THE GUARANTEE, STATED HONESTLY: admitted spend ≤ allowance + Σ over the
 *     concurrently admitted turns of (that turn's actual cost − RESERVE_USD).
 *     Overshoot is bounded by one turn's excess over its reserve per
 *     concurrently admitted turn; it is NOT an absolute hard cap, because a
 *     turn's cost is only known after the provider returns.
 *
 * PURE — no I/O, no clock, no database. The loader is lib/ai/allowance.ts.
 */

import { AI_RATES, rateAt, priceAiUsage, type AiRate } from "@/lib/usage/pricing";
import { allowanceExhaustedSentence, allowanceUnavailableSentence, allowanceUnpricedSentence } from "@/lib/ai/conversation/refusal-sentences";
import { fmtMoney } from "@/lib/ai/format";
import { priceSpendGroup, type ModelUsageGroup, type SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";

export const ALLOWANCE_CODE = "AI_ALLOWANCE" as const;

/** One (provider, model) group of the customer's RETURNED customer-surface rows TODAY. */
export type TodaySpendGroup = ModelUsageGroup;

export interface TodaySpend {
  /** Estimated USD over the priced invocations; 0 when nothing was spent. */
  spentUsd: number;
  invocations: number;
  unpricedInvocations: number;
  unpricedModels: string[];
}

/** Pure: today's groups, priced at today's rate. */
export function sumTodaySpend(groups: readonly TodaySpendGroup[], todayISO: string, rates: readonly AiRate[] = AI_RATES): TodaySpend {
  let spentUsd = 0, invocations = 0, unpricedInvocations = 0;
  const unpricedModels = new Set<string>();
  for (const g of groups) {
    invocations += g.invocations;
    const asGroup: SpendGroup = { ...g, surface: null, day: todayISO };
    const priced = priceSpendGroup(asGroup, rates);
    if (priced.unpriced) { unpricedInvocations += g.invocations; unpricedModels.add(`${g.provider}:${g.model}`); continue; }
    if (priced.usd !== null) spentUsd += priced.usd;
  }
  return { spentUsd, invocations, unpricedInvocations, unpricedModels: [...unpricedModels].sort() };
}

/**
 * RESERVATION_UNAVAILABLE (AI RELIABILITY 2026-10-16) — enforcement is ON and the
 * per-customer reservation could not be taken (lock, counter or transaction
 * failed). FAIL CLOSED: the plain stale-sum check has no in-flight count, so N
 * simultaneous turns would all pass it (measured 8/8 at $3.80 of $5). Retryable —
 * 503 with Retry-After; nothing was spent.
 */
/**
 * LEDGER_UNTRUSTED (IDEMP-009 / OBS-005) — the reservation ran under the lock but
 * the ledger it reduces over has been FAILING ITS WRITES (lib/platform/ai/
 * ledger-health.ts): today's spend cannot be trusted to be complete, and an
 * unknown spend is never "under the allowance". FAIL CLOSED, retryable like
 * RESERVATION_UNAVAILABLE (503 + Retry-After): the signal ages out and clears on
 * recovery. Nothing was spent.
 */
export type AllowanceReason = "ALLOWANCE_EXHAUSTED" | "UNPRICED_MODEL" | "RESERVATION_UNAVAILABLE" | "LEDGER_UNTRUSTED";

/** The two transient refusals: retryable, 503, Retry-After. */
export function isRetryableAllowanceReason(reason: AllowanceReason): boolean {
  return reason === "RESERVATION_UNAVAILABLE" || reason === "LEDGER_UNTRUSTED";
}

/** Seconds a client should wait before retrying a RESERVATION_UNAVAILABLE refusal. */
export const RESERVATION_RETRY_AFTER_SECONDS = 15;

/**
 * How the in-flight reservation was judged:
 *   RESERVED     the decision ran under the advisory lock with the in-flight
 *                count, and (when allowed) this turn now holds a reservation;
 *   UNAVAILABLE  the lock/counter could not be taken (no fm_system transaction,
 *                the store errored). With enforcement ON the turn is REFUSED
 *                (RESERVATION_UNAVAILABLE, fail closed); with enforcement
 *                explicitly OFF the plain check decides, as before;
 *   NONE         the pure check with no reservation concept (tests, the legacy
 *                injected-client path).
 */
export type AllowanceReservationState = "RESERVED" | "UNAVAILABLE" | "NONE";

interface VerdictCommon {
  spentUsd: number;
  allowanceUsd: number;
  /** PlatformSetting `ai_daily_allowance_enforced` as judged for THIS decision. */
  enforced: boolean;
  reservation: AllowanceReservationState;
  /** Turns admitted and not yet returned at the moment of the decision (this one excluded). */
  inFlight: number;
}

export type AllowanceVerdict =
  | (VerdictCommon & { allowed: true; remainingUsd: number })
  | (VerdictCommon & { allowed: false; reason: AllowanceReason; unpricedInvocations: number });

/** PURE — the decision (no reservation: `inFlight` 0, `enforced` true unless told otherwise). */
export function dailyAllowanceVerdict(input: { spentUsd: number; allowanceUsd: number; unpricedInvocations: number; enforced?: boolean }): AllowanceVerdict {
  return reservedAllowanceVerdict({ ...input, inFlight: 0, reserveUsd: 0, enforced: input.enforced ?? true, reservation: "NONE" });
}

// ── The reservation ─────────────────────────────────────────────────────────

/**
 * The model every reservation is priced for, and the per-turn shape it reserves.
 *
 * DERIVATION (pinned by lib/ai/allowance.test.ts against the engine and the
 * rate card, so it cannot drift silently):
 *   · the conversation engine runs on `CHAT_MODEL = 'gpt-5.1'`
 *     (lib/ai/conversation/engine.ts) — RESERVE_MODEL mirrors it; the engine
 *     is not imported here because this module must stay pure and light;
 *   · a turn is at most MAX_TOOL_ROUNDTRIPS = 6 answer calls
 *     (lib/ai/conversation/turn.ts) — RESERVE_ANSWER_HOPS — PLUS the guidance
 *     classifier, a second paid call on the same model after every answered
 *     turn (lib/ai/conversation/engine.ts) — RESERVE_GUIDANCE_CALLS. Before
 *     SEC-AI-008 the reserve covered the hops only, so the label was a 7th
 *     unreserved call per turn; RESERVE_INVOCATIONS_PER_TURN is their sum;
 *   · each call carries ~30,000 prompt tokens (the T0 orientation measured
 *     ≈32k tokens after the evidence clip, with tool results growing later
 *     hops while prompt caching shrinks them) and ~1,500 completion tokens
 *     (CLASSIC_COMPLETION_BUDGET; observed reasoning spend on the modern
 *     dialect ≈1,500);
 *   · priced at the rate card's rate for RESERVE_MODEL (the latest rate):
 *     gpt-5.1 input $1.25 / M, output $10 / M ⇒ 30,000 × 1.25 / 1e6 +
 *     1,500 × 10 / 1e6 = $0.0525 per call ⇒ 7 × $0.0525 = $0.3675 per turn.
 * The constant is COMPUTED from the rate card at module load so a rate change
 * moves it; RESERVE_USD_FALLBACK is used only if the card had no rate for the
 * model (never 0 — a zero reserve would silently disable the concurrency bound).
 *
 * ⚠️ NOT SIZED FROM THE TRANSCRIPT (SEC-AI-002, documented rather than done):
 * the routes reserve BEFORE reading the request body (pinned: the allowance is
 * judged before `req.json()` so a refused turn costs no parse and no model
 * work), so the transcript's size is unknown when the reserve is taken. The
 * per-call shape above is the worst case the body limits allow (≤ 160 KB ≈
 * 40k tokens, cached after the first hop); the overshoot bound stated in the
 * reservation module's header is unchanged.
 */
export const RESERVE_MODEL = "gpt-5.1";
export const RESERVE_ANSWER_HOPS = 6;
export const RESERVE_GUIDANCE_CALLS = 1;
export const RESERVE_INVOCATIONS_PER_TURN = RESERVE_ANSWER_HOPS + RESERVE_GUIDANCE_CALLS;
export const RESERVE_PROMPT_TOKENS_PER_INVOCATION = 30_000;
export const RESERVE_COMPLETION_TOKENS_PER_INVOCATION = 1_500;
export const RESERVE_USD_FALLBACK = 0.3675;

/** PURE — the per-turn reserve for a model from a rate card (null when the card cannot price it). */
export function reserveUsdFor(model: string, rates: readonly AiRate[] = AI_RATES): number | null {
  const latest = rateAt("OPENAI", model, "9999-12-31", rates);
  if (!latest) return null;
  const metric = `chat.completions:${model}`;
  const day = latest.effectiveFrom;
  const p = priceAiUsage([
    { provider: "OPENAI", metric, unit: "prompt_tokens",        day, count: RESERVE_PROMPT_TOKENS_PER_INVOCATION * RESERVE_INVOCATIONS_PER_TURN },
    { provider: "OPENAI", metric, unit: "cached_prompt_tokens", day, count: 0 },
    { provider: "OPENAI", metric, unit: "completion_tokens",    day, count: RESERVE_COMPLETION_TOKENS_PER_INVOCATION * RESERVE_INVOCATIONS_PER_TURN },
  ], rates);
  return p.usd !== null && p.usd > 0 ? p.usd : null;
}

/** The reserve one admitted-but-unreturned turn holds against the allowance, in estimated USD. */
export const RESERVE_USD: number = reserveUsdFor(RESERVE_MODEL) ?? RESERVE_USD_FALLBACK;

export interface ReservationDecisionInput {
  spentUsd: number;
  allowanceUsd: number;
  unpricedInvocations: number;
  /** Turns already admitted and not yet returned for this customer. */
  inFlight: number;
  /** The reserve each of those holds (RESERVE_USD; 0 for the no-reservation check). */
  reserveUsd: number;
  enforced: boolean;
  reservation: AllowanceReservationState;
}

/**
 * PURE — the decision WITH the in-flight reservation:
 *   1. an unpriced invocation today refuses first (UNPRICED_MODEL), enforced or not;
 *   2. with enforcement OFF nothing else refuses — the verdict still carries
 *      the spend and the flag, so the refusal that was withheld is visible;
 *   3. otherwise refuse when spent + inFlight × reserve ≥ allowance.
 */
export function reservedAllowanceVerdict(input: ReservationDecisionInput): AllowanceVerdict {
  const spentUsd = Number.isFinite(input.spentUsd) && input.spentUsd > 0 ? input.spentUsd : 0;
  const allowanceUsd = Number.isFinite(input.allowanceUsd) && input.allowanceUsd > 0 ? input.allowanceUsd : 0;
  const unpricedInvocations = Number.isFinite(input.unpricedInvocations) && input.unpricedInvocations > 0 ? Math.floor(input.unpricedInvocations) : 0;
  const inFlight = Number.isFinite(input.inFlight) && input.inFlight > 0 ? Math.floor(input.inFlight) : 0;
  const reserveUsd = Number.isFinite(input.reserveUsd) && input.reserveUsd > 0 ? input.reserveUsd : 0;
  const enforced = input.enforced !== false;
  const common = { spentUsd, allowanceUsd, enforced, reservation: input.reservation, inFlight };
  // Fail closed FIRST: an unknown spend is never "under the allowance" — and this is pricing validation, not the allowance, so it stays when enforcement is off.
  if (unpricedInvocations > 0) return { ...common, allowed: false, reason: "UNPRICED_MODEL", unpricedInvocations };
  const committed = spentUsd + inFlight * reserveUsd;
  if (enforced && committed >= allowanceUsd) return { ...common, allowed: false, reason: "ALLOWANCE_EXHAUSTED", unpricedInvocations: 0 };
  return { ...common, allowed: true, remainingUsd: Math.max(0, allowanceUsd - committed) };
}

/** The customer-readable refusal body — one shape for Conversations and the Daily Brief. */
export interface AllowanceRefusalBody {
  error: string;
  code: typeof ALLOWANCE_CODE;
  reason: AllowanceReason;
  /** Estimated USD, rounded to the cent. */
  spentUsd: number;
  allowanceUsd: number;
  /** RESERVATION_UNAVAILABLE only — the refusal is transient; retry after this many seconds. */
  retryable?: true;
  retryAfterSeconds?: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function allowanceRefusalBody(v: Extract<AllowanceVerdict, { allowed: false }>, surfaceLabel: string): AllowanceRefusalBody {
  if (isRetryableAllowanceReason(v.reason)) {
    return {
      error: allowanceUnavailableSentence(surfaceLabel),
      code: ALLOWANCE_CODE, reason: v.reason, spentUsd: cents(v.spentUsd), allowanceUsd: v.allowanceUsd,
      retryable: true, retryAfterSeconds: RESERVATION_RETRY_AFTER_SECONDS,
    };
  }
  const error = v.reason === "UNPRICED_MODEL"
    ? allowanceUnpricedSentence(surfaceLabel)
    // The allowance is denominated in USD by definition (the rate card is USD);
    // formatted through the currency-aware helper, never a literal symbol (REVIEW-3 C-6).
    : allowanceExhaustedSentence(surfaceLabel, fmtMoney(v.allowanceUsd, "USD"));
  return { error, code: ALLOWANCE_CODE, reason: v.reason, spentUsd: cents(v.spentUsd), allowanceUsd: v.allowanceUsd };
}

/**
 * The HTTP status for a refusal. 429 for an exhausted allowance — time cures it
 * (the UTC day rolls) — and 503 for an unpriced model: the service cannot price
 * what it would run, which only the operator (the rate card) can fix. 503 is
 * also what the Conversations route answers when the provider chokepoint
 * refuses the model itself, so a customer sees ONE status for the one gap.
 */
export function allowanceRefusalStatus(v: Extract<AllowanceVerdict, { allowed: false }>): 429 | 503 {
  return v.reason === "UNPRICED_MODEL" || isRetryableAllowanceReason(v.reason) ? 503 : 429;
}
