"use client";

/**
 * components/platform/widgets/OpsRefreshCoverageWidget.tsx  (OPS-2C-2 · ops_refresh_coverage)
 *
 * Per-endpoint account coverage, over
 * GET /api/platform/platform-ops/refresh/coverage (requirePlatformAccess
 * PLATFORM_OPS READ).
 *
 * ── TWO HONESTY RULES, BOTH LOAD-BEARING ──────────────────────────────────────
 * 1. ABSENCE IS NOT 0% COVERAGE. When the projection observed no rows
 *    (`tier: "unknown"`) this renders "not observed" and shows NO percentage.
 *    A "0% covered" on an empty ledger would assert a measurement nobody made.
 *    Once rows exist, a genuine zero IS shown — `ratio()` returns null only when
 *    the denominator is zero, never for a real counted zero.
 * 2. THIS IS NOT A STALENESS VERDICT. DF-2E ships coverage facts and the reason
 *    vocabulary; deciding "stale now" needs a per-endpoint cadence authority
 *    that does not exist. The widget shows what was covered and when freshness
 *    last advanced, and stops there.
 */

import { Target } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { CoverageSummary } from "@/lib/platform/refresh/types";
import { describeWindow, humanizeToken, isUnobserved, ratio, tallyEntries } from "./refresh-format";

export function OpsRefreshCoverageWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<CoverageSummary>(
    "/api/platform/platform-ops/refresh/coverage",
  );

  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={Target}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }

  const win = describeWindow(data);
  const unobserved = isUnobserved(data.tier);

  return (
    <PlatformWidgetCard label={section.label} icon={Target}>
      <p className="text-[11px] text-[var(--text-muted)]">
        {win.window} ·{" "}
        <span style={{ color: win.reproducible ? "var(--text-muted)" : "var(--brass-300, #d9b25a)" }}>
          {win.detail}
        </span>
      </p>

      {unobserved ? (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          No per-account coverage recorded — <em>not observed</em>. No percentage is shown,
          because none was measured. Absence of a coverage row never means an account is
          fresh, and never means it is stale.
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-[var(--text-secondary)] tabular-nums">
            {data.distinctAccounts} account{data.distinctAccounts === 1 ? "" : "s"} evaluated
            across {data.endpoints.length} endpoint{data.endpoints.length === 1 ? "" : "s"}
          </p>

          <ul className="mt-2 flex flex-col gap-1">
            {data.endpoints.map((ep) => {
              const total = ep.covered + ep.skipped + ep.failed;
              const pct = ratio(ep.covered, total);
              return (
                <li key={ep.endpoint} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-[var(--text-primary)]">{ep.endpoint}</span>
                  <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                    {ep.covered} covered
                    {pct != null && <span className="text-[var(--text-muted)]"> ({pct}%)</span>}
                    {ep.skipped > 0 && <span className="text-[var(--text-muted)]"> · {ep.skipped} skipped</span>}
                    {ep.failed > 0 && (
                      <span style={{ color: "var(--accent-negative, #f87171)" }}> · {ep.failed} failed</span>
                    )}
                    <span className="text-[var(--text-muted)]"> · {ep.freshnessAdvanced} fresh</span>
                  </span>
                </li>
              );
            })}
          </ul>

          {data.endpoints.some((ep) => Object.keys(ep.reasons).length > 0) && (
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
              {data.endpoints.flatMap((ep) =>
                tallyEntries(ep.reasons).map((r) => (
                  <li key={`${ep.endpoint}:${r.key}`} className="tabular-nums">
                    {humanizeToken(r.key)} <span className="text-[var(--text-secondary)]">{r.count}</span>
                  </li>
                )),
              )}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
