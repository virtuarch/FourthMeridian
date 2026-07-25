"use client";

/**
 * components/platform/widgets/OpsPlatformHealthWidget.tsx  (PM-1 · ops_platform_health)
 *
 * The consolidated supporting surface for Platform Operations Overview:
 * Alerts · Providers · Freshness · Configuration, as FOUR GROUPS INSIDE ONE
 * SURFACE instead of five equal-weight cards in a flat grid.
 *
 * ── WHAT CHANGED IS THE FRAMING, NOT THE FACTS ───────────────────────────────
 * Nothing was removed and nothing new was computed. The five routes it reads —
 * alerts, provider-health, resource-freshness, rate-limits, env-status — are the
 * ones that already shipped, called exactly as authored. What goes away is five
 * bordered cards each with its own eyebrow and its own three-figure stat grid,
 * which gave five supporting reads the same weight as the two surfaces that
 * actually decide the operator's next move (Scheduler, Jobs).
 *
 * ── CONFIGURATION IS NOT OPTIONAL ────────────────────────────────────────────
 * `ops_rate_limits` and `ops_env_status` are composed ONLY into the Overview
 * workspace. If this surface superseded them without representing them, both
 * would become unreachable in the product — a consolidation that quietly deletes
 * two reads. Hence a Configuration group with two sources, each with its own
 * fetch state, so one failing never hides the other.
 *
 * ── THE SPLIT, AND WHY ───────────────────────────────────────────────────────
 * `OpsPlatformHealthWidget` fetches; `PlatformHealthSurface` renders. That is
 * the IncidentPreview precedent, and it is the reason loading / failed / empty /
 * populated can each be PROVEN by rendering the real component in a test rather
 * than asserted about a mock (server rendering never runs an effect, so a
 * self-fetching component can only ever demonstrate its first frame).
 *
 * ── FOUR STATES, NEVER COLLAPSED ─────────────────────────────────────────────
 * Per source: loading, failed, "the registry is empty", and answered. A failed
 * fetch says the platform could not be asked; it never renders as zero, as
 * nominal, or as nothing-to-see. Colour never carries meaning alone — every
 * status is a word first (see StatusWord in platform-surface.tsx).
 *
 * ── NON-GOALS ────────────────────────────────────────────────────────────────
 * No new route, projection, authority or schema. No drill panel and no click
 * targets: the migration plan §6 rules this a consolidated READ, not N objects.
 * No doorway buttons either — `PlatformWorkspaceComposition.doorways` already
 * owns summary→detail navigation and lives outside this file.
 */

import { useState, type ReactNode } from "react";
import { Activity, AlertTriangle, Loader2 } from "lucide-react";
import { useWidgetFetch, type PlatformSection } from "../widget-kit";
import { GroupLabel, Provenance, SectionSurface, StatusWord, TwoLine } from "../platform-surface";
import {
  LINE_TOKEN,
  LOADING_TEXT,
  STATUS_TOKEN,
  STATUS_WORD,
  SURFACE_FOOTNOTE,
  alertsView,
  envView,
  freshnessView,
  providersView,
  rateLimitsView,
  unavailableText,
  type SourceView,
} from "./platform-health-view";
import type { PlatformAlertsResponse } from "@/app/api/platform/platform-ops/alerts/route";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { ResourceFreshnessResponse } from "@/app/api/platform/platform-ops/resource-freshness/route";
import type { PlatformRateLimitsResponse } from "@/app/api/platform/platform-ops/rate-limits/route";
import type { PlatformEnvStatusResponse } from "@/app/api/platform/platform-ops/env-status/route";

/** Exactly the shape `useWidgetFetch` returns — the surface takes five of these. */
export interface FetchedResource<T> {
  data:    T | null;
  loading: boolean;
  error:   string | null;
}

