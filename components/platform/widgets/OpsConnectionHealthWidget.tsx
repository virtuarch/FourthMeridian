"use client";

/**
 * components/platform/widgets/OpsConnectionHealthWidget.tsx
 *   (Wave 2 S7 / CH-1 · ops_connection_health · PO-4A operator controls)
 *
 * Provider-connection health, over GET /api/platform/platform-ops/connection-health
 * (requirePlatformAccess PLATFORM_OPS READ). Headline healthy/total + the
 * non-healthy connections worst-first, each opening a RightPanel of operational
 * FACTS (institution/provider/status/health/timestamps — NO PII, never balances
 * or transactions) with two WRITE ACTIONS for Plaid connections:
 *   - Resync now — re-run the per-item sync (PO-4A)
 *   - Request reauthorization — ask the customer to reconnect (never removes)
 * Both POST to requireFreshPlatformAccess(PLATFORM_OPS, WRITE) routes behind a
 * ConfirmDialog, then refetch. Manages its own fetch/action state (it mutates).
 */

import { useCallback, useEffect, useState } from "react";
import { PlugZap, RefreshCw, KeyRound, Loader2 } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import { RightPanel, PanelHeader, PanelContent, PanelFooter } from "@/components/atlas/panels";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import type { ConnectionHealthResponse } from "@/app/api/platform/platform-ops/connection-health/route";
import type { ConnectionHealthRow } from "@/lib/connections/health";

const STATE_LABEL: Record<string, string> = {
  REVOKED:      "Revoked",
  ERROR:        "Error",
  NEEDS_REAUTH: "Needs re-auth",
  DEGRADED:     "Degraded",
  STALE:        "Stale",
  HEALTHY:      "Healthy",
};

