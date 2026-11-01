"use client";

/**
 * components/platform/leads/CustomerSuccessLead.tsx  (Platform Spaces 2.0 — Customer Success)
 *
 * THE CUSTOMER SUCCESS DEFAULT SCREEN — simpler than Growth or Security, in the
 * same grammar. One read (customer-success/overview) plus the audited customer
 * list, hosted in the page unchanged (its profile drawer, policy / cohort /
 * refresh / access actions, reasons and WRITE gating all stay inside it).
 *
 *   ≥ lg
 *     1  hero (who needs help) · 4 KPIs
 *     2  needs help, by reason (7) · connection health (5)
 *     3  CUSTOMERS — the list (12, hosted)
 *     4  where customers are (5) · onboarding friction by registration week (7)
 *     5  sync issues opened / resolved (8) · open now, by kind (4)
 *   < lg
 *     hero → KPIs → needs help → the list → ONE group (Onboarding · Sync issues).
 *
 * PB-4 — WHO, NOT JUST HOW MANY. Each "Who needs help, and why" row is a
 * control: it asks the hosted Customers list to filter to that reason
 * (cs-attention-link.ts) and scrolls to it, so the operator sees WHICH
 * customers, with their reasons, in the audited list. The overview stays
 * counts-only. Offered only when the list is hosted for this viewer.
 *
 * Not shown, because no authority exists: support tickets, health scores.
 */

import { useState } from "react";
import { Block, Surface } from "@/components/atlas/Surface";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { useSharedWidgetFetch } from "../workspace-session";
import type { CsOverviewResponse } from "@/lib/platform/customer/overview-types";
import type { PlatformViewLeadProps } from "./lead-contract";
import { LazyDisclosure } from "./lead-kit";
import { Caption, ChartMessage, Doorway, Segmented, goToSection } from "./visual-kit";
import { HealthHero } from "../ops-visual/HealthHero";
import { DayBars, DayBarsLegend } from "../ops-visual/DayBars";
import type { Fetched } from "../ops-visual/ops-visual-model";
import { HeatGrid } from "../charts/HeatGrid";
import { ShareBars } from "../charts/ShareBars";
import { cohortLayout } from "../charts/heatmap-model";
import { ONBOARDING_SHORT, cohortCellText, describeCohortCell } from "./growth-model";
import {
  CUSTOMER_LIST_KEY, INCIDENTS_WORKSPACE, INCIDENT_PALETTE, attentionBars, csHero, healthItems, incidentBars, stageBars,
  type CsWindow,
} from "./customer-success-model";
import type { ReactNode } from "react";
import type { AttentionFilter } from "@/lib/platform/customer/overview-types";
import { requestCustomerAttentionFilter } from "./cs-attention-link";

const n = (v: number) => v.toLocaleString("en-US");
type Group = "onboarding" | "issues";
const GRID = "grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8";

function Loading({ f, what }: { f: Fetched<unknown>; what: string }) {
  return <ChartMessage>{f.loading ? `Reading ${what}…` : `${what[0].toUpperCase()}${what.slice(1)} unavailable${f.error ? ` — ${f.error}` : ""}`}</ChartMessage>;
}

export interface CsLeadSurfaceProps {
  f: Fetched<CsOverviewResponse>;
  period: CsWindow;
  onPeriod: (w: CsWindow) => void;
  customerList: ReactNode;
  onOpenWorkspace: (id: string) => void;
  group?: Group;
  onGroup?: (g: Group) => void;
}

