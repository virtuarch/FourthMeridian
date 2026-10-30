"use client";

/**
 * components/platform/leads/PoliciesLead.tsx  (Platform Ops visual spec §5 — Policies)
 *
 * THE POLICIES DEFAULT SCREEN — an entitlement overview in the accepted
 * Operations grammar (Personal Space language). READ-ONLY: editing policy
 * groups arrives with the policy editor (Phase 2), so there is no edit
 * affordance here — not a disabled one, not a fake one; the group detail says
 * so once. The one exception is the owner-ruled Beta reconciliation entry
 * (BetaReconciliationEntry.tsx), which creates missing assignments only and
 * never edits a group or an existing assignment.
 *
 *   ≥ lg (12-col)
 *     A  Customer policies hero (12)  covered x of y · default group · 4 KPIs
 *        (+ one "Review in Attention" doorway while anyone is exposed)
 *        (+ "Assign Beta to n unassigned accounts" — the ONE action on this
 *           screen, BetaReconciliationEntry: offered only to an operator whose
 *           access allows it and only while the dry run counts n > 0)
 *     B  Customers by group (5)        BreakdownWidget donut (groups · Unassigned · Unknown)
 *        Entitlement comparison (7)    groups (+ "Beta + Founder") × the six categories
 *     C  Policy groups (12)            2-col cards: customers · 3 key limits · Read-only
 *     D  Platform defaults · Alerts · Emergency controls (4/4/4) — summary lines
 *   < lg
 *     compact hero → 2×2 KPIs → donut card → group cards (1 col) → the three
 *     destination cards; the matrix is desktop-only (the group detail carries it).
 *
 * Drawers (ONE DetailDrawer; its body exists only while open):
 *   group      the group's entitlements by category, assignments (counts),
 *              version history and cost exposure slots
 *   catalogue  ops_policies · groups     (PolicyGroupsPanel: overlays, cohorts)
 *   defaults   ops_policies · defaults   (refresh + execution cadence, AI cost
 *                                         controls incl. the kill switch)
 *   alerts     ops_alerts
 *   emergency  ops_policies · emergency  (maintenance mode, Plaid webhook)
 * Every hosted widget renders through `renderHosted` with the operator's
 * access: its gating, reason and confirmation are its own, unchanged.
 *
 * Presentation only. Words and figures come from policies-model.ts (pure).
 */

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { DetailDrawer } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import { TONE_COLOR, type StatusTone } from "../platform-surface";
import type { PolicyGroupsResponse } from "@/app/api/platform/platform-ops/policy-groups/route";
import type { PlatformPoliciesResponse } from "@/app/api/platform/platform-ops/policies/route";
import type { JobCadenceResponse } from "@/app/api/platform/platform-ops/job-cadence/route";
import type { PlatformAlertsResponse } from "@/app/api/platform/platform-ops/alerts/route";
import type { AiCostControlsReadModel } from "@/lib/platform/ai/cost-controls.types";
import type { OperationalControlsReadModel } from "@/lib/platform/policies/operational-controls.types";
import type { PlatformViewLeadProps, RenderHosted } from "./lead-contract";
import { Caption, ChartMessage, Doorway, Meter } from "./visual-kit";
import { BetaReconciliationEntry } from "./BetaReconciliationEntry";
import { HealthHero, type HeroModel } from "../ops-visual/HealthHero";
import { StatusWord } from "../ops-visual/UnifiedJobs";
import type { Fetched } from "../ops-visual/ops-visual-model";
import {
  COST_EXPOSURE_NOTE,
  EDITING_NOTE,
  NO_ENTITLEMENTS_YET,
  VERSION_HISTORY_NOTE,
  aiControlsLine,
  alertsLine,
  comparisonMatrix,
  coverage,
  distribution,
  emergencyEngaged,
  exposure,
  groupDetail,
  heroCaption,
  heroVerdict,
  jobCadenceLine,
  keyLimits,
  killSwitchState,
  maintenanceState,
  policyColumns,
  policyKpis,
  refreshCadenceLine,
  type CellModel,
  type MatrixCategory,
  type PolicyColumn,
} from "./policies-model";

