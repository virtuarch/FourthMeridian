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
 * /dashboard/spaces latency.
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
 * ── PROD-POOLER-AUTH-INCIDENT-1 ──────────────────────────────────────────────
 * Two production incidents (2026-07-25 14:57:38Z and 2026-07-26 11:40:08Z,
 * ~90s each) traced to this check. Two distinct defects, both fixed here:
 *
 * 1. THUNDERING HERD. On a cold instance — or the instant the TTL lapses —
 *    every concurrent request missed the cache simultaneously and each issued
 *    its OWN `userSession.findFirst()`. Production runs Prisma with
 *    `connection_limit=1` (see docs/operations/deployment.md) AND Vercel Fluid
 *    Compute, so those concurrent requests share ONE process and therefore ONE
 *    pooled connection: N identical queries queued behind each other until the
 *    10s pool timeout fired as P2024. The 11:40:08.192Z evidence shows three
 *    `unread-count` invocations failing in the same millisecond.
 *    Fix: `resolveRevocation()` coalesces concurrent misses for the same token
 *    into a SINGLE in-flight query (N queries → 1).
 *
 * 2. TRANSIENT FAILURE BECAME LOGOUT. A throw from the check escaped the
 *    NextAuth `session()` callback into NextAuth's own catch, which calls
 *    `sessionStore.clean()` — emitting `Set-Cookie: …=; Max-Age=0` and
 *    DELETING the user's session cookie. A 10-second DB hiccup logged people
 *    out for real.
 *    Fix: `resolveRevocation()` NEVER throws. On a DB failure it serves a
 *    BOUNDED-STALE previously-verified result if one exists, and otherwise
 *    reports INDETERMINATE so the caller can deny this one request without
 *    destroying the credential. See lib/auth.ts.
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

/**
 * How long PAST the fresh TTL a previously-verified result may still be served
 * — but ONLY when the live check could not be performed at all (DB unreachable).
 *
 * This window is deliberately bounded and deliberately short. It is not a
 * second cache tier: an ordinary request never reads it (a lapsed entry still
 * triggers a live check). It exists so a ~90-second pool-pressure window
 * degrades into "slightly stale revocation" instead of "everyone logged out".
 * Past this ceiling the answer is INDETERMINATE and access is denied rather
 * than guessed — an unbounded stale window would mean a revoked session could
 * be honoured indefinitely by an instance that can no longer reach the DB.
 */
export const SESSION_STALE_GRACE_MS = 120_000; // 2 minutes

/** Oldest an entry may be before it is evicted outright. */
const MAX_ENTRY_AGE_MS = SESSION_CACHE_TTL_MS + SESSION_STALE_GRACE_MS;

const cache = new Map<string, CacheEntry>();

/**
 * In-flight live checks, keyed by sessionToken. Present only while a live
 * check is running; used to coalesce concurrent misses (defect 1 above).
 */
const inflight = new Map<string, Promise<boolean>>();

/**
 * How a revocation answer was obtained. Reported to monitoring as a tag so a
 * degradation window is visible as degradation rather than as noise.
 */
export type RevocationDisposition =
  /** Served from the fresh (< TTL) cache — no DB contact. */
  | "FRESH_HIT"
  /** Joined an already-running live check instead of issuing a second query. */
  | "COALESCED"
  /** Performed the live DB check. */
  | "LIVE"
  /** DB failed; served a bounded-stale previously-verified result. */
  | "STALE_HIT"
  /** DB failed and no usable entry existed — caller must deny, not guess. */
  | "INDETERMINATE";

export type RevocationOutcome = {
  /**
   * `true` = session valid, `false` = session revoked (both authoritative
   * enough to act on), `null` = COULD NOT DETERMINE. `null` must never be
   * treated as either "valid" or "revoked".
   */
  valid:       boolean | null;
  disposition: RevocationDisposition;
  /** The underlying failure, present only on STALE_HIT / INDETERMINATE. */
  error?:      unknown;
};

/**
 * Drop entries older than the stale ceiling. Called on write, so the map stays
 * bounded by the number of sessions active within MAX_ENTRY_AGE_MS without a
 * timer or a sweep thread.
 */
function prune(now: number): void {
  for (const [token, entry] of cache) {
    if (now - entry.checkedAt > MAX_ENTRY_AGE_MS) cache.delete(token);
  }
}

/**
 * Returns the cached revocation result for `sessionToken` if present and
 * still FRESH (< SESSION_CACHE_TTL_MS), or `null` if there's no entry / it
 * expired (caller should then do a live DB check).
 *
 * A lapsed entry is deliberately NOT deleted here — it is retained for the
 * bounded stale window (getStaleRevocation) so a DB outage has something
 * better than a logout to fall back on. Eviction happens in prune().
 */
