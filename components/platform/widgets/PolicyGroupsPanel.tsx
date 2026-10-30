/**
 * components/platform/widgets/PolicyGroupsPanel.tsx  (PLATFORM OPS PHASE 1 UX — Policies › Policy groups)
 *
 * The Policy Group catalogue, READ-ONLY, over GET /api/platform/platform-ops/policy-groups
 * (PLATFORM_OPS READ; the same reader as the Growth route,
 * lib/platform/policy-groups-read.ts):
 *
 *   counts         customers assigned · on the default (unassigned) · on an unknown group
 *   policy groups  every group (the default marked) with each entitlement
 *                  dimension's value beside the platform ceiling —
 *                  a compact matrix at md+, one card per group below md
 *   overlays       explicit, audited overrides, with their values and customer counts
 *   cohorts        rollout populations (they entitle nothing), with customer counts
 *
 * Phase 1 is read-only and says so ONCE: editing groups arrives with the
 * entitlement engine (Phase 2). There is no edit affordance — not a disabled
 * one, not a fake one — so this panel takes no access flag at all.
 *
 * Prop-driven and fetch-free: the host (OpsPoliciesWidget, variant "groups")
 * passes the shared read. Counts only — no customer identity ever reaches it.
 */

import { AlertTriangle, Layers, Loader2 } from "lucide-react";
import type { SharedFetchState } from "../workspace-session";
import { GroupLabel, SectionSurface, TONE_COLOR } from "../platform-surface";
import { LOADING_TEXT, unavailableText } from "./platform-health-view";
import type { PolicyGroupsResponse } from "@/app/api/platform/platform-ops/policy-groups/route";

export const POLICY_GROUPS_TITLE = "Policy groups";
export const POLICY_GROUPS_SUBJECT = "Policy groups";
/** The one honest line about what this view does not do yet. */
export const POLICY_GROUPS_READ_ONLY_NOTE =
  "Read-only. Definitions are versioned in code; editing policy groups arrives with the entitlement engine (Phase 2). " +
  "Changing a customer’s group, overlay or cohort is a Customer Success action, audited with a reason.";

type Value = PolicyGroupsResponse["dimensions"][number]["ceiling"];

/** One entitlement value in words: booleans as on/off, numbers as written. */
export function entitlementText(v: Value | undefined): string {
  if (v === undefined) return "—";
  return typeof v === "boolean" ? (v ? "On" : "Off") : String(v);
}

