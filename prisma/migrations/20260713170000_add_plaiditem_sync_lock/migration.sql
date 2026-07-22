-- Webhook concurrency guard — a nullable "a sync is currently running" marker on
-- PlaidItem. Set while a sync/deferred pipeline runs for the item and cleared
-- when it finishes; a conditional claim on this column serializes syncs so a
-- duplicated/racing SYNC_UPDATES_AVAILABLE webhook can't run two pipelines at
-- once. Additive + nullable — existing rows default to NULL ("not locked").
ALTER TABLE "PlaidItem" ADD COLUMN "syncLockedAt" TIMESTAMP(3);
