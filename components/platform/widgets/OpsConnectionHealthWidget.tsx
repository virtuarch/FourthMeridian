"use client";

/**
 * components/platform/widgets/OpsConnectionHealthWidget.tsx
 *   (Wave 2 S7 / CH-1 · ops_connection_health · PO-4A operator controls · UX-P1 table)
 *
 * Provider-connection health at PAGE grain, over
 * GET /api/platform/platform-ops/connection-health (PLATFORM_OPS READ). One
 * `SectionSurface`: the fleet composition as a DistributionBar, an All / Needs
 * action filter, and the shared connection table (connection-health-table.tsx)
 * over the authority's worst-first unhealthy list. A row opens the RightPanel
 * of FACTS (institution / provider / status / health / threshold / timestamps —
 * NO PII, never balances or transactions) with the two WRITE actions for Plaid
 * connections, rendered only when the operator's resolved access can write:
 *   - Resync now — re-run the per-item sync (PO-4A)
 *   - Request reauthorization — ask the customer to reconnect (never removes)
 * Both POST to requireFreshPlatformAccess(PLATFORM_OPS, WRITE) routes behind a
 * ConfirmDialog, then the surface REMOUNTS its reader (the keyed-fetch idiom)
 * so what it shows afterwards is the canonical read, not a client-side guess.
 *
 * OWNER COLUMN (owner decision D4): the fleet projection carries no identity.
 * `OwnerResolution` asks the separate CUSTOMER_SUCCESS route for the rows on
 * screen; the column exists only when that read returned 200. A 403 — the
 * common case for a PLATFORM_OPS-only operator — renders no column at all.
 *
 * Composed in Pipeline (platform-refresh) and Providers (platform-providers).
 */

