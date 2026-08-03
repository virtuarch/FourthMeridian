-- V26-STAGE-1 — attributable, resumable historical execution stages.
--
-- Purely additive: seven nullable columns on the existing stage table. No
-- financial table is read or written, no execution history is deleted, and every
-- pre-existing row — including legacy HISTORY_BACKFILL stages — remains readable
-- with all seven reading NULL ("not recorded", never zero).
--
-- `status` and `endpoint` are already free-form TEXT, so the new
-- PROVIDER_LIMITED status and the five new stage names need no schema change;
-- they are guarded at write time by the canonical vocabulary in
-- lib/plaid/historical-stages.core.ts.
ALTER TABLE "RefreshEndpointResult" ADD COLUMN "attempt"       INTEGER;
ALTER TABLE "RefreshEndpointResult" ADD COLUMN "windowFromISO" TEXT;
ALTER TABLE "RefreshEndpointResult" ADD COLUMN "windowToISO"   TEXT;
ALTER TABLE "RefreshEndpointResult" ADD COLUMN "plannerMode"   TEXT;
ALTER TABLE "RefreshEndpointResult" ADD COLUMN "errorCode"     TEXT;
ALTER TABLE "RefreshEndpointResult" ADD COLUMN "retryable"     BOOLEAN;
ALTER TABLE "RefreshEndpointResult" ADD COLUMN "resultSummary" JSONB;
