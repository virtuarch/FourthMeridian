"use client";

/**
 * components/platform/leads/SecurityLead.tsx  (Platform Spaces 2.0 — Security)
 *
 * THE SECURITY DEFAULT SCREEN — an analytical security command centre in the
 * Growth reference grammar. One read (security-ops/analytics), counts only.
 *
 *   ≥ lg (12-col)
 *     1  period + hero                 failed sign-ins · 4 KPIs (sign-ins, failed, operator / customer 2FA)
 *     2  sign-in activity (8)          stacked: successful · blocked · credential — or access control series
 *        two-factor coverage (4)       operators · admins · customers vs enforcement
 *     3  failures by weekday × hour (6) · failure reasons (6)
 *     4  security-event calendar (6)   · detector windows + signals NOT recorded (6)
 *     5  operator activity (7)         · most frequent operator actions (5)
 *     6  how measured · posture drawer · Audit feed / Operator actions workspaces
 *   < lg
 *     compact hero → 2×2 KPIs → sign-in activity → 2FA → ONE group at a time
 *     (Sign-ins · Events · Operators) → detail nav.
 *
 * Wording: a failed sign-in is not an incident; a denial is not an attack;
 * lockouts, rate-limited attempts and verified incidents are NOT RECORDED and
 * are said to be so. Presentation only — security-model.ts owns the words.
 */

import { useState } from "react";
import { Block, Surface } from "@/components/atlas/Surface";
import { DetailDrawer, ProvenanceChip } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import type { SecurityAnalyticsResponse } from "@/lib/platform/security/analytics-types";
import type { PlatformViewLeadProps, RenderHosted } from "./lead-contract";
import { LazyDisclosure } from "./lead-kit";
import { Caption, ChartMessage, Doorway, Meter, Segmented, goToSection } from "./visual-kit";
import { HealthHero } from "../ops-visual/HealthHero";
import { DayBars, DayBarsLegend } from "../ops-visual/DayBars";
import type { Fetched } from "../ops-visual/ops-visual-model";
import { TONE_COLOR } from "../platform-surface";
import { HeatGrid } from "../charts/HeatGrid";
import { ShareBars } from "../charts/ShareBars";
import { calendarLayout, weekHourLayout } from "../charts/heatmap-model";
import { describeCalendarCell, describeWeekHourCell } from "../charts/heat-readouts";
import {
  ACCESS_PALETTE, FAILURE_PATTERN_MIN, OPERATOR_PALETTE, SECURITY_DRAWERS, SECURITY_FEEDS, SIGN_IN_PALETTE, actionBars, controlBars,
  coverageRows, eventBreakdown, eventDays, operatorBars, reasonBars, securityHero, signInBars, totals,
  type SecurityDrawer, type SecurityWindow,
} from "./security-model";

const n = (v: number) => v.toLocaleString("en-US");
type Group = "signins" | "events" | "operators";
const GRID = "grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8";

function Loading({ f, what }: { f: Fetched<unknown>; what: string }) {
  return <ChartMessage>{f.loading ? `Reading ${what}…` : `${what[0].toUpperCase()}${what.slice(1)} unavailable${f.error ? ` — ${f.error}` : ""}`}</ChartMessage>;
}

function ActivityCard({ f }: { f: Fetched<SecurityAnalyticsResponse> }) {
  const [series, setSeries] = useState<"signins" | "control">("signins");
  const s = f.data;
  const t = s ? totals(s) : null;
  return (
    <Block id="sec-activity" label="Sign-in activity" className="min-w-0 lg:col-span-8"
      hint={<ProvenanceChip kind="MEASURED" />}
      action={<Segmented label="Series" value={series} onChange={setSeries} options={[{ id: "signins", label: "Sign-ins" }, { id: "control", label: "Access control" }]} />}>
      <Surface className="flex-1 p-4 sm:p-5">
        {s && t ? (
          series === "signins" ? (
            <>
              <DayBars days={signInBars(s)} height={236} noun="sign-in attempt" palette={SIGN_IN_PALETTE}
                ariaLabel="Sign-in attempts per UTC day: successful, refused by an account gate, and credential failures" />
              <div className="mt-2"><DayBarsLegend items={[{ label: "Successful", color: SIGN_IN_PALETTE.succeeded }, { label: "Account gate (not a wrong password)", color: SIGN_IN_PALETTE.other }, { label: "Credential failure", color: SIGN_IN_PALETTE.failed }]} /></div>
              <Caption>{`${n(t.signIns)} successful · ${n(t.blocked)} account gate · ${n(t.credential)} credential failures · ${s.windowDays} UTC days`}</Caption>
            </>
          ) : (
            <>
              <DayBars days={controlBars(s)} height={236} noun="event" palette={ACCESS_PALETTE}
                ariaLabel="Access-control events per UTC day: refused policy changes, platform access denials and detector windows" />
              <div className="mt-2"><DayBarsLegend items={[{ label: "Refused change", color: ACCESS_PALETTE.succeeded }, { label: "Access denied (floor)", color: ACCESS_PALETTE.other }, { label: "Detector window", color: ACCESS_PALETTE.failed }]} /></div>
              <Caption>{`${n(t.refusals)} refused · ${n(t.denials)} denied (≤ 1 per operator per Space per hour) · ${n(t.detector)} detector windows`}</Caption>
            </>
          )
        ) : <Loading f={f} what="sign-in activity" />}
      </Surface>
    </Block>
  );
}

