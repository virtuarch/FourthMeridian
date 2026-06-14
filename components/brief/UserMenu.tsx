"use client";

/**
 * UserMenu
 *
 * Avatar circle showing user initials.
 * Click opens a small dropdown with navigation shortcuts.
 */

import { useState, useRef, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import {
  LayoutDashboard,
  Settings,
  Brain,
  LogOut,
  ChevronDown,
} from "lucide-react";

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0][0] ?? "?").toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return "?";
}

const MENU_ITEMS = [
  { label: "Dashboard",       href: "/dashboard",          icon: LayoutDashboard },
  { label: "Analyze with AI", href: "/dashboard/analyze",  icon: Brain },
  { label: "Settings",        href: "/dashboard/settings", icon: Settings },
];

export function UserMenu() {
  const { data: session } = useSession();
  const [open, setOpen]   = useState(false);
  const ref               = useRef<HTMLDivElement>(null);

  const name     = session?.user?.name;
  const email    = session?.user?.email;
  const initials = getInitials(name, email);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 group"
        aria-label="User menu"
      >
        {/* Avatar circle */}
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500/40 to-blue-700/40 border border-white/20 backdrop-blur-sm flex items-center justify-center text-xs font-bold text-white ring-2 ring-transparent group-hover:ring-white/10 transition-all">
          {initials}
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-52 rounded-xl bg-gray-900/95 border border-white/10 backdrop-blur-xl shadow-2xl shadow-black/50 overflow-hidden z-50">
          {/* User info */}
          {(name || email) && (
            <div className="px-4 py-3 border-b border-white/[0.07]">
              {name && <p className="text-sm font-medium text-white truncate">{name}</p>}
              {email && <p className="text-xs text-gray-500 truncate mt-0.5">{email}</p>}
            </div>
          )}

          {/* Nav items */}
          <div className="p-1">
            {MENU_ITEMS.map(item => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                <item.icon className="w-4 h-4 text-gray-500" />
                {item.label}
              </Link>
            ))}
          </div>

          {/* Sign out */}
          <div className="p-1 border-t border-white/[0.07]">
            <button
              onClick={async () => { await signOut({ redirect: false }); window.location.href = "/login"; }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-400 hover:text-red-400 hover:bg-red-500/[0.06] transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
