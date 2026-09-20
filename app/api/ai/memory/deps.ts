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
 * can reach is SpaceMemory" stays a one-file claim. `db` appears in this file for
 * exactly one thing: the content-free audit row.
 */

import { requireUser }         from '@/lib/session';
import { limitByUser }         from '@/lib/rate-limit';
import { resolveSpaceContext } from '@/lib/space';
import { db }                  from '@/lib/db';
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
  list: listOwnMemories,
  retire: retireMemory,
  erase: deleteMemoryChain,
  audit: async ({ userId, spaceId, kind, versionsErased }) => {
    await db.auditLog.create({
      data: { ...buildAuditData({
        actorId: userId, actorType: 'USER', action: AuditAction.AI_MEMORY_ERASED, result: 'SUCCESS',
        target: { type: 'space-memory' },
        // ⚠️ COUNTS AND KINDS ONLY. Not the subject, not the words, not a field: the
        // user erased this, and an audit row that kept it would un-erase it.
        metadata: { kind, versionsErased },
      }), spaceId },
    });
  },
};
