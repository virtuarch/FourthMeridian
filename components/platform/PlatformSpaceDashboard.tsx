"use client";

/**
 * components/platform/PlatformSpaceDashboard.tsx  (OPS-5 S6 — Workspace Decomposition)
 *
 * The Platform Space render surface. It renders through the SHARED, universal
 * SpaceShell frame (the same primitive customer Spaces use) and now composes
 * MULTIPLE Workspaces into the shell's workspace slot — no longer one flat
 * Overview grid.
 *
 * Architecture reuse (NOT a parallel framework):
 *   • Identity  — each rail destination is a universal `WorkspaceDefinition`
 *     registered in the ONE `WORKSPACE_REGISTRY` (lib/platform/workspaces.ts →
 *     lib/perspectives.ts), domain:"platform".
 *   • Composition — which Workspaces an area exposes, and which section-widgets
 *     each renders, comes from the SINGLE composition owner
 *     `PLATFORM_AREA_WORKSPACES` (lib/platform/workspaces.ts).
 *   • Frame — SpaceShell owns chrome + the rail (Atlas SegmentedControl); this
 *     host only supplies title/subtitle/toolbar/rail + the active workspace body.
 *   • Sidebar — identity, the area's WORKSPACE destinations (UX-P1 Change B:
 *     the same `workspaceNav` channel a customer Space publishes Net Worth ·
 *     Cash Flow through, so at lg+ the sidebar is the primary switcher and the
 *     rail serves smaller screens) AND the active workspace's SECTION anchors
 *     are published up through the ONE SpaceChrome bridge customer workspaces
 *     use, so the ContextualNavbar serves both domains from one model.
 *   • URL — the open workspace is URL state (`?workspace=`), owned by
 *     lib/space/use-platform-workspace-navigation (the Platform counterpart of
 *     useSpaceNavigation): deep links, Back/Forward and reload all resolve the
 *     same workspace; the default writes no param (UX-P1 Change A).
 *   • Data — Platform widgets SELF-FETCH (OPS-5 S6 dataNeeds decision A); this
 *     host passes each its enabled DB `SpaceDashboardSection` row and nothing more.
 *
 * Overview is a SUMMARY surface (top alerts + high-level job/provider/freshness
 * summaries + config posture) with DOORWAYS into the detailed Workspaces — not the
 * home of every capability. The heavy detail (Manual Operations WRITE controls,
 * connection + API-usage breakdowns) lives in its own Workspace.
 *
 * The PO1.0 placeholder subsystem (PlaceholderCard / section-note registry) is
 * gone: every composed section resolves to a real widget (a key without one is
 * simply skipped), so the placeholder branch was dead (OPS-5 integration gate §12).
 */