export function CustomerSuccessLeadSurface(p: CsLeadSurfaceProps) {
  const o = p.f.data;
  const group = p.group ?? "onboarding";
  const only = (g: Group) => (group === g ? "" : "max-lg:hidden");
  const health = o ? healthItems(o) : [];
  const cohorts = o ? cohortLayout(o.onboarding.rows, o.onboarding.stages.map((s) => ({ key: s.key, label: ONBOARDING_SHORT[s.key] ?? s.label, shown: true }))) : null;
  // PB-4 — reasons link to the list only when the list is hosted here (its READ decides).
  const showWho = p.customerList ? (filter: AttentionFilter) => { requestCustomerAttentionFilter(filter); goToSection("cs-customers"); } : null;
  const totals = o ? o.incidents.days.reduce((a, d) => ({ opened: a.opened + d.opened, resolved: a.resolved + d.resolved }), { opened: 0, resolved: 0 }) : null;

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-cs-dashboard>
      {/* 1 — hero. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-end gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">Sync-issue period</span>
          <Segmented label="Period" value={p.period} onChange={p.onPeriod} options={[{ id: "30", label: "30 d" }, { id: "90", label: "90 d" }]} />
        </div>
        <HealthHero model={{ ...csHero(p.f), actions: {
          ...(p.customerList ? { customers: { label: "Open the customer list", onSelect: () => goToSection("cs-customers") } } : {}),
          help: { label: "Show who needs help and why", onSelect: () => goToSection("cs-attention") },
          connected: { label: "Show where customers are", onSelect: () => { p.onGroup?.("onboarding"); goToSection("cs-stages"); } },
          issues: { label: "Open Incidents", onSelect: () => p.onOpenWorkspace(INCIDENTS_WORKSPACE) },
        } }} />
      </div>

      {/* 2 — needs help (7) · connection health (5). */}
      <div className={GRID}>
        <Block id="cs-attention" label="Who needs help, and why" className="min-w-0 lg:col-span-7"
          hint={<span className="text-[11px] text-[var(--text-faint)]">Now</span>}>
          <Surface className="flex flex-1 flex-col justify-center p-4 sm:p-5">
            {o ? (
              o.customers.active === 0 ? <ChartMessage>No active customers</ChartMessage> : (
                <>
                  <ShareBars items={attentionBars(o)} ariaLabel="Active customers needing help, by reason" noun="customer"
                    denominator={`of ${n(o.customers.active)} active customers · one customer can have several reasons`}
                    {...(showWho ? { onSelect: (key: string) => showWho(key as AttentionFilter), selectLabel: (b: { label: string; count: number }) => `Show the ${n(b.count)} customer${b.count === 1 ? "" : "s"}: ${b.label}` } : {})} />
                  {showWho && o.attention.customers > 0 && (
                    <button type="button" onClick={() => showWho("any")} data-attention-any
                      className="mt-2 inline-flex min-h-11 items-center self-start text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] lg:min-h-8">
                      {`Show all ${n(o.attention.customers)} who need help in the list`}
                    </button>
                  )}
                </>
              )
            ) : <Loading f={p.f} what="who needs help" />}
          </Surface>
        </Block>
        <Block id="cs-connections" label="Connection health" className="min-w-0 max-lg:hidden lg:col-span-5"
          hint={<span className="text-[11px] text-[var(--text-faint)]">Live connections</span>}>
          <Surface className="flex-1 p-4 sm:p-5">
            {o ? (
              <>
                <BreakdownWidget items={health} viewMode="donut" itemNoun="connection" formatValue={n}
                  centerTotal={{ value: o.connections.total, label: "connections" }} centerTone="neutral" emptyHeadline="No live connections" />
                {(o.connections.retired.revoked + o.connections.retired.ownerInactive) > 0 && (
                  <Caption>{`${n(o.connections.retired.revoked)} revoked · ${n(o.connections.retired.ownerInactive)} on deactivated accounts — not counted`}</Caption>
                )}
              </>
            ) : <Loading f={p.f} what="connection health" />}
          </Surface>
        </Block>
      </div>

      {/* 3 — the customer list, first-class (hosted unchanged). */}
      {p.customerList && (
        <section id="cs-customers" aria-label="Customers" className="min-w-0 scroll-mt-20" data-customer-list-slot>{p.customerList}</section>
      )}

      {/* < lg — one group at a time. */}
      <div className="flex justify-center lg:hidden">
        <Segmented label="Analytics" value={group} onChange={(g) => p.onGroup?.(g)}
          options={[{ id: "onboarding", label: "Onboarding" }, { id: "issues", label: "Sync issues" }]} />
      </div>

      {/* 4 — onboarding: where customers are (5) · friction by registration week (7). */}
      <div className={`${GRID} ${only("onboarding")}`} data-group="onboarding">
        <Block id="cs-stages" label="Where customers are" className="min-w-0 lg:col-span-5"
          hint={<span className="text-[11px] text-[var(--text-faint)]">Furthest stage reached</span>}>
          <Surface className="flex-1 p-4 sm:p-5">
            {o ? <ShareBars items={stageBars(o)} ariaLabel="Active customers by the furthest onboarding stage reached" noun="customer"
              denominator={`of ${n(o.customers.active)} active customers · strict funnel, now`} /> : <Loading f={p.f} what="onboarding stages" />}
          </Surface>
        </Block>
        <Block id="cs-friction" label="Onboarding friction by registration week" className="min-w-0 lg:col-span-7">
          <Surface className="flex-1 p-4 sm:p-5">
            {o && cohorts ? (
              o.onboarding.rows.some((r) => r.size > 0) ? (
                <>
                  <HeatGrid layout={cohorts} rowHeight={26} labelWidth={74} domainMax={1} cellText={cohortCellText} legend={{ low: "0%", high: "100%" }}
                    ariaLabel="Share of each registration week's active customers that got through each onboarding stage"
                    describe={(r, c, cell) => describeCohortCell(o.onboarding.rows[r], o.onboarding.stages[c].label, cell, "customers")} />
                  <Caption>A pale cell is where a week&apos;s customers stall · as of today</Caption>
                </>
              ) : <ChartMessage>No customers registered in the last 8 weeks</ChartMessage>
            ) : <Loading f={p.f} what="cohorts" />}
          </Surface>
        </Block>
      </div>

      {/* 5 — sync issues: trend (8) · open by kind (4). */}
      <div className={`${GRID} ${only("issues")}`} data-group="issues">
        <Block id="cs-incidents" label="Sync issues" className="min-w-0 lg:col-span-8"
          action={<Doorway label="Incidents" onSelect={() => p.onOpenWorkspace(INCIDENTS_WORKSPACE)} />}>
          <Surface className="flex-1 p-4 sm:p-5">
            {o && totals ? (
              <>
                <DayBars days={incidentBars(o)} height={200} noun="lifecycle event" palette={INCIDENT_PALETTE} failedWord="opened" segmentLabels={{ succeeded: "resolved", other: "other", failed: "opened" }}
                  ariaLabel="Sync-issue episodes opened and resolved per UTC day" />
                <div className="mt-2"><DayBarsLegend items={[{ label: "Resolved", color: INCIDENT_PALETTE.succeeded }, { label: "Opened", color: INCIDENT_PALETTE.failed }]} /></div>
                <Caption>{`${n(totals.opened)} opened · ${n(totals.resolved)} resolved · ${o.windowDays} UTC days${o.incidents.floor ? " · at least (read cap)" : ""}`}</Caption>
              </>
            ) : <Loading f={p.f} what="sync issues" />}
          </Surface>
        </Block>
        <Block id="cs-open-issues" label="Open now, by kind" className="min-w-0 lg:col-span-4">
          <Surface className="flex-1 px-4 py-2 sm:px-5">
            {!o ? <Loading f={p.f} what="open issues" /> : o.incidents.openByKind.length === 0 ? (
              <p className="py-3 text-xs text-[var(--text-secondary)]">No unresolved sync issues.</p>
            ) : (
              <ul className="flex flex-col" aria-label="Unresolved sync-issue episodes by kind">
                {o.incidents.openByKind.map((k) => (
                  <li key={k.kind} className="flex min-h-10 items-center justify-between gap-3 border-t border-[var(--border-hairline)] text-xs first:border-t-0">
                    <span className="min-w-0 truncate text-[var(--text-primary)]">{k.label}</span>
                    <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">{n(k.count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Surface>
        </Block>
      </div>

      {/* 6 — how measured. */}
      {o && (
        <LazyDisclosure title="How these figures are measured" hint="sources and what is not available">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[11px] text-[var(--text-muted)]">{o.notes.map((t) => <li key={t}>{t}</li>)}</ul>
        </LazyDisclosure>
      )}
    </div>
  );
}

export function CustomerSuccessLead({ renderHosted, hasHosted, onOpenWorkspace }: PlatformViewLeadProps) {
  const [period, setPeriod] = useState<CsWindow>("30");
  const [group, setGroup] = useState<Group>("onboarding");
  const f = useSharedWidgetFetch<CsOverviewResponse>(`/api/platform/customer-success/overview?window=${period}`);
  return (
    <CustomerSuccessLeadSurface f={f} period={period} onPeriod={setPeriod} onOpenWorkspace={onOpenWorkspace} group={group} onGroup={setGroup}
      customerList={hasHosted(CUSTOMER_LIST_KEY) ? renderHosted(CUSTOMER_LIST_KEY, onOpenWorkspace) : null} />
  );
}
