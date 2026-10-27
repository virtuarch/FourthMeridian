"use client";

/**
 * components/notices/NoticeRail.tsx  (UNIFIED NOTICES)
 *
 * ONE compact notice rail for the authenticated shell, mounted once by
 * DashboardChrome. It replaces the bulky 2FA card (TotpNudgeBanner) and carries
 * the maintenance notice: thin hairline dividers inside one quiet frame, small
 * icons, one line per notice on desktop (wrapping on narrow screens).
 *
 * STATUS — one shared read, never per page. The server layout passes the
 * first status (no pop-in, no layout shift for maintenance); after that the
 * rail re-reads GET /api/status/notices when the tab regains focus (throttled),
 * every two minutes while visible, and at once when an operator changes
 * maintenance (NOTICE_REVALIDATE_EVENT). A failed re-read keeps the last known
 * status rather than flickering.
 *
 * DISMISSAL — per notice, for this browser session (notice-model.ts). Dismissing
 * maintenance collapses it to a one-line indicator; it is display only and
 * never touches enforcement.
 *
 * GEOMETRY — the AI page sizes itself to the viewport, so the rail publishes its
 * own height as `--fm-notice-rail-h` and AiShell subtracts it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Link2, ShieldCheck, Wrench, X } from "lucide-react";
import {
  CONNECT_DISMISSED_KEY, LEGACY_TOTP_DISMISS_KEY, MAINTENANCE_COLLAPSED_KEY, NOTICE_FOCUS_THROTTLE_MS, NOTICE_REFRESH_MS, NOTICE_REVALIDATE_EVENT,
  NOTICE_STATUS_URL, TWO_FACTOR_DISMISSED_KEY, readNoticeStatus, shouldForgetMaintenanceCollapse, visibleNotices,
  type AppNoticeStatus, type NoticeDismissals, type NoticeView,
} from "./notice-model";

const ICON_BTN = "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)] touch-manipulation";

// ── Presentation (pure; every state is renderable from props) ─────────────────

export function NoticeRailView({ notices, onDismiss, onExpand }: {
  notices: NoticeView[];
  onDismiss: (id: NoticeView["id"]) => void;
  onExpand: () => void;
}) {
  if (notices.length === 0) return null;
  return (
    <section aria-label="Notices" data-notice-rail
      className="overflow-hidden rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-muted)] divide-y divide-[var(--border-hairline)]">
      {notices.map((n) => {
        if (n.id === "maintenance" && n.mode === "collapsed") {
          return (
            <div key={n.id} data-notice="maintenance" data-mode="collapsed"
              className="flex items-center gap-2 px-3 py-1 text-[11px] text-[var(--text-secondary)]">
              <Wrench size={12} aria-hidden className="shrink-0 text-[var(--accent-warning)]" />
              <span className="min-w-0 flex-1 truncate">{n.title}</span>
              <button type="button" onClick={onExpand} aria-expanded={false} aria-label="Show maintenance details"
                className="shrink-0 rounded px-1.5 py-1 font-medium text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]">
                Details
              </button>
            </div>
          );
        }
        if (n.id === "maintenance") {
          return (
            <div key={n.id} role="status" data-notice="maintenance" data-mode="full" className="flex items-center gap-2.5 px-3 py-1.5 text-xs">
              <Wrench size={14} aria-hidden className="shrink-0 text-[var(--accent-warning)]" />
              <p className="min-w-0 flex-1 leading-snug">
                <span className="font-medium text-[var(--text-primary)]">{n.title}</span>
                <span className="hidden text-[var(--text-muted)] sm:inline" aria-hidden> · </span>
                <span className="block text-[var(--text-secondary)] sm:inline">{n.description}</span>
              </p>
              <button type="button" onClick={() => onDismiss(n.id)} aria-label="Dismiss maintenance notice" className={ICON_BTN}>
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        }
        if (n.id === "connect") {
          return (
            <div key={n.id} data-notice="connect" className="flex items-center gap-2.5 px-3 py-1.5 text-xs">
              <Link2 size={14} aria-hidden className="shrink-0 text-[var(--meridian-400)]" />
              <p className="min-w-0 flex-1 leading-snug text-[var(--text-secondary)]">{n.title}</p>
              <Link href={n.href}
                className="shrink-0 rounded-md px-2 py-1.5 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]">
                {n.actionLabel}
              </Link>
              <button type="button" onClick={() => onDismiss(n.id)} aria-label="Dismiss add-account invitation" className={ICON_BTN}>
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        }
        return (
          <div key={n.id} data-notice="two-factor" className="flex items-center gap-2.5 px-3 py-1.5 text-xs">
            <ShieldCheck size={14} aria-hidden className="shrink-0 text-[var(--text-muted)]" />
            <p className="min-w-0 flex-1 leading-snug text-[var(--text-secondary)]">{n.title}</p>
            <Link href={n.href}
              className="shrink-0 rounded-md px-2 py-1.5 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]">
              {n.actionLabel}
            </Link>
            <button type="button" onClick={() => onDismiss(n.id)} aria-label="Dismiss two-factor reminder" className={ICON_BTN}>
              <X size={14} aria-hidden />
            </button>
          </div>
        );
      })}
    </section>
  );
}

// ── Session dismissals: an external store over sessionStorage ─────────────────

const listeners = new Set<() => void>();
/** Fallback ONLY when sessionStorage is unavailable (blocked site data, some private modes). */
const memory: Record<string, boolean> = {};

