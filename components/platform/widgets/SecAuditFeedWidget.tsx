"use client";

/**
 * components/platform/widgets/SecAuditFeedWidget.tsx  (PO1.1 · sec_audit_feed)
 *
 * Recent security-relevant audit activity, over
 * GET /api/platform/security-ops/audit (requirePlatformAccess SECURITY_OPS READ).
 * A short recent-activity list — action, actor, relative time.
 */

import { ScrollText } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  useWidgetFetch,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformAuditResponse } from "@/app/api/platform/security-ops/audit/route";

/** "TWO_FACTOR_ENABLED" → "Two factor enabled". Display only. */
function humanizeAction(action: string): string {
  const s = action.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function SecAuditFeedWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformAuditResponse>("/api/platform/security-ops/audit");

  return (
    <PlatformWidgetCard label={section.label} icon={ScrollText}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : data.events.length === 0 ? (
        <WidgetMessage empty="No recent security events." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {data.events.slice(0, 8).map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-[var(--text-primary)] truncate">
                {humanizeAction(e.action)}
                <span className="text-[var(--text-secondary)]"> · {e.actor}</span>
              </span>
              <span className="text-[var(--text-muted)] tabular-nums shrink-0">{timeAgo(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </PlatformWidgetCard>
  );
}
