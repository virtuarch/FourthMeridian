-- ═══════════════════════════════════════════════════════════════════════════
-- B11 batch — not part of B10.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Platform AI conversations: persistent, multi-turn, OPERATOR-PRIVATE.
-- Design (authority): docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md (PR #416,
-- e80ed1b) §2.1 schema, §2.4 RLS / grants / triggers, §7.2 the purge function.
-- Production batch: B11 (owner ruling 2026-11-04). B10's migration set and
-- rollback rehearsal are final (79/79); this migration must not enter B10.
--
-- ONE ADDITIVE MIGRATION. Two tables, three enums, indexes (including the
-- partial PENDING index Prisma cannot express), RLS and column-level grants,
-- four trigger / definer functions and the CHECK constraints. Nothing on an
-- existing table changes except that FK references to "User" are created (a
-- brief SHARE ROW EXCLUSIVE lock on "User", bounded by lock_timeout). No
-- backfill, no data movement. B9 and B10 code never read, write or know these
-- tables, so a database with this migration applied runs either unchanged.
--
-- R1 / OD-7 (PENDING, owner): this is the option (b) shape S2 recommends —
-- per-message expiry ("purgeAfter" = DB default createdAt + 90 days) plus
-- purging empty conversation shells. The purge job that calls the function
-- ships DISABLED (PLATFORM_AI_PURGE_ENABLED, default off) and the conversations
-- flag (PLATFORM_AI_CONVERSATIONS_ENABLED) is off on every environment.
--
-- S2 REQUIRED 1 — writers never choose retention or timestamps: every
--   timestamp is a database default, excluded from fm_app's column-level INSERT
--   grant; the timestamps an UPDATE produces are set by triggers.
-- S2 REQUIRED 2 — the definer functions are owned by a principal that BYPASSES
--   RLS (asserted in block 0): under FORCE RLS a non-bypassing owner would see
--   and delete 0 rows, silently (fail-OPEN for retention).
-- S2 REQUIRED 3 — account purge by FK cascade (User → conversation → message).
--
-- ⚠️ CONSTANTS DUPLICATED FROM CODE (the DB-010 pattern). The parse test
--   lib/platform/intelligence/ai/conversations/migration-policy.test.ts pins
--   them to lib/platform/intelligence/ai/conversations/constants.ts:
--     '90 days'  = PLATFORM_AI_RETENTION_DAYS      (purgeAfter default + bound)
--     '0 days'   = PLATFORM_AI_DELETE_GRACE_DAYS   (OD-10, default IMMEDIATE)
--     '1 day'    = PLATFORM_AI_SHELL_MIN_AGE_DAYS  (an empty shell is never raced)
--     500        = PLATFORM_AI_PURGE_BATCH         (p_limit upper bound)
--     20         = PLATFORM_AI_PURGE_EXCHANGE_FACTOR (expired exchanges per call = p_limit × 20)
--   Changing a constant fails CI until a follow-up migration moves the SQL with it.
--
-- BOUNDARIES. "createdAt" etc. are TIMESTAMP(3) WITHOUT TIME ZONE holding UTC
-- (Prisma); every comparison is (now() AT TIME ZONE 'UTC') - interval, UTC to
-- UTC, independent of the session TimeZone (the 2026-10-25 pooler incident).
--
-- PROOF: npm run rls:accept:ai-conversations
--   (scripts/platform-ai-conversations-acceptance.ts, real PostgreSQL roles).
-- PREVIEW PRE-ENABLE CHECK (read-only): npm run report:platform-ai-conversations-precheck
-- ROLLBACK: README.md in this folder (owner-only; destroys conversation content).

SET LOCAL lock_timeout = '5s';   -- FKs to "User" take a brief SHARE ROW EXCLUSIVE lock; fail fast, never queue

