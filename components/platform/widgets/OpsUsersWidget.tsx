"use client";

/**
 * components/platform/widgets/OpsUsersWidget.tsx  (OPS-6B · growth_users)
 *
 * Operator user management for Beta Operations. Search/list over GET
 * /api/platform/growth-revenue/users (GROWTH_REVENUE READ) and act:
 * Deactivate / Reactivate POST to the requireFreshPlatformAccess WRITE route
 * (reuses `User.deactivatedAt` + session revocation — reversible), then refetch.
 * Self-managed fetch/action state (mutates + refetches), like the beta queue.
 */

import { useCallback, useEffect, useState } from "react";
import { Users, Loader2, UserX, UserCheck } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformUsersResponse } from "@/app/api/platform/growth-revenue/users/route";

/**
 * P1 — deactivate / reactivate are CONSEQUENTIAL operator actions and the route
 * refuses them without a structured reason (lib/audit.ts REASON_REQUIRED_ACTIONS).
 * The code list mirrors OPERATOR_REASON_CODES; lib/audit.ts is server-only, so a
 * client component cannot import it — lib/platform/operator-action-adoption.test.ts
 * pins this copy equal to the authority.
 */
const REASON_CODES = ["BETA_ONBOARDING", "SUPPORT_REQUEST", "DOGFOOD", "TESTING", "POLICY_ROLLOUT", "INCIDENT", "ABUSE", "OTHER"] as const;
type ReasonCode = (typeof REASON_CODES)[number];
const REASON_LABEL: Record<ReasonCode, string> = {
  BETA_ONBOARDING: "Beta onboarding", SUPPORT_REQUEST: "Support request", DOGFOOD: "Dogfood", TESTING: "Testing",
  POLICY_ROLLOUT: "Policy rollout", INCIDENT: "Incident", ABUSE: "Abuse", OTHER: "Other",
};

export function OpsUsersWidget({ section }: { section: PlatformSection }) {
  const [search, setSearch] = useState("");
  const [data, setData] = useState<PlatformUsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  // The pending consequential action awaiting a reason: which user, which verb.
  const [pending, setPending] = useState<{ id: string; action: "deactivate" | "reactivate" } | null>(null);
  const [reasonCode, setReasonCode] = useState<ReasonCode>("SUPPORT_REQUEST");
  const [reasonNote, setReasonNote] = useState("");

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/platform/growth-revenue/users${q ? `?search=${encodeURIComponent(q)}` : ""}`;
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
      setData((await r.json()) as PlatformUsersResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => { if (alive) void load(search); }, search ? 300 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [search, load]);

  async function act(id: string, action: "deactivate" | "reactivate", reason: { code: ReasonCode; note?: string }) {
    setActing(id);
    setError(null);
    try {
      const r = await fetch(`/api/platform/growth-revenue/users/${id}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `Action failed (${r.status})`);
      }
      await load(search);
      setPending(null);
      setReasonNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActing(null);
    }
  }

  return (
    <PlatformWidgetCard label={section.label} icon={Users}>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name / email / username…"
        className="w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-xs bg-transparent text-[var(--text-primary)]"
        style={{ borderColor: "var(--border-hairline)" }}
      />
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <WidgetStat value={data.total} label="Users" />
            <WidgetStat value={data.users.filter((u) => u.deactivatedAt).length} label="Deactivated (shown)" />
          </div>
          {pending && (
            <div className="mt-1 flex flex-col gap-2 rounded-[var(--radius-sm)] border p-2.5" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
              role="group" aria-label={`Reason to ${pending.action}`}>
              <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                {pending.action === "deactivate" ? "Deactivate account" : "Reactivate account"} — a reason is recorded with the action
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value as ReasonCode)} aria-label="Reason"
                  className="rounded-[var(--radius-sm)] border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]" style={{ borderColor: "var(--border-hairline)" }}>
                  {REASON_CODES.map((c) => <option key={c} value={c}>{REASON_LABEL[c]}</option>)}
                </select>
                <input value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} maxLength={280} placeholder="Note (optional, no personal data)" aria-label="Reason note"
                  className="min-w-[12rem] flex-1 rounded-[var(--radius-sm)] border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)]" style={{ borderColor: "var(--border-hairline)" }} />
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => { setPending(null); setReasonNote(""); }} disabled={acting !== null}
                  className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40" style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}>
                  Cancel
                </button>
                <button type="button" disabled={acting !== null}
                  onClick={() => act(pending.id, pending.action, reasonNote.trim() ? { code: reasonCode, note: reasonNote.trim() } : { code: reasonCode })}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  style={pending.action === "deactivate"
                    ? { background: "rgba(248,113,113,.1)", color: "var(--danger-400, #f87171)", borderColor: "rgba(248,113,113,.28)" }
                    : { background: "rgba(52,211,153,.12)", color: "var(--success-400, #34d399)", borderColor: "rgba(52,211,153,.3)" }}>
                  {acting === pending.id ? <Loader2 size={13} className="animate-spin" /> : pending.action === "deactivate" ? <UserX size={13} /> : <UserCheck size={13} />}
                  Confirm {pending.action}
                </button>
              </div>
            </div>
          )}
          {data.users.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] mt-1">No users match.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 mt-1">
              {data.users.map((u) => (
                <li key={u.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-2" style={{ borderColor: "var(--border-hairline)", background: "var(--glass-ultrathin)" }}>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[var(--text-primary)] truncate">
                      {u.email}
                      {u.deactivatedAt ? <span className="text-[var(--danger-400,#f87171)]"> · deactivated</span> : !u.emailVerifiedAt ? <span className="text-[var(--text-muted)]"> · unverified</span> : null}
                    </p>
                    <p className="text-[10px] text-[var(--text-muted)]">
                      {u.lastLoginAt ? `last login ${timeAgo(u.lastLoginAt)} ago` : "never signed in"} · {u.activeSessions} session(s)
                    </p>
                  </div>
                  {u.role === "SYSTEM_ADMIN" ? (
                    <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">admin</span>
                  ) : u.deactivatedAt ? (
                    <button onClick={() => setPending({ id: u.id, action: "reactivate" })} disabled={acting !== null} title="Reactivate account"
                      className="flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide disabled:opacity-40"
                      style={{ background: "rgba(52,211,153,.12)", color: "var(--success-400, #34d399)", borderColor: "rgba(52,211,153,.3)" }}>
                      {acting === u.id ? <Loader2 size={11} className="animate-spin" /> : <UserCheck size={11} />} Reactivate
                    </button>
                  ) : (
                    <button onClick={() => setPending({ id: u.id, action: "deactivate" })} disabled={acting !== null} title="Deactivate — blocks login, revokes sessions (reversible)"
                      className="flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide disabled:opacity-40"
                      style={{ background: "rgba(248,113,113,.1)", color: "var(--danger-400, #f87171)", borderColor: "rgba(248,113,113,.28)" }}>
                      {acting === u.id ? <Loader2 size={11} className="animate-spin" /> : <UserX size={11} />} Deactivate
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
