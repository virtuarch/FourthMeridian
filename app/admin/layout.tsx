/**
 * app/admin/layout.tsx
 *
 * Admin panel shell. Wraps all /admin/* routes with a sidebar nav and
 * a header showing the current admin user. The sidebar is sticky on desktop
 * and collapses to a bottom bar on mobile.
 *
 * Access is enforced at middleware level — any non-SYSTEM_ADMIN session is
 * redirected to /dashboard before reaching this layout.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Shield } from "lucide-react";
import { AdminNav } from "@/components/admin/AdminNav";
import { AdminUserMenu } from "@/components/admin/AdminUserMenu";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "SYSTEM_ADMIN") redirect("/dashboard");

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* ── Top bar ── */}
      <header className="fixed top-0 inset-x-0 z-40 h-14 flex items-center justify-between px-4 border-b border-red-900/40 bg-gray-950/95 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center justify-center">
            <Shield size={14} className="text-red-400" />
          </div>
          <span className="text-sm font-bold text-white tracking-tight">FinTracker Admin</span>
          <span className="hidden sm:inline text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
            SYSTEM_ADMIN
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400 hidden sm:block">
            {session.user.username ? `@${session.user.username}` : session.user.email}
          </span>
          <AdminUserMenu
            initial={(session.user.name ?? session.user.email ?? "A")[0].toUpperCase()}
            name={session.user.name ?? session.user.email ?? "Admin"}
            username={session.user.username ?? null}
            email={session.user.email ?? ""}
          />
        </div>
      </header>

      <div className="pt-14 flex">
        {/* ── Sidebar (desktop) ── */}
        <aside className="hidden lg:flex flex-col w-52 shrink-0 fixed left-0 top-14 bottom-0 border-r border-gray-800/70 bg-gray-950 overflow-y-auto">
          <AdminNav />

          {/* Admin identity footer */}
          <div className="mt-auto p-4 border-t border-gray-800/70">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-red-500/20 flex items-center justify-center text-xs font-bold text-red-400 shrink-0">
                {(session.user.name ?? session.user.email ?? "A")[0].toUpperCase()}
              </div>
              <div className="overflow-hidden">
                <p className="text-xs font-medium text-white truncate">
                  {session.user.name ?? session.user.email}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {session.user.username ? `@${session.user.username}` : "admin"}
                </p>
              </div>
            </div>
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className="flex-1 lg:ml-52 pb-24 lg:pb-8 px-4 sm:px-6 lg:px-8 py-6 min-w-0">
          {children}
        </main>
      </div>

      {/* ── Bottom nav (mobile) ── */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-gray-800 bg-gray-950/95 backdrop-blur-sm">
        <div className="flex items-center justify-around h-16">
          <AdminNav mobile />
        </div>
      </nav>
    </div>
  );
}