export type PoliciesDrawer =
  | { kind: "group"; key: string }
  | { kind: "catalogue" }
  | { kind: "defaults" }
  | { kind: "alerts" }
  | { kind: "emergency" };

/** Each hosted drawer: its title and the hosted key + variant it renders. */
export const POLICY_DRAWERS = {
  catalogue: { title: "Policy catalogue", key: "ops_policies", variant: "groups" },
  defaults: { title: "Platform defaults", key: "ops_policies", variant: "defaults" },
  alerts: { title: "Alerts", key: "ops_alerts", variant: undefined },
  emergency: { title: "Emergency controls", key: "ops_policies", variant: "emergency" },
} as const;

/** Where Attention lives (the Operations dashboard's "Needs attention" card). */
const ATTENTION_WORKSPACE = "platform-overview";
const n = (v: number) => v.toLocaleString("en-US");
const hhmm = (iso: string) => `Checked ${new Date(iso).toISOString().slice(11, 16)} UTC`;
const plural = (v: number, w: string) => `${n(v)} ${w}${v === 1 ? "" : "s"}`;

// ── Small read-only pieces ───────────────────────────────────────────────────

function ReadOnlyChip() {
  return (
    <span data-read-only className="shrink-0 rounded-full border border-[var(--border-hairline)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
      Read-only
    </span>
  );
}

/** A static on/off shape — a picture of the value, never a control (no role, no button). */
function ToggleShape({ on }: { on: boolean }) {
  return (
    <span aria-hidden data-toggle-shape={on ? "on" : "off"}
      className="relative inline-block h-3.5 w-6 shrink-0 rounded-full"
      style={{ background: on ? TONE_COLOR.info : "var(--border-hairline-strong, var(--border-hairline))" }}>
      <span className="absolute top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--surface-inset,#fff)]" style={{ left: on ? 12 : 2 }} />
    </span>
  );
}

