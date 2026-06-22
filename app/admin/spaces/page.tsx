"use client";

/**
 * app/admin/spaces/page.tsx — All Spaces (searchable/filterable)
 */

import { useState, useEffect, useMemo } from "react";
import { Search, Filter, X, Globe, Lock } from "lucide-react";
import { formatDate } from "@/lib/format";

type Member = {
  role: string;
  user: { id: string; email: string; username: string | null; name: string | null; firstName: string | null };
};

type Space = {
  id:          string;
  name:        string;
  description: string | null;
  type:        string;
  category:    string;
  isPublic:    boolean;
  createdAt:   string;
  members:     Member[];
  accounts:    { type: string }[];
  _count:      { accounts: number; members: number };
};

const fmtDate = formatDate;

const WS_TYPE_PILL: Record<string, string> = {
  PERSONAL: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  SHARED:   "bg-violet-500/10 text-violet-400 border-violet-500/20",
};

const WS_ROLE_PILL: Record<string, string> = {
  OWNER:  "bg-amber-500/10 text-amber-400 border-amber-500/20",
  ADMIN:  "bg-orange-500/10 text-orange-400 border-orange-500/20",
  MEMBER: "bg-gray-700/50 text-gray-400 border-gray-600/30",
};

const CATEGORIES = [
  "PERSONAL","HOUSEHOLD","FAMILY","BUSINESS","PROPERTY","VEHICLE",
  "TRIP","INVESTMENT","EQUIPMENT","RETIREMENT","DEBT_PAYOFF","EMERGENCY_FUND","CUSTOM","OTHER",
];

