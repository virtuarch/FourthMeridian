-- ═══════════════════════════════════════════════════════════════════════════
-- B11 batch — not part of B10. Preview only until a separate Production decision.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Platform AI OPERATIONAL MEMORY: short, typed, operator-confirmed pointers to
-- records ("watching provider outcome; check after deploy"), OPERATOR-PRIVATE.
-- Design (authority): Platform AI operational memory v2, S2-approved 2026-11-08
-- (conditional), open item O1 ruled (b): the soft delete is ONE narrow SECURITY
-- DEFINER function, the sole soft-delete path (fm_app holds no UPDATE on
-- "deletedAt").
--
-- ONE ADDITIVE MIGRATION. Five enums, one table (no link to a conversation,
-- message or AiInvocation — not even a nullable one), the Prisma indexes, RLS
-- (ENABLE + FORCE) with fm_app-only policies, column-level grants, two trigger
-- functions (INVOKER), three SECURITY DEFINER functions, and the CHECKs. Nothing
-- on an existing table changes except the FK reference to "User" (a brief SHARE
-- ROW EXCLUSIVE lock, bounded by lock_timeout). No backfill. B9 / B10 code never
-- reads, writes or knows this table.
--
-- Both flags ship OFF (PLATFORM_AI_MEMORY_ENABLED, PLATFORM_AI_MEMORY_PURGE_ENABLED);
-- memory is effective only with conversations on, the memory purge on, and the
-- 7-day transcript retention (20261108120000) verified by
-- `npm run report:platform-ai-memory-precheck` (design D1).
--
-- WRITERS NEVER CHOOSE TIME. createdAt / observedAt / expiresAt are set by the
-- insert trigger and are outside fm_app's INSERT grant; invalidatedAt and
-- deletedAt are set to now() by the immutability trigger, once, NULL → now().
-- expiresAt can never move: renewal is a NEW row that supersedes the old one.
--
-- ⚠️ CONSTANTS AND REGISTRIES DUPLICATED FROM CODE (the DB-010 pattern). The parse
-- test lib/platform/intelligence/ai/memory/migration-policy.test.ts pins every
-- literal below to lib/platform/intelligence/ai/memory/constants.ts:
--     TTL hours (24 / 72 / 168 / 720)       = MEMORY_TTL_HOURS
--     '72 hours' OPERATIONAL_STATE cap      = MEMORY_OPERATIONAL_STATE_CAP_HOURS
--     '30 days'  every other type's cap     = MEMORY_MAX_CAP_HOURS
--     '1 day'    invalidated rows kept      = MEMORY_INVALIDATED_KEEP_DAYS
--     500        purge p_limit bound        = MEMORY_PURGE_BATCH
--     512 / 512 / 1024 / 5 / 64             = payload / note cipher / refs octets / refs / ref id
--     the payload allowlist                  = MEMORY_PAYLOAD_SCHEMA
--     the ref registries (S2 B2)             = MEMORY_METRIC_KEYS, _PAGE_IDS, _METRIC_PARTS,
--                                              _METRIC_WINDOWS, _JOB_NAMES, _PROVIDER_IDS,
--                                              _OBSERVED_STATES, _INCIDENT_ID_PATTERN
--   …and ./memory.test.ts pins those registries to the live metric / navigation
--   registries, the retrieval contracts' parts, the job facts and PROVIDER_SPECS.
--   Adding a key memory may reference therefore needs a migration.
--
-- BOUNDARIES. Timestamps are TIMESTAMP(3) WITHOUT TIME ZONE holding UTC (Prisma);
-- every comparison is against (now() AT TIME ZONE 'UTC'), independent of the
-- session TimeZone.
--
-- PROOF: npm run rls:accept:ai-memory (scripts/platform-ai-memory-acceptance.ts,
--   real PostgreSQL roles; incl. every O1 case S2 listed).
-- PREVIEW PRE-ENABLE CHECK (read-only): npm run report:platform-ai-memory-precheck
-- ROLLBACK: README.md in this folder (Preview-only; destroys memory facts).

