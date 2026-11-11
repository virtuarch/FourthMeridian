/**
 * lib/platform/ai/platform-ai-usage-today.core.ts  (PLATFORM AI COST MANAGEMENT — today's usage, the PURE fold)
 *
 * WHAT THE CAPS ARE DOING TODAY, stated in the reservation's own terms. The caps
 * (platform-ai-spend.core.ts) and the reservation (platform-ai-spend.ts) decide;
 * this module only DESCRIBES, for the two read surfaces:
 *
 *   · Admin → Platform AI caps (SYSTEM_ADMIN): per-operator spend, remaining and state;
 *   · Platform Ops → Policies → AI Cost Controls (PLATFORM_OPS READ): the platform
 *     totals, by model and by feature, COUNTS of operators at their limit, and the
 *     viewer's OWN figures — never another operator's identity.
 *
 * ONE ARITHMETIC. Spend = today's RETURNED `platform_ai` rows grouped by (provider,
 * model) and priced by sumTodaySpend (THE rate card), exactly as the reservation
 * prices them. A budget's state uses the reservation's own inequality:
 *     spent + (inFlight + 1) × reserve > cap  ⇒  EXHAUSTED (the next question is refused)
 * so the page can never say "room left" where the reservation would refuse (pinned
 * against platformAiSpendDecision in the test).
 *
 * FAIL CLOSED IN THE DESCRIPTION TOO. A cap that does not resolve (CAP_MISSING /
 * CAP_INVALID), an unpriced model or row (UNPRICED) or a ledger failing its writes
 * (LEDGER_UNTRUSTED) is state REFUSING with that cause and NO remaining figure —
 * never a $0 or a made-up headroom.
 *
 * ESTIMATES, NOT CHARGES. Tokens are provider-reported; dollars are those tokens
 * priced by the code-owned rate card. No provider invoice or billing API is read
 * (none is readable: lib/usage/pricing.ts). Every surface says so.
 *
 * PURE — no I/O, no clock, no env read.
 */

import { AI_RATES, type AiRate } from "@/lib/usage/pricing";
import { sumTodaySpend, type TodaySpendGroup } from "@/lib/ai/allowance-core";
import type { AdminApiAccess } from "@/lib/admin-totp-enrollment";
import type {
  PlatformAiBudgetRefusal, PlatformAiBudgetState, PlatformAiBudgetView, PlatformAiOperatorUsageView,
  PlatformAiUsageFigure, PlatformAiUsageSlice,
} from "@/lib/platform/ai/cost-controls.types";

export type {
  PlatformAiBudgetRefusal, PlatformAiBudgetState, PlatformAiBudgetView, PlatformAiOperatorUsageView,
  PlatformAiUsageFigure, PlatformAiUsageSlice,
};

/** One `platform_ai` ledger row of today, of ANY outcome (only RETURNED rows are priced). */
export interface PlatformAiUsageRow {
  userId: string | null;
  provider: string;
  model: string;
  subSurface: string | null;
  outcome: string;
  correlationId: string | null;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
}

/** A budget is LOW when this many worst-case questions or fewer still fit. */
export const PLATFORM_AI_LOW_TURNS = 2;

/** The feature (sub-surface) names an operator reads. Unknown codes are shown as the code itself. */
export const PLATFORM_AI_FEATURE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "platform_ai:ask": "Ask (one question)",
  "platform_ai:conversation": "Conversations",
});
export const UNLABELLED_FEATURE = "Unlabelled";

export const featureLabel = (subSurface: string | null): string =>
  subSurface === null ? UNLABELLED_FEATURE : PLATFORM_AI_FEATURE_LABELS[subSurface] ?? subSurface;

/** PURE — today's RETURNED rows as (provider, model) groups, the shape the reservation prices. */
export function spendGroupsOf(rows: readonly PlatformAiUsageRow[]): TodaySpendGroup[] {
  const by = new Map<string, TodaySpendGroup>();
  for (const r of rows) {
    if (r.outcome !== "RETURNED") continue;
    const k = `${r.provider}\u0000${r.model}`;
    const g = by.get(k) ?? { provider: r.provider, model: r.model, invocations: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };
    g.invocations++; g.promptTokens += r.promptTokens ?? 0; g.cachedPromptTokens += r.cachedPromptTokens ?? 0; g.completionTokens += r.completionTokens ?? 0;
    by.set(k, g);
  }
  return [...by.values()];
}

