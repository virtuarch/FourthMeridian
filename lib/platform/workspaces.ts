/**
 * lib/platform/workspaces.ts  (OPS-5 S6 — Platform Workspace Decomposition)
 *
 * TWO things, both Platform-domain-owned:
 *
 *   1. PLATFORM_WORKSPACES — the IDENTITY of every Platform primary destination,
 *      as UNIVERSAL `WorkspaceDefinition`s (the same type customer Spaces use).
 *      They are unioned into the ONE universal `WORKSPACE_REGISTRY`
 *      (lib/perspectives.ts) so Platform reuses the universal Workspace identity
 *      authority — NOT a parallel identity system (SD-2/SD-3 "second real
 *      consumer" convergence). Each is `domain: "platform"` and declares NONE of
 *      the finance-scoped metadata (routing/dataNeeds/consumesShellTime/envelope):
 *      Platform widgets SELF-FETCH (OPS-5 S6 dataNeeds decision A), carry no
 *      finance envelope, and navigate via the platform rail — never the finance
 *      modal tabs. The guard in workspaces.test.ts pins "no finance vocabulary on
 *      a Platform definition".
 *
 *   2. PLATFORM_AREA_WORKSPACES — THE single composition owner. It answers, from
 *      one place, "which Workspaces does each Platform area expose, in what order,
 *      and which section-widgets does each render?" This replaces "everything
 *      lands in one Overview grid": Platform Operations now decomposes into
 *      Overview (summary + doorways) · Jobs · Providers · Operations · Alerts,
 *      each a real Workspace rendered in the shared SpaceShell workspace slot.
 *      The other areas (Security/Growth/Customer-Success) keep a single Overview
 *      workspace (behavior-preserving) — decomposition is demand-pulled per area.
 *
 * COMPOSITION vs IDENTITY: identity (label/icon/kind) lives in PLATFORM_WORKSPACES
 * (and thus the universal registry); composition (order + which section keys each
 * workspace renders) lives in PLATFORM_AREA_WORKSPACES. The render surface
 * (PlatformSpaceDashboard) resolves label/icon from the registry and order/sections
 * from here — no duplicated identity.
 *
 * Client-safe config (no server/engine imports), like lib/perspectives.ts — it is
 * imported by that module to build the universal registry, so it must stay
 * runtime-free of it (the only coupling back is the type-only import below).
 */

import type { PlatformArea } from "@prisma/client";
// Type-only (erased at compile time) — no runtime dependency on lib/perspectives,
// so the value-import the registry does the other way introduces no runtime cycle.
import type { WorkspaceDefinition } from "@/lib/perspectives";

// ── Identity: Platform workspaces as universal WorkspaceDefinitions ──────────────

/** Platform workspace ids are "platform-*"-namespaced so they never collide with a
 *  finance workspace id in the shared WORKSPACE_REGISTRY. */