import { useEffect, useMemo, type ComponentType } from "react";
import {
  useSpaceChromePublisher,
  useSpaceSectionsPublisher,
  useSpaceWorkspaceNavPublisher,
  type SpaceChromeSection,
} from "@/lib/space/space-chrome-context";
import {
  platformWorkspaceHref,
  usePlatformWorkspaceNavigation,
} from "@/lib/space/use-platform-workspace-navigation";
import type { SpaceMountContext, SpaceMountAccess } from "@/lib/space/mount-context";
import type { LucideIcon } from "lucide-react";
import { LayoutDashboard, Timer, PlugZap, Wrench, BellRing, History, Sparkles, Gauge, RefreshCw, SlidersHorizontal, ArrowRight, ChevronLeft } from "lucide-react";
import type { PlatformArea } from "@prisma/client";
import { SpaceShell, type SpaceShellRailOption } from "@/components/space/shell/SpaceShell";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import {
  getPlatformAreaWorkspaces,
  platformAreaViewIds,
  resolvePlatformDestination,
  viewSectionKey,
  type PlatformSectionVariant,
  type PlatformViewLead,
  type PlatformViewSection,
  type PlatformWorkspaceView,
} from "@/lib/platform/workspaces";
import type { PlatformViewLeadProps, RenderHosted } from "./leads/lead-contract";
import { OperationsLead } from "./leads/OperationsLead";
import { PipelineLead } from "./leads/PipelineLead";
import { ProvidersLead } from "./leads/ProvidersLead";
import { AiCostsLead } from "./leads/AiCostsLead";
import { PoliciesLead } from "./leads/PoliciesLead";
import { PlatformAreaHero } from "./PlatformAreaHero";
import { PlatformSpaceSwitcher } from "./PlatformSpaceSwitcher";
import { usePlatformNav } from "@/components/ui/PlatformNavContext";
import type { PlatformSection } from "./widget-kit";
import { SecAuditFeedWidget } from "./widgets/SecAuditFeedWidget";
import { SecOperatorActionsWidget } from "./widgets/SecOperatorActionsWidget";
import { SecAuthPostureWidget } from "./widgets/SecAuthPostureWidget";
import { SecSessionsWidget } from "./widgets/SecSessionsWidget";
import { SecAnomaliesWidget } from "./widgets/SecAnomaliesWidget";
import { CsCustomersWidget } from "./widgets/CsCustomersWidget";
import { GrowthPolicyGroupsWidget } from "./widgets/GrowthPolicyGroupsWidget";
import { GrowthProductAnalyticsWidget } from "./widgets/GrowthProductAnalyticsWidget";
import { OpsJobsWidget } from "./ops-visual/OpsJobsWidget";
import { OpsRateLimitsWidget } from "./widgets/OpsRateLimitsWidget";
import { OpsEnvStatusWidget } from "./widgets/OpsEnvStatusWidget";
import { OpsApiUsageWidget } from "./widgets/OpsApiUsageWidget";
import { OpsConnectionHealthWidget } from "./widgets/OpsConnectionHealthWidget";
import { OpsConnectionDiagnosticsWidget } from "./widgets/OpsConnectionDiagnosticsWidget";
import { OpsProviderCleanupWidget } from "./widgets/OpsProviderCleanupWidget";
import { OpsEmailDeliveryWidget } from "./widgets/OpsEmailDeliveryWidget";
import { OpsResourceFreshnessWidget } from "./widgets/OpsResourceFreshnessWidget";
import { OpsProviderHealthWidget } from "./widgets/OpsProviderHealthWidget";
import { OpsAlertsWidget } from "./widgets/OpsAlertsWidget";
import { OpsHistoryWidget } from "./widgets/OpsHistoryWidget";
import { OpsConvergenceWidget } from "./widgets/OpsConvergenceWidget";
import { OpsTimelineWidget } from "./widgets/OpsTimelineWidget";
import { OpsAiTrendWidget } from "./widgets/OpsAiTrendWidget";
import { OpsCostWidget } from "./widgets/OpsCostWidget";
import { OpsRefreshSummaryWidget } from "./widgets/OpsRefreshSummaryWidget";
import { OpsRefreshExecutionsWidget } from "./widgets/OpsRefreshExecutionsWidget";
import { OpsRefreshCoverageWidget } from "./widgets/OpsRefreshCoverageWidget";
import { OpsProviderOperationsWidget } from "./widgets/OpsProviderOperationsWidget";
import { OpsSchedulerWidget } from "./widgets/OpsSchedulerWidget";
import { OpsPoliciesWidget } from "./widgets/OpsPoliciesWidget";
import { OpsPlatformHealthWidget } from "./widgets/OpsPlatformHealthWidget";
import { OpsOverviewWidget } from "./widgets/OpsOverviewWidget";
import { OpsAiInvocationsWidget } from "./widgets/OpsAiInvocationsWidget";
import { OpsBriefOpsWidget } from "./widgets/OpsBriefOpsWidget";
import { OpsPlaidUsageWidget } from "./widgets/OpsPlaidUsageWidget";
import { OpsAiBudgetWidget } from "./widgets/OpsAiBudgetWidget";
import { WorkspaceSessionProvider } from "./workspace-session";
import { GrowthSignupsWidget } from "./widgets/GrowthSignupsWidget";
import { GrowthBetaRequestsWidget } from "./widgets/GrowthBetaRequestsWidget";
import { OpsUsersWidget } from "./widgets/OpsUsersWidget";
import { OpsActivityWidget } from "./widgets/OpsActivityWidget";
import { OpsGrowthWidget } from "./widgets/OpsGrowthWidget";
import { CsSyncIssuesWidget } from "./widgets/CsSyncIssuesWidget";
import { MerchantReviewWidget } from "./widgets/MerchantReviewWidget";

type Section = PlatformSection;

/**
 * Platform-local widget registry: section key → its widget. A SEPARATE,
 * platform-scoped map (the customer WIDGET_REGISTRY is untouched) — justified: the
 * two domains render different widget families through the same "one entry, no
 * switch/case" pattern.
 */
