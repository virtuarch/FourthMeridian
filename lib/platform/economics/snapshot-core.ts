/**
 * lib/platform/economics/snapshot-core.ts  (Platform Economics — PR A: the Overview)
 *
 * THE PURE FOLD behind Economics › Overview. It composes facts the existing
 * readers already produce — no new collection, no new pricing, no second
 * spend engine:
 *
 *   AI          AiInvocation ledger, RETURNED rows grouped by (provider, model,
 *               surface, UTC day) — the SAME grouped read (readSpendGroups) and
 *               the SAME pricer (priceSpendGroup, lib/usage/pricing) the AI &
 *               Costs "Cost by surface" card uses.
 *   Plaid       the Item × product × cycle census (buildPlaidUsage → priceCycle,
 *               the "present during the cycle" reading AI & Costs shows) priced by
 *               the invoice-derived rate (plaidRateAt). Billed per Item-month, so
 *               it is reported per CYCLE and never allocated to days.
 *   Customers   PB-10's engagement predicate (loadEngagedUserIdsSince) — never
 *               sessions, never presence.
 *
 * STATUS VOCABULARY (lib/platform/ai/fleet-spend-status.ts, the owner's):
 *   MEASURED     a fact read, not priced: a count of engaged customers. No dollar
 *                figure is ever MEASURED — no invoice is read anywhere.
 *   ESTIMATED    every part of the figure was priced by a code-owned rate card.
 *   PARTIAL      some parts priced, some not (unpriced calls, an unpriced or
 *                incomplete Plaid census, an unmetered component): the value is a
 *                LOWER BOUND, and `coverage.missing` names what is not in it.
 *   UNAVAILABLE  nothing to show: value null with its reason — NEVER $0.
 *
 * Revenue and margin are ALWAYS UNAVAILABLE: there is no billing source. Nothing
 * here computes revenue, margin, profitability or CAC.
 *
 * DRILL = THE KPI's OWN ROWS. Every drillable figure's value is DEFINED as the
 * sum of its drill rows (`figureFromRows`), and the drill endpoint calls the same
 * row builder over the same inputs — so "the KPI total equals its drill list" is
 * true by construction, not by a matching query (pinned in snapshot.test.ts).
 *
 * Pure: no I/O, no clock (the caller passes `nowMs`), no user id in the output
 * (the reader maps engaged ids to opaque references before calling in).
 */

import type { SpendStatus } from "@/lib/platform/ai/fleet-spend-status";
import { PLATFORM_AI_SURFACES, isCustomerSurface, isPlatformAiSurface, priceSpendGroup, type SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import type { BillingCycle, PlaidCycleCost } from "@/lib/platform/plaid/item-months";
import { plaidRateAt, type PlaidBillableProduct, type PlaidRate } from "@/lib/usage/pricing";
import { POLICY_GROUP_KEY_PATTERN } from "@/lib/entitlements/policy-groups";

const DAY_MS = 86_400_000;

// ── Vocabulary ──────────────────────────────────────────────────────────────────

export type EconomicsStatus = SpendStatus;

/** The windows a figure is read over: the current billing cycle (calendar month to date) or N UTC days ending today. */
export const ECONOMICS_WINDOWS = ["cycle", "7d", "30d", "90d"] as const;
export type EconomicsWindow = (typeof ECONOMICS_WINDOWS)[number];
export const TREND_WINDOWS = ["7d", "30d", "90d"] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];
const WINDOW_DAYS: Readonly<Record<TrendWindow, number>> = { "7d": 7, "30d": 30, "90d": 90 };
export const MAX_TREND_DAYS = 90;

export const ECONOMICS_FIGURES = [
  "operating_cost", "ai_cost", "provider_cost", "infra_cost",
  "active_customers", "cost_per_active_customer", "revenue", "margin",
  // PR C — AI invoked for an OPERATOR (Comms authoring), split out of overhead.
  "platform_ai_cost",
] as const;
/** The Overview's figures (the snapshot's `figures` record). */
export type OverviewFigureKey = (typeof ECONOMICS_FIGURES)[number];
/** PR B — Providers (per-provider cost) and Entitlements (cost by policy group, scenarios). */
export const PROVIDER_FIGURES = ["openai_cost", "plaid_cost", "provider_unmetered"] as const;
export const ENTITLEMENT_FIGURES = ["group_cost", "unattributed_cost", "scenario_cost"] as const;
export type EconomicsFigureKey = OverviewFigureKey | (typeof PROVIDER_FIGURES)[number] | (typeof ENTITLEMENT_FIGURES)[number];
const ALL_FIGURES: readonly string[] = [...ECONOMICS_FIGURES, ...PROVIDER_FIGURES, ...ENTITLEMENT_FIGURES];
export function isOverviewFigure(k: string): k is OverviewFigureKey { return (ECONOMICS_FIGURES as readonly string[]).includes(k); }

