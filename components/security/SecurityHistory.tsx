"use client";

/**
 * components/security/SecurityHistory.tsx  (OPS-2 S1 · UX-1 polish)
 *
 * "Recent Activity" card for the Security page: shows only the 5 most recent
 * allowlisted security events from /api/user/security-history (safe fields
 * only — the route does the filtering/scoping). A "See logs" control opens the
 * "Security Logs" modal, which lists the full endpoint response with
 * client-side text search + date-range filtering. Read-only; endpoint
 * unchanged (still returns the last 50 events).
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Globe, History, ScrollText, Search } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { formatDevice, type ParsedUA } from "@/lib/ua-parser";
import { DataCardTitle } from "@/components/atlas/DataCard";
import { FormModal } from "@/components/atlas/FormModal";

type SecurityEvent = {
  id:        string;
  action:    string;
  label:     string;
  createdAt: string;
  ipAddress: string | null;
  parsed:    ParsedUA;
  reason:    string | null;
};

const FAILURE_ACTIONS = new Set(["LOGIN_FAILED", "PASSWORD_CHANGE_FAILED"]);
const RECENT_COUNT = 5;

type RangeKey = "24h" | "7d" | "30d" | "1y" | "all";
const RANGE_OPTIONS: { value: RangeKey; label: string; ms: number | null }[] = [
  { value: "24h", label: "Past 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d",  label: "Past 7 days",   ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Past 30 days",  ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "1y",  label: "Past year",     ms: 365 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All time",      ms: null },
];

function EventRow({ e }: { e: SecurityEvent }) {
  const isFailure = FAILURE_ACTIONS.has(e.action);
  return (
    <div className="flex items-start justify-between gap-3 p-2.5 rounded-xl bg-gray-800/20 border border-gray-800/40">
      <div className="min-w-0 space-y-0.5">
        <p className={`text-xs font-medium ${isFailure ? "text-red-400" : "text-gray-200"}`}>
          {e.label}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-gray-600">{formatDevice(e.parsed)}</span>
          {e.ipAddress && (
            <span className="flex items-center gap-1 text-xs text-gray-600 font-mono">
              <Globe size={10} /> {e.ipAddress}
            </span>
          )}
        </div>
      </div>
      <span className="shrink-0 text-xs text-gray-600" suppressHydrationWarning>
        {formatDateTime(e.createdAt)}
      </span>
    </div>
  );
}

export function SecurityHistory() {
  const [events,    setEvents]    = useState<SecurityEvent[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [query,     setQuery]     = useState("");
  const [range,     setRange]     = useState<RangeKey>("all");
  // "now" is captured (in the open handler — an event, so impurity is fine)
  // when the logs open, so the date-range memo stays pure and stable.
  const [now,       setNow]       = useState(0);

  function openLogs() {
    setNow(Date.now());
    setModalOpen(true);
  }

  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch("/api/user/security-history");
        const data = await res.json().catch(() => ({ events: [] }));
        setEvents(Array.isArray(data.events) ? data.events : []);
      } catch {
        setEvents([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const recent = events.slice(0, RECENT_COUNT);

  const filtered = useMemo(() => {
    const rangeMs = RANGE_OPTIONS.find((r) => r.value === range)?.ms ?? null;
    const cutoff  = rangeMs ? now - rangeMs : null;
    const q       = query.trim().toLowerCase();
    return events.filter((e) => {
      if (cutoff !== null && new Date(e.createdAt).getTime() < cutoff) return false;
      if (q && !`${e.label} ${e.action}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [events, query, range, now]);

  const inputCls =
    "w-full text-xs rounded-lg border px-3 py-2 focus:outline-none focus:border-[var(--accent-info)] transition-colors";
  const inputStyle: React.CSSProperties = {
    background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)",
  };

  return (
    <>
      {/* Card header — "Recent Activity" + See logs */}
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <History size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Recent Activity</DataCardTitle>
        </div>
        {events.length > 0 && (
          <button
            type="button"
            onClick={openLogs}
            className="flex items-center gap-1 text-xs shrink-0 px-2 py-1 rounded-lg border border-gray-800/40 text-gray-400 hover:text-gray-200 transition-colors"
          >
            <ScrollText size={12} /> See logs
          </button>
        )}
      </div>
      <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
        Recent sign-ins and security changes — check for anything you don&apos;t recognize.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-6 text-gray-500">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : recent.length === 0 ? (
        <p className="text-xs text-gray-600 py-4 text-center">No recent security activity.</p>
      ) : (
        <div className="space-y-1.5">
          {recent.map((e) => <EventRow key={e.id} e={e} />)}
        </div>
      )}

      {/* Security Logs modal — full list, client-side search + date filter */}
      <FormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Security Logs"
        icon={ScrollText}
        size="md"
        toolbar={
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--text-faint)" }} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search activity…"
                aria-label="Search security logs"
                className={inputCls + " pl-8"}
                style={inputStyle}
              />
            </div>
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as RangeKey)}
              aria-label="Filter by date range"
              className={inputCls + " sm:w-40 appearance-none"}
              style={inputStyle}
            >
              {RANGE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
        }
      >
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-600 py-8 text-center">No logs match your filters.</p>
        ) : (
          <div className="space-y-1.5">
            {filtered.map((e) => <EventRow key={e.id} e={e} />)}
          </div>
        )}
      </FormModal>
    </>
  );
}