/**
 * Widgets receive their section row and, optionally, the rail's own workspace
 * switcher. The prototype's summary surfaces end each group with a doorway into
 * the workspace that owns its detail ("Alerts →"), so the surface needs a way to
 * move the rail — and it must be the SAME way `WorkspaceDoorway` already does it,
 * not a second navigation mechanism. `onOpenWorkspace` is OPTIONAL, so every
 * existing widget stays assignable to this registry unchanged; a widget that does
 * not take it simply never moves the rail.
 */
/** The fail-safe access a workspace body renders with when none is supplied. */
const READ_ONLY_ACCESS: SpaceMountAccess = { canRead: true, canWrite: false, canControl: false, level: "READ" };

const PLATFORM_WIDGET_REGISTRY: Record<
  string,
  ComponentType<{ section: Section; onOpenWorkspace?: (id: string) => void; access?: SpaceMountAccess; variant?: PlatformSectionVariant }>
> = {
  // Security Operations
  sec_audit_feed:       SecAuditFeedWidget,
  sec_operator_actions: SecOperatorActionsWidget,
  sec_auth_posture:     SecAuthPostureWidget,
  sec_sessions:     SecSessionsWidget,
  sec_anomalies:    SecAnomaliesWidget,
  // Platform Operations
  ops_job_health:         OpsJobsWidget,
  ops_rate_limits:        OpsRateLimitsWidget,
  ops_env_status:         OpsEnvStatusWidget,
  ops_api_usage:          OpsApiUsageWidget,
  ops_connection_health:  OpsConnectionHealthWidget,
  ops_connection_diagnostics: OpsConnectionDiagnosticsWidget,
  ops_provider_cleanup:       OpsProviderCleanupWidget,
  ops_email_delivery:     OpsEmailDeliveryWidget,
  ops_resource_freshness: OpsResourceFreshnessWidget,
  ops_provider_health:    OpsProviderHealthWidget,
  ops_alerts:             OpsAlertsWidget,
  ops_history:            OpsHistoryWidget,
  ops_convergence:        OpsConvergenceWidget,
  ops_timeline:           OpsTimelineWidget,
  ops_ai_trend:           OpsAiTrendWidget,
  ops_cost:               OpsCostWidget,
  // OPS-2C-2 — Refresh workspace (first consumers of the DF-2 read model).
  ops_refresh_summary:    OpsRefreshSummaryWidget,
  ops_refresh_executions: OpsRefreshExecutionsWidget,
  ops_refresh_coverage:   OpsRefreshCoverageWidget,
  ops_provider_operations: OpsProviderOperationsWidget,
  ops_scheduler:          OpsSchedulerWidget,
  ops_platform_health:    OpsPlatformHealthWidget,
  // PLATFORM OPS POLICIES (Slice 1) — read-only financial refresh policy.
  ops_policies:           OpsPoliciesWidget,
  // PLATFORM OPS OBSERVABILITY — the cockpit and the new authority readers.
  ops_overview:           OpsOverviewWidget,
  ops_ai_invocations:     OpsAiInvocationsWidget,
  ops_brief_ops:          OpsBriefOpsWidget,
  ops_plaid_usage:        OpsPlaidUsageWidget,
  // AI COST CONTROLS — budget utilization on Economics (Agent B replaces the stub).
  ops_ai_budget:          OpsAiBudgetWidget,
  // Growth & Revenue
  growth_signups:       GrowthSignupsWidget,
  growth_beta_requests: GrowthBetaRequestsWidget,
  growth_users:         OpsUsersWidget,
  growth_activity:      OpsActivityWidget,
  growth_funnel:        OpsGrowthWidget,
  growth_policy_groups: GrowthPolicyGroupsWidget,
  growth_product_analytics: GrowthProductAnalyticsWidget,
  // Customer Success
  cs_customers:   CsCustomersWidget,
  cs_sync_issues: CsSyncIssuesWidget,
  // Merchant Operations — a doorway to the merge review (/merchant-ops).
  merchant_review: MerchantReviewWidget,
};

/**
 * PLATFORM OPS 2.0 (R2) — the view LEADS: lead id → its summary-first component
 * (lib/platform/workspaces.ts `PlatformWorkspaceView.lead`). A lead is not a
 * section: it has no DB row and no anchor; it reads existing READ routes and
 * reaches the view's HOSTED sections only through `renderHosted` below.
 */
const PLATFORM_VIEW_LEADS: Record<PlatformViewLead, ComponentType<PlatformViewLeadProps>> = {
  operations: OperationsLead,
  pipeline:   PipelineLead,
  providers:  ProvidersLead,
  "ai-costs": AiCostsLead,
  policies:   PoliciesLead,
};