function readFlag(key: string): boolean {
  try { return window.sessionStorage.getItem(key) === "1"; } catch { return memory[key] === true; }
}
function legacyTotpDismissed(): boolean {
  try { return window.localStorage.getItem(LEGACY_TOTP_DISMISS_KEY) === "1"; } catch { return false; }
}
function writeFlag(key: string, on: boolean): void {
  try { if (on) window.sessionStorage.setItem(key, "1"); else window.sessionStorage.removeItem(key); }
  catch { memory[key] = on; /* storage unavailable: the dismissal still holds for this page */ }
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
/** A string snapshot keeps identity stable between unchanged reads. */
const snapshot = () => `${readFlag(MAINTENANCE_COLLAPSED_KEY) ? 1 : 0}${readFlag(TWO_FACTOR_DISMISSED_KEY) || legacyTotpDismissed() ? 1 : 0}${readFlag(CONNECT_DISMISSED_KEY) ? 1 : 0}`;
/** Server and hydration: maintenance shows in full; 2FA and the invitation wait (no flash for someone who dismissed them). */
const serverSnapshot = () => "011";

/** The current session dismissals (also used by tests through a stand-in window). */
export function currentDismissals(): NoticeDismissals {
  const f = snapshot();
  return { maintenanceCollapsed: f[0] === "1", twoFactorDismissed: f[1] === "1", connectDismissed: f[2] === "1" };
}
/** Dismiss one notice for this browser session. Maintenance collapses; 2FA hides.
 *  The invitation hides at once AND is persisted server-side (POST /api/onboarding),
 *  so it does not return on another device or a later session. */
export function dismissNotice(id: NoticeView["id"]): void {
  if (id === "connect") {
    writeFlag(CONNECT_DISMISSED_KEY, true);
    try {
      void fetch("/api/onboarding", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "dismissed" }), keepalive: true,
      }).catch(() => {});
    } catch { /* no fetch: the session dismissal still holds */ }
    return;
  }
  writeFlag(id === "maintenance" ? MAINTENANCE_COLLAPSED_KEY : TWO_FACTOR_DISMISSED_KEY, true);
}
/** Re-open a collapsed maintenance notice. */
export function expandMaintenanceNotice(): void {
  writeFlag(MAINTENANCE_COLLAPSED_KEY, false);
}
/** Maintenance ended: forget its collapse so the next window shows in full. */
export function forgetMaintenanceCollapse(): void {
  if (readFlag(MAINTENANCE_COLLAPSED_KEY)) writeFlag(MAINTENANCE_COLLAPSED_KEY, false);
}

/** Ask the rail to re-read now (e.g. after an operator changed maintenance). */
export function requestNoticeRevalidation(): void {
  try { window.dispatchEvent(new Event(NOTICE_REVALIDATE_EVENT)); } catch { /* no window */ }
}

// ── The mounted rail ───────────────────────────────────────────────────────────

export function NoticeRail({ initialStatus, conversationSurface = false }: {
  initialStatus: AppNoticeStatus | null;
  conversationSurface?: boolean;
}) {
  const [status, setStatus] = useState<AppNoticeStatus | null>(initialStatus);
  const flags = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const dismissals: NoticeDismissals = { maintenanceCollapsed: flags[0] === "1", twoFactorDismissed: flags[1] === "1", connectDismissed: flags[2] === "1" };
  // Connections IS the invitation — never show it on top of itself.
  const connectionsSurface = (usePathname() ?? "").startsWith("/dashboard/connections");
  const lastRead = useRef(0);
  const frame = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    lastRead.current = Date.now();
    try {
      const res = await fetch(NOTICE_STATUS_URL, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return; // keep the last known status
      const next = readNoticeStatus(await res.json().catch(() => null));
      if (next) setStatus(next);
    } catch { /* keep the last known status */ }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server had no status: read it once now
    if (initialStatus === null) void refresh();
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRead.current < NOTICE_FOCUS_THROTTLE_MS) return;
      void refresh();
    };
    const onRevalidate = () => { void refresh(); };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, NOTICE_REFRESH_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener(NOTICE_REVALIDATE_EVENT, onRevalidate);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener(NOTICE_REVALIDATE_EVENT, onRevalidate);
    };
  }, [initialStatus, refresh]);

  // A remembered collapse ends with the maintenance window it belonged to.
  useEffect(() => {
    if (shouldForgetMaintenanceCollapse(status)) forgetMaintenanceCollapse();
  }, [status]);

  const notices = visibleNotices(status, dismissals, { conversationSurface, connectionsSurface });

  // Publish the rail's height for full-viewport surfaces (AiShell subtracts it).
  useEffect(() => {
    const root = document.documentElement;
    const el = frame.current;
    if (!el) { root.style.removeProperty("--fm-notice-rail-h"); return; }
    const publish = () => root.style.setProperty("--fm-notice-rail-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty("--fm-notice-rail-h"); };
  }, [notices.length]);

  if (notices.length === 0) return null;
  return (
    <div ref={frame} className="pb-4">
      <NoticeRailView
        notices={notices}
        onDismiss={dismissNotice}
        onExpand={expandMaintenanceNotice}
      />
    </div>
  );
}
