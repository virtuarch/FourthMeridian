/**
 * lib/platform/intelligence/navigation/registry.ts  (Platform Intelligence — foundation step 3)
 *
 * THE NAVIGATION REGISTRY: every place in the Platform an operator can be sent,
 * as typed targets. Design: docs/plans/PLATFORM-INTELLIGENCE.md (step 3, "the
 * navigation copilot: observe and navigate first"). No route, no UI, no AI
 * wiring: this is the map a later navigator reads.
 *
 * DERIVED, NEVER HAND-COPIED (S2 binding 1)
 *   The targets are GENERATED at module load from the sources the UI itself
 *   renders from:
 *     - the two Platform pages off the Space axis (Overview, AI): lib/platform/nav.ts
 *       `platformDestinations` (labels) + its hrefs;
 *     - every Platform area × workspace × view: lib/platform/workspaces.ts
 *       PLATFORM_AREA_WORKSPACES (composition, view labels) + PLATFORM_WORKSPACES
 *       (identity labels), labelled through `resolvePlatformDestination`, the
 *       resolver the doorways use;
 *     - the path + workspace / view query: lib/platform/workspace-href.ts
 *       `platformWorkspaceHref` — the SAME function the sidebar and doorways
 *       call (a fixed segment template over the PlatformArea enum, never user input);
 *     - the deep-link params: lib/space/space-url.ts `buildSpaceUrl`, the one
 *       serializer, over keys typed against SPACE_URL_PARAMS (the one list).
 *   registry.test.ts fails in BOTH directions: a workspace, view or Platform
 *   deep-link param in the sources without a target, or a target / param
 *   without a source. Adding a workspace therefore surfaces here or fails CI.
 *
 * TARGET GRAIN
 *   A workspace WITH views yields one target per view (its first view is the
 *   workspace's default and its href is the bare workspace link); a workspace
 *   without views yields one target. Sections are not targets: a section's
 *   label is DB text (SpaceDashboardSection.label) and it has no URL of its own
 *   (a scroll anchor that exists only when an enabled row renders), so each
 *   target lists the section KEYS it composes instead.
 *
 * VISIBILITY = THE DESTINATION'S REAL GUARD (S2 binding 2)
 *   `guard` is exactly what the destination page enforces, pinned against the
 *   page source in registry.test.ts:
 *     - app/(shell)/dashboard/platform/[area]/page.tsx: requirePlatformAccess(area, "READ"),
 *       and it refuses break-glass (grant null ⇒ redirect; proxy.ts also sends a
 *       SYSTEM_ADMIN off /dashboard/*);
 *     - app/(shell)/dashboard/platform/page.tsx and …/ai/page.tsx: any ACTIVE
 *       PlatformGrant (loadPlatformDirectory non-empty), same break-glass refusal.
 *
 * IDENTITY TIER (S2 binding 7)
 *   A destination's tier is its area's surface tier (retrieve-core SURFACE_TIER):
 *   every Customer Success destination may render the customer it is about
 *   (customer list, CS incidents, Communications), every other one is
 *   identity-free. The accessor hides a CUSTOMER_SUCCESS target on any other
 *   surface, downgrade-only (./access.ts).
 *
 * DEEP-LINK PARAMS (S2 binding 4) are an allowlist per target, grouped by the
 * existing URL module that owns them; each group's validator is that module's
 * OWN read → update round trip (readIncidentsUrl / incidentsUrlUpdate over
 * parseIncidentSearch, readAiBudgetCallsUrl over parseBudgetCallsQuery,
 * readEconomicsDrillUrl over parseEconomicsDrillQuery, readMerchantRecordsUrl
 * over parseRecordsQuery, readAttentionParam over parseAttentionFilter). Nothing
 * is re-implemented: a value is accepted only if the owner's parser keeps it
 * byte-for-byte. A group belongs to a target when the view's LEAD, or a
 * section the view composes, is the component that reads it (pinned).
 *
 * METRIC LINKS: a target names the metric ids whose tile renders in it, derived
 * from TILE_HOMES (each registry tile → the lead or section that renders it,
 * pinned against the component imports) and the target's composition, and only
 * for metrics served in the target's area.
 *
 * OUT OF SCOPE (S2 binding 3): personal-Space and tenant destinations
 * (/dashboard/spaces/<id>, a customer's detail by userId). No target names a
 * Space id, a user id or any other row id; record ids appear only as validated
 * deep-link VALUES the owner's parser accepts (iid, rid).
 *
 * ⚠️ FUTURE AI / chat consumers obtain an href ONLY through
 * `resolveNavigationTarget` (./access.ts) and never compose a URL themselves.
 * `buildNavigationHref` is exported for that accessor alone (importers pinned).
 *
 * Pure: no I/O, no module state beyond the derived constant tables.
 */