/**
 * The scroll-anchor id for a composed section, derived from its section KEY (the
 * stable composition identity — labels are editable DB text and would move the
 * anchor under the sidebar). ONE derivation, used by both the rendered wrapper
 * and the published anchor, so the sidebar can never point at an id that does
 * not exist.
 */
export function platformSectionAnchor(key: string): string {
  return `platform-section-${key}`;
}

/** The DB rows a workspace (view) actually RENDERS: composed, enabled, and
 *  backed by a widget — each with the variant its view composes it in. A
 *  composed key with no enabled row, or no widget, renders nothing. */
function resolveWorkspaceRows(
  sectionKeys: readonly PlatformViewSection[],
  dbByKey: ReadonlyMap<string, Section>,
): { row: Section; variant?: PlatformSectionVariant }[] {
  return sectionKeys
    .map((entry) => ({ row: dbByKey.get(viewSectionKey(entry)), variant: typeof entry === "string" ? undefined : entry.variant }))
    .filter((r): r is { row: Section; variant: PlatformSectionVariant | undefined } => r.row != null && PLATFORM_WIDGET_REGISTRY[r.row.key] != null);
}

/**
 * The ACTIVE workspace's sidebar Sections list — the same `SpaceChromeSection`
 * contract customer workspaces publish, so Platform adopts the ONE model rather
 * than growing a second one.
 *
 * Honesty rules, both load-bearing:
 *   • The LABEL is the DB `SpaceDashboardSection.label` — never a hardcoded
 *     string and never the section key. A composed key with no enabled DB row
 *     has no label and therefore no row here: it does not exist on this surface.
 *   • The ANCHOR is null when the section has no widget to scroll to. That row
 *     renders DISABLED ("· soon") rather than pretending to a scroll target the
 *     page never mounts.
 */
export function platformChromeSections(
  sectionKeys: readonly PlatformViewSection[],
  dbByKey: ReadonlyMap<string, Section>,
): SpaceChromeSection[] {
  return sectionKeys
    .map((entry) => dbByKey.get(viewSectionKey(entry)))
    .filter((row): row is Section => row != null)
    .map((row) => ({
      label: row.label,
      anchor: PLATFORM_WIDGET_REGISTRY[row.key] != null ? platformSectionAnchor(row.key) : null,
    }));
}

/** Stable empty composition — keeps the sections memo from re-firing per render. */
const NO_SECTION_KEYS: readonly PlatformViewSection[] = [];
/** Stable "hosts nothing" list (a view without a lead). */
const NO_HOSTED_KEYS: readonly string[] = [];

/** Lucide icon-name → component, for the Platform workspace identities. */
const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Timer, PlugZap, Wrench, BellRing, History, Sparkles, Gauge, RefreshCw, SlidersHorizontal,
};

interface Props {
  /** Domain locator — the PlatformArea. Deliberately KEPT OUT of the neutral
   *  SpaceRef (the area is a resolution detail, not identity), so it stays a
   *  Platform-specific prop: it drives the area editorial lede (PlatformAreaHero)
   *  and the operational workspace COMPOSITION (which section keys + doorways each
   *  workspace renders). That composition is data-needs metadata, NOT mount
   *  context — it correctly remains Platform-owned. */
  area:        PlatformArea;
  /** Enabled SpaceDashboardSection rows for this area's Space (DB, ordered) — the
   *  OPERATIONAL data the self-fetching widgets render. Never mount context. */
  sections:    Section[];
  /** PS-6C — the shared domain-neutral SpaceMountContext (the SAME contract the
   *  financial route builds), now CONSUMED for identity / display / workspace
   *  navigation / access / shell config. Required: Platform reads these from the
   *  contract rather than rebuilding them locally. */
  mountContext: SpaceMountContext;
  /** PLATFORM OPS PHASE 1 UX — the server-resolved first-paint VIEW of the
   *  selected workspace (`?view=`, resolveRequestedPlatformView), so SSR and the
   *  hydrated client agree. Absent/null ⇒ the default view. Platform-specific,
   *  like `area`: views are composition, not mount context. */
  selectedView?: string | null;
}


/** A summary→detail doorway (Overview only).
 *
 * UX-P1 (D11) — a quiet text link in one "Explore" row, no longer a card. Every
 * Overview block now ends in its own doorway into the workspace that holds its
 * detail, so this row is the generic fallback the composition still declares
 * (workspaces.test.ts pins ≥1 doorway), not a second card grid competing with
 * the blocks. Same `onOpen` mechanism as every block — one navigation path. */
