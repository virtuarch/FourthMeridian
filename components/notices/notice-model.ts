/**
 * components/notices/notice-model.ts  (UNIFIED NOTICES — pure rules)
 *
 * Which application notices show, in what order, and how dismissal behaves.
 * Pure and client-safe: the rail (NoticeRail.tsx) only lays these out; the
 * status route and the server layout produce the `AppNoticeStatus` it reads.
 *
 *   maintenance  — "Maintenance in progress". Highest priority, always first.
 *                  Dismissing COLLAPSES it to a one-line indicator for this
 *                  browser session — it never disappears while maintenance is
 *                  on, so the restriction stays discoverable — and the collapse
 *                  is forgotten when maintenance ends, so a later window shows
 *                  in full again. Display only: enforcement never reads this.
 *   two-factor   — "Protect your account with 2FA." for a user without 2FA.
 *                  Dismissing hides it for this browser session (and a
 *                  dismissal made in the old per-browser nudge is honoured).
 *                  Not shown on the AI conversation surface (AI-4, unchanged).
 *   connect      — "Add your first account" for a user with no live source who
 *                  has not dismissed it (lib/onboarding). Dismissing hides it at
 *                  once for this session AND persists server-side, so it never
 *                  returns. Not shown on Connections itself (that page IS the
 *                  invitation) or on the AI conversation surface.
 */

/** The one status read: `maintenance` null = could not tell (show nothing). */
export interface AppNoticeStatus {
  maintenance: boolean | null;
  twoFactorReminder: boolean;
  /** Connections pass PR 2 — present (true) only when the invitation applies. */
  connectInvitation?: boolean;
}

export const NOTICE_STATUS_URL = "/api/status/notices";

export const MAINTENANCE_TITLE = "Maintenance in progress";
export const MAINTENANCE_DESCRIPTION = "AI and account syncing are temporarily paused.";
export const TWO_FACTOR_TEXT = "Protect your account with 2FA.";
export const TWO_FACTOR_ACTION = "Enable";
/** The existing enrolment flow — unchanged. */
export const TWO_FACTOR_HREF = "/dashboard/settings/security";
export const CONNECT_TEXT = "Add your first account to see your full financial picture.";
export const CONNECT_ACTION = "Get started";
export const CONNECT_HREF = "/dashboard/connections";

/** Session-scoped dismissal keys (sessionStorage). */
export const MAINTENANCE_COLLAPSED_KEY = "fm.notice.maintenance.collapsed";
export const TWO_FACTOR_DISMISSED_KEY = "fm.notice.twoFactor.dismissed";
export const CONNECT_DISMISSED_KEY = "fm.notice.connect.dismissed";
/** The retired TotpNudgeBanner's per-browser dismissal (localStorage) — read, honoured, never written. */
export const LEGACY_TOTP_DISMISS_KEY = "fm.totpNudge.dismissed";

/** Fired after an operator changes maintenance, so the rail re-reads at once. */
export const NOTICE_REVALIDATE_EVENT = "fm:notices:revalidate";
/** Background revalidation while the tab is visible. */
export const NOTICE_REFRESH_MS = 2 * 60_000;
/** A focus/visibility re-read is skipped if the last one was this recent. */
export const NOTICE_FOCUS_THROTTLE_MS = 30_000;

export type NoticeView =
  | { id: "maintenance"; mode: "full" | "collapsed"; title: string; description: string }
  | { id: "two-factor"; mode: "full"; title: string; actionLabel: string; href: string }
  | { id: "connect"; mode: "full"; title: string; actionLabel: string; href: string };

export interface NoticeDismissals {
  maintenanceCollapsed: boolean;
  twoFactorDismissed: boolean;
  connectDismissed?: boolean;
}

/** The notices to render, highest priority first. Empty ⇒ the rail renders nothing. */
export function visibleNotices(
  status: AppNoticeStatus | null,
  dismissals: NoticeDismissals,
  opts: { conversationSurface: boolean; connectionsSurface?: boolean },
): NoticeView[] {
  if (!status) return [];
  const out: NoticeView[] = [];
  if (status.maintenance === true) {
    out.push({
      id: "maintenance", mode: dismissals.maintenanceCollapsed ? "collapsed" : "full",
      title: MAINTENANCE_TITLE, description: MAINTENANCE_DESCRIPTION,
    });
  }
  if (status.twoFactorReminder && !dismissals.twoFactorDismissed && !opts.conversationSurface) {
    out.push({ id: "two-factor", mode: "full", title: TWO_FACTOR_TEXT, actionLabel: TWO_FACTOR_ACTION, href: TWO_FACTOR_HREF });
  }
  if (status.connectInvitation === true && !dismissals.connectDismissed && !opts.conversationSurface && !opts.connectionsSurface) {
    out.push({ id: "connect", mode: "full", title: CONNECT_TEXT, actionLabel: CONNECT_ACTION, href: CONNECT_HREF });
  }
  return out;
}

/**
 * When maintenance is known to be off, a remembered collapse is forgotten — the
 * next maintenance window must announce itself in full.
 */
export function shouldForgetMaintenanceCollapse(status: AppNoticeStatus | null): boolean {
  return status !== null && status.maintenance === false;
}

/** Narrow an untrusted JSON body to the status shape, or null. */
export function readNoticeStatus(body: unknown): AppNoticeStatus | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const maintenance = b.maintenance === true ? true : b.maintenance === false ? false : null;
  return { maintenance, twoFactorReminder: b.twoFactorReminder === true, ...(b.connectInvitation === true ? { connectInvitation: true } : {}) };
}
