"use client";

/**
 * components/platform/leads/PolicyGroupHistory.tsx  (POLICY EDITOR — history + exposure)
 *
 * The group detail's lower half, for EVERY Policies reader: the immutable
 * version history (version · when · who · what changed) and the cost exposure
 * (estimated ceiling of AI spend per day for the group's customers; the
 * measured 30-day spend says "not yet available" — never invented).
 *
 * "Restore this version" renders only when the host hands `onRestore` (the
 * editor decides that from the operator's access; this component never reads
 * an access flag). Restoring opens the editor's review step — it never writes
 * from here.
 *
 * Reads GET /api/platform/platform-ops/policy-groups/[key] (PLATFORM_OPS READ).
 */

import { History, RotateCcw } from "lucide-react";
import type { PolicyGroupDetailResponse } from "@/lib/platform/policies/policy-group-detail";
import { useSharedWidgetFetch } from "../workspace-session";
import { costExposure, customersAffectedLine, ESTIMATED_CEILING_LABEL, versionSummaryText } from "./policy-editor-model";

export const groupDetailUrl = (key: string) => `/api/platform/platform-ops/policy-groups/${encodeURIComponent(key)}`;

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const H3 = "text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]";

/** PURE presentation (prop-driven; renders in a test). */
export function PolicyGroupHistoryView({ detail, loading, error, onRestore }: {
  detail: PolicyGroupDetailResponse | null;
  loading: boolean;
  error: string | null;
  onRestore?: (version: number) => void;
}) {
  if (!detail) {
    return <p className="text-[11px] text-[var(--text-muted)]">{loading ? "Reading version history…" : `Version history unavailable${error ? ` — ${error}` : ""}`}</p>;
  }
  const cost = costExposure(detail, null, Number(detail.group.values?.aiDailyUsdAllowance ?? 0));
  const versions = detail.versions;
  return (
    <div className="flex min-w-0 flex-col gap-6" data-group-history={detail.group.key}>
      <section aria-label="Cost exposure" className="flex min-w-0 flex-col gap-2">
        <h3 className={H3}>Cost exposure</h3>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]" data-cost-ceiling>
            {detail.group.valid ? cost.after : "—"}
          </span>
          <span className="text-[11px] text-[var(--text-muted)]">{ESTIMATED_CEILING_LABEL} · max estimated AI spend / day</span>
        </div>
        <p className="text-[11px] text-[var(--text-muted)]">{customersAffectedLine(detail)}</p>
        <p className="text-[11px] text-[var(--text-faint)]" data-measured-spend>{cost.measured}</p>
      </section>
      <section aria-label="Version history" className="flex min-w-0 flex-col gap-2">
        <h3 className={`${H3} flex items-center gap-1.5`}><History size={12} aria-hidden /> Version history</h3>
        {versions.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)]">Defined in code — no stored versions yet.</p>
        ) : (
          <ol aria-label="Versions" className="flex flex-col">
            {versions.map((v) => (
              <li key={v.version} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-hairline)] py-2 first:border-t-0" data-version={v.version}>
                <span className="w-8 shrink-0 text-xs font-medium tabular-nums text-[var(--text-primary)]">v{v.version}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-[var(--text-secondary)]">{versionSummaryText(v.summary)}</span>
                  <span className="block truncate text-[10px] tabular-nums text-[var(--text-faint)]">{when(v.createdAt)} · {v.createdBy} · {v.reasonCode.replace(/_/g, " ").toLowerCase()}</span>
                </span>
                {v.current ? (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Current</span>
                ) : onRestore && v.restorable && !detail.group.archived ? (
                  <button type="button" onClick={() => onRestore(v.version)} data-restore-version={v.version}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border border-[var(--border-hairline)] px-2.5 text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-inset)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-7">
                    <RotateCcw size={11} aria-hidden /> Restore this version
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {detail.versionsTruncated && <p className="text-[10px] text-[var(--text-faint)]">Showing the latest {versions.length} versions.</p>}
      </section>
    </div>
  );
}

/** Reads the group detail into the shared session and renders it. */
export function PolicyGroupHistory({ groupKey, onRestore }: { groupKey: string; onRestore?: (version: number) => void }) {
  const detail = useSharedWidgetFetch<PolicyGroupDetailResponse>(groupDetailUrl(groupKey));
  return <PolicyGroupHistoryView detail={detail.data} loading={detail.loading} error={detail.error} onRestore={onRestore} />;
}
