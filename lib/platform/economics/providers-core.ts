/**
 * lib/platform/economics/providers-core.ts  (Platform Economics — PR B: Providers, cost view)
 *
 * "What does each provider cost us this cycle, and what can we not see?" — the
 * COST of a provider, never its health (provider health stays in Platform Ops ›
 * Providers; every row links there). Pure; same figure shape and status rules as
 * the Overview (snapshot-core.ts):
 *
 *   OpenAI      the AI invocation ledger (RETURNED calls × rate card), every surface,
 *               this cycle — the same day rows as the Overview's AI figure.
 *   Plaid       Item-months × the invoice-derived rate (ESTIMATED), per product, no
 *               daily allocation. Investments is billed only once INITIALIZED
 *               (Plaid `billed_products`), which is not stored, so consented
 *               Investments Item-months are counted and named, never priced ⇒ PARTIAL.
 *   Others      every other provider with recorded calls: UNAVAILABLE "not metered".
 *
 * Calls this cycle are MEASURED (ApiUsageCounter). Quotas: no provider exposes a cap
 * this app stores, so every row says "cap unknown" — a cap is never invented.
 */

import {
  AI_BASIS, PLAID_BASIS, REASON_NO_AI_CALLS, REASON_NO_AI_PRICED, REASON_NO_AI_RATE_CARD,
  REASON_OTHER_PROVIDERS_NOT_METERED, aiDayRows, cycleOf, figureFromRows, plaidCaveats, plaidEmptyReason, plaidRows, unavailable,
  type EconomicsDrillRow, type EconomicsFigure, type EconomicsInputs,
} from "@/lib/platform/economics/snapshot-core";

/** Calls recorded per provider this cycle (ApiUsageCounter, unit "calls"). */
export interface ProviderCallsFact { provider: string; calls: number }

export interface ProvidersInputs extends EconomicsInputs {
  /** null when the counter read is unavailable — calls then say so, never 0. */
  providerCalls: readonly ProviderCallsFact[] | null;
}

export const CAP_UNKNOWN = "cap unknown";
export const REASON_NO_CAP = "no provider exposes a quota this app stores";
/** The workspace that owns provider HEALTH — Economics links there and never restates it. */
export const PROVIDER_HEALTH_WORKSPACE = "platform-providers";

export interface EconomicsProviderRow {
  id: string;
  label: string;
  cost: EconomicsFigure;
  calls: { value: number | null; status: "MEASURED" | "UNAVAILABLE"; basis: string };
  quota: { cap: null; text: typeof CAP_UNKNOWN; reason: string };
  health: { workspaceId: typeof PROVIDER_HEALTH_WORKSPACE };
}

export interface EconomicsProvidersView {
  checkedAt: string;
  cycle: { start: string; end: string };
  providers: readonly EconomicsProviderRow[];
  /** How many providers have a priced cost vs none. */
  metered: number;
  unmetered: number;
  note: string;
}

export const PROVIDERS_NOTE =
  "Cost only — provider health lives in Platform Operations › Providers. Estimates from code-owned rate cards, never a bill; Plaid is billed per Item-month and never allocated to days.";

const titleCase = (id: string) => id.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function openAiRows(inputs: EconomicsInputs): EconomicsDrillRow[] {
  if (!inputs.aiPricingConfigured) return [];
  return aiDayRows({ nowMs: inputs.nowMs, spendGroups: inputs.spendGroups.filter((g) => g.provider === "OPENAI") }, "cycle");
}

export function openAiCostFigure(inputs: EconomicsInputs, checkedAt: string): EconomicsFigure {
  if (!inputs.aiPricingConfigured) return unavailable("openai_cost", "OpenAI · this cycle", "usd", REASON_NO_AI_RATE_CARD, AI_BASIS, "cycle", inputs.nowMs, checkedAt);
  const rows = openAiRows(inputs);
  return figureFromRows({
    key: "openai_cost", window: "cycle", label: "OpenAI · this cycle", unit: "usd", basis: AI_BASIS,
    covered: ["OpenAI · every surface"], absent: [], emptyReason: rows.length === 0 ? REASON_NO_AI_CALLS : REASON_NO_AI_PRICED,
  }, rows, inputs.nowMs, checkedAt);
}

export function plaidCostFigure(inputs: EconomicsInputs, checkedAt: string): EconomicsFigure {
  return figureFromRows({
    key: "plaid_cost", window: "cycle", label: "Plaid · this cycle", unit: "usd", basis: PLAID_BASIS,
    covered: ["Plaid Transactions Item-months"], absent: plaidCaveats(inputs), emptyReason: plaidEmptyReason(inputs),
  }, plaidRows(inputs), inputs.nowMs, checkedAt);
}

/** The records behind a provider figure (Σ = the figure, as for every Overview figure). */
export function providerDrillRows(inputs: EconomicsInputs, key: "openai_cost" | "plaid_cost"): EconomicsDrillRow[] {
  return key === "openai_cost" ? openAiRows(inputs) : plaidRows(inputs);
}

export function buildProvidersView(inputs: ProvidersInputs): EconomicsProvidersView {
  const checkedAt = new Date(inputs.nowMs).toISOString();
  const callsBy = new Map((inputs.providerCalls ?? []).map((c) => [c.provider, c.calls] as const));
  const calls = (id: string): EconomicsProviderRow["calls"] => inputs.providerCalls === null
    ? { value: null, status: "UNAVAILABLE", basis: "call counter unavailable" }
    : { value: callsBy.get(id) ?? 0, status: "MEASURED", basis: "ApiUsageCounter calls since the cycle start" };
  const row = (id: string, label: string, cost: EconomicsFigure): EconomicsProviderRow => ({
    id, label, cost, calls: calls(id),
    quota: { cap: null, text: CAP_UNKNOWN, reason: REASON_NO_CAP },
    health: { workspaceId: PROVIDER_HEALTH_WORKSPACE },
  });
  const providers: EconomicsProviderRow[] = [
    row("OPENAI", "OpenAI", openAiCostFigure(inputs, checkedAt)),
    row("PLAID", "Plaid", plaidCostFigure(inputs, checkedAt)),
  ];
  const others = [...new Set((inputs.providerCalls ?? []).map((c) => c.provider))]
    .filter((p) => p !== "OPENAI" && p !== "PLAID").sort();
  for (const id of others) {
    providers.push(row(id, titleCase(id), unavailable("provider_unmetered", `${titleCase(id)} · this cycle`, "usd",
      REASON_OTHER_PROVIDERS_NOT_METERED, "no rate card or invoice for this provider", "cycle", inputs.nowMs, checkedAt)));
  }
  const metered = providers.filter((p) => p.cost.value !== null).length;
  return {
    checkedAt,
    cycle: cycleOf(inputs.nowMs),
    providers, metered, unmetered: providers.length - metered, note: PROVIDERS_NOTE,
  };
}
