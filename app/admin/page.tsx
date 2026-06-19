/**
 * app/admin/page.tsx  —  Admin Overview
 *
 * Stat cards + quick-look tables for users and workspaces.
 * Data is fetched directly from the DB (server component) — no cookie
 * forwarding needed.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import Link from "next/link";
import { Users, Building2, CreditCard, ScrollText, ChevronRight } from "lucide-react";
import { formatDate, formatNumber } from "@/lib/format";

function fmtDate(iso: string | Date) {
  return formatDate(typeof iso === "string" ? iso : iso.toISOString());
}

const ROLE_PILL: Record<string, string> = {
  SYSTEM_ADMIN: "bg-red-500/15 text-red-400 border-red-500/20",
  USER:         "bg-gray-700/60 text-gray-300 border-gray-600/40",
};

const WS_TYPE_PILL: Record<string, string> = {
  PERSONAL: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  SHARED:   "bg-violet-500/10 text-violet-400 border-violet-500/20",
  BUSINESS: "bg-amber-500/10 text-amber-400 border-amber-500/20",
};

export default async function AdminOverviewPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "SYSTEM_ADMIN") redirect("/dashboard");

  const [users, workspaces, totalAccounts, totalAuditLogs] = await Promise.all([
    db.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, email: true, username: true, name: true, role: true, createdAt: true,
        workspaces: {
          select: { role: true, workspace: { select: { id: true, name: true, type: true } } },
        },
      },
    }),
    db.workspace.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, type: true, createdAt: true,
        members: {
          select: { role: true, user: { select: { id: true, email: true, username: true, name: true, role: true } } },
        },
        _count: { select: { accounts: true } },
      },
    }),
    db.account.count(),
    db.auditLog.count(),
  ]);

  const STAT_CARDS = [
    { label: "Users",      value: users.length,      icon: Users,      color: "text-blue-400",    bg: "bg-blue-500/10"    },
    { label: "Spaces",     value: workspaces.length,  icon: Building2,  color: "text-violet-400",  bg: "bg-violet-500/10"  },
    { label: "Accounts",   value: totalAccounts,      icon: CreditCard, color: "text-emerald-400", bg: "bg-emerald-500/10" },
    { label: "Audit Logs", value: totalAuditLogs,     icon: ScrollText, color: "text-amber-400",   bg: "bg-amber-500/10"   },
  ];

  return (
    <div className="space-y-8 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Overview</h1>
        <p className="text-sm text-gray-400 mt-0.5">System-wide snapshot of all users, Spaces, and activity.</p>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {STAT_CARDS.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="rounded-2xl border border-gray-800 bg-gray-900/60 px-5 py-4 flex items-center gap-4">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${bg}`}>
              <Icon size={18} className={color} />
            </div>
            <div>
              <p className="text-2xl font-bold text-white tabular-nums">{formatNumber(value)}</p>
              <p className="text-xs text-gray-400">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Users table ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-white">Users</h2>
          <Link href="/admin/users" className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors">
            View all <ChevronRight size={13} />
          </Link>
        </div>
        <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500 text-left">
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium hidden sm:table-cell">Space</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u, idx) => (
                  <tr
                    key={u.id}
                    className={`${idx < users.length - 1 ? "border-b border-gray-800/60" : ""} hover:bg-gray-800/40 transition-colors`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-white leading-tight">{u.name ?? u.email}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {u.username ? `@${u.username} · ` : ""}{u.email}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${ROLE_PILL[u.role] ?? ROLE_PILL.USER}`}>
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      {u.workspaces.length === 0 ? (
                        <span className="text-xs text-gray-600">—</span>
                      ) : (
                        <div className="space-y-0.5">
                          {u.workspaces.map((w) => (
                            <p key={w.workspace.id} className="text-xs text-gray-300">
                              {w.workspace.name}
                              <span className="text-gray-600 ml-1.5">({w.role})</span>
                            </p>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs text-gray-500">
                      {fmtDate(u.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Workspaces table ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-white">Spaces</h2>
          <Link href="/admin/workspaces" className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors">
            View all <ChevronRight size={13} />
          </Link>
        </div>
        <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500 text-left">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium hidden sm:table-cell">Members</th>
                  <th className="px-4 py-3 font-medium hidden sm:table-cell">Accounts</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">Created</th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((w, idx) => (
                  <tr
                    key={w.id}
                    className={`${idx < workspaces.length - 1 ? "border-b border-gray-800/60" : ""} hover:bg-gray-800/40 transition-colors`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-white">{w.name}</p>
                      <p className="text-xs text-gray-600 mt-0.5 font-mono">{w.id.slice(0, 8)}…</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${WS_TYPE_PILL[w.type] ?? WS_TYPE_PILL.PERSONAL}`}>
                        {w.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <div className="space-y-0.5">
                        {w.members.map((m) => (
                          <p key={m.user.id} className="text-xs text-gray-300">
                            {m.user.username ? `@${m.user.username}` : m.user.email}
                            <span className="text-gray-600 ml-1.5">({m.role})</span>
                          </p>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-xs text-gray-400 tabular-nums">
                      {w._count.accounts}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs text-gray-500">
                      {fmtDate(w.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
