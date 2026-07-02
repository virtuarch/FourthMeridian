"use client";

/**
 * app/admin/users/page.tsx — All Users (searchable/filterable)
 */

import { useState, useEffect, useMemo } from "react";
import { Search, Filter, X, ShieldCheck, ShieldOff } from "lucide-react";
import { formatDate } from "@/lib/format";

type SpaceMembership = {
  role:      string;
  space: { id: string; name: string; type: string; _count: { accounts: number } };
};

type User = {
  id:                     string;
  email:                  string;
  username:               string | null;
  name:                   string | null;
  firstName:              string | null;
  lastName:               string | null;
  role:                   string;
  totpEnabled:            boolean;
  forcePasswordReset:     boolean;
  employmentStatus:       string | null;
  useCase:                string | null;
  createdAt:              string;
  spaces:             SpaceMembership[];
  recoveryCodesRemaining: number;
};

const fmtDate = formatDate;

const ROLE_PILL: Record<string, string> = {
  SYSTEM_ADMIN: "bg-red-500/15 text-red-400 border-red-500/20",
  USER:         "bg-gray-700/60 text-gray-300 border-gray-600/40",
};

const WS_ROLE_PILL: Record<string, string> = {
  OWNER:  "bg-amber-500/10 text-amber-400 border-amber-500/20",
  ADMIN:  "bg-orange-500/10 text-orange-400 border-orange-500/20",
  MEMBER: "bg-gray-700/50 text-gray-400 border-gray-600/30",
};

export default function AdminUsersPage() {
  const [users,       setUsers]       = useState<User[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [search,      setSearch]      = useState("");
  const [roleFilter,  setRoleFilter]  = useState("");
  const [totpFilter,  setTotpFilter]  = useState("");
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => r.json())
      .then((d) => setUsers(d.users ?? []))
      .finally(() => setLoading(false));
  }, []);

  // Client-side filtering (small dataset)
  const filtered = useMemo(() => {
    let list = users;

    if (roleFilter) list = list.filter((u) => u.role === roleFilter);
    if (totpFilter !== "") list = list.filter((u) => u.totpEnabled === (totpFilter === "true"));

    if (search) {
      const q = search.toLowerCase();
      list = list.filter((u) =>
        u.email.toLowerCase().includes(q) ||
        (u.username ?? "").toLowerCase().includes(q) ||
        (u.name ?? "").toLowerCase().includes(q) ||
        (u.firstName ?? "").toLowerCase().includes(q) ||
        (u.lastName ?? "").toLowerCase().includes(q),
      );
    }

    return list;
  }, [users, search, roleFilter, totpFilter]);

  const hasFilters = search || roleFilter || totpFilter;

  function clearFilters() { setSearch(""); setRoleFilter(""); setTotpFilter(""); }

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Users</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {loading ? "Loading…" : `${filtered.length} of ${users.length} user${users.length !== 1 ? "s" : ""}${hasFilters ? " (filtered)" : ""}`}
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
            placeholder="Search by name, email, username…"
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
              <label className="text-xs text-gray-500 font-medium">Role</label>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
              >
                <option value="">All roles</option>
                <option value="USER">USER</option>
                <option value="SYSTEM_ADMIN">SYSTEM_ADMIN</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">2FA status</label>
              <select
                value={totpFilter}
                onChange={(e) => setTotpFilter(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
              >
                <option value="">Any</option>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
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

      {/* Table */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 text-left">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium hidden sm:table-cell">2FA</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Details</th>
                <th className="px-4 py-3 font-medium hidden sm:table-cell">Spaces</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Joined</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-600">Loading…</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-600">
                    {hasFilters ? "No users match the current filters." : "No users yet."}
                  </td>
                </tr>
              ) : (
                filtered.map((u, idx) => (
                  <tr
                    key={u.id}
                    className={`${idx < filtered.length - 1 ? "border-b border-gray-800/60" : ""} hover:bg-gray-800/30 transition-colors align-top`}
                  >
                    {/* Identity */}
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-xs font-bold text-gray-300 shrink-0">
                          {((u.firstName ?? u.name ?? u.email)[0]).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-white leading-tight">
                            {u.firstName && u.lastName ? `${u.firstName} ${u.lastName}` : (u.name ?? "—")}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">{u.email}</p>
                          {u.username && <p className="text-xs text-blue-400 mt-0.5">@{u.username}</p>}
                          {u.forcePasswordReset && (
                            <span className="text-xs text-amber-400">⚠ password reset required</span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Role */}
                    <td className="px-4 py-3.5">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${ROLE_PILL[u.role] ?? ROLE_PILL.USER}`}>
                        {u.role}
                      </span>
                    </td>

                    {/* 2FA */}
                    <td className="px-4 py-3.5 hidden sm:table-cell">
                      <div className="flex flex-col gap-1">
                        {u.totpEnabled ? (
                          <div className="flex items-center gap-1.5 text-emerald-400">
                            <ShieldCheck size={13} />
                            <span className="text-xs font-medium">Enabled</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-gray-600">
                            <ShieldOff size={13} />
                            <span className="text-xs">Disabled</span>
                          </div>
                        )}
                        {u.totpEnabled && (
                          <p className="text-xs text-gray-600">{u.recoveryCodesRemaining} codes left</p>
                        )}
                      </div>
                    </td>

                    {/* Profile details */}
                    <td className="px-4 py-3.5 hidden md:table-cell">
                      <div className="space-y-1">
                        {u.employmentStatus && (
                          <p className="text-xs text-gray-400">
                            <span className="text-gray-600">Employment: </span>{u.employmentStatus.replace("_", " ")}
                          </p>
                        )}
                        {u.useCase && (
                          <p className="text-xs text-gray-400">
                            <span className="text-gray-600">Use case: </span>{u.useCase.replace("_", " ")}
                          </p>
                        )}
                        <p className="text-xs text-gray-600 font-mono">{u.id.slice(0, 12)}…</p>
                      </div>
                    </td>

                    {/* Spaces */}
                    <td className="px-4 py-3.5 hidden sm:table-cell">
                      {u.spaces.length === 0 ? (
                        <span className="text-xs text-gray-600">No Spaces</span>
                      ) : (
                        <div className="space-y-1.5">
                          {u.spaces.map((m) => (
                            <div key={m.space.id} className="flex items-center gap-1.5">
                              <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${WS_ROLE_PILL[m.role] ?? WS_ROLE_PILL.MEMBER}`}>
                                {m.role}
                              </span>
                              <span className="text-xs text-gray-300">{m.space.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>

                    {/* Joined */}
                    <td className="px-4 py-3.5 hidden lg:table-cell text-xs text-gray-500 whitespace-nowrap">
                      {fmtDate(u.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
