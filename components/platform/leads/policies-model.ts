/**
 * components/platform/leads/policies-model.ts  (Platform Ops visual spec §5 — Policies)
 *
 * PURE view-model behind the Policies dashboard. No React, no fetch, no clock.
 * Every figure comes from an existing PLATFORM_OPS READ route:
 *
 *   policy-groups          the catalogue (definitions from code) + customer COUNTS
 *                          (no identity) → hero, distribution donut, comparison
 *                          matrix, group cards and the group detail
 *   policies               refresh cadence (Bank / Wallet)          → defaults card
 *   job-cadence            execution cadence per job                → defaults card
 *   ai-cost-controls       allowance, alerts, the AI kill switch    → defaults + emergency
 *   operational-controls   maintenance mode                          → emergency card
 *   alerts                 rules + the latest evaluation's delivery → alerts card
 *
 * READ-ONLY (Phase 1). Editing policy groups arrives with the policy editor
 * (Phase 2): nothing here models an edit, a draft or a pending change — the
 * model has no edit affordance to offer (pinned by platform-visual-policies.test.ts).
 *
 * THE SIX CATEGORIES (owner, 2026-10-30) map the nine catalogue dimensions with
 * plain-English labels, each dimension exactly once; a category with no
 * dimension says "No entitlements yet" instead of inventing one.
 *
 * EFFECTIVE VALUES. A column "Beta + Founder" is the overlay applied on top of
 * the default group and clamped to the platform ceiling — the same CEILING →
 * POLICY → OVERLAY precedence lib/entitlements/resolve.ts applies, restated here
 * for catalogue values only (a per-customer AI allowance override or platform
 * setting is NOT in this view; the defaults card reports the allowance in force).
 */

import type { PolicyGroupsResponse } from "@/app/api/platform/platform-ops/policy-groups/route";
import type { PlatformPoliciesResponse } from "@/app/api/platform/platform-ops/policies/route";
import type { JobCadenceResponse } from "@/app/api/platform/platform-ops/job-cadence/route";
import type { PlatformAlertsResponse } from "@/app/api/platform/platform-ops/alerts/route";
import type { AiCostControlsReadModel } from "@/lib/platform/ai/cost-controls.types";
import type { OperationalControlsReadModel } from "@/lib/platform/policies/operational-controls.types";
import type { StatusTone } from "../platform-surface";
import type { Fetched, Kpi } from "../ops-visual/ops-visual-model";

type Dimension = PolicyGroupsResponse["dimensions"][number];
type Value = Dimension["ceiling"];

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, word: string) => `${n(v)} ${word}${v === 1 ? "" : "s"}`;

/** The one honest line about editing (said once, on the group detail). */
export const EDITING_NOTE = "Editing arrives with the policy editor";
export const VERSION_HISTORY_NOTE = "Arrives with the policy editor";
export const COST_EXPOSURE_NOTE = "Arrives with policy economics";

// ── Categories ────────────────────────────────────────────────────────────────

export type CategoryId = "connections" | "refresh" | "crypto" | "ai" | "insights" | "exports";

/** The owner's six categories, in order, with the dimensions each speaks for. */
export const POLICY_CATEGORIES: readonly { id: CategoryId; label: string; dimensions: readonly string[] }[] = [
  { id: "connections", label: "Connections & accounts", dimensions: ["maxConnections"] },
  { id: "refresh", label: "Refresh & synchronization", dimensions: ["manualBankRefreshCooldownMinutes", "manualWalletRefreshPerHour"] },
  { id: "crypto", label: "Crypto history & data coverage", dimensions: [] },
  { id: "ai", label: "AI features & allowances", dimensions: ["conversations", "aiTurnsPerMinute", "aiTurnsPerHour", "aiDailyUsdAllowance"] },
  { id: "insights", label: "Financial insights & reports", dimensions: ["dailyBrief"] },
  { id: "exports", label: "Exports & premium features", dimensions: ["exportsPerDay"] },
];

export const NO_ENTITLEMENTS_YET = "No entitlements yet";

/** Plain-English names (the catalogue label stays the technical name in the catalogue drawer). */
export const PLAIN_LABEL: Readonly<Record<string, string>> = {
  maxConnections: "Connected institutions & wallets",
  manualBankRefreshCooldownMinutes: "Manual bank refresh",
  manualWalletRefreshPerHour: "Manual wallet syncs per hour",
  conversations: "Conversations",
  aiTurnsPerMinute: "Messages per minute",
  aiTurnsPerHour: "Messages per hour",
  aiDailyUsdAllowance: "Daily AI allowance (est.)",
  dailyBrief: "Daily Brief",
  exportsPerDay: "Data exports per day",
};