export const PLATFORM_WORKSPACES: Record<string, WorkspaceDefinition> = {
  "platform-overview": {
    id: "platform-overview", kind: "standard", domain: "platform",
    label: "Overview", icon: "LayoutDashboard",
  },
  "platform-jobs": {
    id: "platform-jobs", kind: "standard", domain: "platform",
    label: "Jobs", icon: "Timer",
  },
  // Customer Success (redesign §4.3) — the open sync incidents get their own
  // workspace beside the customer list: "which incidents are open, recurring,
  // slow to resolve?" is a different question from "which customers need help?".
  "platform-incidents": {
    id: "platform-incidents", kind: "standard", domain: "platform",
    label: "Incidents", icon: "TriangleAlert",
  },
  // Security Operations (redesign §4.9) — the end-user security feed and the
  // operator-action feed each get a workspace beside Posture.
  "platform-audit": {
    id: "platform-audit", kind: "standard", domain: "platform",
    label: "Audit", icon: "ScrollText",
  },
  "platform-operator-actions": {
    id: "platform-operator-actions", kind: "standard", domain: "platform",
    label: "Operator actions", icon: "UserCog",
  },
  "platform-providers": {
    id: "platform-providers", kind: "standard", domain: "platform",
    label: "Providers", icon: "PlugZap",
  },
  // OPS-6D — the AI operations console (usage volume + trend + estimated cost).
  "platform-ai": {
    id: "platform-ai", kind: "standard", domain: "platform",
    // P-10 (owner-approved "AI & costs", 2026-10-27; spelled "and" so the label never needs HTML escaping) — AI usage AND the economics console in
    // one workspace (the former "Economics" tab, platform-costs, merged here).
    label: "AI and costs", icon: "Sparkles",
  },
  // OPS-2C-2 — the Refresh workspace. It answers a question no existing
  // workspace does ("what did this refresh do, to which accounts, and did it
  // fail?") and carries a distinct action on failure, which is the standing bar
  // for a workspace existing. Deliberately NOT folded into Providers, which
  // already carries six sections and answers whether a provider is trustworthy.
  "platform-refresh": {
    id: "platform-refresh", kind: "standard", domain: "platform",
    label: "Pipeline", icon: "RefreshCw",
  },
  // PLATFORM OPS POLICIES (Slice 1) — the Policies workspace: declared operational
  // policy beside what the deployment can honour and what actually executed. It
  // answers a question no other workspace does ("what is the platform SUPPOSED
  // to do, and can it?"); Jobs answers whether work ran, Refresh what it did.
  "platform-policies": {
    id: "platform-policies", kind: "standard", domain: "platform",
    // P-10 — "what is configured, what is in force, who changed it".
    label: "Controls", icon: "SlidersHorizontal",
  },
};

// ── Composition: which workspaces each area exposes, and their section-widgets ───

/** One Workspace's place in an area: its identity id (→ PLATFORM_WORKSPACES) plus
 *  the ordered SpaceDashboardSection keys it renders. Overview additionally offers
 *  `doorways` — rail ids it links to (the summary→detail navigation). */
export interface PlatformWorkspaceComposition {
  /** Key into PLATFORM_WORKSPACES / WORKSPACE_REGISTRY. */
  workspaceId: string;
  /** Ordered section keys this workspace renders (widgets from the platform-local
   *  widget registry; gated by the enabled DB SpaceDashboardSection rows). */
  sections: readonly string[];
  /** Overview-only: rail workspace ids this workspace links to as doorways. */
  doorways?: readonly string[];
}

/**
 * THE single composition owner. Only PLATFORM_OPS is decomposed in Wave A; the
 * other areas expose one Overview workspace that renders all their sections (the
 * pre-S6 single grid, behavior-preserving) so the shared render path is uniform.
 */
/**
 * P-10 (owner-approved, 2026-10-27) — Platform Operations goes from eight
 * workspaces to six WITHOUT removing a capability: every section key composed
 * before is still composed (pinned by workspaces.test.ts). History dissolved
 * into its owners (convergence + timeline → Overview, the history series →
 * Jobs); Economics merged into "AI & costs" (so ops_ai_trend renders once);
 * connection health renders once, in Pipeline.
 *
 * Retired workspace ids still resolve: PLATFORM_WORKSPACE_ALIASES maps them to
 * their new home, so existing `?workspace=` deep links keep working.
 */
export const PLATFORM_WORKSPACE_ALIASES: Readonly<Record<string, string>> = {
  "platform-trends": "platform-overview",
  "platform-costs":  "platform-ai",
};

/** A requested workspace id, with retired ids mapped to their new home. */
export function canonicalPlatformWorkspaceId(id: string | null | undefined): string | null | undefined {
  return id && PLATFORM_WORKSPACE_ALIASES[id] ? PLATFORM_WORKSPACE_ALIASES[id] : id;
}

