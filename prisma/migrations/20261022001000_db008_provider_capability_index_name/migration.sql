-- DB-008 — close the one migrations-vs-schema drift.
--
-- 20260803_v26_provider_capability_observation created
-- "ProviderCapabilityObservation_provider_capabilityKey_observedAt_idx" (67
-- characters); PostgreSQL truncates identifiers to 63, so the index exists as
-- "…_observedAt". Prisma names the same @@index with its own truncation,
-- "…_observ_idx", so `prisma migrate diff` (migrations → schema) has reported a
-- rename on every run. Renaming makes the drift audit's baseline empty.
--
-- Metadata-only (no rebuild, brief lock). IF EXISTS: an environment created by a
-- different path is left alone and the audit says so.
ALTER INDEX IF EXISTS "ProviderCapabilityObservation_provider_capabilityKey_observedAt"
  RENAME TO "ProviderCapabilityObservation_provider_capabilityKey_observ_idx";
