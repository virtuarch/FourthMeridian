-- PB-1 PHASE 1 — INCIDENT DATA MODEL (one additive migration)
--
-- docs/plans/PB1-INCIDENT-LIFECYCLE.md §3.3 + §12 P3, extended by the owner's
-- Phase-1 data-model directive (2026-11-03) and Session 2's binding conditions.
--
-- HYGIENE
--   * Additive only: nothing dropped, renamed or retyped; the partial unique
--     index (one open episode per incidentKey) is untouched.
--   * NO BACKFILL. There is no UPDATE in this file. Every new column is
--     nullable except `recoveryEvidenceCount`, whose default is the CONSTANT 0
--     (PostgreSQL ≥ 11 stores a constant default in the catalog — no table
--     rewrite). Readers derive the state from `resolved` while
--     `lifecycleState` IS NULL.
--   * Every CHECK below is satisfied by every existing row by construction
--     (each one is vacuous while its new columns are NULL), so no row is
--     re-validated into failure.
--
-- RLS / GRANTS
--   * The fm_app column grant on SyncIssue (20261002000500_rls_app_sync_issue_read)
--     is NOT changed: Postgres column privileges do not extend to new columns,
--     so the member activity feed still reads exactly id/kind/resolved/
--     createdAt/financialAccountId/plaidTransactionId.
--   * The three new tables are fm_system-only: FORCE RLS + fm_system_all,
--     SELECT for fm_backup, nothing for fm_app / fm_auth. SyncIssueEvent is
--     append-only by grant (no UPDATE; INSERT excludes `at`).

-- ═════════════════════════════════════════════════════════════════════════════
-- SyncIssue
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE "SyncIssue"
  -- §3.3 lifecycle
  ADD COLUMN "lifecycleState"        TEXT,
  ADD COLUMN "openedBy"              TEXT,
  ADD COLUMN "acknowledgedAt"        TIMESTAMP(3),
  ADD COLUMN "acknowledgedById"      TEXT,
  ADD COLUMN "acknowledgedAuditId"   TEXT,
  ADD COLUMN "recoveringSince"       TIMESTAMP(3),
  ADD COLUMN "recoveryEvidenceCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "staleSince"            TIMESTAMP(3),
  ADD COLUMN "lastEvidenceCheckedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedById"          TEXT,
  ADD COLUMN "resolutionReasonCode"  TEXT,
  ADD COLUMN "resolutionAuditId"     TEXT,
  ADD COLUMN "resolutionEvidence"    JSONB,
  -- Phase-1 extension
  ADD COLUMN "archivedAt"            TIMESTAMP(3),
  ADD COLUMN "subjectUserId"         TEXT,
  ADD COLUMN "causeStatus"           TEXT,
  ADD COLUMN "causeCode"             TEXT,
  ADD COLUMN "causeConfirmedById"    TEXT,
  ADD COLUMN "causeConfirmedAuditId" TEXT;

-- Value sets (§12 P3: TEXT + CHECK; REOPENED is display-only, never stored).
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_lifecycleState_check"
  CHECK ("lifecycleState" IS NULL OR "lifecycleState" IN ('ACTIVE', 'ACKNOWLEDGED', 'RECOVERING', 'STALE', 'RESOLVED'));
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_openedBy_check"
  CHECK ("openedBy" IS NULL OR "openedBy" IN ('OBSERVATION', 'RECURRENCE', 'OPERATOR_REOPEN'));
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_causeStatus_check"
  CHECK ("causeStatus" IS NULL OR "causeStatus" IN ('HYPOTHESIS', 'CONFIRMED'));
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_recoveryEvidenceCount_check"
  CHECK ("recoveryEvidenceCount" >= 0);

-- Registry codes (lib/platform/incidents/codes.ts), never free text.
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_resolutionReasonCode_format_check"
  CHECK ("resolutionReasonCode" IS NULL OR "resolutionReasonCode" ~ '^[A-Z0-9_]{2,64}$');
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_causeCode_format_check"
  CHECK ("causeCode" IS NULL OR "causeCode" ~ '^[A-Z0-9_]{2,64}$');

