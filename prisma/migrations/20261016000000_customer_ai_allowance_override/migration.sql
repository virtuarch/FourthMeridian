-- AI COST CONTROLS (2026-10-15) — the per-customer daily AI allowance override.
-- Additive, no backfill, compatible with the running application: one nullable
-- integer column, no default, no index, no constraint, no data change. The
-- resolver reads NULL as "no override" (lib/entitlements/resolve.ts); the only
-- writer is lib/platform/customer/assign.ts (Customer Success, audited,
-- reason-required, refused above the catalogue ceiling).
ALTER TABLE "CustomerPolicyAssignment" ADD COLUMN "aiDailyUsdAllowanceOverride" INTEGER;
