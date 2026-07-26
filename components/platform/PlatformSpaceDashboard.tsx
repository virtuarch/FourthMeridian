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
 *   • Sidebar — identity AND the active workspace's SECTION anchors are published
 *     up through the ONE SpaceChrome bridge customer workspaces use, so the
 *     ContextualNavbar's Sections block serves both domains from one model.
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

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import {
  useSpaceChromePublisher,
  useSpaceSectionsPublisher,
  type SpaceChromeSection,
} from "@/lib/space/space-chrome-context";
import type { SpaceMountContext } from "@/lib/space/mount-context";
import type { LucideIcon } from "lucide-react";
import { LayoutDashboard, Timer, PlugZap, Wrench, BellRing, History, Sparkles, Gauge, RefreshCw, ArrowRight } from "lucide-react";
import type { PlatformArea } from "@prisma/client";
import { SpaceShell, type SpaceShellRailOption } from "@/components/space/shell/SpaceShell";
import { getPlatformAreaWorkspaces, getPlatformWorkspace } from "@/lib/platform/workspaces";
import { PlatformAreaHero } from "./PlatformAreaHero";
import type { PlatformSection } from "./widget-kit";
import { SecAuditFeedWidget } from "./widgets/SecAuditFeedWidget";
import { SecOperatorActionsWidget } from "./widgets/SecOperatorActionsWidget";
import { SecAuthPostureWidget } from "./widgets/SecAuthPostureWidget";
import { SecSessionsWidget } from "./widgets/SecSessionsWidget";
import { SecAnomaliesWidget } from "./widgets/SecAnomaliesWidget";
import { OpsJobHealthWidget } from "./widgets/OpsJobHealthWidget";
import { OpsRateLimitsWidget } from "./widgets/OpsRateLimitsWidget";
import { OpsEnvStatusWidget } from "./widgets/OpsEnvStatusWidget";
import { OpsApiUsageWidget } from "./widgets/OpsApiUsageWidget";
import { OpsConnectionHealthWidget } from "./widgets/OpsConnectionHealthWidget";
import { OpsConnectionDiagnosticsWidget } from "./widgets/OpsConnectionDiagnosticsWidget";
import { OpsEmailDeliveryWidget } from "./widgets/OpsEmailDeliveryWidget";
import { OpsResourceFreshnessWidget } from "./widgets/OpsResourceFreshnessWidget";
import { OpsManualOperationsWidget } from "./widgets/OpsManualOperationsWidget";
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
import { OpsPlatformHealthWidget } from "./widgets/OpsPlatformHealthWidget";
import { WorkspaceSessionProvider } from "./workspace-session";
import { GrowthSignupsWidget } from "./widgets/GrowthSignupsWidget";
import { GrowthBetaRequestsWidget } from "./widgets/GrowthBetaRequestsWidget";
import { OpsUsersWidget } from "./widgets/OpsUsersWidget";
import { OpsActivityWidget } from "./widgets/OpsActivityWidget";
import { OpsGrowthWidget } from "./widgets/OpsGrowthWidget";
import { CsSyncIssuesWidget } from "./widgets/CsSyncIssuesWidget";

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
const PLATFORM_WIDGET_REGISTRY: Record<
  string,
  ComponentType<{ section: Section; onOpenWorkspace?: (id: string) => void }>