/** The three limits a group card shows. */
export const KEY_LIMITS: readonly string[] = ["maxConnections", "aiDailyUsdAllowance", "exportsPerDay"];

// ── Values vs ceilings ────────────────────────────────────────────────────────

/** A value as the comparison draws it: a toggle (boolean) or a meter vs the ceiling. */
export type CellModel =
  | { kind: "toggle"; on: boolean; text: string; ceilingText: string }
  | { kind: "meter"; pct: number; text: string; ceilingText: string; atCeiling: boolean }
  | { kind: "missing"; text: string };

const money = (v: number) => `$${n(v)}`;

/** The value clamped to the platform ceiling (the resolver's precedence, catalogue values only). */
export function clampToCeiling(d: Dimension, v: Value): Value {
  if (d.kind === "boolean") return Boolean(v) && Boolean(d.ceiling);
  const num = Math.max(0, Number(v));
  // A floor ("minutes-floor"): the ceiling is the SHORTEST wait — a value may not go below it.
  return d.kind === "minutes-floor" ? Math.max(num, Number(d.ceiling)) : Math.min(num, Number(d.ceiling));
}

/** One dimension's value, drawn against its ceiling. A floor's meter is how close it is to the fastest allowed. */
export function cellModel(d: Dimension, v: Value | undefined): CellModel {
  if (v === undefined) return { kind: "missing", text: "—" };
  if (d.kind === "boolean") return { kind: "toggle", on: Boolean(v), text: v ? "On" : "Off", ceilingText: d.ceiling ? "allowed" : "off at the platform" };
  const value = Number(v);
  const ceiling = Number(d.ceiling);
  if (d.kind === "minutes-floor") {
    const pct = value <= 0 ? 100 : Math.min(100, (ceiling / value) * 100);
    return { kind: "meter", pct, text: `every ${minutes(value)}`, ceilingText: `fastest ${minutes(ceiling)}`, atCeiling: value <= ceiling };
  }
  const fmt = d.key === "aiDailyUsdAllowance" ? money : n;
  const pct = ceiling <= 0 ? 0 : Math.min(100, (value / ceiling) * 100);
  return { kind: "meter", pct, text: fmt(value), ceilingText: `of ${fmt(ceiling)}`, atCeiling: value >= ceiling };
}

function minutes(m: number): string {
  if (m >= 1440 && m % 1440 === 0) return `${n(m / 1440)} d`;
  if (m >= 60 && m % 60 === 0) return `${n(m / 60)} h`;
  return `${n(m)} min`;
}

// ── Columns: groups, then each overlay on the default group ───────────────────

export interface PolicyColumn {
  key: string;
  /** Short header ("Beta", "Beta + Founder"). */
  label: string;
  /** Full catalogue name(s). */
  title: string;
  kind: "group" | "overlay";
  isDefault: boolean;
  customers: number;
  /** The definition's effective-from date (ISO day). */
  effectiveFrom: string;
  /** Effective catalogue values (clamped to the ceiling). */
  values: Record<string, Value>;
}

/** "Beta — full access (v1)" → "Beta"; "Founder / internal (v1)" → "Founder". */
export function shortName(label: string): string {
  return label.split(/\s+[—–/(-]\s*|\s+\(/)[0].trim() || label;
}

export const MAX_COLUMNS = 4;

export function policyColumns(data: PolicyGroupsResponse): PolicyColumn[] {
  const dims = data.dimensions;
  const clampAll = (values: Record<string, Value>) =>
    Object.fromEntries(dims.filter((d) => values[d.key] !== undefined).map((d) => [d.key, clampToCeiling(d, values[d.key])]));
  const groups: PolicyColumn[] = data.policyGroups.map((g) => ({
    key: g.key, label: shortName(g.label), title: g.label, kind: "group", isDefault: g.isDefault, customers: g.customers, effectiveFrom: g.effectiveFrom, values: clampAll(g.values),
  }));
  const base = data.policyGroups.find((g) => g.isDefault) ?? data.policyGroups[0];
  const overlays: PolicyColumn[] = base
    ? data.overlays.map((o) => ({
        key: `${base.key}+${o.key}`, label: `${shortName(base.label)} + ${shortName(o.label)}`, title: `${base.label} with ${o.label}`,
        kind: "overlay", isDefault: false, customers: o.customers, effectiveFrom: o.effectiveFrom, values: clampAll({ ...base.values, ...o.values }),
      }))
    : [];
  return [...groups, ...overlays].slice(0, MAX_COLUMNS);
}

/** The matrix: categories × columns, each dimension once. */
export interface MatrixCategory {
  id: CategoryId;
  label: string;
  rows: { key: string; label: string; cells: CellModel[] }[];
}

export function comparisonMatrix(data: PolicyGroupsResponse, columns: readonly PolicyColumn[] = policyColumns(data)): MatrixCategory[] {
  const byKey = new Map(data.dimensions.map((d) => [d.key as string, d] as const));
  return POLICY_CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    rows: c.dimensions.flatMap((k) => {
      const d = byKey.get(k);
      return d ? [{ key: k, label: PLAIN_LABEL[k] ?? d.label, cells: columns.map((col) => cellModel(d, col.values[k])) }] : [];
    }),
  }));
}

