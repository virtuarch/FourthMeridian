/**
 * lib/session-cache.ts
 *
 * Short-TTL in-memory cache for the UserSession revocation check that backs
 * the NextAuth `session` callback (lib/auth.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * JWTs are stateless, so every getServerSession()/requireUser() call
 * re-validates against the UserSession row in Postgres (revokedAt IS NULL)
 * to catch revoked sessions immediately. Production logs showed that check
 * alone costing 1.1-2.4s per call, and it runs on EVERY Server Component
 * render and EVERY API route that checks auth — multiple times per page
 * navigation. That's the dominant cost behind the multi-second
 * /dashboard/workspaces latency.
 *
 * Revocation is rare, and a few seconds of staleness on an ordinary page
 * load is an acceptable trade-off for a 10-50x latency win. So:
 *
 *   - Normal requests (requireUser / getServerSession) may read a cached
 *     "still valid" result up to TTL_MS old instead of hitting the DB.
 *   - Sensitive actions (password change, disabling 2FA, regenerating
 *     recovery codes, revoking sessions, admin security actions) call
 *     requireFreshUser()/requireFreshSystemAdmin() (lib/session.ts), which
 *     NEVER read this cache — they always hit the DB directly.
 *
 * This does not remove the revocation check. It only lets cheap, frequent,
 * low-stakes checks skip the DB when a fresh-enough answer is already known.
 *
 * SCOPE / LIMITATIONS (serverless)
 * ---------------------------------
 * This is a module-level Map, so it's per-warm-Lambda-instance on Vercel —
 * there's no cross-instance invalidation. invalidateSession()/
 * clearAllSessions() clear the cache immediately on whichever instance
 * handles the revoke, but OTHER warm instances may still serve a stale
 * "valid" answer for up to TTL_MS. That's the accepted trade-off without a
 * shared store (Redis/Vercel KV). If one gets added later, swap the Map
 * below for it without touching any call site.
 */

type CacheEntry = {
  valid:     boolean;
  checkedAt: number;
};

/** How long a live DB result may be served from cache before re-checking. */
export const SESSION_CACHE_TTL_MS = 30_000; // 30 seconds

const cache = new Map<string, CacheEntry>();

/**
 * Returns the cached revocation result for `sessionToken` if present and
 * still fresh, or `null` if there's no entry / it expired (caller should
 * then do a live DB check and call setCachedRevocation with the result).
 */
export function getCachedRevocation(sessionToken: string): boolean | null {
  const entry = cache.get(sessionToken);
  if (!entry) return null;
  if (Date.now() - entry.checkedAt > SESSION_CACHE_TTL_MS) {
    cache.delete(sessionToken);
    return null;
  }
  return entry.valid;
}

/** Records a freshly DB-verified revocation result. */
export function setCachedRevocation(sessionToken: string, valid: boolean): void {
  cache.set(sessionToken, { valid, checkedAt: Date.now() });
}

/**
 * Targeted invalidation — call this when a specific session's token is
 * known at the moment it's revoked (e.g. user revokes one device, sign-out).
 * Cheaper than clearAllSessions() and doesn't punish unrelated sessions.
 */
export function invalidateSession(sessionToken: string): void {
  cache.delete(sessionToken);
}

/**
 * Bulk invalidation — call this when sessions are revoked without their
 * tokens in hand (e.g. "revoke all other sessions", admin bulk revoke).
 * Clears every cached entry rather than leaving stale ones behind.
 */
export function clearAllSessions(): void {
  cache.clear();
}

/** Test/diagnostic helper — current cache size. Not used in request paths. */
export function _debugCacheSize(): number {
  return cache.size;
}