export default function AdminSpacesPage() {
  const [spaces,  setSpaces]  = useState<Space[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [search,      setSearch]      = useState("");
  const [typeFilter,  setTypeFilter]  = useState("");
  const [catFilter,   setCatFilter]   = useState("");
  const [pubFilter,   setPubFilter]   = useState("");
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    fetch("/api/admin/spaces")
      .then((r) => r.json())
      .then((d) => setSpaces(d.spaces ?? []))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let list = spaces;
    if (typeFilter)  list = list.filter((w) => w.type === typeFilter);
    if (catFilter)   list = list.filter((w) => w.category === catFilter);
    if (pubFilter !== "") list = list.filter((w) => w.isPublic === (pubFilter === "true"));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((w) => w.name.toLowerCase().includes(q));
    }
    return list;
  }, [spaces, search, typeFilter, catFilter, pubFilter]);

  const hasFilters = search || typeFilter || catFilter || pubFilter;
  function clearFilters() { setSearch(""); setTypeFilter(""); setCatFilter(""); setPubFilter(""); }

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Spaces</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {loading ? "Loading…" : `${filtered.length} of ${spaces.length} Space${spaces.length !== 1 ? "s" : ""}${hasFilters ? " (filtered)" : ""}`}
          </p>
        </div>
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm border transition-colors ${
            showFilters || hasFilters
              ? "bg-red-500/10 border-red-500/30 text-red-400"
              : "bg-gray-800 border-gray-700 text-gray-400 hover:text-white"
          }`}
        >
          <Filter size={14} />
          Filters
          {hasFilters && <span className="w-1.5 h-1.5 rounded-full bg-red-400" />}
        </button>
      </div>

      {/* Search + filters */}
      <div className="space-y-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by Space name…"
            className="w-full bg-gray-900/60 border border-gray-800 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400">
              <X size={14} />
            </button>
          )}
        </div>

        {showFilters && (
          <div className="flex flex-wrap gap-3 p-4 bg-gray-900/40 rounded-xl border border-gray-800/60">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Type</label>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
              >
                <option value="">All types</option>
                <option value="PERSONAL">PERSONAL</option>
                <option value="SHARED">SHARED</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Category</label>
              <select
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
              >
                <option value="">All categories</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Visibility</label>
              <select
                value={pubFilter}
                onChange={(e) => setPubFilter(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
              >
                <option value="">Any</option>
                <option value="false">Private</option>
                <option value="true">Public</option>
              </select>
            </div>

            {hasFilters && (
              <div className="flex flex-col justify-end">
                <button
                  onClick={clearFilters}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors"
                >
                  <X size={12} /> Clear filters
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Cards */}
      {loading ? (
        <div className="text-center text-sm text-gray-600 py-10">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-sm text-gray-600 py-10">
          {hasFilters ? "No Spaces match the current filters." : "No Spaces yet."}
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((w) => {
            const byType: Record<string, number> = {};
            for (const a of w.accounts) byType[a.type] = (byType[a.type] ?? 0) + 1;
            const typeOrder   = ["checking", "savings", "investment", "crypto", "debt"];
            const typeBadges  = typeOrder.filter((t) => byType[t]).map((t) => ({ type: t, count: byType[t] }));
            const ownerMember = w.members.find((m) => m.role === "OWNER");

            return (
              <div key={w.id} className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
                {/* Header */}
                <div className="px-5 py-4 flex flex-wrap items-start justify-between gap-3 border-b border-gray-800/60">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-semibold text-white">{w.name}</h2>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${WS_TYPE_PILL[w.type] ?? WS_TYPE_PILL.PERSONAL}`}>
                        {w.type}
                      </span>
                      <span className="text-xs text-gray-600 px-2 py-0.5 rounded-full border border-gray-800">
                        {w.category}
                      </span>
                      {w.isPublic ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <Globe size={11} /> Public
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-gray-600">
                          <Lock size={11} /> Private
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-600 font-mono mt-0.5">{w.id}</p>
                    {ownerMember && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        Owner: {ownerMember.user.email}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">Created {fmtDate(w.createdAt)}</p>
                    <p className="text-xs text-gray-600 mt-0.5">{w._count.members} member{w._count.members !== 1 ? "s" : ""} · {w._count.accounts} account{w._count.accounts !== 1 ? "s" : ""}</p>
                  </div>
                </div>

                <div className="px-5 py-4 grid sm:grid-cols-3 gap-6">
                  {/* Members */}
                  <div>
                    <p className="text-xs text-gray-500 font-medium uppercase tracking-widest mb-2">Members</p>
                    <div className="space-y-2">
                      {w.members.slice(0, 5).map((m) => (
                        <div key={m.user.id} className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-xs font-bold text-gray-300 shrink-0">
                            {((m.user.firstName ?? m.user.name ?? m.user.email)[0]).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs text-white truncate">
                              {m.user.username ? `@${m.user.username}` : (m.user.name ?? m.user.email)}
                            </p>
                            <p className="text-xs text-gray-600 truncate">{m.user.email}</p>
                          </div>
                          <span className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${WS_ROLE_PILL[m.role] ?? WS_ROLE_PILL.MEMBER}`}>
                            {m.role}
                          </span>
                        </div>
                      ))}
                      {w.members.length > 5 && (
                        <p className="text-xs text-gray-600">+{w.members.length - 5} more</p>
                      )}
                    </div>
                  </div>

                  {/* Account breakdown */}
                  <div>
                    <p className="text-xs text-gray-500 font-medium uppercase tracking-widest mb-2">Accounts ({w.accounts.length})</p>
                    {w.accounts.length === 0 ? (
                      <p className="text-xs text-gray-600">No accounts yet</p>
                    ) : (
                      <div className="space-y-1.5">
                        {typeBadges.map(({ type, count }) => (
                          <div key={type} className="flex items-center gap-2">
                            <span className="text-xs text-gray-400 capitalize w-20">{type}</span>
                            <div className="flex-1 bg-gray-800 rounded-full h-1.5 overflow-hidden">
                              <div
                                className="h-full bg-gray-500 rounded-full"
                                style={{ width: `${(count / w.accounts.length) * 100}%` }}
                              />
                            </div>
                            <span className="text-xs text-gray-500 tabular-nums w-4 text-right">{count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Member emails */}
                  <div>
                    <p className="text-xs text-gray-500 font-medium uppercase tracking-widest mb-2">Member Emails</p>
                    {w.members.length === 0 ? (
                      <p className="text-xs text-gray-600">—</p>
                    ) : (
                      <div className="space-y-1">
                        {w.members.slice(0, 5).map((m) => (
                          <p key={m.user.id} className="text-xs text-gray-400 font-mono">{m.user.email}</p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
