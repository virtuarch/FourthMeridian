"use client";

/**
 * components/platform/leads/EconomicsEntitlementsLead.tsx  (Platform Economics — Entitlements)
 *
 * "What does each policy group cost us, and what if its allowance changed?"
 *
 *   A  Cost by policy group — one row per group: its cost this cycle (status chip;
 *      opens the group's customers as opaque refs), customers with cost, and the
 *      group's configured daily AI allowance. Plus what could not be attributed.
 *   B  Scenario — HYPOTHETICAL and READ-ONLY: pick a group and a daily allowance,
 *      read GET …/economics/scenario (a GET; it writes nothing). The result is
 *      labelled HYPOTHETICAL everywhere it appears. There is NO apply / save
 *      control: changing a policy happens in Policies, never here.
 *
 * Presentation only — figures from entitlements-core.ts, words from economics-model.ts.
 */

import { useEffect, useState } from "react";
import { Block, Surface } from "@/components/atlas/Surface";
import { useSharedWidgetFetch } from "../workspace-session";
import type { PlatformViewLeadProps } from "./lead-contract";
import type { Fetched } from "../ops-visual/ops-visual-model";
import type { EconomicsFigure } from "@/lib/platform/economics/snapshot-core";
import type { EconomicsEntitlementsView, EconomicsScenario } from "@/lib/platform/economics/entitlements-core";
import { ChartMessage, Doorway } from "./visual-kit";
import { allowanceText, figureSubText, figureValueText, rowValueText, scenarioHeadline } from "./economics-model";
import { EconomicsDrillDrawer, EconomicsStatusChip, FigureTile, useEconomicsDrill } from "./EconomicsOverviewLead";

export const ECONOMICS_ENTITLEMENTS_URL = "/api/platform/platform-ops/economics/entitlements";
export const ECONOMICS_SCENARIO_URL = "/api/platform/platform-ops/economics/scenario";
export const SCENARIO_ROWS = 5;

const FIELD = "min-h-11 min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-transparent px-2 text-xs text-[var(--text-secondary)] lg:min-h-8";

/** The scenario's read path (a GET — the only request the scenario can make). */
export function scenarioPath(group: string, allowanceUsd: string): string {
  return `${ECONOMICS_SCENARIO_URL}?${new URLSearchParams({ group, allowance: allowanceUsd }).toString()}`;
}

/** The HYPOTHETICAL result, in its own words. Rendered from the route's payload only. */
export function ScenarioResult({ s }: { s: EconomicsScenario }) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-hypothetical="true" data-econ-scenario={s.group.key}>
      <span className="inline-flex w-fit items-center rounded-full border border-dashed border-[var(--border-hairline-strong)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{s.label}</span>
      <p className="break-words text-sm font-semibold tabular-nums text-[var(--text-primary)]" data-econ-scenario-headline>{scenarioHeadline(s)}</p>
      <p className="break-words text-[11px] text-[var(--text-muted)]">
        {`${s.group.label}: ${allowanceText(s.currentAllowanceUsd)} → proposed $${s.proposedAllowanceUsd.toFixed(2)} / day · ${s.customerDaysOver} customer-day${s.customerDaysOver === 1 ? "" : "s"} over · ${s.customersAffected} customer${s.customersAffected === 1 ? "" : "s"} affected${s.ownAllowanceCustomers > 0 ? ` · ${s.ownAllowanceCustomers} with their own allowance (not capped)` : ""}`}
      </p>
      <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
        <span>{`Recorded: ${figureValueText(s.current)}`}</span>
        <EconomicsStatusChip status={s.current.status} />
        <span>{`HYPOTHETICAL: ${figureValueText(s.hypotheticalCost)}`}</span>
        <EconomicsStatusChip status={s.hypotheticalCost.status} />
      </span>
      {s.rows.length > 0 && (
        <ul aria-label="HYPOTHETICAL per-customer effect" className="flex flex-col divide-y divide-[var(--border-hairline)]">
          {s.rows.slice(0, SCENARIO_ROWS).map((r) => (
            <li key={r.ref} className="flex min-h-11 min-w-0 items-center justify-between gap-3 py-1.5 text-[11px]">
              <span className="min-w-0 truncate font-mono text-[10px] text-[var(--text-secondary)]">{r.ref}</span>
              <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{`${rowValueText(r.currentUsd, "usd")} → ${rowValueText(r.hypotheticalUsd, "usd")}${r.ownAllowance ? " · own allowance" : ` · ${r.daysOver} d over`}`}</span>
            </li>
          ))}
        </ul>
      )}
      {s.rows.length > SCENARIO_ROWS && <p className="text-[11px] text-[var(--text-muted)]">{`${s.rows.length - SCENARIO_ROWS} more customers`}</p>}
      <p className="break-words text-[10px] leading-relaxed text-[var(--text-faint)]">{s.note}</p>
    </div>
  );
}

