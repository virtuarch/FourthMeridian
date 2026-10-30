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
 *      lands in one Overview grid": Platform Operations decomposes into four
 *      workspaces (Operations · Providers · AI & Costs · Policies), each with named VIEWS,
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
    // P-10 — AI usage AND the economics console in one workspace (the former
    // "Economics" tab, platform-costs, merged here). PLATFORM OPS PHASE 1 UX —
    // relabelled "AI & Costs" (owner brief); its two VIEWS split usage from spend.
    label: "AI & Costs", icon: "Sparkles",
  },
  // PLATFORM OPS PHASE 1 UX — "platform-jobs" and "platform-refresh" are no
  // longer workspace identities: Jobs and Pipeline are VIEWS of Operations
  // (platform-overview), and the retired ids resolve there through
  // PLATFORM_WORKSPACE_ALIASES (view-carrying), so old deep links still land.
  // PLATFORM OPS POLICIES (Slice 1) — the Policies workspace: declared operational
  // policy beside what the deployment can honour and what actually executed. It
  // answers a question no other workspace does ("what is the platform SUPPOSED
  // to do, and can it?"); Jobs answers whether work ran, Refresh what it did.
  "platform-policies": {
    id: "platform-policies", kind: "standard", domain: "platform",
    // P-10 — "what is configured, what is in force, who changed it".
    // PLATFORM OPS PHASE 1 UX — relabelled "Policies" (owner brief): policy
    // groups, platform defaults, alerts and emergency controls are its views.
    label: "Policies", icon: "SlidersHorizontal",
  },
};

// ── Composition: which workspaces each area exposes, and their section-widgets ───

/** The variants a composed section may render in (PLATFORM OPS PHASE 1 UX). Only
 *  `ops_policies` takes one today: its widget renders a slice of itself per view
 *  (components/platform/widgets/OpsPoliciesWidget.tsx `variant`). Absent ⇒ the
 *  widget's full, unchanged render. */
export type PlatformSectionVariant = "groups" | "defaults" | "emergency";

/** One entry of a view: a bare section key, or a key rendered in a variant. */
export type PlatformViewSection = string | { readonly key: string; readonly variant: PlatformSectionVariant };

/** A named VIEW of a workspace (PLATFORM OPS PHASE 1 UX) — the second navigation
 *  axis beneath the workspace (`?view=<id>`; the first view is the default and
 *  writes no param). A view is composition only: it selects which of the
 *  workspace's sections render, never a section of its own (no new DB keys). */
export interface PlatformWorkspaceView {
  /** URL-stable id, unique within its workspace. */
  readonly id: string;
  /** The segmented-control label. */
  readonly label: string;
  /** Optional lucide icon NAME for a doorway that opens this view directly. */
  readonly icon?: string;
  /** Ordered entries this view renders INLINE (below its lead, when it has one). */
  readonly sections: readonly PlatformViewSection[];
  /** PLATFORM OPS 2.0 (R2) — the view's summary-first LEAD: a presentation
   *  component (components/platform/PlatformSpaceDashboard.tsx PLATFORM_VIEW_LEADS)
   *  rendered above `sections`. It reads existing READ routes only and computes
   *  no authority; it is where the 3–5-item summary of the view lives. */
  readonly lead?: PlatformViewLead;
  /** PLATFORM OPS 2.0 (R2) — section keys this view reaches ONLY through its
   *  lead's drawers / detail panes (never inline). Each still renders through the
   *  platform widget registry, gated by its enabled DB row, with the operator's
   *  access — so a hosted widget keeps its exact behaviour and gating. Counted in
   *  the workspace's `sections` union, so reachability and parity guards read
   *  hosted keys as composed (pinned in workspaces.test.ts). */
  readonly hosted?: readonly string[];
}

/** The summary-first leads a view may declare (Platform Ops 2.0 plan §4.2–§4.3). */
export type PlatformViewLead = "operations" | "pipeline" | "providers" | "ai-costs";

/** One Workspace's place in an area: its identity id (→ PLATFORM_WORKSPACES) plus
 *  the ordered SpaceDashboardSection keys it renders. Overview additionally offers
 *  `doorways` — rail ids it links to (the summary→detail navigation). */
