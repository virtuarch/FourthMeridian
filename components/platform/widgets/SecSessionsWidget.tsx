"use client";

/**
 * components/platform/widgets/SecSessionsWidget.tsx  (PO1.1 · sec_sessions)
 *
 * Active-session activity, over GET /api/platform/security-ops/sessions
 * (requirePlatformAccess SECURITY_OPS READ). Live count + distinct users + a
 * short most-recently-active list (parsed device/browser only, no IP/UA/email).
 */

import { MonitorSmartphone } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformSessionsResponse } from "@/app/api/platform/security-ops/sessions/route";

export function SecSessionsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformSessionsResponse>("/api/platform/security-ops/sessions");

  return (
    <PlatformWidgetCard label={section.label} icon={MonitorSmartphone}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <WidgetStat value={data.totalActive} label="Active sessions" />
            <WidgetStat value={data.distinctUsers} label="Distinct users" />
          </div>
          {data.recent.length > 0 && (
            <ul className="flex flex-col gap-1 mt-1">
              {data.recent.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-secondary)] truncate">
                    {s.browser} · {s.device}
                  </span>
                  <span className="text-[var(--text-muted)] tabular-nums shrink-0">{timeAgo(s.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
