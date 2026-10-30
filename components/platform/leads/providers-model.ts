/**
 * components/platform/leads/providers-model.ts  (Platform Operations 2.0 — R2, plan §4.3)
 *
 * PURE view-model behind the Providers master–detail. One entity per provider
 * that an existing reader REPORTS — nothing is listed because we know it exists:
 *
 *   provider-health   Plaid, Open Exchange Rates (trust verdict, runs, freshness,
 *                     notes; the registry pair is always listed — when the read
 *                     fails each says so instead of disappearing)
 *   api-usage         every ApiUsageCounter provider with recorded calls (Plaid,
 *                     OpenAI, Alchemy, Esplora, CoinGecko, …) + the AI token
 *                     spend estimate (rate card × tokens)
 *   provider-ops      ProviderCall roll-ups: failed / rate-limited attempts
 *   email-health      Resend (NotificationDelivery counts; no verdict)
 *   plaid-usage       Plaid's Item-month cost estimate (invoice-derived rate card)
 *
 * HONESTY RULES (pinned by ops2-r2.test.ts):
 *   · an allowance is printed only when a reader exposes one; none does today,
 *     so every row says "allowance unknown" — never a number, never a bar;
 *   · spend is ESTIMATED only where a rate card answered, else UNKNOWN with the
 *     reason — never $0;
 *   · a provider without a health authority is "Not assessed" (muted), never a
 *     health word derived here.
 *
 * No React, no fetch, no clock.
 */

import type { StatusTone } from "../platform-surface";
import type { ProviderHealth } from "@/lib/platform/provider-health";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { ApiUsageResponse } from "@/app/api/platform/platform-ops/api-usage/route";
import type { EmailHealthResponse } from "@/app/api/platform/platform-ops/email-health/route";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { ProviderOperationRollup, ProviderOperationSummary } from "@/lib/platform/refresh/types";
import { trustBadge } from "../widgets/provider-view";
import type { Fetched } from "./operations-model";

export type ProviderGroup = "data" | "wallets" | "services" | "other";

export const GROUP_LABEL: Record<ProviderGroup, string> = {
  data: "Banking & market data",
  wallets: "Wallet networks",
  services: "Platform services",
  other: "Other metered providers",
};
export const GROUP_ORDER: readonly ProviderGroup[] = ["data", "wallets", "services", "other"];

/** Display identity for the provider strings the readers emit (ApiUsageCounter.provider, ProviderHealth.key, ProviderCall.provider). */
const KNOWN: Readonly<Record<string, { label: string; group: ProviderGroup }>> = {
  PLAID:               { label: "Plaid", group: "data" },
  OPEN_EXCHANGE_RATES: { label: "Open Exchange Rates", group: "data" },
  COINGECKO:           { label: "CoinGecko", group: "data" },
  ALCHEMY:             { label: "Alchemy", group: "wallets" },
  ESPLORA:             { label: "Esplora (Blockstream)", group: "wallets" },
  OPENAI:              { label: "OpenAI", group: "services" },
  RESEND:              { label: "Resend", group: "services" },
};

/** The provider-health registry pair: always listed, so a failed read is visible, never absent. */
const HEALTH_REGISTRY = ["PLAID", "OPEN_EXCHANGE_RATES"] as const;
/** Providers whose detail links to connection diagnostics (their connections are customer sources). */
export const CONNECTION_PROVIDERS: ReadonlySet<string> = new Set(["PLAID", "ALCHEMY", "ESPLORA"]);

export const ALLOWANCE_UNKNOWN = "allowance unknown";
export const NOT_ASSESSED = "Not assessed";

export type Spend =
  | { kind: "ESTIMATED"; usd: number; window: string; basis: string }
  | { kind: "UNKNOWN"; reason: string };

export interface ProviderEntity {
  key: string;
  label: string;
  group: ProviderGroup;
  status: { word: string; tone: StatusTone };
  /** Which authority the status word is from (or why there is none). */
  statusBasis: string;
  /** ApiUsageCounter calls, or null when the provider is not metered there. */
  usage: { today: number; d7: number; d30: number } | null;
  /** Never a number today: no reader exposes a provider allowance. */
  allowance: { known: false; reason: string };
  errors: { count: number | null; text: string; window: string | null };
  rateLimited: number | null;
  spend: Spend;
  health: ProviderHealth | null;
  operations: readonly ProviderOperationRollup[];
  email: EmailHealthResponse | null;
  /** Hosted section keys this provider's detail offers as technical diagnostics. */
  diagnostics: readonly string[];
  /** ISO instant of the freshest read behind the row (provenance), or null. */
  asOf: string | null;
}

