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
 * (D5 PR1: resolvePlatformAiCaps, §1b below, adds override / setting sources and code
 * ceilings ahead of env. D5 PR2: the two blanket PlatformSettings are read inside the
 * reservation transaction and fed in; ENV is clamped to the ceilings too (S2 E1); an
 * INVALID env refuses even when a higher source would win (S2 E2).)
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

/** Where a cap's value came from. CEILING = a code ceiling lowered the winning source's value. */
export type CapSource = "OPERATOR_OVERRIDE" | "PLATFORM_SETTING" | "ENV" | "TEST_DEFAULT" | "CEILING";
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

type OneCap = { ok: true; usd: number; source: "ENV" | "TEST_DEFAULT" } | { ok: false; cause: CapRefusalCause };

/** PURE — one cap from its raw env value (unchanged semantics, S2 ruling 8). */
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

// ── 1b. The caps resolver (D5 PR1 + PR2) — one precedence, mirroring lib/entitlements/ai-allowance.ts ──
//
//   OPERATOR cap:  OPERATOR_OVERRIDE > PLATFORM_SETTING > ENV > TEST_DEFAULT (preview/development) > REFUSE
//   PLATFORM cap:                      PLATFORM_SETTING > ENV > TEST_DEFAULT (preview/development) > REFUSE
//
// A setting / override is a candidate only when it is a whole, finite, non-negative
// number. 0 is a candidate and refuses every turn, never "unlimited". ENV keeps its
// strict parse (resolveOneCap).
//
// R2 (S2 ruling 09fp, D5 PR2): a PLATFORM_SETTING that is PRESENT (non-null) but not a
// candidate REFUSES CAP_INVALID: a stored row is intended config, and skipping it could
// silently raise the cap. null = absent = "not set" (the next source applies). Judged
// regardless of the override, like the env rule E2.
// R2 for the OVERRIDE (D5 PR4, S2 09fq): a PRESENT override (a PlatformAiOperatorCap row)
// that is not a candidate refuses CAP_INVALID too (the operator cap). The row reader
// (parseOperatorCapRow, §1d) also treats a value outside 0..PLATFORM_AI_OPERATOR_CAP_CEILING_USD
// as invalid (the table's CHECK bounds), so a corrupt row never reaches the clamp.
//
// E2 (S2 ruling, D5 PR2): ENV is resolved FIRST. An INVALID env value refuses
// CAP_INVALID EVEN WHEN an override or setting would win: a malformed deployment
// variable is a configuration defect we surface, never one a higher source hides.
// A MISSING env stays non-blocking when a higher source exists.
//
// The code CEILING ($20 operator / $100 platform) clamps EVERY source: OPERATOR_OVERRIDE,
// PLATFORM_SETTING, ENV (E1, S2 ruling, D5 PR2) and TEST_DEFAULT (the test defaults sit
// below it: a no-op). A clamped result reports source CEILING with the asked source and
// value kept (askedSource / askedUsd, clamped=true). No cap env var is set on any
// environment today, so the ENV clamp changes nothing in practice.

export const PLATFORM_AI_OPERATOR_CAP_CEILING_USD = 20;
export const PLATFORM_AI_PLATFORM_CAP_CEILING_USD = 100;

export interface PlatformAiCapsInput extends CapInputs {
  /** A per-operator override, whole USD, or null when none is set. */
  operatorOverrideUsd: number | null;
  /** The platform setting for the per-operator cap, whole USD, or null when absent. */
  settingPerOperatorUsd: number | null;
  /** The platform setting for the platform cap, whole USD, or null when absent. */
  settingPlatformUsd: number | null;
}

export interface PlatformAiCapResolution {
  ok: true;
  /** The cap in force, after the ceiling where the ceiling applies. */
  usd: number;
  source: CapSource;
  /** The value the winning source asked for, before the ceiling. */
  askedUsd: number;
  /** The source that won BEFORE the ceiling (equals `source` unless clamped). */
  askedSource: Exclude<CapSource, "CEILING">;
  clamped: boolean;
}

