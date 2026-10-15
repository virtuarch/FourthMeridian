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
 *
 * ── BETA A2 — THE PRESENCE ROW RIDES THE SAME STATEMENT ───────────────────────
 * `SESSION_ACTIVE_DAY` (lib/audit-actions.ts) is the one product event written
 * on the pre-identity role: "this user had a live session on this UTC day". It
 * is written by the SAME autocommit statement, as a data-modifying CTE:
 *
 *   · the UPDATE now RETURNS the row's PREVIOUS `lastActiveAt` (taken from the
 *     locked sub-select, which sees the old value) and its `createdAt`;
 *   · the INSERT fires only when the previous touch was on an EARLIER UTC day,
 *     or when the row had never been touched since it was created (a session
 *     created today has `lastActiveAt = createdAt`, both from the one INSERT's
 *     `now()`), AND no OTHER live session of the user has already been touched
 *     today — so two devices on one day produce one row, not two.
 *
 * WHY THE DEDUPE READS UserSession AND NOT AuditLog. fm_auth holds INSERT on
 * AuditLog and NO SELECT (20261002000200_rls_auth_surface); a `WHERE NOT
 * EXISTS (… FROM "AuditLog")` would be refused outright. UserSession IS readable
 * on this role (it is what the session callback validates), and its touch
 * clocks carry the same fact. The guarantee is per statement, not per index:
 * two sessions touched in the same instant can both see the other untouched and
 * both write, so every reader counts DISTINCT (user, day) — the owner's rule.
 *
 * What it costs: nothing new. Still one statement, still no transaction a
 * suspended instance could hold open, still SKIP LOCKED, still throttled to the
 * granularity. A session shorter than one granularity window writes no touch and
 * therefore no day row; the readers union the sign-in day (UserSession.createdAt)
 * for presence, so such a visit is still present, never engaged.
 *
 * The id is generated here because nothing comes back from the INSERT (the
 * auditInsert lesson, lib/audit.ts). metadata is built in SQL from the database
 * clock so the day in the row is the day the comparison used.
 */

import { randomUUID } from "crypto";
import { AuditAction } from "@/lib/audit-actions";

/** Minimum age before `lastActiveAt` is written again. */
export const SESSION_ACTIVITY_GRANULARITY_SECONDS = 60;

/** The one capability this needs — a client that can run a single raw statement. */
export interface RawExecutor {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<number>;
}

/**
 * Record that a session validated just now was used, and the user's presence on
 * this UTC day when this is the day's first touch. Returns the number of
 * SESSION_ACTIVE_DAY rows written (0 or 1); the session touch itself happens
 * whenever the row was stale and free, and is never waited on.
 *
 * The interval literal is kept in step with SESSION_ACTIVITY_GRANULARITY_SECONDS
 * by lib/auth/session-activity.test.ts.
 */
export function touchSessionActivity(
  client:       RawExecutor,
  sessionToken: string,
  userId:       string,
): PromiseLike<number> {
  const dayRowId = randomUUID();
  const action = AuditAction.SESSION_ACTIVE_DAY;
  return client.$executeRaw`
    WITH touched AS (
      UPDATE "UserSession" u
         SET "lastActiveAt" = (now() AT TIME ZONE 'UTC')
        FROM (
          SELECT "id", "lastActiveAt" AS "previousActiveAt", "createdAt"
            FROM "UserSession"
           WHERE "sessionToken" = ${sessionToken}
             AND "userId"       = ${userId}
             AND "revokedAt"    IS NULL
             AND "lastActiveAt" < (now() AT TIME ZONE 'UTC') - interval '60 seconds'
           FOR UPDATE SKIP LOCKED
        ) s
       WHERE u."id" = s."id"
       RETURNING u."id", s."previousActiveAt", s."createdAt"
    )
    INSERT INTO "AuditLog" ("id", "userId", "action", "metadata", "ipAddress", "userAgent")
    SELECT ${dayRowId}::text, ${userId}::text, ${action}::text,
           jsonb_build_object('actorType', 'USER', 'result', 'SUCCESS',
                              'day', to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD')),
           NULL, NULL
      FROM touched t
     WHERE (t."previousActiveAt" < date_trunc('day', (now() AT TIME ZONE 'UTC'))
            OR t."previousActiveAt" = t."createdAt")
       AND NOT EXISTS (
         SELECT 1 FROM "UserSession" o
          WHERE o."userId"       = ${userId}
            AND o."id"          <> t."id"
            AND o."revokedAt"    IS NULL
            AND o."lastActiveAt" >= date_trunc('day', (now() AT TIME ZONE 'UTC'))
            AND o."lastActiveAt" <> o."createdAt"
       )`;
}
