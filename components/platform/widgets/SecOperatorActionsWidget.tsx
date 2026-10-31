"use client";

/**
 * components/platform/widgets/SecOperatorActionsWidget.tsx  (PO-3A · sec_operator_actions → BETA V2 group)
 *
 * The Operator actions GROUP of the one Security posture surface
 * (SecurityPostureWidget.tsx), over GET /api/platform/security-ops/operator-actions
 * (requirePlatformAccess SECURITY_OPS READ). Distinct from the End-user auth group:
 * this is what operators DID to the platform — grant changes, manual operations,
 * beta decisions, operator account state changes, the P1 consequential actions —
 * each attributed to the acting operator, with the reason CODE (never the note),
 * the result as a word in its tone, and opaque execution handles. Read-only.
 *
 * The action and reason vocabularies stay in this file (lib/platform/
 * operator-action-adoption.test.ts pins that the feed widget labels the P1
 * actions and never renders a note).
 *
 * `SecOperatorActionsWidget` (the registry export for `sec_operator_actions`)
 * renders nothing: the section is absorbed by the surface `sec_auth_posture` hosts.
 */

import { useState } from "react";
import { UserCog } from "lucide-react";
import { useWidgetFetch, type PlatformSection } from "../widget-kit";
import { SectionSurface, ToneBadge, TwoLine } from "../platform-surface";
import type { OperatorActionsResponse } from "@/app/api/platform/security-ops/operator-actions/route";
import { OPERATOR_RESULT_TONE, OPERATOR_RESULT_WORD, feedDepthText, operatorLine, type Fetched } from "./security-posture-view";
import { SourceGate } from "./SecurityPostureParts";
import { relTime } from "./job-health-format";

/** Humanize the audit action into a short operator-verb. Unknown → the raw action. */
export const OPERATOR_ACTION_LABEL: Record<string, string> = {
  PLATFORM_GRANT_CREATED:       "Granted platform access",
  PLATFORM_GRANT_LEVEL_CHANGED: "Changed access level",
  PLATFORM_GRANT_REVOKED:       "Revoked platform access",
  PLATFORM_GRANT_REINSTATED:    "Reinstated platform access",
  PLATFORM_OPERATION_EXECUTED:  "Ran a manual operation",
  PLATFORM_OPERATION_DRY_RUN:   "Dry-ran an operation",
  PLATFORM_OPERATION_REQUESTED: "Started a fleet-wide operation",
  BETA_ACCESS_APPROVED:         "Approved a beta request",
  BETA_ACCESS_DENIED:           "Denied a beta request",
  BETA_MODE_CHANGED:            "Changed signup mode",
  BETA_INVITATION_CREATED:      "Sent a direct invitation",
  BETA_INVITATION_RESENT:       "Resent an invitation",
  BETA_INVITATION_REVOKED:      "Revoked an invitation",
  BETA_INVITATION_VALIDITY_CHANGED: "Changed invitation validity",
  BETA_INVITATION_EXTENDED:     "Extended an invitation",
  BETA_ACCESS_BULK_APPROVED:    "Bulk-approved beta requests",
  PRODUCT_STATUS_CHANGED:       "Changed product status",
  CONNECTION_RESYNC_TRIGGERED:  "Resynced a connection",
  CONNECTION_REAUTH_REQUESTED:  "Requested reauthorization",
  WALLET_HISTORY_RESUMED:       "Resumed wallet history",
  ACCOUNT_DEACTIVATED:          "Deactivated an account",
  ACCOUNT_REACTIVATED:          "Reactivated an account",
  // P1 — customer policy / cohort, execution cadence, operator refresh-all.
  CUSTOMER_POLICY_ASSIGNED:        "Assigned a policy group",
  CUSTOMER_POLICY_OVERLAY_CHANGED: "Changed a policy overlay",
  CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED: "Changed a customer's AI allowance override",
  CUSTOMER_COHORT_ASSIGNED:        "Assigned a cohort",
  CUSTOMER_POLICY_RECONCILED:      "Assigned Beta to unassigned accounts",
  POLICY_GROUP_CREATED:            "Created a policy group",
  POLICY_GROUP_UPDATED:            "Edited a policy group",
  POLICY_GROUP_ROLLED_BACK:        "Restored a policy group version",
  POLICY_GROUP_ARCHIVED:           "Archived a policy group",
  POLICY_GROUP_DEFAULT_CHANGED:    "Changed the default policy group",
  POLICY_GROUP_PAUSED:             "Paused a policy group",
  POLICY_GROUP_RESUMED:            "Resumed a policy group",
  POLICY_GROUP_ENDED:              "Ended a policy group",
  POLICY_GROUP_COST_FROZEN:        "Froze a policy group's costs",
  POLICY_GROUP_COST_UNFROZEN:      "Unfroze a policy group's costs",
  JOB_CADENCE_CHANGED:             "Changed a job cadence",
  JOB_CADENCE_RESET:               "Reset a job cadence",
  OPERATOR_REFRESH_ALL:            "Refreshed a customer's authorities",
  PLAID_ITEM_REVOCATION_RETRY_REQUESTED: "Retried provider cleanup",
  // SEC-PLAT-2 — these two were on the feed but rendered as raw action names.
  PLATFORM_POLICY_CHANGED:         "Changed a platform control",
  PLATFORM_POLICY_RESET:           "Reset a platform control",
  MERCHANT_MERGE_APPLIED:          "Merged two merchants",
  MERCHANT_MERGE_DISMISSED:        "Dismissed a merchant merge",
  PLATFORM_CONTROL_REFUSED:        "A control change was refused",
  PLAID_ITEM_WEBHOOK_DRY_RUN:      "Dry-ran a webhook repoint",
  PLAID_ITEM_WEBHOOK_UPDATED:      "Repointed a provider webhook",
  // SEC-PLAT-3
  CUSTOMER_PROFILE_VIEWED:         "Viewed a customer profile",
};