SET LOCAL lock_timeout = '5s';   -- the FK to "User" takes a brief SHARE ROW EXCLUSIVE lock; fail fast, never queue

-- ── 0. The migration principal must bypass RLS ──────────────────────────────
-- It owns every function below. FORCE RLS binds the table OWNER too; a SECURITY
-- DEFINER function owned by a role WITHOUT BYPASSRLS would match 0 rows,
-- silently (the soft delete would "succeed" with 0, the purge would keep rows).
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'Platform AI memory: migration principal % must have BYPASSRLS (definer functions under FORCE RLS)', current_user;
  END IF;
END $$;

-- ── 1. Types and table ──────────────────────────────────────────────────────
CREATE TYPE "PlatformAiMemoryFactType" AS ENUM ('WATCHING_ISSUE', 'OPERATIONAL_STATE', 'FOLLOW_UP', 'OPERATOR_PREFERENCE');
CREATE TYPE "PlatformAiMemoryOrigin" AS ENUM ('OPERATOR_EXPLICIT', 'TOOL_DERIVED');
CREATE TYPE "PlatformAiMemoryConcern" AS ENUM ('RECURRING_FAILURE', 'DEGRADATION', 'COST_SPIKE', 'CUSTOMER_IMPACT', 'AWAITING_FIX', 'MONITOR_ONLY');
CREATE TYPE "PlatformAiMemoryTtl" AS ENUM ('H24', 'H72', 'D7', 'D30');
CREATE TYPE "PlatformAiMemoryInvalidReason" AS ENUM ('GONE', 'STATE_CHANGED', 'AREA_LOST', 'SUPERSEDED');

CREATE TABLE "PlatformAiMemoryFact" (
    "id" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "platformArea" "PlatformArea" NOT NULL,
    "factType" "PlatformAiMemoryFactType" NOT NULL,
    "origin" "PlatformAiMemoryOrigin" NOT NULL,
    "concern" "PlatformAiMemoryConcern",
    "noteEncrypted" TEXT,
    "payload" JSONB NOT NULL,
    "sourceRefs" JSONB NOT NULL,
    "ttl" "PlatformAiMemoryTtl" NOT NULL,
    "proposalJti" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'::text),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'::text),
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'::text),
    "invalidatedAt" TIMESTAMP(3),
    "invalidReason" "PlatformAiMemoryInvalidReason",
    "deletedAt" TIMESTAMP(3),
    "supersedesId" TEXT,

    CONSTRAINT "PlatformAiMemoryFact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAiMemoryFact_supersedesId_key" ON "PlatformAiMemoryFact"("supersedesId");
CREATE INDEX "PlatformAiMemoryFact_operatorUserId_platformArea_deletedAt__idx" ON "PlatformAiMemoryFact"("operatorUserId", "platformArea", "deletedAt", "expiresAt");
CREATE INDEX "PlatformAiMemoryFact_expiresAt_idx" ON "PlatformAiMemoryFact"("expiresAt");
CREATE INDEX "PlatformAiMemoryFact_deletedAt_idx" ON "PlatformAiMemoryFact"("deletedAt");
CREATE UNIQUE INDEX "PlatformAiMemoryFact_operatorUserId_proposalJti_key" ON "PlatformAiMemoryFact"("operatorUserId", "proposalJti");

ALTER TABLE "PlatformAiMemoryFact" ADD CONSTRAINT "PlatformAiMemoryFact_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. RLS (B1): fm_app owner + ACTIVE grant; no fm_system table path ────────
ALTER TABLE public."PlatformAiMemoryFact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PlatformAiMemoryFact" FORCE  ROW LEVEL SECURITY;

