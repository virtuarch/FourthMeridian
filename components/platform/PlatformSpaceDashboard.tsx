"use client";

/**
 * components/platform/PlatformSpaceDashboard.tsx
 *
 * PO1.0 — the placeholder render surface for a platform Space. One card per
 * enabled SpaceDashboardSection, resolved through a LOCAL section registry
 * (PLATFORM_SECTION_REGISTRY) keyed by section key — the widget-registry
 * adapter *pattern* ("add one entry, no switch/case") in a platform-local map,
 * deliberately separate from the customer WIDGET_REGISTRY (untouched).
 *
 * In PO1.0 every entry renders an HONEST placeholder card naming where its real
 * adapter lands, so the gate → listing → host chain is fully exercisable
 * end-to-end before any data plumbing exists. Real widgets replace card bodies
 * one entry at a time in PO1.1+.
 *
 * No customer tab rail (SPACE_TAB_ORDER), no entry into SpaceDashboard.tsx, no
 * WIDGET_REGISTRY entries — the customer surface stays untouched.
 *
 * SD-2E — render-layer convergence. The section/widget grid now renders INSIDE the
 * universal `SpaceShell` frame (the same one customer Spaces use), as a single
 * Overview Workspace occupying the shell's workspace slot. This makes the Platform
 * Space the SECOND real consumer of the universal Space architecture — same frame,
 * same navigation primitive — WITHOUT any Platform redesign: the widgets, APIs,
 * self-fetching, sections, grant authorization, and the platform-local registries
 * below are all unchanged. Only the outer chrome is now shared, not forked. The
 * Overview Workspace's identity/composition still lives platform-locally
 * (PLATFORM_AREAS + these local registries); registering it in the canonical
 * Workspace Registry is a later composition slice — see SPACE_CONTRACT_DOCTRINE
 * Addendum II §C/§H.
 */

import type { ComponentType } from "react";
import { Wrench, LayoutDashboard } from "lucide-react";
import { SpaceShell } from "@/components/space/shell/SpaceShell";
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
import { GrowthSignupsWidget } from "./widgets/GrowthSignupsWidget";
import { GrowthBetaRequestsWidget } from "./widgets/GrowthBetaRequestsWidget";
import { CsSyncIssuesWidget } from "./widgets/CsSyncIssuesWidget";

type Section = PlatformSection;

/**
 * Platform-local widget registry: section key → the real widget component that
 * replaces its placeholder card. Mirrors the customer WIDGET_REGISTRY adapter
 * pattern ("add one entry, no switch/case") but is a SEPARATE, platform-scoped
 * map per this file's doctrine. A key with no entry here falls back to
 * PlaceholderCard unchanged — so growth_signups / cs_sync_issues (PO1.3/PO1.4)
 * stay placeholders until their slice adds an entry.
 */
const PLATFORM_WIDGET_REGISTRY: Record<string, ComponentType<{ section: Section }>> = {
  // Security Operations (PO1.1)
  sec_audit_feed:   SecAuditFeedWidget,
  sec_auth_posture: SecAuthPostureWidget,
  sec_sessions:     SecSessionsWidget,
  // Security Operations (Wave 3 ⑧)
  sec_anomalies:    SecAnomaliesWidget,
  // Platform Operations (PO1.2)
  ops_job_health:   OpsJobHealthWidget,
  ops_rate_limits:  OpsRateLimitsWidget,
  ops_env_status:   OpsEnvStatusWidget,
  // Platform Operations (Wave 2 S7 / CH-1)
  ops_api_usage:         OpsApiUsageWidget,
  ops_connection_health: OpsConnectionHealthWidget,
  // Growth & Revenue (PO1.3 / Wave 1 S3)
  growth_signups:        GrowthSignupsWidget,
  growth_beta_requests:  GrowthBetaRequestsWidget,
  // Customer Success (PO1.4)
  cs_sync_issues:   CsSyncIssuesWidget,
};

interface Props {
  areaLabel:   string;
  spaceName:   string;
  accessLevel: string; // READ | WRITE
  sections:    Section[];
}

/**
 * Local section registry: section key → the honest "what lands here, and when"
 * note shown in its placeholder card. A key with no entry falls back to a
 * generic placeholder (below) — adding a real widget later is one entry, no
 * switch/case.
 */