/** Figures that have records to drill into, and the windows each accepts. */
export const DRILLABLE: Readonly<Partial<Record<EconomicsFigureKey, readonly EconomicsWindow[]>>> = {
  operating_cost: ["cycle"],
  ai_cost: ["cycle", "7d", "30d", "90d"],
  platform_ai_cost: ["cycle", "7d", "30d", "90d"],
  provider_cost: ["cycle"],
  active_customers: ["cycle"],
  cost_per_active_customer: ["cycle"],
  openai_cost: ["cycle"],
  plaid_cost: ["cycle"],
  group_cost: ["cycle"],
  unattributed_cost: ["cycle"],
};

export const ECONOMICS_DRILL_PATH = "/api/platform/platform-ops/economics/drill";

// ── Reasons (exported so the UI and tests say exactly the same words) ─────────

export const REASON_NO_BILLING = "no billing source";
export const REASON_INFRA_NOT_METERED = "infrastructure (hosting, database) is not metered";
export const REASON_OTHER_PROVIDERS_NOT_METERED = "other providers are not metered";
export const REASON_NO_AI_RATE_CARD = "no AI rate card configured";
export const REASON_NO_AI_CALLS = "no AI invocations recorded in the window";
export const REASON_NO_AI_PRICED = "no AI invocation in the window could be priced";
export const REASON_NO_PLAID_RATE = "no Plaid rate card configured";
export const REASON_NO_PLAID_CYCLE = "no Plaid billing cycle reported";
export const REASON_NO_PLAID_PRICED = "no Plaid Item-month this cycle could be priced";
export const REASON_NOTHING_PRICED = "no cost component could be priced";
export const REASON_NO_ENGAGED = "no engaged customers this cycle";
export const ESTIMATE_NOTE =
  "Every dollar here is an estimate from code-owned rate cards — never a bill (no provider invoice is read). Revenue and margin are unavailable: there is no billing source.";

// ── Shapes ──────────────────────────────────────────────────────────────────────

export interface EconomicsCoverage {
  /** What the figure includes. */
  covered: readonly string[];
  /** What it does NOT include, each with why. Non-empty ⇔ PARTIAL or UNAVAILABLE. */
  missing: readonly string[];
}

export interface EconomicsFreshness {
  /** When the underlying ledgers were read (the snapshot's checkedAt). */
  asOf: string;
  /** Inclusive UTC days the figure covers. */
  from: string;
  to: string;
}

export interface EconomicsDrillRef {
  figure: EconomicsFigureKey;
  window: EconomicsWindow;
  /** group_cost only — the policy group key the figure is for. */
  group?: string;
  /** The records endpoint — the SAME inputs and row builder as the figure. */
  href: string;
}

export interface EconomicsFigure {
  key: EconomicsFigureKey;
  window: EconomicsWindow;
  label: string;
  unit: "usd" | "count";
  /** null ⇔ UNAVAILABLE. A lower bound when PARTIAL. Never a stand-in 0 for missing data. */
  value: number | null;
  status: EconomicsStatus;
  /** Why there is no figure (UNAVAILABLE) or why it is a lower bound (PARTIAL). */
  reason: string | null;
  coverage: EconomicsCoverage;
  freshness: EconomicsFreshness;
  /** How the figure is computed, in one line. */
  basis: string;
  drill: EconomicsDrillRef | null;
}

/** One record behind a figure. `value` null = this part has no figure (never counted as 0). */
export interface EconomicsDrillRow {
  id: string;
  label: string;
  value: number | null;
  status: EconomicsStatus;
  detail: string;
}

export interface EconomicsTrendDay {
  day: string;
  /** False when the ledger has no row for the day — a GAP, never $0. */
  observed: boolean;
  customerUsd: number | null;
  overheadUsd: number | null;
  totalUsd: number | null;
  unpricedInvocations: number;
}

export interface EconomicsSnapshot {
  checkedAt: string;
  cycle: BillingCycle & { today: string };
  figures: Readonly<Record<OverviewFigureKey, EconomicsFigure>>;
  trend: {
    windows: Readonly<Record<TrendWindow, EconomicsFigure>>;
    /** PR C — Platform AI over the same windows (weekly / monthly / quarterly; the daily rows are its drill). */
    platformAi: Readonly<Record<TrendWindow, EconomicsFigure>>;
    /** The last 90 calendar UTC days, ascending (the 7 d / 30 d series are its tails). */
    days: readonly EconomicsTrendDay[];
    /** Why the daily trend is AI-only. */
    note: string;
  };
  estimateNote: string;
}

