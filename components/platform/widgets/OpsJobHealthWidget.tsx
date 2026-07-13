"use client";

/**
 * components/platform/widgets/OpsJobHealthWidget.tsx  (PO1.2 · ops_job_health)
 *
 * Scheduled-job health, over GET /api/platform/platform-ops/job-health
 * (requirePlatformAccess PLATFORM_OPS READ). Headline healthy/total + a short
 * list of any unhealthy jobs.
 */

import { Activity } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformJobHealthResponse } from "@/app/api/platform/platform-ops/job-health/route";

const STATUS_LABEL: Record<string, string> = {
  overdue:     "Overdue",
  failing:     "Failing",
  "never-ran": "Never ran",
  healthy:     "Healthy",
};

export function OpsJobHealthWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformJobHealthResponse>("/api/platform/platform-ops/job-health");

  const unhealthy = data?.jobs.filter((j) => j.status !== "healthy") ?? [];

  return (
    <PlatformWidgetCard label={section.label} icon={Activity}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.counts.healthy} label="Healthy" />
            <WidgetStat value={data.counts.overdue + data.counts.failing} label="Unhealthy" />
            <WidgetStat value={data.counts.neverRan} label="Never ran" />
          </div>
          {unhealthy.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] mt-1">All scheduled jobs healthy.</p>
          ) : (
            <ul className="flex flex-col gap-1 mt-1">
              {unhealthy.map((j) => (
                <li key={j.job} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-primary)] truncate">{j.job}</span>
                  <span className="text-[var(--text-muted)] shrink-0">{STATUS_LABEL[j.status] ?? j.status}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