function WorkspaceDoorway({ targetId, onOpen }: { targetId: string; onOpen: (id: string) => void }) {
  // PLATFORM OPS PHASE 1 UX — a doorway may target a VIEW (Operations › Jobs);
  // the destination resolver names it by the view, so the row still reads "Jobs".
  const def = resolvePlatformDestination(targetId);
  if (!def) return null;
  const Icon = WORKSPACE_ICONS[def.icon] ?? ArrowRight;
  return (
    <button
      type="button"
      onClick={() => onOpen(targetId)}
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] hover:bg-[var(--glass-ultrathin)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
      style={{ borderColor: "var(--border-hairline)" }}
      aria-label={`Open ${def.label}`}
    >
      <Icon size={12} aria-hidden className="text-[var(--text-muted)]" />
      {def.label}
    </button>
  );
}

/**
 * PLATFORM OPS PHASE 1 UX — the active workspace's VIEW switcher: the shared
 * Atlas SegmentedControl (the same primitive as the rail), at the top of the
 * workspace body at every width. Below lg it scrolls horizontally (the
 * primitive's own overflow) and every segment is a ≥44px touch target; at lg+
 * it is the compact control. Exported for the render test.
 */
export function PlatformViewSwitcher({ views, activeView, onSelect, workspaceLabel }: {
  views: readonly PlatformWorkspaceView[];
  activeView: string;
  onSelect: (viewId: string) => void;
  workspaceLabel: string;
}) {
  return (
    <div className="min-w-0 max-w-full">
      <SegmentedControl
        aria-label={`${workspaceLabel} views`}
        options={views.map((v) => ({ id: v.id, label: v.label }))}
        value={activeView}
        onChange={onSelect}
        touchOptimized
        className="max-lg:[&>button]:min-h-11"
      />
    </div>
  );
}

/**
 * PLATFORM OPS VISUAL SPEC §1 — a "drilldown" workspace's way back from a
 * non-default view: ONE compact link ("‹ Operations · Jobs"), never a second
 * full-height tab row under the workspace rail.
 */
export function PlatformDrilldownBack({ label, viewLabel, onBack }: { label: string; viewLabel: string; onBack: () => void }) {
  return (
    <nav aria-label={`${label} navigation`} className="-mb-4 flex min-w-0 items-center gap-1.5 text-xs md:-mb-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-xs)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8"
      >
        <ChevronLeft size={14} aria-hidden />
        {label}
      </button>
      <span aria-hidden className="text-[var(--text-faint)]">/</span>
      <span aria-current="page" className="truncate font-medium text-[var(--text-primary)]">{viewLabel}</span>
    </nav>
  );
}

/** One workspace body — its composed section widgets (+ Overview doorways).
 *
 * PO-2 — the body is now an EDITORIAL STACK, not a card grid: each widget is an
 * Atlas Block+Surface (widget-kit) laid out in the same top-to-bottom reading
 * rhythm customer Spaces use (space-y), so density builds down the page instead
 * of tiling isolated metric cards. The doorways keep their summary→detail role
 * but read as a quiet "Explore" region rather than a second card grid.
 *
 * Exported for the render test only (platform-shell.test.ts): the SIDEBAR points
 * at ids this body emits, so the two must be provable together — a scroll target
 * asserted only in the publisher would be a promise nothing keeps. */