import type { PlatformAccessLevel, PlatformArea } from "@prisma/client";
import { ALL_PLATFORM_AREAS, PLATFORM_AREAS } from "@/lib/platform/policy";
import { platformAreaHref } from "@/lib/platform/directory";
import { PLATFORM_AI_HREF, platformDestinations } from "@/lib/platform/nav";
import { PLATFORM_DIRECTORY_HREF } from "@/lib/space-nav";
import {
  getPlatformAreaWorkspaces,
  platformViewTarget,
  resolvePlatformDestination,
  viewComposedKeys,
  type PlatformViewLead,
} from "@/lib/platform/workspaces";
import { buildSpaceUrl, type SpaceUrlParam } from "@/lib/space/space-url";
import { PLATFORM_DEFAULT_WORKSPACE_ID, platformWorkspaceHref } from "@/lib/platform/workspace-href";
import { METRICS, metricKey } from "@/lib/platform/intelligence/metrics/registry";
import type { IdentityTier } from "@/lib/platform/intelligence/metrics/registry";
import { SURFACE_TIER } from "@/lib/platform/intelligence/metrics/retrieve-core";
import { INCIDENTS_URL_PARAMS, incidentsUrlUpdate, readIncidentsUrl } from "@/components/platform/incidents/incidents-url";
import { AI_BUDGET_CALLS_URL_PARAMS, aiBudgetCallsUrlUpdate, readAiBudgetCallsUrl } from "@/components/platform/leads/ai-budget-calls-url";
import { MERCHANT_URL_PARAMS, merchantRecordsUrlUpdate, readMerchantRecordsUrl } from "@/components/platform/leads/merchant-records-url";
import { ECONOMICS_URL_PARAMS, economicsDrillUrlUpdate, readEconomicsDrillUrl } from "@/components/platform/leads/economics-model";
import { CS_ATTENTION_PARAM, attentionUrlUpdate, readAttentionParam } from "@/components/platform/leads/cs-attention-link";

// ── Vocabulary ───────────────────────────────────────────────────────────────

export type NavigationTargetKind = "platform-page" | "workspace" | "view";

/** The page's own gate (pinned against the page source). */
export type NavigationGuard =
  | { kind: "AREA"; area: PlatformArea; level: PlatformAccessLevel; page: string }
  | { kind: "ANY_GRANT"; page: string };

/** The page file every Platform area target renders through, and the level it requires. */
export const AREA_PAGE = "app/(shell)/dashboard/platform/[area]/page.tsx";
export const AREA_PAGE_LEVEL: PlatformAccessLevel = "READ";
export const DIRECTORY_PAGE = "app/(shell)/dashboard/platform/page.tsx";
export const AI_PAGE = "app/(shell)/dashboard/platform/ai/page.tsx";

/** The Space-URL keys that carry the target itself (never a caller-supplied param). */
export const TARGET_IDENTITY_PARAMS = ["workspace", "view"] as const;

export type NavigationParamGroupId = "incidents" | "ai-budget-calls" | "economics-drill" | "merchant-records" | "cs-attention";

/** Where a param group (or a metric tile) renders: a view lead (optionally only on one view of it), or a composed section key. */
export type ComponentHome = { lead: PlatformViewLead; view?: string } | { section: string };

export interface NavigationParamGroup {
  id: NavigationParamGroupId;
  /** The owner module's exported key list — Space-URL params by type (space-url.ts, the one list). */
  keys: readonly SpaceUrlParam[];
  /** The module that owns the keys (pinned: it exports them, and each home's component imports it). */
  module: string;
  homes: readonly ComponentHome[];
  /** The owner's own canonical form of a query: read with its parser, write with its updater. */
  canonical(search: string, at: { viewId: string | null; nowMs: number }): Readonly<Record<string, string | null>>;
}

