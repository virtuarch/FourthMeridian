-- POLICY EDITOR (Phase 2) — customer Policy Group definitions as versioned data.
--
-- ADDITIVE ONLY: two NEW tables, their indexes, grants and RLS, and ONE seed
-- (the built-in Beta group, exactly the code values). No existing table, row,
-- column or policy is touched; no assignment is created, changed or deleted.
--
-- Day-one behaviour is unchanged: the resolver reads the seeded Beta version,
-- which equals lib/entitlements/catalogue.ts BETA_FULL_ACCESS_V1 (pinned by
-- lib/platform/policies/policy-group-migration.test.ts), and falls back to the
-- code catalogue whenever these tables are absent or unreadable.
--
-- AUTHORITY (least privilege):
--   fm_system  PolicyGroup        SELECT, INSERT, UPDATE  (no DELETE — groups are archived, never removed)
--              PolicyGroupVersion SELECT, INSERT          (no UPDATE / DELETE — versions are IMMUTABLE)
--   fm_app     nothing — product routes read definitions through the cached
--              fm_system loader (deployment configuration, not tenant data)
--   fm_auth    nothing — registration reads the default through the same loader
--   fm_backup  SELECT (complete dumps)

-- ── 1. PolicyGroup ───────────────────────────────────────────────────────────
CREATE TABLE "PolicyGroup" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "currentVersion" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyGroup_pkey" PRIMARY KEY ("key")
);

-- At most ONE default group (SQL only — Prisma cannot express a partial index;
-- mirrored in tests with FakePrisma.partialUnique).
CREATE UNIQUE INDEX "PolicyGroup_single_default" ON "PolicyGroup"("isDefault") WHERE "isDefault" = true;

-- ── 2. PolicyGroupVersion ────────────────────────────────────────────────────
CREATE TABLE "PolicyGroupVersion" (
    "id" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "changeSummary" JSONB NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyGroupVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PolicyGroupVersion_groupKey_version_key" ON "PolicyGroupVersion"("groupKey", "version");
ALTER TABLE "PolicyGroupVersion" ADD CONSTRAINT "PolicyGroupVersion_groupKey_fkey"
  FOREIGN KEY ("groupKey") REFERENCES "PolicyGroup"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── 3. Grants + RLS — operators (fm_system) only ─────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PolicyGroup', 'PolicyGroupVersion'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM fm_app', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM fm_auth', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM fm_system', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO fm_backup', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY fm_system_all ON public.%I FOR ALL TO fm_system USING (true) WITH CHECK (true)', t);
  END LOOP;
  -- Belt and braces (as migration 20261002000100 §19): never reachable by the Data API roles.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."PolicyGroup", public."PolicyGroupVersion" FROM anon, authenticated, service_role';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON TABLE public."PolicyGroup" TO fm_system;
GRANT SELECT, INSERT ON TABLE public."PolicyGroupVersion" TO fm_system;

-- ── 4. Seed — the built-in Beta group, version 1 = the code values exactly ───
INSERT INTO "PolicyGroup" ("key", "label", "description", "isDefault", "builtIn", "archivedAt", "currentVersion", "createdById", "createdAt", "updatedAt")
VALUES (
  'BETA_FULL_ACCESS_V1',
  'Beta — full access (v1)',
  'The first consumer-beta policy: every shipped surface, at the product''s established pacing. No customer-plan quota beyond the platform ceilings except the three-per-day export and the one-hour bank refresh cooldown.',
  true, true, NULL, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PolicyGroupVersion" ("id", "groupKey", "version", "values", "label", "description", "changeSummary", "reasonCode", "reasonNote", "createdById", "createdAt")
VALUES (
  'seed_beta_full_access_v1_v1',
  'BETA_FULL_ACCESS_V1',
  1,
  '{"conversations":true,"dailyBrief":true,"aiTurnsPerMinute":10,"aiTurnsPerHour":60,"manualBankRefreshCooldownMinutes":60,"manualWalletRefreshPerHour":6,"exportsPerDay":3,"aiDailyUsdAllowance":5,"maxConnections":10}'::jsonb,
  'Beta — full access (v1)',
  'The first consumer-beta policy: every shipped surface, at the product''s established pacing. No customer-plan quota beyond the platform ceilings except the three-per-day export and the one-hour bank refresh cooldown.',
  '{"kind":"SEEDED","from":"CODE","changes":[]}'::jsonb,
  'POLICY_ROLLOUT',
  'Seeded from the code catalogue (lib/entitlements/catalogue.ts BETA_FULL_ACCESS_V1).',
  NULL,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("groupKey", "version") DO NOTHING;
