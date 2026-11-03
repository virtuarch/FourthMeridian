-- scripts/test-incident-phase1-schema.sql  (PB-1 Phase 1 — disposable-PG schema probes)
--
-- Grants, FORCED RLS and every DB-level CHECK of migration 20261103120000, run
-- as the real roles. THROWAWAY DATABASES ONLY (it writes and deletes rows).
-- Every probe prints OK or REFUSED; the expected result is in each label.
--   psql "$THROWAWAY_URL" -At -f scripts/test-incident-phase1-schema.sql

\set ON_ERROR_STOP 0
\set QUIET 1
-- Each probe runs in its own savepoint-free transaction; expect OK / DENIED lines.
CREATE OR REPLACE FUNCTION pg_temp.probe(label text, stmt text, role text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', role); END IF;
  EXECUTE stmt;
  IF role IS NOT NULL THEN RESET ROLE; END IF;
  RETURN label || ': OK';
EXCEPTION WHEN OTHERS THEN
  RETURN label || ': REFUSED (' || SQLSTATE || ' ' || left(SQLERRM, 70) || ')';
END $$;
INSERT INTO "SyncIssue" (id, kind, "updatedAt", "incidentKey") VALUES ('si_t', 'WALLET_SYNC_FAILED', now(), 'v1::WALLET::x::wallet::price');
SELECT pg_temp.probe('event insert WITHOUT at as fm_system', $q$INSERT INTO "SyncIssueEvent"(id,"incidentId",type,"actorKind") VALUES ('e1','si_t','OBSERVED','SYSTEM')$q$, 'fm_system');
SELECT pg_temp.probe('event insert WITH at as fm_system (backdate)', $q$INSERT INTO "SyncIssueEvent"(id,"incidentId",at,type,"actorKind") VALUES ('e2','si_t','2020-01-01','OBSERVED','SYSTEM')$q$, 'fm_system');
SELECT pg_temp.probe('event UPDATE as fm_system', $q$UPDATE "SyncIssueEvent" SET "toState"='RESOLVED' WHERE id='e1'$q$, 'fm_system');
SELECT pg_temp.probe('event select as fm_app', $q$SELECT 1 FROM "SyncIssueEvent"$q$, 'fm_app');
SELECT pg_temp.probe('archive select as fm_app', $q$SELECT 1 FROM "SyncIssueArchive"$q$, 'fm_app');
SELECT pg_temp.probe('relation select as fm_app', $q$SELECT 1 FROM "SyncIssueRelation"$q$, 'fm_app');
SELECT pg_temp.probe('archive select as fm_backup', $q$SELECT 1 FROM "SyncIssueArchive"$q$, 'fm_backup');
SELECT pg_temp.probe('fm_app reads the RLS-16 columns', $q$SELECT id, kind, resolved, "createdAt", "financialAccountId", "plaidTransactionId" FROM "SyncIssue"$q$, 'fm_app');
SELECT pg_temp.probe('fm_app reads a NEW column (subjectUserId)', $q$SELECT "subjectUserId" FROM "SyncIssue"$q$, 'fm_app');
SELECT pg_temp.probe('fm_app reads lifecycleState', $q$SELECT "lifecycleState" FROM "SyncIssue"$q$, 'fm_app');
SELECT pg_temp.probe('event delete as fm_system', $q$DELETE FROM "SyncIssueEvent" WHERE id='e1'$q$, 'fm_system');
-- CHECKs
SELECT pg_temp.probe('CHECK resolved=state', $q$UPDATE "SyncIssue" SET "lifecycleState"='RESOLVED' WHERE id='si_t'$q$);
SELECT pg_temp.probe('CHECK RESOLVED needs resolvedAt+reason', $q$UPDATE "SyncIssue" SET resolved=true,"lifecycleState"='RESOLVED',"resolvedAt"=now() WHERE id='si_t'$q$);
SELECT pg_temp.probe('RESOLVED with reason (valid)', $q$UPDATE "SyncIssue" SET resolved=true,"lifecycleState"='RESOLVED',"resolvedAt"=now(),"resolutionReasonCode"='SUBJECT_DELETED' WHERE id='si_t'$q$);
SELECT pg_temp.probe('CHECK reason code format', $q$UPDATE "SyncIssue" SET "resolutionReasonCode"='free text' WHERE id='si_t'$q$);
SELECT pg_temp.probe('CHECK ack trio all-or-none', $q$UPDATE "SyncIssue" SET "acknowledgedAt"=now() WHERE id='si_t'$q$);
SELECT pg_temp.probe('CHECK cause needs code', $q$UPDATE "SyncIssue" SET "causeStatus"='HYPOTHESIS' WHERE id='si_t'$q$);
SELECT pg_temp.probe('CHECK CONFIRMED needs who+audit', $q$UPDATE "SyncIssue" SET "causeStatus"='CONFIRMED',"causeCode"='PROVIDER_OUTAGE' WHERE id='si_t'$q$);
SELECT pg_temp.probe('CHECK lifecycleState value', $q$UPDATE "SyncIssue" SET "lifecycleState"='REOPENED' WHERE id='si_t'$q$);
SELECT pg_temp.probe('CHECK evidence <= 4096 B', $q$UPDATE "SyncIssue" SET "resolutionEvidence"=jsonb_build_object('x', (SELECT string_agg(md5(i::text),'') FROM generate_series(1,200) i)) WHERE id='si_t'$q$);
SELECT pg_temp.probe('CHECK occurrence evidenceSummary <= 4096 B', $q$INSERT INTO "SyncIssueOccurrence"(id,"syncIssueId","evidenceSummary") VALUES ('o1','si_t',jsonb_build_object('x', (SELECT string_agg(md5(i::text),'') FROM generate_series(1,200) i)))$q$);
SELECT pg_temp.probe('CHECK event OPERATOR needs actor+audit', $q$INSERT INTO "SyncIssueEvent"(id,"incidentId",type,"actorKind") VALUES ('e3','si_t','ACTION_TAKEN','OPERATOR')$q$);
SELECT pg_temp.probe('CHECK event SYSTEM has no actor', $q$INSERT INTO "SyncIssueEvent"(id,"incidentId",type,"actorKind","actorId") VALUES ('e4','si_t','OBSERVED','SYSTEM','u')$q$);
SELECT pg_temp.probe('CHECK CAUSE_RETRACTED needs refEventId', $q$INSERT INTO "SyncIssueEvent"(id,"incidentId",type,"actorKind") VALUES ('e5','si_t','CAUSE_RETRACTED','SYSTEM')$q$);
SELECT pg_temp.probe('CHECK event code format', $q$INSERT INTO "SyncIssueEvent"(id,"incidentId",type,"actorKind","outcomeCode") VALUES ('e6','si_t','NOTE_CODE','SYSTEM','it broke')$q$);
SELECT pg_temp.probe('CHECK relation self-link', $q$INSERT INTO "SyncIssueRelation"(id,"fromIncidentId","toIncidentId",kind,"createdBy") VALUES ('r1','a','a','RELATED','SYSTEM')$q$);
SELECT pg_temp.probe('CHECK symmetric relation order', $q$INSERT INTO "SyncIssueRelation"(id,"fromIncidentId","toIncidentId",kind,"createdBy") VALUES ('r2','b','a','SAME_ROOT_CAUSE','SYSTEM')$q$);
SELECT pg_temp.probe('relation RECURRENCE_OF any order (valid)', $q$INSERT INTO "SyncIssueRelation"(id,"fromIncidentId","toIncidentId",kind,"createdBy","createdById","auditId") VALUES ('r3','b','a','RECURRENCE_OF','OPERATOR','u','aud')$q$);
SELECT pg_temp.probe('CHECK OPERATOR relation needs auditId', $q$INSERT INTO "SyncIssueRelation"(id,"fromIncidentId","toIncidentId",kind,"createdBy") VALUES ('r4','a','b','RELATED','OPERATOR')$q$);
SELECT pg_temp.probe('relation to an archived (absent) incident id (valid — soft ref)', $q$INSERT INTO "SyncIssueRelation"(id,"fromIncidentId","toIncidentId",kind,"createdBy") VALUES ('r5','a','zz-archived','RELATED','SYSTEM')$q$);
SELECT pg_temp.probe('CHECK archive timeline <= 8192 B', $q$INSERT INTO "SyncIssueArchive"(id,"incidentId",provider,kind,"occurrenceCount","eventTimeline") VALUES ('a1','x','PLAID','K',0,jsonb_build_object('x', (SELECT string_agg(md5(i::text),'') FROM generate_series(1,400) i)))$q$);
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('SyncIssueEvent','SyncIssueArchive','SyncIssueRelation') ORDER BY 1;
SELECT count(*) AS rewritten_rows_check FROM "SyncIssue" WHERE "recoveryEvidenceCount" IS NULL;
DELETE FROM "SyncIssueRelation"; DELETE FROM "SyncIssueEvent"; DELETE FROM "SyncIssue" WHERE id='si_t';
