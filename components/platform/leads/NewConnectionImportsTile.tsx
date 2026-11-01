"use client";

/**
 * components/platform/leads/NewConnectionImportsTile.tsx  (PB-7)
 *
 * Platform Ops › Pipeline — "New-connection imports (7 d)": started ·
 * completed · recovered · in progress · failed. COUNTS ONLY (Platform Ops is
 * identity-free by ruling); the route returns no item, institution or owner.
 * "Recovered" = the first pass was interrupted (e.g. killed at the function
 * limit) and a later run — typically resume-stale-imports — completed it.
 */

import { KpiTile, ProvenanceChip } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import type { NewConnectionImportsResponse } from "@/app/api/platform/platform-ops/new-connection-imports/route";
import { IMPORT_REASON_LABELS, type ImportReasonCategory } from "@/lib/platform/onboarding/import-status-core";
import { importTileFigures } from "../widgets/onboarding-view";
import { LeadSection } from "./lead-kit";

export const NEW_CONNECTION_IMPORTS_URL = "/api/platform/platform-ops/new-connection-imports";

const n = (v: number) => v.toLocaleString("en-US");

export function NewConnectionImportsTile() {
  const f = useSharedWidgetFetch<NewConnectionImportsResponse>(NEW_CONNECTION_IMPORTS_URL);
  return <NewConnectionImportsSurface data={f.data} loading={f.loading} error={f.error} />;
}

export function NewConnectionImportsSurface({ data, loading, error }: { data: NewConnectionImportsResponse | null; loading: boolean; error: string | null }) {
  const reason = loading ? "reading…" : `unavailable${error ? ` — ${error}` : ""}`;
  const figures = data ? importTileFigures(data.byStatus, data.started) : null;
  const failedWhy = data ? (Object.entries(data.failedReasons) as [ImportReasonCategory, number][]).map(([k, v]) => `${n(v)} ${IMPORT_REASON_LABELS[k]}`).join(" · ") : "";
  return (
    <LeadSection title={`New-connection imports (${data?.windowDays ?? 7} d)`}>
      <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-5" data-new-connection-imports>
        {(figures ?? importTileFigures({ complete: 0, recovered: 0, in_progress: 0, failed: 0, removed: 0 }, 0)).map((k) => (
          <KpiTile key={k.key} label={k.label} value={figures ? `${data!.floor ? "≥" : ""}${n(k.value)}` : null} unavailableReason={reason}
            note={k.key === "failed" && failedWhy ? failedWhy : k.key === "in_progress" && data && data.interruptedInProgress > 0 ? `${n(data.interruptedInProgress)} awaiting resume` : undefined}
            provenance={figures ? <ProvenanceChip kind="MEASURED" asOf={data!.checkedAt} /> : undefined} />
        ))}
      </div>
      {data && <p className="mt-2 text-[11px] text-[var(--text-muted)]">{data.notes[0]}</p>}
    </LeadSection>
  );
}