export interface PlatformWorkspaceComposition {
  /** Key into PLATFORM_WORKSPACES / WORKSPACE_REGISTRY. */
  workspaceId: string;
  /** Area-local label override. The identity label is shared by every area that
   *  composes the workspace (all five areas open on "platform-overview" =
   *  "Overview"); an area that names its first workspace differently says so
   *  here instead of forking the identity. Absent ⇒ the identity label. */
  label?: string;
  /** Ordered section keys this workspace renders (widgets from the platform-local
   *  widget registry; gated by the enabled DB SpaceDashboardSection rows). With
   *  `views`, this is the ordered UNION of the views' keys (each key once) — the
   *  reachability / parity guards keep reading one list (pinned in
   *  workspaces.test.ts). */
  sections: readonly string[];
  /** Optional named views; only the active view's sections render. */
  views?: readonly PlatformWorkspaceView[];
  /** Overview-only: destination ids (workspace ids, view targets, or aliases —
   *  see resolvePlatformDestination) this workspace links to as doorways. */
  doorways?: readonly string[];
  /** How the workspace's views are navigated (spec §1: ONE row of tabs before
   *  content). "segmented" (default) renders the view control as a row; a
   *  "drilldown" workspace reaches its non-default views from its own cards and
   *  shows only a compact "back" link on them — never a second tab row. */
  viewControl?: "segmented" | "drilldown";
}

/** The section key of a view entry. */
export function viewSectionKey(entry: PlatformViewSection): string {
  return typeof entry === "string" ? entry : entry.key;
}

/** Every section key a view composes: its inline sections, then its hosted keys. */
export function viewComposedKeys(view: PlatformWorkspaceView): readonly string[] {
  return [...view.sections.map(viewSectionKey), ...(view.hosted ?? [])];
}

/** The ordered union of section keys a list of views composes (first occurrence wins). */
function unionOfViews(views: readonly PlatformWorkspaceView[]): readonly string[] {
  const out: string[] = [];
  for (const v of views) for (const k of viewComposedKeys(v)) if (!out.includes(k)) out.push(k);
  return out;
}

/** A workspace composed of views: `sections` is DERIVED from them, so the union
 *  can never drift from what the views actually render. */
function withViews(c: Omit<PlatformWorkspaceComposition, "sections"> & { views: readonly PlatformWorkspaceView[] }): PlatformWorkspaceComposition {
  return { ...c, sections: unionOfViews(c.views) };
}

/** A destination id that opens `workspaceId` on `viewId` (doorways, block links). */
const VIEW_TARGET_SEPARATOR = ":";
export function platformViewTarget(workspaceId: string, viewId: string): string {
  return `${workspaceId}${VIEW_TARGET_SEPARATOR}${viewId}`;
}

/**
 * P-10 (owner-approved, 2026-10-27) — Platform Operations went from eight
 * workspaces to six WITHOUT removing a capability. PLATFORM OPS PHASE 1 UX goes
 * from six to FOUR the same way — Jobs and Pipeline become VIEWS of Operations —
 * so every section key composed before is still composed (pinned by
 * workspaces.test.ts).
 *
 * Retired workspace ids still resolve: PLATFORM_WORKSPACE_ALIASES maps them to
 * their new home — a workspace and, where the retired workspace became a view,
 * that VIEW — so existing `?workspace=` deep links and every payload that still
 * names a retired id (attention/overview/activity read models) land on the same
 * content they always did.
 */
export const PLATFORM_WORKSPACE_ALIASES: Readonly<Record<string, { readonly workspaceId: string; readonly viewId?: string }>> = {
  "platform-trends":  { workspaceId: "platform-overview" },
  // PLATFORM OPS VISUAL SPEC §5 — AI & Costs is ONE analytical dashboard; the
  // former "costs" view (Plaid usage + operational cost) is in its drawers, so
  // the retired economics id lands on that dashboard.
  "platform-costs":   { workspaceId: "platform-ai" },
  "platform-jobs":    { workspaceId: "platform-overview", viewId: "jobs" },
  "platform-refresh": { workspaceId: "platform-overview", viewId: "pipeline" },
};

/** A requested workspace id, with retired ids mapped to their new home workspace. */
export function canonicalPlatformWorkspaceId(id: string | null | undefined): string | null | undefined {
  return id && PLATFORM_WORKSPACE_ALIASES[id] ? PLATFORM_WORKSPACE_ALIASES[id].workspaceId : id;
}

/** The view a retired (aliased) workspace id carries, or null. */
export function aliasedPlatformViewId(id: string | null | undefined): string | null {
  return (id && PLATFORM_WORKSPACE_ALIASES[id]?.viewId) || null;
}

