/**
 * app/admin/audit/page.tsx  —  Audit Log Viewer
 *
 * Shows the 200 most recent audit log entries across all users.
 * Read-only. Color-coded by action category.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";

function fmtDateTime(d: Date) {
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

// Color-code by action category
function actionStyle(action: string): string {
  if (action.includes("FAIL") || action.includes("ERROR"))  return "bg-red-500/10 text-red-400 border-red-500/20";
  if (action.includes("LOGIN"))                              return "bg-blue-500/10 text-blue-400 border-blue-500/20";
  if (action.includes("REGISTER") || action.includes("WALLET_ADD") || action.includes("PLAID")) return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  if (action.includes("PASSWORD"))                          return "bg-amber-500/10 text-amber-400 border-amber-500/20";
  if (action.includes("PROFILE") || action.includes("UPDATE")) return "bg-violet-500/10 text-violet-400 border-violet-500/20";
  return "bg-gray-700/50 text-gray-400 border-gray-600/30";
}

export default async function AdminAuditPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "SYSTEM_ADMIN") redirect("/dashboard");

  const logs = await db.auditLog.findMany({
    take:    200,
    orderBy: { createdAt: "desc" },
    select: {
      id:          true,
      action:      true,
      userId:      true,
      workspaceId: true,
      metadata:    true,
      createdAt:   true,
      user: { select: { email: true, username: true, name: true } },
    },
  });

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Audit Log</h1>
        <p className="text-sm text-gray-400 mt-0.5">Most recent {logs.length} events across all users</p>
      </div>

      <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 text-left">
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium hidden sm:table-cell">User</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Metadata</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, idx) => (
                <tr
                  key={log.id}
                  className={`${idx < logs.length - 1 ? "border-b border-gray-800/60" : ""} hover:bg-gray-800/30 transition-colors align-top`}
                >
                  {/* Action */}
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border font-mono ${actionStyle(log.action)}`}>
                      {log.action}
                    </span>
                  </td>

                  {/* User */}
                  <td className="px-4 py-3 hidden sm:table-cell">
                    {log.user ? (
                      <div>
                        <p className="text-xs text-white">
                          {log.user.username ? `@${log.user.username}` : (log.user.name ?? log.user.email)}
                        </p>
                        <p className="text-xs text-gray-600">{log.user.email}</p>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-600">—</span>
                    )}
                  </td>

                  {/* Metadata */}
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {log.metadata && Object.keys(log.metadata as object).length > 0 ? (
                      <pre className="text-xs text-gray-500 font-mono whitespace-pre-wrap max-w-xs">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    ) : (
                      <span className="text-xs text-gray-700">—</span>
                    )}
                  </td>

                  {/* Timestamp */}
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                    {fmtDateTime(log.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {logs.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-gray-600">
            No audit log entries yet.
          </div>
        )}
      </div>
    </div>
  );
}
