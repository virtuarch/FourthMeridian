-- OPS-2D-5B-1 — typed persistence taxonomy.
--
-- Four additive enum values. Nothing is removed, no row is rewritten, no
-- incidentKey is touched, and UPSERT_ERROR stays: legacy rows keep the kind they
-- were recorded under, because history is evidence and not a style to update.
--
-- These are DESCRIPTIONS, not identity. Incident identity is
-- v1::provider::scope::domain::operationKey and contains no issue kind, so an
-- active generic episode keeps receiving occurrences from the newly typed
-- producer — a taxonomy deployment is not recovery, supersession or recurrence.
--
-- PostgreSQL requires ALTER TYPE ... ADD VALUE to commit before any statement
-- references the new value (see 20260718120000_add_descriptor_evidence_reason).
-- This migration references nothing; the first writers are the producers, which
-- run in later transactions.
ALTER TYPE "SyncIssueKind" ADD VALUE IF NOT EXISTS 'TRANSACTION_PERSISTENCE_FAILED';
ALTER TYPE "SyncIssueKind" ADD VALUE IF NOT EXISTS 'INVESTMENT_DATA_PERSISTENCE_FAILED';
ALTER TYPE "SyncIssueKind" ADD VALUE IF NOT EXISTS 'IMPORT_ROLLBACK_FAILED';
ALTER TYPE "SyncIssueKind" ADD VALUE IF NOT EXISTS 'WALLET_SYNC_FAILED';