import { useState } from "react";
import { PlugZap, RefreshCw, KeyRound, Loader2 } from "lucide-react";
import { WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { DistributionBar, PillGroup, SectionSurface, TONE_COLOR } from "../platform-surface";
import { RightPanel, PanelHeader, PanelContent, PanelFooter } from "@/components/atlas/panels";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import type { SpaceMountAccess } from "@/lib/space/mount-context";
import type { ConnectionHealthResponse } from "@/app/api/platform/platform-ops/connection-health/route";
import type { ConnectionHealthRow } from "@/lib/connections/health";
import {
  compositionCaption,
  compositionSegments,
  describeConnection,
  filterOptions,
  filterRows,
  listCoverage,
  rowKey,
  type ConnectionFilter,
} from "./connection-health-view";
import { ConnectionFacts, ConnectionHealthTable, OwnerResolution } from "./connection-health-table";

export const CONNECTION_HEALTH_FOOTNOTE =
  "Population: the live fleet — revoked connections and those whose owner is deactivated are retired, not unhealthy, and are named above when present. " +
  "STALE is judged against the refresh policy's overdue threshold, the same one the customer's Connections page and the Brief read. " +
  "Owner labels come from Customer Success and appear only for operators holding that grant; an email never leaves the Customer Success detail. " +
  "Resync and reauthorization run through the same lock and cooldown as the fleet and never remove a connection.";

type ActionKind = "resync" | "reauth";

export function OpsConnectionHealthWidget({ section, access }: { section: PlatformSection; onOpenWorkspace?: (id: string) => void; access?: SpaceMountAccess }) {
  // A mutation bumps the epoch, which REMOUNTS the reader below — the honest
  // refetch under the static-url contract of useWidgetFetch.
  const [epoch, setEpoch] = useState(0);
  const [filter, setFilter] = useState<ConnectionFilter>("all");
  return (
    <ConnectionHealthReader
      key={epoch}
      title={section.label}
      access={access}
      filter={filter}
      onFilter={setFilter}
      onMutated={() => setEpoch((e) => e + 1)}
    />
  );
}

function ConnectionHealthReader(props: Omit<Parameters<typeof ConnectionHealthSurface>[0], "data" | "loading" | "error">) {
  const { data, loading, error } = useWidgetFetch<ConnectionHealthResponse>("/api/platform/platform-ops/connection-health");
  return <ConnectionHealthSurface {...props} data={data} loading={loading} error={error} />;
}

/**
 * The whole surface, given a fetch RESULT rather than performing one — so the
 * loading, failed, all-healthy and populated states are renderable in a test.
 */
export function ConnectionHealthSurface({
  title,
  data,
  loading,
  error,
  access,
  filter,
  onFilter,
  onMutated,
  nowMs,
}: {
  title: string;
  data: ConnectionHealthResponse | null;
  loading: boolean;
  error: string | null;
  access?: SpaceMountAccess;
  filter: ConnectionFilter;
  onFilter: (f: ConnectionFilter) => void;
  /** Called after a successful WRITE; the host remounts the reader. */
  onMutated: () => void;
  /** Injected clock for the relative Last-sync words. Omitted in production. */
  nowMs?: number;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ActionKind | null>(null);
  const [acting, setActing] = useState<ActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading || error || !data) {
    return (
      <SectionSurface icon={PlugZap} title={title} footnote={CONNECTION_HEALTH_FOOTNOTE}>
        <WidgetMessage loading={loading} error={error} />
      </SectionSurface>
    );
  }

  const rows = filterRows(data.unhealthy, filter);
  const selected: ConnectionHealthRow | null = selectedKey ? data.unhealthy.find((r) => rowKey(r) === selectedKey) ?? null : null;
  const canWrite = access?.canWrite === true;
  const coverage = listCoverage(data);

  async function act(kind: ActionKind) {
    if (!selected) return;
    const path = kind === "resync" ? "resync" : "request-reauth";
    setActing(kind);
    setActionError(null);
    try {
      const r = await fetch(`/api/platform/platform-ops/connections/${selected.id}/${path}`, { method: "POST", credentials: "same-origin" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (r.status === 429 && body.retryAfterSeconds) throw new Error(`On cooldown — try again in ~${Math.ceil(body.retryAfterSeconds / 60)} min.`);
        if (r.status === 409 && body.error === "in-flight") throw new Error("A sync is already in flight for this connection.");
        // OPS-2D-3 — an admission denial carries a human label from the reason
        // registry; prefer it over the code.
        if (body.message) throw new Error(body.message as string);
        throw new Error(body.error ?? `Action failed (${r.status})`);
      }
      setConfirm(null);
      setSelectedKey(null);
      onMutated();
    } catch (e) {
      setConfirm(null);
      setActionError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActing(null);
    }
  }

  const canResync = selected?.availableActions.includes("resync") === true;
  const canReauth = selected?.availableActions.includes("request-reauth") === true;
  const isPlaid = selected?.source === "PLAID";

  return (
    <SectionSurface
      icon={PlugZap}
      title={title}
      count={data.total}
      actions={<PillGroup label="Connection filter" value={filter} options={filterOptions(data.unhealthy)} onChange={onFilter} />}
      footnote={CONNECTION_HEALTH_FOOTNOTE}
    >
      <div className="flex flex-col gap-6">
        {actionError && (
          <p
            role="alert"
            className="rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[11px]"
            style={{
              color: TONE_COLOR.bad,
              borderColor: "color-mix(in srgb, var(--coral-500) 28%, transparent)",
              background: "color-mix(in srgb, var(--coral-500) 8%, transparent)",
            }}
          >
            Last action failed — {actionError}
          </p>
        )}

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
                <ConnectionHealthTable
                  rows={rows}
                  owners={owners}
                  checkedAt={data.checkedAt}
                  nowMs={nowMs}
                  onSelect={(row) => { setActionError(null); setSelectedKey(rowKey(row)); }}
                  emptyMessage="No connection needs action — the remaining unhealthy rows are late, not faulted."
                />

                <RightPanel open={selected != null} onClose={() => setSelectedKey(null)} ariaLabel="Connection detail">
                  {selected && (
                    <>
                      <PanelHeader eyebrow="Connection health" title={describeConnection(selected).title} />
                      <PanelContent>
                        <div className="flex flex-col gap-3 text-xs">
                          <ConnectionFacts row={selected} owner={owners?.get(rowKey(selected))} checkedAt={data.checkedAt} nowMs={nowMs} />
                          <p className="border-t border-[var(--border-hairline)] pt-3 text-[11px] leading-snug text-[var(--text-muted)]">
                            {isPlaid
                              ? "Resync re-runs the per-item sync (same lock + cooldown as the fleet). Request reauthorization asks the customer to reconnect — it never removes the connection."
                              : "Operator actions are available for Plaid connections only."}
                            {isPlaid && !canWrite ? " Running them needs WRITE access to Platform Operations." : null}
                          </p>
                        </div>
                      </PanelContent>
                      {isPlaid && canWrite && (
                        <PanelFooter>
                          <button
                            type="button"
                            onClick={() => setConfirm("reauth")}
                            disabled={acting !== null || !canReauth}
                            title={canReauth ? undefined : "Revoked — the customer must re-add this connection."}
                            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                            style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}
                          >
                            <KeyRound size={13} aria-hidden /> Request reauthorization
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirm("resync")}
                            disabled={acting !== null || !canResync}
                            title={canResync ? undefined : "This connection needs reauthorization before it can sync."}
                            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                            style={{
                              background: "color-mix(in srgb, var(--emerald-500) 12%, transparent)",
                              color: TONE_COLOR.ok,
                              borderColor: "color-mix(in srgb, var(--emerald-500) 30%, transparent)",
                            }}
                          >
                            {acting === "resync" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />} Resync now
                          </button>
                        </PanelFooter>
                      )}
                    </>
                  )}
                </RightPanel>
              </>
            )}
          </OwnerResolution>
        )}
      </div>

      {confirm === "resync" && selected && (
        <ConfirmDialog
          icon={RefreshCw}
          title={`Resync ${describeConnection(selected).title} now?`}
          message="Re-runs this connection's sync through the existing per-item path (respects the in-flight lock and manual cooldown). No customer data is exposed."
          confirmLabel="Resync now"
          confirmTone="meridian"
          busy={acting === "resync"}
          onConfirm={() => act("resync")}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "reauth" && selected && (
        <ConfirmDialog
          icon={KeyRound}
          title={`Ask the customer to reauthorize ${describeConnection(selected).title}?`}
          message="Marks the connection as needing reauthorization and prompts the customer to reconnect. It does NOT remove the connection or any data."
          confirmLabel="Request reauthorization"
          confirmTone="meridian"
          busy={acting === "reauth"}
          onConfirm={() => act("reauth")}
          onClose={() => setConfirm(null)}
        />
      )}
    </SectionSurface>
  );
}