export interface EconomicsDrillResponse {
  figure: EconomicsFigure;
  rows: readonly EconomicsDrillRow[];
  /** Σ of the rows' non-null values (a count figure: the row count) — equals `figure.value`. */
  total: number | null;
  checkedAt: string;
}

/** Everything the fold needs, read once by the server reader. */
export interface EconomicsInputs {
  nowMs: number;
  /** RETURNED AiInvocation groups from the earliest window start (cycle or 90 d) to now. */
  spendGroups: readonly SpendGroup[];
  aiPricingConfigured: boolean;
  /** The current cycle's Plaid census, "present during the cycle" reading; null when not reported. */
  plaidCycle: PlaidCycleCost | null;
  /** True when the two invoice readings of the cycle agree (usage.ts `agree`). */
  plaidReadingsAgree: boolean;
  plaidRates: readonly PlaidRate[];
  /** Opaque references (never ids) of the customers engaged since the cycle start, sorted. */
  engagedCustomerRefs: readonly string[];
}

// ── Calendar ────────────────────────────────────────────────────────────────────

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOfUtcDay = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

/** The current billing cycle: the calendar month containing `nowMs` (Plaid's invoice shape). */
export function cycleOf(nowMs: number): BillingCycle {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return { start: dayKey(Date.UTC(y, m, 1)), end: dayKey(Date.UTC(y, m + 1, 0)) };
}

/** Inclusive UTC day range of a window ending today. */
export function windowRange(window: EconomicsWindow, nowMs: number): { from: string; to: string } {
  const to = dayKey(nowMs);
  if (window === "cycle") return { from: cycleOf(nowMs).start, to };
  return { from: dayKey(startOfUtcDay(nowMs) - (WINDOW_DAYS[window] - 1) * DAY_MS), to };
}

/** The earliest instant any window needs — what the reader reads from. */
export function readSince(nowMs: number): Date {
  const a = Date.parse(`${windowRange("90d", nowMs).from}T00:00:00Z`);
  const b = Date.parse(`${cycleOf(nowMs).start}T00:00:00Z`);
  return new Date(Math.min(a, b));
}

function calendarDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += DAY_MS) out.push(dayKey(t));
  return out;
}

// ── Figures from rows (THE definition of "a figure equals its drill") ──────────

/** Σ of the rows that carry a value; null when none does. Summed in row order. */
export function rowsTotal(rows: readonly EconomicsDrillRow[]): number | null {
  let total: number | null = null;
  for (const r of rows) if (r.value !== null) total = (total ?? 0) + r.value;
  return total;
}

export function drillRef(key: EconomicsFigureKey, window: EconomicsWindow, checkedAt: string, group?: string): EconomicsDrillRef | null {
  if (!DRILLABLE[key]?.includes(window)) return null;
  const p = new URLSearchParams({ figure: key, window });
  if (group !== undefined) p.set("group", group);
  p.set("until", String(Date.parse(checkedAt)));
  return { figure: key, window, ...(group !== undefined ? { group } : {}), href: `${ECONOMICS_DRILL_PATH}?${p.toString()}` };
}

export interface FigureSpec {
  key: EconomicsFigureKey;
  window: EconomicsWindow;
  label: string;
  unit: "usd" | "count";
  basis: string;
  covered: readonly string[];
  /** Parts that are structurally absent (always make the figure PARTIAL when anything else has a value). */
  absent: readonly string[];
  /** Reason when nothing has a value. */
  emptyReason: string;
}

/**
 * The figure for a set of rows: value = Σ rows; status from the rows and the
 * structurally-absent parts. A row without a value (unpriced, unmetered) or a
 * PARTIAL row makes the whole PARTIAL; no row with a value ⇒ UNAVAILABLE.
 */
