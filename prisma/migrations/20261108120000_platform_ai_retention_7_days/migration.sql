-- ═══════════════════════════════════════════════════════════════════════════
-- B11 batch — not part of B10.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Platform AI conversations: retention 90 → 7 days (owner, 2026-11-08).
-- Follows 20261104120000_platform_ai_conversations and
-- 20261105120000_platform_ai_message_expiry_on_read.
--
-- The owner amended OD-7: each Platform AI message is kept AT MOST 7 days from
-- its creation. A question and its answer expire together, 7 days after the
-- question. This migration:
--   1. CLAMPS every existing row (never lengthens):
--        USER       purgeAfter := LEAST(purgeAfter, createdAt + 7 days)
--        ASSISTANT  purgeAfter := LEAST(purgeAfter, createdAt + 7 days,
--                                       its question's purgeAfter,
--                                       its question's createdAt + 7 days)
--      so an answer is never kept past its question.
--   2. moves the purgeAfter DEFAULT to now() + 7 days;
--   3. replaces the CHECK bound PlatformAiMessage_purgeAfter_bounded with
--      createdAt + 7 days.
-- No row is deleted here. Rows the clamp makes expired are hidden at once by
-- the expiry-on-read policies (20261105120000) and removed by the purge
-- (fm_purge_platform_ai_conversations, unchanged) on its next run.
--
-- THE SETTLE TRIGGER. fm_platform_ai_message_settle (20261104120000 §3c)
-- refuses ANY change to "purgeAfter" on a settled row — even for a role that
-- bypasses RLS (only "contentEncrypted" may move). The clamp therefore runs
-- with that ONE trigger disabled, inside ONE DO block, under an ACCESS
-- EXCLUSIVE lock on the table taken first: no other session can read or write
-- the table while the trigger is off, the block re-enables it and RAISEs
-- (aborting the whole migration) unless it is enabled again afterwards. The
-- trigger function and its definition are NOT changed: the immutability rule
-- stays exactly as S2 approved it. See README.md for the alternative weighed.
--
-- ⚠️ CONSTANT DUPLICATED FROM CODE (the DB-010 pattern):
--     '7 days' = PLATFORM_AI_RETENTION_DAYS (purgeAfter default + bound + clamp)
--   pinned by lib/platform/intelligence/ai/conversations/migration-policy.test.ts.
--
-- IDEMPOTENT: the clamp updates only rows above their cap (a re-run matches
-- none); the default is SET; the constraint is dropped IF EXISTS and re-added.
-- BOUNDARIES: TIMESTAMP(3) holding UTC, as the original migration.
-- PROOF: npm run rls:accept:ai-conversations ([retention-7d] cases).

SET LOCAL lock_timeout = '5s';   -- fail fast rather than queue behind a long transaction

-- ── 0. The migration principal must bypass RLS (S2 REQUIRED 2) ──────────────
-- FORCE RLS binds the table owner too; without BYPASSRLS the clamp would match
-- 0 rows, silently, and the new CHECK would then fail on the unclamped rows.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'migration principal % must have BYPASSRLS (S2 REQUIRED 2)', current_user;
  END IF;
END $$;

-- ── 1. One lock for the whole migration (no lock upgrade mid-way) ───────────
LOCK TABLE public."PlatformAiMessage" IN ACCESS EXCLUSIVE MODE;

-- ── 2. The clamp (never lengthens; pairs together) ──────────────────────────
DO $$
BEGIN
  ALTER TABLE public."PlatformAiMessage" DISABLE TRIGGER platform_ai_message_settle;

  WITH cap AS (
    SELECT m.id,
           CASE WHEN m.role = 'USER'
                THEN LEAST(m."purgeAfter", m."createdAt" + interval '7 days')
                ELSE LEAST(m."purgeAfter", m."createdAt" + interval '7 days',
                           q."purgeAfter", q."createdAt" + interval '7 days')
           END AS "purgeAfter"
      FROM public."PlatformAiMessage" m
      LEFT JOIN public."PlatformAiMessage" q
        ON q."conversationId" = m."conversationId" AND q.id = m."replyToId"
  )
  UPDATE public."PlatformAiMessage" t
     SET "purgeAfter" = cap."purgeAfter"
    FROM cap
   WHERE t.id = cap.id AND t."purgeAfter" > cap."purgeAfter";

  ALTER TABLE public."PlatformAiMessage" ENABLE TRIGGER platform_ai_message_settle;

  IF (SELECT tgenabled FROM pg_trigger
       WHERE tgrelid = 'public."PlatformAiMessage"'::regclass AND tgname = 'platform_ai_message_settle') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'platform_ai_message_settle is not enabled after the clamp';
  END IF;
END $$;

-- ── 3. The default and the bound ────────────────────────────────────────────
ALTER TABLE public."PlatformAiMessage"
  ALTER COLUMN "purgeAfter" SET DEFAULT ((now() AT TIME ZONE 'UTC'::text) + '7 days'::interval);

ALTER TABLE public."PlatformAiMessage" DROP CONSTRAINT IF EXISTS "PlatformAiMessage_purgeAfter_bounded";
ALTER TABLE public."PlatformAiMessage" ADD CONSTRAINT "PlatformAiMessage_purgeAfter_bounded"
  CHECK ("purgeAfter" <= "createdAt" + interval '7 days');