export const PLATFORM_AREA_WORKSPACES: Record<PlatformArea, readonly PlatformWorkspaceComposition[]> = {
  PLATFORM_OPS: [
    // ── Operations — "is the platform working, and is the work running?" ──────
    // PLATFORM OPS VISUAL SPEC (2026-10-30, after the owner rejected R1/R2) — the
    // default view is ONE analytical dashboard in the Personal Space language
    // (components/platform/leads/OperationsLead.tsx): health hero · execution
    // trend · outcome composition · needs attention (grouped by cause) · refresh
    // activity · the UNIFIED Jobs list · recent activity. Its drawers keep every
    // former widget reachable:
    //   ops_overview          status board, the full attention list (with its
    //                         resync / reauth actions) and the activity blocks
    //   ops_platform_health   "Platform health" drawer
    //   ops_convergence +
    //   ops_timeline          "Incidents" drawer
    //   ops_job_health        the unified Jobs card (5 rows, worst first) — its
    //                         rows carry Dry run / Run now for every job the
    //                         operations registry can run (fleet runs: Control
    //                         access + reason + confirmation), so Manual operations
    //                         is no longer a section of its own (absorbed below)
    // Jobs is the drill-down: every job, searchable, then the scheduler
    // observation and the history series. Pipeline is unchanged. Operations
    // reaches its drill-downs from the dashboard's cards ("See all", "Pipeline"),
    // so its views are never a second row of tabs (viewControl "drilldown").
    withViews({
      workspaceId: "platform-overview",
      label: "Operations",
      viewControl: "drilldown",
      views: [
        { id: "overview", label: "Overview", lead: "operations", sections: [],
          hosted: ["ops_overview", "ops_platform_health", "ops_convergence", "ops_timeline", "ops_job_health"] },
        { id: "jobs", label: "Jobs", icon: "Timer", sections: ["ops_job_health", "ops_scheduler", "ops_history"] },
        { id: "pipeline", label: "Pipeline", icon: "RefreshCw", lead: "pipeline", sections: ["ops_refresh_executions"],
          hosted: ["ops_refresh_summary", "ops_connection_health", "ops_refresh_coverage"] },
      ],
    }),
    // ── Providers — "is each provider trustworthy, and what does it cost us?" ──
    // PLATFORM OPS VISUAL SPEC §5 — ONE analytical dashboard in the accepted
    // Operations grammar (components/platform/leads/ProvidersLead.tsx):
    // integration-health hero · sync activity · health distribution · provider
    // tiles (status · usage vs a KNOWN cap — none is exposed, so "cap unknown" ·
    // failures 7 d · spend with provenance). A tile opens the provider drawer,
    // which HOSTS the technical widgets unchanged (provider operations / health,
    // resource freshness, usage ledger, email delivery; connection diagnostics +
    // its history recovery and provider cleanup for Plaid / wallet networks); the
    // fleet-wide ones are also one drawer each. The single view keeps the id
    // "health" so every existing deep link (?view=health) and the canonical
    // default URL stay byte-identical; retired view ids fall back to it.
    withViews({
      workspaceId: "platform-providers",
      views: [
        { id: "health", label: "Providers", lead: "providers", sections: [],
          hosted: ["ops_provider_health", "ops_provider_operations", "ops_resource_freshness", "ops_connection_diagnostics", "ops_provider_cleanup", "ops_api_usage", "ops_email_delivery"] },
      ],
    }),
    // ── AI & Costs (P-10) — PLATFORM OPS VISUAL SPEC §5: ONE analytical
    // dashboard (components/platform/leads/AiCostsLead.tsx): estimated-spend
    // hero (billed = Unknown) · daily spend · cost by surface · tokens &
    // invocations · cost by provider · budget utilisation · customers · the
    // Economics (Phase 3) slot. The former AI and Costs views' widgets are
    // HOSTED unchanged in its drawers (Invocations · Daily Brief · Usage ledger
    // · Budget & controls · Plaid & operational cost), so the second tab row is
    // gone; the retired "costs" view id falls back to this one (and the
    // platform-costs alias lands here). Composition only — no second spend engine.
    withViews({
      workspaceId: "platform-ai",
      views: [
        { id: "ai", label: "AI & Costs", lead: "ai-costs", sections: [],
          hosted: ["ops_ai_invocations", "ops_ai_trend", "ops_ai_budget", "ops_brief_ops", "ops_plaid_usage", "ops_cost"] },
      ],
    }),
    // ── Policies (formerly "Controls") — declared policy. ONE section,
    // ops_policies, renders a different slice per view (its `variant`), plus
    // the alert rules. No new section key: views are composition only.
    withViews({
      workspaceId: "platform-policies",
      views: [
        { id: "groups", label: "Policy groups", sections: [{ key: "ops_policies", variant: "groups" }] },
        { id: "defaults", label: "Platform defaults", sections: [{ key: "ops_policies", variant: "defaults" }] },
        { id: "alerts", label: "Alerts", sections: ["ops_alerts"] },
        { id: "emergency", label: "Emergency controls", sections: [{ key: "ops_policies", variant: "emergency" }] },
      ],
    }),
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
  // PLATFORM OPS VISUAL SPEC §3 — the unified Jobs experience: every manual
  // operation (Dry run / Run now, fleet runs behind Control access + reason +
  // confirmation through the same POST /platform-ops/operations) is on its job's
  // row and detail in ops_job_health. The section keeps its DB row; its widget
  // is no longer registered.
  ops_manual_operations:  "ops_job_health",
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

// ── Views + destinations (PLATFORM OPS PHASE 1 UX) ──────────────────────────────

/** The composition of `workspaceId` in `area`, or undefined. */
export function getPlatformWorkspaceComposition(area: PlatformArea, workspaceId: string): PlatformWorkspaceComposition | undefined {
  return PLATFORM_AREA_WORKSPACES[area].find((w) => w.workspaceId === workspaceId);
}

/** The ordered view ids of every workspace in `area` that HAS views (the first is
 *  each workspace's default). Workspaces without views are absent. Client-safe
 *  string data — what the navigation hook needs, and nothing more. */
export function platformAreaViewIds(area: PlatformArea): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const w of PLATFORM_AREA_WORKSPACES[area]) if (w.views && w.views.length > 0) out[w.workspaceId] = w.views.map((v) => v.id);
  return out;
}

