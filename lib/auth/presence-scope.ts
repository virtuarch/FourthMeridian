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
 * CONFINED. `runWithoutSessionTouch` is imported by app/api/user/presence/route.ts
 * ONLY and `isSessionTouchSuppressed` by lib/auth.ts ONLY (static pin in
 * lib/auth/presence-scope.test.ts), so no other route can silently stop counting
 * session use.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<{ readonly suppressTouch: true }>();

/** Run `fn` (the heartbeat's session guard) with the session touch switched off. */
export function runWithoutSessionTouch<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ suppressTouch: true }, fn);
}

/** True only inside runWithoutSessionTouch's async scope. Read by lib/auth.ts. */
export function isSessionTouchSuppressed(): boolean {
  return scope.getStore()?.suppressTouch === true;
}
