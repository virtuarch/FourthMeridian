/**
 * app/admin/users/page.tsx  —  All Users (full detail)
 *
 * Expanded user table: email, username, role, employment, use case,
 * workspace memberships with type + role, account counts, joined date.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const ROLE_PILL: Record<string, string> = {
  SYSTEM_ADMIN: "bg-red-500/15 text-red-400 border-red-500/20",
  USER:         "bg-gray-700/60 text-gray-300 border-gray-600/40",
};

const WS_ROLE_PILL: Record<string, string> = {
  OWNER:  "bg-amber-500/10 text-amber-400 border-amber-500/20",
  ADMIN:  "bg-orange-500/10 text-orange-400 border-orange-500/20",
  MEMBER: "bg-gray-700/50 text-gray-400 border-gray-600/30",
};

export default async function AdminUsersPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "SYSTEM_ADMIN") redirect("/dashboard");

  const users = await db.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id:               true,
      email:            true,
      username:         true,
      name:             true,
      firstName:        true,
      lastName:         true,
      role:             true,
      employmentStatus: true,
      useCase:          true,
      createdAt:        true,
      workspaces: {
        select: {
          role: true,
          workspace: {
            select: {
              id:   true,
              name: true,
              type: true,
              _count: { select: { accounts: true } },
            },
          },
        },
      },
    },
  });

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Users</h1>
        <p className="text-sm text-gray-400 mt-0.5">{users.length} registered account{users.length !== 1 ? "s" : ""}</p>
      </div>

      <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 text-left">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Details</th>
                <th className="px-4 py-3 font-medium hidden sm:table-cell">Workspaces</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, idx) => (
                <tr
                  key={u.id}
                  className={`${idx < users.length - 1 ? "border-b border-gray-800/60" : ""} hover:bg-gray-800/30 transition-colors align-top`}
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
                        {u.username && (
                          <p className="text-xs text-blue-400 mt-0.5">@{u.username}</p>
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

                  {/* Workspaces */}
                  <td className="px-4 py-3.5 hidden sm:table-cell">
                    {u.workspaces.length === 0 ? (
                      <span className="text-xs text-gray-600">No workspaces</span>
                    ) : (
                      <div className="space-y-1.5">
                        {u.workspaces.map((m) => (
                          <div key={m.workspace.id} className="flex items-center gap-1.5">
                            <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${WS_ROLE_PILL[m.role] ?? WS_ROLE_PILL.MEMBER}`}>
                              {m.role}
                            </span>
                            <span className="text-xs text-gray-300">{m.workspace.name}</span>
                            <span className="text-xs text-gray-600">
                              · {m.workspace._count.accounts} acct{m.workspace._count.accounts !== 1 ? "s" : ""}
                            </span>
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
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
