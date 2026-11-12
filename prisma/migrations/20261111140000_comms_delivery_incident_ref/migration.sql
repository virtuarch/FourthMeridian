-- INCIDENT CUSTOMER UPDATE (owner yes; S2 ruling 09gg (c), migration terms 09gh).
--
-- ADDITIVE ONLY: one NULLABLE column on "CommsDelivery". No default, no
-- backfill, no index, no foreign key, no grant / policy / RLS change, no DML.
--
-- "incidentId" is a SOFT reference to the Platform Ops incident (SyncIssue.id)
-- an operator-approved customer update belongs to. It is written only by the
-- INCIDENT_CUSTOMER_UPDATE send (createNotification ledger tag) and is never
-- rendered to a customer. NO FK (09gh preferred): an incident is archived and
-- pruned on its own clock, and a delivery-ledger row (90-day retention) must
-- neither block nor cascade with it.
--
-- NO INDEX (09gh): a plain CREATE INDEX blocks writes on this write-hot table,
-- and CONCURRENTLY cannot run inside Prisma's migration transaction. The one
-- reader (the deliveries of one incident) is bounded FIRST by the existing
-- "CommsDelivery_recipientUserId_createdAt_idx" (the incident's own subject and
-- time window), then filtered on "incidentId".
--
-- GRANTS: CommsDelivery's grants are TABLE-level only (fm_system SELECT, INSERT,
-- DELETE; fm_backup SELECT — 20261031200000_comms_delivery_ledger §2) and its one
-- policy (fm_system_all, FOR ALL USING (true)) lists no columns, so the new
-- column needs no grant and no policy change. fm_app / fm_auth still have nothing.
--
-- LOCK: ADD COLUMN (nullable, no default) is catalog-only, but it takes a brief
-- ACCESS EXCLUSIVE lock on a write-hot table — bounded by lock_timeout.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "CommsDelivery" ADD COLUMN "incidentId" TEXT NULL;
