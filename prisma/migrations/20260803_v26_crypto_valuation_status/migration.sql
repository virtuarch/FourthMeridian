-- V26-CRYPTO-STATUS-1 — authorize the persisted crypto component.
--
-- Additive only: one nullable column, no default, no backfill. Every existing
-- row reads NULL, which resolves to `legacy-unrecorded` when the row carries
-- material crypto and to `none` when it does not. No financial scalar is
-- touched, and no row is rewritten by this migration.
ALTER TABLE "SpaceSnapshot" ADD COLUMN "cryptoValuationStatus" TEXT;