/** Catalogue dimensions no category speaks for (must be empty — pinned). */
export function uncategorised(data: PolicyGroupsResponse): string[] {
  const mapped = new Set(POLICY_CATEGORIES.flatMap((c) => c.dimensions));
  return data.dimensions.map((d) => d.key as string).filter((k) => !mapped.has(k));
}

/** A group card's three key limits. */
export function keyLimits(data: PolicyGroupsResponse, col: PolicyColumn): { key: string; label: string; cell: CellModel }[] {
  const byKey = new Map(data.dimensions.map((d) => [d.key as string, d] as const));
  return KEY_LIMITS.flatMap((k) => {
    const d = byKey.get(k);
    return d ? [{ key: k, label: PLAIN_LABEL[k] ?? d.label, cell: cellModel(d, col.values[k]) }] : [];
  });
}

// ── Coverage: hero, KPIs, distribution ────────────────────────────────────────

export interface Coverage {
  covered: number;
  unassigned: number;
  unknown: number;
  total: number;
  overlaysInUse: number;
  defaultLabel: string | null;
}

export function coverage(data: PolicyGroupsResponse): Coverage {
  const covered = data.policyGroups.reduce((a, g) => a + g.customers, 0);
  const total = covered + (data.unassignedActiveCustomers ?? data.unassignedCustomers) + data.unknownAssignments;
  const def = data.policyGroups.find((g) => g.key === data.defaultPolicyGroup) ?? data.policyGroups.find((g) => g.isDefault);
  return {
    covered, unassigned: (data.unassignedActiveCustomers ?? data.unassignedCustomers), unknown: data.unknownAssignments, total,
    overlaysInUse: data.overlays.reduce((a, o) => a + o.customers, 0), defaultLabel: def?.label ?? null,
  };
}

export const DISTRIBUTION_COLORS = {
  unassigned: "var(--accent-warning)",
  unknown: "var(--coral-400)",
} as const;

/** The donut: every group, then Unassigned and Unknown. Zero slices are dropped; the slices sum to the total. */
export function distribution(data: PolicyGroupsResponse): { id: string; label: string; value: number; color?: string }[] {
  return [
    ...data.policyGroups.map((g) => ({ id: g.key, label: shortName(g.label), value: g.customers })),
    { id: "unassigned", label: "Unassigned", value: (data.unassignedActiveCustomers ?? data.unassignedCustomers), color: DISTRIBUTION_COLORS.unassigned },
    { id: "unknown", label: "Unknown group", value: data.unknownAssignments, color: DISTRIBUTION_COLORS.unknown },
  ].filter((i) => i.value > 0);
}

export function heroVerdict(groups: Fetched<PolicyGroupsResponse>): { word: string; tone: StatusTone } {
  if (!groups.data) return { word: groups.loading ? "Reading" : "Unknown", tone: "muted" };
  const c = coverage(groups.data);
  return { word: `${n(c.covered)} of ${n(c.total)}`, tone: c.unassigned + c.unknown > 0 ? "warn" : c.total > 0 ? "ok" : "muted" };
}

export function heroCaption(groups: Fetched<PolicyGroupsResponse>): string {
  if (!groups.data) return groups.loading ? "Reading the policy catalogue…" : `Policy catalogue unavailable${groups.error ? ` — ${groups.error}` : ""}`;
  const c = coverage(groups.data);
  return `Covered by a valid assignment · default group: ${c.defaultLabel ?? "none"}`;
}