export type PlatformAiCapOutcome = PlatformAiCapResolution | { ok: false; cause: CapRefusalCause };

export interface PlatformAiCapsResolution {
  operator: PlatformAiCapOutcome;
  platform: PlatformAiCapOutcome;
}

/** A whole, finite, non-negative number is a candidate; anything else is skipped. */
export function isCapCandidate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

function clampTo(source: Exclude<CapSource, "CEILING">, askedUsd: number, ceiling: number): PlatformAiCapResolution {
  const usd = Math.min(askedUsd, ceiling);
  const clamped = usd !== askedUsd;
  return { ok: true, usd, source: clamped ? "CEILING" : source, askedUsd, askedSource: source, clamped };
}

function resolveCap(
  ordered: readonly (readonly ["OPERATOR_OVERRIDE" | "PLATFORM_SETTING", number | null])[],
  raw: string | undefined, vercelEnv: string | undefined, testDefault: number, ceiling: number,
): PlatformAiCapOutcome {
  // E2: env first — an INVALID env value refuses whatever a higher source says.
  const env = resolveOneCap(raw, vercelEnv, testDefault);
  if (!env.ok && env.cause === "CAP_INVALID") return env;
  // R2: a present but invalid SETTING or OVERRIDE refuses (null = absent = not set).
  for (const [, value] of ordered) {
    if (value !== null && value !== undefined && !isCapCandidate(value)) return { ok: false, cause: "CAP_INVALID" };
  }
  for (const [source, value] of ordered) {
    if (isCapCandidate(value)) return clampTo(source, value, ceiling);
  }
  if (!env.ok) return env;
  // E1: ENV and TEST_DEFAULT are clamped like every other source.
  return clampTo(env.source, env.usd, ceiling);
}

/** PURE — both caps, each by its own precedence. */
export function resolvePlatformAiCaps(input: PlatformAiCapsInput): PlatformAiCapsResolution {
  return {
    operator: resolveCap(
      [["OPERATOR_OVERRIDE", input.operatorOverrideUsd], ["PLATFORM_SETTING", input.settingPerOperatorUsd]],
      input.operatorRaw, input.vercelEnv, PLATFORM_AI_SPEND_TEST_DEFAULTS.operatorUsd, PLATFORM_AI_OPERATOR_CAP_CEILING_USD,
    ),
    platform: resolveCap(
      [["PLATFORM_SETTING", input.settingPlatformUsd]],
      input.platformRaw, input.vercelEnv, PLATFORM_AI_SPEND_TEST_DEFAULTS.platformUsd, PLATFORM_AI_PLATFORM_CAP_CEILING_USD,
    ),
  };
}

/** PURE — the resolution as the decision's ResolvedCaps. INVALID before MISSING; operator before platform (unchanged). */
export function toResolvedCaps(r: PlatformAiCapsResolution): ResolvedCaps {
  const { operator: op, platform: pl } = r;
  if (!op.ok && op.cause === "CAP_INVALID") return { state: "REFUSE", cause: "CAP_INVALID", cap: "OPERATOR" };
  if (!pl.ok && pl.cause === "CAP_INVALID") return { state: "REFUSE", cause: "CAP_INVALID", cap: "PLATFORM" };
  if (!op.ok) return { state: "REFUSE", cause: op.cause, cap: "OPERATOR" };
  if (!pl.ok) return { state: "REFUSE", cause: pl.cause, cap: "PLATFORM" };
  return { state: "OK", operatorUsd: op.usd, platformUsd: pl.usd, source: { operator: op.source, platform: pl.source } };
}

/** The input with no override and no settings (env only): the pre-transaction CAP_INVALID probe and the legacy wrapper. */
export function envOnlyCapsInput(input: CapInputs): PlatformAiCapsInput {
  return { ...input, operatorOverrideUsd: null, settingPerOperatorUsd: null, settingPlatformUsd: null };
}