const n = (v: number) => v.toLocaleString("en-US");
const plural = (c: number, w: string) => `${n(c)} ${w}${c === 1 ? "" : "s"}`;
export const usd = (v: number) => `$${v.toFixed(2)}`;

function labelOf(key: string): { label: string; group: ProviderGroup } {
  return KNOWN[key] ?? { label: key.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), group: "other" };
}

function spendFor(key: string, api: ApiUsageResponse | null, plaid: Fetched<PlaidUsage>, apiFetch: Fetched<ApiUsageResponse>): Spend {
  if (key === "PLAID") {
    const p = plaid.data;
    if (!p) return { kind: "UNKNOWN", reason: plaid.loading ? "reading Plaid usage…" : `Plaid usage unavailable${plaid.error ? ` — ${plaid.error}` : ""}` };
    if (!p.priceAuthority.configured) return { kind: "UNKNOWN", reason: "no rate card configured" };
    const current = p.cycles.find((c) => c.label === "current");
    if (!current) return { kind: "UNKNOWN", reason: "no current billing cycle reported" };
    if (current.during.usd === null) return { kind: "UNKNOWN", reason: current.during.unpricedItemMonths ? "before the rate's evidence" : "nothing billable this cycle" };
    return { kind: "ESTIMATED", usd: current.during.usd, window: "current cycle", basis: "Item-months × invoice-derived rate" };
  }
  if (key === "OPENAI") {
    if (!api) return { kind: "UNKNOWN", reason: apiFetch.loading ? "reading usage…" : `usage unavailable${apiFetch.error ? ` — ${apiFetch.error}` : ""}` };
    if (!api.pricingConfigured) return { kind: "UNKNOWN", reason: "no AI rate card configured" };
    if (api.estimatedSpendUsd === null) return { kind: "UNKNOWN", reason: "no rate in force in the window" };
    return { kind: "ESTIMATED", usd: api.estimatedSpendUsd, window: "30 d", basis: "tokens × rate card" };
  }
  return { kind: "UNKNOWN", reason: "no rate card for this provider" };
}

export interface ProviderInputs {
  health: Fetched<ProviderHealthResponse>;
  apiUsage: Fetched<ApiUsageResponse>;
  email: Fetched<EmailHealthResponse>;
  plaid: Fetched<PlaidUsage>;
  operations: Fetched<ProviderOperationSummary>;
}

