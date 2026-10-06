/**
 * lib/auth/session-activity.ts  (RLS-PREVIEW-13)
 *
 * Owns ONE fact: how a validated session records that it was just used
 * (`UserSession.lastActiveAt`). Validation is NOT here — it stays synchronous in
 * the session callback (lib/auth.ts) and is decided before this ever runs.
 *
 * ── THE INCIDENT THIS REPLACES (Preview, 2026-10-06, Stage 13 load row) ──────
 * The session callback bumped the timestamp with
 *
 *     db.userSession.updateMany({ ... lastActiveAt ... }).catch(() => {})
 *
 * launched fire-and-forget on `authDb` (fm_auth). Three facts made that fatal:
 *
 *   1. Prisma 5 runs `updateMany` as THREE round trips — BEGIN, UPDATE, COMMIT —
 *      measured, not assumed. The row lock is taken by the UPDATE and released
 *      only by a COMMIT the client must still send.
 *   2. The promise was not awaited, so it outlived the request. Under Vercel
 *      Fluid Compute an instance with no request in flight can be suspended;
 *      un-awaited work is not guaranteed to run. A process frozen between
 *      UPDATE and COMMIT leaves the transaction OPEN for as long as the
 *      instance stays frozen — Postgres saw it as "idle in transaction" for
 *      326 s, holding the UserSession row lock.
 *   3. Every concurrent request for one signed-in user touches the SAME row.
 *      The next touches queued on that lock, each holding an fm_auth pool slot
 *      (5 per process in Prisma, 12 per role at Supavisor), until the
 *      revocation read — the security-critical query that shares that pool —
 *      could not get a connection: P2024, INDETERMINATE, 503 for every
 *      signed-in request. Isolation held; availability did not.
 *
 * ── THE SHAPE THAT CANNOT DO THAT ─────────────────────────────────────────────
 *   · ONE autocommit statement (`$executeRaw`, no BEGIN). The server commits it
 *     the moment it runs, whatever the client does next, so a suspended process
 *     can never hold the lock past the statement. There is no transaction to
 *     leave open.
 *   · `FOR UPDATE SKIP LOCKED`. If another session already holds the row — a
 *     concurrent touch, a revoke-all, anything — this touch skips instead of
 *     queueing. Hot-row contention costs nothing and pins no pool slot.
 *   · Throttled IN THE DATABASE to SESSION_ACTIVITY_GRANULARITY_SECONDS. Only a
 *     row older than the granularity is written, so a burst writes the row at
 *     most once per granularity window across every instance (an in-process
 *     throttle could not see other instances).
 *   · AWAITED by the caller, so it finishes inside the request that started it.
 *     It runs only on a LIVE revocation check (at most once per
 *     SESSION_CACHE_TTL_MS per token per process), never waits on a lock, and
 *     is one statement — so awaiting it serialises nothing. `after()` was
 *     rejected: it needs a request scope the session callback is not always
 *     invoked in, and it would keep the write AFTER the response, which is
 *     exactly the lifetime that broke.
 *
 * Semantics: `lastActiveAt` is display and analytics only (session lists, the
 * export, weekly-active counts). Nothing reads it for expiry or revocation, so
 * minute granularity loses nothing it is used for. A revoked row is never
 * touched.
 */

/** Minimum age before `lastActiveAt` is written again. */
export const SESSION_ACTIVITY_GRANULARITY_SECONDS = 60;

/** The one capability this needs — a client that can run a single raw statement. */
export interface RawExecutor {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<number>;
}

/**
 * Record that a session validated just now was used. Returns the number of rows
 * written: 1 when the row was stale and free, 0 when it was fresh, locked by
 * someone else, revoked, or not this user's. Never waits on a row lock.
 *
 * The interval literal is kept in step with SESSION_ACTIVITY_GRANULARITY_SECONDS
 * by lib/auth/session-activity.test.ts.
 */
export function touchSessionActivity(
  client:       RawExecutor,
  sessionToken: string,
  userId:       string,
): PromiseLike<number> {
  return client.$executeRaw`
    UPDATE "UserSession"
       SET "lastActiveAt" = (now() AT TIME ZONE 'UTC')
     WHERE "id" = (
       SELECT "id" FROM "UserSession"
        WHERE "sessionToken" = ${sessionToken}
          AND "userId"       = ${userId}
          AND "revokedAt"    IS NULL
          AND "lastActiveAt" < (now() AT TIME ZONE 'UTC') - interval '60 seconds'
        FOR UPDATE SKIP LOCKED
     )`;
}
