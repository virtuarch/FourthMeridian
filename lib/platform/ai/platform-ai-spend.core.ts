/**
 * lib/platform/ai/platform-ai-spend.core.ts  (Platform AI P2b — the daily $ caps, the PURE rules; design v2 §10, I-10)
 *
 * Two estimated-dollar caps per UTC day, ON TOP of the per-operator turn cap
 * (PLATFORM_AI_DAILY_TURNS), the kill switch and the global cost freeze:
 *
 *   OPERATOR   one operator's Platform AI spend today      ≤ PLATFORM_AI_DAILY_USD_CAP_PER_OPERATOR
 *   PLATFORM   every operator's Platform AI spend today    ≤ PLATFORM_AI_DAILY_USD_CAP_PLATFORM
 *
 * This module holds the three pure halves; the fm_system read + reservation is
 * lib/platform/ai/platform-ai-spend.ts.
 *
 * ── 1. Cap resolution — FAIL CLOSED IN CODE (S2 APPROVAL ruling 8) ─────────
 * Each cap is read from its env var (lib/env.ts platformAiSpendCapInputs):
 *   · set and strict-valid (whole dollars or cents, `^(0|[1-9]\d{0,5})(\.\d{1,2})?$`) ⇒ that value;
 *   · set and anything else (" 5", "5.", "1e3", "-1", "$5", "five")      ⇒ INVALID ⇒ REFUSE, every env;
 *   · MISSING (unset or "") and VERCEL_ENV === "preview" | "development"   ⇒ the TEST default below;
 *   · MISSING and VERCEL_ENV === "production", absent, or any other value  ⇒ REFUSE (like INVALID).
 * The raw VERCEL_ENV is the authority — NOT deploymentEnvironment(), which maps
 * an absent VERCEL_ENV to "development": an environment that cannot say what it
 * is gets no default. "0" is valid and means 0 (every turn refused), never "unlimited".
 *
 * ⚠️ THE DEFAULTS ARE TEST VALUES, NOT OWNER NUMBERS. The cap numbers are an
 * owner spending decision (OI-2); they must be set as env vars before any
 * Production activation. Production never falls back to these.
 *
 * ── 2. The spend — ESTIMATED from the ledger ────────────────────────────────
 * AiInvocation has no cost column: spend = today's RETURNED `platform_ai` rows,
 * grouped by (provider, model) and priced by THE rate card (allowance-core
 * sumTodaySpend → priceAiUsage). Any unpriced row ⇒ the spend is unknown ⇒ REFUSE.
 *
 * ── 3. The reservation — worst case of ONE turn ─────────────────────────────
 * The ledger is written after the provider returns, so a turn is judged with
 * every turn admitted-but-not-returned at PLATFORM_AI_RESERVE_TOKENS priced at
 * the model's HIGHER per-token rate (input or output), and THIS turn's own
 * reserve included:
 *     spent + (inFlight + 1) × reserve > cap  ⇒  COST_CAP
 * so the caps hold as long as each admitted turn costs no more than its reserve.
 * PLATFORM_AI_RESERVE_TOKENS = 2 × the turn token ceiling + one reasoning
 * completion: the ceiling is checked AFTER each round, so the round that crosses
 * it can carry at most the transcript so far (< the ceiling) plus its own
 * completion. Tool results added in that last round are not separately counted;
 * pricing every token at the output rate (≈ 4–8× the input rate) covers them in
 * practice. Stated, not hidden: like the customer allowance, this is an
 * ESTIMATE bound, not an invoice-exact hard cap.
 *
 * PURE — no I/O, no clock, no env read.
 */

import { AI_RATES, rateAt, type AiRate } from "@/lib/usage/pricing";
import { sumTodaySpend, type TodaySpendGroup } from "@/lib/ai/allowance-core";
import { PLATFORM_AI_COMPLETION_TOKENS_REASONING, PLATFORM_AI_TURN_TOKEN_CEILING } from "@/lib/platform/intelligence/ai/core";

// ── 1. Cap resolution ──────────────────────────────────────────────────────