export function OpsConnectionHealthWidget({ section }: { section: PlatformSection }) {
  const [data, setData]       = useState<ConnectionHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);       // load error (hides the widget)
  const [actionError, setActionError] = useState<string | null>(null); // action error (inline, keeps the list)
  const [acting, setActing]   = useState<string | null>(null);      // "resync" | "reauth"
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "resync" | "reauth">(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/platform/platform-ops/connection-health", { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
      setData((await r.json()) as ConnectionHealthResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await load(); })();
    return () => { alive = false; };
  }, [load]);

  const selected: ConnectionHealthRow | null =
    selectedKey && data ? data.unhealthy.find((c) => `${c.source}:${c.id}` === selectedKey) ?? null : null;

  async function act(kind: "resync" | "reauth") {
    if (!selected) return;
    const path = kind === "resync" ? "resync" : "request-reauth";
    setActing(kind);
    setActionError(null);
    try {
      const r = await fetch(`/api/platform/platform-ops/connections/${selected.id}/${path}`, {
        method: "POST", credentials: "same-origin",
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (r.status === 429 && body.retryAfterSeconds) {
          throw new Error(`On cooldown — try again in ~${Math.ceil(body.retryAfterSeconds / 60)} min.`);
        }
        if (r.status === 409 && body.error === "in-flight") {
          throw new Error("A sync is already in flight for this connection.");
        }
        throw new Error(body.error ?? `Action failed (${r.status})`);
      }
      setConfirm(null);
      setSelectedKey(null);
      await load();
    } catch (e) {
      setConfirm(null);
      setActionError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActing(null);
    }
  }

  // Action availability (Plaid only; a dead credential can't sync, a revoked item is gone).
  const isPlaid   = selected?.source === "PLAID";
  const canResync = isPlaid && selected!.healthState !== "REVOKED" && selected!.healthState !== "NEEDS_REAUTH";
  const canReauth = isPlaid && selected!.healthState !== "REVOKED";

  return (
    <PlatformWidgetCard label={section.label} icon={PlugZap}>
      {loading || error || !data ? (
        <>
          <WidgetMessage loading={loading} error={error} />
          {error && !loading && (
            <button type="button" onClick={load} className="mt-1 w-fit text-[11px] text-[var(--meridian-400)] underline">Retry</button>
          )}
        </>
      ) : (
        <>
          {actionError && (
            <p className="rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[11px]"
               style={{ color: "var(--danger-400, #f87171)", borderColor: "rgba(248,113,113,.28)", background: "rgba(248,113,113,.08)" }}>
              {actionError}
            </p>
          )}
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.counts.HEALTHY} label="Healthy" />
            <WidgetStat value={data.total - data.counts.HEALTHY} label="Unhealthy" />
            <WidgetStat value={data.total} label="Total" />
          </div>
          {data.unhealthy.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]">All provider connections healthy.</p>
          ) : (
            <ul className="-mx-1 divide-y divide-[var(--border-hairline)]">
              {data.unhealthy.map((c) => (
                <li key={`${c.source}:${c.id}`}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(`${c.source}:${c.id}`)}
                    className="group relative flex w-full items-center justify-between gap-2 overflow-hidden px-1 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
                  >
                    <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                    <span className="min-w-0 truncate text-xs text-[var(--text-primary)]">
                      {c.label} <span className="text-[var(--text-muted)]">· {c.source}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">
                      {STATE_LABEL[c.healthState] ?? c.healthState}
                      {c.since ? <span className="text-[var(--text-muted)]"> · {timeAgo(c.since)}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Detail + operator actions */}
          <RightPanel open={selected != null} onClose={() => setSelectedKey(null)} ariaLabel="Connection detail">
            {selected && (
              <>
                <PanelHeader eyebrow="Connection health" title={selected.label} />
                <PanelContent>
                  <div className="flex flex-col gap-2.5 text-xs">
                    <Row label="Institution" value={selected.label} />
                    <Row label="Provider" value={selected.source} />
                    <Row label="Status" value={selected.status} />
                    <Row label="Health state" value={STATE_LABEL[selected.healthState] ?? selected.healthState} />
                    <Row label="Last sync" value={selected.lastSyncedAt ? `${timeAgo(selected.lastSyncedAt)} ago` : "never"} />
                    {selected.errorCode && <Row label="Error code" value={selected.errorCode} />}
                    {selected.since && <Row label="Broken since" value={`${timeAgo(selected.since)} ago`} />}
                    <p className="border-t border-[var(--border-hairline)] pt-3 text-[11px] leading-snug text-[var(--text-muted)]">
                      {isPlaid
                        ? "Resync re-runs the per-item sync (same lock + cooldown as the fleet). Request reauthorization asks the customer to reconnect — it never removes the connection."
                        : "Operator actions are available for Plaid connections only."}
                    </p>
                  </div>
                </PanelContent>
                {isPlaid && (
                  <PanelFooter>
                    <button
                      onClick={() => setConfirm("reauth")}
                      disabled={acting !== null || !canReauth}
                      title={canReauth ? undefined : "Revoked — the customer must re-add this connection."}
                      className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                      style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}
                    >
                      <KeyRound size={13} /> Request reauthorization
                    </button>
                    <button
                      onClick={() => setConfirm("resync")}
                      disabled={acting !== null || !canResync}
                      title={canResync ? undefined : "This connection needs reauthorization before it can sync."}
                      className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                      style={{ background: "rgba(52,211,153,.12)", color: "var(--success-400, #34d399)", borderColor: "rgba(52,211,153,.3)" }}
                    >
                      {acting === "resync" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Resync now
                    </button>
                  </PanelFooter>
                )}
              </>
            )}
          </RightPanel>

          {confirm === "resync" && selected && (
            <ConfirmDialog
              icon={RefreshCw}
              title={`Resync ${selected.label} now?`}
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
              title={`Ask the customer to reauthorize ${selected.label}?`}
              message="Marks the connection as needing reauthorization and prompts the customer to reconnect. It does NOT remove the connection or any data."
              confirmLabel="Request reauthorization"
              confirmTone="meridian"
              busy={acting === "reauth"}
              onConfirm={() => act("reauth")}
              onClose={() => setConfirm(null)}
            />
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="text-[var(--text-primary)] text-right">{value}</span>
    </div>
  );
}