-- Cross-column rules (DB-level, mirrored in lib/platform/incidents/invariant.ts).
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_lifecycleState_resolved_check"
  CHECK ("lifecycleState" IS NULL OR "resolved" = ("lifecycleState" = 'RESOLVED'));
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_resolved_state_reason_check"
  CHECK ("lifecycleState" IS DISTINCT FROM 'RESOLVED' OR ("resolvedAt" IS NOT NULL AND "resolutionReasonCode" IS NOT NULL));
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_acknowledged_all_or_none_check"
  CHECK (("acknowledgedAt" IS NULL) = ("acknowledgedById" IS NULL) AND ("acknowledgedById" IS NULL) = ("acknowledgedAuditId" IS NULL));
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_cause_code_check"
  CHECK ("causeStatus" IS NULL OR "causeCode" IS NOT NULL);
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_cause_confirmed_check"
  CHECK ("causeStatus" IS DISTINCT FROM 'CONFIRMED' OR ("causeConfirmedById" IS NOT NULL AND "causeConfirmedAuditId" IS NOT NULL));

-- Size cap (§8: frozen summaries, never raw evidence).
ALTER TABLE "SyncIssue" ADD CONSTRAINT "SyncIssue_resolutionEvidence_size_check"
  CHECK ("resolutionEvidence" IS NULL OR pg_column_size("resolutionEvidence") <= 4096);

CREATE INDEX "SyncIssue_lifecycleState_lastOccurredAt_idx" ON "SyncIssue"("lifecycleState", "lastOccurredAt");
CREATE INDEX "SyncIssue_subjectUserId_idx" ON "SyncIssue"("subjectUserId");

-- ═════════════════════════════════════════════════════════════════════════════
-- SyncIssueOccurrence — structured subjects and job link (soft references)
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE "SyncIssueOccurrence"
  ADD COLUMN "evidenceSummary"  JSONB,
  ADD COLUMN "subjectAccountId" TEXT,
  ADD COLUMN "securityId"       TEXT,
  ADD COLUMN "jobRunId"         TEXT,
  ADD COLUMN "jobName"          TEXT;

ALTER TABLE "SyncIssueOccurrence" ADD CONSTRAINT "SyncIssueOccurrence_evidenceSummary_size_check"
  CHECK ("evidenceSummary" IS NULL OR pg_column_size("evidenceSummary") <= 4096);

-- ═════════════════════════════════════════════════════════════════════════════
-- SyncIssueRelation — explicit links between episodes (soft references)
-- ═════════════════════════════════════════════════════════════════════════════
-- No FK to SyncIssue on purpose: a relation may name an incident whose row has
-- been pruned and survives only in SyncIssueArchive (same id). Recurrence
-- stays derived from SyncIssue.previousIncidentId; RECURRENCE_OF rows are
-- written only for explicit operator links. Symmetric kinds are stored once,
-- normalised from < to. Retained 13 months from creation
-- (jobs/data-retention.ts), the same window as the archive.
CREATE TABLE "SyncIssueRelation" (
    "id"             TEXT NOT NULL,
    "fromIncidentId" TEXT NOT NULL,
    "toIncidentId"   TEXT NOT NULL,
    "kind"           TEXT NOT NULL,
    "createdBy"      TEXT NOT NULL,
    "createdById"    TEXT,
    "auditId"        TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncIssueRelation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SyncIssueRelation_kind_check" CHECK ("kind" IN ('RECURRENCE_OF', 'SAME_ROOT_CAUSE', 'RELATED')),
    CONSTRAINT "SyncIssueRelation_createdBy_check" CHECK ("createdBy" IN ('SYSTEM', 'OPERATOR')),
    CONSTRAINT "SyncIssueRelation_operator_check" CHECK ("createdBy" <> 'OPERATOR' OR "auditId" IS NOT NULL),
    CONSTRAINT "SyncIssueRelation_distinct_check" CHECK ("fromIncidentId" <> "toIncidentId"),
    CONSTRAINT "SyncIssueRelation_symmetric_order_check" CHECK ("kind" = 'RECURRENCE_OF' OR "fromIncidentId" < "toIncidentId")
);
CREATE UNIQUE INDEX "SyncIssueRelation_fromIncidentId_toIncidentId_kind_key" ON "SyncIssueRelation"("fromIncidentId", "toIncidentId", "kind");
CREATE INDEX "SyncIssueRelation_toIncidentId_idx" ON "SyncIssueRelation"("toIncidentId");
CREATE INDEX "SyncIssueRelation_createdAt_idx" ON "SyncIssueRelation"("createdAt");

