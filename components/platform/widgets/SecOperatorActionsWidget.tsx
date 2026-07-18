"use client";

/**
 * components/platform/widgets/SecOperatorActionsWidget.tsx  (PO-3A · sec_operator_actions)
 *
 * The "what did operators do?" feed, over GET
 * /api/platform/security-ops/operator-actions (requirePlatformAccess
 * SECURITY_OPS READ). Distinct from SecAuditFeedWidget (end-user auth events):
 * this surfaces operator-performed platform actions — grant changes, manual
 * operations, beta decisions, operator account state changes — each attributed
 * to the acting operator (performedByAdminId). Read-only; no actions here.
 */

import { UserCog } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  timeAgo,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { OperatorActionsResponse } from "@/app/api/platform/security-ops/operator-actions/route";

/** Humanize the audit action into a short operator-verb. Unknown → the raw action. */
const ACTION_LABEL: Record<string, string> = {
  PLATFORM_GRANT_CREATED:       "Granted platform access",
  PLATFORM_GRANT_LEVEL_CHANGED: "Changed access level",
  PLATFORM_GRANT_REVOKED:       "Revoked platform access",
  PLATFORM_GRANT_REINSTATED:    "Reinstated platform access",
  PLATFORM_OPERATION_EXECUTED:  "Ran a manual operation",
  PLATFORM_OPERATION_DRY_RUN:   "Dry-ran an operation",
  BETA_ACCESS_APPROVED:         "Approved a beta request",
  BETA_ACCESS_DENIED:           "Denied a beta request",
  BETA_MODE_CHANGED:            "Changed signup mode",
  BETA_INVITATION_CREATED:      "Sent a direct invitation",
  BETA_INVITATION_RESENT:       "Resent an invitation",
  BETA_INVITATION_REVOKED:      "Revoked an invitation",
  PRODUCT_STATUS_CHANGED:       "Changed product status",
  ACCOUNT_DEACTIVATED:          "Deactivated an account",
  ACCOUNT_REACTIVATED:          "Reactivated an account",
};

export function SecOperatorActionsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<OperatorActionsResponse>(
    "/api/platform/security-ops/operator-actions",
  );

  return (
    <PlatformWidgetCard label={section.label} icon={UserCog}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : data.events.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">No operator actions recorded.</p>
      ) : (
        <ul className="-mx-1 divide-y divide-[var(--border-hairline)]">
          {data.events.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 px-1 py-2">
              <span className="min-w-0">
                <span className="text-xs font-medium text-[var(--text-primary)]">
                  {ACTION_LABEL[e.action] ?? e.action}
                </span>
                <span className="block text-[11px] text-[var(--text-muted)] truncate">
                  {e.operator}
                  {/* Show "→ target" only when the target differs from the actor
                      (a platform-setting change like mode has no distinct subject). */}
                  {e.target && e.target !== e.operator ? ` → ${e.target}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-faint)]">{timeAgo(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </PlatformWidgetCard>
  );
}
