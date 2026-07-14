-- Cosmetic index-name normalization (no data/structure change). The unique index
-- on PositionObservation(financialAccountId, instrumentId, date, origin, source)
-- was created by 20260711210000_investment_observation_foundation with a
-- hand-specified name of 64 chars, which Postgres silently truncated to 63
-- ("..._date_ori_ke"), diverging from the name Prisma now derives
-- ("..._date_or_key"). This realigns the physical name so `prisma migrate diff`
-- is clean. Same columns, same uniqueness — a pure rename. Surfaced (and
-- deliberately deferred) alongside the MerchantMergeDecision drift by
-- 20260713150000_po1_0_platform_access; resolved here in its own migration.

-- RenameIndex
ALTER INDEX "PositionObservation_financialAccountId_instrumentId_date_ori_ke" RENAME TO "PositionObservation_financialAccountId_instrumentId_date_or_key";
