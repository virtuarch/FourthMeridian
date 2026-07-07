"use client";

/**
 * NotificationBell  (OPS-3 S2)
 *
 * The bell + Notification Center panel — the first user-facing OPS-3 surface.
 * Self-contained, self-fetching client component (the TotpSection /
 * ActiveSessions / UserButton house pattern), mounted in both DashboardChrome
 * header strips.
 *
 * DATA: reads the S2 API only (GET /api/notifications, GET
 * /api/notifications/unread-count, POST /api/notifications/[id]/read, POST
 * /api/notifications/read-all) — which reads `Notification` only. No AuditLog,
 * no derivation, no direct DB access from the client.
 *
 * BADGE: fetch-on-navigation (usePathname) + a slow 60s poll + window focus.
 * No server push (frozen S2 — deferred with real-time work). Hidden at zero.
 *
 * READ SEMANTICS (frozen): opening the panel marks NOTHING read. Clicking an
 * item marks it read (optimistic) and follows its href when present;
 * "Mark all read" is the single bulk action. No archive/delete in this slice
 * (S2 was narrowed to read-state only; archive ships with a later touch).
 *
 * Icons resolve from the registry's kebab-case lucide keys via the
 * lucide-react `icons` map — the registry stays the single definition site;
 * this component contains no per-type switch.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bell, CheckCheck, icons, type LucideIcon } from "lucide-react";
import { formatRelativeTime } from "@/lib/format";
import type { NotificationListItem } from "@/lib/notifications/read";

/** "triangle-alert" → icons["TriangleAlert"], with Bell as the safe fallback. */
function iconFor(key: string): LucideIcon {
  const pascal = key
    .split("-")
    .map((s) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s))
    .join("");
  return (icons as Record<string, LucideIcon>)[pascal] ?? Bell;
}

/** Priority accent for the item's icon tint. NORMAL/LOW stay neutral. */
function priorityTint(priority: string): string {
  if (priority === "CRITICAL") return "text-red-400";
  if (priority === "HIGH") return "text-amber-400";
  return "text-[var(--text-secondary)]";
}

const POLL_MS = 60_000;

export function NotificationBell() {
  const pathname = usePathname();
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationListItem[] | null>(null); // null = loading
  const [busy, setBusy] = useState(false);

  // ── Badge: navigation + slow poll + focus. Best-effort; failures keep the
  //    last known count rather than flashing errors into the chrome.
  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/unread-count");
      if (!res.ok) return;
      const data = (await res.json()) as { count?: number };
      if (typeof data.count === "number") setUnread(data.count);
    } catch {
      /* keep last known count */
    }
  }, []);

  // Fetch-on-navigation: the count updates from the network response callback
  // (external-system subscription shape), never synchronously in the effect
  // body — cancelled guards a route change racing a slow response.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/notifications/unread-count")
      .then((res) => (res.ok ? (res.json() as Promise<{ count?: number }>) : null))
      .then((data) => {
        if (!cancelled && data && typeof data.count === "number") setUnread(data.count);
      })
      .catch(() => {
        /* keep last known count */
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    const timer = setInterval(refreshCount, POLL_MS);
    window.addEventListener("focus", refreshCount);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshCount);
    };
  }, [refreshCount]);

  // ── Panel: fetch the list on open (loading state = items === null).
  const openPanel = useCallback(async () => {
    setOpen(true);
    setItems(null);
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) {
        setItems([]);
        return;
      }
      const data = (await res.json()) as {
        notifications?: NotificationListItem[];
        unreadCount?: number;
      };
      setItems(data.notifications ?? []);
      if (typeof data.unreadCount === "number") setUnread(data.unreadCount);
    } catch {
      setItems([]);
    }
  }, []);

  // Close on outside click (UserButton pattern).
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Read-state actions (optimistic; POST is fire-and-verify).
  async function markRead(item: NotificationListItem) {
    if (!item.read) {
      setItems((prev) =>
        prev?.map((n) => (n.id === item.id ? { ...n, read: true } : n)) ?? prev,
      );
      setUnread((u) => Math.max(0, u - 1));
      try {
        await fetch(`/api/notifications/${item.id}/read`, { method: "POST" });
      } catch {
        /* best-effort; next poll reconciles */
      }
    }
    if (item.href) {
      setOpen(false);
      router.push(item.href);
    }
  }

  async function markAllRead() {
    if (busy) return;
    setBusy(true);
    setItems((prev) => prev?.map((n) => ({ ...n, read: true })) ?? prev);
    setUnread(0);
    try {
      await fetch("/api/notifications/read-all", { method: "POST" });
    } catch {
      /* best-effort; next poll reconciles */
    } finally {
      setBusy(false);
    }
  }

  const hasUnreadInList = items?.some((n) => !n.read) ?? false;

  return (
    <div ref={ref} className="relative">
      {/* Bell trigger — sized/styled like the adjacent chrome buttons. */}
      <button
        onClick={() => (open ? setOpen(false) : openPanel())}
        className="relative w-8 h-8 rounded-full flex items-center justify-center touch-manipulation text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
      >
        <Bell size={17} strokeWidth={1.75} />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-4 text-center"
            aria-hidden
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {/* Panel — fixed so it never overflows the viewport edge (UserButton). */}
      {open && (
        <div className="fixed top-[58px] right-3 w-[min(24rem,calc(100vw-1.5rem))] bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden z-50">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800">
            <p className="text-xs font-semibold text-white">Notifications</p>
            <button
              onClick={markAllRead}
              disabled={busy || !hasUnreadInList}
              className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              <CheckCheck size={13} strokeWidth={1.75} />
              Mark all read
            </button>
          </div>

          {/* Body */}
          <div className="max-h-[min(28rem,70vh)] overflow-y-auto">
            {items === null ? (
              // Loading state
              <div className="px-4 py-8 text-center text-xs text-gray-500">
                Loading notifications…
              </div>
            ) : items.length === 0 ? (
              // Empty state
              <div className="px-4 py-10 text-center">
                <Bell size={20} strokeWidth={1.5} className="mx-auto mb-2 text-gray-600" />
                <p className="text-xs text-gray-500">You&apos;re all caught up.</p>
              </div>
            ) : (
              <ul>
                {items.map((n) => {
                  const Icon = iconFor(n.icon);
                  return (
                    <li key={n.id} className="border-b border-gray-800 last:border-b-0">
                      <button
                        onClick={() => markRead(n)}
                        className={[
                          "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-800/60",
                          n.read ? "opacity-60" : "",
                        ].join(" ")}
                      >
                        <span className={["mt-0.5 shrink-0", priorityTint(n.priority)].join(" ")}>
                          <Icon size={15} strokeWidth={1.75} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span
                              className={[
                                "text-xs truncate",
                                n.read ? "text-gray-400" : "text-white font-medium",
                              ].join(" ")}
                            >
                              {n.title}
                            </span>
                            {!n.read && (
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" aria-label="Unread" />
                            )}
                          </span>
                          {n.body && (
                            <span className="block text-[11px] text-gray-500 mt-0.5 line-clamp-2">
                              {n.body}
                            </span>
                          )}
                          <span className="block text-[10px] text-gray-600 mt-1">
                            {formatRelativeTime(n.createdAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
