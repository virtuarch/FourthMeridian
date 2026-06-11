"use client";

import { useEffect, useRef, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { LogOut, Settings, Wallet } from "lucide-react";
import Link from "next/link";
import { ConnectAccountButton } from "@/components/dashboard/ConnectAccountButton";
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";

export function UserButton() {
  const { data: session } = useSession();
  const [open,       setOpen]       = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const ref                         = useRef<HTMLDivElement>(null);

  const user     = session?.user;
  const initial  = (user?.name ?? user?.email ?? "?")[0].toUpperCase();
  const username = user?.username ? `@${user.username}` : user?.email ?? "";

  // Close dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <>
      <div ref={ref} className="relative">
        {/* Avatar trigger */}
        <button
          onClick={() => setOpen((p) => !p)}
          className="w-8 h-8 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center touch-manipulation"
          aria-label="Account menu"
        >
          <span className="text-blue-400 text-xs font-semibold">{initial}</span>
        </button>

        {/* Dropdown — fixed so it never overflows the viewport edge */}
        {open && (
          <div className="fixed top-[58px] right-3 w-56 bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden z-50">
            {/* Identity */}
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0">
                  <span className="text-blue-400 text-xs font-semibold">{initial}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">{user?.name ?? "—"}</p>
                  <p className="text-xs text-gray-500 truncate">{username}</p>
                </div>
              </div>
            </div>

            {/* Access section */}
            <div className="p-1.5 border-b border-gray-800">
              <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest px-3 pt-1 pb-0.5">Access</p>
              <ConnectAccountButton variant="row" onDone={() => setOpen(false)} />
              <button
                onClick={() => { setOpen(false); setWalletOpen(true); }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-gray-300 hover:bg-gray-800 transition-colors"
              >
                <Wallet size={14} className="shrink-0" />
                Add Wallet
              </button>
            </div>

            {/* Settings + Sign out */}
            <div className="p-1.5 space-y-0.5">
              <Link
                href="/dashboard/settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-gray-300 hover:bg-gray-800 transition-colors"
              >
                <Settings size={14} />
                Settings
              </Link>
              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LogOut size={14} />
                Sign Out
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Wallet modal — rendered outside the dropdown so z-index works cleanly */}
      {walletOpen && <AddWalletModal onClose={() => setWalletOpen(false)} />}
    </>
  );
}
