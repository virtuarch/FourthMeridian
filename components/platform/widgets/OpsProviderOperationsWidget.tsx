"use client";

/**
 * components/platform/widgets/OpsProviderOperationsWidget.tsx  (OPS-2C-5 · ops_provider_operations)
 *
 * Observed provider behaviour DURING refresh executions, over
 * GET /api/platform/platform-ops/refresh/provider-operations
 * (requirePlatformAccess PLATFORM_OPS READ). Every value arrives precomputed from
 * the Provider Operation Summary projection; this widget derives nothing and
 * imports no projection, Prisma, or ledger authority.
 *
 * ── THREE ADJACENT SURFACES, THREE DIFFERENT QUESTIONS ────────────────────────
 * This sits in the Providers workspace beside two others. They are independent
 * authorities and neither is recomputed from the other:
 *
 *   Provider Health      what is the provider's health interpretation?
 *                        (provider-health.ts trust — the canonical authority)
 *   Provider Operations  how did the provider actually behave when we called it?
 *                        (THIS — ProviderCall attempts inside refresh executions)
 *   API Usage            how much of the provider are we consuming over time?
 *                        (ApiUsageCounter volume + tokens)
 *
 * ── WHY THE LEADING METRIC IS DELIBERATELY NOT A CALL COUNT ───────────────────
 * API Usage already leads with per-provider call volume. Its population and this
 * one's are NOT the same and never will be: ApiUsageCounter counts EVERY provider
 * call (link tokens, token exchange, item removal, the connect fast slice), while
 * ProviderCall counts only calls made INSIDE a refresh execution. Two adjacent
 * cards each leading with "N calls" would invite an operator to reconcile numbers
 * that are not meant to reconcile. So this card leads with OUTCOMES and LATENCY
 * per operation, and the attempt count appears only as trailing detail on a row.
 *
 * ── IT IS NOT A HEALTH AUTHORITY ──────────────────────────────────────────────
 * No verdict is computed here, and rows are never re-ranked by failure — the
 * projection's stable (provider, operation) order is preserved, because a
 * "worst-first" ordering would be an unowned health judgement. Failures are shown
 * as counts, which is evidence; concluding what they mean is Provider Health's job.
 */

import { Activity } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { ProviderOperationSummary } from "@/lib/platform/refresh/types";
import {
  describeAttempts,
  describeWindow,
  formatDuration,
  isUnobserved,
  operationLabel,
} from "./refresh-format";

export function OpsProviderOperationsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ProviderOperationSummary>(
    "/api/platform/platform-ops/refresh/provider-operations",
  );

  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={Activity}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }

  const win = describeWindow(data);
  const unobserved = isUnobserved(data.tier);

  return (
    <PlatformWidgetCard label={section.label} icon={Activity}>
      {/* Restrained framing: names the population, not a manual. */}
      <p className="text-[11px] text-[var(--text-muted)]">
        Observed during refresh executions · {win.window} ·{" "}
        <span style={{ color: win.reproducible ? "var(--text-muted)" : "var(--brass-300, #d9b25a)" }}>
          {win.detail}
        </span>
      </p>

      {unobserved ? (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          No provider operations recorded — <em>not observed</em>. No calls were attributed to
          a refresh execution in this window; that is not evidence the provider behaved well.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {data.operations.map((op) => {
            const attempts = describeAttempts(op);
            return (
              <li key={`${op.provider}:${op.operation}`} className="flex flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-[var(--text-primary)]">{operationLabel(op)}</span>
                  {/* OUTCOMES lead. Attempts are trailing detail, never the headline. */}
                  <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                    {op.failed > 0 && (
                      <span style={{ color: "var(--accent-negative, #f87171)" }}>{op.failed} failed · </span>
                    )}
                    {op.rateLimited > 0 && (
                      <span style={{ color: "var(--brass-300, #d9b25a)" }}>{op.rateLimited} rate-limited · </span>
                    )}
                    <span>{op.succeeded} ok</span>
                    <span className="text-[var(--text-muted)]">
                      {" "}
                      · {formatDuration(op.meanDurationMs)} avg · {formatDuration(op.maxDurationMs)} max
                    </span>
                  </span>
                </span>
                {attempts && (
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {attempts}
                    {op.paginationConfounded && " — not a retry rate"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PlatformWidgetCard>
  );
}
