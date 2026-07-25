-- OPS-2D-5A-1 — sync incident lifecycle + execution correlation.
--
-- Additive throughout: new nullable columns, one new table, one partial unique
-- index. No column is dropped, no row is rewritten, and `resolved` stays exactly
-- where it was — six consumers and lib/platform/sync-issue-semantics.ts read it,
-- so it remains a compatibility projection until every read is migrated.
--
-- BACKFILL IS DELIBERATELY MINIMAL. firstOccurredAt/lastOccurredAt take
-- createdAt because that is provable. Everything else stays NULL:
--   * incidentKey — legacy rows were never episodes; inventing identity would
--     retroactively merge failures that were recorded as separate facts.
--   * resolvedAt — a legacy `resolved = true` row records THAT it recovered,
--     never WHEN. updatedAt is not a resolution timestamp (any write moves it).
--   * resolvingExecutionId — no legacy row can prove which run recovered it.
-- Nulls here mean "historically unknown", which is the truth. See
-- lib/platform/incidents/ for how projections render that honestly.

ALTER TABLE "SyncIssue" ADD COLUMN IF NOT EXISTS "incidentKey"          TEXT;
ALTER TABLE "SyncIssue" ADD COLUMN IF NOT EXISTS "incidentKeyVersion"   INTEGER;
ALTER TABLE "SyncIssue" ADD COLUMN IF NOT EXISTS "previousIncidentId"   TEXT;
ALTER TABLE "SyncIssue" ADD COLUMN IF NOT EXISTS "firstOccurredAt"      TIMESTAMP(3);
ALTER TABLE "SyncIssue" ADD COLUMN IF NOT EXISTS "lastOccurredAt"       TIMESTAMP(3);
ALTER TABLE "SyncIssue" ADD COLUMN IF NOT EXISTS "resolvedAt"           TIMESTAMP(3);
ALTER TABLE "SyncIssue" ADD COLUMN IF NOT EXISTS "resolutionKind"       TEXT;
ALTER TABLE "SyncIssue" ADD COLUMN IF NOT EXISTS "resolvingExecutionId" TEXT;

-- Provable backfill only.
UPDATE "SyncIssue"
   SET "firstOccurredAt" = COALESCE("firstOccurredAt", "createdAt"),
       "lastOccurredAt"  = COALESCE("lastOccurredAt",  "createdAt");

CREATE TABLE IF NOT EXISTS "SyncIssueOccurrence" (
    "id"                 TEXT NOT NULL,
    "syncIssueId"        TEXT NOT NULL,
    "refreshExecutionId" TEXT,
    "runId"              TEXT,
    "observedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail"             JSONB,
    CONSTRAINT "SyncIssueOccurrence_pkey" PRIMARY KEY ("id")
);

-- Cascade: an occurrence has no meaning without its episode. This is the ONLY
-- hard FK added — the execution references stay soft, because the refresh ledger
-- is append-only and must outlive the items it describes.
ALTER TABLE "SyncIssueOccurrence"
  ADD CONSTRAINT "SyncIssueOccurrence_syncIssueId_fkey"
  FOREIGN KEY ("syncIssueId") REFERENCES "SyncIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "SyncIssueOccurrence_syncIssueId_observedAt_idx"
  ON "SyncIssueOccurrence"("syncIssueId", "observedAt");
CREATE INDEX IF NOT EXISTS "SyncIssueOccurrence_refreshExecutionId_idx"
  ON "SyncIssueOccurrence"("refreshExecutionId");
CREATE INDEX IF NOT EXISTS "SyncIssue_incidentKey_idx" ON "SyncIssue"("incidentKey");
CREATE INDEX IF NOT EXISTS "SyncIssue_resolvedAt_idx"  ON "SyncIssue"("resolvedAt");

-- ── The concurrency guarantee ────────────────────────────────────────────────
--
-- ONE ACTIVE EPISODE PER IDENTITY, enforced by the database rather than by an
-- application read-then-write. Two concurrent failures on the same item raced
-- through find-or-create would otherwise both see "no active episode" and both
-- insert; this makes the loser fail loudly so it can retry into the winner's
-- episode and append its occurrence there.
--
-- PARTIAL, and both predicates matter: `resolved = false` is what lets a
-- resolved episode recur as a new generation instead of colliding forever, and
-- `incidentKey IS NOT NULL` exempts every legacy row (which has no identity and
-- must not be forced into one).
--
-- Written as raw SQL because Prisma cannot express a partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "SyncIssue_active_incident_key_uniq"
  ON "SyncIssue"("incidentKey")
  WHERE "resolved" = false AND "incidentKey" IS NOT NULL;