/** One authority's block: its own state, its own words, its own system of record. */
function SourceBlock<T>({
  subject,
  provenance,
  caption,
  state,
  build,
}: {
  /** Names this source in the failure sentence, e.g. "Provider health". */
  subject:    string;
  /** The module or table that actually answers — never omitted. */
  provenance: string;
  /** Shown only where a group holds more than one source. */
  caption?:   string;
  state:      FetchedResource<T>;
  build:      (data: T) => SourceView;
}) {
  const head = caption ? (
    <span className="text-[11px] font-medium text-[var(--text-secondary)]">{caption}</span>
  ) : null;

  // LOADING. Deliberately not the empty state: "nothing to report" while a
  // request is still in flight is a claim we cannot support yet.
  if (state.loading) {
    return (
      <div className="flex flex-col gap-1.5">
        {head}
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status">
          <Loader2 size={12} className="animate-spin" aria-hidden /> {LOADING_TEXT}
        </p>
        <Provenance source={provenance} />
      </div>
    );
  }

  // FAILED. An error wins over any data we happen to be holding — showing the
  // last answer as if it were current is how an outage starts reading as calm.
  if (state.error || !state.data) {
    return (
      <div className="flex flex-col gap-1.5">
        {head}
        <p className="flex items-start gap-1.5 text-xs" style={{ color: "var(--coral-400)" }} role="alert">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span>{unavailableText(subject)}</span>
        </p>
        <Provenance source={provenance} />
      </div>
    );
  }

  const view = build(state.data);

  return (
    <div className="flex flex-col gap-2">
      {head}

      {/* The headline, led by the status WORD. A source with no threshold
          authority (rate-limit pressure) has status null and shows no verdict at
          all rather than borrowing a reassuring one. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {view.status && <StatusWord word={STATUS_WORD[view.status]} token={STATUS_TOKEN[view.status]} />}
        <span className="text-xs text-[var(--text-secondary)]">{view.headline}</span>
      </div>

      {view.lines.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {view.lines.map((line, i) => (
            <li key={`${line.label}:${i}`}>
              <TwoLine value={line.label} qualifier={line.detail} qualifierTone={LINE_TOKEN[line.tone]} />
            </li>
          ))}
        </ul>
      )}

      <Provenance source={provenance}>{view.note}</Provenance>
    </div>
  );
}

/** One labelled group inside the surface. Its label renders whatever its sources say. */
function HealthGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GroupLabel>{label}</GroupLabel>
      {children}
    </div>
  );
}

/**
 * The presentational surface. Prop-driven and fetch-free, so every state is
 * reachable in a test by handing it props.
 */
export function PlatformHealthSurface({
  section,
  alerts,
  providers,
  freshness,
  rateLimits,
  env,
  nowMs,
}: {
  section:    PlatformSection;
  alerts:     FetchedResource<PlatformAlertsResponse>;
  providers:  FetchedResource<ProviderHealthResponse>;
  freshness:  FetchedResource<ResourceFreshnessResponse>;
  rateLimits: FetchedResource<PlatformRateLimitsResponse>;
  env:        FetchedResource<PlatformEnvStatusResponse>;
  /** Injected clock — relative ages are deterministic under test. */
  nowMs:      number;
}) {
  return (
    <SectionSurface icon={Activity} title={section.label} footnote={SURFACE_FOOTNOTE}>
      {/* One frame, four groups, separated by space rather than by more boxes.
          Columns collapse through `md:`/`xl:` variants — production scans this
          tree, so the prototype's viewport-as-state hook is not needed here. */}
      <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-4">
        <HealthGroup label="Alerts">
          <SourceBlock
            subject="Alert status"
            provenance="lib/alerts"
            state={alerts}
            build={(d) => alertsView(d, nowMs)}
          />
        </HealthGroup>

        <HealthGroup label="Providers">
          <SourceBlock
            subject="Provider health"
            provenance="lib/platform/provider-health"
            state={providers}
            build={providersView}
          />
        </HealthGroup>

        <HealthGroup label="Freshness">
          <SourceBlock
            subject="Resource freshness"
            provenance="lib/platform/resource-freshness"
            state={freshness}
            build={freshnessView}
          />
        </HealthGroup>

        {/* Two sources, two independent states. This group is what keeps the
            rate-limit and environment reads reachable after consolidation. */}
        <HealthGroup label="Configuration">
          <SourceBlock
            caption="Environment"
            subject="Environment status"
            provenance="lib/env"
            state={env}
            build={envView}
          />
          <SourceBlock
            caption="Rate limits"
            subject="Rate-limit pressure"
            provenance="RateLimit table"
            state={rateLimits}
            build={(d) => rateLimitsView(d, nowMs)}
          />
        </HealthGroup>
      </div>
    </SectionSurface>
  );
}

export function OpsPlatformHealthWidget({ section }: { section: PlatformSection }) {
  // Five reads, one per literal URL — the `useWidgetFetch` static-url contract
  // (components/platform/widget-fetch-static-url.test.ts). Nothing is merged:
  // each response is rendered by the group that asked for it.
  const alerts     = useWidgetFetch<PlatformAlertsResponse>("/api/platform/platform-ops/alerts");
  const providers  = useWidgetFetch<ProviderHealthResponse>("/api/platform/platform-ops/provider-health");
  const freshness  = useWidgetFetch<ResourceFreshnessResponse>("/api/platform/platform-ops/resource-freshness");
  const rateLimits = useWidgetFetch<PlatformRateLimitsResponse>("/api/platform/platform-ops/rate-limits");
  const env        = useWidgetFetch<PlatformEnvStatusResponse>("/api/platform/platform-ops/env-status");

  // ONE instant for the whole surface, captured at mount. Every relative age
  // below is measured from it, so two groups can never disagree about "now" —
  // the same reason the workspace owns one operational session (OPS-2C-6).
  // Read once rather than per render: a clock read during render is impure and
  // would make the same data render differently on an unrelated re-render.
  const [nowMs] = useState(() => Date.now());

  return (
    <PlatformHealthSurface
      section={section}
      alerts={alerts}
      providers={providers}
      freshness={freshness}
      rateLimits={rateLimits}
      env={env}
      nowMs={nowMs}
    />
  );
}
