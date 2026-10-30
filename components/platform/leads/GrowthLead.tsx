"use client";

/**
 * components/platform/leads/GrowthLead.tsx  (Platform Spaces 2.0 — Growth, the reference design)
 *
 * THE GROWTH DEFAULT SCREEN — acquisition and growth intelligence in the
 * accepted Platform Ops grammar (Personal Space language). It REPLACES the seven
 * stacked Growth widgets; every one of them stays reachable in a drawer, hosted
 * unchanged — and the beta signup list is hosted IN the page, third, by owner
 * requirement ("much closer to the top").
 *
 *   order (owner hierarchy)
 *     1  period control + Growth hero          accounts · 4 KPIs
 *     2  acquisition overview (8) · waitlist (4)   requests / registrations per day · status donut
 *     3  BETA SIGNUPS (12)                     growth_beta_requests, hosted — actions, gating, audit unchanged
 *     4  acquisition: request calendar (7) · sources (5)
 *        conversion:  onboarding funnel (5) · onboarding by cohort heatmap (7)
 *     5  engagement:  active users (7) · feature adoption (5)
 *                     retention cohort heatmap (6) · time-of-week heatmap (6)
 *     6  how the figures are measured · detail drawers
 *   < lg
 *     compact hero → 2×2 KPIs → acquisition chart → beta signups → ONE analytics
 *     group at a time (Acquisition · Conversion · Engagement) → detail nav.
 *
 * Presentation only. Words and figures come from growth-model.ts (pure).
 */

import { useState, type ReactNode } from "react";
import { Block, Surface } from "@/components/atlas/Surface";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { DetailDrawer, ProvenanceChip } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import type { AcquisitionResponse } from "@/lib/platform/growth/acquisition-types";
import type { ProductAnalyticsResponse } from "@/lib/platform/growth/product-analytics-types";
import type { PlatformViewLeadProps, RenderHosted } from "./lead-contract";
import { LazyDisclosure } from "./lead-kit";
import { Caption, ChartMessage, Doorway, Segmented } from "./visual-kit";
import { HealthHero } from "../ops-visual/HealthHero";
import { DayBars } from "../ops-visual/DayBars";
import type { Fetched } from "../ops-visual/ops-visual-model";
import { HeatGrid } from "../charts/HeatGrid";
import { FunnelBars } from "../charts/FunnelBars";
import { calendarLayout, cohortLayout, weekHourLayout } from "../charts/heatmap-model";
import {
  BETA_LIST_KEY, GROWTH_COLORS, GROWTH_DRAWERS, RETENTION_COLS, TIME_OF_WEEK_MIN_EVENTS, activeBars, adoptionItems,
  cohortCellText, cohortHasHistory, countBars, describeCalendarCell, describeCohortCell, describeWeekHourCell, funnelStages,
  growthHero, seriesCaption, sourceItems, waitlistItems, type GrowthDrawer, type GrowthWindow,
} from "./growth-model";

const n = (v: number) => v.toLocaleString("en-US");
const ONE = { succeeded: GROWTH_COLORS.primary, other: GROWTH_COLORS.secondary, failed: "var(--coral-400)" } as const;
type Group = "acquisition" | "conversion" | "engagement";
const GRID = "grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8";

function Loading({ f, what }: { f: Fetched<unknown>; what: string }) {
  return <ChartMessage>{f.loading ? `Reading ${what}…` : `${what[0].toUpperCase()}${what.slice(1)} unavailable${f.error ? ` — ${f.error}` : ""}`}</ChartMessage>;
}

// ── Cards with their own toggle ──────────────────────────────────────────────