/** Every provider a reader reports, grouped, in a stable order (group, then health first, then name). */
export function providerEntities(inp: ProviderInputs): ProviderEntity[] {
  const health = inp.health.data;
  const api = inp.apiUsage.data;
  const ops = inp.operations.data;
  const keys: string[] = [];
  const add = (k: string) => { if (!keys.includes(k)) keys.push(k); };
  for (const k of HEALTH_REGISTRY) add(k);
  for (const p of health?.providers ?? []) add(p.key);
  for (const p of api?.providers ?? []) add(p.provider);
  if (api && api.models.length > 0) add("OPENAI");
  for (const o of ops?.operations ?? []) add(o.provider);
  if (inp.email.data || inp.email.error || inp.email.loading) add("RESEND");

  const healthReason = inp.health.loading ? "reading provider health…" : `provider health unavailable${inp.health.error ? ` — ${inp.health.error}` : ""}`;

  const out = keys.map((key): ProviderEntity => {
    const id = labelOf(key);
    const h = health?.providers.find((p) => p.key === key) ?? null;
    const u = api?.providers.find((p) => p.provider === key) ?? null;
    const opRows = (ops?.operations ?? []).filter((o) => o.provider === key);
    const email = key === "RESEND" ? inp.email.data : null;

    // Status: only an authority's word.
    let status: ProviderEntity["status"];
    let statusBasis: string;
    if (h) { status = trustBadge(h.trust); statusBasis = "provider-health verdict"; }
    else if ((HEALTH_REGISTRY as readonly string[]).includes(key)) { status = { word: inp.health.loading ? "Reading" : "Unavailable", tone: "muted" }; statusBasis = healthReason; }
    else { status = { word: NOT_ASSESSED, tone: "muted" }; statusBasis = key === "RESEND" ? "delivery counts, no verdict" : "no health authority on a Platform Operations route"; }

    // Errors / rate limiting: summed only from rows a reader returned.
    const parts: string[] = [];
    let count: number | null = null;
    let window: string | null = null;
    if (h) { count = (count ?? 0) + h.syncFailures; parts.push(plural(h.syncFailures, "failed run")); window = "recent runs"; }
    const opFailed = opRows.reduce((a, o) => a + o.failed, 0);
    const opLimited = opRows.reduce((a, o) => a + o.rateLimited, 0);
    if (opRows.length > 0) { count = (count ?? 0) + opFailed; parts.push(plural(opFailed, "failed call")); if (opLimited > 0) parts.push(`${n(opLimited)} rate-limited`); window = window ?? "projection window"; }
    if (email) { count = (count ?? 0) + email.counts.error; parts.push(plural(email.counts.error, "delivery error")); window = `${email.windowDays} d`; }
    const errors = count === null
      ? { count: null, text: "errors not recorded", window: null }
      : { count, text: count === 0 && opLimited === 0 ? "no errors recorded" : parts.filter((x) => !x.startsWith("0 ")).join(" · ") || "no errors recorded", window };

    const diagnostics: string[] = [];
    if (h || (HEALTH_REGISTRY as readonly string[]).includes(key)) diagnostics.push("ops_provider_health");
    if (opRows.length > 0 || key === "PLAID") diagnostics.push("ops_provider_operations");
    if (key === "RESEND") diagnostics.push("ops_email_delivery");

    return {
      key, label: id.label, group: id.group, status, statusBasis,
      usage: u ? { today: u.callsToday, d7: u.calls7d, d30: u.calls30d } : null,
      allowance: { known: false, reason: h?.notes.find((x) => /quota/i.test(x)) ?? "no allowance is exposed to Platform Operations" },
      errors,
      rateLimited: opRows.length > 0 ? opLimited : null,
      spend: spendFor(key, api, inp.plaid, inp.apiUsage),
      health: h, operations: opRows, email, diagnostics,
      asOf: health?.checkedAt ?? ops?.checkedAt ?? null,
    };
  });

  const rank = (e: ProviderEntity) => GROUP_ORDER.indexOf(e.group);
  return out.sort((a, b) => rank(a) - rank(b) || Number(b.health !== null) - Number(a.health !== null) || a.label.localeCompare(b.label));
}

/** Entities grouped for the master list (each group is one section; empty groups dropped). */
export function groupEntities(list: readonly ProviderEntity[]): { group: ProviderGroup; label: string; items: ProviderEntity[] }[] {
  return GROUP_ORDER
    .map((g) => ({ group: g, label: GROUP_LABEL[g], items: list.filter((e) => e.group === g) }))
    .filter((g) => g.items.length > 0);
}

/** "1,204 calls today" / "not metered" — the row's usage words (no allowance number, ever). */
export function usageText(e: ProviderEntity): string {
  if (e.key === "RESEND" && e.email) return `${plural(e.email.counts.total, "delivery")} · ${e.email.windowDays} d`;
  return e.usage ? `${plural(e.usage.today, "call")} today` : "not metered";
}

/** The spend cell's words: "$12.40" (estimated) or "Unknown". Never "$0" for unknown. */
export function spendText(s: Spend): string {
  return s.kind === "ESTIMATED" ? `${usd(s.usd)} · ${s.window}` : "Unknown";
}

/** The worst-first default selection: the first provider whose verdict is bad/warn, else the first. */
export function defaultSelection(list: readonly ProviderEntity[]): string | null {
  const worst = list.find((e) => e.status.tone === "bad") ?? list.find((e) => e.status.tone === "warn");
  return (worst ?? list[0])?.key ?? null;
}

/** Fleet-wide diagnostics that belong to no single provider (each a hosted section). */
export const FLEET_DIAGNOSTICS: readonly { id: string; name: string; summary: string; keys: readonly string[] }[] = [
  { id: "diag:connections", name: "Connections", summary: "Per-connection diagnostics, history recovery, provider cleanup", keys: ["ops_connection_diagnostics", "ops_provider_cleanup"] },
  { id: "diag:freshness", name: "Resource freshness", summary: "FX, prices and other produced resources against their cadence", keys: ["ops_resource_freshness"] },
  { id: "diag:usage", name: "Usage ledger", summary: "Calls per provider, AI tokens per model, estimated AI spend", keys: ["ops_api_usage"] },
];

/** Human titles for the hosted diagnostics inside a provider's detail. */
export const DIAGNOSTIC_TITLE: Readonly<Record<string, string>> = {
  ops_provider_health: "Provider health (all providers)",
  ops_provider_operations: "Provider operations (all providers)",
  ops_email_delivery: "Email delivery",
};