export function figureFromRows(spec: FigureSpec, rows: readonly EconomicsDrillRow[], nowMs: number, checkedAt: string): EconomicsFigure {
  const value = rowsTotal(rows);
  const range = windowRange(spec.window, nowMs);
  const missingRows = rows.filter((r) => r.value === null || r.status === "PARTIAL").map((r) => `${r.label} — ${r.detail}`);
  const missing = [...missingRows, ...spec.absent];
  let status: EconomicsStatus;
  let reason: string | null;
  if (value === null) { status = "UNAVAILABLE"; reason = rows.length === 0 ? spec.emptyReason : (rows.length === 1 ? rows[0].detail : spec.emptyReason); }
  else if (missing.length > 0) { status = "PARTIAL"; reason = `lower bound — ${missing.length} part${missing.length === 1 ? "" : "s"} not included`; }
  else { status = "ESTIMATED"; reason = null; }
  return {
    key: spec.key, window: spec.window, label: spec.label, unit: spec.unit, value, status, reason,
    coverage: { covered: spec.covered, missing: value === null && missing.length === 0 ? [spec.emptyReason] : missing },
    freshness: { asOf: checkedAt, from: range.from, to: range.to },
    basis: spec.basis,
    drill: drillRef(spec.key, spec.window, checkedAt),
  };
}

export function unavailable(key: EconomicsFigureKey, label: string, unit: "usd" | "count", reason: string, basis: string, window: EconomicsWindow, nowMs: number, checkedAt: string): EconomicsFigure {
  const range = windowRange(window, nowMs);
  return {
    key, window, label, unit, value: null, status: "UNAVAILABLE", reason,
    coverage: { covered: [], missing: [reason] },
    freshness: { asOf: checkedAt, from: range.from, to: range.to },
    basis, drill: null,
  };
}

// ── AI (the invocation ledger) ──────────────────────────────────────────────────

/** Per-UTC-day priced AI spend over [from, to], customer vs overhead. A day without a ledger row is a gap. */
export function aiDays(inputs: Pick<EconomicsInputs, "spendGroups">, from: string, to: string): EconomicsTrendDay[] {
  const by = new Map<string, EconomicsTrendDay>();
  for (const g of inputs.spendGroups) {
    if (g.day < from || g.day > to) continue;
    const d = by.get(g.day) ?? { day: g.day, observed: true, customerUsd: null, overheadUsd: null, totalUsd: null, unpricedInvocations: 0 };
    const p = priceSpendGroup(g);
    if (p.unpriced) d.unpricedInvocations += g.invocations;
    else if (p.usd !== null) {
      if (isCustomerSurface(g.surface)) d.customerUsd = (d.customerUsd ?? 0) + p.usd;
      else d.overheadUsd = (d.overheadUsd ?? 0) + p.usd;
    }
    by.set(g.day, d);
  }
  return calendarDays(from, to).map((day) => {
    const d = by.get(day);
    if (!d) return { day, observed: false, customerUsd: null, overheadUsd: null, totalUsd: null, unpricedInvocations: 0 };
    const priced = d.customerUsd !== null || d.overheadUsd !== null;
    // A day whose rows carry no tokens prices to nothing without being unpriced: a real $0 (the rows exist).
    const total = priced ? (d.customerUsd ?? 0) + (d.overheadUsd ?? 0) : d.unpricedInvocations > 0 ? null : 0;
    return { ...d, totalUsd: total };
  });
}

export function aiDayRows(inputs: Pick<EconomicsInputs, "spendGroups" | "nowMs">, window: EconomicsWindow): EconomicsDrillRow[] {
  const { from, to } = windowRange(window, inputs.nowMs);
  return aiDays(inputs, from, to).filter((d) => d.observed).map((d) => ({
    id: d.day,
    label: d.day,
    value: d.totalUsd,
    status: d.totalUsd === null ? "UNAVAILABLE" : d.unpricedInvocations > 0 ? "PARTIAL" : "ESTIMATED",
    detail: d.totalUsd === null
      ? `${d.unpricedInvocations} unpriced invocation${d.unpricedInvocations === 1 ? "" : "s"}, none priced`
      : `customer ${fmt(d.customerUsd)} · overhead ${fmt(d.overheadUsd)}${d.unpricedInvocations > 0 ? ` · ${d.unpricedInvocations} unpriced, not counted` : ""}`,
  }));
}

const fmt = (v: number | null) => (v === null ? "none" : `$${v.toFixed(2)}`);
export const AI_BASIS = "AiInvocation ledger, RETURNED calls, each (model, UTC day) priced by the code-owned rate card; all surfaces (customer + overhead)";