export function policyKpis(groups: Fetched<PolicyGroupsResponse>): Kpi[] {
  const d = groups.data;
  if (!d) {
    const sub = groups.loading ? "reading" : "unavailable";
    return [
      { key: "groups", label: "Policy groups", value: "—", sub, tone: "muted" },
      { key: "unassigned", label: "Unassigned", value: "—", sub, tone: "muted" },
      { key: "unknown", label: "Unknown group", value: "—", sub, tone: "muted" },
      { key: "overlays", label: "Overlays in use", value: "—", sub, tone: "muted" },
    ];
  }
  const c = coverage(d);
  return [
    { key: "groups", label: "Policy groups", value: n(d.policyGroups.length), sub: `${d.policyGroups.filter((g) => g.isDefault).length ? "1 default" : "no default"} · read-only`, tone: "muted" },
    { key: "unassigned", label: "Unassigned", value: n(c.unassigned), sub: c.unassigned > 0 ? "fail-closed exposure" : "none", tone: c.unassigned > 0 ? "warn" : "ok" },
    { key: "unknown", label: "Unknown group", value: n(c.unknown), sub: c.unknown > 0 ? "retired group key" : "none", tone: c.unknown > 0 ? "bad" : "ok" },
    { key: "overlays", label: "Overlays in use", value: n(c.overlaysInUse), sub: `${plural(d.overlays.length, "overlay")} defined`, tone: "muted" },
  ];
}

/** Customers on a missing or unknown assignment — the Attention doorway shows only when > 0. */
export function exposure(groups: Fetched<PolicyGroupsResponse>): number {
  return groups.data ? (groups.data.unassignedActiveCustomers ?? groups.data.unassignedCustomers) + groups.data.unknownAssignments : 0;
}

// ── Group detail ──────────────────────────────────────────────────────────────

export interface GroupDetail {
  column: PolicyColumn;
  categories: MatrixCategory[];
  assignments: { label: string; value: string }[];
}

export function groupDetail(data: PolicyGroupsResponse, key: string): GroupDetail | null {
  const columns = policyColumns(data);
  const column = columns.find((c) => c.key === key);
  if (!column) return null;
  const categories = comparisonMatrix(data, [column]);
  const assignments = column.kind === "group"
    ? [
        { label: "Customers assigned", value: n(column.customers) },
        { label: "With an overlay", value: n(data.overlays.reduce((a, o) => a + o.customers, 0)) },
        ...(column.isDefault ? [{ label: "Unassigned", value: n((data.unassignedActiveCustomers ?? data.unassignedCustomers)) }, { label: "Unknown group", value: n(data.unknownAssignments) }] : []),
      ]
    : [{ label: "Customers with this overlay", value: n(column.customers) }];
  return { column, categories, assignments: assignments.slice(0, 4) };
}

// ── Secondary destinations: one summary line each ─────────────────────────────

const unread = (f: Fetched<unknown>, what: string) => (f.loading ? `Reading ${what}…` : `${what[0].toUpperCase()}${what.slice(1)} unavailable`);

export function refreshCadenceLine(p: Fetched<PlatformPoliciesResponse>): string {
  if (!p.data) return unread(p, "refresh cadence");
  if (p.data.policies.length === 0) return "No refresh policy declared";
  return p.data.policies.map((v) => `${v.label.replace(/\s*refresh$/i, "")} every ${n(v.effective.expectedEveryHours)} h${v.effective.origin === "SETTING" ? " (override)" : ""}`).join(" · ");
}

export function jobCadenceLine(c: Fetched<JobCadenceResponse>): string {
  if (!c.data) return unread(c, "job cadence");
  const jobs = c.data.jobs;
  const overrides = jobs.filter((j) => j.origin === "SETTING").length;
  const invalid = jobs.filter((j) => j.origin === "INVALID_SETTING").length;
  return `${plural(jobs.length, "job")} · ${n(jobs.filter((j) => j.editable).length)} editable · ${plural(overrides, "override")}${invalid ? ` · ${n(invalid)} invalid` : ""}`;
}

export function aiControlsLine(a: Fetched<AiCostControlsReadModel>): string {
  if (!a.data) return unread(a, "AI cost controls");
  const al = a.data.allowance;
  return `$${n(al.effectiveDefaultUsd)}/day default · ${al.enforced.value ? "enforced" : "not enforced"} · ${plural(al.overrides.count, "override")}`;
}