/** The scenario card: a group, an allowance, a READ. No apply / save control exists. */
export function ScenarioCard({ groups, initialGroup }: { groups: readonly { key: string; label: string }[]; initialGroup: string | null }) {
  const [group, setGroup] = useState<string>(initialGroup ?? groups[0]?.key ?? "");
  const [allowance, setAllowance] = useState<string>("");
  const [path, setPath] = useState<string | null>(null);
  const [res, setRes] = useState<{ key: string | null; data: EconomicsScenario | null; error: string | null }>({ key: null, data: null, error: null });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    fetch(path, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 400 ? "Pick a group and an allowance of 0–1000 USD/day" : r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
        return (await r.json()) as EconomicsScenario;
      })
      .then((data) => { if (alive) setRes({ key: path, data, error: null }); })
      .catch((e: unknown) => { if (alive) setRes({ key: path, data: null, error: e instanceof Error ? e.message : "Failed to load" }); });
    return () => { alive = false; };
  }, [path]);
  const fresh = path !== null && res.key === path;
  return (
    <Block id="econ-scenario" label="Scenario · what if a group's allowance changed?"
      hint={<span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Hypothetical</span>}>
      <Surface className="p-4 sm:p-5">
        <form className="flex min-w-0 flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (group && allowance.trim() !== "") setPath(scenarioPath(group, allowance.trim())); }} data-econ-scenario-form>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--text-muted)]">
            Policy group
            <select className={FIELD} value={group} onChange={(e) => setGroup(e.target.value)}>
              {groups.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--text-muted)]">
            Daily AI allowance (USD)
            <input className={`${FIELD} w-28`} inputMode="decimal" type="number" min={0} max={1000} step="0.5" value={allowance} onChange={(e) => setAllowance(e.target.value)} placeholder="e.g. 3" />
          </label>
          <button type="submit" className={`${FIELD} font-medium text-[var(--text-primary)]`}>Compute (read-only)</button>
        </form>
        <div className="mt-4 min-w-0">
          {!path ? <p className="text-[11px] text-[var(--text-muted)]">Computes over recorded spend only. Changes no policy — configure groups in Policies.</p>
            : fresh && res.error ? <ChartMessage>{`Scenario unavailable — ${res.error}`}</ChartMessage>
            : fresh && res.data ? <ScenarioResult s={res.data} />
            : <ChartMessage>Computing…</ChartMessage>}
        </div>
      </Surface>
    </Block>
  );
}

export interface EconomicsEntitlementsSurfaceProps {
  view: Fetched<EconomicsEntitlementsView>;
  onOpenDrill: (f: EconomicsFigure) => void;
  onOpenPolicies?: () => void;
}

export function EconomicsEntitlementsSurface({ view, onOpenDrill, onOpenPolicies }: EconomicsEntitlementsSurfaceProps) {
  const v = view.data;
  if (!v) {
    return <Surface className="p-4 sm:p-5"><ChartMessage>{view.loading ? "Reading cost by policy group…" : `Cost by policy group unavailable${view.error ? ` — ${view.error}` : ""}`}</ChartMessage></Surface>;
  }
  const live = v.groups.filter((g) => !g.archived);
  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-economics-entitlements>
      <Block id="econ-groups" label="Cost by policy group · this cycle"
        action={onOpenPolicies ? <Doorway label="Configure in Policies" onSelect={onOpenPolicies} /> : undefined}>
        <Surface className="px-4 py-2 sm:px-5">
          <ul aria-label="Policy groups" className="flex flex-col divide-y divide-[var(--border-hairline)]">
            {v.groups.map((g) => (
              <li key={g.key} className="flex min-w-0 flex-col gap-1 py-3" data-econ-group={g.key}>
                <span className="flex min-w-0 items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]">
                    {g.label}{g.isDefault ? " · default" : ""}{g.archived ? " · archived" : ""}
                  </span>
                  <EconomicsStatusChip status={g.cost.status} title={g.cost.basis} />
                </span>
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                  {g.cost.drill ? (
                    <button type="button" onClick={() => onOpenDrill(g.cost)} aria-haspopup="dialog" data-econ-tile={`group_cost.${g.key}`} data-econ-drill={g.cost.drill.href}
                      className="text-lg font-semibold tabular-nums text-[var(--text-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
                      {figureValueText(g.cost)}
                    </button>
                  ) : <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{figureValueText(g.cost)}</span>}
                  <span className="min-w-0 break-words text-[11px] text-[var(--text-muted)]">{figureSubText(g.cost)}</span>
                </span>
                <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
                  <span className="tabular-nums">{`${g.customersWithCost} customer${g.customersWithCost === 1 ? "" : "s"} with cost`}</span>
                  <span>{allowanceText(g.allowanceUsd)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Surface>
      </Block>
      <div className="grid gap-3 sm:grid-cols-2">
        <FigureTile figure={v.unattributed} onOpen={onOpenDrill} />
      </div>
      {live.length > 0 && <ScenarioCard groups={live.map((g) => ({ key: g.key, label: g.label }))} initialGroup={live.find((g) => g.isDefault)?.key ?? null} />}
      <p className="text-[10px] leading-relaxed text-[var(--text-faint)]" data-econ-note>{v.note}</p>
    </div>
  );
}

export function EconomicsEntitlementsLead({ onOpenWorkspace }: PlatformViewLeadProps) {
  const view = useSharedWidgetFetch<EconomicsEntitlementsView>(ECONOMICS_ENTITLEMENTS_URL);
  const { drill, open, close } = useEconomicsDrill();
  const title = (drill && (drill.figure === "unattributed_cost" ? view.data?.unattributed.label : view.data?.groups.find((g) => g.key === drill.group)?.label)) ?? "Records";
  return (
    <>
      <EconomicsEntitlementsSurface view={view} onOpenDrill={open} onOpenPolicies={() => onOpenWorkspace("platform-policies")} />
      <EconomicsDrillDrawer drill={drill} title={title} onClose={close} />
    </>
  );
}