// ── The surface (prop-driven, fetch-free) ────────────────────────────────────

export interface SecurityLeadSurfaceProps {
  f: Fetched<SecurityAnalyticsResponse>;
  period: SecurityWindow;
  onPeriod: (w: SecurityWindow) => void;
  hasHosted: (key: string) => boolean;
  onOpenDrawer: (d: SecurityDrawer) => void;
  onOpenWorkspace: (id: string) => void;
  group?: Group;
  onGroup?: (g: Group) => void;
}

export function SecurityLeadSurface(p: SecurityLeadSurfaceProps) {
  const s = p.f.data;
  const group = p.group ?? "signins";
  const only = (g: Group) => (group === g ? "" : "max-lg:hidden");
  const drawers = SECURITY_DRAWERS.filter((d) => d.keys.some(p.hasHosted));
  const failedTotal = s ? s.failedByHour.flat().reduce((a, b) => a + b, 0) : 0;
  const cal = s ? calendarLayout(eventDays(s)) : null;
  const events = s ? eventDays(s).reduce((a, d) => a + (d.count ?? 0), 0) : 0;

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-security-dashboard>
      {/* 1 — period + hero. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-end gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">Period</span>
          <Segmented label="Period" value={p.period} onChange={p.onPeriod} options={[{ id: "30", label: "30 d" }, { id: "90", label: "90 d" }]} />
        </div>
        <HealthHero model={{ ...securityHero(p.f), actions: {
          signIns: { label: "Show sign-in activity", onSelect: () => goToSection("sec-activity") },
          failed: { label: "Show why sign-ins fail", onSelect: () => { p.onGroup?.("signins"); goToSection("sec-failure-reasons"); } },
          operators2fa: { label: "Show two-factor coverage", onSelect: () => goToSection("sec-2fa") },
          customers2fa: { label: "Show two-factor coverage", onSelect: () => goToSection("sec-2fa") },
        } }} />
      </div>

      {/* 2 — sign-in activity (8) · two-factor coverage (4). */}
      <div className={GRID}>
        <ActivityCard f={p.f} />
        <Block id="sec-2fa" label="Two-factor coverage" className="min-w-0 lg:col-span-4" hint={<span className="text-[11px] text-[var(--text-faint)]">Now</span>}>
          <Surface className="flex flex-1 flex-col gap-4 p-4 sm:p-5">
            {s ? coverageRows(s).map((r) => (
              <div key={r.key} className="flex min-w-0 flex-col gap-1.5" data-coverage={r.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-[var(--text-primary)]">{r.label}</span>
                  <span className="text-xs tabular-nums" style={{ color: r.tone === "muted" ? "var(--text-muted)" : TONE_COLOR[r.tone] }}>
                    {r.total === 0 ? "none" : `${n(r.enrolled)} of ${n(r.total)}`}
                  </span>
                </div>
                {r.pct === null ? <span role="img" aria-label={`${r.label}: no accounts`} className="block h-2 w-full rounded-full border border-dashed border-[var(--border-hairline-strong)]" />
                  : <Meter pct={r.pct} tone={r.tone} label={`${r.label} with two-factor enabled`} />}
                <span className="text-[10px] text-[var(--text-muted)]">{r.enforcement}</span>
              </div>
            )) : <Loading f={p.f} what="two-factor coverage" />}
          </Surface>
        </Block>
      </div>

      {/* < lg — one analytics group at a time. */}
      <div className="flex justify-center lg:hidden">
        <Segmented label="Analytics" value={group} onChange={(g) => p.onGroup?.(g)}
          options={[{ id: "signins", label: "Failures" }, { id: "events", label: "Events" }, { id: "operators", label: "Operators" }]} />
      </div>

      {/* 3 — failures: weekday × hour (6) · reasons (6). */}
      <div className={`${GRID} ${only("signins")}`} data-group="signins">
        {/* The weekday × hour grid is OMITTED (not drawn empty) when there are too few failures for a pattern. */}
        {(!s || failedTotal >= FAILURE_PATTERN_MIN) && (
        <Block id="sec-failure-hours" label="When sign-ins fail" className="min-w-0 lg:col-span-6">
          <Surface className="flex-1 p-4 sm:p-5">
            {!s ? <Loading f={p.f} what="failures" /> : (
              <>
                <HeatGrid layout={weekHourLayout(s.failedByHour)} rowHeight={14} labelWidth={30}
                  ariaLabel={`Failed sign-ins by weekday and UTC hour, last ${s.windowDays} days: ${n(failedTotal)}`}
                  describe={(r, c, cell) => describeWeekHourCell(r, c, cell, "failed sign-in", failedTotal)} />
                <Caption>{`${n(failedTotal)} failed sign-ins · weekday × hour, UTC · all reasons`}</Caption>
              </>
            )}
          </Surface>
        </Block>
        )}
        <Block id="sec-failure-reasons" label="Why sign-ins fail" className={`min-w-0 ${s && failedTotal < FAILURE_PATTERN_MIN ? "lg:col-span-12" : "lg:col-span-6"}`}
          hint={s && failedTotal < FAILURE_PATTERN_MIN && failedTotal > 0 ? <span className="text-[11px] text-[var(--text-faint)]">{`too few (${n(failedTotal)}) for a weekday × hour pattern`}</span> : undefined}>
          <Surface className="flex-1 p-4 sm:p-5">
            {!s ? <Loading f={p.f} what="failure reasons" /> : s.failureReasons.length === 0 ? (
              <ChartMessage>{`No failed sign-ins in ${s.windowDays} days`}</ChartMessage>
            ) : (
              <ShareBars items={reasonBars(s)} ariaLabel="Failed sign-ins by reason" noun="attempt"
                denominator={`of ${n(s.failureReasons.reduce((a, r) => a + r.count, 0))} failed sign-ins · "account gate" = stopped by the account's state, not a wrong password`} />
            )}
          </Surface>
        </Block>
      </div>

      {/* 4 — events: calendar (6) · detector windows + not recorded (6). */}
      <div className={`${GRID} ${only("events")}`} data-group="events">
        <Block id="sec-calendar" label="Security events by day" className="min-w-0 lg:col-span-6">
          <Surface className="flex-1 p-4 sm:p-5">
            {s && cal ? (
              <>
                <HeatGrid layout={cal} rowHeight={18} labelWidth={30}
                  ariaLabel={`Security events per UTC day, last ${s.windowDays} days: ${n(events)}`}
                  describe={(r, c, cell) => `${describeCalendarCell(cal.dayAt(r, c), cell, "event")}${eventBreakdown(s, cal.dayAt(r, c))}`} />
                <Caption>{`${n(events)} events · failed sign-ins, access denials, refused changes (detector windows excluded — they derive from the failures)`}</Caption>
              </>
            ) : <Loading f={p.f} what="events" />}
          </Surface>
        </Block>
        <Block id="sec-detectors" label="Detector windows" className="min-w-0 lg:col-span-6"
          hint={<span className="text-[11px] text-[var(--text-faint)]">not incidents</span>}>
          <Surface className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
            {!s ? <Loading f={p.f} what="detector windows" /> : (
              <>
                {s.detectorTypes.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">{`No detector threshold tripped in ${s.windowDays} days.`}</p>
                ) : (
                  <ul className="flex flex-col" aria-label="Detector windows by detector">
                    {s.detectorTypes.map((d) => (
                      <li key={d.type} className="flex min-h-9 items-center justify-between gap-3 border-t border-[var(--border-hairline)] text-xs first:border-t-0">
                        <span className="min-w-0 truncate text-[var(--text-primary)]">{d.label}</span>
                        <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">{n(d.count)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-auto border-t border-[var(--border-hairline)] pt-3" data-not-recorded>
                  <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">Not recorded</p>
                  <ul className="mt-1.5 flex flex-col gap-1 text-[11px] text-[var(--text-muted)]">
                    {s.unavailable.map((u) => <li key={u}>{u}</li>)}
                  </ul>
                </div>
              </>
            )}
          </Surface>
        </Block>
      </div>

      {/* 5 — operators: activity (7) · top actions (5). */}
      <div className={`${GRID} ${only("operators")}`} data-group="operators">
        <Block id="sec-operators" label="Operator activity" className="min-w-0 lg:col-span-7"
          action={<Doorway label="Operator actions" onSelect={() => p.onOpenWorkspace("platform-operator-actions")} />}>
          <Surface className="flex-1 p-4 sm:p-5">
            {s ? (
              <>
                <DayBars days={operatorBars(s)} height={200} noun="operator action" palette={OPERATOR_PALETTE}
                  ariaLabel="Audited operator actions per UTC day: done, result not recorded, refused or failed" />
                <div className="mt-2"><DayBarsLegend items={[{ label: "Done", color: OPERATOR_PALETTE.succeeded }, { label: "Result not recorded", color: OPERATOR_PALETTE.other }, { label: "Refused or failed", color: OPERATOR_PALETTE.failed }]} /></div>
                <Caption>{(() => {
                  const sum = s.operators.days.reduce((a, d) => ({ refused: a.refused + d.refused, failure: a.failure + d.failure, unknown: a.unknown + d.unknown }), { refused: 0, failure: 0, unknown: 0 });
                  return `${n(s.operators.total)} operator actions · ${n(sum.refused)} refused · ${n(sum.failure)} failed${sum.unknown ? ` · ${n(sum.unknown)} result not recorded` : ""} · ${s.windowDays} UTC days`;
                })()}</Caption>
              </>
            ) : <Loading f={p.f} what="operator activity" />}
          </Surface>
        </Block>
        <Block id="sec-top-actions" label="Most frequent operator actions" className="min-w-0 lg:col-span-5">
          <Surface className="flex-1 p-4 sm:p-5">
            {!s ? <Loading f={p.f} what="operator actions" /> : s.operators.topActions.length === 0 ? (
              <ChartMessage>{`No operator actions in ${s.windowDays} days`}</ChartMessage>
            ) : (
              <ShareBars items={actionBars(s)} ariaLabel="Operator actions by type" noun="action"
                denominator={`of ${n(s.operators.total)} operator actions in ${s.windowDays} d`} />
            )}
          </Surface>
        </Block>
      </div>

      {/* 6 — how measured · drawers · the record feeds. */}
      <div className="flex flex-col gap-2">
        {s && (
          <LazyDisclosure title="How these figures are measured" hint="sources, floors and exclusions">
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[11px] text-[var(--text-muted)]">
              {s.notes.map((t) => <li key={t}>{t}</li>)}
              {s.floor && <li>A grouped read reached its cap — figures are a floor.</li>}
            </ul>
          </LazyDisclosure>
        )}
        <nav aria-label="Security detail" className="flex flex-wrap items-center gap-x-4">
          {drawers.map((d) => <Doorway key={d.key} label={d.label} onSelect={() => p.onOpenDrawer(d.key)} dialog />)}
          {SECURITY_FEEDS.map((w) => <Doorway key={w.workspaceId} label={w.label} onSelect={() => p.onOpenWorkspace(w.workspaceId)} />)}
        </nav>
      </div>
    </div>
  );
}

export function SecurityDrawerBody({ drawer, renderHosted, onOpenWorkspace }: { drawer: SecurityDrawer; renderHosted: RenderHosted; onOpenWorkspace: (id: string) => void }) {
  const d = SECURITY_DRAWERS.find((x) => x.key === drawer);
  if (!d) return null;
  return <div className="flex flex-col gap-8">{d.keys.map((k) => <div key={k} className="min-w-0">{renderHosted(k, onOpenWorkspace)}</div>)}</div>;
}

export function SecurityLead({ renderHosted, hasHosted, onOpenWorkspace }: PlatformViewLeadProps) {
  const [period, setPeriod] = useState<SecurityWindow>("30");
  const [group, setGroup] = useState<Group>("signins");
  const f = useSharedWidgetFetch<SecurityAnalyticsResponse>(`/api/platform/security-ops/analytics?window=${period}`);
  const [drawer, setDrawer] = useState<SecurityDrawer | null>(null);
  const go = (id: string) => { setDrawer(null); onOpenWorkspace(id); };
  const d = drawer ? SECURITY_DRAWERS.find((x) => x.key === drawer) : undefined;
  return (
    <>
      <SecurityLeadSurface f={f} period={period} onPeriod={setPeriod} hasHosted={hasHosted} onOpenDrawer={setDrawer}
        onOpenWorkspace={onOpenWorkspace} group={group} onGroup={setGroup} />
      <DetailDrawer open={drawer !== null} onClose={() => setDrawer(null)} eyebrow="Security" title={d?.label ?? ""} size="xl">
        {drawer ? <SecurityDrawerBody drawer={drawer} renderHosted={renderHosted} onOpenWorkspace={go} /> : null}
      </DetailDrawer>
    </>
  );
}