const PLATFORM_SECTION_REGISTRY: Record<string, { note: string }> = {
  // Platform Operations (PO1.2)
  ops_job_health:  { note: "Lands in PO1.2 — job health over lib/jobs/health.ts (checkScheduledJobHealth)." },
  ops_rate_limits: { note: "Lands in PO1.2 — rate-limit status over the RateLimit table." },
  ops_env_status:  { note: "Lands in PO1.2 — environment report over a validateEnv() report-shape refactor." },
  ops_api_usage:         { note: "Wave 2 S7 — API call/token volume over ApiUsageCounter (optional estimated spend)." },
  ops_connection_health: { note: "Wave 2 CH-1 — normalized provider-connection health over PlaidItem + Connection." },
  // Security Operations (PO1.1)
  sec_audit_feed:   { note: "Lands in PO1.1 — audit feed over the same query as /api/admin/audit." },
  sec_auth_posture: { note: "Lands in PO1.1 — TOTP/forced-2FA posture over /api/admin/security/*." },
  sec_sessions:     { note: "Lands in PO1.1 — active-session activity over UserSession." },
  // Growth & Revenue (PO1.3) — revenue has no data source until billing (v3.0).
  growth_signups:   { note: "Lands in PO1.3 — signups/activation from User.createdAt / emailVerifiedAt / UserSession. Revenue has no data source until billing (v3.0)." },
  growth_beta_requests: { note: "Wave 1 S3 — beta-access request queue over BetaAccessRequest (approve mints & emails a single-use invite)." },
  // Customer Success (PO1.4) — no CS primitives exist yet.
  cs_sync_issues:   { note: "Lands in PO1.4 — sync-issue triage over SyncIssue. No customer-success primitives exist yet." },
};

function sectionNote(key: string): string {
  return PLATFORM_SECTION_REGISTRY[key]?.note ?? "Placeholder — a real widget lands in a later PO1.x slice.";
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

function PlaceholderCard({ section }: { section: Section }) {
  return (
    <div
      className="relative overflow-hidden rounded-[var(--radius-lg)] border p-5 flex flex-col gap-3"
      style={{ background: "var(--surface-muted)", borderColor: "var(--border-hairline)" }}
    >
      <div className="flex items-center gap-2">
        <div
          className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
          style={{ background: "var(--glass-ultrathin)", color: "var(--text-muted)" }}
        >
          <Wrench size={14} />
        </div>
        <p className="font-semibold text-[var(--text-primary)] text-sm">{section.label}</p>
      </div>
      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{sectionNote(section.key)}</p>
      <span
        className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full self-start"
        style={{ background: "var(--surface-muted)", color: "var(--text-muted)", border: "1px solid var(--border-hairline)" }}
      >
        Placeholder
      </span>
    </div>
  );
}

/**
 * The Overview Workspace body — the existing self-fetching section/widget grid.
 * Unchanged from PO1.x; only its enclosing frame moved (SD-2E).
 */
function PlatformOverviewWorkspace({ sections }: { sections: Section[] }) {
  if (sections.length === 0) {
    return <p className="text-sm text-[var(--text-secondary)]">No sections configured for this area yet.</p>;
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-4 md:gap-5 pb-16">
      {sections.map((s) => {
        const Widget = PLATFORM_WIDGET_REGISTRY[s.key];
        return Widget ? <Widget key={s.id} section={s} /> : <PlaceholderCard key={s.id} section={s} />;
      })}
    </div>
  );
}

export function PlatformSpaceDashboard({ areaLabel, spaceName, accessLevel, sections }: Props) {
  // SD-2E — the Platform Space renders through the universal SpaceShell frame, the
  // same primitive customer Spaces use (DashboardChrome → SpaceShell → Workspace).
  // A Platform Space today exposes a SINGLE Overview Workspace (the section grid);
  // the rail therefore shows one destination. `onSelectTab` is a no-op because that
  // sole destination is always active — richer Platform composition (more Workspaces,
  // operational Perspectives) is a later slice, deliberately not built here.
  return (
    <SpaceShell
      title={spaceName}
      subtitle={`Platform · ${areaLabel}`}
      // The access-level indicator is a frame-level affordance, not workspace body.
      toolbar={<AccessBadge level={accessLevel} />}
      railOptions={[{ id: "overview", label: "Overview", icon: <LayoutDashboard size={14} aria-hidden /> }]}
      activeTab="overview"
      onSelectTab={NOOP_SELECT}
    >
      <PlatformOverviewWorkspace sections={sections} />
    </SpaceShell>
  );
}

/** Stable no-op: a single-Workspace Space has nothing to switch to (SD-2E). */
const NOOP_SELECT = (_tab: string): void => {};