export function alertsLine(a: Fetched<PlatformAlertsResponse>): { rules: string; delivery: { word: string; tone: StatusTone } } {
  if (!a.data) return { rules: unread(a, "alert rules"), delivery: { word: "Unknown", tone: "muted" } };
  const live = a.data.rules.filter((r) => r.live);
  return {
    rules: `${plural(a.data.rules.length, "rule")} · ${n(live.filter((r) => r.enabled).length)} enabled`,
    delivery: deliveryShort(a.data.latest),
  };
}

/** The latest evaluation's delivery outcome as one word (the full sentence lives in the Alerts drawer). */
export function deliveryShort(latest: PlatformAlertsResponse["latest"]): { word: string; tone: StatusTone } {
  if (!latest) return { word: "Never evaluated", tone: "muted" };
  if (latest.undelivered) return { word: "Undelivered", tone: "bad" };
  switch (latest.deliveryStatus) {
    case "none": return { word: "Nothing to send", tone: "ok" };
    case "sent": return { word: "Accepted by provider", tone: "ok" };
    case "captured": return { word: "Captured (dev)", tone: "warn" };
    case "skipped": return { word: "Skipped", tone: "bad" };
    case "error": return { word: "Delivery error", tone: "bad" };
  }
}

export function maintenanceState(o: Fetched<OperationalControlsReadModel>): { word: string; tone: StatusTone } {
  if (!o.data) return { word: o.loading ? "Reading…" : "Unknown", tone: "muted" };
  switch (o.data.maintenance.state) {
    case "ON": return { word: "On — customers blocked", tone: "bad" };
    case "OFF": return { word: "Off", tone: "ok" };
    case "MISSING": return { word: "Off (not configured)", tone: "ok" };
    case "INVALID": return { word: "Invalid — denies", tone: "bad" };
  }
}

export function killSwitchState(a: Fetched<AiCostControlsReadModel>): { word: string; tone: StatusTone } {
  if (!a.data) return { word: a.loading ? "Reading…" : "Unknown", tone: "muted" };
  const p = a.data.killSwitch.paused;
  if (p.origin === "INVALID_SETTING") return { word: `${p.value ? "Paused" : "Running"} (invalid row)`, tone: "warn" };
  return p.value ? { word: "Paused", tone: "bad" } : { word: "Running", tone: "ok" };
}

/** Whether any emergency control is engaged (the card's border turns from quiet to loud). */
export function emergencyEngaged(o: Fetched<OperationalControlsReadModel>, a: Fetched<AiCostControlsReadModel>): boolean {
  return maintenanceState(o).tone === "bad" || killSwitchState(a).tone === "bad";
}

// ── Beta reconciliation (owner ruling, 2026-10-30) ────────────────────────────
//
// The ONE deliberate entry that gives active customers with NO assignment the
// beta default. The words live here (pure); whether the entry is OFFERED is the
// host component's call (BetaReconciliationEntry.tsx), and the server route is
// the authority either way.

/** The guarantee the confirmation states, verbatim. */
export const RECONCILE_GUARANTEE =
  "Creates Beta assignments only for active accounts that have none. Existing assignments — including Founder — are never changed.";

/** The entry's label, or null when there is nothing to assign (then nothing renders). */
export function reconcileEntryLabel(eligible: number | null | undefined): string | null {
  if (!eligible || eligible <= 0) return null;
  return `Assign Beta to ${eligible.toLocaleString("en-US")} unassigned account${eligible === 1 ? "" : "s"}`;
}

/** The confirmation's exact-count sentence. */
export function reconcileConfirmCount(eligible: number): string {
  return `${eligible.toLocaleString("en-US")} active account${eligible === 1 ? "" : "s"} without an assignment will be placed on Beta.`;
}

/** The outcome line after a POST answered (status + body). */
export function reconcileOutcome(status: number, body: { created?: number; skipped?: number; error?: string }): { text: string; tone: StatusTone } {
  if (status === 200) {
    const created = body.created ?? 0;
    const skipped = body.skipped ?? 0;
    return {
      text: `Assigned Beta to ${created.toLocaleString("en-US")} account${created === 1 ? "" : "s"}${skipped > 0 ? ` · ${skipped} already assigned meanwhile (left unchanged)` : ""}`,
      tone: "ok",
    };
  }
  return { text: body.error ?? `Not applied (HTTP ${status})`, tone: status === 409 ? "warn" : "bad" };
}