export function PlatformWorkspaceBody({
  sectionKeys,
  doorways,
  dbByKey,
  onOpen,
  access = READ_ONLY_ACCESS,
  lead,
  hosted = NO_HOSTED_KEYS,
}: {
  sectionKeys: readonly PlatformViewSection[];
  doorways?:   readonly string[];
  dbByKey:     Map<string, Section>;
  onOpen:      (id: string) => void;
  /** The operator's resolved access (descriptive). Widgets that RENDER a control
   *  read it; the server gate decides. Optional and FAIL-SAFE: an absent value
   *  renders every widget as READ-only. */
  access?:     SpaceMountAccess;
  /** PLATFORM OPS 2.0 (R2) — the view's summary-first lead, rendered first. */
  lead?:       PlatformViewLead;
  /** The view's HOSTED keys — rendered only when the lead asks (drawers / detail). */
  hosted?:     readonly string[];
}) {
  const rows = resolveWorkspaceRows(sectionKeys, dbByKey);
  const Lead = lead ? PLATFORM_VIEW_LEADS[lead] : null;

  // A hosted key renders exactly as an inline section would: the same registry
  // widget, its enabled DB row, the same access — so gating (WRITE / control-
  // plane flags, reasons, confirmations) stays inside the widget, unchanged.
  // A key outside this view's `hosted`, without an enabled row, or without a
  // widget renders nothing (fails safe, like an inline section).
  const hasHosted = (key: string): boolean =>
    hosted.includes(key) && dbByKey.has(key) && PLATFORM_WIDGET_REGISTRY[key] != null;
  const renderHosted: RenderHosted = (key, onOpenWorkspace, variant) => {
    if (!hasHosted(key)) return null;
    const row = dbByKey.get(key)!;
    const Widget = PLATFORM_WIDGET_REGISTRY[key];
    // A variant rides only where the lead asks for one (the Policies drawers),
    // exactly as an inline view entry passes it; every other hosted widget
    // receives exactly the props it always did.
    return variant
      ? <Widget section={row} onOpenWorkspace={onOpenWorkspace ?? onOpen} access={access} variant={variant} />
      : <Widget section={row} onOpenWorkspace={onOpenWorkspace ?? onOpen} access={access} />;
  };

  return (
    <div className="flex flex-col gap-8 md:gap-10 pb-16">
      {Lead && (
        <WorkspaceSessionProvider>
          <Lead renderHosted={renderHosted} hasHosted={hasHosted} onOpenWorkspace={onOpen} access={access} />
          {rows.length > 0 && (
            <div className="flex flex-col gap-8 md:gap-10">
              {rows.map(({ row }) => {
                const Widget = PLATFORM_WIDGET_REGISTRY[row.key];
                return (
                  <div key={row.id} id={platformSectionAnchor(row.key)} className="scroll-mt-20">
                    <Widget section={row} onOpenWorkspace={onOpen} access={access} />
                  </div>
                );
              })}
            </div>
          )}
        </WorkspaceSessionProvider>
      )}
      {Lead ? null : rows.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">No sections enabled for this workspace.</p>
      ) : (
        /* OPS-2C-6 — the workspace owns the operational session. Widgets reading
           the same route in this workspace share ONE request and therefore one
           operational moment. Consumption only: no route is merged and no truth
           is computed here. The session is discarded when the workspace changes
           (the provider is keyed), so returning refetches rather than serving a
           previous view's answer as current. */
        <WorkspaceSessionProvider>
          <div className="flex flex-col gap-8 md:gap-10">
            {rows.map(({ row, variant }) => {
              const Widget = PLATFORM_WIDGET_REGISTRY[row.key];
              /* The scroll target for the sidebar's Sections list. Structural
                 only — a wrapper carrying the key-derived id (and the sticky-
                 header offset customer workspaces use), never a layout change:
                 the row is still one child of the same editorial stack. */
              return (
                <div key={row.id} id={platformSectionAnchor(row.key)} className="scroll-mt-20">
                  {/* A variant rides only where the view composes one, so every
                      other widget receives exactly the props it always did. */}
                  {variant ? (
                    <Widget section={row} onOpenWorkspace={onOpen} access={access} variant={variant} />
                  ) : (
                    <Widget section={row} onOpenWorkspace={onOpen} access={access} />
                  )}
                </div>
              );
            })}
          </div>
        </WorkspaceSessionProvider>
      )}

      {doorways && doorways.length > 0 && (
        <section aria-label="Explore" className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] mr-1">Explore</span>
          {doorways.map((id) => (
            <WorkspaceDoorway key={id} targetId={id} onOpen={onOpen} />
          ))}
        </section>
      )}
    </div>
  );
}

/** "CONTROL" → "Control" — the access level as a chip word. */
export function accessChipWord(level: string): string {
  return level ? level.charAt(0).toUpperCase() + level.slice(1).toLowerCase() : "";
}

/** Platform Ops it2 — the small access chip beside the compact title (and the sidebar's Workspaces heading). */
export function AccessChip({ level }: { level: string }) {
  if (!level) return null;
  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]"
      style={{ background: "var(--surface-hover)", border: "1px solid var(--border-hairline)" }}
      data-access-chip
    >
      <span className="sr-only">Access: </span>{accessChipWord(level)}
    </span>
  );
}