export function aiCostFigure(inputs: EconomicsInputs, window: EconomicsWindow, checkedAt: string): EconomicsFigure {
  const label = window === "cycle" ? "AI · this cycle" : `AI cost · ${window.replace("d", " d")}`;
  // No rate card ⇒ nothing can be priced: no figure and no records to drill (never $0).
  if (!inputs.aiPricingConfigured) return unavailable("ai_cost", label, "usd", REASON_NO_AI_RATE_CARD, AI_BASIS, window, inputs.nowMs, checkedAt);
  const rows = aiDayRows(inputs, window);
  return figureFromRows({
    key: "ai_cost", window, label, unit: "usd", basis: AI_BASIS,
    covered: ["OpenAI · every surface (Conversations, Daily Brief, evaluation, unattributed)"],
    absent: [],
    emptyReason: rows.length === 0 ? REASON_NO_AI_CALLS : REASON_NO_AI_PRICED,
  }, rows, inputs.nowMs, checkedAt);
}

// ── Platform AI (operator features) ─────────────────────────────────────────────

export const REASON_NO_PLATFORM_AI = "no Platform AI usage recorded in the window";
export const PLATFORM_AI_BASIS = `AiInvocation ledger, RETURNED calls on the operator surfaces (${PLATFORM_AI_SURFACES.join(", ")}), each (model, UTC day) priced by the rate card`;

/** Per-UTC-day priced Platform AI spend (observed days only) — the KPI's drill rows. */
export function platformAiDayRows(inputs: Pick<EconomicsInputs, "spendGroups" | "nowMs" | "aiPricingConfigured">, window: EconomicsWindow): EconomicsDrillRow[] {
  if (!inputs.aiPricingConfigured) return [];
  return aiDayRows({ nowMs: inputs.nowMs, spendGroups: inputs.spendGroups.filter((g) => isPlatformAiSurface(g.surface)) }, window)
    .map((r) => ({ ...r, detail: r.detail.replace(/^customer none · overhead /, "Platform AI ") }));
}

export function platformAiCostFigure(inputs: EconomicsInputs, window: EconomicsWindow, checkedAt: string): EconomicsFigure {
  const label = window === "cycle" ? "Platform AI · this cycle" : `Platform AI · ${window.replace("d", " d")}`;
  if (!inputs.aiPricingConfigured) return unavailable("platform_ai_cost", label, "usd", REASON_NO_AI_RATE_CARD, PLATFORM_AI_BASIS, window, inputs.nowMs, checkedAt);
  const rows = platformAiDayRows(inputs, window);
  return figureFromRows({
    key: "platform_ai_cost", window, label, unit: "usd", basis: PLATFORM_AI_BASIS,
    covered: ["Comms Center authoring (Polish / Check)"], absent: [],
    emptyReason: rows.length === 0 ? REASON_NO_PLATFORM_AI : REASON_NO_AI_PRICED,
  }, rows, inputs.nowMs, checkedAt);
}

// ── Plaid (the Item-month census) ───────────────────────────────────────────────

const PRODUCT_LABEL: Readonly<Record<PlaidBillableProduct, string>> = { transactions: "Plaid · Transactions", investments: "Plaid · Investments" };

export function plaidRows(inputs: Pick<EconomicsInputs, "plaidCycle" | "plaidRates">): EconomicsDrillRow[] {
  const c = inputs.plaidCycle;
  if (!c) return [];
  const rows: EconomicsDrillRow[] = [];
  for (const product of ["transactions", "investments"] as const) {
    const months = c.itemMonths[product];
    if (months === 0) continue;
    // S2 (PR B review): Plaid bills Investments per Item-month only once the product is
    // INITIALIZED (Plaid's `billed_products`), not merely consented. The census counts
    // consented Items, and `billed_products` is not stored, so these Item-months are
    // NOT EVIDENCED as billed: counted and named, never priced (the figure is PARTIAL).
    if (product === "investments") {
      rows.push({ id: "plaid-investments", label: PRODUCT_LABEL.investments, value: null, status: "UNAVAILABLE", detail: investmentsGap(months) });
      continue;
    }
    const rate = plaidRateAt(product, c.cycle.start, inputs.plaidRates);
    rows.push(rate
      ? { id: `plaid-${product}`, label: PRODUCT_LABEL[product], value: months * rate.usdPerItemMonth, status: "ESTIMATED", detail: `${months} Item-month${months === 1 ? "" : "s"} × $${rate.usdPerItemMonth.toFixed(2)}` }
      : { id: `plaid-${product}`, label: PRODUCT_LABEL[product], value: null, status: "UNAVAILABLE", detail: `${months} Item-month${months === 1 ? "" : "s"} — no rate in force for the cycle` });
  }
  return rows;
}

/** Why consented Investments Item-months are not priced (exported: the UI and tests say the same words). */
export const REASON_INVESTMENTS_NOT_EVIDENCED = "billed only once initialized (Plaid billed_products), which is not stored — consent alone is not evidence";
export function investmentsGap(months: number): string {
  return `${months} consented Item-month${months === 1 ? "" : "s"} — ${REASON_INVESTMENTS_NOT_EVIDENCED}; not counted`;
}

