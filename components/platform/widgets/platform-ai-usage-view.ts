/**
 * components/platform/widgets/platform-ai-usage-view.ts  (PLATFORM AI COST MANAGEMENT — the pure wording)
 *
 * Every sentence the two usage surfaces say about today's Platform AI spend, as pure
 * functions (testable without a DOM). Every dollar is labelled an ESTIMATE; a budget
 * that refuses says WHY and shows no headroom; nothing here renders an id.
 */

import type {
  PlatformAiBudgetRefusal, PlatformAiBudgetState, PlatformAiBudgetView, PlatformAiOperatorUsageView, PlatformAiUsageFigure,
} from "@/lib/platform/ai/cost-controls.types";

export type UsageTone = "ok" | "warn" | "bad" | "muted";

export const USAGE_TODAY_TITLE = "Platform AI usage today";
export const ESTIMATED_BADGE = "Estimated";
export const MANAGE_LIMITS_LABEL = "Manage limits";
export const USAGE_UNAVAILABLE ="Platform AI usage is not available right now.";

/** Estimated dollars: cents precision; a positive amount under a cent reads "<$0.01", never "$0.00". */
export function estUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.005) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

const STATE: Record<PlatformAiBudgetState, { word: string; tone: UsageTone }> = {
  OK: { word: "Within budget", tone: "ok" },
  LOW: { word: "Running low", tone: "warn" },
  EXHAUSTED: { word: "Limit reached", tone: "bad" },
  REFUSING: { word: "Refusing questions", tone: "bad" },
};
export const stateBadge = (s: PlatformAiBudgetState) => STATE[s];

const REFUSAL: Record<PlatformAiBudgetRefusal, string> = {
  CAP_MISSING: "The cap is not set, so every Platform AI question is refused.",
  CAP_INVALID: "The cap setting is invalid, so every Platform AI question is refused.",
  UNPRICED: "The model cannot be priced, so every Platform AI question is refused.",
  LEDGER_UNTRUSTED: "The usage ledger is failing its writes, so questions are refused until it recovers.",
};
export const refusalText = (r: PlatformAiBudgetRefusal | null): string => (r ? REFUSAL[r] : "");

const LIMITED_BY: Record<NonNullable<PlatformAiOperatorUsageView["limitedBy"]>, string> = {
  OPERATOR: "their own cap",
  PLATFORM: "the platform cap",
  DAILY_TURNS: "the daily question limit",
};
export const limitedByText = (l: PlatformAiOperatorUsageView["limitedBy"]): string => (l ? LIMITED_BY[l] : "");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "$0.42 spent (estimated) · 5 questions · 12 calls · 1 failed · 2 unpriced". */
export function spentLine(u: PlatformAiUsageFigure): string {
  const parts = [`${estUsd(u.estimatedUsd)} spent (estimated)`, plural(u.turns, "question"), plural(u.calls, "call")];
  if (u.failedCalls > 0) parts.push(`${u.failedCalls} failed`);
  if (u.unpricedCalls > 0) parts.push(`${u.unpricedCalls} unpriced`);
  return parts.join(" · ");
}

/** "$9.58 left of $10 (estimated) · about 38 questions", or why there is no headroom. */
export function remainingLine(b: PlatformAiBudgetView): string {
  if (b.state === "REFUSING" || b.remainingUsd === null || b.capUsd === null) return refusalText(b.refusal ?? "CAP_MISSING");
  const base = `${estUsd(b.remainingUsd)} left of $${b.capUsd} (estimated)`;
  const running = b.inFlight > 0 ? ` · ${plural(b.inFlight, "question")} running` : "";
  if (b.state === "EXHAUSTED") return `${base}${running} · the next question is refused until 00:00 UTC`;
  return `${base}${running} · about ${plural(b.turnsLeft ?? 0, "question")} at worst case`;
}

/** The 0..1 share of the cap used (spent + reserved), for a meter; null when there is no cap. */
export function usedShare(b: PlatformAiBudgetView): number | null {
  if (b.capUsd === null || b.state === "REFUSING") return null;
  if (b.capUsd <= 0) return 1;
  return Math.min(1, Math.max(0, (b.spentUsd + (b.reservedUsd ?? 0)) / b.capUsd));
}

/** One operator, one line: "$0.42 of $3 (estimated) · 4/20 questions · Limit reached (the platform cap)". */
export function operatorTodayLine(v: PlatformAiOperatorUsageView): string {
  const cap = v.budget.capUsd === null ? "no cap" : `$${v.budget.capUsd}`;
  const head = `${estUsd(v.usage.estimatedUsd)} of ${cap} (estimated) · ${v.turnsUsed}/${v.turnsCap} questions`;
  if (v.state === "OK") return head;
  if (v.state === "REFUSING") return `${head} · ${stateBadge(v.state).word}`;
  return `${head} · ${stateBadge(v.state).word} (${limitedByText(v.limitedBy)})`;
}

/** The fleet's operator counts: "3 people used Platform AI today · 1 at a limit · 1 running low". */
export function operatorCountsLine(c: { activeToday: number; low: number; exhausted: number; refusing: number }): string {
  const parts = [`${plural(c.activeToday, "person", "people")} used Platform AI today`];
  if (c.exhausted > 0) parts.push(`${c.exhausted} at a limit`);
  if (c.refusing > 0) parts.push(`${c.refusing} refused`);
  if (c.low > 0) parts.push(`${c.low} running low`);
  return parts.join(" · ");
}
