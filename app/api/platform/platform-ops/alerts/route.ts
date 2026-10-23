/**
 * GET /api/platform/platform-ops/alerts  (OPS-5 S5 · UX-P1 latest outcomes)
 *
 * The read surface for the `ops_alerts` widget and the Platform Health posture:
 * the alert rules with their enabled/dormant state and destination, each rule's
 * last-triggered time, a recent firing history — and, since UX-P1, the LATEST
 * evaluation's per-rule outcomes. All derived from the registry + PlatformSetting
 * overrides + recent evaluate-alerts JobRun summaries (the alert store; no new
 * table). Read-only, aggregate + non-monetary only (rule ids, kinds, states,
 * counts, timestamps).
 *
 * TWO CLOCKS, KEPT APART. `history` is a DELIVERY log: an email went out at
 * that time. `latest` is the most recent cycle's verdict: which rules breached
 * when the evaluator last looked. Only `latest.rules[].firing` may be rendered
 * as "firing now"; the history is the past and is labelled so wherever it is
 * shown (investigation §13 risk 1).
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ") — the same gate
 * the other Platform Ops read widgets use. No mutation here: enabling/disabling
 * a rule is a PlatformSetting change (a WRITE lever is a later slice, mirroring
 * how OPS-5 S4 split "Run Now" out of the read surfaces).
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { env } from "@/lib/env";
import { ALERT_RULES } from "@/lib/alerts/rules";
import { loadAlertSettings, loadRecentAlertRuns } from "@/lib/alerts/run";
import { latestAlertEvaluation, type AlertLatestEvaluation } from "@/lib/alerts/latest-evaluation";
import {
  collectAlertHistory,
  deriveAlertRuleViews,
  resolveEnabled,
  type AlertFiredRecord,
  type AlertRuleView,
} from "@/lib/alerts/evaluate";

export const runtime = "nodejs";

export interface PlatformAlertsResponse {
  /** PLATFORM OPS PRIVACY — whether an alert destination is configured. The
   *  address is an environment value and never crosses into a payload. */
  destinationConfigured: boolean;
  lastEvaluatedAt: string | null;
  rules: AlertRuleView[];
  /** Delivery HISTORY across the retained evaluations — never "open". */
  history: AlertFiredRecord[];
  /** How many evaluation runs `history` was collected from (the window). */
  historyRuns: number;
  /** The latest evaluation's verdict — the only source of "firing now". Null
   *  when the evaluator has never recorded a run. */
  latest: AlertLatestEvaluation | null;
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const [settings, recentRuns] = await Promise.all([loadAlertSettings(), loadRecentAlertRuns()]);
  const isEnabled = (ruleId: string): boolean => {
    const rule = ALERT_RULES.find((r) => r.id === ruleId);
    return rule ? resolveEnabled(rule, settings) : false;
  };

  return NextResponse.json({
    destinationConfigured: Boolean(env.PLATFORM_ALERTS_EMAIL),
    lastEvaluatedAt: recentRuns[0]?.evaluatedAtISO ?? null,
    rules: deriveAlertRuleViews(ALERT_RULES, isEnabled, recentRuns),
    history: collectAlertHistory(recentRuns),
    historyRuns: recentRuns.length,
    latest: latestAlertEvaluation(recentRuns),
  } satisfies PlatformAlertsResponse);
}
