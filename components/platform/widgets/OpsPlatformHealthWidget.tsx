"use client";

/**
 * components/platform/widgets/OpsPlatformHealthWidget.tsx  (PM-1 · UX-P1 · ops_platform_health)
 *
 * The COMPACT TECHNICAL POSTURE of Platform Operations: Alerts · Providers ·
 * Freshness · Configuration, as FOUR GROUPS INSIDE ONE SURFACE. The Overview's
 * status board carries the same four verdicts as chips; this surface is where
 * an operator reads the rows behind them without leaving the Overview.
 *
 * ── WHAT CHANGED IN UX-P1, AND WHAT DID NOT ──────────────────────────────────
 * The five routes it reads — alerts, provider-health, resource-freshness,
 * rate-limits, env-status — are the ones that already shipped, called exactly
 * as authored, each with its own four fetch states. What changed is density and
 * honesty: each group leads with a ToneBadge, one headline and at most two rows;
 * everything else — the remaining rows, the provenance and the authority's
 * caveat — lives in a per-group "Details" disclosure, so no module path is
 * visible by default. The Alerts group's word now derives from the LATEST
 * evaluation's `firing` outcomes, and the delivery history is a labelled list
 * in its disclosure — a critical delivered two days ago no longer keeps
 * "Action needed" lit (platform-health-view.ts).
 *
 * ── CONFIGURATION IS NOT OPTIONAL ────────────────────────────────────────────
 * `ops_rate_limits` and `ops_env_status` are composed ONLY into the Overview
 * workspace. If this surface superseded them without representing them, both
 * would become unreachable in the product. Hence a Configuration group with two
 * sources, each with its own fetch state, so one failing never hides the other.
 *
 * ── THE SPLIT, AND WHY ───────────────────────────────────────────────────────
 * `OpsPlatformHealthWidget` fetches; `PlatformHealthSurface` renders. That is
 * what lets loading / failed / empty / populated be PROVEN by rendering the real
 * component in a test (server rendering never runs an effect, so a self-fetching
 * component can only ever demonstrate its first frame).
 *
 * ── FOUR STATES, NEVER COLLAPSED ─────────────────────────────────────────────
 * Per source: loading, failed, "the registry is empty", and answered. A failed
 * fetch says the platform could not be asked; it never renders as zero, as
 * nominal, or as nothing-to-see. Colour never carries meaning alone — every
 * status is a word first (ToneBadge).
 *
 * ── PER-GROUP DOORWAYS (PM-1 S3) ─────────────────────────────────────────────
 * Each group ends with a doorway into the workspace that owns its detail,
 * through the host's `onOpen(workspaceId)` callback (the rail's one navigation
 * mechanism). Without the callback the doorway renders nothing.
 */