> = {
  // Security Operations
  sec_audit_feed:       SecAuditFeedWidget,
  sec_operator_actions: SecOperatorActionsWidget,
  sec_auth_posture:     SecAuthPostureWidget,
  sec_sessions:     SecSessionsWidget,
  sec_anomalies:    SecAnomaliesWidget,
  // Platform Operations
  ops_job_health:         OpsJobHealthWidget,
  ops_rate_limits:        OpsRateLimitsWidget,
  ops_env_status:         OpsEnvStatusWidget,
  ops_api_usage:          OpsApiUsageWidget,
  ops_connection_health:  OpsConnectionHealthWidget,
  ops_connection_diagnostics: OpsConnectionDiagnosticsWidget,
  ops_email_delivery:     OpsEmailDeliveryWidget,
  ops_resource_freshness: OpsResourceFreshnessWidget,
  ops_manual_operations:  OpsManualOperationsWidget,
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
  // Growth & Revenue
  growth_signups:       GrowthSignupsWidget,
  growth_beta_requests: GrowthBetaRequestsWidget,
  growth_users:         OpsUsersWidget,
  growth_activity:      OpsActivityWidget,
  growth_funnel:        OpsGrowthWidget,
  // Customer Success
  cs_sync_issues: CsSyncIssuesWidget,
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

/** The DB rows a workspace actually RENDERS: composed, enabled, and backed by a
 *  widget. A composed key with no enabled row, or no widget, renders nothing. */
function resolveWorkspaceRows(
  sectionKeys: readonly string[],
  dbByKey: ReadonlyMap<string, Section>,
): Section[] {
  return sectionKeys
    .map((key) => dbByKey.get(key))
    .filter((row): row is Section => row != null && PLATFORM_WIDGET_REGISTRY[row.key] != null);
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
  sectionKeys: readonly string[],
  dbByKey: ReadonlyMap<string, Section>,
): SpaceChromeSection[] {
  return sectionKeys
    .map((key) => dbByKey.get(key))
    .filter((row): row is Section => row != null)
    .map((row) => ({
      label: row.label,
      anchor: PLATFORM_WIDGET_REGISTRY[row.key] != null ? platformSectionAnchor(row.key) : null,
    }));
}

/** Stable empty composition — keeps the sections memo from re-firing per render. */
const NO_SECTION_KEYS: readonly string[] = [];

/** Lucide icon-name → component, for the Platform workspace identities. */
const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Timer, PlugZap, Wrench, BellRing, History, Sparkles, Gauge, RefreshCw,
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
}


