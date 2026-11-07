/**
 * components/platform/widgets/ai-budget-view.ts  (AI COST CONTROLS — budget utilization · Economics)
 *
 * THE PURE WORDING behind Economics → "AI Budget" (OpsAiBudgetWidget.tsx) over
 * `AiBudgetUtilization` (lib/platform/ai/cost-controls.types.ts). Every reading
 * — fleet rolling-24 h estimate against the threshold, per-customer today vs
 * allowance and rolling vs alert threshold, spend by surface, the unpriced
 * warning, the past alert deliveries — is derived here from the read model.
 *
 * EVERY DOLLAR IS AN ESTIMATE and says so. A null figure is UNAVAILABLE with
 * its reason, never $0; unpriced usage is counted and named, never priced at
 * zero. Refs are the reader's opaque refs — nothing here resolves identity.
 *
 * No React, no clock (dates are formatted by the injected formatter): deterministic under test.
 */

import type { StatusTone } from "../platform-surface";
import type { AiBudgetUtilization, AlertTriggerView, CustomerBudgetView, SurfaceBudgetView } from "@/lib/platform/ai/cost-controls.types";
import { ESTIMATE_CAPTION, fmtCount, fmtUsd } from "./overview/ai-economics-view";
import { FLEET_REASON_NONE_PRICED, NO_THRESHOLD, fleetSpendStatus } from "@/lib/platform/ai/fleet-spend-status";

export const AI_BUDGET_SUBJECT = "AI budget utilization";
export const PAST_DELIVERIES_NOTE = "Past deliveries from the alert evaluator, newest first — a fire is history, never an open incident.";
export const FLEET_NOTE = "Fleet = customer surfaces only (Conversations + Daily Brief); harness and unattributed traffic is overhead, stated beside it, never inside it.";

