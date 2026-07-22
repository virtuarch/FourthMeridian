"use client";

/**
 * components/platform/widgets/OpsEmailDeliveryWidget.tsx  (PO-5A)
 *
 * Beta email-delivery visibility: sent / captured / error counts over the last
 * 7 days from the NotificationDelivery ledger, plus recent errors. "Captured"
 * is called out because in production it means emails fell back to capture
 * (RESEND_API_KEY unset/failing) and did NOT actually send — the exact silent
 * failure this widget exists to make visible. Metadata only.
 */

import { Mail } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, WidgetStat, useWidgetFetch, timeAgo, type PlatformSection } from "@/components/platform/widget-kit";
import type { EmailHealthResponse } from "@/app/api/platform/platform-ops/email-health/route";

export function OpsEmailDeliveryWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<EmailHealthResponse>("/api/platform/platform-ops/email-health");

  return (
    <PlatformWidgetCard label={section.label} icon={Mail}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.counts.sent} label="Sent" />
            <WidgetStat value={data.counts.captured} label="Captured" />
            <WidgetStat value={data.counts.error} label="Errors" />
          </div>

          {data.counts.total === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]">No email activity in the last {data.windowDays} days.</p>
          ) : data.counts.captured > 0 ? (
            <p className="rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[11px] leading-snug"
               style={{ color: "var(--accent-warning,#f59e0b)", borderColor: "rgba(245,158,11,.28)", background: "rgba(245,158,11,.08)" }}>
              {data.counts.captured} email(s) were CAPTURED, not sent — in production this means email delivery is not configured (RESEND_API_KEY). Check the Environment widget.
            </p>
          ) : (
            <p className="text-xs text-[var(--text-secondary)]">All emails delivered in the last {data.windowDays} days.</p>
          )}

          {data.recentErrors.length > 0 && (
            <ul className="-mx-1 divide-y divide-[var(--border-hairline)]">
              {data.recentErrors.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-2 px-1 py-1.5">
                  <span className="min-w-0 truncate text-[11px] text-[var(--text-secondary)]">{e.error}</span>
                  <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{timeAgo(e.at)} ago</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
