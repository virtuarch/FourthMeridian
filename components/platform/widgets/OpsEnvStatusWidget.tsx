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
import { TONE_COLOR } from "../platform-surface";
import { openAiFactLines } from "./env-status-view";

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
              All checked variables set ({data.deploymentEnv}).
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
          {/* OPENAI ENVIRONMENT SEPARATION — the value-free OpenAI project pin:
              key SHAPE, the proj_… id in full (a non-secret identifier) and the
              expected-environment guard. Never the key. */}
          <div className="mt-2 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] pt-2">
            <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">OpenAI project pin</p>
            <ul className="flex flex-col gap-1">
              {openAiFactLines(data.openAi).map((line) => (
                <li key={line.label} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="shrink-0 text-[var(--text-secondary)]">{line.label}</span>
                  <span className="min-w-0 text-right font-mono break-all" style={{ color: TONE_COLOR[line.tone] }}>{line.value}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </PlatformWidgetCard>
  );
}