/** PURE — one figure over a set of rows. A turn = one distinct correlationId of any outcome (the daily turn cap's count). */
export function foldPlatformAiUsage(rows: readonly PlatformAiUsageRow[], todayISO: string, rates: readonly AiRate[] = AI_RATES): PlatformAiUsageFigure {
  const spend = sumTodaySpend(spendGroupsOf(rows), todayISO, rates);
  let failedCalls = 0, tokens = 0;
  const turns = new Set<string>();
  for (const r of rows) {
    turns.add(r.correlationId ?? "(ungrouped)");
    if (r.outcome !== "RETURNED") { failedCalls++; continue; }
    tokens += (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
  }
  return {
    estimatedUsd: spend.spentUsd,
    calls: spend.invocations,
    failedCalls,
    unpricedCalls: spend.unpricedInvocations,
    turns: turns.size,
    tokens,
  };
}

/** PURE — the rows split by a key, each slice folded; most expensive first, then by name. */
export function slicePlatformAiUsage(
  rows: readonly PlatformAiUsageRow[], keyOf: (r: PlatformAiUsageRow) => string, labelOf: (r: PlatformAiUsageRow) => string,
  todayISO: string, rates: readonly AiRate[] = AI_RATES,
): PlatformAiUsageSlice[] {
  const by = new Map<string, { label: string; rows: PlatformAiUsageRow[] }>();
  for (const r of rows) {
    const k = keyOf(r);
    const s = by.get(k) ?? { label: labelOf(r), rows: [] };
    s.rows.push(r);
    by.set(k, s);
  }
  return [...by.entries()]
    .map(([key, s]) => ({ key, label: s.label, ...foldPlatformAiUsage(s.rows, todayISO, rates) }))
    .sort((a, b) => b.estimatedUsd - a.estimatedUsd || a.label.localeCompare(b.label));
}

export const byModel = (rows: readonly PlatformAiUsageRow[], todayISO: string, rates?: readonly AiRate[]) =>
  slicePlatformAiUsage(rows, (r) => `${r.provider}:${r.model}`, (r) => r.model, todayISO, rates);

export const byFeature = (rows: readonly PlatformAiUsageRow[], todayISO: string, rates?: readonly AiRate[]) =>
  slicePlatformAiUsage(rows, (r) => r.subSurface ?? "", (r) => featureLabel(r.subSurface), todayISO, rates);

const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export interface BudgetInput {
  /** The cap in force, or why it does not resolve. */
  cap: { usd: number | null; refusal: "CAP_MISSING" | "CAP_INVALID" | null };
  usage: PlatformAiUsageFigure;
  /** Questions admitted and not yet released (the reservation's in-flight buckets). */
  inFlight: number;
  /** platformAiReserveUsd(model, today) — null ⇒ unpriced. */
  reserveUsd: number | null;
  ledgerUntrusted: boolean;
}

/**
 * PURE — one budget, judged in the reservation's order: cap refusal, ledger untrusted,
 * unpriced, then `spent + (inFlight + 1) × reserve > cap` ⇒ EXHAUSTED; ≤ LOW_TURNS fit ⇒ LOW.
 */
export function platformAiBudget(input: BudgetInput): PlatformAiBudgetView {
  const inFlight = whole(input.inFlight);
  const spentUsd = input.usage.estimatedUsd;
  const reserve = input.reserveUsd !== null && Number.isFinite(input.reserveUsd) && input.reserveUsd > 0 ? input.reserveUsd : null;
  const base = { capUsd: input.cap.usd, spentUsd, inFlight, reservedUsd: reserve === null ? null : inFlight * reserve };
  const refusing = (refusal: PlatformAiBudgetRefusal): PlatformAiBudgetView =>
    ({ ...base, remainingUsd: null, turnsLeft: null, state: "REFUSING", refusal });
  if (input.cap.refusal !== null || input.cap.usd === null) return refusing(input.cap.refusal ?? "CAP_MISSING");
  if (input.ledgerUntrusted) return refusing("LEDGER_UNTRUSTED");
  if (reserve === null || input.usage.unpricedCalls > 0) return refusing("UNPRICED");
  const cap = input.cap.usd;
  const remainingUsd = Math.max(0, cap - spentUsd - inFlight * reserve);
  const turnsLeft = Math.floor(remainingUsd / reserve + 1e-9);
  // The reservation's inequality, verbatim (platformAiSpendDecision).
  const exhausted = spentUsd + (inFlight + 1) * reserve > cap;
  const state: PlatformAiBudgetState = exhausted ? "EXHAUSTED" : turnsLeft <= PLATFORM_AI_LOW_TURNS ? "LOW" : "OK";
  return { ...base, remainingUsd, turnsLeft: exhausted ? 0 : turnsLeft, state, refusal: null };
}

/** The SYSTEM_ADMIN page where the caps are edited (the page, not its API). */
export const PLATFORM_AI_CAPS_PAGE_HREF = "/admin/platform-ai-caps";

/**
 * PURE — the "Manage limits" link for the Platform Space usage card: the caps page
 * when the viewer passes the SAME admin-access rule the caps route enforces
 * (lib/session.ts adminApiAccess → requireSystemAdmin), else null — no link, no href.
 * Decided by the server from the session; the card only renders what it is given.
 */
export function platformAiManageLimitsHref(access: AdminApiAccess): string | null {
  return access === "ALLOW" ? PLATFORM_AI_CAPS_PAGE_HREF : null;
}

const RANK: Record<PlatformAiBudgetState, number> = { OK: 0, LOW: 1, EXHAUSTED: 2, REFUSING: 3 };

/**
 * PURE — one operator: their own budget, the platform budget and the daily turn cap,
 * combined into what their NEXT question meets first (the worst state wins; on a
 * tie the operator's own limit is named before the platform's, then the turn cap).
 */
export function platformAiOperatorUsage(args: {
  usage: PlatformAiUsageFigure;
  budget: PlatformAiBudgetView;
  platform: PlatformAiBudgetView;
  turnsCap: number;
}): PlatformAiOperatorUsageView {
  const { usage, budget, platform, turnsCap } = args;
  const turnsState: PlatformAiBudgetState = usage.turns >= turnsCap ? "EXHAUSTED" : turnsCap - usage.turns <= PLATFORM_AI_LOW_TURNS ? "LOW" : "OK";
  const candidates: Array<[PlatformAiOperatorUsageView["limitedBy"], PlatformAiBudgetState, PlatformAiBudgetRefusal | null]> = [
    ["OPERATOR", budget.state, budget.refusal],
    ["PLATFORM", platform.state, platform.refusal],
    ["DAILY_TURNS", turnsState, null],
  ];
  let pick = candidates[0];
  for (const c of candidates) if (RANK[c[1]] > RANK[pick[1]]) pick = c;
  return {
    usage, budget, turnsCap, turnsUsed: usage.turns,
    state: pick[1],
    limitedBy: pick[1] === "OK" ? null : pick[0],
    refusal: pick[2],
  };
}