/** The env var names (lib/env.ts reads them; .env.example documents them). */
export const PLATFORM_AI_OPERATOR_CAP_ENV = "PLATFORM_AI_DAILY_USD_CAP_PER_OPERATOR";
export const PLATFORM_AI_PLATFORM_CAP_ENV = "PLATFORM_AI_DAILY_USD_CAP_PLATFORM";

/**
 * TEST VALUES for a MISSING cap on Preview / development ONLY (never Production, never
 * an unknown environment). Not owner numbers (OI-2). Sized so a few turns on the most
 * expensive priced model (see platformAiReserveUsd) fit, so Preview acceptance can run.
 */
export const PLATFORM_AI_SPEND_TEST_DEFAULTS = Object.freeze({ operatorUsd: 10, platformUsd: 50 });

/** The environments where a MISSING cap may use the test default. Everything else refuses. */
export const PLATFORM_AI_SPEND_DEFAULT_ENVS: readonly string[] = ["preview", "development"];

const CAP_SHAPE = /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/;

export type CapSource = "ENV" | "TEST_DEFAULT";
export type CapRefusalCause = "CAP_INVALID" | "CAP_MISSING";

export type ResolvedCaps =
  | { state: "OK"; operatorUsd: number; platformUsd: number; source: { operator: CapSource; platform: CapSource } }
  | { state: "REFUSE"; cause: CapRefusalCause; cap: "OPERATOR" | "PLATFORM" };

export interface CapInputs {
  operatorRaw: string | undefined;
  platformRaw: string | undefined;
  /** process.env.VERCEL_ENV, raw (undefined when absent). */
  vercelEnv: string | undefined;
}

type OneCap = { ok: true; usd: number; source: CapSource } | { ok: false; cause: CapRefusalCause };

/** PURE — one cap from its raw env value. */
export function resolveOneCap(raw: string | undefined, vercelEnv: string | undefined, testDefault: number): OneCap {
  if (raw === undefined || raw === "") {
    return typeof vercelEnv === "string" && PLATFORM_AI_SPEND_DEFAULT_ENVS.includes(vercelEnv)
      ? { ok: true, usd: testDefault, source: "TEST_DEFAULT" }
      : { ok: false, cause: "CAP_MISSING" };
  }
  if (!CAP_SHAPE.test(raw)) return { ok: false, cause: "CAP_INVALID" };
  const usd = Number(raw);
  return Number.isFinite(usd) && usd >= 0 ? { ok: true, usd, source: "ENV" } : { ok: false, cause: "CAP_INVALID" };
}

/** PURE — both caps. INVALID is reported before MISSING; the operator cap before the platform cap. */
export function resolvePlatformAiSpendCaps(input: CapInputs): ResolvedCaps {
  const op = resolveOneCap(input.operatorRaw, input.vercelEnv, PLATFORM_AI_SPEND_TEST_DEFAULTS.operatorUsd);
  const pl = resolveOneCap(input.platformRaw, input.vercelEnv, PLATFORM_AI_SPEND_TEST_DEFAULTS.platformUsd);
  if (!op.ok && op.cause === "CAP_INVALID") return { state: "REFUSE", cause: "CAP_INVALID", cap: "OPERATOR" };
  if (!pl.ok && pl.cause === "CAP_INVALID") return { state: "REFUSE", cause: "CAP_INVALID", cap: "PLATFORM" };
  if (!op.ok) return { state: "REFUSE", cause: op.cause, cap: "OPERATOR" };
  if (!pl.ok) return { state: "REFUSE", cause: pl.cause, cap: "PLATFORM" };
  return { state: "OK", operatorUsd: op.usd, platformUsd: pl.usd, source: { operator: op.source, platform: pl.source } };
}

// ── 3. The reserve ─────────────────────────────────────────────────────────

/** Tokens one admitted turn is reserved at (derivation in the header §3). */
export const PLATFORM_AI_RESERVE_TOKENS = 2 * PLATFORM_AI_TURN_TOKEN_CEILING + PLATFORM_AI_COMPLETION_TOKENS_REASONING;

