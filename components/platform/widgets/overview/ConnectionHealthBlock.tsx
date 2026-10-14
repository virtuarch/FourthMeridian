"use client";

/**
 * components/platform/widgets/overview/ConnectionHealthBlock.tsx  (UX-P1 · Agent 3)
 *
 * "WHO OR WHAT IS AFFECTED?" — the Overview's connection block. The same row
 * renderer the Providers/Pipeline widget uses (connection-health-table.tsx),
 * over the authority's unhealthy list only, under the fleet composition bar,
 * with the owner column under the same CUSTOMER_SUCCESS rule (D4) and a
 * doorway into Providers, where the operator actions live. A row opens the
 * facts drawer; the WRITE buttons are deliberately NOT here — one place runs
 * a resync, and that place is the Providers workspace.
 *
 * Self-fetches over /platform-ops/connection-health (PLATFORM_OPS READ); one
 * SectionSurface; owns its loading / failed / all-healthy / populated states;
 * never returns null.
 */

import { useState } from "react";
import { PlugZap } from "lucide-react";
import { WidgetMessage, useWidgetFetch } from "../../widget-kit";
import { DistributionBar, SectionSurface } from "../../platform-surface";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { getPlatformWorkspace } from "@/lib/platform/workspaces";
import type { ConnectionHealthResponse } from "@/app/api/platform/platform-ops/connection-health/route";
import type { ConnectionHealthRow } from "@/lib/connections/health";
import type { OverviewBlockProps } from "./block-contract";
import { compositionCaption, compositionSegments, describeConnection, listCoverage, rowKey } from "../connection-health-view";
import { ConnectionFacts, ConnectionHealthTable, OwnerResolution } from "../connection-health-table";

export const CONNECTION_BLOCK_TITLE = "Connection health";
export const CONNECTION_BLOCK_WORKSPACE = "platform-providers";
export const CONNECTION_BLOCK_FOOTNOTE =
  "Unhealthy connections only, worst first, judged against the refresh policy's overdue threshold. " +
  "Owner labels come from Customer Success and appear only for operators holding that grant. " +
  "Resync and reauthorization are run from Providers.";

export function ConnectionHealthBlock({ onOpenWorkspace }: OverviewBlockProps) {
  const { data, loading, error } = useWidgetFetch<ConnectionHealthResponse>("/api/platform/platform-ops/connection-health");
  return <ConnectionHealthBlockSurface data={data} loading={loading} error={error} onOpenWorkspace={onOpenWorkspace} />;
}

/** The doorway out of the block and into Providers. Renders nothing without a
 *  host switcher or a registered workspace — a doorway that cannot open is
 *  worse than none. */
function Doorway({ onOpen }: { onOpen?: (workspaceId: string) => void }) {
  const def = getPlatformWorkspace(CONNECTION_BLOCK_WORKSPACE);
  if (!onOpen || !def) return null;
  return (
    <button
      type="button"
      onClick={() => onOpen(CONNECTION_BLOCK_WORKSPACE)}
      aria-label={`Open ${def.label} — connection actions`}
      className="rounded-[var(--radius-xs)] py-1 text-[11px] text-[var(--meridian-400)] transition-colors hover:text-[var(--meridian-300)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
    >
      Open {def.label} →
    </button>
  );
}

/** Prop-driven surface, so every state is renderable in a test. */
export function ConnectionHealthBlockSurface({
  data,
  loading,
  error,
  onOpenWorkspace,
  nowMs,
}: {
  data: ConnectionHealthResponse | null;
  loading: boolean;
  error: string | null;
  onOpenWorkspace?: (workspaceId: string) => void;
  nowMs?: number;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  if (loading || error || !data) {
    return (
      <SectionSurface icon={PlugZap} title={CONNECTION_BLOCK_TITLE} actions={<Doorway onOpen={onOpenWorkspace} />} footnote={CONNECTION_BLOCK_FOOTNOTE}>
        <WidgetMessage loading={loading} error={error} />
      </SectionSurface>
    );
  }

  const selected: ConnectionHealthRow | null = selectedKey ? data.unhealthy.find((r) => rowKey(r) === selectedKey) ?? null : null;
  const coverage = listCoverage(data);

  return (
    <SectionSurface icon={PlugZap} title={CONNECTION_BLOCK_TITLE} count={data.total} actions={<Doorway onOpen={onOpenWorkspace} />} footnote={CONNECTION_BLOCK_FOOTNOTE}>
      <div className="flex flex-col gap-6">
        <DistributionBar
          label="Fleet composition"
          segments={compositionSegments(data.counts)}
          caption={compositionCaption(data)}
          floor={coverage.capped}
          emptyText="no live connections — nothing is syncing for any customer"
        />

        {data.unhealthy.length === 0 ? (
          <p className="text-xs text-[var(--text-secondary)]">
            {data.total === 0 ? "No live connections to judge." : `All ${data.total} live connection${data.total === 1 ? "" : "s"} healthy under the current policy.`}
          </p>
        ) : (
          <OwnerResolution rows={data.unhealthy}>
            {(owners) => (
              <>
                <ConnectionHealthTable rows={data.unhealthy} owners={owners} checkedAt={data.checkedAt} nowMs={nowMs} onSelect={(row) => setSelectedKey(rowKey(row))} />
                <RightPanel open={selected != null} onClose={() => setSelectedKey(null)} ariaLabel="Connection detail">
                  {selected && (
                    <>
                      <PanelHeader eyebrow="Connection health" title={describeConnection(selected).title} />
                      <PanelContent>
                        <div className="flex flex-col gap-3 text-xs">
                          <ConnectionFacts row={selected} owner={owners?.get(rowKey(selected))} checkedAt={data.checkedAt} nowMs={nowMs} />
                          <p className="border-t border-[var(--border-hairline)] pt-3 text-[11px] leading-snug text-[var(--text-muted)]">
                            Operator actions (resync, request reauthorization) run from the Providers workspace.
                          </p>
                          <Doorway onOpen={onOpenWorkspace} />
                        </div>
                      </PanelContent>
                    </>
                  )}
                </RightPanel>
              </>
            )}
          </OwnerResolution>
        )}
      </div>
    </SectionSurface>
  );
}
