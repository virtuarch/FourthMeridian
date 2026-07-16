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

import { useState, type ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { LayoutDashboard, Timer, PlugZap, Wrench, BellRing, History, ArrowRight } from "lucide-react";
import type { PlatformArea } from "@prisma/client";
import { SpaceShell, type SpaceShellRailOption } from "@/components/space/shell/SpaceShell";
import { getPlatformAreaWorkspaces, getPlatformWorkspace } from "@/lib/platform/workspaces";
import type { PlatformSection } from "./widget-kit";
import { SecAuditFeedWidget } from "./widgets/SecAuditFeedWidget";
import { SecAuthPostureWidget } from "./widgets/SecAuthPostureWidget";
import { SecSessionsWidget } from "./widgets/SecSessionsWidget";
import { SecAnomaliesWidget } from "./widgets/SecAnomaliesWidget";
import { OpsJobHealthWidget } from "./widgets/OpsJobHealthWidget";
import { OpsRateLimitsWidget } from "./widgets/OpsRateLimitsWidget";
import { OpsEnvStatusWidget } from "./widgets/OpsEnvStatusWidget";
import { OpsApiUsageWidget } from "./widgets/OpsApiUsageWidget";
import { OpsConnectionHealthWidget } from "./widgets/OpsConnectionHealthWidget";
import { OpsResourceFreshnessWidget } from "./widgets/OpsResourceFreshnessWidget";
import { OpsManualOperationsWidget } from "./widgets/OpsManualOperationsWidget";
import { OpsProviderHealthWidget } from "./widgets/OpsProviderHealthWidget";
import { OpsAlertsWidget } from "./widgets/OpsAlertsWidget";
import { OpsHistoryWidget } from "./widgets/OpsHistoryWidget";
import { OpsConvergenceWidget } from "./widgets/OpsConvergenceWidget";
import { OpsTimelineWidget } from "./widgets/OpsTimelineWidget";
import { OpsCostWidget } from "./widgets/OpsCostWidget";
import { GrowthSignupsWidget } from "./widgets/GrowthSignupsWidget";
import { GrowthBetaRequestsWidget } from "./widgets/GrowthBetaRequestsWidget";
import { OpsUsersWidget } from "./widgets/OpsUsersWidget";
import { OpsActivityWidget } from "./widgets/OpsActivityWidget";
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
  sec_audit_feed:   SecAuditFeedWidget,
  sec_auth_posture: SecAuthPostureWidget,
  sec_sessions:     SecSessionsWidget,
  sec_anomalies:    SecAnomaliesWidget,
  // Platform Operations
  ops_job_health:         OpsJobHealthWidget,
  ops_rate_limits:        OpsRateLimitsWidget,
  ops_env_status:         OpsEnvStatusWidget,
  ops_api_usage:          OpsApiUsageWidget,
  ops_connection_health:  OpsConnectionHealthWidget,
  ops_resource_freshness: OpsResourceFreshnessWidget,
  ops_manual_operations:  OpsManualOperationsWidget,
  ops_provider_health:    OpsProviderHealthWidget,
  ops_alerts:             OpsAlertsWidget,
  ops_history:            OpsHistoryWidget,
  ops_convergence:        OpsConvergenceWidget,
  ops_timeline:           OpsTimelineWidget,
  ops_cost:               OpsCostWidget,
  // Growth & Revenue
  growth_signups:       GrowthSignupsWidget,
  growth_beta_requests: GrowthBetaRequestsWidget,
  growth_users:         OpsUsersWidget,
  growth_activity:      OpsActivityWidget,
  // Customer Success
  cs_sync_issues: CsSyncIssuesWidget,
};

/** Lucide icon-name → component, for the Platform workspace identities. */
const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Timer, PlugZap, Wrench, BellRing, History,
};

interface Props {
  area:        PlatformArea;
  areaLabel:   string;
  spaceName:   string;
  accessLevel: string; // READ | WRITE
  /** Enabled SpaceDashboardSection rows for this area's Space (DB, ordered). */
  sections:    Section[];
}

function AccessBadge({ level }: { level: string }) {
  const isWrite = level === "WRITE";
  return (
    <span
      className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border"
      style={
        isWrite
          ? { background: "rgba(201,155,60,.14)", color: "var(--brass-300)", borderColor: "rgba(201,155,60,.3)" }
          : { background: "rgba(59,130,246,.1)", color: "var(--meridian-400)", borderColor: "rgba(125,168,255,.24)" }
      }
    >
      {level} access
    </span>
  );
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

/** One workspace body — its composed section widgets (+ Overview doorways). */
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
    <div className="pb-16 flex flex-col gap-4 md:gap-5">
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">No sections enabled for this workspace.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-4 md:gap-5">
          {rows.map((row) => {
            const Widget = PLATFORM_WIDGET_REGISTRY[row.key];
            return <Widget key={row.id} section={row} />;
          })}
        </div>
      )}

      {doorways && doorways.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-2">Explore</p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3">
            {doorways.map((id) => (
              <WorkspaceDoorway key={id} targetId={id} onOpen={onOpen} />
            ))}
          </div>
        </div>
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

  return (
    <SpaceShell
      title={spaceName}
      subtitle={`Platform · ${areaLabel}`}
      toolbar={<AccessBadge level={accessLevel} />}
      railOptions={railOptions}
      activeTab={active?.workspaceId ?? activeTab}
      onSelectTab={setActiveTab}
    >
      {active ? (
        <PlatformWorkspaceBody
          sectionKeys={active.sections}
          doorways={active.doorways}
          dbByKey={dbByKey}
          onOpen={setActiveTab}
        />
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">No workspaces configured for this area.</p>
      )}
    </SpaceShell>
  );
}
