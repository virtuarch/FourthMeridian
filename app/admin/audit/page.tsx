"use client";

/**
 * app/admin/audit/page.tsx — Audit Log Viewer
 *
 * Features:
 *   - Free-text search (action, name, email, username)
 *   - Dedicated filters: email, username, action, workspace, date range
 *   - Quick-filter pills: Security events | Admin actions
 *   - Expandable rows for full metadata
 *   - Device/browser column parsed from userAgent
 *   - Workspace column
 *   - Performed-by-admin badge
 *   - Pagination (50/page)
 */

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Search, Filter, X, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, Shield, ShieldAlert,
  Monitor, Smartphone, Tablet, Globe,
  User, Calendar, Building2,
} from "lucide-react";
import { AUDIT_ACTION_GROUPS } from "@/lib/audit-actions";
import { parseUserAgent } from "@/lib/ua-parser";
import { formatDate, formatNumber } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────

type LogEntry = {
  id:                 string;
  action:             string;
  userId:             string | null;
  workspaceId:        string | null;
  metadata:           Record<string, unknown> | null;
  ipAddress:          string | null;
  userAgent:          string | null;
  performedByAdminId: string | null;
  createdAt:          string;
  user:               { email: string; username: string | null; name: string | null; firstName: string | null; lastName: string | null; role: string } | null;
  workspace:          { name: string } | null;
  performedByAdmin:   { email: string; username: string | null; name: string | null } | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtDate = formatDate;

function fmtTime(d: string) {
  return new Date(d).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

function actionBadgeClass(action: string): string {
  if (action.includes("FAIL") || action.includes("ERROR"))
    return "bg-red-500/10 text-red-400 border-red-500/20";
  if (action === "LOGIN" || action === "LOGOUT" || action === "WORKSPACE_SWITCH")
    return "bg-blue-500/10 text-blue-400 border-blue-500/20";
  if (action.includes("TWO_FACTOR") || action.includes("RECOVERY"))
    return "bg-amber-500/10 text-amber-400 border-amber-500/20";
  if (action.includes("SESSION"))
    return "bg-orange-500/10 text-orange-400 border-orange-500/20";
  if (action.includes("PASSWORD"))
    return "bg-purple-500/10 text-purple-400 border-purple-500/20";
  if (action.includes("GOAL"))
    return "bg-violet-500/10 text-violet-400 border-violet-500/20";
  if (action.includes("MEMBER"))
    return "bg-cyan-500/10 text-cyan-400 border-cyan-500/20";
  if (action === "REGISTER" || action.includes("ACCOUNT") || action.includes("PLAID") || action.includes("WALLET"))
    return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  return "bg-gray-700/50 text-gray-400 border-gray-700/50";
}

function metaSummary(metadata: Record<string, unknown> | null): string {
  if (!metadata || Object.keys(metadata).length === 0) return "";
  const pairs = Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  const joined = pairs.join(" · ");
  return joined.length > 80 ? joined.slice(0, 77) + "…" : joined;
}

function DeviceIcon({ ua }: { ua: string | null }) {
  if (!ua) return <Globe size={13} className="text-gray-600" />;
  const parsed = parseUserAgent(ua);
  if (parsed.device === "iPhone" || parsed.device === "Android Phone")
    return <Smartphone size={13} className="text-gray-500" />;
  if (parsed.device === "iPad" || parsed.device === "Android Tablet")
    return <Tablet size={13} className="text-gray-500" />;
  return <Monitor size={13} className="text-gray-500" />;
}

function DeviceLabel({ ua }: { ua: string | null }) {
  if (!ua) return <span className="text-gray-700 text-xs">—</span>;
  const { browser, os } = parseUserAgent(ua);
  return (
    <div className="flex items-center gap-1.5">
      <DeviceIcon ua={ua} />
      <div>
        <p className="text-xs text-gray-400 leading-none">{browser}</p>
        <p className="text-xs text-gray-600 leading-none mt-0.5">{os}</p>
      </div>
    </div>
  );
}

// ── Expandable Row ────────────────────────────────────────────────────────────

function LogRow({ log, isLast }: { log: LogEntry; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = (log.metadata && Object.keys(log.metadata).length > 0) || log.userAgent;
  const summary = metaSummary(log.metadata);

  const displayName = log.user
    ? (log.user.firstName && log.user.lastName)
      ? `${log.user.firstName} ${log.user.lastName}`
      : (log.user.name ?? log.user.email)
    : null;

  return (
    <>
      <tr
        className={`${!isLast || expanded ? "border-b border-gray-800/60" : ""} hover:bg-gray-800/20 transition-colors align-top cursor-pointer`}
        onClick={() => hasDetail && setExpanded((v) => !v)}
      >
        {/* Timestamp */}
        <td className="px-4 py-3 whitespace-nowrap">
          <p className="text-xs text-gray-300">{fmtDate(log.createdAt)}</p>
          <p className="text-xs text-gray-600 mt-0.5 font-mono">{fmtTime(log.createdAt)}</p>
        </td>

        {/* User */}
        <td className="px-4 py-3 hidden sm:table-cell min-w-[160px]">
          {log.user ? (
            <div>
              <p className="text-xs text-white font-medium leading-none">{displayName}</p>
              {log.user.username && (
                <p className="text-xs text-gray-500 mt-0.5 leading-none">@{log.user.username}</p>
              )}
              <p className="text-xs text-gray-600 mt-0.5 leading-none">{log.user.email}</p>
              {log.user.role === "SYSTEM_ADMIN" && (
                <span className="text-[10px] text-red-400 font-medium">SYSADMIN</span>
              )}
            </div>
          ) : (
            <span className="text-xs text-gray-700">—</span>
          )}
        </td>

        {/* Action */}
        <td className="px-4 py-3">
          <div className="space-y-1">
            <span className={`inline-block text-[11px] font-mono font-medium px-2 py-0.5 rounded-full border ${actionBadgeClass(log.action)}`}>
              {log.action}
            </span>
            {log.performedByAdmin && (
              <p className="text-[10px] text-red-400/70 flex items-center gap-1">
                <ShieldAlert size={10} />
                via {log.performedByAdmin.username ? `@${log.performedByAdmin.username}` : log.performedByAdmin.email}
              </p>
            )}
          </div>
        </td>

        {/* Workspace */}
        <td className="px-4 py-3 hidden lg:table-cell">
          {log.workspace ? (
            <p className="text-xs text-gray-400 max-w-[120px] truncate">{log.workspace.name}</p>
          ) : (
            <span className="text-xs text-gray-700">—</span>
          )}
        </td>

        {/* IP + Device */}
        <td className="px-4 py-3 hidden md:table-cell">
          <p className="text-xs text-gray-600 font-mono leading-none">{log.ipAddress ?? "—"}</p>
          <div className="mt-1.5">
            <DeviceLabel ua={log.userAgent} />
          </div>
        </td>

        {/* Metadata summary + expand toggle */}
        <td className="px-4 py-3 hidden xl:table-cell max-w-[220px]">
          <div className="flex items-start gap-1">
            <p className="text-xs text-gray-600 break-all flex-1">{summary || "—"}</p>
            {hasDetail && (
              <button className="shrink-0 text-gray-600 hover:text-gray-400 mt-0.5">
                {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            )}
          </div>
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr className={`${!isLast ? "border-b border-gray-800/60" : ""} bg-gray-950/60`}>
          <td colSpan={6} className="px-6 py-4">
            <div className="space-y-3">
              {log.metadata && Object.keys(log.metadata).length > 0 && (
                <div>
                  <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">Metadata</p>
                  <pre className="text-xs text-gray-400 font-mono bg-gray-900 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(log.metadata, null, 2)}
                  </pre>
                </div>
              )}
              {log.userAgent && (
                <div>
                  <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">User Agent</p>
                  <p className="text-xs text-gray-600 font-mono break-all">{log.userAgent}</p>
                </div>
              )}
              <div className="flex flex-wrap gap-4 text-xs text-gray-600">
                <span>ID: <span className="font-mono text-gray-500">{log.id}</span></span>
                {log.userId && <span>User ID: <span className="font-mono text-gray-500">{log.userId}</span></span>}
                {log.workspaceId && <span>Workspace ID: <span className="font-mono text-gray-500">{log.workspaceId}</span></span>}
                {log.performedByAdminId && <span>Admin ID: <span className="font-mono text-gray-500">{log.performedByAdminId}</span></span>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export default function AdminAuditPage() {
  // Filters
  const [search,       setSearch]       = useState("");
  const [userEmail,    setUserEmail]    = useState("");
  const [username,     setUsername]     = useState("");
  const [action,       setAction]       = useState("");
  const [workspaceId,  setWorkspaceId]  = useState("");
  const [from,         setFrom]         = useState("");
  const [to,           setTo]           = useState("");
  const [securityOnly, setSecurityOnly] = useState(false);
  const [adminOnly,    setAdminOnly]    = useState(false);
  const [showFilters,  setShowFilters]  = useState(false);

  // Data
  const [offset,  setOffset]  = useState(0);
  const [logs,    setLogs]    = useState<LogEntry[]>([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(false);

  // Debounce for search/email/username text fields
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLogs = useCallback(async (off: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search)       params.set("search",       search);
      if (userEmail)    params.set("userEmail",     userEmail);
      if (username)     params.set("username",      username);
      if (action)       params.set("action",        action);
      if (workspaceId)  params.set("workspaceId",   workspaceId);
      if (from)         params.set("from",          from);
      if (to)           params.set("to",            to);
      if (securityOnly) params.set("securityOnly",  "true");
      if (adminOnly)    params.set("adminOnly",     "true");
      params.set("limit",  String(PAGE_SIZE));
      params.set("offset", String(off));

      const res  = await fetch(`/api/admin/audit?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setLogs(data.logs ?? []);
      setTotal(data.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [search, userEmail, username, action, workspaceId, from, to, securityOnly, adminOnly]);

  // Reset to page 0 on any filter change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setOffset(0);
      fetchLogs(0);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, userEmail, username, action, workspaceId, from, to, securityOnly, adminOnly]);

  // Page navigation — wrapped in setTimeout so fetchLogs's synchronous setLoading(true)
  // doesn't run directly within the effect body (satisfies react-hooks/set-state-in-effect).
  useEffect(() => {
    const t = setTimeout(() => fetchLogs(offset), 0);
    return () => clearTimeout(t);
  }, [offset]); // eslint-disable-line react-hooks/exhaustive-deps

  function clearFilters() {
    setSearch(""); setUserEmail(""); setUsername("");
    setAction(""); setWorkspaceId(""); setFrom(""); setTo("");
    setSecurityOnly(false); setAdminOnly(false);
    setOffset(0);
  }

  const hasFilters = search || userEmail || username || action || workspaceId || from || to || securityOnly || adminOnly;
  const totalPages  = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-5 max-w-7xl">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Audit Log</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {loading
              ? "Loading…"
              : `${formatNumber(total)} event${total !== 1 ? "s" : ""}${hasFilters ? " matching filters" : " total"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Quick-filter pills */}
          <button
            onClick={() => setSecurityOnly((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
              securityOnly
                ? "bg-blue-500/15 border-blue-500/40 text-blue-400"
                : "bg-gray-800/60 border-gray-700 text-gray-500 hover:text-gray-300"
            }`}
          >
            <Shield size={12} />
            Security
          </button>
          <button
            onClick={() => setAdminOnly((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
              adminOnly
                ? "bg-red-500/15 border-red-500/40 text-red-400"
                : "bg-gray-800/60 border-gray-700 text-gray-500 hover:text-gray-300"
            }`}
          >
            <ShieldAlert size={12} />
            Admin actions
          </button>
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
              showFilters || (hasFilters && !securityOnly && !adminOnly)
                ? "bg-gray-700 border-gray-600 text-white"
                : "bg-gray-800/60 border-gray-700 text-gray-500 hover:text-gray-300"
            }`}
          >
            <Filter size={12} />
            Filters
            {hasFilters && !securityOnly && !adminOnly && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            )}
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search actions, names, emails, usernames…"
          className="w-full bg-gray-900/60 border border-gray-800 rounded-xl pl-10 pr-10 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600 transition-colors"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Expanded filter panel */}
      {showFilters && (
        <div className="p-4 bg-gray-900/40 rounded-xl border border-gray-800/60 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">

            {/* Email */}
            <div className="space-y-1">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 font-medium">
                <User size={11} /> Email
              </label>
              <input
                type="email"
                value={userEmail}
                onChange={(e) => setUserEmail(e.target.value)}
                placeholder="user@example.com"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
              />
            </div>

            {/* Username */}
            <div className="space-y-1">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 font-medium">
                <User size={11} /> Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@username"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
              />
            </div>

            {/* Action */}
            <div className="space-y-1">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 font-medium">
                <Filter size={11} /> Action type
              </label>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-gray-600"
              >
                <option value="">All actions</option>
                {AUDIT_ACTION_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.actions.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* Workspace ID */}
            <div className="space-y-1">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 font-medium">
                <Building2 size={11} /> Workspace ID
              </label>
              <input
                type="text"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="Workspace ID"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-gray-600 font-mono"
              />
            </div>

            {/* From date */}
            <div className="space-y-1">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 font-medium">
                <Calendar size={11} /> From
              </label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-gray-600"
              />
            </div>

            {/* To date */}
            <div className="space-y-1">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 font-medium">
                <Calendar size={11} /> To
              </label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-gray-600"
              />
            </div>
          </div>

          {hasFilters && (
            <div className="flex justify-end">
              <button
                onClick={clearFilters}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors"
              >
                <X size={11} /> Clear all filters
              </button>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900/40 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] text-gray-600 uppercase tracking-wider text-left">
                <th className="px-4 py-3 font-medium">Timestamp</th>
                <th className="px-4 py-3 font-medium hidden sm:table-cell">User</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Workspace</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">IP / Device</th>
                <th className="px-4 py-3 font-medium hidden xl:table-cell">Details</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-gray-800/40">
                    {[...Array(6)].map((__, j) => (
                      <td key={j} className={`px-4 py-3 ${j > 0 && j < 3 ? "" : j === 3 ? "hidden lg:table-cell" : j === 4 ? "hidden md:table-cell" : j === 5 ? "hidden xl:table-cell" : "hidden sm:table-cell"}`}>
                        <div className="h-3 bg-gray-800 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-14 text-center">
                    <p className="text-sm text-gray-600">
                      {hasFilters ? "No events match the current filters." : "No audit events yet."}
                    </p>
                    {hasFilters && (
                      <button onClick={clearFilters} className="mt-2 text-xs text-gray-500 hover:text-gray-300 underline">
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                logs.map((log, idx) => (
                  <LogRow key={log.id} log={log} isLast={idx === logs.length - 1} />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-800/60 flex items-center justify-between">
            <span className="text-xs text-gray-600">
              Page {currentPage} of {totalPages} · {formatNumber(total)} events
            </span>
            <div className="flex items-center gap-1">
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-gray-800 border border-gray-700 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={13} /> Prev
              </button>
              <span className="px-2 text-xs text-gray-600">{currentPage}</span>
              <button
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-gray-800 border border-gray-700 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next <ChevronRight size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