export const NAVIGATION_PARAM_GROUPS: readonly NavigationParamGroup[] = [
  {
    id: "incidents", keys: INCIDENTS_URL_PARAMS, module: "components/platform/incidents/incidents-url.ts",
    homes: [{ lead: "incidents-ops" }, { lead: "incidents-cs" }],
    canonical: (s, { viewId, nowMs }) => incidentsUrlUpdate(readIncidentsUrl(s, viewId, nowMs)),
  },
  {
    id: "ai-budget-calls", keys: AI_BUDGET_CALLS_URL_PARAMS, module: "components/platform/leads/ai-budget-calls-url.ts",
    homes: [{ lead: "ai-costs" }],
    canonical: (s, { nowMs }) => aiBudgetCallsUrlUpdate(readAiBudgetCallsUrl(s, nowMs)),
  },
  {
    id: "economics-drill", keys: ECONOMICS_URL_PARAMS, module: "components/platform/leads/economics-model.ts",
    // The Providers and Entitlements leads open the same drill drawer (useEconomicsDrill).
    homes: [{ lead: "economics-overview" }, { lead: "economics-providers" }, { lead: "economics-entitlements" }],
    canonical: (s, { nowMs }) => economicsDrillUrlUpdate(readEconomicsDrillUrl(s, nowMs)),
  },
  {
    id: "merchant-records", keys: MERCHANT_URL_PARAMS, module: "components/platform/leads/merchant-records-url.ts",
    homes: [{ lead: "merchant" }],
    canonical: (s) => merchantRecordsUrlUpdate(readMerchantRecordsUrl(s)),
  },
  {
    id: "cs-attention", keys: [CS_ATTENTION_PARAM], module: "components/platform/leads/cs-attention-link.ts",
    homes: [{ section: "cs_customers" }],
    canonical: (s) => {
      const r = readAttentionParam(s);
      return r.unknown ? { [CS_ATTENTION_PARAM]: null } : attentionUrlUpdate(r.filter);
    },
  },
];

/**
 * Where each metric-registry tile renders (component → the lead or composed
 * section that mounts it). Pinned: the home's component IS the tile module or
 * imports it within two hops. A tile with no Platform home says why.
 */
export const TILE_HOMES: Readonly<Record<string, readonly ComponentHome[] | { none: string }>> = {
  "components/platform/leads/providers-model.ts": [{ lead: "providers" }],
  "components/platform/widgets/provider-view.ts": [{ section: "ops_provider_health" }],
  "components/platform/widgets/ai-budget-view.ts": [{ section: "ops_ai_budget" }],
  "components/platform/leads/ai-costs-model.ts": [{ lead: "ai-costs" }],
  "components/platform/leads/EconomicsOverviewLead.tsx": [{ lead: "economics-overview" }],
  "components/platform/leads/economics-model.ts": [{ lead: "economics-overview" }],
  "components/platform/widgets/CsCustomersWidget.tsx": [{ section: "cs_customers" }],
  "components/platform/leads/growth-model.ts": [{ lead: "growth" }],
  "components/platform/incidents/incidents-model.ts": [{ lead: "incidents-ops" }, { lead: "incidents-cs" }],
  // The list total on the "Broken now" view only (each view is one status preset).
  "components/platform/incidents/IncidentsLead.tsx": [{ lead: "incidents-ops", view: "open" }, { lead: "incidents-cs", view: "open" }],
  "components/platform/leads/merchant-model.ts": [{ lead: "merchant" }],
  "components/platform/leads/CustomerSuccessLead.tsx": [{ lead: "customer-success" }],
  "components/platform/leads/customer-success-model.ts": [{ lead: "customer-success" }],
  "components/platform/widgets/security-posture-view.ts": [{ section: "sec_auth_posture" }],
  "components/platform/widgets/OpsUsersWidget.tsx": [{ section: "growth_users" }],
  "lib/platform/customer/customer-core.ts": { none: "A server reader (the per-customer detail fold), not a rendered tile: its figure reaches the UI through CsCustomersWidget, which is homed." },
};

export interface NavigationTarget {
  /** "platform:<page>" | "<AREA>:<workspaceId>" | "<AREA>:<workspaceId>:<viewId>". */
  id: string;
  kind: NavigationTargetKind;
  /** The label the UI shows for this destination (the view control / rail / nav label). */
  label: string;
  /** The rail label of the workspace (null for a platform page). */
  workspaceLabel: string | null;
  area: PlatformArea | null;
  /** PLATFORM_AREAS[area].label (null for a platform page). */
  areaLabel: string | null;
  guard: NavigationGuard;
  tier: IdentityTier;
  workspaceId: string | null;
  viewId: string | null;
  /** The workspace's default view (or a view-less workspace / page): its href writes no `?view=`. */
  isDefault: boolean;
  /** The fixed path template's value (a PlatformArea enum segment at most). */
  pathname: string;
  /** Allowed deep-link keys, in group order. */
  params: readonly string[];
  paramGroups: readonly NavigationParamGroupId[];
  /** Section keys the destination composes (inline + hosted). */
  sections: readonly string[];
  /** Metric ids (id@version) whose tile renders here. */
  metrics: readonly `${string}@${number}`[];
}

// ── Derivation ───────────────────────────────────────────────────────────────

interface At { lead: PlatformViewLead | undefined; viewId: string | null; sections: readonly string[] }

const homeIn = (h: ComponentHome, at: At) =>
  "lead" in h ? h.lead === at.lead && (h.view === undefined || h.view === at.viewId) : at.sections.includes(h.section);

