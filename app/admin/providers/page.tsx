/**
 * app/admin/providers/page.tsx — Provider Diagnostics
 *
 * Read-only health view over every PlaidItem: status, last error, last
 * sync/refresh times, and linked account count. D2 Step 7F — see
 * docs/initiatives/d2/implementation/D2_STEP7F_PROVIDER_DIAGNOSTICS_CHECKLIST.md.
 *
 * Data is fetched directly from the DB (server component), same pattern as
 * app/admin/page.tsx. No actions, no mutations — diagnostics only. Never
 * selects PlaidItem.encryptedToken or PlaidItem.cursor, and never reads
 * AccountConnection.syncStatus / FinancialAccount.syncStatus as a health
 * signal — see the checklist's Risks section for why those fields don't
 * reflect Plaid failures today.
 *
 * D4 Slice 0 — adds a per-row "Diagnostics" action that opens a client-side
 * drawer (ProviderDiagnosticsDrawer). The drawer fetches extended data from
 * POST /api/admin/plaid/diagnostics on open; this page stays a server
 * component. ProviderActionsButton is the client leaf that owns drawer state.
 *
 * D4 Slice 2 — selects institutionId and account masks to compute
 * expandHistoryEligible per row. Passed to ProviderActionsButton as
 * serializable props (no functions, no class instances). The expand-history-
 * token endpoint re-validates these conditions server-side before touching
 * Plaid; the prop is a UX hint only.
 *
 * expandHistoryEligible is true when:
 *   - item.status === ACTIVE
 *   - at least one live AccountConnection exists
 *   - every connected FinancialAccount has a non-null mask
 *
 * The cursor / institutionId server-side checks remain in the API endpoint.
 * We intentionally do not select cursor here to avoid leaking the sync token
 * into the server component render (consistent with the diagnostics endpoint).
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { formatDate, formatDateTimeShort } from "@/lib/format";
import { ProviderActionsButton } from "@/components/admin/ProviderActionsButton";

function fmtDate(d: Date) {
  return formatDate(d.toISOString());
}

function fmtDateTime(d: Date | null) {
  return formatDateTimeShort(d ? d.toISOString() : null);
}

const STATUS_PILL: Record<string, string> = {
  ACTIVE:       "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  NEEDS_REAUTH: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  ERROR:        "bg-red-500/15 text-red-400 border-red-500/20",
  REVOKED:      "bg-gray-700/60 text-gray-400 border-gray-600/40",
};

export default async function AdminProvidersPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "SYSTEM_ADMIN") redirect("/dashboard");

  const plaidItems = await db.plaidItem.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id:                  true,
      externalItemId:      true,
      institutionId:       true,
      institutionName:     true,
      status:              true,
      errorCode:           true,
      lastSyncedAt:        true,
      lastManualRefreshAt: true,
      createdAt:           true,
      user: {
        select: { email: true, username: true, name: true },
      },
      _count: {
        select: { connections: true },
      },
      // D4 Slice 2 — mask data for expandHistoryEligible computation.
      // Only non-deleted connections; mask null-check determines whether
      // resolveAccountByFingerprint can safely match after a fresh link.
      connections: {
        where:  { deletedAt: null },
        select: {
          financialAccount: {
            select: { mask: true },
          },
        },
      },
    },
  });

  return (
    <div className="space-y-8 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Providers</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Read-only connection health for every linked provider item.
        </p>
      </div>

      <section>
        <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500 text-left">
                  <th className="px-4 py-3 font-medium">Institution</th>
                  <th className="px-4 py-3 font-medium">Owner</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium hidden sm:table-cell">Linked accounts</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">Last synced</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">Last manual refresh</th>
                  <th className="px-4 py-3 font-medium hidden lg:table-cell">Connected</th>
                  <th className="px-4 py-3 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {plaidItems.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-sm text-gray-500">
                      No provider connections yet.
                    </td>
                  </tr>
                ) : (
                  plaidItems.map((item, idx) => (
                    <tr
                      key={item.id}
                      className={`${idx < plaidItems.length - 1 ? "border-b border-gray-800/60" : ""} hover:bg-gray-800/40 transition-colors`}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-white leading-tight">{item.institutionName}</p>
                        <p className="text-xs text-gray-600 mt-0.5 font-mono">{item.externalItemId}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-white leading-tight">{item.user.name ?? item.user.email}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {item.user.username ? `@${item.user.username} · ` : ""}{item.user.email}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_PILL[item.status] ?? STATUS_PILL.ACTIVE}`}>
                          {item.status}
                        </span>
                        {item.errorCode && (
                          <p className="text-xs text-gray-500 mt-1 font-mono">{item.errorCode}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-xs text-gray-400 tabular-nums">
                        {item._count.connections}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-xs text-gray-500">
                        {fmtDateTime(item.lastSyncedAt)}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-xs text-gray-500">
                        {fmtDateTime(item.lastManualRefreshAt)}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-xs text-gray-500">
                        {fmtDate(item.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ProviderActionsButton
                          plaidItemId={item.id}
                          institutionId={item.institutionId}
                          institutionName={item.institutionName}
                          expandHistoryEligible={
                            item.status === "ACTIVE" &&
                            item.connections.length > 0 &&
                            item.connections.every(
                              (c) => c.financialAccount.mask !== null,
                            )
                          }
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
