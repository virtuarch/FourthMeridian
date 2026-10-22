"use client";

/**
 * components/security/ActiveSessions.tsx  (OPS-2 S1 · UX-1 polish)
 *
 * User-facing active-sessions card for the Security page. Answers "who is
 * signed in right now?": a compact summary (current session + up to 2 other
 * recent sessions + a "+ N more" affordance) with a "See Sessions" modal for
 * full investigation, search/filtering, and revocation.
 *
 * Presentation + wiring only. All authorization + auditing lives in the
 * unchanged /api/user/sessions* routes; revoke-one and revoke-all behavior is
 * preserved exactly. The current session is clearly labelled and is never
 * offered an "End session" action — the only self sign-out path remains the
 * global one elsewhere. The shared admin <SessionsList> is intentionally left
 * untouched.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Smartphone, Tablet, Monitor, Globe, LogOut, Search, ListChecks } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { type SessionRow } from "@/components/security/SessionsList";
import { FormModal } from "@/components/atlas/FormModal";

const CARD_OTHERS_LIMIT = 2;
type SessionFilter = "all" | "current" | "other";

/**
 * UI-006 — a failed read is an ERROR, never an empty list: "No active sessions"
 * on a security page after a 500 would tell the user nothing is signed in.
 */
async function fetchSessions(): Promise<{ sessions: SessionRow[]; error: string | null }> {
  try {
    const res  = await fetch("/api/user/sessions");
    if (!res.ok) return { sessions: [], error: `Your sessions could not be loaded (${res.status}).` };
    const data = await res.json().catch(() => null) as { sessions?: unknown } | null;
    if (!data || !Array.isArray(data.sessions)) return { sessions: [], error: "Your sessions could not be loaded." };
    return { sessions: data.sessions as SessionRow[], error: null };
  } catch {
    return { sessions: [], error: "Could not reach Fourth Meridian to load your sessions." };
  }
}

function DeviceIcon({ device }: { device: string }) {
  if (/phone|iphone|android phone/i.test(device)) return <Smartphone size={13} className="text-gray-400" />;
  if (/tablet|ipad/i.test(device))                return <Tablet      size={13} className="text-gray-400" />;
  return <Monitor size={13} className="text-gray-400" />;
}

function fmtRelative(d: string | null) {
  if (!d) return "—";
  const diff  = Date.now() - new Date(d).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 1)   return "Just now";
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function byRecent(a: SessionRow, b: SessionRow) {
  return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
}

