/**
 * components/platform/growth/beta-risk-badge-model.ts  (beta-request risk · queue cue)
 *
 * The PURE half of the advisory risk cue on Growth's Waiting queue: which badge a
 * row shows, and the plain-English signal lines the single-request panel lists.
 * No React, no fetch, no clock — unit-tested directly.
 *
 * PRESENTATION ONLY. The level is advisory (lib/platform/growth/beta-risk-core.ts):
 * it never blocks approval, never hides a row, never changes a status. Wording is
 * the core's neutral vocabulary — never "bot", "fraud" or "malicious".
 *
 * Client-safe: TYPE imports only (beta-risk-core imports node:crypto). The level
 * labels are mirrored here and pinned equal to the core's by the model test.
 */

import type { BetaRequestRisk, BetaRiskLevel, BetaRiskReason, BetaRiskReviewStatusValue } from "@/lib/platform/growth/beta-risk-types";
import type { StatusTone } from "@/components/platform/widgets/job-health-format";

/** Mirror of BETA_RISK_LEVEL_LABEL (pinned equal by beta-risk-badge-model.test.ts). */
export const RISK_LEVEL_LABEL: Readonly<Record<BetaRiskLevel, string>> = {
  none:         "No notable signals",
  review:       "Review suggested",
  high:         "High suspicion",
  insufficient: "Insufficient evidence",
};

const LEVEL_TONE: Readonly<Record<Exclude<BetaRiskLevel, "none">, StatusTone>> = {
  high:         "bad",
  review:       "warn",
  insufficient: "muted",
};

const REVIEW_WORD: Readonly<Record<BetaRiskReviewStatusValue, string>> = {
  UNREVIEWED: "not yet reviewed",
  LEGITIMATE: "marked legitimate",
  SUSPICIOUS: "marked suspicious",
};

export interface RiskBadge {
  level: Exclude<BetaRiskLevel, "none">;
  word: string;
  tone: StatusTone;
  /** Accessible / hover text: the level, the signals, the latest verdict. */
  title: string;
}

/** The row badge, or null when there is nothing to show (no risk block, or level none). */
export function riskBadge(risk: BetaRequestRisk | null | undefined): RiskBadge | null {
  if (!risk || risk.level === "none") return null;
  const level = risk.level;
  const parts = [`Risk: ${RISK_LEVEL_LABEL[level]}`];
  if (risk.reasons.length > 0) parts.push(risk.reasons.map((r) => r.label).join("; "));
  const verdict = reviewLine(risk);
  if (verdict) parts.push(verdict);
  parts.push("Advisory only — never blocks approval.");
  return { level, word: RISK_LEVEL_LABEL[level], tone: LEVEL_TONE[level], title: parts.join(" · ") };
}

function windowWords(minutes: number | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  if (minutes % 60 === 0) { const h = minutes / 60; return `${h} hour${h === 1 ? "" : "s"}`; }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Plain-English evidence for one reason, or null when the reason carries none. */
export function evidenceWords(reason: Pick<BetaRiskReason, "code" | "evidence">): string | null {
  const { count, windowMinutes } = reason.evidence ?? {};
  const within = windowWords(windowMinutes);
  if (count === undefined) return null;
  switch (reason.code) {
    case "BURST_WINDOW":        return `${plural(count, "request", "requests")}${within ? ` within ${within}` : ""}`;
    case "SHARED_NETWORK":      return `${plural(count, "other requester", "other requesters")}${within ? ` within ${within}` : ""}`;
    case "AUTOMATION_UA":
    case "UNRECOGNISED_UA":
    case "REPEATED_SUBMISSION":
    case "NO_BROWSER_SIGNALS":  return plural(count, "submission", "submissions");
    case "ALIAS_CLUSTER":       return `${plural(count, "address", "addresses")} in the group`;
    case "DUPLICATE_NOTE":      return `${plural(count, "request", "requests")} with this note`;
    default:                    return null;
  }
}

export interface RiskSignalLine { code: string; text: string; evidence: string | null }

/** The panel's signal list: each reason's neutral label plus its evidence, in the server's order. */
export function riskSignalLines(risk: BetaRequestRisk | null | undefined): RiskSignalLine[] {
  if (!risk) return [];
  return risk.reasons.map((r) => ({ code: r.code, text: r.label, evidence: evidenceWords(r) }));
}

/** "Marked legitimate by alice" — the latest operator verdict, or null when none/unreviewed. */
export function reviewLine(risk: BetaRequestRisk | null | undefined): string | null {
  const rv = risk?.review;
  if (!rv || rv.status === "UNREVIEWED") return null;
  const word = REVIEW_WORD[rv.status];
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}${rv.by ? ` by ${rv.by}` : ""}`;
}
