"use client";

/**
 * components/platform/widgets/GrowthPolicyGroupsWidget.tsx  (growth_policy_groups)
 *
 * The read-only Policy Group CATALOGUE for Growth & Revenue: what each group
 * allows (value beside the platform ceiling), the overlays, the cohorts, and how
 * many customers sit on each. Definitions are versioned in code; this surface
 * cannot edit them, and it names no customer — assignment is a Customer Success
 * action, which is where identity may be resolved.
 */

import { Layers } from "lucide-react";
import type { PolicyGroupsResponse } from "@/app/api/platform/growth-revenue/policy-groups/route";
import { PlatformWidgetCard, WidgetMessage, WidgetStat, useWidgetFetch, type PlatformSection } from "../widget-kit";

const show = (v: unknown) => (typeof v === "boolean" ? (v ? "on" : "off") : String(v));

export function GrowthPolicyGroupsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PolicyGroupsResponse>("/api/platform/growth-revenue/policy-groups");

  return (
    <PlatformWidgetCard label={section.label} icon={Layers}>
      {(loading || error) && <WidgetMessage loading={loading} error={error} />}
      {data && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-2">
            <WidgetStat value={data.policyGroups.reduce((n, g) => n + g.customers, 0)} label="Assigned" />
            <WidgetStat value={data.unassignedCustomers} label="On default (unassigned)" />
            <WidgetStat value={data.unknownAssignments} label="Unknown group" />
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Policy Groups</p>
            {data.policyGroups.map((g) => (
              <div key={g.key} className="rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-[var(--text-primary)]">{g.label} <span className="font-mono text-[11px] text-[var(--text-muted)]">{g.key}</span></span>
                  <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">{g.customers} customer{g.customers === 1 ? "" : "s"}{g.isDefault ? " · default" : ""}</span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-[var(--text-secondary)]">{g.description}</p>
                <table className="mt-2 w-full text-[11px]">
                  <thead><tr className="text-left text-[var(--text-muted)]"><th className="font-medium">Dimension</th><th className="font-medium">Plan</th><th className="font-medium">Ceiling</th></tr></thead>
                  <tbody>
                    {data.dimensions.map((d) => (
                      <tr key={d.key} className="border-t border-[var(--border-hairline)]">
                        <td className="py-0.5 text-[var(--text-primary)]">{d.label}</td>
                        <td className="py-0.5 tabular-nums text-[var(--text-secondary)]">{show(g.values[d.key])}</td>
                        <td className="py-0.5 tabular-nums text-[var(--text-muted)]">{show(d.ceiling)}{d.kind === "minutes-floor" ? " (floor)" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-[10px] text-[var(--text-muted)]">Effective from {g.effectiveFrom}.</p>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Overlays (explicit, audited overrides)</p>
            {data.overlays.map((o) => (
              <div key={o.key} className="rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-[var(--text-primary)]">{o.label} <span className="font-mono text-[11px] text-[var(--text-muted)]">{o.key}</span></span>
                  <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">{o.customers} customer{o.customers === 1 ? "" : "s"}</span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-[var(--text-secondary)]">{o.description}</p>
                <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                  {Object.entries(o.values).map(([k, v]) => `${data.dimensions.find((d) => d.key === k)?.label ?? k}: ${show(v)}`).join(" · ")}
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Cohorts (rollout populations — entitle nothing)</p>
            {data.cohorts.map((c) => (
              <div key={c.key} className="flex items-baseline justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-2.5">
                <span className="text-sm text-[var(--text-primary)]">{c.label} <span className="font-mono text-[11px] text-[var(--text-muted)]">{c.key}</span> <span className="text-[11px] text-[var(--text-muted)]">· entry {c.entry.toLowerCase()}</span></span>
                <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">{c.customers} customer{c.customers === 1 ? "" : "s"}</span>
              </div>
            ))}
          </div>

          <p className="text-[10px] leading-snug text-[var(--text-muted)]">
            Definitions are versioned in code and cannot be edited here. A customer is placed on the default group at registration;
            changing a customer’s group, overlay or cohort is a Customer Success action and is audited with a reason.
          </p>
        </div>
      )}
    </PlatformWidgetCard>
  );
}