export const PLATFORM_AREA_WORKSPACES: Record<PlatformArea, readonly PlatformWorkspaceComposition[]> = {
  PLATFORM_OPS: [
    {
      workspaceId: "platform-overview",
      // PLATFORM OPS OBSERVABILITY — Overview is the COCKPIT: one verdict per
      // operational domain (refresh pipeline, sources, jobs, Daily Brief, AI,
      // Plaid) from ops_overview, then the consolidated Platform Health surface
      // (alerts, provider health, resource freshness, rate limits, environment —
      // see PLATFORM_SECTION_REPRESENTATION). Every domain has a doorway into
      // the workspace that holds its detail, so "something is wrong" is two
      // clicks from "this exact execution failed".
      // P-10 — the incident timeline (convergence) and the event timeline
      // answer "what changed, and why?" for the cockpit, so they live here.
      sections: ["ops_overview", "ops_platform_health", "ops_convergence", "ops_timeline"],
      doorways: ["platform-jobs", "platform-refresh", "platform-providers", "platform-ai", "platform-policies"],
    },
    // Jobs — the scheduler observation, the per-job health table, and the
    // manual Run Now / Dry Run controls (formerly their own Operations workspace:
    // "are scheduled jobs working? are manual runs working?" is one question).
    // P-10 — the operational history series (job runtime per run, manual runs,
    // alert firings) is job history, so it closes the Jobs workspace.
    { workspaceId: "platform-jobs", sections: ["ops_scheduler", "ops_job_health", "ops_manual_operations", "ops_history"] },
    // Pipeline — the execution ROWS first (every source kind, filterable, each
    // opening its inspection), then outcomes, the operator's source health,
    // and per-account coverage.
    { workspaceId: "platform-refresh", sections: ["ops_refresh_executions", "ops_refresh_summary", "ops_connection_health", "ops_refresh_coverage"] },
    // Providers — health interpretation → observed behaviour → per-connection
    // diagnostics → consumption → freshness → delivery.
    // `ops_provider_cleanup` sits right after per-connection diagnostics: an
    // operator reading connection state should meet "and these removals were
    // never confirmed upstream" in the same breath, since those items are
    // REVOKED and appear in none of the health surfaces above.
    // P-10 — connection health renders once, in Pipeline (above).
    { workspaceId: "platform-providers", sections: ["ops_provider_health", "ops_provider_operations", "ops_connection_diagnostics", "ops_provider_cleanup", "ops_api_usage", "ops_resource_freshness", "ops_email_delivery"] },
    // AI & costs (P-10) — usage first (invocations + the day-grain trend, once),
    // then spend against controls, provider economics, operational cost, and
    // Daily Brief operations. Composition only — no second spend engine.
    { workspaceId: "platform-ai", sections: ["ops_ai_invocations", "ops_ai_trend", "ops_ai_budget", "ops_plaid_usage", "ops_cost", "ops_brief_ops"] },
    // Controls (P-10; formerly "Policies") — the financial refresh policy (with
    // its CONTROL editor) and the alert rules, which are declared policy too.
    { workspaceId: "platform-policies", sections: ["ops_policies", "ops_alerts"] },
  ],
  SECURITY_OPS: [
    // BETA V2 — one "Security posture" surface (hosted by the first composed key,
    // sec_auth_posture; SecurityPostureWidget) absorbs the four former card-grain
    // widgets, which stay registered and are REPRESENTED by the host below.
    { workspaceId: "platform-overview", sections: ["sec_auth_posture"] },
    // Redesign §4.9 — Audit and Operator actions as their own workspaces.
    { workspaceId: "platform-audit", sections: ["sec_audit_feed"] },
    { workspaceId: "platform-operator-actions", sections: ["sec_operator_actions"] },
  ],
  GROWTH_REVENUE: [
    { workspaceId: "platform-overview", sections: ["growth_signups", "growth_product_analytics", "growth_beta_requests", "growth_users", "growth_activity", "growth_funnel", "growth_policy_groups"] },
  ],
  // Redesign §4.3 — Customers (the list + audited profile) and Incidents.
  CUSTOMER_SUCCESS: [
    { workspaceId: "platform-overview", sections: ["cs_customers"] },
    { workspaceId: "platform-incidents", sections: ["cs_sync_issues"] },
  ],
  MERCHANT_OPS: [
    { workspaceId: "platform-overview", sections: ["merchant_review"] },
  ],
};