/** A summary→detail doorway button (Overview only). */
function WorkspaceDoorway({ targetId, onOpen }: { targetId: string; onOpen: (id: string) => void }) {
  const def = getPlatformWorkspace(targetId);
  if (!def) return null;
  const Icon = WORKSPACE_ICONS[def.icon] ?? ArrowRight;
  return (
    <button
      onClick={() => onOpen(targetId)}
      className="flex items-center justify-between gap-2 rounded-[var(--radius-lg)] border p-4 text-left transition-colors hover:bg-[var(--glass-ultrathin)]"
      style={{ background: "var(--surface-muted)", borderColor: "var(--border-hairline)" }}
    >
      <span className="flex items-center gap-2">
        <span
          className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
          style={{ background: "var(--glass-ultrathin)", color: "var(--text-muted)" }}
        >
          <Icon size={14} />
        </span>
        <span className="text-sm font-semibold text-[var(--text-primary)]">Open {def.label}</span>
      </span>
      <ArrowRight size={14} className="text-[var(--text-muted)]" />
    </button>
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
}: {
  sectionKeys: readonly string[];
  doorways?:   readonly string[];
  dbByKey:     Map<string, Section>;
  onOpen:      (id: string) => void;
}) {
  const rows = resolveWorkspaceRows(sectionKeys, dbByKey);

  return (
    <div className="flex flex-col gap-8 md:gap-10 pb-16">
      {rows.length === 0 ? (
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
            {rows.map((row) => {
              const Widget = PLATFORM_WIDGET_REGISTRY[row.key];
              /* The scroll target for the sidebar's Sections list. Structural
                 only — a wrapper carrying the key-derived id (and the sticky-
                 header offset customer workspaces use), never a layout change:
                 the row is still one child of the same editorial stack. */
              return (
                <div key={row.id} id={platformSectionAnchor(row.key)} className="scroll-mt-20">
                  <Widget section={row} onOpenWorkspace={onOpen} />
                </div>
              );
            })}
          </div>
        </WorkspaceSessionProvider>
      )}

      {doorways && doorways.length > 0 && (
        <section aria-label="Explore">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] mb-3">Explore</p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3">
            {doorways.map((id) => (
              <WorkspaceDoorway key={id} targetId={id} onOpen={onOpen} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function PlatformSpaceDashboard({ area, sections, mountContext }: Props) {
  // ── Identity / display / navigation / access / shell — ALL from the shared
  //    contract (PS-6C). Nothing here is rebuilt from a second local derivation. ──
  const spaceName   = mountContext.display.name;
  const areaLabel   = mountContext.display.label ?? "";
  const accessLevel = mountContext.access.level;
  const { available, selectedKey } = mountContext.workspaces;

  const [activeTab, setActiveTab] = useState<string>(selectedKey);

  // Operational COMPOSITION (which section keys + doorways each workspace renders)
  // stays Platform-owned — it is data-needs metadata, NOT mount context, and is
  // deliberately absent from the neutral contract. Keyed by the same workspace ids
  // the contract's rail exposes, so rail and body stay consistent by construction.
  const composition = getPlatformAreaWorkspaces(area);
  const dbByKey = useMemo(() => new Map(sections.map((s) => [s.key, s] as const)), [sections]);

  // Rail navigation is the CONTRACT's workspace projection (key/label/icon NAME),
  // not a second registry walk here. Resolving the icon name → component is the
  // consuming surface's concern (the contract is client-safe string data).
  const railOptions: SpaceShellRailOption[] = available.map((w) => {
    const Icon = WORKSPACE_ICONS[w.icon] ?? LayoutDashboard;
    return { id: w.key, label: w.label, icon: <Icon size={14} aria-hidden /> };
  });

  const active = composition.find((w) => w.workspaceId === activeTab) ?? composition[0];

  // SHELL migration — publish platform identity to the ContextualNavbar's Space
  // mode (the same transforming sidebar customer Spaces use; platform Spaces are
  // count-based, so no FX and no Manage). The operator's access level, formerly a
  // toolbar badge, folds into the subtitle so no information is lost.
  const router = useRouter();
  const { publishSpace, publishCurrencyControl } = useSpaceChromePublisher();
  const chromeSubtitle = `Platform · ${areaLabel} · ${accessLevel}`;
  useEffect(() => {
    publishCurrencyControl(null);
    publishSpace({
      identity: { name: spaceName, subtitle: chromeSubtitle },
      onLeave: () => router.push("/dashboard/spaces"),
    });
    return () => publishSpace(null);
  }, [publishSpace, publishCurrencyControl, spaceName, chromeSubtitle, router]);

  // SECTIONS — the ACTIVE workspace's "what's inside" list, published UP to the
  // same ContextualNavbar block customer workspaces feed (SpaceChrome sections
  // channel). Keyed on the active workspace's composed keys, so switching the
  // rail re-publishes; cleared on unmount exactly like the identity above, so
  // leaving a platform Space never leaves its sections behind in the sidebar.
  const publishSections = useSpaceSectionsPublisher();
  const chromeSections = useMemo(
    () => platformChromeSections(active?.sections ?? NO_SECTION_KEYS, dbByKey),
    [active, dbByKey],
  );
  useEffect(() => {
    publishSections(chromeSections);
    return () => publishSections([]);
  }, [publishSections, chromeSections]);

  return (
    <SpaceShell
      title={spaceName}
      subtitle={chromeSubtitle}
      railOptions={railOptions}
      activeTab={active?.workspaceId ?? activeTab}
      onSelectTab={setActiveTab}
      // Shell frame variant from the contract (platform resolves to "space" — it
      // delegates identity to the ContextualNavbar exactly like finance; see
      // SpaceMountShellConfig). Byte-identical to the prior default.
      variant={mountContext.shell.variant}
    >
      {active ? (
        <div className="flex flex-col gap-8 md:gap-10">
          {/* The area's editorial lede opens its Overview — the "operating
              environment" identity. Detail workspaces (Jobs/Providers/…) skip it
              and lead straight with their content. */}
          {active.workspaceId === "platform-overview" && (
            <PlatformAreaHero area={area} accessLevel={accessLevel} />
          )}
          <PlatformWorkspaceBody
            /* OPS-2C-6 — keyed by workspace so the operational session is
               DISCARDED on switch. Without this the provider would be reused and
               a return visit would serve the previous session's answers as
               current; refetch-on-return is the verified, honest behaviour. */
            key={active.workspaceId}
            sectionKeys={active.sections}
            doorways={active.doorways}
            dbByKey={dbByKey}
            onOpen={setActiveTab}
          />
        </div>
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">No workspaces configured for this area.</p>
      )}
    </SpaceShell>
  );
}