function AcquisitionCard({ acq }: { acq: Fetched<AcquisitionResponse> }) {
  const [series, setSeries] = useState<"requests" | "registrations">("requests");
  const a = acq.data;
  const days = a ? (series === "requests" ? a.requests.perDay : a.registrations.perDay) : [];
  const noun = series === "requests" ? "request" : "registration";
  return (
    <Block id="growth-acquisition" label="Acquisition" className="min-w-0 lg:col-span-8"
      hint={<ProvenanceChip kind="MEASURED" />}
      action={<Segmented label="Series" value={series} onChange={setSeries} options={[{ id: "requests", label: "Beta requests" }, { id: "registrations", label: "Registrations" }]} />}>
      <Surface className="flex-1 p-4 sm:p-5">
        {a ? (
          <>
            <DayBars days={countBars(days)} height={180} noun={noun} palette={ONE}
              ariaLabel={series === "requests" ? "Distinct beta requesters per UTC day" : "New accounts per UTC day"} />
            <Caption>{seriesCaption(days, noun)}{series === "requests" && a.coverage.requestsFrom ? ` · recorded from ${a.coverage.requestsFrom}` : ""}</Caption>
          </>
        ) : <Loading f={acq} what="acquisition" />}
      </Surface>
    </Block>
  );
}

function ActiveUsersCard({ pa }: { pa: Fetched<ProductAnalyticsResponse> }) {
  const [series, setSeries] = useState<"engaged" | "present">("engaged");
  const p = pa.data;
  return (
    <Block id="growth-active" label="Active accounts" className="min-w-0 lg:col-span-7"
      hint={<ProvenanceChip kind="MEASURED" />}
      action={<Segmented label="Activity" value={series} onChange={setSeries} options={[{ id: "engaged", label: "Engaged" }, { id: "present", label: "Signed in" }]} />}>
      <Surface className="flex-1 p-4 sm:p-5">
        {p ? (
          <>
            <DayBars days={activeBars(p, series)} height={160} noun="account" palette={ONE}
              ariaLabel={series === "engaged" ? "Accounts with meaningful product activity per UTC day" : "Accounts with an authenticated session per UTC day"} />
            <Caption>
              {series === "engaged"
                ? `${n(p.active.daily.engaged)} today · ${n(p.active.weekly.engaged)} this week · ${n(p.active.monthly.engaged)} in 30 d`
                : `${n(p.active.daily.present)} today · ${n(p.active.weekly.present)} this week · ${n(p.active.monthly.present)} in 30 d`}
            </Caption>
          </>
        ) : <Loading f={pa} what="activity" />}
      </Surface>
    </Block>
  );
}

function TimeOfWeekCard({ acq }: { acq: Fetched<AcquisitionResponse> }) {
  const [series, setSeries] = useState<"signIns" | "chat">("signIns");
  const a = acq.data;
  const grid = a ? (series === "signIns" ? a.timeOfWeek.signIns : a.timeOfWeek.chatTurns) : [];
  const total = a ? (series === "signIns" ? a.timeOfWeek.signInTotal : a.timeOfWeek.chatTotal) : 0;
  const noun = series === "signIns" ? "sign-in" : "chat turn";
  const layout = weekHourLayout(grid);
  return (
    <Block id="growth-time-of-week" label="When people use it" className="min-w-0 lg:col-span-6"
      action={<Segmented label="Activity" value={series} onChange={setSeries} options={[{ id: "signIns", label: "Sign-ins" }, { id: "chat", label: "AI chat" }]} />}>
      <Surface className="flex-1 p-4 sm:p-5">
        {!a ? <Loading f={acq} what="activity" /> : total < TIME_OF_WEEK_MIN_EVENTS ? (
          <ChartMessage>{`Only ${n(total)} ${noun}s in ${a.windowDays} days — too few to show a weekly pattern`}</ChartMessage>
        ) : (
          <>
            <HeatGrid layout={layout} rowHeight={14} labelWidth={30}
              ariaLabel={`${noun}s by weekday and UTC hour, last ${a.windowDays} days: ${n(total)}`}
              describe={(r, c, cell) => describeWeekHourCell(r, c, cell, noun, total)} />
            <Caption>{`${n(total)} ${noun}s · weekday × hour, UTC · ${a.windowDays} days`}</Caption>
          </>
        )}
      </Surface>
    </Block>
  );
}

// ── The surface (prop-driven, fetch-free — every state renders in a test) ────

