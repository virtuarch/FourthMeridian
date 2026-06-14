-- Migration: add_security_models
-- Adds: RecoveryCode, UserSession, PlatformSetting
-- Updates: AuditLog (userAgent, performedByAdminId), User (forcePasswordReset)

-- ── User additions ─────────────────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "forcePasswordReset" BOOLEAN NOT NULL DEFAULT false;

-- ── AuditLog additions ─────────────────────────────────────────────────────────
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "performedByAdminId" TEXT;
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- ── RecoveryCode ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RecoveryCode" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "codeHash"  TEXT NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");
CREATE INDEX IF NOT EXISTS "RecoveryCode_userId_usedAt_idx" ON "RecoveryCode"("userId", "usedAt");

ALTER TABLE "RecoveryCode"
    DROP CONSTRAINT IF EXISTS "RecoveryCode_userId_fkey",
    ADD CONSTRAINT "RecoveryCode_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── UserSession ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "UserSession" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "ipAddress"    TEXT,
    "userAgent"    TEXT,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"    TIMESTAMP(3),
    "revokedById"  TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserSession_sessionToken_key" ON "UserSession"("sessionToken");
CREATE INDEX IF NOT EXISTS "UserSession_userId_idx" ON "UserSession"("userId");
CREATE INDEX IF NOT EXISTS "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");

ALTER TABLE "UserSession"
    DROP CONSTRAINT IF EXISTS "UserSession_userId_fkey",
    ADD CONSTRAINT "UserSession_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PlatformSetting ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PlatformSetting" (
    "key"         TEXT NOT NULL,
    "value"       TEXT NOT NULL,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- Seed default settings
INSERT INTO "PlatformSetting" ("key", "value", "updatedAt") VALUES
    ('require_totp_system_admin', 'false', CURRENT_TIMESTAMP),
    ('require_totp_admins',       'false', CURRENT_TIMESTAMP),
    ('require_totp_all_users',    'false', CURRENT_TIMESTAMP),
    ('recovery_codes_enabled',    'true',  CURRENT_TIMESTAMP),
    ('min_password_length',       '8',     CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