-- ── 0. S2 REQUIRED 2: the migration principal must bypass RLS ───────────────
-- It owns every function below. FORCE RLS binds the table OWNER too; a
-- SECURITY DEFINER function owned by a role WITHOUT BYPASSRLS would match 0
-- rows and delete 0 rows, silently. Abort instead.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'Platform AI conversations: migration principal % must have BYPASSRLS (definer functions under FORCE RLS)', current_user;
  END IF;
END $$;

-- ── 1. Types and tables ─────────────────────────────────────────────────────
CREATE TYPE "PlatformAiMessageRole" AS ENUM ('USER', 'ASSISTANT');
CREATE TYPE "PlatformAiMessageStatus" AS ENUM ('PENDING', 'COMPLETE', 'FAILED');
CREATE TYPE "PlatformAiFailureCode" AS ENUM ('TIMEOUT', 'PROVIDER', 'KILL_SWITCH', 'ABANDONED');

CREATE TABLE "PlatformAiConversation" (
    "id" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "area" "PlatformArea" NOT NULL,
    "createRequestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'::text),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'::text),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PlatformAiConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformAiMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "PlatformAiMessageRole" NOT NULL,
    "contentEncrypted" TEXT,
    "evidenceRefs" JSONB,
    "clientRequestId" TEXT,
    "replyToId" TEXT,
    "status" "PlatformAiMessageStatus" NOT NULL,
    "failureCode" "PlatformAiFailureCode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'::text),
    "completedAt" TIMESTAMP(3),
    "purgeAfter" TIMESTAMP(3) NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC'::text) + '90 days'::interval),

    CONSTRAINT "PlatformAiMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformAiConversation_operatorUserId_deletedAt_lastActivit_idx" ON "PlatformAiConversation"("operatorUserId", "deletedAt", "lastActivityAt");
CREATE INDEX "PlatformAiConversation_deletedAt_idx" ON "PlatformAiConversation"("deletedAt");
CREATE INDEX "PlatformAiConversation_createdAt_idx" ON "PlatformAiConversation"("createdAt");
CREATE UNIQUE INDEX "PlatformAiConversation_operatorUserId_createRequestId_key" ON "PlatformAiConversation"("operatorUserId", "createRequestId");
CREATE UNIQUE INDEX "PlatformAiMessage_replyToId_key" ON "PlatformAiMessage"("replyToId");
CREATE INDEX "PlatformAiMessage_conversationId_createdAt_idx" ON "PlatformAiMessage"("conversationId", "createdAt");
CREATE INDEX "PlatformAiMessage_purgeAfter_idx" ON "PlatformAiMessage"("purgeAfter");
CREATE UNIQUE INDEX "PlatformAiMessage_conversationId_id_key" ON "PlatformAiMessage"("conversationId", "id");
CREATE UNIQUE INDEX "PlatformAiMessage_conversationId_replyToId_key" ON "PlatformAiMessage"("conversationId", "replyToId");
CREATE UNIQUE INDEX "PlatformAiMessage_conversationId_clientRequestId_key" ON "PlatformAiMessage"("conversationId", "clientRequestId");

-- The single in-flight turn per conversation (design §2.1). Raw SQL only:
-- Prisma cannot express a partial index (invisible to migrate diff both ways).
CREATE UNIQUE INDEX "PlatformAiMessage_one_pending_per_conversation"
  ON public."PlatformAiMessage" ("conversationId") WHERE status = 'PENDING';

ALTER TABLE "PlatformAiConversation" ADD CONSTRAINT "PlatformAiConversation_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlatformAiMessage" ADD CONSTRAINT "PlatformAiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "PlatformAiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- S2 Q6: a reply into ANOTHER conversation is impossible at the database.
ALTER TABLE "PlatformAiMessage" ADD CONSTRAINT "PlatformAiMessage_conversationId_replyToId_fkey" FOREIGN KEY ("conversationId", "replyToId") REFERENCES "PlatformAiMessage"("conversationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. RLS (S2 B4): fm_app owner-only, no fm_system table path ──────────────
ALTER TABLE public."PlatformAiConversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PlatformAiConversation" FORCE  ROW LEVEL SECURITY;
ALTER TABLE public."PlatformAiMessage"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PlatformAiMessage"      FORCE  ROW LEVEL SECURITY;

-- fm_app: COLUMN-level INSERT that EXCLUDES every timestamp and retention
-- column (S2 REQUIRED 1); naming one ⇒ permission denied. UPDATE on the
-- smallest column sets. NO DELETE (hard deletion is the purge function's alone).
GRANT SELECT ON public."PlatformAiConversation" TO fm_app;
GRANT INSERT ("id", "operatorUserId", "area", "createRequestId")
  ON public."PlatformAiConversation" TO fm_app;
GRANT UPDATE ("deletedAt") ON public."PlatformAiConversation" TO fm_app;     -- no "lastActivityAt", no "createdAt"

GRANT SELECT ON public."PlatformAiMessage" TO fm_app;
GRANT INSERT ("id", "conversationId", "role", "contentEncrypted", "evidenceRefs",
              "clientRequestId", "replyToId", "status")
  ON public."PlatformAiMessage" TO fm_app;                                    -- no "createdAt", "purgeAfter", "completedAt", "failureCode"
GRANT UPDATE ("contentEncrypted", "evidenceRefs", "status", "failureCode")
  ON public."PlatformAiMessage" TO fm_app;                                    -- no timestamp, no retention column

CREATE POLICY fm_app_sel ON public."PlatformAiConversation" FOR SELECT TO fm_app
  USING ("operatorUserId" = current_fm_user_id());
CREATE POLICY fm_app_ins ON public."PlatformAiConversation" FOR INSERT TO fm_app
  WITH CHECK ("operatorUserId" = current_fm_user_id());
CREATE POLICY fm_app_upd ON public."PlatformAiConversation" FOR UPDATE TO fm_app
  USING      ("operatorUserId" = current_fm_user_id())
  WITH CHECK ("operatorUserId" = current_fm_user_id());

-- Messages have no owner column: visibility is the parent's (no self-reference).
CREATE POLICY fm_app_sel ON public."PlatformAiMessage" FOR SELECT TO fm_app
  USING (EXISTS (SELECT 1 FROM public."PlatformAiConversation" c
                  WHERE c.id = "conversationId" AND c."operatorUserId" = current_fm_user_id()));
CREATE POLICY fm_app_ins ON public."PlatformAiMessage" FOR INSERT TO fm_app
  WITH CHECK (EXISTS (SELECT 1 FROM public."PlatformAiConversation" c
                       WHERE c.id = "conversationId" AND c."operatorUserId" = current_fm_user_id()
                         AND c."deletedAt" IS NULL));
CREATE POLICY fm_app_upd ON public."PlatformAiMessage" FOR UPDATE TO fm_app
  USING      (EXISTS (SELECT 1 FROM public."PlatformAiConversation" c
                       WHERE c.id = "conversationId" AND c."operatorUserId" = current_fm_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public."PlatformAiConversation" c
                       WHERE c.id = "conversationId" AND c."operatorUserId" = current_fm_user_id()));

-- NO grant and NO policy for fm_system, fm_auth, anon, authenticated or
-- service_role. fm_backup keeps its catalog-wide SELECT (BYPASSRLS, default
-- privileges) for pg_dump; it sees ciphertext only. Belt and braces where the
-- PostgREST roles exist (Supabase):
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."PlatformAiConversation", public."PlatformAiMessage" FROM anon, authenticated, service_role';
  END IF;
END $$;

-- ── 3. Triggers: the database, not the writer, chooses every derived timestamp ─

-- 3a. Soft delete: the value is always now(); no un-delete, no re-dating.
CREATE FUNCTION public.fm_platform_ai_conversation_soft_delete() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."deletedAt" IS NOT NULL THEN RAISE EXCEPTION 'conversation already deleted'; END IF;
  IF NEW."deletedAt" IS NOT NULL THEN NEW."deletedAt" := now() AT TIME ZONE 'UTC'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_ai_conversation_soft_delete BEFORE UPDATE OF "deletedAt"
  ON public."PlatformAiConversation" FOR EACH ROW EXECUTE FUNCTION public.fm_platform_ai_conversation_soft_delete();

-- 3b. Activity = an operator APPEND (R2): a USER message insert moves
--     lastActivityAt. SECURITY DEFINER because fm_app holds no UPDATE on
--     "lastActivityAt"; the owner bypasses RLS (asserted in block 0). Fires
--     only on INSERT of a USER row; it is a trigger function and cannot be
--     called directly. Body pinned by the parse test.
CREATE FUNCTION public.fm_platform_ai_touch_conversation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public."PlatformAiConversation" SET "lastActivityAt" = now() AT TIME ZONE 'UTC'
   WHERE id = NEW."conversationId";
  RETURN NULL;
END $$;
CREATE TRIGGER platform_ai_touch_conversation AFTER INSERT ON public."PlatformAiMessage"
  FOR EACH ROW WHEN (NEW.role = 'USER') EXECUTE FUNCTION public.fm_platform_ai_touch_conversation();

-- 3c. Settle: only a PENDING row may change; completedAt is the database's.
--     The one exception is the key rotation (design §2.3): a role that
--     bypasses RLS changing "contentEncrypted" ALONE (every other column must
--     be NOT DISTINCT from its old value). SECURITY INVOKER is load-bearing:
--     current_user must be the role running the UPDATE — as a DEFINER it would
--     always be the (bypassing) owner and the exception would admit fm_app.
--     Pinned INVOKER by the parse test.
CREATE FUNCTION public.fm_platform_ai_message_settle() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    IF (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user)
       AND (NEW.id, NEW."conversationId", NEW.role, NEW."evidenceRefs", NEW."clientRequestId", NEW."replyToId",
            NEW.status, NEW."failureCode", NEW."createdAt", NEW."completedAt", NEW."purgeAfter")
           IS NOT DISTINCT FROM
           (OLD.id, OLD."conversationId", OLD.role, OLD."evidenceRefs", OLD."clientRequestId", OLD."replyToId",
            OLD.status, OLD."failureCode", OLD."createdAt", OLD."completedAt", OLD."purgeAfter")
    THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'settled message is immutable';
  END IF;
  IF NEW.status <> 'PENDING' THEN NEW."completedAt" := now() AT TIME ZONE 'UTC'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_ai_message_settle BEFORE UPDATE ON public."PlatformAiMessage"
  FOR EACH ROW EXECUTE FUNCTION public.fm_platform_ai_message_settle();

-- ── 4. Bounds and shapes ────────────────────────────────────────────────────
-- No writer can make a row immortal (they cannot write the columns at all;
-- this is defence in depth against a future grant mistake).
ALTER TABLE public."PlatformAiMessage" ADD CONSTRAINT "PlatformAiMessage_purgeAfter_bounded"
  CHECK ("purgeAfter" <= "createdAt" + interval '90 days');
ALTER TABLE public."PlatformAiMessage" ADD CONSTRAINT "PlatformAiMessage_failure_shape"
  CHECK ((status = 'FAILED') = ("failureCode" IS NOT NULL));
-- A USER row is the operator's settled question (no reply link, no evidence);
-- an ASSISTANT row always answers one USER row. Guarantees the purge's step 1
-- (USER rows + their cascaded replies) reaches EVERY assistant row.
ALTER TABLE public."PlatformAiMessage" ADD CONSTRAINT "PlatformAiMessage_role_shape"
  CHECK ((role = 'USER' AND "replyToId" IS NULL AND "evidenceRefs" IS NULL AND "clientRequestId" IS NOT NULL AND status = 'COMPLETE')
      OR (role = 'ASSISTANT' AND "replyToId" IS NOT NULL AND "clientRequestId" IS NULL));

-- ── 5. The purge function (design §7.2; S2 Q4 APPROVED; R1 option (b)) ──────
-- EXECUTE to fm_system only; search_path fixed; p_limit the only argument; no
-- dynamic SQL; counts in, counts out (no id, timestamp or content returned).
-- S2 (after approval): the parent (question) rows are locked FOR UPDATE and
-- their cascaded replies are locked and counted in the same statement window,
-- so the audited `messages` count equals the rows actually removed: a reply
-- cannot attach to a locked parent (its FK check needs FOR KEY SHARE), and a
-- message cannot join a locked conversation for the same reason.
CREATE FUNCTION public.fm_purge_platform_ai_conversations(p_limit integer)
  RETURNS TABLE (conversations integer, messages integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE v_now timestamp(3) := now() AT TIME ZONE 'UTC';   -- UTC-to-UTC, as DB-010; (3) = the columns' own precision, so "exactly 90 days" is kept (strict <)
        v_users text[]; v_conv text[];
        v_parents integer := 0; v_replies integer := 0; v_cmsgs integer := 0; v_nconv integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN RAISE EXCEPTION 'p_limit out of range'; END IF;
  -- 1. Expired MESSAGES (per-message expiry; purgeAfter is a DB default).
  --    Lock the expired USER (question) rows; lock and count their replies;
  --    delete the parents (each reply goes by the composite-FK cascade).
  SELECT array_agg(id) INTO v_users FROM (
    SELECT id FROM public."PlatformAiMessage"
     WHERE role = 'USER' AND "purgeAfter" < v_now
     ORDER BY "purgeAfter" LIMIT p_limit * 20 FOR UPDATE SKIP LOCKED) s;
  IF v_users IS NOT NULL THEN
    SELECT count(*) INTO v_replies FROM (
      SELECT id FROM public."PlatformAiMessage" WHERE "replyToId" = ANY (v_users) FOR UPDATE) r;
    DELETE FROM public."PlatformAiMessage" WHERE id = ANY (v_users);
    GET DIAGNOSTICS v_parents = ROW_COUNT;
  END IF;
  -- 2. Deleted conversations past the grace, and empty SHELLS (no message left,
  --    created more than a day ago so a create in flight is never raced).
  SELECT array_agg(id) INTO v_conv FROM (
    SELECT c.id FROM public."PlatformAiConversation" c
     WHERE c."deletedAt" < v_now - interval '0 days'          -- = PLATFORM_AI_DELETE_GRACE_DAYS (OD-10; pinned)
        OR (c."createdAt" < v_now - interval '1 day'
            AND NOT EXISTS (SELECT 1 FROM public."PlatformAiMessage" m WHERE m."conversationId" = c.id))
     ORDER BY c."createdAt" LIMIT p_limit FOR UPDATE SKIP LOCKED) s;
  IF v_conv IS NOT NULL THEN
    SELECT count(*) INTO v_cmsgs FROM (
      SELECT id FROM public."PlatformAiMessage" WHERE "conversationId" = ANY (v_conv) FOR UPDATE) m;
    DELETE FROM public."PlatformAiConversation" WHERE id = ANY (v_conv);   -- remaining messages by cascade
    GET DIAGNOSTICS v_nconv = ROW_COUNT;
  END IF;
  RETURN QUERY SELECT v_nconv, v_parents + v_replies + v_cmsgs;
END $$;

-- ── 6. Function privileges ──────────────────────────────────────────────────
-- Trigger functions are not checked for EXECUTE when they fire; revoking keeps
-- every one of them uncallable by any runtime role. Only fm_system may EXECUTE
-- the purge.
REVOKE ALL ON FUNCTION public.fm_platform_ai_conversation_soft_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_platform_ai_touch_conversation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_platform_ai_message_settle() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_purge_platform_ai_conversations(integer) FROM PUBLIC;
-- Supabase grants EXECUTE on new public functions to its API roles by default privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.fm_platform_ai_conversation_soft_delete(), public.fm_platform_ai_touch_conversation(), public.fm_platform_ai_message_settle(), public.fm_purge_platform_ai_conversations(integer) FROM anon, authenticated, service_role';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.fm_purge_platform_ai_conversations(integer) TO fm_system;
