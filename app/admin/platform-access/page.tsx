"use client";

/**
 * app/admin/platform-access/page.tsx — Platform Access (grant matrix)
 *
 * PO1.0 — the SYSTEM_ADMIN surface for issuing / changing / revoking platform
 * grants (user × area × level). The screen IS the model: a (user, area) matrix
 * whose cells are — / READ / WRITE, backed 1:1 by PlatformGrant rows.
 *
 * Mutations go through the extra-guarded routes:
 *   POST  /api/admin/platform-grants            { userId, area, level }
 *   PATCH /api/admin/platform-grants/[grantId]  { action: "revoke" }
 * (fresh-auth + rate-limit + transactional canon audit live server-side.)
 *
 * Grants may only be held by USER-role accounts — SYSTEM_ADMIN already has the
 * unconditional break-glass bypass, so admins are omitted from the matrix.
 * Access is gated by app/admin/layout.tsx (any non-SYSTEM_ADMIN is redirected
 * before reaching here).
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { Search, X, ScrollText, Loader2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { PLATFORM_AREAS, ALL_PLATFORM_AREAS } from "@/lib/platform/policy";

type Identity = { id: string; name: string | null; username: string | null };
type User = Identity & { email: string; role: string };
type Grant = {
  id:        string;
  area:      string;
  level:     string;
  status:    string;
  grantedAt: string;
  revokedAt: string | null;
  user:      Identity & { email: string };
  grantedBy: Identity | null;
  revokedBy: Identity | null;
};

const LEVELS = ["READ", "WRITE"] as const;

export default function PlatformAccessPage() {
  const [users,   setUsers]   = useState<User[]>([]);
  const [grants,  setGrants]  = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState("");
  const [busy,    setBusy]    = useState<string | null>(null); // `${userId}:${area}`
  const [error,   setError]   = useState<string | null>(null);

  const loadGrants = useCallback(async () => {
    const r = await fetch("/api/admin/platform-grants");
    if (r.ok) setGrants((await r.json()).grants ?? []);
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/users").then((r) => (r.ok ? r.json() : { users: [] })),
      fetch("/api/admin/platform-grants").then((r) => (r.ok ? r.json() : { grants: [] })),
    ])
      .then(([u, g]) => {
        // Grants are issued to USER-role accounts only.
        setUsers((u.users ?? []).filter((x: User) => x.role === "USER"));
        setGrants(g.grants ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  // Active grant per (userId, area) — the matrix's source of state.
  const active = useMemo(() => {
    const m = new Map<string, Grant>();
    for (const g of grants) {
      if (g.status === "ACTIVE") m.set(`${g.user.id}:${g.area}`, g);
    }
    return m;
  }, [grants]);

  const filteredUsers = useMemo(() => {
    if (!search) return users;
    const q = search.toLowerCase();
    return users.filter((u) =>
      u.email.toLowerCase().includes(q) ||
      (u.username ?? "").toLowerCase().includes(q) ||
      (u.name ?? "").toLowerCase().includes(q),
    );
  }, [users, search]);

  async function setLevel(userId: string, area: string, level: string) {
    const key = `${userId}:${area}`;
    setBusy(key); setError(null);
    try {
      const r = await fetch("/api/admin/platform-grants", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId, area, level }),
      });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Grant failed");
      else await loadGrants();
    } finally {
      setBusy(null);
    }
  }

  async function revoke(userId: string, area: string, grantId: string) {
    const key = `${userId}:${area}`;
    setBusy(key); setError(null);
    try {
      const r = await fetch(`/api/admin/platform-grants/${grantId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "revoke" }),
      });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Revoke failed");
      else await loadGrants();
    } finally {
      setBusy(null);
    }
  }

  const activeCount = active.size;

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <ShieldCheck size={20} className="text-red-400" />
            Platform Access
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {loading
              ? "Loading…"
              : `${activeCount} active grant${activeCount === 1 ? "" : "s"} across ${users.length} user${users.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <Link
          href="/admin/audit"
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm border bg-gray-800 border-gray-700 text-gray-400 hover:text-white transition-colors"
        >
          <ScrollText size={14} />
          Grant history
        </Link>
      </div>

      <p className="text-xs text-gray-500 leading-relaxed max-w-3xl">
        Grants are held per user, per platform area, at READ or WRITE (WRITE
        implies READ). Revoking flips the grant to REVOKED — the row is kept for
        audit and reinstated on re-grant. SYSTEM_ADMIN accounts are omitted:
        they already have unconditional access and need no grant.
      </p>

      {error && (
        <div className="px-4 py-2.5 rounded-xl text-sm bg-red-500/10 border border-red-500/30 text-red-400">
          {error}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search users by name, email, username…"
          className="w-full bg-gray-900/60 border border-gray-800 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
        />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Matrix */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 text-left">
                <th className="px-4 py-3 font-medium">User</th>
                {ALL_PLATFORM_AREAS.map((area) => (
                  <th key={area} className="px-4 py-3 font-medium whitespace-nowrap">
                    {PLATFORM_AREAS[area].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={ALL_PLATFORM_AREAS.length + 1} className="px-4 py-10 text-center text-sm text-gray-600">Loading…</td></tr>
              ) : filteredUsers.length === 0 ? (
                <tr><td colSpan={ALL_PLATFORM_AREAS.length + 1} className="px-4 py-10 text-center text-sm text-gray-600">
                  {search ? "No users match." : "No USER-role accounts."}
                </td></tr>
              ) : (
                filteredUsers.map((u, idx) => (
                  <tr key={u.id} className={`${idx < filteredUsers.length - 1 ? "border-b border-gray-800/60" : ""} align-top`}>
                    {/* Identity */}
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-xs font-bold text-gray-300 shrink-0">
                          {((u.name ?? u.email)[0]).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-white leading-tight truncate">{u.name ?? "—"}</p>
                          <p className="text-xs text-gray-500 mt-0.5 truncate">{u.email}</p>
                          {u.username && <p className="text-xs text-blue-400 mt-0.5">@{u.username}</p>}
                        </div>
                      </div>
                    </td>

                    {/* One matrix cell per area */}
                    {ALL_PLATFORM_AREAS.map((area) => {
                      const key = `${u.id}:${area}`;
                      const grant = active.get(key);
                      const isBusy = busy === key;
                      return (
                        <td key={area} className="px-4 py-3.5">
                          <div className="flex items-center gap-1">
                            {isBusy ? (
                              <Loader2 size={14} className="animate-spin text-gray-500" />
                            ) : (
                              <>
                                {LEVELS.map((lvl) => {
                                  const isCurrent = grant?.level === lvl;
                                  return (
                                    <button
                                      key={lvl}
                                      onClick={() => !isCurrent && setLevel(u.id, area, lvl)}
                                      disabled={isCurrent}
                                      title={isCurrent ? `Currently ${lvl}` : `Grant ${lvl}`}
                                      className={[
                                        "text-[11px] font-semibold px-2 py-1 rounded-md border transition-colors",
                                        isCurrent
                                          ? lvl === "WRITE"
                                            ? "bg-amber-500/15 text-amber-400 border-amber-500/30 cursor-default"
                                            : "bg-blue-500/15 text-blue-400 border-blue-500/30 cursor-default"
                                          : "bg-gray-800/60 text-gray-500 border-gray-700/60 hover:text-white hover:border-gray-600",
                                      ].join(" ")}
                                    >
                                      {lvl === "READ" ? "R" : "W"}
                                    </button>
                                  );
                                })}
                                {grant ? (
                                  <button
                                    onClick={() => revoke(u.id, area, grant.id)}
                                    title="Revoke"
                                    className="text-[11px] font-semibold px-1.5 py-1 rounded-md border border-transparent text-gray-600 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10 transition-colors"
                                  >
                                    <X size={12} />
                                  </button>
                                ) : (
                                  <span className="text-[11px] text-gray-700 px-1.5 select-none">—</span>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      );
                    })}
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