function SessionRowItem({
  s,
  isCurrent,
  onEnd,
  ending,
}: {
  s:          SessionRow;
  isCurrent:  boolean;
  onEnd?:     () => void;
  ending?:    boolean;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-3 p-3 rounded-xl border transition-colors ${
        isCurrent ? "bg-blue-500/5 border-blue-500/20" : "bg-gray-800/30 border-gray-800"
      }`}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="mt-0.5 shrink-0"><DeviceIcon device={s.parsed.device} /></div>
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-white">{s.parsed.browser}</span>
            <span className="text-xs text-gray-500">on {s.parsed.os}</span>
            <span className="text-xs text-gray-600">· {s.parsed.device}</span>
            {isCurrent && (
              <span className="text-xs font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded-full">
                Current
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {s.ipAddress && (
              <span className="flex items-center gap-1 text-xs text-gray-600 font-mono">
                <Globe size={10} /> {s.ipAddress}
              </span>
            )}
            <span className="text-xs text-gray-600">Started {formatDateTime(s.createdAt)}</span>
            <span className="text-xs text-gray-600" suppressHydrationWarning>Active {fmtRelative(s.lastActiveAt)}</span>
          </div>
        </div>
      </div>
      {!isCurrent && onEnd && (
        <button
          type="button"
          onClick={onEnd}
          disabled={ending}
          className="shrink-0 text-xs px-2.5 py-1 rounded-lg border bg-gray-800 border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-500/30 transition-colors disabled:opacity-40"
        >
          {ending ? "…" : "End session"}
        </button>
      )}
    </div>
  );
}

export function ActiveSessions() {
  const [sessions,    setSessions]    = useState<SessionRow[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [modalOpen,   setModalOpen]   = useState(false);
  const [revokingId,  setRevokingId]  = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [query,       setQuery]       = useState("");
  const [filter,      setFilter]      = useState<SessionFilter>("all");
  const [error,       setError]       = useState<string | null>(null);

  async function reload(): Promise<string | null> {
    const r = await fetchSessions();
    setSessions(r.sessions);
    return r.error;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetchSessions();
      if (!cancelled) { setSessions(r.sessions); setError(r.error); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  /** UI-006 — a revoke that did not happen must never look like it did. */
  async function revoke(url: string, what: string): Promise<void> {
    let failed: string | null = null;
    try {
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) failed = `${what} could not be ended (${res.status}). It may still be signed in — try again.`;
    } catch {
      failed = `${what} could not be ended: Fourth Meridian was unreachable. It may still be signed in — try again.`;
    }
    const readError = await reload();
    setError(failed ?? readError);
  }

  async function handleEnd(id: string) {
    setRevokingId(id);
    await revoke(`/api/user/sessions/${id}`, "That session");
    setRevokingId(null);
  }

  async function handleEndAllOthers() {
    setRevokingAll(true);
    await revoke("/api/user/sessions", "Your other sessions");
    setRevokingAll(false);
  }

  async function retryLoad() {
    setLoading(true);
    setError(await reload());
    setLoading(false);
  }

  const active  = useMemo(() => sessions.filter((s) => !s.revokedAt), [sessions]);
  const current = useMemo(() => active.find((s) => s.isCurrent) ?? null, [active]);
  const others  = useMemo(() => active.filter((s) => !s.isCurrent).sort(byRecent), [active]);

  const shownOthers = others.slice(0, CARD_OTHERS_LIMIT);
  const hiddenCount = others.length - shownOthers.length;

  // Modal list — search + filter applied, grouped Current / Other.
  const q = query.trim().toLowerCase();
  const matches = (s: SessionRow) =>
    !q || `${s.parsed.browser} ${s.parsed.os} ${s.parsed.device} ${s.ipAddress ?? ""}`.toLowerCase().includes(q);

  const modalCurrent = current && filter !== "other" && matches(current) ? current : null;
  const modalOthers  = filter === "current" ? [] : others.filter(matches);
  const modalEmpty   = !modalCurrent && modalOthers.length === 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-gray-500">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  const errorBanner = error ? (
    <div role="alert" aria-live="assertive" data-sessions-error className="mb-2 flex items-center justify-between gap-2 rounded-md border border-red-500/30 px-2 py-1.5 text-[11px] text-red-400">
      <span>{error}</span>
      <button type="button" onClick={retryLoad} className="shrink-0 underline">Retry</button>
    </div>
  ) : null;

  if (active.length === 0) {
    return error ? errorBanner : <p className="text-xs text-gray-600 py-4 text-center">No active sessions.</p>;
  }

  return (
    <>
      {errorBanner}
      {/* Compact summary */}
      <div className="space-y-2">
        {current && <SessionRowItem s={current} isCurrent />}
        {shownOthers.map((s) => (
          <SessionRowItem key={s.id} s={s} isCurrent={false} onEnd={() => handleEnd(s.id)} ending={revokingId === s.id} />
        ))}
      </div>

      {others.length === 0 && (
        <p className="text-xs text-gray-600 mt-3">Only this device is signed in.</p>
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="mt-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          + {hiddenCount} more session{hiddenCount !== 1 ? "s" : ""}
        </button>
      )}

      {/* Footer actions */}
      <div className="flex items-center gap-2 flex-wrap mt-4 pt-3 border-t border-gray-800/60">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 border border-gray-800/60 hover:border-gray-700 px-3 py-1.5 rounded-lg transition-colors"
        >
          <ListChecks size={12} /> See Sessions
        </button>
        {others.length > 0 && (
          <button
            type="button"
            onClick={handleEndAllOthers}
            disabled={revokingAll}
            className="flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300 border border-orange-500/20 hover:border-orange-500/40 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
          >
            {revokingAll ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />}
            Sign out other sessions
          </button>
        )}
      </div>

      {/* See Sessions modal */}
      <FormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Active Sessions"
        icon={Monitor}
        size="md"
        toolbar={
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--text-faint)" }} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search device, browser, OS, IP…"
                aria-label="Search sessions"
                className="w-full text-xs rounded-lg border pl-8 pr-3 py-2 focus:outline-none focus:border-[var(--accent-info)] transition-colors"
                style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" }}
              />
            </div>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as SessionFilter)}
              aria-label="Filter sessions"
              className="text-xs rounded-lg border px-3 py-2 sm:w-40 appearance-none focus:outline-none focus:border-[var(--accent-info)] transition-colors"
              style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" }}
            >
              <option value="all">All</option>
              <option value="current">Current</option>
              <option value="other">Other Sessions</option>
            </select>
          </div>
        }
        footer={
          others.length > 0 ? (
            <button
              type="button"
              onClick={handleEndAllOthers}
              disabled={revokingAll}
              className="flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300 border border-orange-500/20 hover:border-orange-500/40 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
            >
              {revokingAll ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />}
              Sign out other sessions
            </button>
          ) : undefined
        }
      >
        {modalEmpty ? (
          <p className="text-xs text-gray-600 py-8 text-center">No sessions match your filters.</p>
        ) : (
          <div className="space-y-4">
            {modalCurrent && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Current</p>
                <SessionRowItem s={modalCurrent} isCurrent />
              </div>
            )}
            {modalOthers.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Other Sessions</p>
                {modalOthers.map((s) => (
                  <SessionRowItem key={s.id} s={s} isCurrent={false} onEnd={() => handleEnd(s.id)} ending={revokingId === s.id} />
                ))}
              </div>
            )}
          </div>
        )}
      </FormModal>
    </>
  );
}