-- ═════════════════════════════════════════════════════════════════════════════
-- SyncIssueArchive — the durable, summary-only record of a pruned episode
-- ═════════════════════════════════════════════════════════════════════════════
-- Written by the 90-day prune (upsert-before-delete keyed on incidentId, so a
-- crash neither loses nor duplicates a summary). ALLOWLIST ONLY: ids, codes,
-- timestamps, counts and the size-capped typed resolutionEvidence. No
-- `detail`, no provider message, no free text of any kind. Retained 13 months
-- (owner, 2026-11-03); subjectUserId is NULLed by the account-deletion purge.
CREATE TABLE "SyncIssueArchive" (
    "id"                   TEXT NOT NULL,
    "incidentId"           TEXT NOT NULL,
    "incidentKey"          TEXT,
    "provider"             TEXT NOT NULL,
    "kind"                 TEXT NOT NULL,
    "operation"            TEXT,
    "plaidItemId"          TEXT,
    "financialAccountId"   TEXT,
    "subjectUserId"        TEXT,
    "previousIncidentId"   TEXT,
    "firstOccurredAt"      TIMESTAMP(3),
    "lastOccurredAt"       TIMESTAMP(3),
    "resolvedAt"           TIMESTAMP(3),
    "resolutionKind"       TEXT,
    "resolutionReasonCode" TEXT,
    "causeStatus"          TEXT,
    "causeCode"            TEXT,
    "occurrenceCount"      INTEGER NOT NULL,
    "resolutionEvidence"   JSONB,
    "eventTimeline"        JSONB,
    "archivedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncIssueArchive_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SyncIssueArchive_occurrenceCount_check" CHECK ("occurrenceCount" >= 0),
    CONSTRAINT "SyncIssueArchive_causeStatus_check" CHECK ("causeStatus" IS NULL OR "causeStatus" IN ('HYPOTHESIS', 'CONFIRMED')),
    CONSTRAINT "SyncIssueArchive_codes_format_check" CHECK (
      ("resolutionReasonCode" IS NULL OR "resolutionReasonCode" ~ '^[A-Z0-9_]{2,64}$')
      AND ("causeCode" IS NULL OR "causeCode" ~ '^[A-Z0-9_]{2,64}$')),
    CONSTRAINT "SyncIssueArchive_resolutionEvidence_size_check" CHECK ("resolutionEvidence" IS NULL OR pg_column_size("resolutionEvidence") <= 4096),
    CONSTRAINT "SyncIssueArchive_eventTimeline_size_check" CHECK ("eventTimeline" IS NULL OR pg_column_size("eventTimeline") <= 8192)
);
CREATE UNIQUE INDEX "SyncIssueArchive_incidentId_key" ON "SyncIssueArchive"("incidentId");
CREATE INDEX "SyncIssueArchive_archivedAt_idx" ON "SyncIssueArchive"("archivedAt");
CREATE INDEX "SyncIssueArchive_subjectUserId_resolvedAt_idx" ON "SyncIssueArchive"("subjectUserId", "resolvedAt");
CREATE INDEX "SyncIssueArchive_provider_kind_resolvedAt_idx" ON "SyncIssueArchive"("provider", "kind", "resolvedAt");