export function getCachedRevocation(sessionToken: string): boolean | null {
  const entry = cache.get(sessionToken);
  if (!entry) return null;
  if (Date.now() - entry.checkedAt > SESSION_CACHE_TTL_MS) return null;
  return entry.valid;
}

/**
 * Returns a previously-verified result that is past its fresh TTL but still
 * within SESSION_STALE_GRACE_MS, or `null` when there is nothing usable.
 *
 * FOR DEGRADED PATHS ONLY. Callers must reach here only after a live check has
 * actually failed — never as a way to skip one. A stale `false` (revoked) is
 * honoured just like a fresh one: degradation must not resurrect a session the
 * DB already told us was revoked.
 */
export function getStaleRevocation(sessionToken: string): boolean | null {
  const entry = cache.get(sessionToken);
  if (!entry) return null;
  const age = Date.now() - entry.checkedAt;
  if (age > MAX_ENTRY_AGE_MS) {
    cache.delete(sessionToken);
    return null;
  }
  return entry.valid;
}

/** Records a freshly DB-verified revocation result. */
export function setCachedRevocation(sessionToken: string, valid: boolean): void {
  const now = Date.now();
  cache.set(sessionToken, { valid, checkedAt: now });
  prune(now);
}

/**
 * Resolve `sessionToken`'s revocation state, coalescing concurrent checks and
 * degrading safely when the store cannot answer.
 *
 * NEVER THROWS. That is the whole point: a throw from the NextAuth `session()`
 * callback reaches NextAuth's catch, which deletes the session cookie
 * (node_modules/next-auth/core/routes/session.js — `sessionStore.clean()`).
 * The failure is reported through the returned outcome instead.
 *
 * `liveCheck` is injected rather than imported so this policy is unit-testable
 * without Prisma or a database — the same seam lib/rate-limit.ts uses.
 */
export async function resolveRevocation(
  sessionToken: string,
  liveCheck: () => Promise<boolean>,
): Promise<RevocationOutcome> {
  const fresh = getCachedRevocation(sessionToken);
  if (fresh !== null) return { valid: fresh, disposition: "FRESH_HIT" };

  // Someone else is already asking the DB this exact question — wait for their
  // answer instead of opening a second query against a 1-connection pool.
  const existing = inflight.get(sessionToken);
  if (existing) {
    try {
      return { valid: await existing, disposition: "COALESCED" };
    } catch (error) {
      return degrade(sessionToken, error);
    }
  }

  const pending = (async () => {
    const valid = await liveCheck();
    setCachedRevocation(sessionToken, valid);
    return valid;
  })();
  inflight.set(sessionToken, pending);

  try {
    return { valid: await pending, disposition: "LIVE" };
  } catch (error) {
    return degrade(sessionToken, error);
  } finally {
    inflight.delete(sessionToken);
  }
}

/**
 * The live check failed. Prefer a bounded-stale verified answer; otherwise
 * report INDETERMINATE so the caller denies this request WITHOUT clearing the
 * session cookie.
 */
function degrade(sessionToken: string, error: unknown): RevocationOutcome {
  const stale = getStaleRevocation(sessionToken);
  if (stale !== null) return { valid: stale, disposition: "STALE_HIT", error };
  return { valid: null, disposition: "INDETERMINATE", error };
}

/**
 * Targeted invalidation — call this when a specific session's token is
 * known at the moment it's revoked (e.g. user revokes one device, sign-out).
 * Cheaper than clearAllSessions() and doesn't punish unrelated sessions.
 *
 * Also drops any in-flight check for the token, so a revoke that lands mid-
 * check cannot be overwritten by the older query's result landing afterwards.
 */
export function invalidateSession(sessionToken: string): void {
  cache.delete(sessionToken);
  inflight.delete(sessionToken);
}

/**
 * Bulk invalidation — call this when sessions are revoked without their
 * tokens in hand (e.g. "revoke all other sessions", admin bulk revoke).
 * Clears every cached entry rather than leaving stale ones behind.
 */
export function clearAllSessions(): void {
  cache.clear();
  inflight.clear();
}

/** Test/diagnostic helper — current cache size. Not used in request paths. */
export function _debugCacheSize(): number {
  return cache.size;
}

/** Test-only: force an entry's age so stale/ceiling behaviour is provable. */
export function _debugSetCheckedAt(sessionToken: string, checkedAt: number): void {
  const entry = cache.get(sessionToken);
  if (entry) cache.set(sessionToken, { ...entry, checkedAt });
}
