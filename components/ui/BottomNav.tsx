"use client";

/**
 * BottomNav
 *
 * Mobile counterpart to Sidebar — same Spaces-first IA, different pattern.
 * The desktop sidebar can afford an inline, always-expanded Spaces tree;
 * a bottom bar can't, so this collapses to four top-level destinations
 * (Brief / Spaces / AI / Settings) and lets /dashboard/spaces carry the
 * full Spaces experience (switching, creating, exploring) on mobile.
 *
 * "Spaces" is active both on /dashboard/spaces and on /dashboard itself —
 * the latter is a Space's dashboard, reached by picking a Space, so it
 * reads as part of the same section rather than a separate "Dashboard" tab.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, LayoutGrid, Brain, Settings as SettingsIcon } from "lucide-react";

const nav = [
  { label: "Brief",    href: "/dashboard/brief",    icon: Sparkles },
  { label: "Spaces",   href: "/dashboard/spaces",   icon: LayoutGrid },
  { label: "AI",       href: "/dashboard/analyze",  icon: Brain },
  { label: "Settings", href: "/dashboard/settings", icon: SettingsIcon },
];

function isActive(href: string, path: string): boolean {
  if (href === "/dashboard/spaces") {
    return path.startsWith("/dashboard/spaces") || path === "/dashboard";
  }
  return path.startsWith(href);
}

export function BottomNav() {
  const path = usePathname();
  return (
    <nav
      className="lg:hidden fixed bottom-0 inset-x-0 z-50"
      style={{
        borderTop:      "1px solid var(--border-hairline)",
        background:     "var(--glass-regular)",
        backdropFilter: "blur(30px) saturate(160%)",
      }}
    >
      <div className="flex items-center justify-around h-16">
        {nav.map(({ label, href, icon: Icon }) => {
          const active = isActive(href, path);
          return (
            <Link
              key={href}
              href={href}
              className="flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-colors"
              style={{ color: active ? "var(--meridian-400)" : "var(--text-muted)" }}
            >
              <Icon size={20} strokeWidth={active ? 2.5 : 1.5} />
              <span className="text-xs font-medium">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
