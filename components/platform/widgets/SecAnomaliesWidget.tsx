"use client";

/**
 * components/platform/widgets/SecAnomaliesWidget.tsx  (Wave 3 ⑧ · sec_anomalies)
 *
 * Real-time auth-anomaly trips over
 * GET /api/platform/security-ops/anomalies (requirePlatformAccess SECURITY_OPS READ).
 * A pulse stat (failed logins in the current window · trips in 24h) plus the
 * recent trip list — type, coarse key, relative time.
 */

import { ShieldAlert } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import type { AnomaliesResponse } from "@/app/api/platform/security-ops/anomalies/route";

/** "failed_login_identifier" → "Failed login (identifier)". Display only. */
function humanizeType(type: string): string {
  switch (type) {
    case "failed_login_identifier": return "Failed-login burst (account)";
    case "failed_login_ip":         return "Failed-login burst (IP)";
    case "recovery_code_streak":    return "Invalid recovery-code streak";
    case "system_admin_disabled":   return "Disabled-admin probe";
    default:                        return type.replace(/_/g, " ");
  }
}

export function SecAnomaliesWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<AnomaliesResponse>("/api/platform/security-ops/anomalies");

  return (
    <PlatformWidgetCard label={section.label} icon={ShieldAlert}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex gap-4">
            <WidgetStat value={data.summary.failedLoginsWindow} label={`fails · ${data.summary.windowMinutes}m`} />
            <WidgetStat value={data.summary.tripsLast24h} label="trips · 24h" />
          </div>

          {data.trips.length === 0 ? (
            <WidgetMessage empty="No anomalies detected." />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {data.trips.slice(0, 6).map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-primary)] truncate">
                    {humanizeType(t.type)}
                    <span className="text-[var(--text-secondary)]"> · ×{t.count}</span>
                  </span>
                  <span className="text-[var(--text-muted)] tabular-nums shrink-0">{timeAgo(t.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PlatformWidgetCard>
  );
}
