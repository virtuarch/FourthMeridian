-- V26-CAP-1 — append-only record of provider-declared historical capability.
--
-- Purely additive: one new table, no column added to any existing table, no
-- financial row read or written. Existing installations begin with NO rows and
-- converge on their next capability check, which records a first-observation
-- baseline and schedules no work.
CREATE TABLE "ProviderCapabilityObservation" (
  "id"                    TEXT NOT NULL,
  "provider"              TEXT NOT NULL,
  "capabilityKey"         TEXT NOT NULL,
  "scope"                 TEXT NOT NULL,
  "kind"                  TEXT NOT NULL,
  "historyDays"           INTEGER,
  "earliestSupportedISO"  TEXT NOT NULL,
  "declarationSource"     TEXT NOT NULL,
  "comparison"            TEXT NOT NULL,
  "previousObservationId" TEXT,
  "widenedFromISO"        TEXT,
  "widenedToISO"          TEXT,
  "observedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderCapabilityObservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderCapabilityObservation_provider_capabilityKey_observedAt_idx"
  ON "ProviderCapabilityObservation"("provider", "capabilityKey", "observedAt");