// ── Consolidation: which sections a CONSOLIDATING section stands in for ─────────

/**
 * Declared CONSOLIDATION, owned by the same module that owns composition.
 *
 * A section key normally earns its place on a surface by appearing in some
 * workspace's `sections`. When a new surface ABSORBS an older one — same
 * operational question, one widget instead of five — the absorbed key stops
 * being composed anywhere. Without a record of that intent the key is
 * indistinguishable from one that was dropped by accident, which is exactly how
 * an operational surface goes silently missing.
 *
 * So absorption is DECLARED here: `absorbedKey → absorbingKey`. The absorbing
 * section must itself be a declared, reachable section (the reachability guard
 * in workspaces.test.ts walks this transitively), so consolidating into a
 * surface that is later removed from every workspace FAILS rather than quietly
 * hiding both.
 *
 * This is not a second composition truth: it grants no placement and renders
 * nothing. It records that the operator can still SEE the absorbed question,
 * inside the absorbing widget.
 *
 * PM-1 — the Platform Health surface answers "is the platform healthy?" across
 * alerts, provider health and resource freshness, and carries a Configuration
 * group covering rate-limit posture and environment status. Those five keys keep
 * their DB rows and their widgets (still composed by Alerts / Providers where
 * they carry a detail question of their own); only their OVERVIEW summary card
 * is what ops_platform_health replaces.
 */
export const PLATFORM_SECTION_REPRESENTATION: Readonly<Record<string, string>> = {
  ops_alerts:             "ops_platform_health",
  ops_provider_health:    "ops_platform_health",
  ops_resource_freshness: "ops_platform_health",
  ops_rate_limits:        "ops_platform_health",
  ops_env_status:         "ops_platform_health",
  // BETA V2 — absorbed by the Security posture surface (components/platform/widgets/SecurityPostureWidget.tsx).
  sec_sessions:           "sec_auth_posture",
  sec_anomalies:          "sec_auth_posture",
};

// ── Accessors ───────────────────────────────────────────────────────────────────

/**
 * Every section key an operator of `area` can actually REACH: the union of all
 * keys composed into any of the area's workspaces, plus every key transitively
 * ABSORBED by one of those (PLATFORM_SECTION_REPRESENTATION).
 *
 * Absorption is followed transitively with a visited set, so a chain
 * (a → b → composed-b) resolves and a cycle (a → b → a) terminates and is simply
 * unreachable — a cycle grants nothing, which is the correct fail-safe.
 */
export function reachableSectionKeys(area: PlatformArea): ReadonlySet<string> {
  const composed = new Set<string>();
  for (const w of PLATFORM_AREA_WORKSPACES[area]) for (const k of w.sections) composed.add(k);

  const reachable = new Set(composed);
  for (const absorbed of Object.keys(PLATFORM_SECTION_REPRESENTATION)) {
    const seen = new Set<string>([absorbed]);
    let cursor: string | undefined = PLATFORM_SECTION_REPRESENTATION[absorbed];
    while (cursor && !seen.has(cursor)) {
      if (composed.has(cursor)) { reachable.add(absorbed); break; }
      seen.add(cursor);
      cursor = PLATFORM_SECTION_REPRESENTATION[cursor];
    }
  }
  return reachable;
}

/** The ordered workspace composition an area exposes (never empty for a known area). */
export function getPlatformAreaWorkspaces(area: PlatformArea): readonly PlatformWorkspaceComposition[] {
  return PLATFORM_AREA_WORKSPACES[area];
}

/** A Platform workspace identity by id, or undefined (fails safe). */
export function getPlatformWorkspace(id: string): WorkspaceDefinition | undefined {
  return PLATFORM_WORKSPACES[id];
}

/** True for a Platform-domain workspace id (the "platform-*" namespace). */
export function isPlatformWorkspaceId(id: string): boolean {
  return id in PLATFORM_WORKSPACES;
}
