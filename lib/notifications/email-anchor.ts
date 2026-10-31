/**
 * lib/notifications/email-anchor.ts  (Comms Center A-2b — owner ruling 2026-10-31, O-7)
 *
 * Pure. No I/O.
 */

/**
 * Comms Center A-2b — the reserved metadata key that marks an EMAIL ANCHOR: a
 * Notification row written archived because the user's in-app channel was off
 * while the type's email (emailIndependentOfInApp) was on. Set ONLY by the
 * createNotification chokepoint (lib/notifications/create.ts; a producer-
 * supplied value is stripped there). Read by that chokepoint's dedupe
 * (an anchor holding its key is an OPEN condition whatever the user's in-app
 * setting is now: re-enabling in-app must not re-email the same outage) and
 * by jobs/retry-notifications.ts (an anchor's failed email is retried, not
 * closed as obsolete for being archived).
 */
export const EMAIL_ANCHOR_MARKER = "_commsEmailAnchor";

/** True when a stored metadata blob marks an email anchor. */
export function isEmailAnchorMetadata(metadata: unknown): boolean {
  return typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>)[EMAIL_ANCHOR_MARKER] === true;
}
