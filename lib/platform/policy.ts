/**
 * lib/platform/policy.ts
 *
 * PO1.0 — the single, PURE home for platform-access authorization decisions.
 *
 * `hasPlatformAccess(area, needed, grants)` answers "does this grant set allow
 * `needed` on `area`?" — decided entirely from the grant rows, with no I/O, no
 * session, and no DB access. Mirrors `lib/spaces/policy.ts` (`can`) one-to-one:
 * a pure predicate the impure adapter (`lib/platform/authorize.ts`) wraps.
 *
 * AXIS BOUNDARY (07-07 risk #2 — kept structural): this module knows NOTHING
 * about SpaceMemberRole / SpaceMember / can() / requireSpaceRole. Platform
 * access is orthogonal to customer-Space membership; the two never mix. This is
 * tripwired in lib/platform-surface.test.ts.
 *
 * The SYSTEM_ADMIN break-glass bypass deliberately does NOT live here — it is
 * the adapter's concern, so this file stays a pure statement about grants only.
 */

import type {
  PlatformArea,
  PlatformAccessLevel,
  PlatformGrantStatus,
} from "@prisma/client";

// ── Area registry (display + seed metadata) ───────────────────────────────────

/**
 * Display + seed metadata per area — the single registry, in the
 * PlatformSettingKey-style const-registry house pattern. `spaceName` /
 * `spaceDescription` are what the bootstrap seed writes to Space; `sections`
 * are the SpaceDashboardSection rows it materializes (all placeholder widgets
 * in PO1.0 — real adapters land in PO1.1/PO1.2).
 */
export interface PlatformAreaMeta {
  key: PlatformArea;
  /** Human label, e.g. "Security Operations". */
  label: string;
  /** Space.name at seed. */
  spaceName: string;
  /** Space.description at seed. */
  spaceDescription: string;
  /** Section rows the seed materializes (key/label/order); placeholders in PO1.0. */
  sections: { key: string; label: string; order: number }[];
}

/**
 * Complete area → metadata map. Typed as `Record<PlatformArea, …>` so the
 * compiler REQUIRES every enum member to be present — a missing area is a type
 * error. This is the exhaustiveness guarantee mirrored from ACTION_POLICY.
 *
 * Section labels are deliberately HONEST about data readiness (investigation
 * §2.3/§2.4): Growth & Revenue and Customer Success have no purpose-built data
 * yet, so their single placeholder section says so rather than implying a
 * revenue/CS pipeline that does not exist.
 */
