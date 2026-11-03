/**
 * lib/auth/presence-activity.ts  (PB-10 — the presence heartbeat write)
 *
 * Owns ONE fact: a visible tab holding this session reported presence (and,
 * optionally, "interacted since the last beat"). It writes
 * UserSession.lastPresenceAt / lastInteractionAt and NOTHING ELSE — never
 * lastActiveAt (SEC-010's clock), never an AuditLog row, never a product event.
 * Definitions: lib/presence/definitions.ts.
 *
 * PARITY WITH touchSessionActivity (lib/auth/session-activity.ts), on purpose:
 *   · the SAME client — fm_auth (authDb), reached through lib/session.ts, one of
 *     the confined authDb importers (scripts/audit-db-authority.ts);
 *   · the SAME shape — ONE autocommit `$executeRaw` statement (no BEGIN, no
 *     session-level SET), the row taken in a sub-select FOR UPDATE SKIP LOCKED,
 *     so a suspended instance can never hold the row lock and a contended row
 *     is skipped instead of queued;
 *   · the SAME binding — "sessionToken" (the cookie's token, as stored) AND
 *     "userId" (the verified session's user) AND "revokedAt" IS NULL;
 *   · throttled IN THE DATABASE to PRESENCE_CONFIG.serverThrottleSeconds, so a
 *     burst across instances writes the row at most once per window;
 *   · the DATABASE clock — nothing from the client is a time.
 *
 * The interval literal is kept in step with PRESENCE_CONFIG by
 * lib/auth/presence-activity.test.ts.
 */

import type { RawExecutor } from "@/lib/auth/session-activity";

export function recordPresenceBeat(
  client:       RawExecutor,
  sessionToken: string,
  userId:       string,
  interacted:   boolean,
): PromiseLike<number> {
  return client.$executeRaw`
    UPDATE "UserSession" u
       SET "lastPresenceAt"    = (now() AT TIME ZONE 'UTC'),
           "lastInteractionAt" = CASE WHEN ${interacted}::boolean
                                      THEN (now() AT TIME ZONE 'UTC')
                                      ELSE u."lastInteractionAt" END
      FROM (
        SELECT "id"
          FROM "UserSession"
         WHERE "sessionToken" = ${sessionToken}
           AND "userId"       = ${userId}
           AND "revokedAt"    IS NULL
           AND ("lastPresenceAt" IS NULL
                OR "lastPresenceAt" < (now() AT TIME ZONE 'UTC') - interval '20 seconds'
                OR (${interacted}::boolean
                    AND ("lastInteractionAt" IS NULL
                         OR "lastInteractionAt" < (now() AT TIME ZONE 'UTC') - interval '20 seconds')))
         FOR UPDATE SKIP LOCKED
      ) s
     WHERE u."id" = s."id"`;
}