/** Census caveats that make a priced Plaid figure a lower bound (or uncertain). */
export function plaidCaveats(inputs: Pick<EconomicsInputs, "plaidCycle" | "plaidReadingsAgree">): string[] {
  const c = inputs.plaidCycle;
  if (!c) return [];
  const out = c.coverage.incomplete ? c.coverage.reasons.map((r) => `Plaid census — ${r}`) : [];
  if (c.unevidencedProductItemMonths > 0) out.push(`Plaid census — ${c.unevidencedProductItemMonths} Item-month(s) whose product could not be evidenced`);
  if (!inputs.plaidReadingsAgree) out.push("Plaid census — the two invoice readings disagree; showing Items present during the cycle");
  return out;
}

export const PLAID_BASIS = "PlaidItem census × invoice-derived Item-month rate (present during the cycle); sandbox and seeded Items excluded";

export function plaidEmptyReason(inputs: Pick<EconomicsInputs, "plaidCycle" | "plaidRates">): string {
  if (inputs.plaidRates.length === 0) return REASON_NO_PLAID_RATE;
  if (!inputs.plaidCycle) return REASON_NO_PLAID_CYCLE;
  return REASON_NO_PLAID_PRICED;
}

// ── The cycle figures ───────────────────────────────────────────────────────────

/** The operating-cost components this cycle: AI (customer, overhead), Plaid products, and the unmetered parts. */
export function operatingCostRows(inputs: EconomicsInputs): EconomicsDrillRow[] {
  const ai = aiDayRows(inputs, "cycle");
  const aiPriced = inputs.aiPricingConfigured && ai.some((r) => r.value !== null);
  const unpricedAi = inputs.aiPricingConfigured ? ai.reduce((a, r) => a + (r.status === "ESTIMATED" ? 0 : 1), 0) : 0;
  const { from, to } = windowRange("cycle", inputs.nowMs);
  // PR C — Platform AI (operator features) is its own component; customer / overhead exclude it.
  const nonPlatform = { spendGroups: inputs.spendGroups.filter((g) => !isPlatformAiSurface(g.surface)) };
  const days = inputs.aiPricingConfigured ? aiDays(nonPlatform, from, to).filter((d) => d.observed) : [];
  const platformRows = platformAiDayRows(inputs, "cycle");
  const platform = rowsTotal(platformRows);
  let customer: number | null = null, overhead: number | null = null;
  for (const d of days) {
    if (d.customerUsd !== null) customer = (customer ?? 0) + d.customerUsd;
    if (d.overheadUsd !== null) overhead = (overhead ?? 0) + d.overheadUsd;
  }
  const aiReason = !inputs.aiPricingConfigured ? REASON_NO_AI_RATE_CARD : ai.length === 0 ? REASON_NO_AI_CALLS : REASON_NO_AI_PRICED;
  const aiStatus = (v: number | null): EconomicsStatus => (v === null ? "UNAVAILABLE" : unpricedAi > 0 ? "PARTIAL" : "ESTIMATED");
  const aiDetail = (v: number | null, what: string) => (v === null ? (aiPriced ? `no priced ${what} spend this cycle` : aiReason) : `${what} · tokens × rate card${unpricedAi > 0 ? ` · ${unpricedAi} day(s) with unpriced calls not counted` : ""}`);
  const rows: EconomicsDrillRow[] = [
    { id: "ai-customer", label: "AI · customer surfaces", value: customer, status: aiStatus(customer), detail: aiDetail(customer, "Conversations + Daily Brief") },
    { id: "ai-overhead", label: "AI · overhead", value: overhead, status: aiStatus(overhead), detail: aiDetail(overhead, "evaluation + unattributed") },
  ];
  // Only when the ledger holds Platform AI rows this cycle: no usage is not a missing part.
  if (platformRows.length > 0) {
    rows.push({ id: "ai-platform", label: "AI · Platform AI", value: platform,
      status: platform === null ? "UNAVAILABLE" : platformRows.some((r) => r.status !== "ESTIMATED") ? "PARTIAL" : "ESTIMATED",
      detail: platform === null ? REASON_NO_AI_PRICED : "operator features (Comms authoring) · tokens × rate card" });
  }
  const plaid = plaidRows(inputs);
  if (plaid.length > 0) rows.push(...plaid);
  else rows.push({ id: "plaid", label: "Plaid", value: null, status: "UNAVAILABLE", detail: plaidEmptyReason(inputs) });
  rows.push({ id: "other-providers", label: "Other providers", value: null, status: "UNAVAILABLE", detail: REASON_OTHER_PROVIDERS_NOT_METERED });
  rows.push({ id: "infrastructure", label: "Infrastructure", value: null, status: "UNAVAILABLE", detail: REASON_INFRA_NOT_METERED });
  return rows;
}

