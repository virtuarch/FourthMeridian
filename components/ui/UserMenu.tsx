"use client";

/**
 * components/ui/UserMenu.tsx
 *
 * The application menu — the anchored avatar dropdown in the GlobalHeader's
 * right-hand action cluster. It is the canonical home for user identity and
 * Sign out, both of which used to live loose in the desktop Sidebar footer
 * (Sidebar.tsx's bottom block). Moving them here matches the prototype
 * (components/app/UserMenu.tsx): identity at the top of an anchored 232px
 * menu, destructive Sign out separated by a rule at the bottom.
 *
 * Real actions (production, not the prototype's inert menu): Settings / Profile
 * are links into the settings tree; Sign out calls next-auth signOut exactly
 * as the old Sidebar footer did.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { ChevronDown, CircleUser, LogOut, Settings } from "lucide-react";

export function UserMenu() {
  const { data: session } = useSession();
  const user = session?.user;
  const initial = (user?.name ?? user?.email ?? "?")[0]?.toUpperCase() ?? "?";
  const username = user?.username ? `@${user.username}` : (user?.email ?? null);

  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={[
          "flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-1.5",
          "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-[var(--surface-hover)]",
          open ? "bg-[var(--surface-hover-strong)]" : "",
        ].join(" ")}
      >
        <span
          aria-hidden
          className="grid size-6 place-items-center rounded-full text-[10px] font-semibold text-[var(--meridian-400)]"
          style={{ background: "rgba(59,130,246,.16)", border: "1px solid rgba(125,168,255,.3)" }}
        >
          {initial}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={[
            "text-[var(--text-muted)] transition-transform duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-[232px] origin-top-right rounded-[var(--radius-md)] p-1 shadow-[0_16px_40px_rgba(0,0,0,.45)]"
          style={{
            // Solid glass (prototype tier="thick"): stronger surface opacity for
            // readability + clear separation from the content behind, while
            // keeping the shell's blur language.
            background: "var(--glass-thick)",
            border: "1px solid var(--border-hairline-strong)",
            backdropFilter: "blur(48px) saturate(150%)",
            WebkitBackdropFilter: "blur(48px) saturate(150%)",
          }}
        >
          <div className="border-b border-[var(--border-hairline)] px-2.5 pb-2.5 pt-2">
            <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
              {user?.name ?? "—"}
            </p>
            <p className="truncate text-[11px] text-[var(--text-muted)]">{username}</p>
          </div>

          <div className="py-1">
            <Link
              href="/dashboard/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-[var(--surface-hover)]"
            >
              <Settings size={13} strokeWidth={1.75} className="shrink-0 text-[var(--text-muted)]" />
              <span className="flex-1 text-[13px] text-[var(--text-secondary)]">Settings</span>
              <span className="text-[11px] text-[var(--text-muted)]">⌘,</span>
            </Link>
            <Link
              href="/dashboard/settings/account"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-[var(--surface-hover)]"
            >
              <CircleUser size={13} strokeWidth={1.75} className="shrink-0 text-[var(--text-muted)]" />
              <span className="flex-1 text-[13px] text-[var(--text-secondary)]">Profile</span>
            </Link>
          </div>

          <div className="border-t border-[var(--border-hairline)] pt-1">
            <button
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                await signOut({ redirect: false });
                window.location.href = "/login";
              }}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-[var(--surface-hover)]"
            >
              <LogOut size={13} strokeWidth={1.75} className="shrink-0 text-[var(--text-muted)]" />
              <span className="flex-1 text-[13px] text-[var(--text-secondary)]">Sign out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