// ── 1c. The two blanket cap settings (D5 PR2) ───────────────────────────────
//
// Two PlatformSetting rows, whole USD, integer ≥ 0, registered in lib/platform-settings.ts
// (the literal keys there must equal these; a test pins it). ABSENT ⇒ "not set" (the
// fleet-ceiling precedent: the descriptor default is "" and the reader resolves the row
// itself). Read INSIDE the reservation transaction, after both advisory locks, through
// the transaction client — no settings cache. The ceilings are the resolver's (§1b).
// The one application writer is the SA-only service lib/platform/ai/platform-ai-caps-admin.ts (D5 PR4, S2 09fb C1).

export const PLATFORM_AI_CAP_SETTING_KEYS = Object.freeze({
  perOperator: "platform_ai_daily_usd_per_operator",
  platform: "platform_ai_daily_usd_platform",
} as const);

export type CapSettingRow =
  | { state: "ABSENT" }
  | { state: "SET"; usd: number }
  /** A stored row that is not a whole, non-negative number of dollars. REFUSES CAP_INVALID (S2 R2, 09fp); logged by the caller (codes only). */
  | { state: "INVALID" };

/** PURE — one blanket cap setting from its stored row (null/undefined = no row). */
export function parseCapSettingRow(raw: string | null | undefined): CapSettingRow {
  if (raw === null || raw === undefined) return { state: "ABSENT" };
  const t = raw.trim();
  if (!/^(0|[1-9]\d{0,8})$/.test(t)) return { state: "INVALID" };
  const usd = Number(t);
  return isCapCandidate(usd) ? { state: "SET", usd } : { state: "INVALID" };
}

/**
 * The resolver's value for a parsed row: the dollars when SET, null when ABSENT (not set),
 * and NaN when INVALID: a present non-candidate, which the resolver refuses CAP_INVALID (R2).
 */
export function capSettingUsdOf(r: CapSettingRow): number | null {
  if (r.state === "SET") return r.usd;
  return r.state === "ABSENT" ? null : Number.NaN;
}

// ── 1d. The per-operator override row (D5 PR4) ────────────────────────────
//
// One PlatformAiOperatorCap row per operator (D5 PR3: userId PK, dailyUsd Int, DB CHECK
// 0..20). Read INSIDE the reservation transaction, after both advisory locks, through the
// transaction client, no cache. No row ⇒ ABSENT (the blanket setting / env apply). A row
// whose dailyUsd is not a whole number 0..PLATFORM_AI_OPERATOR_CAP_CEILING_USD ⇒ INVALID ⇒
// CAP_INVALID OPERATOR (R2, S2 09fq). 0 is valid: that operator is off.

/** PURE — the override from its row (null = no row). */
export function parseOperatorCapRow(row: { dailyUsd: unknown } | null | undefined): CapSettingRow {
  if (row === null || row === undefined) return { state: "ABSENT" };
  const v = row.dailyUsd;
  return isCapCandidate(v) && v <= PLATFORM_AI_OPERATOR_CAP_CEILING_USD ? { state: "SET", usd: v } : { state: "INVALID" };
}

/** PURE — how many worst-case turns fit under `capUsd` (null when the cap or the reserve is unknown). */
export function platformAiTurnsThatFit(capUsd: number | null, reserveUsd: number | null): number | null {
  if (capUsd === null || reserveUsd === null || !Number.isFinite(capUsd) || !Number.isFinite(reserveUsd) || reserveUsd <= 0 || capUsd < 0) return null;
  return Math.floor(capUsd / reserveUsd + 1e-9);
}

/** PURE — both caps from env only (no override, no settings). A thin wrapper over resolvePlatformAiCaps, kept for tests. */
export function resolvePlatformAiSpendCaps(input: CapInputs): ResolvedCaps {
  return toResolvedCaps(resolvePlatformAiCaps(envOnlyCapsInput(input)));
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
