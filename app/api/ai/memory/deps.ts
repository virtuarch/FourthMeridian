/**
 * app/api/ai/memory/deps.ts
 *
 * The real dependencies behind the memory routes — the ONE place they meet the
 * session, the rate limiter, the Space resolver, the memory store and the audit
 * log. The handlers themselves (`handlers.ts`) are dependency-free, which is what
 * lets their ownership rules be tested without a database.
 *
 * ⚠️ NO MEMORY QUERY LIVES HERE. Every read and write of `SpaceMemory` is a
 * function of `memory-store.ts`, so "the only Prisma model the memory write path
 * can reach is SpaceMemory" stays a one-file claim.
 *
 * ── THIS IS THE TENANT BOUNDARY FOR THE MEMORY SURFACE (RLS SLICE A) ─────────
 * `handlers.ts` resolves the identity and the Space; THIS file is where that
 * identity becomes a database authority. Each dep enters `withTenantDb` with the
 * owner's id and hands the transaction-scoped client down to the store, so every
 * statement carries `app.user_id` and the policies on `SpaceMemory` — which
 * require BOTH a visible Space and `ownerUserId = current_fm_user_id()` — apply
 * on top of the application scope rather than instead of it.
 *
 * ⚠️ ONE TRANSACTION PER OPERATION, NOT PER REQUEST. `withTenantDb` is a security
 * boundary, so it wraps the shortest coherent piece of work: the list, the retire
 * (its read, its new row and its predecessor's status change — previously one
 * transaction inside the store, now one transaction that also carries the
 * identity), the erase. Nothing in here makes a network or model call.
 *
 * ⚠️ THE AUDIT ROW IS TENANT-SCOPED TOO. fm_app is granted INSERT on `AuditLog`
 * (and a SELECT policy over its own rows), so the content-free record of an
 * erasure is written as the user, not as the migration principal.
 */

import { requireUser }         from '@/lib/session';
import { limitByUser }         from '@/lib/rate-limit';
import { resolveSpaceContext } from '@/lib/space';
import { withTenantDb }        from '@/lib/db/tenant-context';
import { todayUTCISO }         from '@/lib/time/clock';
import { buildAuditData }      from '@/lib/audit';
import { AuditAction }         from '@/lib/audit-actions';
import { listOwnMemories, retireMemory, deleteMemoryChain } from '@/lib/ai/conversation/memory-store';
import type { MemoryApiDeps }  from './handlers';

export const memoryApiDeps: MemoryApiDeps = {
  requireUser: () => requireUser(),
  // The chat route's budget: memory is part of the same surface.
  limit: (userId) => limitByUser(userId, 'ai-memory', { limit: 30, windowSec: 60 }),
  resolveSpace: (userId, spaceId) => resolveSpaceContext(userId, spaceId),
  today: () => todayUTCISO(),
  // ⚠️ THE IDENTITY IS THE SCOPE'S OWNER AND NOTHING ELSE. `handlers.ts` builds
  // that scope from the authenticated session and a re-resolved Space; no route
  // takes a user id, so there is no value here a client could have supplied.
  list: (scope, todayISO) =>
    withTenantDb(scope.ownerUserId, (tx) => listOwnMemories(tx, scope, todayISO)),
  retire: (scope, id, statedAt) =>
    withTenantDb(scope.ownerUserId, (tx) => retireMemory(tx, scope, id, statedAt)),
  erase: (scope, id) =>
    withTenantDb(scope.ownerUserId, (tx) => deleteMemoryChain(tx, scope, id)),
  audit: async ({ userId, spaceId, kind, versionsErased }) => {
    await withTenantDb(userId, (tx) => tx.auditLog.create({
      data: { ...buildAuditData({
        actorId: userId, actorType: 'USER', action: AuditAction.AI_MEMORY_ERASED, result: 'SUCCESS',
        target: { type: 'space-memory' },
        // ⚠️ COUNTS AND KINDS ONLY. Not the subject, not the words, not a field: the
        // user erased this, and an audit row that kept it would un-erase it.
        metadata: { kind, versionsErased },
      }), spaceId },
    }));
  },
};
