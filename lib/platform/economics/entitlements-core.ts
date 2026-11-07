/**
 * lib/platform/economics/entitlements-core.ts  (Platform Economics — PR B: Entitlements)
 *
 * COST BY POLICY GROUP: the sum of each customer's attributable cost this cycle,
 * grouped by the customer's CURRENT assignment (no row, or a retired group ⇒ the
 * default group — the resolver's own fallback). A customer's cost is
 *
 *   AI     their RETURNED customer-surface calls (readUserSpendGroups) × the rate card
 *   Plaid  their Items' Transactions Item-months × the invoice-derived rate
 *          (Investments Item-months are counted and named, never priced — S2: billed
 *          only once initialized, and `billed_products` is not stored)
 *
 * What cannot be attributed to a customer (AI overhead: evaluation and unattributed
 * surfaces; customer-surface calls recorded without a user; Items without an owner;
 * infrastructure and unmetered providers) is NEVER spread across groups — it is its
 * own figure, so Σ groups + unattributed is the attributable whole.
 *
 * SCENARIOS are HYPOTHETICAL and READ-ONLY: "what if group X's daily AI allowance
 * were $Y" re-reads the same per-customer, per-UTC-day spend and caps each day at Y.
 * Nothing is written, no policy changes, no allowance moves (pinned by a static scan
 * in entitlements.test.ts). Customers with their own allowance (an individual
 * override, or an overlay that sets one) are left uncapped and counted aside.
 *
 * Pure: no I/O, no clock, no user id (the reader maps ids to opaque refs first).
 * Same figure shape and status rules as snapshot-core.ts; a group's value is the sum
 * of its drill rows (one row per customer, opaque ref).
 */