/**
 * THE view validator, shared by the server's first paint and the client's URL
 * read (the view counterpart of resolveSelectedWorkspaceKey): the first
 * requested id that names one of `viewIds`, else the default (first) view; null
 * for a workspace without views. An unknown id never selects a ghost view.
 */
export function resolvePlatformViewId(
  viewIds: readonly string[] | undefined,
  ...requested: readonly (string | null | undefined)[]
): string | null {
  if (!viewIds || viewIds.length === 0) return null;
  for (const r of requested) if (r && viewIds.includes(r)) return r;
  return viewIds[0];
}

/**
 * The view a REQUEST opens once its workspace resolved to `tab` — the ONE rule
 * the server's first paint and the client's URL read share: an explicit
 * `?view=` wins; a retired workspace id's own view (`?workspace=platform-jobs`)
 * applies when that id resolved to this very workspace; else the default view.
 */
export function resolveRequestedPlatformView(
  viewIdsOfTab: readonly string[] | undefined,
  tab: string,
  requestedWorkspace: string | null | undefined,
  requestedView: string | null | undefined,
): string | null {
  const aliasView = canonicalPlatformWorkspaceId(requestedWorkspace) === tab ? aliasedPlatformViewId(requestedWorkspace) : null;
  return resolvePlatformViewId(viewIdsOfTab, requestedView, aliasView);
}

/**
 * Split a destination id into the workspace and view it names, WITHOUT
 * validating either: a view target splits on the separator, a retired id maps
 * through PLATFORM_WORKSPACE_ALIASES (an explicit view beats the alias's own).
 * The navigation hook validates against what the area actually exposes.
 */
export function parsePlatformDestination(id: string): { workspaceId: string; viewId: string | null } {
  let workspaceId = id;
  let viewId: string | null = null;
  const sep = id.indexOf(VIEW_TARGET_SEPARATOR);
  if (sep > 0) { workspaceId = id.slice(0, sep); viewId = id.slice(sep + 1) || null; }
  const alias = PLATFORM_WORKSPACE_ALIASES[workspaceId];
  if (alias) { workspaceId = alias.workspaceId; viewId = viewId ?? alias.viewId ?? null; }
  return { workspaceId, viewId };
}

/** A resolved navigation destination: which workspace, which view, and the label/icon a doorway shows. */
export interface PlatformDestination {
  workspaceId: string;
  /** null ⇒ the workspace's default view (or a workspace with no views). */
  viewId: string | null;
  label: string;
  icon: string;
}

/**
 * Resolve ANY destination id a Platform surface may hold — a live workspace id,
 * a view target (`platformViewTarget`), or a retired id (PLATFORM_WORKSPACE_
 * ALIASES) — to the workspace + view it opens and the label a doorway names.
 * A view destination is labelled by its VIEW ("Jobs"), a workspace by its
 * area-local label ("Operations") or identity label. Unknown ⇒ undefined
 * (fails safe: the caller renders no doorway).
 */
export function resolvePlatformDestination(id: string, area: PlatformArea = "PLATFORM_OPS"): PlatformDestination | undefined {
  const { workspaceId, viewId } = parsePlatformDestination(id);
  const def = PLATFORM_WORKSPACES[workspaceId];
  if (!def) return undefined;
  const comp = getPlatformWorkspaceComposition(area, workspaceId);
  const view = viewId ? comp?.views?.find((v) => v.id === viewId) : undefined;
  if (viewId && !view) return undefined; // a ghost view is no destination
  return {
    workspaceId,
    viewId,
    label: view?.label ?? comp?.label ?? def.label,
    icon: view?.icon ?? def.icon,
  };
}

