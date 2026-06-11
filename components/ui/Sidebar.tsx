"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import {
  LayoutDashboard,
  Building2,
  Brain,
  RefreshCw,
  LogOut,
  Pencil,
} from "lucide-react";

const nav = [
  { label: "Dashboard",       href: "/dashboard",            icon: LayoutDashboard },
  { label: "Workspaces",      href: "/dashboard/workplaces", icon: Building2 },
  { label: "Analyze with AI", href: "/dashboard/analyze",    icon: Brain },
];

export function Sidebar() {
  const path              = usePathname();
  const { data: session } = useSession();

  const user     = session?.user;
  const initial  = (user?.name ?? user?.email ?? "?")[0].toUpperCase();
  const username = user?.username ? `@${user.username}` : null;

  return (
    <aside className="hidden lg:flex flex-col w-60 shrink-0 border-r border-gray-800 bg-gray-950 min-h-screen sticky top-0">
      {/* Logo */}
      <div className="flex items-center gap-1.5 px-5 h-16 border-b border-gray-800">
        <img src="/logo-icon.png" alt="FinTracker" className="w-8 h-8 rounded-xl shrink-0 object-contain" />
        <span className="font-bold text-white text-lg">FinTracker</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {nav.map(({ label, href, icon: Icon }) => {
          const active =
            href === "/dashboard"
              ? path === "/dashboard"
              : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-600/20 text-blue-400"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
            >
              <Icon size={18} strokeWidth={active ? 2.5 : 1.75} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-5 space-y-1">
        <button className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
          <RefreshCw size={18} strokeWidth={1.75} />
          Refresh Data
        </button>

        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <LogOut size={18} strokeWidth={1.75} />
          Sign Out
        </button>

        {/* User identity */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div className="w-7 h-7 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0">
            <span className="text-blue-400 text-xs font-semibold">{initial}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-white truncate">{user?.name ?? "—"}</p>
            {username ? (
              <p className="text-xs text-gray-500 truncate">{username}</p>
            ) : (
              <p className="text-xs text-gray-600 truncate">{user?.email}</p>
            )}
          </div>
          <Link
            href="/dashboard/settings"
            className="p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-gray-800 transition-colors shrink-0"
            title="Edit profile"
          >
            <Pencil size={12} />
          </Link>
        </div>
      </div>
    </aside>
  );
}
