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

import { useEffect, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { useSpaceChromePublisher } from "@/lib/space/space-chrome-context";
import type { LucideIcon } from "lucide-react";
import { LayoutDashboard, Timer, PlugZap, Wrench, BellRing, History, Sparkles, Gauge, ArrowRight } from "lucide-react";
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
import { OpsResourceFreshnessWidget } from "./widgets/OpsResourceFreshnessWidget";
import { OpsManualOperationsWidget } from "./widgets/OpsManualOperationsWidget";
import { OpsProviderHealthWidget } from "./widgets/OpsProviderHealthWidget";
import { OpsAlertsWidget } from "./widgets/OpsAlertsWidget";
import { OpsHistoryWidget } from "./widgets/OpsHistoryWidget";
import { OpsConvergenceWidget } from "./widgets/OpsConvergenceWidget";
import { OpsTimelineWidget } from "./widgets/OpsTimelineWidget";
import { OpsAiTrendWidget } from "./widgets/OpsAiTrendWidget";
import { OpsCostWidget } from "./widgets/OpsCostWidget";
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
const PLATFORM_WIDGET_REGISTRY: Record<string, ComponentType<{ section: Section }>> = {
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
  ops_resource_freshness: OpsResourceFreshnessWidget,
  ops_manual_operations:  OpsManualOperationsWidget,
  ops_provider_health:    OpsProviderHealthWidget,
  ops_alerts:             OpsAlertsWidget,
  ops_history:            OpsHistoryWidget,
  ops_convergence:        OpsConvergenceWidget,
  ops_timeline:           OpsTimelineWidget,
  ops_ai_trend:           OpsAiTrendWidget,
  ops_cost:               OpsCostWidget,
  // Growth & Revenue
  growth_signups:       GrowthSignupsWidget,
  growth_beta_requests: GrowthBetaRequestsWidget,
  growth_users:         OpsUsersWidget,
  growth_activity:      OpsActivityWidget,
  growth_funnel:        OpsGrowthWidget,
  // Customer Success
  cs_sync_issues: CsSyncIssuesWidget,
};

/** Lucide icon-name → component, for the Platform workspace identities. */
const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Timer, PlugZap, Wrench, BellRing, History, Sparkles, Gauge,
};

interface Props {
  area:        PlatformArea;
  areaLabel:   string;
  spaceName:   string;
  accessLevel: string; // READ | WRITE
  /** Enabled SpaceDashboardSection rows for this area's Space (DB, ordered). */
  sections:    Section[];
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
 * but read as a quiet "Explore" region rather than a second card grid. */
function PlatformWorkspaceBody({
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
  const rows = sectionKeys
    .map((key) => dbByKey.get(key))
    .filter((row): row is Section => row != null && PLATFORM_WIDGET_REGISTRY[row.key] != null);

  return (
    <div className="flex flex-col gap-8 md:gap-10 pb-16">
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">No sections enabled for this workspace.</p>
      ) : (
        <div className="flex flex-col gap-8 md:gap-10">
          {rows.map((row) => {
            const Widget = PLATFORM_WIDGET_REGISTRY[row.key];
            return <Widget key={row.id} section={row} />;
          })}
        </div>
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

export function PlatformSpaceDashboard({ area, areaLabel, spaceName, accessLevel, sections }: Props) {
  const workspaces = getPlatformAreaWorkspaces(area);
  const [activeTab, setActiveTab] = useState<string>(workspaces[0]?.workspaceId ?? "platform-overview");

  const dbByKey = new Map(sections.map((s) => [s.key, s] as const));

  const railOptions: SpaceShellRailOption[] = workspaces.map((w) => {
    const def = getPlatformWorkspace(w.workspaceId);
    const Icon = (def && WORKSPACE_ICONS[def.icon]) ?? LayoutDashboard;
    return { id: w.workspaceId, label: def?.label ?? w.workspaceId, icon: <Icon size={14} aria-hidden /> };
  });

  const active = workspaces.find((w) => w.workspaceId === activeTab) ?? workspaces[0];

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

  return (
    <SpaceShell
      title={spaceName}
      subtitle={chromeSubtitle}
      railOptions={railOptions}
      activeTab={active?.workspaceId ?? activeTab}
      onSelectTab={setActiveTab}
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
