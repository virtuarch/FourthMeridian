"use client";

/**
 * components/platform/widgets/OpsRefreshSummaryWidget.tsx  (OPS-2C-2 · ops_refresh_summary)
 *
 * Refresh execution outcomes + the per-endpoint stage roll-up, over
 * GET /api/platform/platform-ops/refresh/summary (requirePlatformAccess
 * PLATFORM_OPS READ). Presentation-only: every count, duration and tier arrives
 * precomputed from the refresh projection — this widget derives nothing and
 * imports no projection module, no Prisma, and no ledger authority.
 *
 * HONESTY: `tier: "unknown"` means the projection observed no rows, and renders
 * as an explicit "not observed" state — never as healthy, never as zeros. The
 * window's reproducibility line is always shown, so an open window can never be
 * mistaken for a settled one.
 */

import { RefreshCw } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { RefreshSummary } from "@/lib/platform/refresh/types";
import {
  describeWindow,
  formatDuration,
  formatNullable,
  isUnobserved,
  tallyEntries,
} from "./refresh-format";

export function OpsRefreshSummaryWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<RefreshSummary>(
    "/api/platform/platform-ops/refresh/summary",
  );

  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={RefreshCw}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }

  const win = describeWindow(data);
  const unobserved = isUnobserved(data.tier);

  return (
    <PlatformWidgetCard label={section.label} icon={RefreshCw}>
      <p className="text-[11px] text-[var(--text-muted)]">
        {win.window} ·{" "}
        <span style={{ color: win.reproducible ? "var(--text-muted)" : "var(--brass-300, #d9b25a)" }}>
          {win.detail}
        </span>
      </p>

      {unobserved ? (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          No refresh executions recorded in this window — <em>not observed</em>. This is
          an absence of evidence, not a healthy result.
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-[var(--text-secondary)] tabular-nums">
            {data.executions} execution{data.executions === 1 ? "" : "s"} · mean{" "}
            {formatDuration(data.meanDurationMs)} · max {formatDuration(data.maxDurationMs)}
            {data.openExecutions > 0 && (
              <span style={{ color: "var(--brass-300, #d9b25a)" }}>
                {" "}
                · {data.openExecutions} still running
              </span>
            )}
          </p>

          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">
            {tallyEntries(data.byStatus).map((e) => (
              <li key={e.key} className="tabular-nums">
                {e.key} <span className="text-[var(--text-primary)]">{e.count}</span>
              </li>
            ))}
          </ul>

          {data.endpoints.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {data.endpoints.map((ep) => (
                <li
                  key={ep.endpoint}
                  className="flex items-center justify-between gap-2 text-xs"
                  title={`${ep.stageKinds.join(" / ")} · ${ep.attempted} attempted`}
                >
                  <span className="truncate text-[var(--text-primary)]">{ep.endpoint}</span>
                  <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                    {ep.succeeded}/{ep.attempted} ok
                    {ep.failed > 0 && (
                      <span style={{ color: "var(--accent-negative, #f87171)" }}> · {ep.failed} failed</span>
                    )}
                    {ep.skipped > 0 && <span className="text-[var(--text-muted)]"> · {ep.skipped} skipped</span>}
                    <span className="text-[var(--text-muted)]"> · Δ{formatNullable(ep.recordsChanged)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
