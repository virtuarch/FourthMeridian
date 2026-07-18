"use client";

/**
 * components/ui/GlobalActions.tsx
 *
 * The GlobalHeader's right-hand utility cluster — the prototype AppBar's
 * icon-only actions (components/app/AppBar.tsx): Refresh · Notifications ·
 * (rule) · account menu. Icon-only and borderless, because app chrome assumes
 * you learn it once; labelled buttons read as a website.
 *
 * These three affordances used to be scattered: Refresh lived in the desktop
 * top-bar AND the Sidebar footer AND the mobile header; the bell in two header
 * strips; identity + Sign out in the Sidebar footer. They are consolidated here
 * as the single canonical action cluster, mounted once in the GlobalHeader.
 */

import { RefreshButton } from "@/components/dashboard/RefreshButton";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { UserMenu } from "@/components/ui/UserMenu";

export function GlobalActions() {
  return (
    <div className="flex items-center gap-0.5">
      <RefreshButton bare />
      <NotificationBell />
      <div className="mx-1.5 h-4 w-px bg-[var(--border-hairline)]" aria-hidden />
      <UserMenu />
    </div>
  );
}
