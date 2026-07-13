"use client";

/**
 * components/platform/widgets/GrowthBetaRequestsWidget.tsx
 *   (Wave 1 S3 · growth_beta_requests)
 *
 * The beta-access queue. Lists PENDING requests over GET
 * /api/platform/growth-revenue/requests (requirePlatformAccess GROWTH_REVENUE
 * READ) and, unlike the read-only summary widgets, acts on them: Approve mints +
 * emails a single-use invite, Deny is a silent status flip. Both POST to the
 * requireFreshPlatformAccess WRITE routes, then refetch.
 *
 * Manages its own fetch/action state rather than using useWidgetFetch because it
 * mutates and must refetch after each action — but reuses the shared card shell
 * and message states so it sits flush with the other platform widgets.
 */

import { useCallback, useEffect, useState } from "react";
import { Mail, Check, X, Loader2 } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import type { BetaRequestsResponse } from "@/app/api/platform/growth-revenue/requests/route";

export function GrowthBetaRequestsWidget({ section }: { section: PlatformSection }) {
  const [data, setData]       = useState<BetaRequestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [acting, setActing]   = useState<string | null>(null); // request id being acted on

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/platform/growth-revenue/requests", { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
      setData((await r.json()) as BetaRequestsResponse);
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

  async function act(id: string, action: "approve" | "deny") {
    setActing(id);
    setError(null);
    try {
      const r = await fetch(`/api/platform/growth-revenue/requests/${id}/${action}`, {
        method:      "POST",
        credentials: "same-origin",
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `Action failed (${r.status})`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActing(null);
    }
  }

  return (
    <PlatformWidgetCard label={section.label} icon={Mail}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2">
            <WidgetStat value={data.counts.pending} label="Pending" />
            <WidgetStat value={data.counts.approved} label="Approved" />
            <WidgetStat value={data.counts.redeemed} label="Redeemed" />
            <WidgetStat value={data.counts.denied} label="Denied" />
          </div>

          {data.pending.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] mt-1">No pending requests.</p>
          ) : (
            <ul className="flex flex-col gap-2 mt-1">
              {data.pending.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-2"
                  style={{ borderColor: "var(--border-hairline)", background: "var(--glass-ultrathin)" }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[var(--text-primary)] truncate">{r.email}</p>
                    <p className="text-[10px] text-[var(--text-muted)]">
                      {timeAgo(r.createdAt)} ago{r.note ? ` · ${r.note}` : ""}
                    </p>
                  </div>
                  <button
                    onClick={() => act(r.id, "approve")}
                    disabled={acting !== null}
                    title="Approve — mint & email an invite"
                    className="flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide disabled:opacity-40"
                    style={{ background: "rgba(52,211,153,.12)", color: "var(--success-400, #34d399)", borderColor: "rgba(52,211,153,.3)" }}
                  >
                    {acting === r.id ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Approve
                  </button>
                  <button
                    onClick={() => act(r.id, "deny")}
                    disabled={acting !== null}
                    title="Deny — silent status flip, no email"
                    className="flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide disabled:opacity-40"
                    style={{ background: "rgba(248,113,113,.1)", color: "var(--danger-400, #f87171)", borderColor: "rgba(248,113,113,.28)" }}
                  >
                    <X size={11} /> Deny
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-[var(--text-muted)]">
            Approve mints a single-use, email-bound invite (14-day expiry) and emails it. Redemption requires registration mode = invite-only.
          </p>
        </>
      )}
    </PlatformWidgetCard>
  );
}