-- ═════════════════════════════════════════════════════════════════════════════
-- SyncIssueEvent — append-only chronology (codes and refs only)
-- ═════════════════════════════════════════════════════════════════════════════
-- A cause confirmed later is an event AT THE TIME it was confirmed, so it is
-- never presented as known at detection. OBSERVED is written once at episode
-- open (occurrences are the per-observation record — they are not mirrored).
-- Soft reference to the incident: events are copied into
-- SyncIssueArchive.eventTimeline and deleted with the live row at the prune.
--
-- APPEND-ONLY BY GRANT: fm_system may SELECT, INSERT (every column EXCEPT
-- `at` — the database stamps the time; no backdating) and DELETE (only the
-- retention prune and the account-deletion purge do — pinned statically in
-- lib/platform/incidents/incident-boundary.test.ts). No UPDATE for anyone.
CREATE TABLE "SyncIssueEvent" (
    "id"                 TEXT NOT NULL,
    "incidentId"         TEXT NOT NULL,
    "at"                 TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
    "type"               TEXT NOT NULL,
    "actorKind"          TEXT NOT NULL,
    "actorId"            TEXT,
    "auditId"            TEXT,
    "fromState"          TEXT,
    "toState"            TEXT,
    "causeCode"          TEXT,
    "actionCode"         TEXT,
    "outcomeCode"        TEXT,
    "refEventId"         TEXT,
    "occurrenceId"       TEXT,
    "refreshExecutionId" TEXT,
    "jobRunId"           TEXT,
    CONSTRAINT "SyncIssueEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SyncIssueEvent_type_check" CHECK ("type" IN ('OBSERVED', 'STATE_CHANGED', 'CAUSE_HYPOTHESIZED', 'CAUSE_CONFIRMED', 'CAUSE_RETRACTED', 'ACTION_TAKEN', 'ACTION_OUTCOME', 'NOTE_CODE')),
    CONSTRAINT "SyncIssueEvent_actorKind_check" CHECK ("actorKind" IN ('SYSTEM', 'OPERATOR')),
    CONSTRAINT "SyncIssueEvent_operator_actor_check" CHECK ("actorKind" <> 'OPERATOR' OR ("actorId" IS NOT NULL AND "auditId" IS NOT NULL)),
    CONSTRAINT "SyncIssueEvent_system_actor_check" CHECK ("actorKind" <> 'SYSTEM' OR "actorId" IS NULL),
    CONSTRAINT "SyncIssueEvent_retraction_ref_check" CHECK ("type" <> 'CAUSE_RETRACTED' OR "refEventId" IS NOT NULL),
    CONSTRAINT "SyncIssueEvent_codes_format_check" CHECK (
      ("fromState"   IS NULL OR "fromState"   ~ '^[A-Z0-9_]{2,64}$')
      AND ("toState"     IS NULL OR "toState"     ~ '^[A-Z0-9_]{2,64}$')
      AND ("causeCode"   IS NULL OR "causeCode"   ~ '^[A-Z0-9_]{2,64}$')
      AND ("actionCode"  IS NULL OR "actionCode"  ~ '^[A-Z0-9_]{2,64}$')
      AND ("outcomeCode" IS NULL OR "outcomeCode" ~ '^[A-Z0-9_]{2,64}$'))
);
CREATE INDEX "SyncIssueEvent_incidentId_at_idx" ON "SyncIssueEvent"("incidentId", "at");

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS — the new tables are fm_system-only (operator forensics)
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public."SyncIssueRelation" FROM fm_app;
REVOKE ALL ON TABLE public."SyncIssueRelation" FROM fm_auth;
REVOKE ALL ON TABLE public."SyncIssueRelation" FROM fm_system;
GRANT SELECT ON TABLE public."SyncIssueRelation" TO fm_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."SyncIssueRelation" TO fm_system;
ALTER TABLE public."SyncIssueRelation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SyncIssueRelation" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."SyncIssueRelation" FOR ALL TO fm_system USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public."SyncIssueArchive" FROM fm_app;
REVOKE ALL ON TABLE public."SyncIssueArchive" FROM fm_auth;
REVOKE ALL ON TABLE public."SyncIssueArchive" FROM fm_system;
GRANT SELECT ON TABLE public."SyncIssueArchive" TO fm_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."SyncIssueArchive" TO fm_system;
ALTER TABLE public."SyncIssueArchive" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SyncIssueArchive" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."SyncIssueArchive" FOR ALL TO fm_system USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public."SyncIssueEvent" FROM fm_app;
REVOKE ALL ON TABLE public."SyncIssueEvent" FROM fm_auth;
REVOKE ALL ON TABLE public."SyncIssueEvent" FROM fm_system;
GRANT SELECT ON TABLE public."SyncIssueEvent" TO fm_backup;
GRANT SELECT, DELETE ON TABLE public."SyncIssueEvent" TO fm_system;
GRANT INSERT ("id", "incidentId", "type", "actorKind", "actorId", "auditId", "fromState", "toState",
              "causeCode", "actionCode", "outcomeCode", "refEventId", "occurrenceId", "refreshExecutionId", "jobRunId")
  ON TABLE public."SyncIssueEvent" TO fm_system;
ALTER TABLE public."SyncIssueEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SyncIssueEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."SyncIssueEvent" FOR ALL TO fm_system USING (true) WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."SyncIssueEvent" FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE ALL ON TABLE public."SyncIssueRelation" FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE ALL ON TABLE public."SyncIssueArchive" FROM anon, authenticated, service_role';
  END IF;
END $$;