import { useState, type ReactNode } from "react";
import { Activity, AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { useWidgetFetch, type PlatformSection } from "../widget-kit";
import { GroupLabel, Provenance, SectionSurface, ToneBadge, TwoLine } from "../platform-surface";
import { resolvePlatformDestination } from "@/lib/platform/workspaces";
import {
  GROUP_DOORWAY,
  GROUP_LABEL,
  LINE_TOKEN,
  LOADING_TEXT,
  STATUS_TONE,
  STATUS_WORD,
  SURFACE_FOOTNOTE,
  alertsView,
  doorwayLabel,
  envView,
  freshnessView,
  providersView,
  rateLimitsView,
  unavailableText,
  type HealthGroupId,
  type HealthLine,
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

function Lines({ lines }: { lines: readonly HealthLine[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {lines.map((line, i) => (
        <li key={`${line.label}:${i}`}>
          <TwoLine value={line.label} qualifier={line.detail} qualifierTone={LINE_TOKEN[line.tone]} />
        </li>
      ))}
    </ul>
  );
}

/** The per-source disclosure: provenance, the authority's caveat, the remaining rows. */
function Details({ provenance, note, lines }: { provenance: string; note?: string; lines: readonly HealthLine[] }) {
  return (
    <details>
      <summary className="cursor-pointer text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]">
        Details{lines.length > 0 ? ` (${lines.length} more)` : ""}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <Lines lines={lines} />
        <Provenance source={provenance}>{note}</Provenance>
      </div>
    </details>
  );
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
  /** The module or table that actually answers — in the disclosure, never the lead. */
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
        <Details provenance={provenance} lines={[]} />
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
        {view.status && <ToneBadge word={STATUS_WORD[view.status]} tone={STATUS_TONE[view.status]} />}
        <span className="text-xs text-[var(--text-secondary)]">{view.headline}</span>
      </div>

      <Lines lines={view.lines} />

      <Details provenance={provenance} note={view.note} lines={view.details} />
    </div>
  );
}

/**
 * The doorway out of a group and into the workspace that owns its detail.
 *
 * The LABEL is the destination resolver's (`resolvePlatformDestination`), so a
 * renamed workspace renames its doorway and cannot drift into a promise the
 * rail does not keep. A target the registry does not know renders nothing —
 * as does a surface whose host has not wired `onOpen`.
 */
function GroupDoorway({
  group,
  onOpen,
}: {
  group: HealthGroupId;
  onOpen?: (workspaceId: string) => void;
}) {
  const targetId = GROUP_DOORWAY[group];
  const def = resolvePlatformDestination(targetId);
  if (!def || !onOpen) return null;
  return (
    <button
      type="button"
      onClick={() => onOpen(targetId)}
      aria-label={doorwayLabel(def.label, group)}
      /* TOUCH TARGET. An 11px text link lays out a ~21px hit area — under the
         44px minimum. The target is enlarged by an OVERLAY (a `before`
         pseudo-element centred on the button), not by padding or min-height, so
         the box the grid measures is byte-identical at every width. */
      className="relative mt-auto flex w-fit items-center gap-1 pt-1 text-[11px] text-[var(--meridian-400)] transition-colors hover:text-[var(--meridian-300)] before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-full before:min-w-[44px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
    >
      {def.label} <ArrowRight size={10} aria-hidden />
    </button>
  );
}

/** One labelled group inside the surface. */
function HealthGroup({
  group,
  onOpen,
  children,
}: {
  group: HealthGroupId;
  onOpen?: (workspaceId: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GroupLabel>{GROUP_LABEL[group]}</GroupLabel>
      {children}
      <GroupDoorway group={group} onOpen={onOpen} />
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
  onOpenWorkspace,
}: {
  section:    PlatformSection;
  alerts:     FetchedResource<PlatformAlertsResponse>;
  providers:  FetchedResource<ProviderHealthResponse>;
  freshness:  FetchedResource<ResourceFreshnessResponse>;
  rateLimits: FetchedResource<PlatformRateLimitsResponse>;
  env:        FetchedResource<PlatformEnvStatusResponse>;
  /** Injected clock — relative ages are deterministic under test. */
  nowMs:      number;
  /** The host's rail-switch callback. Optional: without it the doorways do not render. */
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  return (
    <SectionSurface icon={Activity} title={section.label} footnote={SURFACE_FOOTNOTE}>
      {/* One frame, four groups, separated by space rather than by more boxes.
          Columns collapse through `md:`/`xl:` variants. */}
      <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-4">
        <HealthGroup group="alerts" onOpen={onOpenWorkspace}>
          <SourceBlock
            subject="Alert status"
            provenance="lib/alerts"
            state={alerts}
            build={(d) => alertsView(d, nowMs)}
          />
        </HealthGroup>

        <HealthGroup group="providers" onOpen={onOpenWorkspace}>
          <SourceBlock
            subject="Provider health"
            provenance="lib/platform/provider-health"
            state={providers}
            build={providersView}
          />
        </HealthGroup>

        <HealthGroup group="freshness" onOpen={onOpenWorkspace}>
          <SourceBlock
            subject="Resource freshness"
            provenance="lib/platform/resource-freshness"
            state={freshness}
            build={freshnessView}
          />
        </HealthGroup>

        {/* Two sources, two independent states. This group is what keeps the
            rate-limit and environment reads reachable after consolidation. */}
        <HealthGroup group="configuration" onOpen={onOpenWorkspace}>
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

export function OpsPlatformHealthWidget({
  section,
  onOpenWorkspace,
}: {
  section: PlatformSection;
  /** Passed straight through to the surface. Supplied by the workspace host. */
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  // Five reads, one per literal URL — the `useWidgetFetch` static-url contract
  // (components/platform/widget-fetch-static-url.test.ts). Nothing is merged:
  // each response is rendered by the group that asked for it.
  const alerts     = useWidgetFetch<PlatformAlertsResponse>("/api/platform/platform-ops/alerts");
  const providers  = useWidgetFetch<ProviderHealthResponse>("/api/platform/platform-ops/provider-health");
  const freshness  = useWidgetFetch<ResourceFreshnessResponse>("/api/platform/platform-ops/resource-freshness");
  const rateLimits = useWidgetFetch<PlatformRateLimitsResponse>("/api/platform/platform-ops/rate-limits");
  const env        = useWidgetFetch<PlatformEnvStatusResponse>("/api/platform/platform-ops/env-status");

  // ONE instant for the whole surface, captured at mount, so two groups can
  // never disagree about "now".
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
      onOpenWorkspace={onOpenWorkspace}
    />
  );
}
