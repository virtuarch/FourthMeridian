-- 20261105120000_platform_ai_message_expiry_on_read  (expiry enforced on read)
-- B11 batch — not part of B10. Follows 20261104120000_platform_ai_conversations.
--
-- OD-7 (owner, APPROVED 2026-11-04): each Platform AI message expires 90 days
-- after creation. Until now expiry took effect only when the retention purge
-- PHYSICALLY removed a row, so between expiry and the next purge (and after any
-- restore, until a purge ran) an expired message stayed readable by its owner:
-- in the UI, in follow-up history sent to the model provider, and in the
-- subject-access export.
--
-- This migration makes expiry authoritative for fm_app: a message is visible
-- (SELECT) and updatable (UPDATE ... USING) only while
-- "purgeAfter" > now() AT TIME ZONE 'UTC' — the DATABASE clock, the same UTC
-- form the purge's v_now uses (20261104120000, fm_purge_platform_ai_conversations).
-- The invariant is "visible ⇒ not expired"; at exact equality a row is hidden
-- but not yet deleted (the purge's strict <), which is the safe side.
--
--   · INSERT is unchanged: purgeAfter defaults to now() + 90 days, so the new
--     row passes the SELECT policy for INSERT ... RETURNING.
--   · USER and its PENDING ASSISTANT row are inserted in ONE transaction
--     (store.ts insertPair), so they share now() and their purgeAfter: an answer
--     never outlives its question on read.
--   · The conversation policy is NOT changed: a message sub-select there would
--     recurse into this table's policy, which sub-selects the conversation (S2).
--     All-expired conversations are hidden by the data module's LIVE filter
--     (lib/platform/intelligence/ai/conversations/store.ts), under this policy.
--   · NOT a substitute for the purge: expired ciphertext stays in the table and
--     in backups until the purge removes it. The purge (SECURITY DEFINER, owner
--     bypasses RLS) is unaffected and still deletes expired rows.
--
-- Restores: a backup taken BEFORE this migration restores WITHOUT this policy;
-- the restore runbook (docs/operations/backup-restore-verification.md §4.1)
-- applies migrations to head and runs the pre-enable check (which asserts this
-- predicate) before the app serves.

SET LOCAL lock_timeout = '5s';

DROP POLICY fm_app_sel ON public."PlatformAiMessage";
CREATE POLICY fm_app_sel ON public."PlatformAiMessage" FOR SELECT TO fm_app
  USING ("purgeAfter" > (now() AT TIME ZONE 'UTC'::text)
         AND EXISTS (SELECT 1 FROM public."PlatformAiConversation" c
                      WHERE c.id = "conversationId" AND c."operatorUserId" = current_fm_user_id()));

DROP POLICY fm_app_upd ON public."PlatformAiMessage";
CREATE POLICY fm_app_upd ON public."PlatformAiMessage" FOR UPDATE TO fm_app
  USING      ("purgeAfter" > (now() AT TIME ZONE 'UTC'::text)
              AND EXISTS (SELECT 1 FROM public."PlatformAiConversation" c
                           WHERE c.id = "conversationId" AND c."operatorUserId" = current_fm_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public."PlatformAiConversation" c
                       WHERE c.id = "conversationId" AND c."operatorUserId" = current_fm_user_id()));
