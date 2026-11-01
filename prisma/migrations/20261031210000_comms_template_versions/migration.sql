-- COMMS CENTER B1 (2026-10-31) — editable template CONTENT VERSIONS and the
-- AI-assisted authoring audit (docs/plans/COMMS-CENTER-API-CONTRACT-v1.1-DELTA-
-- 2026-10-31.md §2, §3, §4, §8.1, §8.3, §8.6).
--
-- ADDITIVE ONLY: three NEW tables, their indexes, grants and RLS, plus ONE
-- nullable column on CommsDelivery. No existing row, policy or grant changes.
--
--   CommsTemplate         the HEAD of one content stream (definitionKey, channel,
--                         variant): which version is live (null = the code
--                         default) and the optimistic token `revision`.
--   CommsTemplateVersion  one IMMUTABLE version of a stream's content (template
--                         text and placeholder NAMES only — never a placeholder
--                         value, never customer data). State is derived:
--                         PUBLISHED ⇔ head.publishedVersionId = id; SUPERSEDED ⇔
--                         publishedAt IS NOT NULL and not live; DRAFT otherwise.
--   CommsAiSuggestion     one AI-authoring request and its outcome (OFFERED /
--                         REJECTED / UNAVAILABLE / ACCEPTED / EXPIRED). Text is
--                         stored only for OFFERED / ACCEPTED, and it is template
--                         text: the request carried no customer data (§4.2).
--   CommsDelivery.contentVersionId  the operator version a send rendered;
--                         NULL = the code default.
--
-- AUTHORITY (least privilege; the house pattern of 20261031200000):
--   CommsTemplate         fm_system  SELECT, INSERT, UPDATE           (no DELETE)
--   CommsTemplateVersion  fm_system  SELECT, INSERT, and UPDATE on ONLY
--                                    ("publishedAt", "publishAuditLogId") — the
--                                    content columns are physically immutable
--   CommsAiSuggestion     fm_system  SELECT, INSERT, DELETE (retention), and UPDATE
--                                    on ONLY ("status", "acceptedVersionId", "resolvedAt")
--   all three             fm_app     nothing  (operators read and write through fm_system;
--                                              the send path resolves content through fm_system)
--                         fm_auth    nothing
--                         fm_backup  SELECT   (complete dumps)
-- CommsDelivery keeps SELECT, INSERT, DELETE for fm_system (append-only); a
-- table-level INSERT grant covers the new column.

-- ── 1. Tables + indexes ──────────────────────────────────────────────────────
CREATE TABLE "CommsTemplate" (
    "id" TEXT NOT NULL,
    "definitionKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'default',
    "publishedVersionId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "headVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommsTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommsTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "preheader" TEXT,
    "blocks" JSONB NOT NULL,
    "placeholdersUsed" TEXT[],
    "contentHash" TEXT NOT NULL,
    "validatorVersion" INTEGER NOT NULL,
    "createdByKind" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "createdById" TEXT,
    "parentVersionId" TEXT,
    "basePublishedVersionId" TEXT,
    "restoredFromVersionId" TEXT,
    "sourceSuggestionId" TEXT,
    "aiEditedAfterAccept" BOOLEAN,
    "createdAuditLogId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishAuditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommsTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommsAiSuggestion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "baseVersionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "tone" TEXT,
    "status" TEXT NOT NULL,
    "unavailableReason" TEXT,
    "unavailableDetail" TEXT,
    "rejectionCodes" TEXT[],
    "suggestedContent" JSONB,
    "suggestedHash" TEXT,
    "notes" JSONB,
    "model" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestAuditLogId" TEXT NOT NULL,
    "acceptedVersionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CommsAiSuggestion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CommsDelivery" ADD COLUMN "contentVersionId" TEXT;

CREATE UNIQUE INDEX "CommsTemplate_definitionKey_channel_variant_key" ON "CommsTemplate"("definitionKey", "channel", "variant");
CREATE UNIQUE INDEX "CommsTemplateVersion_templateId_version_key" ON "CommsTemplateVersion"("templateId", "version");
CREATE INDEX "CommsTemplateVersion_templateId_createdAt_idx" ON "CommsTemplateVersion"("templateId", "createdAt");
CREATE INDEX "CommsAiSuggestion_templateId_createdAt_idx" ON "CommsAiSuggestion"("templateId", "createdAt");
CREATE INDEX "CommsAiSuggestion_status_expiresAt_idx" ON "CommsAiSuggestion"("status", "expiresAt");
CREATE INDEX "CommsAiSuggestion_requestedById_createdAt_idx" ON "CommsAiSuggestion"("requestedById", "createdAt");

ALTER TABLE "CommsTemplateVersion" ADD CONSTRAINT "CommsTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CommsTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 2. Grants + RLS — the system principal only ──────────────────────────────
REVOKE ALL ON TABLE public."CommsTemplate" FROM fm_app;
REVOKE ALL ON TABLE public."CommsTemplate" FROM fm_auth;
REVOKE ALL ON TABLE public."CommsTemplate" FROM fm_system;
GRANT SELECT ON TABLE public."CommsTemplate" TO fm_backup;
GRANT SELECT, INSERT, UPDATE ON TABLE public."CommsTemplate" TO fm_system;

REVOKE ALL ON TABLE public."CommsTemplateVersion" FROM fm_app;
REVOKE ALL ON TABLE public."CommsTemplateVersion" FROM fm_auth;
REVOKE ALL ON TABLE public."CommsTemplateVersion" FROM fm_system;
GRANT SELECT ON TABLE public."CommsTemplateVersion" TO fm_backup;
GRANT SELECT, INSERT ON TABLE public."CommsTemplateVersion" TO fm_system;
GRANT UPDATE ("publishedAt", "publishAuditLogId") ON TABLE public."CommsTemplateVersion" TO fm_system;

REVOKE ALL ON TABLE public."CommsAiSuggestion" FROM fm_app;
REVOKE ALL ON TABLE public."CommsAiSuggestion" FROM fm_auth;
REVOKE ALL ON TABLE public."CommsAiSuggestion" FROM fm_system;
GRANT SELECT ON TABLE public."CommsAiSuggestion" TO fm_backup;
GRANT SELECT, INSERT, DELETE ON TABLE public."CommsAiSuggestion" TO fm_system;
GRANT UPDATE ("status", "acceptedVersionId", "resolvedAt") ON TABLE public."CommsAiSuggestion" TO fm_system;

ALTER TABLE public."CommsTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CommsTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."CommsTemplate" FOR ALL TO fm_system USING (true) WITH CHECK (true);

ALTER TABLE public."CommsTemplateVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CommsTemplateVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."CommsTemplateVersion" FOR ALL TO fm_system USING (true) WITH CHECK (true);

ALTER TABLE public."CommsAiSuggestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CommsAiSuggestion" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."CommsAiSuggestion" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- Belt and braces (as migration 20261002000100 §19): never reachable by the Data API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."CommsTemplate" FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE ALL ON TABLE public."CommsTemplateVersion" FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE ALL ON TABLE public."CommsAiSuggestion" FROM anon, authenticated, service_role';
  END IF;
END $$;