/** The ceiling, with the floor qualifier where the dimension is a floor (lower is more generous). */
export function ceilingText(d: PolicyGroupsResponse["dimensions"][number]): string {
  return `${entitlementText(d.ceiling)}${d.kind === "minutes-floor" ? " (floor)" : ""}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Count({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xl font-semibold tabular-nums text-[var(--text-primary)]">{value}</span>
      <span className="text-[11px] text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}

/** md+: dimensions down, groups across, the ceiling last — one matrix to compare groups. */
function GroupMatrix({ data }: { data: PolicyGroupsResponse }) {
  return (
    <div className="hidden min-w-0 overflow-x-auto md:block">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Entitlement value per policy group, beside the platform ceiling</caption>
        <thead>
          <tr className="text-[11px] text-[var(--text-muted)]">
            <th scope="col" className="py-1.5 pr-4 font-medium">Dimension</th>
            {data.policyGroups.map((g) => (
              <th key={g.key} scope="col" className="py-1.5 pr-4 font-medium">
                <span className="text-[var(--text-primary)]">{g.label}</span>
                {g.isDefault && <span className="ml-1.5 text-[var(--text-muted)]">· default</span>}
                <span className="block font-normal tabular-nums">{plural(g.customers, "customer")}</span>
              </th>
            ))}
            <th scope="col" className="py-1.5 font-medium">Platform ceiling</th>
          </tr>
        </thead>
        <tbody>
          {data.dimensions.map((d) => (
            <tr key={d.key} className="border-t" style={{ borderColor: "var(--border-hairline)" }}>
              <th scope="row" className="py-1.5 pr-4 font-normal text-[var(--text-primary)]">{d.label}</th>
              {data.policyGroups.map((g) => (
                <td key={g.key} className="py-1.5 pr-4 tabular-nums text-[var(--text-secondary)]">{entitlementText(g.values[d.key])}</td>
              ))}
              <td className="py-1.5 tabular-nums text-[var(--text-muted)]">{ceilingText(d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Below md: one card per group, each dimension as "value / ceiling" — no horizontal scroll. */
function GroupCards({ data }: { data: PolicyGroupsResponse }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {data.policyGroups.map((g) => (
        <li key={g.key} className="rounded-[var(--radius-sm)] border p-3" style={{ borderColor: "var(--border-hairline)" }}>
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {g.label}{g.isDefault && <span className="ml-1.5 text-[11px] font-normal text-[var(--text-muted)]">· default</span>}
            </span>
            <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">{plural(g.customers, "customer")}</span>
          </div>
          <dl className="mt-2 flex flex-col gap-1 text-xs">
            {data.dimensions.map((d) => (
              <div key={d.key} className="flex min-w-0 items-baseline justify-between gap-3">
                <dt className="min-w-0 text-[var(--text-secondary)]">{d.label}</dt>
                <dd className="shrink-0 tabular-nums text-[var(--text-primary)]">
                  {entitlementText(g.values[d.key])}
                  <span className="text-[var(--text-muted)]"> / {ceilingText(d)}</span>
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function PolicyGroupsPanel({ state }: { state: SharedFetchState<PolicyGroupsResponse> }) {
  const data = state.error ? null : state.data;
  const dimLabel = (k: string) => data?.dimensions.find((d) => d.key === k)?.label ?? k;
  return (
    <SectionSurface icon={Layers} title={POLICY_GROUPS_TITLE} footnote={POLICY_GROUPS_READ_ONLY_NOTE}>
      {state.loading ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status">
          <Loader2 size={12} className="animate-spin" aria-hidden /> {LOADING_TEXT}
        </p>
      ) : !data ? (
        <p className="flex items-start gap-1.5 text-xs" style={{ color: TONE_COLOR.bad }} role="alert">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span>{unavailableText(POLICY_GROUPS_SUBJECT)}</span>
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-3 gap-4">
            <Count value={data.policyGroups.reduce((n, g) => n + g.customers, 0)} label="Assigned" />
            <Count value={data.unassignedCustomers} label="On default (unassigned)" />
            <Count value={data.unknownAssignments} label="Unknown assignment" />
          </div>

          <div className="flex flex-col gap-3">
            <GroupLabel hint={`Customers with no assignment resolve to the default group (${data.defaultPolicyGroup}).`}>Policy groups</GroupLabel>
            <GroupMatrix data={data} />
            <GroupCards data={data} />
          </div>

          <div className="flex flex-col gap-3">
            <GroupLabel hint="Explicit, audited overrides on top of a customer's group.">Overlays</GroupLabel>
            {data.overlays.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No overlays are defined.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.overlays.map((o) => (
                  <li key={o.key} className="flex min-w-0 flex-col gap-0.5 md:flex-row md:items-baseline md:justify-between md:gap-4">
                    <span className="text-sm text-[var(--text-primary)]">{o.label}</span>
                    <span className="text-[11px] text-[var(--text-secondary)]">
                      {Object.entries(o.values).map(([k, v]) => `${dimLabel(k)}: ${entitlementText(v)}`).join(" · ")}
                      <span className="tabular-nums text-[var(--text-muted)]"> · {plural(o.customers, "customer")}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <GroupLabel hint="Rollout populations. A cohort entitles nothing on its own.">Cohorts</GroupLabel>
            {data.cohorts.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No cohorts are defined.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.cohorts.map((c) => (
                  <li key={c.key} className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm text-[var(--text-primary)]">
                      {c.label} <span className="text-[11px] text-[var(--text-muted)]">· entry {c.entry.toLowerCase()}</span>
                    </span>
                    <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">{plural(c.customers, "customer")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </SectionSurface>
  );
}