export function providerCostRows(inputs: EconomicsInputs): EconomicsDrillRow[] {
  const plaid = plaidRows(inputs);
  return [
    ...(plaid.length > 0 ? plaid : [{ id: "plaid", label: "Plaid", value: null, status: "UNAVAILABLE" as const, detail: plaidEmptyReason(inputs) }]),
    { id: "other-providers", label: "Other providers", value: null, status: "UNAVAILABLE", detail: REASON_OTHER_PROVIDERS_NOT_METERED },
  ];
}

export function activeCustomerRows(inputs: EconomicsInputs): EconomicsDrillRow[] {
  return inputs.engagedCustomerRefs.map((ref) => ({ id: ref, label: ref, value: 1, status: "MEASURED" as const, detail: "engaged this cycle" }));
}

/** Each operating-cost component's share per engaged customer — Σ = the KPI (empty when no customer engaged). */
export function costPerCustomerRows(inputs: EconomicsInputs): EconomicsDrillRow[] {
  const n = inputs.engagedCustomerRefs.length;
  if (n === 0) return [];
  return operatingCostRows(inputs).map((r) => ({
    ...r,
    value: r.value === null ? null : r.value / n,
    detail: r.value === null ? r.detail : `${fmt(r.value)} ÷ ${n} engaged customer${n === 1 ? "" : "s"}`,
  }));
}

const OPERATING_BASIS = "AI (invocation ledger × rate card) + Plaid (Item-months × invoice-derived rate) this cycle; other providers and infrastructure are not metered";

/** One figure, from the same rows its drill returns. */
export function economicsFigure(inputs: EconomicsInputs, key: OverviewFigureKey, window: EconomicsWindow, checkedAt: string): EconomicsFigure {
  const now = inputs.nowMs;
  switch (key) {
    case "ai_cost":
      return aiCostFigure(inputs, window, checkedAt);
    case "operating_cost":
      return figureFromRows({
        key, window: "cycle", label: "Operating cost · this cycle", unit: "usd", basis: OPERATING_BASIS,
        covered: ["AI (OpenAI, every surface)", "Plaid (Transactions, Investments)"], absent: plaidCaveats(inputs),
        emptyReason: REASON_NOTHING_PRICED,
      }, operatingCostRows(inputs), now, checkedAt);
    case "provider_cost":
      return figureFromRows({
        key, window: "cycle", label: "Providers · this cycle", unit: "usd", basis: PLAID_BASIS,
        covered: ["Plaid (Transactions, Investments)"], absent: plaidCaveats(inputs),
        emptyReason: plaidEmptyReason(inputs),
      }, providerCostRows(inputs), now, checkedAt);
    case "infra_cost":
      return unavailable(key, "Infrastructure · this cycle", "usd", REASON_INFRA_NOT_METERED, "hosting and database spend have no metered source", "cycle", now, checkedAt);
    case "active_customers": {
      // A COUNT read from the engagement ledgers: zero engaged customers is a measured 0, not missing data.
      const range = windowRange("cycle", now);
      return {
        key, window: "cycle", label: "Active customers · this cycle", unit: "count",
        value: inputs.engagedCustomerRefs.length, status: "MEASURED", reason: null,
        coverage: { covered: ["engagement facts since the cycle start"], missing: [] },
        freshness: { asOf: checkedAt, from: range.from, to: range.to },
        basis: "customers with a meaningful engagement fact since the cycle start (PB-10: customer-surface AI calls ∪ engagement audit actions) — never sessions",
        drill: drillRef(key, "cycle", checkedAt),
      };
    }
    case "cost_per_active_customer": {
      const op = economicsFigure(inputs, "operating_cost", "cycle", checkedAt);
      const rows = costPerCustomerRows(inputs);
      return figureFromRows({
        key, window: "cycle", label: "Cost per active customer", unit: "usd",
        basis: "operating cost this cycle ÷ customers engaged this cycle (PB-10 engagement)",
        covered: op.coverage.covered, absent: plaidCaveats(inputs),
        emptyReason: inputs.engagedCustomerRefs.length === 0 ? REASON_NO_ENGAGED : REASON_NOTHING_PRICED,
      }, rows, now, checkedAt);
    }
    case "platform_ai_cost":
      return platformAiCostFigure(inputs, window, checkedAt);
    case "revenue":
      return unavailable(key, "Revenue", "usd", REASON_NO_BILLING, "no billing source is connected; revenue is never inferred", "cycle", now, checkedAt);
    case "margin":
      return unavailable(key, "Margin", "usd", REASON_NO_BILLING, "margin needs revenue, and there is no billing source", "cycle", now, checkedAt);
  }
}

