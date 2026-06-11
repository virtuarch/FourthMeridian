"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut, User } from "lucide-react";
import { signOut } from "next-auth/react";

interface Props {
  initial: string;
  name: string;
  username: string | null;
  email: string;
}

export function AdminUserMenu({ initial, name, username, email }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      {/* Avatar button */}
      <button
        onClick={() => setOpen((p) => !p)}
        className="w-8 h-8 rounded-full bg-red-500/20 border border-red-500/30 flex items-center justify-center text-xs font-bold text-red-400 hover:bg-red-500/30 transition-colors"
        aria-label="Account menu"
      >
        {initial}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="fixed top-[58px] right-3 w-52 bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden z-50">
          {/* Identity */}
          <div className="px-4 py-3 border-b border-gray-800">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center text-xs font-bold text-red-400 shrink-0">
                {initial}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white truncate">{name}</p>
                <p className="text-xs text-gray-500 truncate">
                  {username ? `@${username}` : email}
                </p>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="p-1.5">
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