export const PLATFORM_AREAS: Record<PlatformArea, PlatformAreaMeta> = {
  PLATFORM_OPS: {
    key: "PLATFORM_OPS",
    label: "Platform Operations",
    spaceName: "Platform Operations",
    spaceDescription:
      "Job health, rate-limit posture, and environment status for Fourth Meridian itself.",
    sections: [
      { key: "ops_job_health",  label: "Job Health",      order: 0 },
      { key: "ops_rate_limits", label: "Rate Limits",     order: 1 },
      { key: "ops_env_status",  label: "Environment",     order: 2 },
      // Wave 2 S7 — API usage/cost visibility (Part A).
      { key: "ops_api_usage",        label: "API Usage",        order: 3 },
      // Wave 2 CH-1 — provider connection health (Part B).
      { key: "ops_connection_health", label: "Connection Health", order: 4 },
      // OPS-5 S1 — content-aware resource freshness (FX rates, security prices).
      { key: "ops_resource_freshness", label: "Resource Freshness", order: 5 },
      // OPS-5 S4 — manual operational controls (Run Now / Dry Run) over the
      // command registry. Backfilled onto the live Space by ensurePlatformSections.
      { key: "ops_manual_operations", label: "Manual Operations", order: 6 },
      // OPS-5 S3 — provider health: external providers as first-class operational
      // resources (freshness CONSUMED from OPS-5 S1). Backfilled by ensurePlatformSections.
      { key: "ops_provider_health", label: "Provider Health", order: 7 },
      // OPS-5 S5 — alert rules + history (consumes the job-health / connection-health
      // / resource-freshness authorities; emails on breach). Backfilled by ensurePlatformSections.
      { key: "ops_alerts", label: "Alerts", order: 8 },
      // OPS-5 Wave B — S7 Operational History (content of the History workspace).
      { key: "ops_history", label: "Operational History", order: 9 },
      // OPS-5 Wave B — S9 Off-ledger Convergence (the operational story).
      { key: "ops_convergence", label: "Convergence", order: 10 },
      // OPS-6E — the operational timeline (S9 flat event feed).
      { key: "ops_timeline", label: "Operational Timeline", order: 12 },
      // OPS-6D — AI usage trend over time (ApiUsageCounter projection).
      { key: "ops_ai_trend", label: "AI Usage Trend", order: 13 },
      // OPS-5 Wave B — S10 Cost & Latency Intelligence (derived over S7 + S9).
      { key: "ops_cost", label: "Cost & Latency", order: 11 },
    ],
  },
  SECURITY_OPS: {
    key: "SECURITY_OPS",
    label: "Security Operations",
    spaceName: "Security Operations",
    spaceDescription:
      "Audit feed, authentication posture, and session activity across the platform.",
    sections: [
      { key: "sec_audit_feed",   label: "Audit Feed",          order: 0 },
      { key: "sec_auth_posture", label: "Authentication Posture", order: 1 },
      { key: "sec_sessions",     label: "Sessions",            order: 2 },
      // Wave 3 ⑧ — real-time auth-anomaly trips (failed-login bursts, recovery
      // streaks, disabled-admin probes). Backfilled onto the live Space by
      // ensurePlatformSections.
      { key: "sec_anomalies",    label: "Anomalies",           order: 3 },
    ],
  },
  GROWTH_REVENUE: {
    key: "GROWTH_REVENUE",
    label: "Growth & Revenue",
    spaceName: "Growth & Revenue",
    spaceDescription:
      "Signup and activation signals. Revenue has no data source until billing (v3.0).",
    sections: [
      // Honest label: revenue has no data source until v3.0 billing (D10).
      { key: "growth_signups", label: "Signups & Activation", order: 0 },
      // Wave 1 S3 — beta-access request queue (approve → mint + email invite).
      { key: "growth_beta_requests", label: "Beta Access Requests", order: 1 },
      // OPS-6B Beta Operations — user search + operator deactivate/reactivate.
      { key: "growth_users", label: "Users", order: 2 },
      // OPS-6C User Activity — DAU/WAU/MAU + most-active Spaces (projection).
      { key: "growth_activity", label: "User Activity", order: 3 },
    ],
  },
  CUSTOMER_SUCCESS: {
    key: "CUSTOMER_SUCCESS",
    label: "Customer Success",
    spaceName: "Customer Success",
    spaceDescription:
      "Operational health signals. No purpose-built customer-success primitives exist yet.",
    sections: [
      // Honest label: no CS primitives exist yet — first real widget is sync-issue triage.
      { key: "cs_sync_issues", label: "Sync Issues", order: 0 },
    ],
  },
};

/** Every known area, derived from the registry (stays in sync with the enum). */
export const ALL_PLATFORM_AREAS = Object.keys(PLATFORM_AREAS) as PlatformArea[];

// ── Level rank ────────────────────────────────────────────────────────────────

/**
 * Canonical level precedence. WRITE implies READ — never compared for equality.
 * Mirrors ROLE_RANK (lib/spaces/policy.ts:90) / ROLE_ORDER (lib/session.ts:246).
 */
export const LEVEL_RANK: Record<PlatformAccessLevel, number> = {
  READ:  0,
  WRITE: 1,
};

// ── Grant context ─────────────────────────────────────────────────────────────

/** The minimal, pure input required to decide platform access from a grant. */
export interface PlatformGrantCtx {
  area:   PlatformArea;
  level:  PlatformAccessLevel;
  status: PlatformGrantStatus;
}

// ── Decision ──────────────────────────────────────────────────────────────────

/**
 * Pure decision: does this grant set allow `needed` on `area`?
 *
 *   1. Only ACTIVE grants count (REVOKED ⇒ denied — no residual access).
 *   2. Area must match exactly (no cross-area inheritance).
 *   3. LEVEL_RANK[grant.level] >= LEVEL_RANK[needed] (WRITE satisfies READ).
 *
 * Deterministic; same arguments always yield the same result. The SYSTEM_ADMIN
 * bypass is intentionally NOT here — it is the adapter's concern.
 */
export function hasPlatformAccess(
  area:   PlatformArea,
  needed: PlatformAccessLevel,
  grants: readonly PlatformGrantCtx[],
): boolean {
  return grants.some(
    (g) =>
      g.status === "ACTIVE" &&
      g.area === area &&
      LEVEL_RANK[g.level] >= LEVEL_RANK[needed],
  );
}

// ── Derived capability names (display / widget self-declaration only) ──────────

/**
 * 07-07-style capability names, derived from `area × level` rather than stored.
 * `SECURITY_OPS_VIEW ≡ (SECURITY_OPS, READ)`, `SECURITY_OPS_MANAGE ≡
 * (SECURITY_OPS, WRITE)`. For display / widget self-declaration only — never a
 * storage or gating primitive (the grant row + hasPlatformAccess are).
 */
export type PlatformCapability = `${PlatformArea}_${"VIEW" | "MANAGE"}`;