export function pctText(pct: number | null): string {
  return pct === null ? "—" : pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** Utilization tone: under 80% ok · 80–99% caution · at or over 100% danger · unknown muted. */
export function utilizationTone(pct: number | null): StatusTone {
  if (pct === null) return "muted";
  if (pct >= 100) return "bad";
  if (pct >= 80) return "warn";
  return "ok";
}

/** The bar's fill as a share of the threshold, capped at 100 so "over" stays legible as a full bar + the word. */
export function utilizationFill(pct: number | null): number {
  if (pct === null) return 0;
  return Math.max(0, Math.min(100, pct));
}

/**
 * The fleet headline, from THE fleet spend status (lib/platform/ai/fleet-spend-status.ts —
 * the same object the AI & Costs budget tiles read): ESTIMATED is the figure with its
 * utilization; PARTIAL is "at least" the priced figure, its utilization a lower bound and
 * its unpriced calls counted; UNAVAILABLE is the reason — never $0.
 */
export function fleetReading(b: Pick<AiBudgetUtilization, "fleet" | "windowHours" | "bySurface" | "unpriced">):
  | { kind: "figure"; status: "ESTIMATED" | "PARTIAL"; value: string; qualifier: string; pct: number | null }
  | { kind: "unavailable"; status: "UNAVAILABLE"; reason: string; qualifier: string; pct: null } {
  const f = b.fleet;
  const s = fleetSpendStatus(b);
  const scope = `${fmtCount(f.customers)} customer${f.customers === 1 ? "" : "s"} · ${fmtCount(f.invocations)} invocation${f.invocations === 1 ? "" : "s"} · rolling ${b.windowHours} h`;
  if (s.status === "UNAVAILABLE" || s.pricedUsd === null) {
    return { kind: "unavailable", status: "UNAVAILABLE", reason: s.reason ?? FLEET_REASON_NONE_PRICED, qualifier: `${scope} · ${ESTIMATE_CAPTION}`, pct: null };
  }
  // A 0 / unset threshold is NO threshold — never "0% of the $0 fleet alert threshold".
  const share = (prefix: string) => s.thresholdSet
    ? `${prefix}${pctText(s.utilisationPct)} of the ${fmtUsdWhole(f.thresholdUsd)} fleet alert threshold`
    : NO_THRESHOLD;
  if (s.status === "PARTIAL") {
    const u = `${fmtCount(s.unpricedInvocations)} unpriced invocation${s.unpricedInvocations === 1 ? "" : "s"} not counted`;
    return {
      kind: "figure", status: "PARTIAL", pct: s.utilisationPct,
      value: `at least ${fmtUsd(s.pricedUsd)}`,
      qualifier: `${share("at least ")} · partial — ${u} · ${scope} · ${ESTIMATE_CAPTION}`,
    };
  }
  return {
    kind: "figure", status: "ESTIMATED", pct: s.utilisationPct,
    value: fmtUsd(s.pricedUsd),
    qualifier: `${share("")} · ${scope} · ${ESTIMATE_CAPTION}`,
  };
}

export function fmtUsdWhole(n: number): string {
  return `$${n}`;
}

/** "Threshold $10 / 24 h · alert enabled"; a 0 / unset threshold is "No threshold set". */
export function thresholdText(f: Pick<AiBudgetUtilization["fleet"], "thresholdUsd" | "alertEnabled">, windowHours: number): string {
  const set = Number.isFinite(f.thresholdUsd) && f.thresholdUsd > 0;
  return `${set ? `Threshold ${fmtUsdWhole(f.thresholdUsd)} / ${windowHours} h` : NO_THRESHOLD} · alert ${f.alertEnabled ? "enabled" : "disabled"}`;
}

/** The overhead line: harness and unattributed, never fleet. A null figure is said, never zeroed. */
export function overheadText(o: AiBudgetUtilization["overhead"]): string {
  const n = `${fmtCount(o.invocations)} invocation${o.invocations === 1 ? "" : "s"}`;
  if (o.estimatedUsd === null) return `Overhead: ${n}, ${o.invocations === 0 ? "none in the window" : "none priced"} — harness and unattributed, never fleet`;
  return `Overhead ${fmtUsd(o.estimatedUsd)} (${n}) — harness and unattributed, never fleet`;
}

export function pausedWord(paused: boolean): { word: "Paused" | "Admitting"; tone: StatusTone } {
  return paused ? { word: "Paused", tone: "bad" } : { word: "Admitting", tone: "ok" };
}

export function enforcementWord(enforced: boolean): { word: "Enforced" | "Not enforced"; tone: StatusTone } {
  return enforced ? { word: "Enforced", tone: "ok" } : { word: "Not enforced", tone: "warn" };
}

/** "Allowance enforced · default $5 per UTC day · per-customer alert enabled at $3 / 24 h". */
export function controlsText(c: AiBudgetUtilization["controls"], windowHours: number): string {
  return `Allowance ${c.allowanceEnforced ? "enforced" : "not enforced"} · default ${fmtUsdWhole(c.allowanceDefaultUsd)} per UTC day · per-customer alert ${c.userAlertEnabled ? "enabled" : "disabled"} at ${fmtUsdWhole(c.userAlertThresholdUsd)} / ${windowHours} h`;
}

export function sourceText(source: CustomerBudgetView["allowanceSource"]): string {
  switch (source) {
    case "USER_OVERRIDE":    return "customer override";
    case "OVERLAY":          return "overlay";
    case "PLATFORM_SETTING": return "platform setting";
    case "POLICY":           return "policy group";
    case "CEILING":          return "ceiling";
  }
}

/** One customer row's two readings — today against the allowance, the rolling window against the alert threshold. */
export function customerRowText(c: CustomerBudgetView, userAlertThresholdUsd: number): { today: string; todayPct: number | null; rolling: string; rollingPct: number | null } {
  // A $0 allowance / threshold has no share (pct() is null): say so, never "0% of $0".
  const allowance = c.allowanceUtilizationPct === null ? "no allowance" : pctText(c.allowanceUtilizationPct);
  const alert = c.alertUtilizationPct === null ? NO_THRESHOLD.toLowerCase() : pctText(c.alertUtilizationPct);
  return {
    today: `${fmtUsd(c.todayUsd)} of ${fmtUsdWhole(c.allowanceUsd)} (${allowance}, ${sourceText(c.allowanceSource)})`,
    todayPct: c.allowanceUtilizationPct,
    rolling: `${fmtUsd(c.rolling24hUsd)} vs ${fmtUsdWhole(userAlertThresholdUsd)} (${alert})`,
    rollingPct: c.alertUtilizationPct,
  };
}

/** One surface row: its name and whether it is customer spend or overhead; a null figure is unavailable with its reason. */
export function surfaceRowText(s: SurfaceBudgetView): { label: string; value: string | null; unavailable: string; meta: string } {
  const unpriced = s.unpricedInvocations > 0 ? ` · ${fmtCount(s.unpricedInvocations)} unpriced not counted` : "";
  return {
    label: `${s.surface} · ${s.customer ? "customer" : "overhead"}`,
    value: s.estimatedUsd === null ? null : fmtUsd(s.estimatedUsd),
    unavailable: s.invocations === 0 ? "none in the window" : "none priced",
    meta: `${fmtCount(s.invocations)} invocation${s.invocations === 1 ? "" : "s"}${unpriced}`,
  };
}

/** The unpriced warning, or null when every invocation was priced. Unknown cost is never $0. */
export function unpricedWarning(u: AiBudgetUtilization["unpriced"]): string | null {
  if (u.invocations === 0) return null;
  const models = u.models.length > 0 ? ` (${u.models.join(", ")})` : "";
  return `${fmtCount(u.invocations)} unpriced invocation${u.invocations === 1 ? "" : "s"}${models} excluded from every figure here — unknown cost is not $0; see the rate card.`;
}

/** "delivered 14 Oct 2026, 09:00 UTC" — a past delivery, in the past tense. */
export function deliveryText(a: Pick<AlertTriggerView, "at">, formatDate: (iso: string) => string): string {
  return `delivered ${formatDate(a.at)}`;
}

export function severityTone(severity: AlertTriggerView["severity"]): StatusTone {
  return severity === "critical" ? "bad" : "warn";
}

/** "checked 14 Oct 2026, 09:00 UTC · rolling 24 h" */
export function windowText(b: Pick<AiBudgetUtilization, "checkedAt" | "windowHours">, formatDate: (iso: string) => string): string {
  return `checked ${formatDate(b.checkedAt)} · rolling ${b.windowHours} h`;
}