/** The provider every Platform AI call is ledgered under (the one chokepoint is OpenAI's). */
export const PLATFORM_AI_RESERVE_PROVIDER = "OPENAI";

/**
 * PURE — the per-turn reserve in estimated USD for `model` on `todayISO`:
 * PLATFORM_AI_RESERVE_TOKENS × max(input, output) rate. null when the rate card
 * cannot price the model that day (⇒ the caller REFUSES; never a $0 reserve).
 */
export function platformAiReserveUsd(model: string, todayISO: string, rates: readonly AiRate[] = AI_RATES): number | null {
  const rate = rateAt(PLATFORM_AI_RESERVE_PROVIDER, model, todayISO, rates);
  if (!rate) return null;
  const perMillion = Math.max(rate.usdPerMillion.input, rate.usdPerMillion.output);
  const usd = (PLATFORM_AI_RESERVE_TOKENS * perMillion) / 1_000_000;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

// ── 2 + 3. The decision ────────────────────────────────────────────────────

export type SpendUnavailableCause = CapRefusalCause | "UNPRICED" | "LEDGER_UNTRUSTED" | "RESERVATION_UNAVAILABLE";

export type PlatformAiSpendVerdict =
  | { allowed: true; operatorRemainingUsd: number; platformRemainingUsd: number }
  | { allowed: false; detail: "COST_CAP"; scope: "OPERATOR" | "PLATFORM" }
  | { allowed: false; detail: "UNAVAILABLE"; cause: SpendUnavailableCause };

export interface SpendDecisionInput {
  caps: ResolvedCaps;
  /** Today's RETURNED platform_ai groups of THIS operator / of EVERY operator. */
  operatorGroups: readonly TodaySpendGroup[];
  platformGroups: readonly TodaySpendGroup[];
  todayISO: string;
  /** Turns admitted and not yet released (this one excluded). */
  operatorInFlight: number;
  platformInFlight: number;
  /** platformAiReserveUsd(model, todayISO) — null ⇒ unpriced ⇒ refuse. */
  reserveUsd: number | null;
  rates?: readonly AiRate[];
}

const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * PURE — the admission rule, in order:
 *   1. a cap that is INVALID / MISSING-outside-preview/development ⇒ UNAVAILABLE (its cause);
 *   2. the model cannot be priced (no reserve) ⇒ UNAVAILABLE UNPRICED;
 *   3. any unpriced row today (operator or platform) ⇒ UNAVAILABLE UNPRICED;
 *   4. operator: spent + (inFlight + 1) × reserve > cap ⇒ COST_CAP OPERATOR;
 *   5. platform: spent + (inFlight + 1) × reserve > cap ⇒ COST_CAP PLATFORM;
 *   6. admitted.
 */
export function platformAiSpendDecision(input: SpendDecisionInput): PlatformAiSpendVerdict {
  const { caps } = input;
  if (caps.state === "REFUSE") return { allowed: false, detail: "UNAVAILABLE", cause: caps.cause };
  const reserve = input.reserveUsd;
  if (reserve === null || !Number.isFinite(reserve) || reserve <= 0) return { allowed: false, detail: "UNAVAILABLE", cause: "UNPRICED" };
  const rates = input.rates ?? AI_RATES;
  const op = sumTodaySpend(input.operatorGroups, input.todayISO, rates);
  const pl = sumTodaySpend(input.platformGroups, input.todayISO, rates);
  if (op.unpricedInvocations > 0 || pl.unpricedInvocations > 0) return { allowed: false, detail: "UNAVAILABLE", cause: "UNPRICED" };
  const opCommitted = op.spentUsd + (count(input.operatorInFlight) + 1) * reserve;
  const plCommitted = pl.spentUsd + (count(input.platformInFlight) + 1) * reserve;
  if (opCommitted > caps.operatorUsd) return { allowed: false, detail: "COST_CAP", scope: "OPERATOR" };
  if (plCommitted > caps.platformUsd) return { allowed: false, detail: "COST_CAP", scope: "PLATFORM" };
  return { allowed: true, operatorRemainingUsd: caps.operatorUsd - opCommitted, platformRemainingUsd: caps.platformUsd - plCommitted };
}