/** Reason codes, humanised. Unknown → the raw code. */
export const OPERATOR_REASON_LABEL: Record<string, string> = {
  BETA_ONBOARDING: "beta onboarding", SUPPORT_REQUEST: "support request", DOGFOOD: "dogfood", TESTING: "testing",
  POLICY_ROLLOUT: "policy rollout", INCIDENT: "incident", ABUSE: "abuse", OTHER: "other",
};

const reasonWord = (code: string): string => OPERATOR_REASON_LABEL[code] ?? code;

export function OperatorActionsGroup({ operators, nowMs }: { operators: Fetched<OperatorActionsResponse>; nowMs: number }) {
  return (
    <SourceGate source="Operator actions" fetched={operators}>
      {(d) => (
        <div>
          {d.events.length === 0 ? (
            <p role="status" className="text-xs text-[var(--text-secondary)]">{feedDepthText(0, "operator actions")}</p>
          ) : (
            <ul className="flex flex-col">
              {d.events.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 border-b px-1 py-2 last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
                  <TwoLine value={OPERATOR_ACTION_LABEL[e.action] ?? e.action} qualifier={operatorLine(e, reasonWord)} />
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {/* The result is a WORD in its tone; a success is the quiet default and is not badged. */}
                    {e.result && e.result !== "SUCCESS" && <ToneBadge word={OPERATOR_RESULT_WORD[e.result]} tone={OPERATOR_RESULT_TONE[e.result]} />}
                    <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{relTime(e.at, nowMs)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {d.events.length > 0 && <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-faint)]">{feedDepthText(d.events.length, "operator actions")}</p>}
        </div>
      )}
    </SourceGate>
  );
}

/** Registry export for `sec_operator_actions` — absorbed into the Security posture surface; renders nothing. */
/** Platform redesign §4.9 — the Operator actions workspace, the single home of the operator feed. */
export const OPERATOR_ACTIONS_SURFACE_TITLE = "Operator actions";

/** Registry export for `sec_operator_actions` — the Security › Operator actions workspace. */
export function SecOperatorActionsWidget(_props: { section: PlatformSection }) {
  const operators = useWidgetFetch<OperatorActionsResponse>("/api/platform/security-ops/operator-actions");
  const [nowMs] = useState(() => Date.now());
  return (
    <SectionSurface icon={UserCog} title={OPERATOR_ACTIONS_SURFACE_TITLE}>
      <OperatorActionsGroup operators={operators} nowMs={nowMs} />
    </SectionSurface>
  );
}
