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
  "platform-providers": {
    id: "platform-providers", kind: "standard", domain: "platform",
    label: "Providers", icon: "PlugZap",
  },
  "platform-operations": {
    id: "platform-operations", kind: "standard", domain: "platform",
    label: "Operations", icon: "Wrench",
  },
  "platform-alerts": {
    id: "platform-alerts", kind: "standard", domain: "platform",
    label: "Alerts", icon: "BellRing",
  },
  // OPS-5 Wave B — the operational INTELLIGENCE workspace: history (S7),
  // convergence (S9), and cost/latency (S10) are Workspace CONTENT here, not a new
  // dashboard. Still a standard Workspace (no fabricated Perspective); the
  // as-of/compare-to time model is the finance shell contract, mirrored.
  "platform-trends": {
    id: "platform-trends", kind: "standard", domain: "platform",
    label: "History", icon: "History",
  },
  // OPS-6D — the AI operations console (usage volume + trend + estimated cost).
  "platform-ai": {
    id: "platform-ai", kind: "standard", domain: "platform",
    label: "AI", icon: "Sparkles",
  },
  // OPS-6G — the unified cost console: operational cost (S10) + AI cost (6D).
  // Composition only — no second spend engine; each metric keeps its truth tier.
  "platform-costs": {
    id: "platform-costs", kind: "standard", domain: "platform",
    label: "Costs", icon: "Gauge",
  },
  // OPS-2C-2 — the Refresh workspace. It answers a question no existing
  // workspace does ("what did this refresh do, to which accounts, and did it
  // fail?") and carries a distinct action on failure, which is the standing bar
  // for a workspace existing. Deliberately NOT folded into Providers, which
  // already carries six sections and answers whether a provider is trustworthy.
  "platform-refresh": {
    id: "platform-refresh", kind: "standard", domain: "platform",
    label: "Refresh", icon: "RefreshCw",
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
export const PLATFORM_AREA_WORKSPACES: Record<PlatformArea, readonly PlatformWorkspaceComposition[]> = {
  PLATFORM_OPS: [
    {
      workspaceId: "platform-overview",
      // PM-1 — Overview reads as ONE operational question in three movements:
      // Scheduler (is the clock ticking?) → Jobs (did the work run?) → Platform
      // Health (is the platform, end to end, healthy?). The five formerly-separate
      // summary cards (alerts, provider health, resource freshness, rate limits,
      // environment) are CONSOLIDATED into ops_platform_health rather than deleted;
      // see PLATFORM_SECTION_REPRESENTATION for the keys it now stands in for. The
      // heavy detail (Manual Operations WRITE controls, connection + API-usage
      // breakdowns) continues to live in its own Workspace.
      sections: ["ops_scheduler", "ops_job_health", "ops_platform_health"],
      doorways: ["platform-jobs", "platform-refresh", "platform-providers", "platform-operations", "platform-alerts", "platform-trends", "platform-ai", "platform-costs"],
    },
    { workspaceId: "platform-jobs", sections: ["ops_scheduler", "ops_job_health"] },
    // OPS-2C-2 — Refresh: outcomes + the execution rows + per-account coverage.
    // Provider-operation attempt facts (route shipped in 2C-1) deliberately do
    // NOT live here — they are provider-shaped and land in Providers at 2C-5.
    { workspaceId: "platform-refresh", sections: ["ops_refresh_summary", "ops_refresh_executions", "ops_refresh_coverage"] },
    // OPS-2C-5 order: health interpretation → observed behaviour → connections →
    // consumption → freshness → delivery. Provider Operations sits directly under
    // Provider Health (the behaviour that supports the interpretation) and well
    // clear of API Usage, whose question is consumption over time.
    { workspaceId: "platform-providers", sections: ["ops_provider_health", "ops_provider_operations", "ops_connection_health", "ops_connection_diagnostics", "ops_api_usage", "ops_resource_freshness", "ops_email_delivery"] },
    { workspaceId: "platform-operations", sections: ["ops_manual_operations"] },
    { workspaceId: "platform-alerts", sections: ["ops_alerts"] },
    // OPS-5 Wave B intelligence layer (S7 → S9 → S10 add their sections here).
    { workspaceId: "platform-trends", sections: ["ops_history", "ops_convergence", "ops_timeline", "ops_cost"] },
    // OPS-6D AI operations — usage volume (existing) + usage trend (new).
    { workspaceId: "platform-ai", sections: ["ops_api_usage", "ops_ai_trend"] },
    // OPS-6G unified cost console — operational cost (S10) + AI cost (6D), each
    // carrying its own truth tier. Composition only, no second spend engine.
    { workspaceId: "platform-costs", sections: ["ops_cost", "ops_ai_trend"] },
  ],
  SECURITY_OPS: [
    { workspaceId: "platform-overview", sections: ["sec_auth_posture", "sec_operator_actions", "sec_audit_feed", "sec_sessions", "sec_anomalies"] },
  ],
  GROWTH_REVENUE: [
    { workspaceId: "platform-overview", sections: ["growth_signups", "growth_beta_requests", "growth_users", "growth_activity", "growth_funnel"] },
  ],
  CUSTOMER_SUCCESS: [
    { workspaceId: "platform-overview", sections: ["cs_sync_issues"] },
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