/** The records behind one figure — the rows its value is the sum of. */
export function economicsDrillRows(inputs: EconomicsInputs, key: OverviewFigureKey, window: EconomicsWindow): EconomicsDrillRow[] {
  switch (key) {
    case "ai_cost": return inputs.aiPricingConfigured ? aiDayRows(inputs, window) : [];
    case "platform_ai_cost": return platformAiDayRows(inputs, window);
    case "operating_cost": return operatingCostRows(inputs);
    case "provider_cost": return providerCostRows(inputs);
    case "active_customers": return activeCustomerRows(inputs);
    case "cost_per_active_customer": return costPerCustomerRows(inputs);
    default: return [];
  }
}

export const TREND_NOTE =
  "Daily trend is AI only: Plaid is billed per Item-month and never allocated to days, and other providers and infrastructure are not metered. A day without a ledger row is a gap, not $0.";

export function buildEconomicsSnapshot(inputs: EconomicsInputs): EconomicsSnapshot {
  const checkedAt = new Date(inputs.nowMs).toISOString();
  const figures = Object.fromEntries(ECONOMICS_FIGURES.map((k) => [k, economicsFigure(inputs, k, "cycle", checkedAt)])) as Record<EconomicsFigureKey, EconomicsFigure>;
  const windows = Object.fromEntries(TREND_WINDOWS.map((w) => [w, aiCostFigure(inputs, w, checkedAt)])) as Record<TrendWindow, EconomicsFigure>;
  const platformAi = Object.fromEntries(TREND_WINDOWS.map((w) => [w, platformAiCostFigure(inputs, w, checkedAt)])) as Record<TrendWindow, EconomicsFigure>;
  const { from, to } = windowRange("90d", inputs.nowMs);
  const days = inputs.aiPricingConfigured ? aiDays(inputs, from, to) : calendarDays(from, to).map((day) => ({ day, observed: false, customerUsd: null, overheadUsd: null, totalUsd: null, unpricedInvocations: 0 }));
  return {
    checkedAt,
    cycle: { ...cycleOf(inputs.nowMs), today: dayKey(inputs.nowMs) },
    figures,
    trend: { windows, platformAi, days, note: TREND_NOTE },
    estimateNote: ESTIMATE_NOTE,
  };
}

export function buildEconomicsDrill(inputs: EconomicsInputs, key: OverviewFigureKey, window: EconomicsWindow): EconomicsDrillResponse {
  const checkedAt = new Date(inputs.nowMs).toISOString();
  const rows = economicsDrillRows(inputs, key, window);
  const figure = economicsFigure(inputs, key, window, checkedAt);
  // A count's records are counted (one row per customer); a dollar figure's are summed.
  return { figure, rows, total: figure.unit === "count" ? rows.length : rowsTotal(rows), checkedAt };
}

// ── The drill query (validated once, shared by the route and the URL mirror) ────

export interface EconomicsDrillQuery { figure: EconomicsFigureKey; window: EconomicsWindow; untilMs: number; group?: string }

/** Parse `figure`, `window`, `until` (epoch ms, ≤ now; else now). Null for a figure/window without records. */
export function parseEconomicsDrillQuery(p: URLSearchParams, nowMs: number): EconomicsDrillQuery | null {
  const figure = p.get("figure") as EconomicsFigureKey | null;
  const window = (p.get("window") ?? "cycle") as EconomicsWindow;
  if (!figure || !ALL_FIGURES.includes(figure)) return null;
  if (!DRILLABLE[figure]?.includes(window)) return null;
  const raw = Number(p.get("until"));
  const untilMs = Number.isFinite(raw) && raw > 0 && raw <= nowMs ? Math.floor(raw) : nowMs;
  if (figure === "group_cost") {
    // A policy group key in the catalogue's own shape; the reader re-checks it exists.
    const group = p.get("group");
    if (!group || !POLICY_GROUP_KEY_PATTERN.test(group)) return null;
    return { figure, window, untilMs, group };
  }
  return { figure, window, untilMs };
}
