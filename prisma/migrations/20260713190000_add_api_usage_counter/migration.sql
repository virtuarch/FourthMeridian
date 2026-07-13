-- Wave 2 S7 — Platform Ops API usage counter. Purely additive: 1 table
-- (ApiUsageCounter) with its uniqueness constraint (provider, metric, unit, day)
-- and read index (provider, day). No existing row or column is changed; no
-- backfill. Scoped to this slice only — any unrelated drift `prisma migrate
-- diff` might also surface belongs to other concurrent slices and is
-- deliberately NOT included here (same convention as
-- 20260713150000_po1_0_platform_access / 20260713180000_add_beta_access_request).

-- CreateTable
CREATE TABLE "ApiUsageCounter" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "count" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ApiUsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiUsageCounter_provider_metric_unit_day_key" ON "ApiUsageCounter"("provider", "metric", "unit", "day");

-- CreateIndex
CREATE INDEX "ApiUsageCounter_provider_day_idx" ON "ApiUsageCounter"("provider", "day");