function metricsAt(area: PlatformArea, at: At): `${string}@${number}`[] {
  return METRICS.filter((m) => m.permission.some((p) => p.area === area)
    && m.tiles.some((t) => {
      const homes = TILE_HOMES[t.component];
      return Array.isArray(homes) && homes.some((h) => homeIn(h, at));
    })).map(metricKey);
}

function groupsAt(at: At): NavigationParamGroup[] {
  return NAVIGATION_PARAM_GROUPS.filter((g) => g.homes.some((h) => homeIn(h, at)));
}

function derive(): NavigationTarget[] {
  const out: NavigationTarget[] = [];
  const pages = platformDestinations(null, null);
  const pageLabel = (id: "overview" | "ai") => pages.find((d) => d.id === id)!.label;
  const page = (id: "overview" | "ai", pathname: string, file: string): NavigationTarget => ({
    id: `platform:${id}`, kind: "platform-page", label: pageLabel(id), workspaceLabel: null, area: null, areaLabel: null,
    guard: { kind: "ANY_GRANT", page: file }, tier: "OPS", workspaceId: null, viewId: null, isDefault: true,
    pathname, params: [], paramGroups: [], sections: [], metrics: [],
  });
  out.push(page("overview", PLATFORM_DIRECTORY_HREF, DIRECTORY_PAGE), page("ai", PLATFORM_AI_HREF, AI_PAGE));

  for (const area of ALL_PLATFORM_AREAS) {
    const base = {
      area, areaLabel: PLATFORM_AREAS[area].label,
      guard: { kind: "AREA", area, level: AREA_PAGE_LEVEL, page: AREA_PAGE } as const,
      tier: SURFACE_TIER(area), pathname: platformAreaHref(area),
    };
    for (const comp of getPlatformAreaWorkspaces(area)) {
      const ws = resolvePlatformDestination(comp.workspaceId, area);
      if (!ws) continue; // an unidentified composition renders nothing (the coverage test fails on it)
      const views = comp.views ?? [];
      if (views.length === 0) {
        const at: At = { lead: undefined, viewId: null, sections: comp.sections };
        const groups = groupsAt(at);
        out.push({
          ...base, id: `${area}:${comp.workspaceId}`, kind: "workspace", label: ws.label, workspaceLabel: ws.label,
          workspaceId: comp.workspaceId, viewId: null, isDefault: true,
          params: groups.flatMap((g) => g.keys), paramGroups: groups.map((g) => g.id),
          sections: comp.sections, metrics: metricsAt(area, at),
        });
        continue;
      }
      views.forEach((v, i) => {
        const dest = resolvePlatformDestination(platformViewTarget(comp.workspaceId, v.id), area);
        const sections = viewComposedKeys(v);
        const at: At = { lead: v.lead, viewId: v.id, sections };
        const groups = groupsAt(at);
        out.push({
          ...base, id: `${area}:${comp.workspaceId}:${v.id}`, kind: "view", label: dest?.label ?? v.label, workspaceLabel: ws.label,
          workspaceId: comp.workspaceId, viewId: v.id, isDefault: i === 0,
          params: groups.flatMap((g) => g.keys), paramGroups: groups.map((g) => g.id),
          sections, metrics: metricsAt(area, at),
        });
      });
    }
  }
  return out;
}

/** Every navigation target, in nav → area registry → workspace → view order. Frozen. */
export const NAVIGATION_TARGETS: readonly NavigationTarget[] = Object.freeze(derive().map((t) => Object.freeze(t)));

/** The workspace that writes no `?workspace=` (workspace-href.ts; every area's first composition — pinned). */
export const DEFAULT_WORKSPACE_ID = PLATFORM_DEFAULT_WORKSPACE_ID;

/**
 * The href for a target and ALREADY-VALIDATED params (./access.ts validates).
 * The workspace / view link is `platformWorkspaceHref` itself — the UI's own
 * builder, by identity (defaults omitted exactly as the UI writes them); the
 * params follow through the one serializer, in the target's allowlist order.
 * Exported for ./access.ts only.
 */
export function buildNavigationHref(t: NavigationTarget, params: Readonly<Record<string, string>>): string {
  const base = t.area && t.workspaceId ? platformWorkspaceHref(t.area, t.workspaceId, t.isDefault ? null : t.viewId) : t.pathname;
  const q = base.indexOf("?");
  const updates: Record<string, string | null> = {};
  for (const k of t.params) if (k in params) updates[k] = params[k];
  return buildSpaceUrl(q < 0 ? base : base.slice(0, q), q < 0 ? "" : base.slice(q + 1), updates);
}
