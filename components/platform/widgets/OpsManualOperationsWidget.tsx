"use client";

/**
 * components/platform/widgets/OpsManualOperationsWidget.tsx
 *   (OPS-5 S4 · ops_manual_operations)
 *
 * The Manual Operations panel. Lists the registered operation commands grouped
 * by target job, each with a Run Now (mutating — behind a ConfirmDialog) and a
 * Dry Run (non-mutating preflight) action. Both POST to the WRITE-gated
 * /operations route; the panel then refetches so the recent-run history and
 * status update in place. Also surfaces the future-safe taxonomy (reserved
 * kinds) so the registry's forward-compatibility is visible, and the recent
 * manual-run history (status + when) as the audit trail.
 *
 * Manages its own fetch/action state (like GrowthBetaRequestsWidget) because it
 * mutates and must refetch after each action, but reuses the shared card shell
 * and message states so it sits flush with the read-only widgets on the grid.
 */

import { useCallback, useEffect, useState } from "react";
import { Wrench, Play, FlaskConical, Loader2, CheckCircle2, XCircle, Clock } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import {
  PlatformWidgetCard,
  WidgetMessage,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import type {
  OperationsResponse,
  OperationActionResponse,
} from "@/app/api/platform/platform-ops/operations/route";
import type { OperationCommand } from "@/lib/platform/operations/registry";

type Feedback = { commandId: string; text: string; tone: "ok" | "warn" | "err" };

function statusTone(status: string): "ok" | "warn" | "err" {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "err";
  return "warn"; // running
}

const TONE_COLOR: Record<"ok" | "warn" | "err", string> = {
  ok: "var(--success-400, #34d399)",
  warn: "var(--brass-300, #d9b45a)",
  err: "var(--danger-400, #f87171)",
};

export function OpsManualOperationsWidget({ section }: { section: PlatformSection }) {
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null); // command id in flight
  const [confirming, setConfirming] = useState<OperationCommand | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/platform/platform-ops/operations", { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
      setData((await r.json()) as OperationsResponse);
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

  const invoke = useCallback(async (command: OperationCommand) => {
    setActing(command.id);
    setFeedback(null);
    try {
      const r = await fetch("/api/platform/platform-ops/operations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: command.id }),
      });
      const res = (await r.json().catch(() => ({}))) as Partial<OperationActionResponse> & { error?: string };
      if (r.status === 409) {
        setFeedback({ commandId: command.id, text: "A run is already in progress — try again shortly.", tone: "warn" });
      } else if (!r.ok) {
        setFeedback({ commandId: command.id, text: res.error ?? `Action failed (${r.status})`, tone: "err" });
      } else if (res.outcome === "planned") {
        setFeedback({
          commandId: command.id,
          text: res.plan?.inFlight
            ? "Dry run: a run is currently in progress."
            : "Dry run: ready — a Run Now would start immediately.",
          tone: "ok",
        });
      } else if (res.outcome === "executed") {
        setFeedback({ commandId: command.id, text: "Ran — recorded a manual JobRun.", tone: "ok" });
      } else if (res.outcome === "failed") {
        setFeedback({ commandId: command.id, text: `Run failed: ${res.error ?? "see JobRun ledger"}.`, tone: "err" });
      }
      await load();
    } catch (e) {
      setFeedback({ commandId: command.id, text: e instanceof Error ? e.message : "Action failed", tone: "err" });
    } finally {
      setActing(null);
    }
  }, [load]);

  // Run Now (mutating) confirms first; Dry Run runs immediately (non-mutating).
  function onCommand(command: OperationCommand) {
    if (command.mutates) setConfirming(command);
    else void invoke(command);
  }

  // Group active commands by target job for a compact per-target row.
  const byTarget = new Map<string, { label: string; description: string; commands: OperationCommand[] }>();
  for (const c of data?.commands ?? []) {
    const g = byTarget.get(c.targetJob) ?? { label: c.targetLabel, description: c.description, commands: [] };
    g.commands.push(c);
    byTarget.set(c.targetJob, g);
  }
  const reserved = (data?.kinds ?? []).filter((k) => k.status === "reserved");

  return (
    <PlatformWidgetCard label={section.label} icon={Wrench}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            {[...byTarget.values()].map((g) => (
              <div
                key={g.label}
                className="rounded-[var(--radius-sm)] border px-2.5 py-2"
                style={{ borderColor: "var(--border-hairline)", background: "var(--glass-ultrathin)" }}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-[var(--text-primary)]">{g.label}</p>
                  <div className="flex items-center gap-1.5">
                    {g.commands.map((c) => {
                      const busy = acting === c.id;
                      const isRun = c.mutates;
                      return (
                        <button
                          key={c.id}
                          onClick={() => onCommand(c)}
                          disabled={acting !== null}
                          title={c.confirm}
                          className="flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide disabled:opacity-40"
                          style={
                            isRun
                              ? { background: "rgba(201,155,60,.14)", color: "var(--brass-300)", borderColor: "rgba(201,155,60,.3)" }
                              : { background: "rgba(125,168,255,.1)", color: "var(--meridian-400)", borderColor: "rgba(125,168,255,.24)" }
                          }
                        >
                          {busy ? <Loader2 size={11} className="animate-spin" /> : isRun ? <Play size={11} /> : <FlaskConical size={11} />}
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] mt-1 leading-relaxed">{g.description}</p>
                {feedback && g.commands.some((c) => c.id === feedback.commandId) && (
                  <p className="text-[10px] mt-1" style={{ color: TONE_COLOR[feedback.tone] }}>
                    {feedback.text}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Recent manual-run history — the audit trail (status + when). */}
          <div className="mt-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1">
              Recent manual runs
            </p>
            {data.recent.length === 0 ? (
              <p className="text-[10px] text-[var(--text-muted)]">No manual runs yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data.recent.slice(0, 6).map((r) => {
                  const tone = statusTone(r.status);
                  const Icon = tone === "ok" ? CheckCircle2 : tone === "err" ? XCircle : Clock;
                  return (
                    <li key={r.id} className="flex items-center gap-1.5 text-[10px]">
                      <Icon size={11} style={{ color: TONE_COLOR[tone] }} />
                      <span className="text-[var(--text-primary)] font-medium">{r.jobName}</span>
                      <span className="text-[var(--text-muted)]">
                        · {r.status} · {timeAgo(r.startedAt)} ago
                        {r.durationMs != null ? ` · ${Math.round(r.durationMs)}ms` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Future-safe taxonomy — reserved kinds the registry can adopt cleanly. */}
          {reserved.length > 0 && (
            <p className="text-[9px] text-[var(--text-muted)] leading-relaxed">
              Reserved operations (register when their canonical body exists):{" "}
              {reserved.map((k) => k.label).join(" · ")}.
            </p>
          )}
        </>
      )}

      {confirming && (
        <ConfirmDialog
          open
          icon={Play}
          title={`${confirming.label} — ${confirming.targetLabel}`}
          message={confirming.confirm}
          confirmLabel={confirming.label}
          confirmTone={confirming.destructive ? "danger" : "meridian"}
          busy={acting === confirming.id}
          onClose={() => { if (acting === null) setConfirming(null); }}
          onConfirm={async () => {
            const c = confirming;
            await invoke(c);
            setConfirming(null);
          }}
        />
      )}
    </PlatformWidgetCard>
  );
}
