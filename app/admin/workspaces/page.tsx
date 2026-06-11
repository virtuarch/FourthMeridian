/**
 * app/admin/workspaces/page.tsx  —  All Workspaces (full detail)
 *
 * Full workspace table with member list, account breakdown by type,
 * Plaid item count, and created date.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const WS_TYPE_PILL: Record<string, string> = {
  PERSONAL: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  SHARED:   "bg-violet-500/10 text-violet-400 border-violet-500/20",
  BUSINESS: "bg-amber-500/10 text-amber-400 border-amber-500/20",
};

const WS_ROLE_PILL: Record<string, string> = {
  OWNER:  "bg-amber-500/10 text-amber-400 border-amber-500/20",
  ADMIN:  "bg-orange-500/10 text-orange-400 border-orange-500/20",
  MEMBER: "bg-gray-700/50 text-gray-400 border-gray-600/30",
};

export default async function AdminWorkspacesPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "SYSTEM_ADMIN") redirect("/dashboard");

  const workspaces = await db.workspace.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id:        true,
      name:      true,
      type:      true,
      createdAt: true,
      members: {
        select: {
          role: true,
          user: { select: { id: true, email: true, username: true, name: true, firstName: true } },
        },
      },
      accounts: {
        select: { type: true },
      },
    },
  });

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Workspaces</h1>
        <p className="text-sm text-gray-400 mt-0.5">{workspaces.length} workspace{workspaces.length !== 1 ? "s" : ""} across all users</p>
      </div>

      <div className="space-y-4">
        {workspaces.map((w) => {
          // Account breakdown by type
          const byType: Record<string, number> = {};
          for (const a of w.accounts) {
            byType[a.type] = (byType[a.type] ?? 0) + 1;
          }

          const typeOrder = ["checking", "savings", "investment", "crypto", "debt"];
          const typeBadges = typeOrder
            .filter((t) => byType[t])
            .map((t) => ({ type: t, count: byType[t] }));

          return (
            <div key={w.id} className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
              {/* Header */}
              <div className="px-5 py-4 flex flex-wrap items-start justify-between gap-3 border-b border-gray-800/60">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold text-white">{w.name}</h2>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${WS_TYPE_PILL[w.type] ?? WS_TYPE_PILL.PERSONAL}`}>
                      {w.type}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 font-mono mt-0.5">{w.id}</p>
                </div>
                <p className="text-xs text-gray-500">Created {fmtDate(w.createdAt)}</p>
              </div>

              <div className="px-5 py-4 grid sm:grid-cols-3 gap-6">
                {/* Members */}
                <div>
                  <p className="text-xs text-gray-500 font-medium uppercase tracking-widest mb-2">
                    Members ({w.members.length})
                  </p>
                  <div className="space-y-2">
                    {w.members.map((m) => (
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
                  </div>
                </div>

                {/* Account breakdown */}
                <div>
                  <p className="text-xs text-gray-500 font-medium uppercase tracking-widest mb-2">
                    Accounts ({w.accounts.length})
                  </p>
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

                {/* Connected members detail */}
                <div>
                  <p className="text-xs text-gray-500 font-medium uppercase tracking-widest mb-2">
                    Member Emails
                  </p>
                  {w.members.length === 0 ? (
                    <p className="text-xs text-gray-600">—</p>
                  ) : (
                    <div className="space-y-1">
                      {w.members.map((m) => (
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
    </div>
  );
}
