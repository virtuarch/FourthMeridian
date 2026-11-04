"use client";

/**
 * components/platform/widgets/OpsRefreshSummaryWidget.tsx  (OPS-2C-2 · ops_refresh_summary · UX-P1 page grain)
 *
 * Refresh execution outcomes + the per-endpoint stage roll-up, over
 * GET /api/platform/platform-ops/refresh/summary (requirePlatformAccess
 * PLATFORM_OPS READ). Presentation-only: every count, duration and tier arrives
 * precomputed from the refresh projection — this widget derives nothing and
 * imports no projection module, no Prisma, and no ledger authority.
 *
 * UX-P1 — the surface moved from the card grain to the page grain: one
 * SectionSurface, the envelope as its scope line, one BigStat for the
 * execution count, the two composition strips (status owns colour, trigger
 * does not) through the SAME view map the Overview's Refresh activity block
 * uses (`refresh-activity-view.ts`), and the endpoint roll-up as the house
 * grid-row table rather than a list of sentences.
 *
 * HONESTY: `tier: "unknown"` means the projection observed no rows, and renders
 * as an explicit "not observed" state — never as healthy, never as zeros. The
 * window's reproducibility line is always shown, so an open window can never be
 * mistaken for a settled one. Δ records is `—` when no stage reported one;
 * null is not zero.
 */

import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { BigStat, DistributionBar, SectionSurface, TONE_COLOR } from "../platform-surface";
import type { EndpointRollup, RefreshSummary } from "@/lib/platform/refresh/types";
import { describeWindow, formatDuration, formatNullable, isUnobserved } from "./refresh-format";
import { envelopeCaption, statusSegments, triggerSegments } from "./refresh-activity-view";

const FOOTNOTE =
  "Counts are the projection's own over its window. The endpoint roll-up counts stage rows — not accounts and not provider calls; a stage can succeed after failed provider attempts. Δ records sums the changes stages reported; — means no stage reported one, which is not zero.";

/** One grid definition, shared by the header and every row. */
const COLS = "minmax(0,1.6fr) 6.5rem 5rem 5rem 6rem";
const HEADINGS = ["Endpoint", "OK / attempted", "Failed", "Skipped", "Δ records"] as const;

/** A fact cell below `md` carries its own label; at `md` the column header carries it. */
function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5 md:block">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)] md:hidden">{label}</span>
      {children}
    </span>
  );
}

/** The endpoint roll-up as grid rows. Exported for the Pipeline render proof. */
export function EndpointRollupRows({ endpoints }: { endpoints: readonly EndpointRollup[] }) {
  return (
    <div className="overflow-x-auto">
      <div
        className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid"
        style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)" }}
      >
        {HEADINGS.map((h) => (
          <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{h}</span>
        ))}
      </div>
      <ul className="flex flex-col">
        {endpoints.map((ep) => (
          <li
            key={ep.endpoint}
            className="flex flex-col gap-1 border-b px-1 py-2 last:border-b-0 md:grid md:items-center md:gap-3"
            style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)" }}
            title={`${ep.stageKinds.join(" / ")} · ${ep.attempted} attempted`}
          >
            <span className="text-xs font-medium text-[var(--text-primary)]">{ep.endpoint}</span>
            <div className="flex flex-wrap gap-x-5 gap-y-1 md:contents">
              <Labelled label="OK / attempted">
                <span className="text-xs tabular-nums text-[var(--text-primary)]">{ep.succeeded}/{ep.attempted}</span>
              </Labelled>
              <Labelled label="Failed">
                <span className="text-xs tabular-nums" style={{ color: ep.failed > 0 ? TONE_COLOR.bad : "var(--text-muted)" }}>{ep.failed}</span>
              </Labelled>
              <Labelled label="Skipped">
                <span className="text-xs tabular-nums text-[var(--text-muted)]">{ep.skipped}</span>
              </Labelled>
              <Labelled label="Δ records">
                <span className="text-xs tabular-nums text-[var(--text-secondary)]">{formatNullable(ep.recordsChanged)}</span>
              </Labelled>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The surface, given a fetch RESULT rather than performing one (renderable in every state). */
export function RefreshSummarySurface({
  title,
  data,
  loading,
  error,
}: {
  title: string;
  data: RefreshSummary | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading || error || !data) {
    return (
      <SectionSurface icon={RefreshCw} title={title}>
        <WidgetMessage loading={loading} error={error} />
      </SectionSurface>
    );
  }

  const win = describeWindow(data);
  const unobserved = isUnobserved(data.tier);

  return (
    <SectionSurface
      icon={RefreshCw}
      title={title}
      actions={
        <p className="text-[11px] text-[var(--text-muted)]">
          {win.window} ·{" "}
          <span style={{ color: win.reproducible ? "var(--text-muted)" : "var(--brass-300)" }}>{win.detail}</span>
        </p>
      }
      footnote={FOOTNOTE}
    >
      {unobserved ? (
        <p className="text-xs text-[var(--text-muted)]">
          No refresh executions recorded in this window — <em>not observed</em>. This is
          an absence of evidence, not a healthy result.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          <div className="grid gap-6 md:grid-cols-[auto_1fr] md:gap-10">
            <BigStat
              label="Executions"
              value={data.executions}
              qualifier={`mean ${formatDuration(data.meanDurationMs)} · max ${formatDuration(data.maxDurationMs)}${
                data.openExecutions > 0 ? ` · ${data.openExecutions} still running` : ""
              }`}
              derivation={`${data.withParentJob} under a batch parent · ${envelopeCaption(data)}`}
            />
            <div className="grid gap-6 md:grid-cols-2">
              <DistributionBar label="By status" segments={statusSegments(data.byStatus, data.recovered ?? 0)} />
              <DistributionBar label="By trigger" segments={triggerSegments(data.byTrigger)} />
            </div>
          </div>

          {data.endpoints.length > 0 && <EndpointRollupRows endpoints={data.endpoints} />}
        </div>
      )}
    </SectionSurface>
  );
}

export function OpsRefreshSummaryWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<RefreshSummary>(
    "/api/platform/platform-ops/refresh/summary",
  );
  return <RefreshSummarySurface title={section.label} data={data} loading={loading} error={error} />;
}
