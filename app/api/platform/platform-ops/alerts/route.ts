/**
 * GET /api/platform/platform-ops/alerts  (OPS-5 S5)
 *
 * The read surface for the `ops_alerts` widget: the alert rules with their
 * enabled/dormant state and destination, each rule's last-triggered time, and a
 * recent firing history — all derived from the registry + PlatformSetting
 * overrides + recent evaluate-alerts JobRun summaries (the alert store; no new
 * table). Read-only, aggregate + non-monetary only (rule ids, kinds, states,
 * counts, timestamps).
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
import {
  collectAlertHistory,
  deriveAlertRuleViews,
  resolveEnabled,
  type AlertFiredRecord,
  type AlertRuleView,
} from "@/lib/alerts/evaluate";

export const runtime = "nodejs";

export interface PlatformAlertsResponse {
  destination: string | null;
  lastEvaluatedAt: string | null;
  rules: AlertRuleView[];
  history: AlertFiredRecord[];
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
    destination: env.PLATFORM_ALERTS_EMAIL,
    lastEvaluatedAt: recentRuns[0]?.evaluatedAtISO ?? null,
    rules: deriveAlertRuleViews(ALERT_RULES, isEnabled, recentRuns),
    history: collectAlertHistory(recentRuns),
  } satisfies PlatformAlertsResponse);
}
