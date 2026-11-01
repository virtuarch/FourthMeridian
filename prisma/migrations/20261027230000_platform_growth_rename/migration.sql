-- P-3 (owner ruling, 2026-10-27): the Growth & Revenue platform Space is
-- displayed as "Growth" until a billing / revenue data source exists.
--
-- DISPLAY NAME ONLY. Unchanged: the PlatformArea enum value GROWTH_REVENUE,
-- the Space id, its dashboard sections, every PlatformGrant, every route
-- (/api/platform/growth-revenue/*) and every audit row.
--
-- Narrow and idempotent: renames only the GROWTH_REVENUE platform Space, and
-- only while it still carries the original seeded name (a manually customised
-- name is left alone; re-running is a no-op).
--
-- REVERSIBLE — to roll back, run:
--   UPDATE "Space" SET "name" = 'Growth & Revenue'
--   WHERE "platformArea" = 'GROWTH_REVENUE' AND "name" = 'Growth';
--
-- Release note: data migrations are applied per environment with
-- `npm run db:migrate:safe`; nothing applies them at build time. Production
-- requires explicit owner release approval.

UPDATE "Space"
SET "name" = 'Growth'
WHERE "platformArea" = 'GROWTH_REVENUE'
  AND "name" = 'Growth & Revenue';