-- fm_app: COLUMN-level INSERT that EXCLUDES every timestamp and lifecycle column;
-- naming one ⇒ permission denied. UPDATE on the two invalidation columns ONLY
-- (O1 (b): NOT "deletedAt" — fm_platform_ai_memory_soft_delete is the sole
-- soft-delete path). NO DELETE (hard deletion is the purge functions' alone).
GRANT SELECT ON public."PlatformAiMemoryFact" TO fm_app;
GRANT INSERT ("id", "operatorUserId", "platformArea", "factType", "origin", "concern", "noteEncrypted",
              "payload", "sourceRefs", "ttl", "supersedesId", "proposalJti")
  ON public."PlatformAiMemoryFact" TO fm_app;                              -- no createdAt / observedAt / expiresAt / invalidatedAt / invalidReason / deletedAt
GRANT UPDATE ("invalidatedAt", "invalidReason") ON public."PlatformAiMemoryFact" TO fm_app;
REVOKE UPDATE ("deletedAt") ON public."PlatformAiMemoryFact" FROM fm_app;   -- O1 (b), explicit (never granted above)

-- G   := an ACTIVE PlatformGrant of the bound operator for the row's area. fm_app
--        reads its OWN PlatformGrant rows (sec014, read-only); status ACTIVE|REVOKED
--        is the whole lifecycle today (pinned by memory.test.ts, D6).
-- OWN := "operatorUserId" = current_fm_user_id().
CREATE POLICY fm_app_sel ON public."PlatformAiMemoryFact" FOR SELECT TO fm_app
  USING ("operatorUserId" = current_fm_user_id()
         AND "deletedAt" IS NULL AND "expiresAt" > (now() AT TIME ZONE 'UTC'::text)
         AND EXISTS (SELECT 1 FROM public."PlatformGrant" g
                      WHERE g."userId" = current_fm_user_id() AND g.area = "platformArea" AND g.status = 'ACTIVE'));
CREATE POLICY fm_app_ins ON public."PlatformAiMemoryFact" FOR INSERT TO fm_app
  WITH CHECK ("operatorUserId" = current_fm_user_id()
              AND EXISTS (SELECT 1 FROM public."PlatformGrant" g
                           WHERE g."userId" = current_fm_user_id() AND g.area = "platformArea" AND g.status = 'ACTIVE'));
-- B1: its OWN WITH CHECK with no deletedAt / expiresAt term (the immutability
-- trigger, not this policy, limits what an UPDATE may change).
CREATE POLICY fm_app_upd ON public."PlatformAiMemoryFact" FOR UPDATE TO fm_app
  USING      ("operatorUserId" = current_fm_user_id()
              AND "deletedAt" IS NULL AND "expiresAt" > (now() AT TIME ZONE 'UTC'::text)
              AND EXISTS (SELECT 1 FROM public."PlatformGrant" g
                           WHERE g."userId" = current_fm_user_id() AND g.area = "platformArea" AND g.status = 'ACTIVE'))
  WITH CHECK ("operatorUserId" = current_fm_user_id()
              AND EXISTS (SELECT 1 FROM public."PlatformGrant" g
                           WHERE g."userId" = current_fm_user_id() AND g.area = "platformArea" AND g.status = 'ACTIVE'));

-- NO grant and NO policy for fm_system, fm_auth, anon, authenticated or
-- service_role. fm_backup keeps its catalog-wide SELECT (ciphertext only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."PlatformAiMemoryFact" FROM anon, authenticated, service_role';
  END IF;
END $$;

-- ── 3. Bounds and shapes ────────────────────────────────────────────────────
ALTER TABLE public."PlatformAiMemoryFact" ADD CONSTRAINT "PlatformAiMemoryFact_payload_bounded"
  CHECK (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 512);
ALTER TABLE public."PlatformAiMemoryFact" ADD CONSTRAINT "PlatformAiMemoryFact_note_bounded"
  CHECK ("noteEncrypted" IS NULL OR length("noteEncrypted") <= 512);
ALTER TABLE public."PlatformAiMemoryFact" ADD CONSTRAINT "PlatformAiMemoryFact_refs_bounded"
  CHECK (octet_length("sourceRefs"::text) <= 1024
         AND CASE WHEN jsonb_typeof("sourceRefs") = 'array' THEN jsonb_array_length("sourceRefs") BETWEEN 0 AND 5 ELSE false END);
ALTER TABLE public."PlatformAiMemoryFact" ADD CONSTRAINT "PlatformAiMemoryFact_refs_required"
  CHECK ("factType" = 'OPERATOR_PREFERENCE'
         OR CASE WHEN jsonb_typeof("sourceRefs") = 'array' THEN jsonb_array_length("sourceRefs") >= 1 ELSE false END);
ALTER TABLE public."PlatformAiMemoryFact" ADD CONSTRAINT "PlatformAiMemoryFact_expiry_bounded"
  CHECK ("expiresAt" <= "createdAt" + interval '30 days'
         AND ("factType" <> 'OPERATIONAL_STATE' OR "expiresAt" <= "createdAt" + interval '72 hours'));
ALTER TABLE public."PlatformAiMemoryFact" ADD CONSTRAINT "PlatformAiMemoryFact_invalid_shape"
  CHECK (("invalidatedAt" IS NULL) = ("invalidReason" IS NULL));

-- ── 4. Triggers: the database, not the writer, chooses every timestamp ──────

-- 4a. Insert (INVOKER): timestamps, expiry, the payload allowlist and the B2
--     sourceRefs validation. Anything outside the registries RAISEs.
CREATE FUNCTION public.fm_platform_ai_memory_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_now timestamp(3) := now() AT TIME ZONE 'UTC';
        v_cap interval; v_ttl interval; v_allowed jsonb; v_key text; v_val jsonb; v_ref jsonb; v_t text; v_id text;
BEGIN
  NEW."createdAt" := v_now;
  NEW."observedAt" := v_now;
  NEW."invalidatedAt" := NULL;
  NEW."invalidReason" := NULL;
  NEW."deletedAt" := NULL;
  v_cap := CASE NEW."factType" WHEN 'OPERATIONAL_STATE' THEN interval '72 hours' ELSE interval '30 days' END;
  v_ttl := CASE NEW.ttl WHEN 'H24' THEN interval '24 hours' WHEN 'H72' THEN interval '72 hours'
                        WHEN 'D7' THEN interval '168 hours' WHEN 'D30' THEN interval '720 hours' END;
  NEW."expiresAt" := v_now + LEAST(v_ttl, v_cap);

  -- Payload: a closed key → enum-value allowlist per fact type.
  IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'memory payload must be an object'; END IF;
  v_allowed := CASE NEW."factType"
    WHEN 'WATCHING_ISSUE'      THEN '{}'::jsonb
    WHEN 'OPERATIONAL_STATE'   THEN '{"expected": ["OPEN", "DEGRADED", "FAILING"]}'::jsonb
    WHEN 'FOLLOW_UP'           THEN '{"due": ["H24", "D7"]}'::jsonb
    WHEN 'OPERATOR_PREFERENCE' THEN '{"pref": ["TERSE_ANSWERS", "DEFAULT_WINDOW_7D"]}'::jsonb
  END;
  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(NEW.payload) LOOP
    IF v_key ILIKE '%conversation%' OR v_key ILIKE '%message%' OR v_key ILIKE '%transcript%' THEN
      RAISE EXCEPTION 'memory payload key refused';
    END IF;
    IF NOT (v_allowed ? v_key) THEN RAISE EXCEPTION 'memory payload key not allowed for this fact type'; END IF;
    IF jsonb_typeof(v_val) IS DISTINCT FROM 'string' OR NOT ((v_allowed -> v_key) ? (v_val #>> '{}')) THEN
      RAISE EXCEPTION 'memory payload value not allowed';
    END IF;
  END LOOP;
  IF NEW."factType" = 'OPERATOR_PREFERENCE' AND NOT (NEW.payload ? 'pref') THEN
    RAISE EXCEPTION 'memory payload missing a required key';
  END IF;

  -- sourceRefs (S2 B2): every element checked key by key against the registries.
  IF jsonb_typeof(NEW."sourceRefs") IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'memory sourceRefs must be an array'; END IF;
  FOR v_ref IN SELECT value FROM jsonb_array_elements(NEW."sourceRefs") LOOP
    IF jsonb_typeof(v_ref) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'memory sourceRef must be an object'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_ref) k WHERE k <> ALL (ARRAY['t', 'id', 'part', 'w', 'observedState'])) THEN
      RAISE EXCEPTION 'memory sourceRef has a key outside {t, id, part, w, observedState}';
    END IF;
    IF jsonb_typeof(v_ref -> 't') IS DISTINCT FROM 'string' OR jsonb_typeof(v_ref -> 'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_ref -> 'observedState') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'memory sourceRef needs string t, id and observedState';
    END IF;
    v_t := v_ref ->> 't';
    v_id := v_ref ->> 'id';
    IF length(v_id) > 64 THEN RAISE EXCEPTION 'memory sourceRef id too long'; END IF;
    IF NOT ((v_ref ->> 'observedState') = ANY (ARRAY[
      'OK', 'DEGRADED', 'FAILING', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN']::text[])) THEN
      RAISE EXCEPTION 'memory sourceRef observedState outside the closed list';
    END IF;
    IF v_t = 'INCIDENT' THEN
      IF v_id !~ '^c[a-z0-9]{24}$' THEN RAISE EXCEPTION 'memory INCIDENT ref id is not a cuid'; END IF;
    ELSIF v_t = 'METRIC' THEN
      IF NOT (v_id = ANY (ARRAY[
      'provider-outcome@1', 'provider-connection@2', 'provider-call-volume@1', 'ops-overall-posture@1',
      'customer-impact-24h@1', 'alerts-firing-now@1', 'connection-health-summary@1', 'refresh-pipeline@1',
      'scheduled-job-health@1', 'data-freshness@1', 'ai-fleet-spend-status@1', 'economics-ai-cost@1',
      'economics-operating-cost@1', 'economics-provider-cost@1', 'ai-call-outcomes@1', 'ai-cost-per-call@1',
      'presence-state@1', 'engaged-users@1', 'growth-registrations@1', 'incident-broken-now@1',
      'incident-alertable@1', 'incident-needs-verification@1', 'incident-resolved-window@1', 'merchant-identity-linked@1',
      'cs-needs-help@1', 'open-customers@1', 'live-sessions@1', 'accounts-with-live-session@1']::text[])) THEN
        RAISE EXCEPTION 'memory METRIC ref id is not a registered metric key';
      END IF;
    ELSIF v_t = 'PAGE' THEN
      IF NOT (v_id = ANY (ARRAY[
      'platform:overview', 'platform:ai',
      'PLATFORM_OPS:platform-overview:overview', 'PLATFORM_OPS:platform-overview:jobs',
      'PLATFORM_OPS:platform-overview:pipeline', 'PLATFORM_OPS:platform-providers:health',
      'PLATFORM_OPS:platform-economics:overview', 'PLATFORM_OPS:platform-economics:ai',
      'PLATFORM_OPS:platform-economics:providers', 'PLATFORM_OPS:platform-economics:entitlements',
      'PLATFORM_OPS:platform-policies:groups', 'PLATFORM_OPS:platform-policies:defaults',
      'PLATFORM_OPS:platform-policies:alerts', 'PLATFORM_OPS:platform-policies:emergency',
      'PLATFORM_OPS:platform-incidents:open', 'PLATFORM_OPS:platform-incidents:verify',
      'PLATFORM_OPS:platform-incidents:history', 'SECURITY_OPS:platform-overview:overview',
      'SECURITY_OPS:platform-audit', 'SECURITY_OPS:platform-operator-actions',
      'GROWTH_REVENUE:platform-overview:overview', 'CUSTOMER_SUCCESS:platform-overview:overview',
      'CUSTOMER_SUCCESS:platform-incidents:summary', 'CUSTOMER_SUCCESS:platform-incidents:open',
      'CUSTOMER_SUCCESS:platform-incidents:verify', 'CUSTOMER_SUCCESS:platform-incidents:history',
      'CUSTOMER_SUCCESS:platform-communications:library', 'CUSTOMER_SUCCESS:platform-communications:automations',
      'CUSTOMER_SUCCESS:platform-communications:delivery', 'CUSTOMER_SUCCESS:platform-communications:preferences',
      'MERCHANT_OPS:platform-overview:overview']::text[])) THEN
        RAISE EXCEPTION 'memory PAGE ref id is not a registered page';
      END IF;
    ELSIF v_t = 'JOB' THEN
      IF NOT (v_id = ANY (ARRAY[
      'sync-banks', 'fetch-fx-rates', 'fetch-security-prices', 'sync-crypto', 'sync-crypto-continuation',
      'process-deletions', 'notification-cleanup', 'notification-retry', 'purge-trash', 'rate-limit-sweep',
      'plaid-removal-retry', 'product-event-retention', 'comms-automations', 'sol-history-backfill', 'evaluate-alerts']::text[])) THEN
        RAISE EXCEPTION 'memory JOB ref id is not a registered job';
      END IF;
    ELSIF v_t = 'PROVIDER' THEN
      IF NOT (v_id = ANY (ARRAY[
      'PLAID', 'OPEN_EXCHANGE_RATES']::text[])) THEN
        RAISE EXCEPTION 'memory PROVIDER ref id is not a registered provider';
      END IF;
    ELSE
      RAISE EXCEPTION 'memory sourceRef type outside the enum';
    END IF;
    -- part / w: METRIC refs only, each from the registry's enums.
    IF v_ref ? 'part' THEN
      IF v_t <> 'METRIC' OR jsonb_typeof(v_ref -> 'part') IS DISTINCT FROM 'string' OR NOT ((v_ref ->> 'part') = ANY (ARRAY[
      'aiFailures', 'aiUsd', 'briefFailed', 'calls', 'callsMonth', 'callsToday',
      'costPerCallUsd', 'costUsd', 'customerImpacting', 'customersAffected', 'dead', 'degraded',
      'distinctUsers', 'empty', 'enabledRules', 'error', 'errorRatePct', 'executions',
      'failed', 'failing', 'firing', 'firingCritical', 'fresh', 'healthy',
      'idle', 'infrastructureUsd', 'institutionConcentrated', 'invocations', 'largestMeasuredCategory', 'linked',
      'live', 'meteredProviders', 'needsReauth', 'neverRan', 'noConnections', 'noRuns',
      'noVerdict', 'notEnoughData', 'notEvaluable', 'notRefreshed', 'notScheduled', 'overdue',
      'pricedUsd', 'providersUsd', 'reconnectNeeded', 'refreshFailed', 'refreshPartial', 'returned',
      'returnedCalls', 'running', 'runningNow', 'sessions', 'skipped', 'sourcesAffected',
      'sourcesUnavailable', 'spendUsd', 'stale', 'syncFailures', 'thresholdUsd', 'totalUsd',
      'unknown', 'unmeteredProviders', 'unpricedInvocations', 'utilisationPct']::text[])) THEN
        RAISE EXCEPTION 'memory sourceRef part outside the registry';
      END IF;
    END IF;
    IF v_ref ? 'w' THEN
      IF v_t <> 'METRIC' OR jsonb_typeof(v_ref -> 'w') IS DISTINCT FROM 'number'
         OR NOT ((v_ref ->> 'w') = ANY (ARRAY['1', '7', '30', '90']::text[])) THEN
        RAISE EXCEPTION 'memory sourceRef window outside the registry';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_ai_memory_insert BEFORE INSERT ON public."PlatformAiMemoryFact"
  FOR EACH ROW EXECUTE FUNCTION public.fm_platform_ai_memory_insert();

-- 4b. Immutability (INVOKER): only invalidatedAt / invalidReason / deletedAt may
--     change, each ONCE, NULL → now(); every other column stays NOT DISTINCT.
--     The one exception is the key rotation (docs/operations/key-rotation.md): a
--     role that bypasses RLS changing "noteEncrypted" ALONE. SECURITY INVOKER is
--     load-bearing (as in fm_platform_ai_message_settle): current_user must be
--     the role running the UPDATE — as a DEFINER it would always be the bypassing
--     owner and the exception would admit fm_app. Pinned INVOKER by the parse test.
CREATE FUNCTION public.fm_platform_ai_memory_immutable() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW."operatorUserId", NEW."platformArea", NEW."factType", NEW.origin, NEW.concern, NEW.payload,
      NEW."sourceRefs", NEW.ttl, NEW."proposalJti", NEW."observedAt", NEW."createdAt", NEW."expiresAt", NEW."supersedesId",
      NEW."invalidatedAt", NEW."invalidReason", NEW."deletedAt")
     IS NOT DISTINCT FROM
     (OLD.id, OLD."operatorUserId", OLD."platformArea", OLD."factType", OLD.origin, OLD.concern, OLD.payload,
      OLD."sourceRefs", OLD.ttl, OLD."proposalJti", OLD."observedAt", OLD."createdAt", OLD."expiresAt", OLD."supersedesId",
      OLD."invalidatedAt", OLD."invalidReason", OLD."deletedAt")
     AND NEW."noteEncrypted" IS DISTINCT FROM OLD."noteEncrypted"
     AND (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user)
  THEN RETURN NEW; END IF;
  IF (NEW.id, NEW."operatorUserId", NEW."platformArea", NEW."factType", NEW.origin, NEW.concern, NEW."noteEncrypted", NEW.payload,
      NEW."sourceRefs", NEW.ttl, NEW."proposalJti", NEW."observedAt", NEW."createdAt", NEW."expiresAt", NEW."supersedesId")
     IS DISTINCT FROM
     (OLD.id, OLD."operatorUserId", OLD."platformArea", OLD."factType", OLD.origin, OLD.concern, OLD."noteEncrypted", OLD.payload,
      OLD."sourceRefs", OLD.ttl, OLD."proposalJti", OLD."observedAt", OLD."createdAt", OLD."expiresAt", OLD."supersedesId")
  THEN RAISE EXCEPTION 'memory fact is immutable'; END IF;
  IF (NEW."invalidatedAt", NEW."invalidReason") IS DISTINCT FROM (OLD."invalidatedAt", OLD."invalidReason") THEN
    IF OLD."invalidatedAt" IS NOT NULL OR OLD."invalidReason" IS NOT NULL THEN RAISE EXCEPTION 'memory fact already invalidated'; END IF;
    IF NEW."invalidReason" IS NULL THEN RAISE EXCEPTION 'memory invalidation needs a reason'; END IF;
    NEW."invalidatedAt" := now() AT TIME ZONE 'UTC';
  END IF;
  IF NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN
    IF OLD."deletedAt" IS NOT NULL THEN RAISE EXCEPTION 'memory fact already deleted'; END IF;
    NEW."deletedAt" := now() AT TIME ZONE 'UTC';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_ai_memory_immutable BEFORE UPDATE ON public."PlatformAiMemoryFact"
  FOR EACH ROW EXECUTE FUNCTION public.fm_platform_ai_memory_immutable();

-- ── 5. The soft delete (O1 ruled (b)) — the SOLE soft-delete path ───────────
-- p_id NULL = every row of the caller. The caller is current_fm_user_id() (the
-- transaction-local app.user_id the tenant client binds); NULL / empty RAISEs.
-- ONLY `SET "deletedAt" = now()` for rows that are the caller's, not deleted,
-- not expired and in an area the caller holds ACTIVE (the triggers still fire:
-- the immutability trigger re-stamps now() and refuses a second delete). Returns
-- the integer count ONLY (no id, timestamp or content). EXECUTE to fm_app alone.
CREATE FUNCTION public.fm_platform_ai_memory_soft_delete(p_id text)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE v_user text := public.current_fm_user_id();
        v_now timestamp(3) := now() AT TIME ZONE 'UTC';
        v_n integer := 0;
BEGIN
  IF v_user IS NULL OR v_user = '' THEN RAISE EXCEPTION 'Platform AI memory soft delete: no operator bound'; END IF;
  UPDATE public."PlatformAiMemoryFact" f SET "deletedAt" = v_now
   WHERE f."operatorUserId" = v_user
     AND f."deletedAt" IS NULL
     AND f."expiresAt" > v_now
     AND EXISTS (SELECT 1 FROM public."PlatformGrant" g
                  WHERE g."userId" = v_user AND g.area = f."platformArea" AND g.status = 'ACTIVE')
     AND (p_id IS NULL OR f.id = p_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ── 6. The purge functions — fm_system's ONLY path ──────────────────────────
-- Fixed predicates, counts in and counts out, no dynamic SQL. A row is removed
-- when ANY holds: expired; soft-deleted (grace 0); invalidated more than 1 day
-- ago (D8); no ACTIVE grant for its (operator, area) (D5: offboarding / revoked
-- area). FOR UPDATE SKIP LOCKED: concurrent calls delete disjoint rows.
CREATE FUNCTION public.fm_purge_platform_ai_memory(p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE v_now timestamp(3) := now() AT TIME ZONE 'UTC';
        v_ids text[]; v_n integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN RAISE EXCEPTION 'p_limit out of range'; END IF;
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT f.id FROM public."PlatformAiMemoryFact" f
     WHERE f."expiresAt" <= v_now
        OR f."deletedAt" IS NOT NULL
        OR f."invalidatedAt" < v_now - interval '1 day'
        OR NOT EXISTS (SELECT 1 FROM public."PlatformGrant" g
                        WHERE g."userId" = f."operatorUserId" AND g.area = f."platformArea" AND g.status = 'ACTIVE')
     ORDER BY f."createdAt" LIMIT p_limit FOR UPDATE SKIP LOCKED) s;
  IF v_ids IS NOT NULL THEN
    DELETE FROM public."PlatformAiMemoryFact" WHERE id = ANY (v_ids);
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  RETURN v_n;
END $$;

-- The same rules for ONE operator (System Admin purge-operator, offboarding).
CREATE FUNCTION public.fm_purge_platform_ai_memory_for_operator(p_user text)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE v_now timestamp(3) := now() AT TIME ZONE 'UTC';
        v_n integer := 0;
BEGIN
  IF p_user IS NULL OR p_user = '' THEN RAISE EXCEPTION 'p_user required'; END IF;
  DELETE FROM public."PlatformAiMemoryFact" f
   WHERE f."operatorUserId" = p_user
     AND (f."expiresAt" <= v_now
          OR f."deletedAt" IS NOT NULL
          OR f."invalidatedAt" < v_now - interval '1 day'
          OR NOT EXISTS (SELECT 1 FROM public."PlatformGrant" g
                          WHERE g."userId" = f."operatorUserId" AND g.area = f."platformArea" AND g.status = 'ACTIVE'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ── 7. Function privileges ──────────────────────────────────────────────────
-- Trigger functions are not checked for EXECUTE when they fire; revoking keeps
-- them uncallable. The soft delete: fm_app alone. The purges: fm_system alone.
REVOKE ALL ON FUNCTION public.fm_platform_ai_memory_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_platform_ai_memory_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_platform_ai_memory_soft_delete(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_purge_platform_ai_memory(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_purge_platform_ai_memory_for_operator(text) FROM PUBLIC;
-- Supabase grants EXECUTE on new public functions to its API roles by default privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.fm_platform_ai_memory_insert(), public.fm_platform_ai_memory_immutable(), public.fm_platform_ai_memory_soft_delete(text), public.fm_purge_platform_ai_memory(integer), public.fm_purge_platform_ai_memory_for_operator(text) FROM anon, authenticated, service_role';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.fm_platform_ai_memory_soft_delete(text) TO fm_app;
GRANT EXECUTE ON FUNCTION public.fm_purge_platform_ai_memory(integer) TO fm_system;
GRANT EXECUTE ON FUNCTION public.fm_purge_platform_ai_memory_for_operator(text) TO fm_system;