export function PlatformSpaceDashboard({ area, sections, mountContext, selectedView = null }: Props) {
  // ── Identity / display / navigation / access / shell — ALL from the shared
  //    contract (PS-6C). Nothing here is rebuilt from a second local derivation. ──
  const spaceName   = mountContext.display.name;
  const areaLabel   = mountContext.display.label ?? "";
  const accessLevel = mountContext.access.level;
  const { available, selectedKey } = mountContext.workspaces;

  // UX-P1 Change A — the open workspace is URL state (`?workspace=`), through
  // the ONE navigation authority for Platform Spaces. `setActiveTab` is the ONE
  // user-navigation setter: the rail, the sidebar rows and the Overview
  // doorways all call it, so every entry point declares the same PUSH intent.
  // PLATFORM OPS PHASE 1 UX — plus the VIEW axis (`?view=`) beneath it; the
  // view control calls `setActiveView`, every doorway still calls setActiveTab
  // (a destination id may carry a view: Operations › Jobs).
  const viewIds = useMemo(() => platformAreaViewIds(area), [area]);
  const { activeTab, activeView, setActiveTab, setActiveView } = usePlatformWorkspaceNavigation({ available, selectedKey, viewIds, selectedView });

  // Operational COMPOSITION (which section keys + doorways each workspace renders)
  // stays Platform-owned — it is data-needs metadata, NOT mount context, and is
  // deliberately absent from the neutral contract. Keyed by the same workspace ids
  // the contract's rail exposes, so rail and body stay consistent by construction.
  const composition = getPlatformAreaWorkspaces(area);
  const dbByKey = useMemo(() => new Map(sections.map((s) => [s.key, s] as const)), [sections]);

  // Rail navigation is the CONTRACT's workspace projection (key/label/icon NAME),
  // not a second registry walk here. Resolving the icon name → component is the
  // consuming surface's concern (the contract is client-safe string data).
  // it2 — the rail is the compact (<lg) switcher only; it fills the row in four
  // equal, text-only columns so every workspace fits a 375 px phone (the icons
  // stay on the desktop sidebar rows, resolved there from the same icon name).
  const railOptions: SpaceShellRailOption[] = available.map((w) => ({ id: w.key, label: w.label }));

  const active = composition.find((w) => w.workspaceId === activeTab) ?? composition[0];
  // The open VIEW of the active workspace (its default when the hook's view
  // belongs to nothing here); undefined for a workspace without views.
  const activeViewDef = active?.views?.find((v) => v.id === activeView) ?? active?.views?.[0];
  const isDefaultView = !active?.views || activeViewDef === active.views[0];
  // Only the active view's sections render — and only they list in the sidebar.
  const activeSections = activeViewDef?.sections ?? active?.sections;

  // SHELL migration — publish platform identity to the ContextualNavbar's Space
  // mode (the same transforming sidebar customer Spaces use; platform Spaces are
  // count-based, so no FX and no Manage). The operator's access level, formerly a
  // toolbar badge, folds into the subtitle so no information is lost.
  const { publishSpace, publishCurrencyControl } = useSpaceChromePublisher();
  // R1 — the granted Spaces for the mobile Space switcher beside the title
  // (the Platform nav provider's server-loaded rows; desktop uses the rail).
  const { spaces: grantedSpaces } = usePlatformNav();
  const chromeSubtitle = `Platform · ${areaLabel} · ${accessLevel}`;
  useEffect(() => {
    publishCurrencyControl(null);
    publishSpace({
      identity: { name: spaceName, subtitle: chromeSubtitle, accessChip: accessChipWord(accessLevel) },
    });
    return () => publishSpace(null);
  }, [publishSpace, publishCurrencyControl, spaceName, chromeSubtitle, accessLevel]);

  // SECTIONS — the ACTIVE workspace's "what's inside" list, published UP to the
  // same ContextualNavbar block customer workspaces feed (SpaceChrome sections
  // channel). Keyed on the active workspace's composed keys, so switching the
  // rail re-publishes; cleared on unmount exactly like the identity above, so
  // leaving a platform Space never leaves its sections behind in the sidebar.
  const publishSections = useSpaceSectionsPublisher();
  const chromeSections = useMemo(
    () => platformChromeSections(activeSections ?? NO_SECTION_KEYS, dbByKey),
    [activeSections, dbByKey],
  );
  useEffect(() => {
    publishSections(chromeSections);
    return () => publishSections([]);
  }, [publishSections, chromeSections]);

  // WORKSPACES — UX-P1 Change B: the area's workspace destinations, published
  // to the SAME `workspaceNav` channel SpaceDashboard feeds (Net Worth · Cash
  // Flow), so the ContextualNavbar's Space block is the desktop switcher here
  // too — one sidebar model, not a second Platform nav. Each row carries its
  // canonical deep link (open-in-new-tab / copy-link) and selects IN PLACE
  // through the same setter the rail uses; the icon is the contract's icon
  // NAME (client-safe string data), resolved by the sidebar. Cleared on
  // unmount exactly like identity and sections.
  const publishWorkspaceNav = useSpaceWorkspaceNavPublisher();
  const workspaceItems = useMemo(
    () => available.map((w) => ({ id: w.key, label: w.label, href: platformWorkspaceHref(area, w.key), icon: w.icon })),
    [available, area],
  );
  const openWorkspaceId = active?.workspaceId ?? activeTab;
  useEffect(() => {
    publishWorkspaceNav({ items: workspaceItems, activeId: openWorkspaceId, onSelect: setActiveTab });
  }, [publishWorkspaceNav, workspaceItems, openWorkspaceId, setActiveTab]);
  useEffect(() => () => publishWorkspaceNav(null), [publishWorkspaceNav]);

  return (
    <SpaceShell
      // Phone-sized rail targets (the rail is the <lg switcher now).
      mobileOptimized
      // UX-P1 D1 — at lg+ the sidebar's workspace rows are THE switcher; the
      // rail shows only below lg (the exact complement of the sidebar's
      // `hidden … lg:block`), so exactly one switcher shows at any width.
      railVisibility="belowLg"
      title={spaceName}
      titleAccessory={<PlatformSpaceSwitcher spaces={grantedSpaces} currentArea={area} />}
      // it2 — one compact title line (name · switcher · access chip), no meta
      // line, and a four-equal-column rail that fits a 375 px phone.
      titleChip={<AccessChip level={accessLevel} />}
      fillCompactRail
      subtitle={chromeSubtitle}
      railOptions={railOptions}
      activeTab={openWorkspaceId}
      onSelectTab={setActiveTab}
      // Shell frame variant from the contract (platform resolves to "space" — it
      // delegates identity to the ContextualNavbar exactly like finance; see
      // SpaceMountShellConfig). Byte-identical to the prior default.
      variant={mountContext.shell.variant}
    >
      {active ? (
        <div className="flex flex-col gap-8 md:gap-10">
          {/* PLATFORM OPS PHASE 1 UX — the view control leads the body. */}
          {active.views && active.views.length > 1 && activeViewDef && active.viewControl === "drilldown" && !isDefaultView && (
            <PlatformDrilldownBack
              label={available.find((w) => w.key === active.workspaceId)?.label ?? active.workspaceId}
              viewLabel={activeViewDef.label}
              onBack={() => setActiveView(active.views![0].id)}
            />
          )}
          {active.views && active.views.length > 1 && activeViewDef && active.viewControl !== "drilldown" && (
            <PlatformViewSwitcher
              views={active.views}
              activeView={activeViewDef.id}
              onSelect={setActiveView}
              workspaceLabel={available.find((w) => w.key === active.workspaceId)?.label ?? active.workspaceId}
            />
          )}
          {/* The area's editorial lede opens its Overview — the "operating
              environment" identity. Detail workspaces and views (Jobs/Providers/…)
              skip it and lead straight with their content. */}
          {/* PLATFORM OPS 2.0 (R2) — a view with a summary-first LEAD opens on
              its status header instead (no editorial paragraph above verdicts). */}
          {active.workspaceId === "platform-overview" && isDefaultView && !activeViewDef?.lead && (
            <PlatformAreaHero area={area} accessLevel={accessLevel} />
          )}
          <PlatformWorkspaceBody
            /* OPS-2C-6 — keyed by workspace (and, since Phase 1 UX, by VIEW —
               a view is a former workspace) so the operational session is
               DISCARDED on switch. Without this the provider would be reused and
               a return visit would serve the previous session's answers as
               current; refetch-on-return is the verified, honest behaviour. */
            key={`${active.workspaceId}:${activeViewDef?.id ?? ""}`}
            sectionKeys={activeSections ?? active.sections}
            doorways={isDefaultView ? active.doorways : undefined}
            dbByKey={dbByKey}
            access={mountContext.access}
            onOpen={setActiveTab}
            lead={activeViewDef?.lead}
            hosted={activeViewDef?.hosted}
          />
        </div>
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">No workspaces configured for this area.</p>
      )}
    </SpaceShell>
  );
}
