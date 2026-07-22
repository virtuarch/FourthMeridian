"use client";

/**
 * components/platform/widgets/OpsEnvStatusWidget.tsx  (PO1.2 · ops_env_status)
 *
 * Environment configuration report, over GET /api/platform/platform-ops/env-status
 * (requirePlatformAccess PLATFORM_OPS READ). pass/warn/fail counts + a list of
 * any non-passing keys — NAMES only, never values.
 */

import { ServerCog } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformEnvStatusResponse } from "@/app/api/platform/platform-ops/env-status/route";

const STATUS_TONE: Record<string, string> = {
  fail: "var(--danger-400, #f87171)",
  warn: "var(--brass-300, #d6b25e)",
  pass: "var(--text-muted)",
};

export function OpsEnvStatusWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformEnvStatusResponse>("/api/platform/platform-ops/env-status");

  const attention = data?.keys.filter((k) => k.status !== "pass") ?? [];

  return (
    <PlatformWidgetCard label={section.label} icon={ServerCog}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.counts.pass} label="Pass" />
            <WidgetStat value={data.counts.warn} label="Warn" />
            <WidgetStat value={data.counts.fail} label="Fail" />
          </div>
          {attention.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              All checked variables set ({data.nodeEnv}).
            </p>
          ) : (
            <ul className="flex flex-col gap-1 mt-1">
              {attention.map((k) => (
                <li key={k.key} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-secondary)] truncate font-mono">{k.key}</span>
                  <span className="shrink-0 uppercase tracking-wide" style={{ color: STATUS_TONE[k.status] }}>
                    {k.status}
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