import { isCustomerSurface, priceSpendGroup, type SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import { plaidRateAt, type PlaidBillableProduct, type PlaidRate } from "@/lib/usage/pricing";
import {
  drillRef, figureFromRows, investmentsGap, rowsTotal, unavailable,
  type EconomicsDrillRow, type EconomicsFigure, type EconomicsStatus,
} from "@/lib/platform/economics/snapshot-core";

// ── Inputs ──────────────────────────────────────────────────────────────────────

export interface EntitlementCustomer {
  /** Opaque reference — never the id. */
  ref: string;
  /** The resolved CURRENT group key. */
  groupKey: string;
  /** True when the customer's AI allowance is their own (individual override or an overlay that sets it). */
  ownAllowance: boolean;
  /** Their RETURNED customer-surface AI groups this cycle. */
  spend: readonly SpendGroup[];
  /** Their billable Items' Item-months this cycle (present during the cycle). */
  plaidMonths: readonly PlaidBillableProduct[];
}

export interface EntitlementGroup {
  key: string;
  label: string;
  isDefault: boolean;
  archived: boolean;
  /** The group's daily AI allowance (USD, estimated); null when its definition is invalid. */
  allowanceUsd: number | null;
}

export interface EntitlementInputs {
  nowMs: number;
  aiPricingConfigured: boolean;
  plaidRates: readonly PlaidRate[];
  /** Start day of the current cycle (rates resolve at the cycle start). */
  cycleStart: string;
  groups: readonly EntitlementGroup[];
  customers: readonly EntitlementCustomer[];
  /** Fleet AI groups this cycle (every surface) — the overhead share is unattributed. */
  fleetSpend: readonly SpendGroup[];
  /** Customer-surface AI groups this cycle recorded WITHOUT a user. */
  userlessSpend: readonly SpendGroup[];
  /** Billable Item-months this cycle whose Item has no owner on record. */
  ownerlessPlaidMonths: readonly PlaidBillableProduct[];
  /** Census caveats from the Overview (incomplete census, readings disagree). */
  plaidCaveats: readonly string[];
}

// ── Per-customer cost ───────────────────────────────────────────────────────────

const fmt = (v: number | null) => (v === null ? "none" : `$${v.toFixed(2)}`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

interface Priced { usd: number | null; unpricedInvocations: number }

function priceGroups(groups: readonly SpendGroup[], configured: boolean): Priced {
  let usd: number | null = null, unpriced = 0;
  for (const g of groups) {
    const p = configured ? priceSpendGroup(g) : { usd: null, unpriced: g.promptTokens + g.completionTokens > 0 };
    if (p.unpriced) unpriced += g.invocations;
    else if (p.usd !== null) usd = (usd ?? 0) + p.usd;
  }
  return { usd, unpricedInvocations: unpriced };
}

function pricePlaid(months: readonly PlaidBillableProduct[], rates: readonly PlaidRate[], cycleStart: string): { usd: number | null; unpriced: number; investments: number } {
  let usd: number | null = null, unpriced = 0, investments = 0;
  const rate = plaidRateAt("transactions", cycleStart, rates);
  for (const m of months) {
    if (m === "investments") { investments++; continue; }
    if (rate) usd = (usd ?? 0) + rate.usdPerItemMonth; else unpriced++;
  }
  return { usd, unpriced, investments };
}

/** One customer's attributable cost this cycle as a drill row (opaque ref). */
export function customerCostRow(c: EntitlementCustomer, i: Pick<EntitlementInputs, "aiPricingConfigured" | "plaidRates" | "cycleStart">): EconomicsDrillRow {
  const ai = priceGroups(c.spend, i.aiPricingConfigured);
  const plaid = pricePlaid(c.plaidMonths, i.plaidRates, i.cycleStart);
  const value = ai.usd === null && plaid.usd === null ? null : (ai.usd ?? 0) + (plaid.usd ?? 0);
  const gaps: string[] = [];
  if (ai.unpricedInvocations > 0) gaps.push(`${plural(ai.unpricedInvocations, "unpriced AI call")} not counted`);
  if (plaid.unpriced > 0) gaps.push(`${plural(plaid.unpriced, "Transactions Item-month")} without a rate`);
  if (plaid.investments > 0) gaps.push(investmentsGap(plaid.investments));
  const status: EconomicsStatus = value === null ? "UNAVAILABLE" : gaps.length > 0 ? "PARTIAL" : "ESTIMATED";
  return { id: c.ref, label: c.ref, value, status, detail: [`AI ${fmt(ai.usd)} · Plaid ${fmt(plaid.usd)}`, ...gaps].join(" · ") };
}

// ── Cost by policy group ────────────────────────────────────────────────────────

export const REASON_NO_GROUP_COST = "no attributable cost recorded for this group's customers this cycle";
export const REASON_UNKNOWN_GROUP = "no such policy group";
export const NOT_ATTRIBUTED = "infrastructure and unmetered providers — not metered, never attributed to a customer";
const GROUP_BASIS = "Σ per-customer cost this cycle (customer-surface AI × rate card + Plaid Transactions Item-months × rate), grouped by current assignment (unassigned or retired ⇒ the default group)";

export function groupRows(i: EntitlementInputs, groupKey: string): EconomicsDrillRow[] {
  return i.customers.filter((c) => c.groupKey === groupKey).map((c) => customerCostRow(c, i)).sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.id.localeCompare(b.id));
}

export function groupCostFigure(i: EntitlementInputs, groupKey: string, checkedAt: string): EconomicsFigure {
  const g = i.groups.find((x) => x.key === groupKey);
  if (!g) return unavailable("group_cost", groupKey, "usd", REASON_UNKNOWN_GROUP, GROUP_BASIS, "cycle", i.nowMs, checkedAt);
  const f = figureFromRows({
    key: "group_cost", window: "cycle", label: g.label, unit: "usd", basis: GROUP_BASIS,
    covered: ["customer-surface AI (Conversations, Daily Brief)", "Plaid Transactions"],
    absent: [NOT_ATTRIBUTED, ...i.plaidCaveats], emptyReason: REASON_NO_GROUP_COST,
  }, groupRows(i, groupKey), i.nowMs, checkedAt);
  return { ...f, drill: drillRef("group_cost", "cycle", checkedAt, groupKey) };
}

/** What could not be attributed to any customer — its own figure, never spread across groups. */
export function unattributedRows(i: EntitlementInputs): EconomicsDrillRow[] {
  const overhead = priceGroups(i.fleetSpend.filter((g) => !isCustomerSurface(g.surface)), i.aiPricingConfigured);
  const userless = priceGroups(i.userlessSpend, i.aiPricingConfigured);
  const ownerless = pricePlaid(i.ownerlessPlaidMonths, i.plaidRates, i.cycleStart);
  const row = (id: string, label: string, p: Priced, what: string): EconomicsDrillRow => ({
    id, label, value: p.usd,
    status: p.usd === null ? "UNAVAILABLE" : p.unpricedInvocations > 0 ? "PARTIAL" : "ESTIMATED",
    detail: p.usd === null ? (p.unpricedInvocations > 0 ? `${plural(p.unpricedInvocations, "unpriced call")}, none priced` : `no ${what} recorded this cycle`) : `${what}${p.unpricedInvocations > 0 ? ` · ${plural(p.unpricedInvocations, "unpriced call")} not counted` : ""}`,
  });
  return [
    row("ai-overhead", "AI · overhead (evaluation, unattributed surfaces)", overhead, "overhead AI"),
    row("ai-userless", "AI · customer surface without a user", userless, "user-less customer-surface AI"),
    { id: "plaid-ownerless", label: "Plaid · Items without an owner", value: ownerless.usd,
      status: ownerless.usd === null ? "UNAVAILABLE" : ownerless.investments > 0 ? "PARTIAL" : "ESTIMATED",
      detail: ownerless.usd === null ? "no ownerless Items this cycle" : `${ownerless.investments > 0 ? investmentsGap(ownerless.investments) : "Transactions Item-months × rate"}` },
  ];
}

export function unattributedFigure(i: EntitlementInputs, checkedAt: string): EconomicsFigure {
  const rows = unattributedRows(i);
  return figureFromRows({
    key: "unattributed_cost", window: "cycle", label: "Not attributed to a group", unit: "usd",
    basis: "AI overhead + user-less customer-surface calls + ownerless Items, this cycle — never spread across groups",
    covered: rows.map((r) => r.label), absent: [NOT_ATTRIBUTED], emptyReason: "nothing unattributed recorded this cycle",
  }, rows.filter((r) => r.value !== null), i.nowMs, checkedAt);
}

export interface EntitlementGroupView extends EntitlementGroup {
  /** Customers in this group with a cost fact this cycle (the drill's row count). */
  customersWithCost: number;
  cost: EconomicsFigure;
}

export interface EconomicsEntitlementsView {
  checkedAt: string;
  groups: readonly EntitlementGroupView[];
  unattributed: EconomicsFigure;
  note: string;
}

export const ENTITLEMENTS_NOTE =
  "Cost by policy group is what each group's customers caused this cycle, by current assignment. Estimates, never a bill. Configuration stays in Policies — nothing here changes a policy.";

export function buildEntitlementsView(i: EntitlementInputs): EconomicsEntitlementsView {
  const checkedAt = new Date(i.nowMs).toISOString();
  return {
    checkedAt,
    groups: i.groups.map((g) => ({ ...g, customersWithCost: i.customers.filter((c) => c.groupKey === g.key).length, cost: groupCostFigure(i, g.key, checkedAt) })),
    unattributed: unattributedFigure(i, checkedAt),
    note: ENTITLEMENTS_NOTE,
  };
}

// ── Scenarios (HYPOTHETICAL, read-only) ─────────────────────────────────────────

export const SCENARIO_LABEL = "HYPOTHETICAL";
export const SCENARIO_MAX_ALLOWANCE_USD = 1000;
export const SCENARIO_NOTE =
  "HYPOTHETICAL — recorded AI spend re-read with each customer-day capped at the proposed allowance. Nothing is written and no policy changes. Real behaviour would differ: the allowance refuses new calls, so customers may stop, retry later or use another surface.";

export interface ScenarioQuery { group: string; allowanceUsd: number }

/** Validate `group` (catalogue key shape) and `allowance` (finite, 0…1000 USD/day). */
export function parseScenarioQuery(p: URLSearchParams, groupKeyPattern: RegExp): ScenarioQuery | null {
  const group = p.get("group");
  const raw = p.get("allowance");
  if (!group || !groupKeyPattern.test(group) || raw === null || raw.trim() === "") return null;
  const allowanceUsd = Number(raw);
  if (!Number.isFinite(allowanceUsd) || allowanceUsd < 0 || allowanceUsd > SCENARIO_MAX_ALLOWANCE_USD) return null;
  return { group, allowanceUsd: Math.round(allowanceUsd * 100) / 100 };
}

export interface ScenarioCustomerRow {
  ref: string;
  /** Recorded AI cost this cycle (priced days only). */
  currentUsd: number | null;
  /** The same, each day capped at the proposed allowance. */
  hypotheticalUsd: number | null;
  daysOver: number;
  /** Has its own allowance (override / overlay) — not capped by a group change. */
  ownAllowance: boolean;
  unpricedInvocations: number;
}

export interface EconomicsScenario {
  label: typeof SCENARIO_LABEL;
  hypothetical: true;
  group: { key: string; label: string };
  currentAllowanceUsd: number | null;
  proposedAllowanceUsd: number;
  /** The group's recorded customer AI cost this cycle (every member). */
  current: EconomicsFigure;
  /** HYPOTHETICAL — the same spend with each customer-day capped. */
  hypotheticalCost: EconomicsFigure;
  /** current − hypothetical (≥ 0 when both are known); null otherwise. */
  differenceUsd: number | null;
  customerDaysOver: number;
  customersAffected: number;
  /** Members left uncapped because their allowance is their own. */
  ownAllowanceCustomers: number;
  rows: readonly ScenarioCustomerRow[];
  note: string;
  checkedAt: string;
}

/** Per UTC day priced spend for one customer; unpriced invocations counted aside (never capped as $0). */
function dailySpend(spend: readonly SpendGroup[], configured: boolean): { byDay: Map<string, number>; unpriced: number } {
  const byDay = new Map<string, number>();
  let unpriced = 0;
  for (const g of spend) {
    const p = configured ? priceSpendGroup(g) : { usd: null, unpriced: g.promptTokens + g.completionTokens > 0 };
    if (p.unpriced) unpriced += g.invocations;
    else if (p.usd !== null) byDay.set(g.day, (byDay.get(g.day) ?? 0) + p.usd);
  }
  return { byDay, unpriced };
}

export function buildScenario(i: EntitlementInputs, q: ScenarioQuery): EconomicsScenario | null {
  const g = i.groups.find((x) => x.key === q.group);
  if (!g) return null;
  const checkedAt = new Date(i.nowMs).toISOString();
  const rows: ScenarioCustomerRow[] = [];
  for (const c of i.customers.filter((x) => x.groupKey === g.key)) {
    const d = dailySpend(c.spend, i.aiPricingConfigured);
    const days = [...d.byDay.values()];
    const current = days.length ? days.reduce((a, v) => a + v, 0) : null;
    const capped = days.length ? days.reduce((a, v) => a + (c.ownAllowance ? v : Math.min(v, q.allowanceUsd)), 0) : null;
    rows.push({
      ref: c.ref, currentUsd: current, hypotheticalUsd: capped,
      daysOver: c.ownAllowance ? 0 : days.filter((v) => v > q.allowanceUsd).length,
      ownAllowance: c.ownAllowance, unpricedInvocations: d.unpriced,
    });
  }
  rows.sort((a, b) => (b.currentUsd ?? -1) - (a.currentUsd ?? -1) || a.ref.localeCompare(b.ref));
  const toRow = (r: ScenarioCustomerRow, v: number | null): EconomicsDrillRow => ({
    id: r.ref, label: r.ref, value: v,
    status: v === null ? "UNAVAILABLE" : r.unpricedInvocations > 0 ? "PARTIAL" : "ESTIMATED",
    detail: r.unpricedInvocations > 0 ? `${plural(r.unpricedInvocations, "unpriced call")} not counted` : r.ownAllowance ? "own allowance — not capped" : `${plural(r.daysOver, "day")} over`,
  });
  const spec = (label: string, basis: string) => ({
    key: "scenario_cost" as const, window: "cycle" as const, label, unit: "usd" as const, basis,
    covered: ["customer-surface AI of the group's customers"], absent: [], emptyReason: REASON_NO_GROUP_COST,
  });
  const current = figureFromRows(spec(`${g.label} · recorded AI cost`, "recorded customer-surface AI this cycle × rate card"), rows.map((r) => toRow(r, r.currentUsd)), i.nowMs, checkedAt);
  const hypo = figureFromRows(spec(`${g.label} · HYPOTHETICAL at $${q.allowanceUsd.toFixed(2)}/day`, `HYPOTHETICAL — each customer-day capped at $${q.allowanceUsd.toFixed(2)}`), rows.map((r) => toRow(r, r.hypotheticalUsd)), i.nowMs, checkedAt);
  const cur = rowsTotal(rows.map((r) => toRow(r, r.currentUsd)));
  const hyp = rowsTotal(rows.map((r) => toRow(r, r.hypotheticalUsd)));
  return {
    label: SCENARIO_LABEL, hypothetical: true,
    group: { key: g.key, label: g.label },
    currentAllowanceUsd: g.allowanceUsd,
    proposedAllowanceUsd: q.allowanceUsd,
    current, hypotheticalCost: hypo,
    differenceUsd: cur === null || hyp === null ? null : Math.max(0, cur - hyp),
    customerDaysOver: rows.reduce((a, r) => a + r.daysOver, 0),
    customersAffected: rows.filter((r) => r.daysOver > 0).length,
    ownAllowanceCustomers: rows.filter((r) => r.ownAllowance).length,
    rows, note: SCENARIO_NOTE, checkedAt,
  };
}
