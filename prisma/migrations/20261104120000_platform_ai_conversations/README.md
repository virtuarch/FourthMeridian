# 20261104120000_platform_ai_conversations — review notes

**B11 batch — not part of B10.** Production batch: **B11** (owner ruling 2026-11-04). B10's
migration set and rollback rehearsal are final; this migration must not enter B10.

**Design (authority).** `docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md` (PR #416, `e80ed1b`)
§2.1, §2.4, §7.2, plus S2's post-approval additions (purge counting under lock, the settle
trigger pinned SECURITY INVOKER, the touch trigger's body pinned and revoked from PUBLIC).

**R1 / OD-7 (owner decision, PENDING).** This is the option (b) shape S2 recommends:
per-message expiry (`purgeAfter` = DB default `createdAt + 90 days`) and empty conversation
shells purged. The purge job that calls the function ships **disabled**
(`PLATFORM_AI_PURGE_ENABLED`, default off). If the owner rules option (a), a follow-up migration
drops `purgeAfter` and replaces the function body (design §7.2, the option (a) variant) before
anything is enabled.

**Statements.**

0. A `DO` block refuses a migration principal without `BYPASSRLS` (S2 REQUIRED 2).
1. Three enums, two tables, the Prisma indexes, the partial unique index
   `PlatformAiMessage_one_pending_per_conversation` (one in-flight turn), three FKs: `User →
   conversation` (CASCADE), `conversation → message` (CASCADE), and the composite reply FK
   `(conversationId, replyToId) → (conversationId, id)` (CASCADE, S2 Q6).
2. ENABLE + FORCE RLS on both tables; fm_app column-level grants that exclude every timestamp and
   retention column; owner-only policies via `current_fm_user_id()`. No grant or policy for
   `fm_system`, `fm_auth` or the PostgREST roles.
3. Triggers: soft delete (value always `now()`, no un-delete), touch (`lastActivityAt` on a USER
   insert, SECURITY DEFINER), settle (`completedAt`; settled rows immutable except the key
   rotation's `contentEncrypted`-only path for a role that bypasses RLS; SECURITY INVOKER).
4. CHECKs: `purgeAfter <= createdAt + 90 days`, the FAILED ⇔ `failureCode` shape, and the role
   shape (a USER row has no reply link or evidence; an ASSISTANT row always answers one).
5. `fm_purge_platform_ai_conversations(p_limit)` — SECURITY DEFINER, counts only, EXECUTE to
   `fm_system` alone.

**Locks.** Creating the FKs to `"User"` takes a brief SHARE ROW EXCLUSIVE lock on `"User"`;
`SET LOCAL lock_timeout = '5s'` makes it fail rather than queue behind a long transaction.

**Proof.** `npm run rls:accept:ai-conversations` (real PG roles, own container) and the parse pins
in `lib/platform/intelligence/ai/conversations/migration-policy.test.ts`. The key rotation's
narrow path: `npm run accept:key-rotation` block 10.

**Apply.** Preview only, by S1 through the guarded `npm run db:migrate:safe`, after S2 review.
Never `prisma migrate dev`. Before ANY flag is enabled on Preview, run the read-only pre-enable
check `npm run report:platform-ai-conversations-precheck -- --env=preview` and record its output
in the PR D enable checklist.

**B9 / B10 compatibility.** Neither release reads, writes or knows these tables. Code rollback
needs no database step.

## ROLLBACK (owner-only — DESTROYS all conversation content)

A deliberate step, run as the migration principal, never part of a code rollback:

```sql
BEGIN;
DROP FUNCTION IF EXISTS public.fm_purge_platform_ai_conversations(integer);
DROP TABLE IF EXISTS public."PlatformAiMessage";
DROP TABLE IF EXISTS public."PlatformAiConversation";
DROP FUNCTION IF EXISTS public.fm_platform_ai_message_settle();
DROP FUNCTION IF EXISTS public.fm_platform_ai_touch_conversation();
DROP FUNCTION IF EXISTS public.fm_platform_ai_conversation_soft_delete();
DROP TYPE IF EXISTS "PlatformAiFailureCode";
DROP TYPE IF EXISTS "PlatformAiMessageStatus";
DROP TYPE IF EXISTS "PlatformAiMessageRole";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261104120000_platform_ai_conversations';
COMMIT;
```