/** One value against its ceiling: a toggle shape, or a meter + "10 of 25". */
export function Cell({ cell, label }: { cell: CellModel; label: string }) {
  if (cell.kind === "missing") return <span className="text-[11px] text-[var(--text-faint)]">—</span>;
  if (cell.kind === "toggle") {
    return (
      <span className="flex min-w-0 items-center gap-2" title={cell.ceilingText}>
        <ToggleShape on={cell.on} />
        <span className="text-[11px] text-[var(--text-secondary)]">{cell.text}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-baseline justify-between gap-2 text-[11px] tabular-nums">
        <span className="truncate text-[var(--text-primary)]">{cell.text}</span>
        <span className="shrink-0 text-[var(--text-faint)]">{cell.ceilingText}</span>
      </span>
      <Meter pct={cell.pct} tone="info" label={`${label}: ${cell.text} ${cell.ceilingText}`} />
    </span>
  );
}

// ── B — the comparison matrix (desktop) ──────────────────────────────────────

function ComparisonMatrix({ categories, columns }: { categories: readonly MatrixCategory[]; columns: readonly PolicyColumn[] }) {
  return (
    <table className="w-full table-fixed text-left" data-entitlement-matrix>
      <caption className="sr-only">Entitlements per policy group by category, each against the platform ceiling</caption>
      <thead>
        <tr>
          <th scope="col" className="w-[38%] pb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">Entitlement</th>
          {columns.map((c) => (
            <th key={c.key} scope="col" className="pb-2 pl-3 align-bottom">
              <span className="block truncate text-xs font-medium text-[var(--text-primary)]" title={c.title}>{c.label}</span>
              <span className="block truncate text-[10px] font-normal tabular-nums text-[var(--text-muted)]">
                {c.kind === "overlay" ? "effective" : c.isDefault ? "default" : "group"} · {n(c.customers)}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      {categories.map((cat) => (
        <tbody key={cat.id} data-category={cat.id}>
          <tr className="border-t border-[var(--border-hairline)]">
            <th scope="colgroup" colSpan={columns.length + 1} className="pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{cat.label}</th>
          </tr>
          {cat.rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + 1} className="pb-2 text-[11px] text-[var(--text-faint)]">{NO_ENTITLEMENTS_YET}</td>
            </tr>
          ) : cat.rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="truncate py-1 pr-2 text-[11px] font-normal text-[var(--text-secondary)]" title={r.label}>{r.label}</th>
              {r.cells.map((cell, i) => <td key={columns[i].key} className="py-1 pl-3 align-middle"><Cell cell={cell} label={`${columns[i].label} · ${r.label}`} /></td>)}
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

// ── C — group cards ──────────────────────────────────────────────────────────

export function GroupCard({ data, column, onSelect }: { data: PolicyGroupsResponse; column: PolicyColumn; onSelect?: () => void }) {
  const limits = keyLimits(data, column);
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]" title={column.title}>{column.label}</span>
        {column.isDefault && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">Default</span>}
        {column.kind === "overlay" && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">Overlay</span>}
        <ReadOnlyChip />
        {onSelect && <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-faint)] group-hover:text-[var(--text-secondary)]" />}
      </span>
      <span className="block text-[11px] tabular-nums text-[var(--text-secondary)]">{plural(column.customers, "customer")}</span>
      <ul aria-label={`${column.label} key limits`} className="flex flex-col gap-2">
        {limits.map((l) => (
          <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3">
            <span className="truncate text-[11px] text-[var(--text-muted)]">{l.label}</span>
            <Cell cell={l.cell} label={`${column.label} · ${l.label}`} />
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <Surface as="li" className="min-w-0">
      {onSelect ? (
        <button type="button" onClick={onSelect} aria-haspopup="dialog" data-group-card={column.key}
          className="group flex w-full min-w-0 flex-col gap-3 rounded-[var(--radius-lg)] p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
          {body}
        </button>
      ) : (
        <div data-group-card={column.key} className="flex min-w-0 flex-col gap-3 p-4">{body}</div>
      )}
    </Surface>
  );
}

// ── D — destination cards ────────────────────────────────────────────────────

/** One summary row: label + the line (a button when it opens a drawer). */
function SummaryRow({ label, value, tone, onSelect }: { label: string; value: string; tone?: StatusTone; onSelect?: () => void }) {
  const inner = (
    <>
      <span className="w-28 shrink-0 truncate text-[11px] text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-[var(--text-secondary)]">
        {tone ? <StatusWord word={value} tone={tone} /> : value}
      </span>
      {onSelect && <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)]" />}
    </>
  );
  return (
    <li className="border-t border-[var(--border-hairline)] first:border-t-0">
      {onSelect ? (
        <button type="button" onClick={onSelect} aria-haspopup="dialog" className="flex min-h-11 w-full min-w-0 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-9">{inner}</button>
      ) : (
        <div className="flex min-h-11 min-w-0 items-center gap-3 lg:min-h-9">{inner}</div>
      )}
    </li>
  );
}

// ── The surface (prop-driven, fetch-free — every state renders in a test) ────

export interface PoliciesLeadSurfaceProps {
  groups: Fetched<PolicyGroupsResponse>;
  policies: Fetched<PlatformPoliciesResponse>;
  cadence: Fetched<JobCadenceResponse>;
  costControls: Fetched<AiCostControlsReadModel>;
  operational: Fetched<OperationalControlsReadModel>;
  alerts: Fetched<PlatformAlertsResponse>;
  hasHosted: (key: string) => boolean;
  onOpenDrawer: (d: PoliciesDrawer) => void;
  onOpenWorkspace: (id: string) => void;
  /**
   * Beta reconciliation (owner ruling, 2026-10-30) — the ONE deliberate entry in
   * the hero area. The lead passes BetaReconciliationEntry, which decides on its
   * own whether to render anything; the surface only places it.
   */
  reconcileSlot?: ReactNode;
}

export function policiesHeroModel(groups: Fetched<PolicyGroupsResponse>): HeroModel {
  return {
    title: "Customer policies",
    verdict: heroVerdict(groups),
    checked: groups.data ? hhmm(groups.data.checkedAt) : null,
    caption: heroCaption(groups),
    kpis: policyKpis(groups),
    kpiLabels: { first: "Policy coverage figures", second: "Policy assignment figures", all: "Customer policy figures" },
  };
}

export function PoliciesLeadSurface(p: PoliciesLeadSurfaceProps) {
  const data = p.groups.data;
  const columns = data ? policyColumns(data) : [];
  const matrix = data ? comparisonMatrix(data, columns) : [];
  const exposed = exposure(p.groups);
  const canPolicies = p.hasHosted(POLICY_DRAWERS.defaults.key);
  const canAlerts = p.hasHosted(POLICY_DRAWERS.alerts.key);
  const open = (d: PoliciesDrawer, can: boolean) => (can ? () => p.onOpenDrawer(d) : undefined);
  const alerts = alertsLine(p.alerts);
  const engaged = emergencyEngaged(p.operational, p.costControls);
  const unread = (what: string) => (p.groups.loading ? `Reading ${what}…` : `${what[0].toUpperCase()}${what.slice(1)} unavailable${p.groups.error ? ` — ${p.groups.error}` : ""}`);

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-policies-dashboard>
      {/* A — Customer policies hero (+ the Attention doorway while anyone is exposed). */}
      <div className="min-w-0">
        <HealthHero model={policiesHeroModel(p.groups)} />
        {(exposed > 0 || p.reconcileSlot) && (
          <div className="mt-2 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 empty:hidden">
            {p.reconcileSlot}
            {exposed > 0 && (
              <span data-attention-doorway>
                <Doorway label={`${plural(exposed, "customer")} without a valid assignment · Attention`} onSelect={() => p.onOpenWorkspace(ATTENTION_WORKSPACE)} />
              </span>
            )}
          </div>
        )}
      </div>

      {/* B — Customers by group (5) · Entitlement comparison (7). */}
      <div className="grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8">
        <Block id="policies-distribution" label="Customers by group" className="min-w-0 lg:col-span-5"
          action={<span className="text-[11px] text-[var(--text-faint)]">Counts only</span>}>
          <Surface className="flex-1 p-4 sm:p-5">
            {data ? (
              <BreakdownWidget
                items={distribution(data)}
                viewMode="donut"
                itemNoun="customer"
                formatValue={(v) => n(v)}
                centerTotal={{ value: coverage(data).total, label: coverage(data).total === 1 ? "customer" : "customers" }}
                centerTone="neutral"
                emptyHeadline="No customers yet"
              />
            ) : (
              <ChartMessage>{unread("customer distribution")}</ChartMessage>
            )}
          </Surface>
        </Block>
        <Block id="policies-matrix" label="Entitlement comparison" className="min-w-0 max-lg:hidden lg:col-span-7"
          action={canPolicies && data ? <Doorway label="Catalogue" onSelect={() => p.onOpenDrawer({ kind: "catalogue" })} dialog /> : undefined}>
          <Surface className="flex-1 p-4 sm:p-5">
            {data ? (
              <>
                <ComparisonMatrix categories={matrix} columns={columns} />
                <Caption>Catalogue values against the platform ceiling · overlays shown as effective</Caption>
              </>
            ) : (
              <ChartMessage>{unread("entitlements")}</ChartMessage>
            )}
          </Surface>
        </Block>
      </div>

      {/* C — Policy groups: one card per group (and per overlay as applied). */}
      <Block id="policies-groups" label="Policy groups"
        action={canPolicies && data ? <span className="lg:hidden"><Doorway label="Catalogue" onSelect={() => p.onOpenDrawer({ kind: "catalogue" })} dialog /></span> : undefined}>
        {data && columns.length > 0 ? (
          <ul aria-label="Policy groups" className="grid min-w-0 gap-4 lg:grid-cols-2">
            {columns.map((c) => <GroupCard key={c.key} data={data} column={c} onSelect={() => p.onOpenDrawer({ kind: "group", key: c.key })} />)}
          </ul>
        ) : (
          <Surface className="px-4 py-3 sm:px-5"><p className="text-xs text-[var(--text-muted)]">{data ? "No policy group is defined" : unread("policy groups")}</p></Surface>
        )}
      </Block>

      {/* D — Platform defaults · Alerts · Emergency controls. */}
      <div className="grid items-stretch gap-6 lg:grid-cols-3 lg:gap-8">
        <Block id="policies-defaults" label="Platform defaults" className="min-w-0">
          <Surface className="flex-1 px-4 py-1.5 sm:px-5">
            <ul aria-label="Platform defaults" className="flex flex-col">
              <SummaryRow label="Refresh cadence" value={refreshCadenceLine(p.policies)} onSelect={open({ kind: "defaults" }, canPolicies)} />
              <SummaryRow label="Job cadence" value={jobCadenceLine(p.cadence)} onSelect={open({ kind: "defaults" }, canPolicies)} />
              <SummaryRow label="AI allowance" value={aiControlsLine(p.costControls)} onSelect={open({ kind: "defaults" }, canPolicies)} />
            </ul>
          </Surface>
        </Block>
        <Block id="policies-alerts" label="Alerts" className="min-w-0">
          <Surface className="flex-1 px-4 py-1.5 sm:px-5">
            <ul aria-label="Alerts" className="flex flex-col">
              <SummaryRow label="Rules" value={alerts.rules} onSelect={open({ kind: "alerts" }, canAlerts)} />
              <SummaryRow label="Last delivery" value={alerts.delivery.word} tone={alerts.delivery.tone} onSelect={open({ kind: "alerts" }, canAlerts)} />
            </ul>
          </Surface>
        </Block>
        <section id="policies-emergency" aria-label="Emergency controls" className="flex min-w-0 flex-col scroll-mt-20" data-danger-zone>
          <header className="mb-4 flex min-h-8 items-center justify-between gap-3">
            <h2 className="text-[10px] font-medium uppercase tracking-wide" style={{ color: TONE_COLOR.bad }}>Emergency controls</h2>
          </header>
          <div className="flex-1 rounded-[var(--radius-lg)] border px-4 py-1.5 sm:px-5"
            style={{ borderColor: `color-mix(in srgb, ${TONE_COLOR.bad} ${engaged ? 70 : 35}%, transparent)`, background: `color-mix(in srgb, ${TONE_COLOR.bad} ${engaged ? 8 : 3}%, var(--surface-inset))` }}>
            <ul aria-label="Emergency controls" className="flex flex-col">
              <SummaryRow label="Maintenance mode" value={maintenanceState(p.operational).word} tone={maintenanceState(p.operational).tone} onSelect={open({ kind: "emergency" }, canPolicies)} />
              {/* The kill switch is a card of AI Cost Controls (the defaults slice) — it opens there. */}
              <SummaryRow label="AI kill switch" value={killSwitchState(p.costControls).word} tone={killSwitchState(p.costControls).tone} onSelect={open({ kind: "defaults" }, canPolicies)} />
              <SummaryRow label="Plaid webhook" value="Repoint one Item · dry run first" onSelect={open({ kind: "emergency" }, canPolicies)} />
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Drawer bodies ────────────────────────────────────────────────────────────

/** The group detail: entitlements by category, assignments, version history and cost exposure slots. */
export function GroupDetailBody({ data, groupKey }: { data: PolicyGroupsResponse; groupKey: string }) {
  const d = groupDetail(data, groupKey);
  if (!d) return null;
  return (
    <div className="flex min-w-0 flex-col gap-6" data-group-detail={groupKey}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ReadOnlyChip />
        {d.column.isDefault && <span className="text-[11px] text-[var(--text-muted)]">Default group</span>}
        <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{plural(d.column.customers, "customer")}</span>
        <span className="text-[11px] text-[var(--text-faint)]" data-editing-note>{EDITING_NOTE}</span>
      </div>
      {d.categories.map((cat) => (
        <section key={cat.id} aria-label={cat.label} className="flex min-w-0 flex-col gap-2" data-category={cat.id}>
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{cat.label}</h3>
          {cat.rows.length === 0 ? (
            <p className="text-[11px] text-[var(--text-faint)]">{NO_ENTITLEMENTS_YET}</p>
          ) : (
            <ul aria-label={`${cat.label} entitlements`} className="flex flex-col gap-2">
              {cat.rows.map((r) => (
                <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4">
                  <span className="truncate text-xs text-[var(--text-secondary)]">{r.label}</span>
                  <Cell cell={r.cells[0]} label={r.label} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <section aria-label="Assignments" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Assignments</h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {d.assignments.map((a) => (
            <div key={a.label} className="min-w-0">
              <dt className="truncate text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{a.label}</dt>
              <dd className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{a.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-label="Version history" className="flex min-w-0 flex-col gap-1">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Version history</h3>
        <p className="text-[11px] text-[var(--text-muted)]">{`Effective from ${d.column.effectiveFrom} · ${VERSION_HISTORY_NOTE}`}</p>
      </section>
      <section aria-label="Cost exposure" className="flex min-w-0 flex-col gap-1">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Cost exposure</h3>
        <p className="text-[11px] text-[var(--text-muted)]" data-cost-exposure-slot>{COST_EXPOSURE_NOTE}</p>
      </section>
    </div>
  );
}

/** The ONE drawer's title, or "" when it names nothing that exists (then it stays closed). */
export function policiesDrawerTitle(d: PoliciesDrawer | null, data: PolicyGroupsResponse | null): string {
  if (!d) return "";
  if (d.kind === "group") return data ? (policyColumns(data).find((c) => c.key === d.key)?.title ?? "") : "";
  return POLICY_DRAWERS[d.kind].title;
}

/** A drawer's body (exported so hosting is provable without a DOM portal). */
export function PoliciesDrawerBody({ drawer, data, renderHosted, onOpenWorkspace }: {
  drawer: PoliciesDrawer;
  data: PolicyGroupsResponse | null;
  renderHosted: RenderHosted;
  onOpenWorkspace: (id: string) => void;
}) {
  if (drawer.kind === "group") return data ? <GroupDetailBody data={data} groupKey={drawer.key} /> : null;
  const h = POLICY_DRAWERS[drawer.kind];
  return <div className="min-w-0">{renderHosted(h.key, onOpenWorkspace, h.variant)}</div>;
}

export function PoliciesLead({ renderHosted, hasHosted, onOpenWorkspace, access }: PlatformViewLeadProps) {
  const groups = useSharedWidgetFetch<PolicyGroupsResponse>("/api/platform/platform-ops/policy-groups");
  const policies = useSharedWidgetFetch<PlatformPoliciesResponse>("/api/platform/platform-ops/policies");
  const cadence = useSharedWidgetFetch<JobCadenceResponse>("/api/platform/platform-ops/job-cadence");
  const costControls = useSharedWidgetFetch<AiCostControlsReadModel>("/api/platform/platform-ops/ai-cost-controls");
  const operational = useSharedWidgetFetch<OperationalControlsReadModel>("/api/platform/platform-ops/operational-controls");
  const alerts = useSharedWidgetFetch<PlatformAlertsResponse>("/api/platform/platform-ops/alerts");
  const [drawer, setDrawer] = useState<PoliciesDrawer | null>(null);
  // A doorway inside a drawer closes it, then moves the rail.
  const go = (id: string) => { setDrawer(null); onOpenWorkspace(id); };

  const title = policiesDrawerTitle(drawer, groups.data);
  const body: ReactNode = drawer && title ? <PoliciesDrawerBody drawer={drawer} data={groups.data} renderHosted={renderHosted} onOpenWorkspace={go} /> : null;

  return (
    <>
      <PoliciesLeadSurface groups={groups} policies={policies} cadence={cadence} costControls={costControls} operational={operational} alerts={alerts}
        hasHosted={hasHosted} onOpenDrawer={setDrawer} onOpenWorkspace={onOpenWorkspace}
        reconcileSlot={<BetaReconciliationEntry access={access} />} />
      <DetailDrawer open={drawer !== null && body !== null} onClose={() => setDrawer(null)} eyebrow="Policies" title={title} size="xl">
        {body}
      </DetailDrawer>
    </>
  );
}
