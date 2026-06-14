-- Migration part 1 of 2: enum additions only.
-- PostgreSQL requires that ALTER TYPE ... ADD VALUE and CREATE TYPE
-- are committed in their own transaction before any table DDL or DML
-- can reference the new values. Part 2 (20260611000001) creates the
-- tables and runs the backfill.

-- ─────────────────────────────────────────────────────────────────────────────
-- New enum types
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "WorkspaceCategory" AS ENUM (
  'PERSONAL', 'HOUSEHOLD', 'FAMILY', 'BUSINESS',
  'PROPERTY', 'VEHICLE', 'TRIP', 'INVESTMENT',
  'EQUIPMENT', 'GOAL', 'OTHER'
);

CREATE TYPE "WorkspaceMemberStatus" AS ENUM ('ACTIVE', 'REMOVED', 'LEFT');

CREATE TYPE "ShareStatus" AS ENUM ('ACTIVE', 'REVOKED');

CREATE TYPE "DuplicateStatus" AS ENUM (
  'PENDING', 'CONFIRMED_DUPLICATE', 'NOT_DUPLICATE', 'IGNORED'
);

CREATE TYPE "AccountOwnerType" AS ENUM ('USER', 'WORKSPACE');

CREATE TYPE "GoalCategory" AS ENUM (
  'EMERGENCY_FUND', 'DEBT_PAYOFF', 'HOME_PURCHASE', 'VEHICLE_PURCHASE',
  'TRIP', 'BUSINESS', 'INVESTMENT', 'EQUIPMENT', 'EDUCATION', 'GENERAL'
);

CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- ─────────────────────────────────────────────────────────────────────────────
-- Extend VisibilityLevel with new values
-- ALTER TYPE ADD VALUE cannot be used in the same transaction that references
-- the new values — these must commit first.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE "VisibilityLevel" ADD VALUE IF NOT EXISTS 'BALANCE_ONLY';
ALTER TYPE "VisibilityLevel" ADD VALUE IF NOT EXISTS 'FULL';
