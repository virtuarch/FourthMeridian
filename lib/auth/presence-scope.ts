/**
 * lib/auth/presence-scope.ts  (PB-10 — the ONE exemption from the session touch)
 *
 * The presence heartbeat is itself an authenticated request. Resolving its
 * session goes through the NextAuth session callback (lib/auth.ts), which on a
 * LIVE revocation check calls touchSessionActivity() and bumps
 * UserSession.lastActiveAt. Left alone, an open tab's heartbeat would keep
 * lastActiveAt fresh forever and DEFEAT the SEC-010 30-day idle cut-off — a
 * security regression, and the very "idle tab looks active" defect PB-10 fixes.
 *
 * THE SHAPE. Not a second validator. The heartbeat route runs the NORMAL guard
 * (requireUser → getServerSession → the same session callback: claims, the
 * revocation cache, row exists / not revoked / owned, SEC-010 lifetime, current
 * role, pending-TOTP gate) inside `runWithoutSessionTouch`. The callback reads
 * `isSessionTouchSuppressed()` and skips ONLY the touch side effect. Every
 * check runs exactly as on any other request — "without the touch" can never
 * become "without the checks".
 *
 * REQUEST-SCOPED. AsyncLocalStorage binds the flag to the heartbeat's own async
 * continuation; a concurrent ordinary request on the same instance has its own
 * (empty) store and still touches (pinned by presence-scope.test.ts).
 *
 * CONFINED. `runWithoutSessionTouch` is imported ONLY by the server-decided
 * allowlist of BACKGROUND routes below, and `isSessionTouchSuppressed` by
 * lib/auth.ts ONLY (static pin in lib/auth/presence-scope.test.ts), so no other
 * route can silently stop counting session use, and no client header can opt a
 * request out.
 *
 * PB-10 F3 — the allowlist. On Preview an untouched tab still moved
 * lastActiveAt (and wrote SESSION_ACTIVE_DAY) through three background reads;
 * they now run the full guard with the touch switched off:
 *   app/api/user/presence/route.ts              the heartbeat
 *   app/api/notifications/unread-count/route.ts the bell's 60 s poll
 *   app/api/status/notices/route.ts             the notice rail's focus re-read
 *   app/api/auth/[...nextauth]/route.ts         GET /api/auth/session only (the
 *                                               SessionProvider focus refetch)
 */

import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<{ readonly suppressTouch: true }>();

/** The ONLY modules that may switch the touch off (pinned by presence-scope.test.ts). */
export const SESSION_TOUCH_EXEMPT_ROUTES = [
  "app/api/user/presence/route.ts",
  "app/api/notifications/unread-count/route.ts",
  "app/api/status/notices/route.ts",
  "app/api/auth/[...nextauth]/route.ts",
] as const;

/** Run `fn` (an allowlisted background route's session guard) with the session touch switched off. */
export function runWithoutSessionTouch<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ suppressTouch: true }, fn);
}

/** True only inside runWithoutSessionTouch's async scope. Read by lib/auth.ts. */
export function isSessionTouchSuppressed(): boolean {
  return scope.getStore()?.suppressTouch === true;
}
