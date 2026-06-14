-- Migration part 2 of 2: table DDL + backfill.
-- Depends on 20260611000000 being committed first (enum values must exist).

-- ─────────────────────────────────────────────────────────────────────────────
-- Workspace: add category column
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Workspace"
  ADD COLUMN IF NOT EXISTS "category" "WorkspaceCategory" NOT NULL DEFAULT 'PERSONAL';

-- ─────────────────────────────────────────────────────────────────────────────
-- WorkspaceMember: add status + revocation columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "WorkspaceMember"
  ADD COLUMN IF NOT EXISTS "status"      "WorkspaceMemberStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "revokedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokedById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'WorkspaceMember_revokedById_fkey'
  ) THEN
    ALTER TABLE "WorkspaceMember"
      ADD CONSTRAINT "WorkspaceMember_revokedById_fkey"
      FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "WorkspaceMember_workspaceId_status_idx"
  ON "WorkspaceMember"("workspaceId", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- FinancialAccount
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "FinancialAccount" (
  "id"               TEXT NOT NULL,
  "ownerType"        "AccountOwnerType" NOT NULL,
  "ownerUserId"      TEXT,
  "ownerWorkspaceId" TEXT,
  "name"             TEXT NOT NULL,
  "type"             "AccountType" NOT NULL,
  "institution"      TEXT NOT NULL,
  "institutionId"    TEXT,
  "mask"             TEXT,
  "balance"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "availableBalance" DOUBLE PRECISION,
  "creditLimit"      DOUBLE PRECISION,
  "currency"         TEXT NOT NULL DEFAULT 'USD',
  "lastUpdated"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "plaidAccountId"   TEXT,
  "walletAddress"    TEXT,
  "walletChain"      TEXT,
  "nativeBalance"    DOUBLE PRECISION,
  "syncStatus"       TEXT DEFAULT 'pending',
  "deletedAt"        TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FinancialAccount"
  ADD CONSTRAINT "FinancialAccount_plaidAccountId_key" UNIQUE ("plaidAccountId");

ALTER TABLE "FinancialAccount"
  ADD CONSTRAINT "FinancialAccount_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "FinancialAccount_ownerWorkspaceId_fkey"
    FOREIGN KEY ("ownerWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "FinancialAccount_ownerUserId_idx"      ON "FinancialAccount"("ownerUserId");
CREATE INDEX IF NOT EXISTS "FinancialAccount_ownerWorkspaceId_idx" ON "FinancialAccount"("ownerWorkspaceId");
CREATE INDEX IF NOT EXISTS "FinancialAccount_type_idx"             ON "FinancialAccount"("type");
CREATE INDEX IF NOT EXISTS "FinancialAccount_deletedAt_idx"        ON "FinancialAccount"("deletedAt");

-- ─────────────────────────────────────────────────────────────────────────────
-- AccountConnection
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AccountConnection" (
  "id"                 TEXT NOT NULL,
  "financialAccountId" TEXT NOT NULL,
  "connectedByUserId"  TEXT NOT NULL,
  "plaidItemDbId"      TEXT,
  "syncStatus"         TEXT NOT NULL DEFAULT 'pending',
  "isCanonical"        BOOLEAN NOT NULL DEFAULT TRUE,
  "lastSyncedAt"       TIMESTAMP(3),
  "deletedAt"          TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountConnection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AccountConnection"
  ADD CONSTRAINT "AccountConnection_financialAccountId_fkey"
    FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "AccountConnection_connectedByUserId_fkey"
    FOREIGN KEY ("connectedByUserId") REFERENCES "User"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "AccountConnection_plaidItemDbId_fkey"
    FOREIGN KEY ("plaidItemDbId") REFERENCES "PlaidItem"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "AccountConnection_financialAccountId_idx"
  ON "AccountConnection"("financialAccountId");
CREATE INDEX IF NOT EXISTS "AccountConnection_connectedByUserId_idx"
  ON "AccountConnection"("connectedByUserId");
CREATE INDEX IF NOT EXISTS "AccountConnection_plaidItemDbId_idx"
  ON "AccountConnection"("plaidItemDbId");
CREATE INDEX IF NOT EXISTS "AccountConnection_financialAccountId_isCanonical_idx"
  ON "AccountConnection"("financialAccountId", "isCanonical");

-- ─────────────────────────────────────────────────────────────────────────────
-- WorkspaceAccountShare
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "WorkspaceAccountShare" (
  "id"                 TEXT NOT NULL,
  "workspaceId"        TEXT NOT NULL,
  "financialAccountId" TEXT NOT NULL,
  "addedByUserId"      TEXT NOT NULL,
  "visibilityLevel"    "VisibilityLevel" NOT NULL DEFAULT 'FULL',
  "status"             "ShareStatus"     NOT NULL DEFAULT 'ACTIVE',
  "revokedAt"          TIMESTAMP(3),
  "revokedByUserId"    TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceAccountShare_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WorkspaceAccountShare"
  ADD CONSTRAINT "WorkspaceAccountShare_workspaceId_financialAccountId_key"
    UNIQUE ("workspaceId", "financialAccountId"),
  ADD CONSTRAINT "WorkspaceAccountShare_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "WorkspaceAccountShare_financialAccountId_fkey"
    FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "WorkspaceAccountShare_addedByUserId_fkey"
    FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "WorkspaceAccountShare_revokedByUserId_fkey"
    FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "WorkspaceAccountShare_workspaceId_status_idx"
  ON "WorkspaceAccountShare"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "WorkspaceAccountShare_financialAccountId_status_idx"
  ON "WorkspaceAccountShare"("financialAccountId", "status");
CREATE INDEX IF NOT EXISTS "WorkspaceAccountShare_addedByUserId_idx"
  ON "WorkspaceAccountShare"("addedByUserId");

-- ─────────────────────────────────────────────────────────────────────────────
-- DuplicateAccountCandidate
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "DuplicateAccountCandidate" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "accountAId"       TEXT NOT NULL,
  "accountBId"       TEXT NOT NULL,
  "status"           "DuplicateStatus" NOT NULL DEFAULT 'PENDING',
  "detectedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"       TIMESTAMP(3),
  "resolvedByUserId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DuplicateAccountCandidate_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DuplicateAccountCandidate"
  ADD CONSTRAINT "DuplicateAccountCandidate_accountAId_accountBId_key"
    UNIQUE ("accountAId", "accountBId"),
  ADD CONSTRAINT "DuplicateAccountCandidate_accountAId_fkey"
    FOREIGN KEY ("accountAId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "DuplicateAccountCandidate_accountBId_fkey"
    FOREIGN KEY ("accountBId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "DuplicateAccountCandidate_resolvedByUserId_fkey"
    FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "DuplicateAccountCandidate_workspaceId_status_idx"
  ON "DuplicateAccountCandidate"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "DuplicateAccountCandidate_accountAId_idx"
  ON "DuplicateAccountCandidate"("accountAId");
CREATE INDEX IF NOT EXISTS "DuplicateAccountCandidate_accountBId_idx"
  ON "DuplicateAccountCandidate"("accountBId");

-- ─────────────────────────────────────────────────────────────────────────────
-- WorkspaceGoal
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "WorkspaceGoal" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "category"        "GoalCategory" NOT NULL DEFAULT 'GENERAL',
  "status"          "GoalStatus"   NOT NULL DEFAULT 'ACTIVE',
  "targetAmount"    DOUBLE PRECISION NOT NULL,
  "currentAmount"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "targetDate"      DATE,
  "completedAt"     TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceGoal_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WorkspaceGoal"
  ADD CONSTRAINT "WorkspaceGoal_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "WorkspaceGoal_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "WorkspaceGoal_workspaceId_status_idx"
  ON "WorkspaceGoal"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "WorkspaceGoal_workspaceId_category_idx"
  ON "WorkspaceGoal"("workspaceId", "category");

-- ─────────────────────────────────────────────────────────────────────────────
-- GoalContribution
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "GoalContribution" (
  "id"                 TEXT NOT NULL,
  "goalId"             TEXT NOT NULL,
  "financialAccountId" TEXT NOT NULL,
  "includeBalance"     BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoalContribution_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GoalContribution"
  ADD CONSTRAINT "GoalContribution_goalId_financialAccountId_key"
    UNIQUE ("goalId", "financialAccountId"),
  ADD CONSTRAINT "GoalContribution_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "WorkspaceGoal"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "GoalContribution_financialAccountId_fkey"
    FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "GoalContribution_goalId_idx"
  ON "GoalContribution"("goalId");
CREATE INDEX IF NOT EXISTS "GoalContribution_financialAccountId_idx"
  ON "GoalContribution"("financialAccountId");

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: Account → FinancialAccount
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "FinancialAccount" (
  "id", "ownerType", "ownerUserId", "ownerWorkspaceId",
  "name", "type", "institution", "balance", "availableBalance",
  "creditLimit", "currency", "lastUpdated", "plaidAccountId",
  "walletAddress", "walletChain", "nativeBalance", "syncStatus",
  "deletedAt", "createdAt", "updatedAt"
)
SELECT
  a."id",
  CASE WHEN a."ownerId" IS NOT NULL THEN 'USER'::"AccountOwnerType"
       ELSE 'WORKSPACE'::"AccountOwnerType"
  END,
  a."ownerId",
  CASE WHEN a."ownerId" IS NULL THEN a."workspaceId" ELSE NULL END,
  a."name", a."type", a."institution", a."balance", a."availableBalance",
  a."creditLimit", a."currency", a."lastUpdated", a."plaidAccountId",
  a."walletAddress", a."walletChain", a."nativeBalance", a."syncStatus",
  a."deletedAt", a."createdAt", a."updatedAt"
FROM "Account" a
ON CONFLICT ("id") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: Account → AccountConnection
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "AccountConnection" (
  "id", "financialAccountId", "connectedByUserId", "plaidItemDbId",
  "syncStatus", "isCanonical", "deletedAt", "createdAt", "updatedAt"
)
SELECT
  a."id" || '_conn',
  a."id",
  COALESCE(
    a."ownerId",
    (SELECT wm."userId" FROM "WorkspaceMember" wm
     WHERE wm."workspaceId" = a."workspaceId" AND wm."role" = 'OWNER'
     LIMIT 1)
  ),
  a."plaidItemDbId",
  COALESCE(a."syncStatus", 'pending'),
  TRUE,
  a."deletedAt",
  a."createdAt",
  a."updatedAt"
FROM "Account" a
WHERE a."ownerId" IS NOT NULL
   OR EXISTS (
        SELECT 1 FROM "WorkspaceMember" wm
        WHERE wm."workspaceId" = a."workspaceId" AND wm."role" = 'OWNER'
      )
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: Account → WorkspaceAccountShare
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "WorkspaceAccountShare" (
  "id", "workspaceId", "financialAccountId", "addedByUserId",
  "visibilityLevel", "status", "createdAt", "updatedAt"
)
SELECT
  a."id" || '_share',
  a."workspaceId",
  a."id",
  COALESCE(
    a."ownerId",
    (SELECT wm."userId" FROM "WorkspaceMember" wm
     WHERE wm."workspaceId" = a."workspaceId" AND wm."role" = 'OWNER'
     LIMIT 1)
  ),
  'FULL'::"VisibilityLevel",
  'ACTIVE'::"ShareStatus",
  a."createdAt",
  a."updatedAt"
FROM "Account" a
WHERE a."ownerId" IS NOT NULL
   OR EXISTS (
        SELECT 1 FROM "WorkspaceMember" wm
        WHERE wm."workspaceId" = a."workspaceId" AND wm."role" = 'OWNER'
      )
ON CONFLICT ("workspaceId", "financialAccountId") DO NOTHING;