export interface GrowthLeadSurfaceProps {
  acq: Fetched<AcquisitionResponse>;
  pa: Fetched<ProductAnalyticsResponse>;
  period: GrowthWindow;
  onPeriod: (w: GrowthWindow) => void;
  hasHosted: (key: string) => boolean;
  /** The beta signup list, hosted (null when the operator's Space has no such row). */
  betaList: ReactNode;
  onOpenDrawer: (d: GrowthDrawer) => void;
  /** The mobile analytics group (desktop shows all three). */
  group?: Group;
  onGroup?: (g: Group) => void;
}

export function GrowthLeadSurface(p: GrowthLeadSurfaceProps) {
  const a = p.acq.data, pa = p.pa.data;
  const group = p.group ?? "acquisition";
  const drawers = GROWTH_DRAWERS.filter((d) => d.keys.some(p.hasHosted));
  const can = (k: GrowthDrawer) => drawers.some((d) => d.key === k);
  const only = (g: Group) => (group === g ? "" : "max-lg:hidden");

  const cal = a ? calendarLayout(a.requests.perDay) : null;
  const onboarding = a ? cohortLayout(a.onboarding.rows, a.onboarding.stages.map((s) => ({ key: s.key, label: s.label, shown: true }))) : null;
  const retention = a ? cohortLayout(a.retention.rows, RETENTION_COLS) : null;
  const waitlist = a ? waitlistItems(a) : [];
  const waitlistTotal = waitlist.reduce((s, i) => s + i.value, 0);

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-growth-dashboard>
      {/* 1 — period control + hero. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-end gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">Period</span>
          <Segmented label="Period" value={p.period} onChange={p.onPeriod} options={[{ id: "30", label: "30 d" }, { id: "90", label: "90 d" }]} />
        </div>
        <HealthHero model={growthHero(p.acq, p.pa)} />
      </div>

      {/* 2 — acquisition overview (8) · waitlist (4). */}
      <div className={GRID}>
        <AcquisitionCard acq={p.acq} />
        <Block id="growth-waitlist" label="Waitlist" className="min-w-0 max-lg:hidden lg:col-span-4"
          hint={<span className="text-[11px] text-[var(--text-faint)]">Now</span>}>
          <Surface className="flex-1 p-4 sm:p-5">
            {a ? (
              <BreakdownWidget items={waitlist} viewMode="donut" itemNoun="request" formatValue={n}
                centerTotal={{ value: waitlistTotal, label: "requests" }} centerTone="neutral"
                emptyHeadline="No beta requests on record" />
            ) : <Loading f={p.acq} what="waitlist" />}
          </Surface>
        </Block>
      </div>

      {/* 3 — the beta signup list, first-class and near the top (hosted unchanged). */}
      {p.betaList && (
        <section id="growth-beta" aria-label="Beta signups" className="min-w-0 scroll-mt-20" data-beta-list-slot>
          {p.betaList}
        </section>
      )}

      {/* < lg — one analytics group at a time. */}
      <div className="flex justify-center lg:hidden">
        <Segmented label="Analytics" value={group} onChange={(g) => p.onGroup?.(g)}
          options={[{ id: "acquisition", label: "Acquisition" }, { id: "conversion", label: "Conversion" }, { id: "engagement", label: "Engagement" }]} />
      </div>

      {/* 4a — acquisition: request calendar (7) · sources (5). */}
      <div className={`${GRID} ${only("acquisition")}`} data-group="acquisition">
        <Block id="growth-calendar" label="Beta request calendar" className="min-w-0 lg:col-span-7">
          <Surface className="flex-1 p-4 sm:p-5">
            {a && cal ? (
              <>
                <HeatGrid layout={cal} rowHeight={18} labelWidth={30}
                  ariaLabel={`Distinct beta requesters per UTC day, last ${a.windowDays} days: ${n(a.requests.total)}`}
                  describe={(r, c, cell) => describeCalendarCell(cal.dayAt(r, c), cell, "requester")} />
                <Caption>{`${n(a.requests.total)} requesters · ${a.windowDays} UTC days`}</Caption>
              </>
            ) : <Loading f={p.acq} what="requests" />}
          </Surface>
        </Block>
        <Block id="growth-sources" label="Where requests come from" className="min-w-0 lg:col-span-5"
          hint={<span className="text-[11px] text-[var(--text-faint)]">{a ? `${a.windowDays} d` : ""}</span>}>
          <Surface className="flex-1 p-4 sm:p-5">
            {a ? (
              <>
                <BreakdownWidget items={sourceItems(a)} viewMode="bar" itemNoun="requester" formatValue={n}
                  emptyHeadline={a.sourcesUnrecorded > 0 ? "No requester in the window carried a source" : "No beta requests in the window"} />
                {a.sourcesUnrecorded > 0 && <Caption>{`${n(a.sourcesUnrecorded)} with no recorded source (direct or untagged)`}</Caption>}
              </>
            ) : <Loading f={p.acq} what="sources" />}
          </Surface>
        </Block>
      </div>

      {/* 4b — conversion: funnel (5) · onboarding by cohort (7). */}
      <div className={`${GRID} ${only("conversion")}`} data-group="conversion">
        <Block id="growth-funnel" label="Onboarding funnel" className="min-w-0 lg:col-span-5"
          hint={<span className="text-[11px] text-[var(--text-faint)]">All time</span>}
          action={can("funnel") ? <Doorway label="Stages" onSelect={() => p.onOpenDrawer("funnel")} dialog /> : undefined}>
          <Surface className="flex-1 p-4 sm:p-5">
            {pa ? (
              <>
                <FunnelBars stages={funnelStages(pa)} ariaLabel="Onboarding funnel, strict: each stage counts accounts that reached it and every stage before"
                  onSelect={can("funnel") ? () => p.onOpenDrawer("funnel") : undefined} droppedNoun={`stalled > ${pa.retention.abandonmentHorizonDays} d`} />
                <Caption>Strict funnel · bars are shares of registered accounts</Caption>
              </>
            ) : <Loading f={p.pa} what="the funnel" />}
          </Surface>
        </Block>
        <Block id="growth-onboarding-cohorts" label="Onboarding by registration week" className="min-w-0 lg:col-span-7">
          <Surface className="flex-1 p-4 sm:p-5">
            {a && onboarding ? (
              a.onboarding.rows.some((r) => r.size > 0) ? (
                <>
                  <HeatGrid layout={onboarding} rowHeight={24} labelWidth={74} domainMax={1} cellText={cohortCellText}
                    legend={{ low: "0%", high: "100%" }}
                    ariaLabel="Share of each registration week's accounts that got through each onboarding stage"
                    describe={(r, c, cell) => describeCohortCell(a.onboarding.rows[r], a.onboarding.stages[c].label, cell, "accounts")} />
                  <Caption>Row = registration week · accounts · cells = share through the stage, as of today</Caption>
                </>
              ) : <ChartMessage>No registrations in the last 8 weeks</ChartMessage>
            ) : <Loading f={p.acq} what="cohorts" />}
          </Surface>
        </Block>
      </div>

      {/* 5 — engagement: active (7) · adoption (5); retention (6) · time of week (6). */}
      <div className={`space-y-8 max-lg:space-y-6! ${only("engagement")}`} data-group="engagement">
        <div className={GRID}>
          <ActiveUsersCard pa={p.pa} />
          <Block id="growth-adoption" label="Feature adoption" className="min-w-0 lg:col-span-5"
            hint={<span className="text-[11px] text-[var(--text-faint)]">30 d</span>}>
            <Surface className="flex-1 p-4 sm:p-5">
              {pa ? (
                <BreakdownWidget items={adoptionItems(pa)} viewMode="bar" itemNoun="feature" formatValue={(v) => `${n(v)} accounts`}
                  emptyHeadline="No feature use in the last 30 days" />
              ) : <Loading f={p.pa} what="adoption" />}
            </Surface>
          </Block>
        </div>
        <div className={GRID}>
          <Block id="growth-retention" label="Retention by registration week" className="min-w-0 lg:col-span-6">
            <Surface className="flex-1 p-4 sm:p-5">
              {a && retention ? (
                cohortHasHistory(a.retention.rows) ? (
                  <>
                    <HeatGrid layout={retention} rowHeight={24} labelWidth={74} domainMax={1} cellText={cohortCellText}
                      legend={{ low: "0%", high: "100%" }}
                      ariaLabel="Share of each registration week's accounts engaged in each following week"
                      describe={(r, c, cell) => describeCohortCell(a.retention.rows[r], `week ${c}`, cell, "engaged")} />
                    <Caption>{`W0 = registration week · engaged = product activity · recorded from ${a.coverage.engagementFrom ?? "—"}`}</Caption>
                  </>
                ) : <ChartMessage>Not enough engagement history yet for a retention heatmap</ChartMessage>
              ) : <Loading f={p.acq} what="retention" />}
            </Surface>
          </Block>
          <TimeOfWeekCard acq={p.acq} />
        </div>
      </div>

      {/* 6 — how the figures are measured, then the former widgets in drawers. */}
      <div className="flex flex-col gap-2">
        {(a || pa) && (
          <LazyDisclosure title="How these figures are measured" hint="sources, coverage and exclusions">
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[11px] text-[var(--text-muted)]">
              {[...(a?.notes ?? []), ...(pa?.exclusions ?? [])].map((t) => <li key={t}>{t}</li>)}
            </ul>
          </LazyDisclosure>
        )}
        {drawers.length > 0 && (
          <nav aria-label="Growth detail" className="flex flex-wrap items-center gap-x-4">
            {drawers.map((d) => <Doorway key={d.key} label={d.label} onSelect={() => p.onOpenDrawer(d.key)} dialog />)}
          </nav>
        )}
      </div>
    </div>
  );
}

