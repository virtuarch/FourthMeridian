-- BETA-REQUEST RISK (2026-10-31) — operator review verdicts on the advisory
-- risk signals of a beta-access request
-- (docs/plans/BETA-REQUEST-RISK-ASSESSMENT-2026-10-31.md §6.3).
--
-- ADDITIVE ONLY: one NEW enum, one NEW table, its index, FK, grants and RLS.
-- No existing table, row, column or policy is touched. The heuristic evidence
-- is NOT stored here — it is recomputed at read time from BetaAccessRequestEvent
-- and the BETA_ACCESS_REQUESTED audit rows; this table holds only what an
-- operator decided about it.
--
-- APPEND-ONLY: a verdict is changed by inserting a newer row (the latest row is
-- the current state).
--
-- CASCADE, BY DESIGN: the FK is ON DELETE CASCADE, so deleting a request erases
-- its review rows. Two paths delete requests today:
--   · the account-deletion purge (lib/account-deletion/purge.ts — by e-mail);
--   · the retention job (jobs/data-retention.ts — DENIED, PENDING and
--     unredeemed APPROVED requests untouched for 180 days; REDEEMED is kept).
-- The referential action runs as the table owner, so fm_system needs (and holds)
-- no DELETE here. Accountability is NOT lost: every verdict also wrote a
-- BETA_REQUEST_RISK_REVIEWED AuditLog row (request id only, no address), and
-- AuditLog is not purged with the request.
--
-- AUTHORITY (least privilege):
--   fm_system  SELECT, INSERT   (no UPDATE / DELETE — history is immutable)
--   fm_app     nothing          (operators only; the Growth routes read through fm_system)
--   fm_auth    nothing
--   fm_backup  SELECT           (complete dumps)

-- ── 1. Enum + table (prisma migrate diff of the schema change, verbatim) ─────
CREATE TYPE "BetaRiskReviewStatus" AS ENUM ('UNREVIEWED', 'LEGITIMATE', 'SUSPICIOUS');

CREATE TABLE "BetaAccessRequestReview" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" "BetaRiskReviewStatus" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "operatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetaAccessRequestReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BetaAccessRequestReview_requestId_createdAt_idx" ON "BetaAccessRequestReview"("requestId", "createdAt");

ALTER TABLE "BetaAccessRequestReview" ADD CONSTRAINT "BetaAccessRequestReview_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "BetaAccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. Grants + RLS — operators (fm_system) only ─────────────────────────────
REVOKE ALL ON TABLE public."BetaAccessRequestReview" FROM fm_app;
REVOKE ALL ON TABLE public."BetaAccessRequestReview" FROM fm_auth;
REVOKE ALL ON TABLE public."BetaAccessRequestReview" FROM fm_system;
GRANT SELECT ON TABLE public."BetaAccessRequestReview" TO fm_backup;
GRANT SELECT, INSERT ON TABLE public."BetaAccessRequestReview" TO fm_system;

ALTER TABLE public."BetaAccessRequestReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BetaAccessRequestReview" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."BetaAccessRequestReview" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- Belt and braces (as migration 20261002000100 §19): never reachable by the Data API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."BetaAccessRequestReview" FROM anon, authenticated, service_role';
  END IF;
END $$;
