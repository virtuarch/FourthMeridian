-- Migration part 1 of 2: enum additions only (Milestone 3).
-- PostgreSQL requires ALTER TYPE ADD VALUE to commit before any DDL references
-- the new values. Part 2 (20260611000003) creates WorkspaceDashboardSection.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extend WorkspaceCategory with new template values
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE "WorkspaceCategory" ADD VALUE IF NOT EXISTS 'RETIREMENT';
ALTER TYPE "WorkspaceCategory" ADD VALUE IF NOT EXISTS 'DEBT_PAYOFF';
ALTER TYPE "WorkspaceCategory" ADD VALUE IF NOT EXISTS 'EMERGENCY_FUND';
ALTER TYPE "WorkspaceCategory" ADD VALUE IF NOT EXISTS 'CUSTOM';

-- ─────────────────────────────────────────────────────────────────────────────
-- New enum: WorkspaceDashboardTab
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "WorkspaceDashboardTab" AS ENUM (
  'OVERVIEW',
  'GOALS',
  'ACCOUNTS',
  'DEBT',
  'INVESTMENTS',
  'RETIREMENT',
  'ACTIVITY',
  'SETTINGS'
);