/** A drawer's body: its hosted widgets through the registry. */
export function GrowthDrawerBody({ drawer, renderHosted, onOpenWorkspace }: { drawer: GrowthDrawer; renderHosted: RenderHosted; onOpenWorkspace: (id: string) => void }) {
  const d = GROWTH_DRAWERS.find((x) => x.key === drawer);
  if (!d) return null;
  return <div className="flex flex-col gap-8">{d.keys.map((k) => <div key={k} className="min-w-0">{renderHosted(k, onOpenWorkspace)}</div>)}</div>;
}

export function GrowthLead({ renderHosted, hasHosted, onOpenWorkspace }: PlatformViewLeadProps) {
  const [period, setPeriod] = useState<GrowthWindow>("30");
  const [group, setGroup] = useState<Group>("acquisition");
  const acq = useSharedWidgetFetch<AcquisitionResponse>(`/api/platform/growth-revenue/acquisition?window=${period}`);
  const pa = useSharedWidgetFetch<ProductAnalyticsResponse>("/api/platform/growth-revenue/product-analytics");
  const [drawer, setDrawer] = useState<GrowthDrawer | null>(null);
  const go = (id: string) => { setDrawer(null); onOpenWorkspace(id); };
  const d = drawer ? GROWTH_DRAWERS.find((x) => x.key === drawer) : undefined;

  return (
    <>
      <GrowthLeadSurface acq={acq} pa={pa} period={period} onPeriod={setPeriod} hasHosted={hasHosted}
        betaList={hasHosted(BETA_LIST_KEY) ? renderHosted(BETA_LIST_KEY, onOpenWorkspace) : null}
        onOpenDrawer={setDrawer} group={group} onGroup={setGroup} />
      <DetailDrawer open={drawer !== null} onClose={() => setDrawer(null)} eyebrow="Growth" title={d?.label ?? ""} size="xl">
        {drawer ? <GrowthDrawerBody drawer={drawer} renderHosted={renderHosted} onOpenWorkspace={go} /> : null}
      </DetailDrawer>
    </>
  );
}
