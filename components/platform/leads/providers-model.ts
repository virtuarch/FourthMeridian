/**
 * components/platform/leads/providers-model.ts  (Platform Ops visual spec §5 — Providers)
 *
 * PURE view-model behind the Providers dashboard ("integration intelligence").
 * One entity per provider that an existing reader REPORTS — nothing is listed
 * because we know it exists:
 *
 *   provider-health   Plaid, Open Exchange Rates (trust verdict, runs, freshness,
 *                     notes; the registry pair is always listed — when the read
 *                     fails each says so instead of disappearing)
 *   api-usage         every ApiUsageCounter provider with recorded calls
 *                     (today / 7 d / 30 d — MEASURED)
 *   provider-ops      ProviderCall roll-ups over the last 7 calendar UTC days:
 *                     failed / rate-limited attempts (MEASURED)
 *   email-health      Resend (NotificationDelivery counts; no verdict)
 *   plaid-usage       Plaid's Item-month cost this cycle (ESTIMATED)
 *   ai-usage-trend    OpenAI's token cost this cycle (ESTIMATED)
 *
 * HEALTH CLASSES (the donut + tiles): healthy / degraded / failing / not assessed.
 *   · the class is provider-health's verdict (OPERATIONAL → healthy; DEGRADED or
 *     STALE → degraded; FAILING → failing; UNKNOWN → not assessed);
 *   · provider-ops may only DOWNGRADE: ≥ FAILED_CALL_SHARE_DEGRADED of at least
 *     MIN_CALLS_FOR_SHARE attempts failed in 7 d ⇒ degraded (never "healthy"
 *     from call counts alone — a provider without a health authority whose calls
 *     look fine stays "Not assessed").
 *
 * HONESTY RULES (pinned by platform-visual-providers-ai.test.ts):
 *   · no reader exposes a usage cap, so every tile says "cap unknown" — never a
 *     number, never a bar;
 *   · spend is ESTIMATED only where a rate card answered, else UNKNOWN with the
 *     reason — never $0;
 *   · failures 7 d are a COUNT (no per-provider per-day series exists).
 *
 * No React, no fetch, no clock.
 */

import type { StatusTone } from "../platform-surface";
import type { ProviderHealth } from "@/lib/platform/provider-health";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { ApiUsageResponse } from "@/app/api/platform/platform-ops/api-usage/route";
import type { EmailHealthResponse } from "@/app/api/platform/platform-ops/email-health/route";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import type { ProviderOperationRollup, ProviderOperationSummary } from "@/lib/platform/refresh/types";
import { trustBadge } from "../widgets/provider-view";
import type { Fetched, Kpi } from "../ops-visual/ops-visual-model";
import { openAiCycleSpend, plaidCycleSpend, sumMoney, usd, type Money } from "./ai-costs-model";

/** Display identity for the provider strings the readers emit (ApiUsageCounter.provider, ProviderHealth.key, ProviderCall.provider). */
const KNOWN_LABEL: Readonly<Record<string, string>> = {
  PLAID: "Plaid",
  OPEN_EXCHANGE_RATES: "Open Exchange Rates",
  COINGECKO: "CoinGecko",
  ALCHEMY: "Alchemy",
  ESPLORA: "Esplora (Blockstream)",
  OPENAI: "OpenAI",
  RESEND: "Resend",
};

/** The provider-health registry pair: always listed, so a failed read is visible, never absent. */
const HEALTH_REGISTRY = ["PLAID", "OPEN_EXCHANGE_RATES"] as const;
/** Providers whose detail hosts connection diagnostics (their connections are customer sources). */
export const CONNECTION_PROVIDERS: ReadonlySet<string> = new Set(["PLAID", "ALCHEMY", "ESPLORA"]);
/** Providers whose data is a produced resource with a freshness cadence (FX, prices). */
const RESOURCE_PROVIDERS: ReadonlySet<string> = new Set(["OPEN_EXCHANGE_RATES", "COINGECKO"]);

export const CAP_UNKNOWN = "cap unknown";
export const NOT_ASSESSED = "Not assessed";
/** The provider-ops downgrade rule (see the module header). */
export const FAILED_CALL_SHARE_DEGRADED = 0.05;
export const MIN_CALLS_FOR_SHARE = 20;
/** The provider-operations read this dashboard asks for: the last 7 calendar UTC days. */
export const OPS_WINDOW_DAYS = 7;

export type HealthClass = "healthy" | "degraded" | "failing" | "not-assessed";
export const HEALTH_CLASS_LABEL: Record<HealthClass, string> = { healthy: "Healthy", degraded: "Degraded", failing: "Failing", "not-assessed": NOT_ASSESSED };
export const HEALTH_CLASS_COLOR: Record<HealthClass, string> = {
  healthy: "var(--emerald-400)",
  degraded: "var(--accent-warning)",
  failing: "var(--coral-400)",
  "not-assessed": "var(--text-faint)",
};
const CLASS_RANK: Record<HealthClass, number> = { failing: 0, degraded: 1, healthy: 2, "not-assessed": 3 };

export interface ProviderEntity {
  key: string;
  label: string;
  status: { word: string; tone: StatusTone };
  healthClass: HealthClass;
  /** Which authority the status word is from (or why there is none). */
  statusBasis: string;
  /** ApiUsageCounter calls, or null when the provider is not metered there. */
  usage: { today: number; d7: number; d30: number } | null;
  /** Never a number today: no reader exposes a provider cap. */
  cap: typeof CAP_UNKNOWN;
  /** Failed / rate-limited ProviderCall attempts and delivery errors over 7 d; count null = not recorded. */
  failures7d: { count: number | null; rateLimited: number | null; calls: number | null };
  /** provider-health's failed runs (its own run window), or null. */
  failedRuns: number | null;
  spend: Money;
  health: ProviderHealth | null;
  operations: readonly ProviderOperationRollup[];
  email: EmailHealthResponse | null;
  /** Hosted section keys this provider's detail offers as technical diagnostics. */
  diagnostics: readonly string[];
  /** ISO instant of the freshest read behind the row (provenance), or null. */
  asOf: string | null;
}

export interface ProviderInputs {
  health: Fetched<ProviderHealthResponse>;
  apiUsage: Fetched<ApiUsageResponse>;
  email: Fetched<EmailHealthResponse>;
  plaid: Fetched<PlaidUsage>;
  /** provider-operations over the last OPS_WINDOW_DAYS calendar UTC days. */
  operations: Fetched<ProviderOperationSummary>;
  trend: Fetched<AiUsageTrend>;
  nowMs: number;
}

const n = (v: number) => v.toLocaleString("en-US");
const plural = (c: number, w: string) => `${n(c)} ${w}${c === 1 ? "" : "s"}`;

function labelOf(key: string): string {
  return KNOWN_LABEL[key] ?? key.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function classOfTrust(trust: string): HealthClass {
  if (trust === "OPERATIONAL") return "healthy";
  if (trust === "DEGRADED" || trust === "STALE") return "degraded";
  if (trust === "FAILING") return "failing";
  return "not-assessed";
}

/** True when 7-day ProviderCall evidence downgrades a provider (see the module header). */
export function callsDegrade(calls: number, failed: number): boolean {
  return calls >= MIN_CALLS_FOR_SHARE && failed / calls >= FAILED_CALL_SHARE_DEGRADED;
}

/** Every provider a reader reports, worst first (failing → degraded → healthy → not assessed), then by name. */
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
  const plaidSpend = plaidCycleSpend(inp.plaid);
  const openAiSpend = openAiCycleSpend(inp.trend, inp.nowMs);

  const out = keys.map((key): ProviderEntity => {
    const h = health?.providers.find((p) => p.key === key) ?? null;
    const u = api?.providers.find((p) => p.provider === key) ?? null;
    const opRows = (ops?.operations ?? []).filter((o) => o.provider === key);
    const email = key === "RESEND" ? inp.email.data : null;

    const opCalls = opRows.reduce((a, o) => a + o.calls, 0);
    const opFailed = opRows.reduce((a, o) => a + o.failed, 0);
    const opLimited = opRows.reduce((a, o) => a + o.rateLimited, 0);
    const emailErrors = email && email.windowDays === OPS_WINDOW_DAYS ? email.counts.error : null;
    const counted = opRows.length > 0 || emailErrors !== null;
    const failures7d = {
      count: counted ? opFailed + (emailErrors ?? 0) : null,
      rateLimited: opRows.length > 0 ? opLimited : null,
      calls: opRows.length > 0 ? opCalls : null,
    };

    // Status: an authority's word; provider-ops may only downgrade it.
    let status: ProviderEntity["status"];
    let healthClass: HealthClass;
    let statusBasis: string;
    if (h) { status = trustBadge(h.trust); healthClass = classOfTrust(h.trust); statusBasis = "provider-health verdict"; }
    else if ((HEALTH_REGISTRY as readonly string[]).includes(key)) { status = { word: inp.health.loading ? "Reading" : "Unavailable", tone: "muted" }; healthClass = "not-assessed"; statusBasis = healthReason; }
    else { status = { word: NOT_ASSESSED, tone: "muted" }; healthClass = "not-assessed"; statusBasis = key === "RESEND" ? "delivery counts, no verdict" : "no health authority on a Platform Operations route"; }
    if ((healthClass === "healthy" || healthClass === "not-assessed") && callsDegrade(opCalls, opFailed)) {
      healthClass = "degraded";
      status = { word: "Degraded", tone: "warn" };
      statusBasis = `${Math.round((opFailed / opCalls) * 100)}% of ${n(opCalls)} provider calls failed in ${OPS_WINDOW_DAYS} d`;
    }

    const diagnostics: string[] = [];
    if (h || (HEALTH_REGISTRY as readonly string[]).includes(key)) diagnostics.push("ops_provider_health");
    if (opRows.length > 0 || key === "PLAID") diagnostics.push("ops_provider_operations");
    if (RESOURCE_PROVIDERS.has(key)) diagnostics.push("ops_resource_freshness");
    if (u) diagnostics.push("ops_api_usage");
    if (key === "RESEND") diagnostics.push("ops_email_delivery");
    if (CONNECTION_PROVIDERS.has(key)) diagnostics.push("ops_connection_diagnostics", "ops_provider_cleanup");

    const spend: Money = key === "PLAID" ? plaidSpend : key === "OPENAI" ? openAiSpend : { kind: "UNKNOWN", reason: "no rate card for this provider" };

    return {
      key, label: labelOf(key), status, healthClass, statusBasis,
      usage: u ? { today: u.callsToday, d7: u.calls7d, d30: u.calls30d } : null,
      cap: CAP_UNKNOWN,
      failures7d,
      failedRuns: h ? h.syncFailures : null,
      spend, health: h, operations: opRows, email, diagnostics,
      asOf: health?.checkedAt ?? ops?.checkedAt ?? null,
    };
  });

  return out.sort((a, b) => CLASS_RANK[a.healthClass] - CLASS_RANK[b.healthClass] || (b.usage?.today ?? -1) - (a.usage?.today ?? -1) || a.label.localeCompare(b.label));
}

// ── Dashboard figures ─────────────────────────────────────────────────────────

/** The donut: providers by health class. Σ value = the providers listed; zero slices dropped. */
export function healthDistribution(list: readonly ProviderEntity[]): { id: HealthClass; label: string; value: number; color: string }[] {
  return (["healthy", "degraded", "failing", "not-assessed"] as const)
    .map((c) => ({ id: c, label: HEALTH_CLASS_LABEL[c], value: list.filter((e) => e.healthClass === c).length, color: HEALTH_CLASS_COLOR[c] }))
    .filter((i) => i.value > 0);
}

/** The hero verdict: failing if any provider fails, degraded if any is degraded, healthy only when something was assessed. */
export function integrationVerdict(list: readonly ProviderEntity[], health: Fetched<ProviderHealthResponse>): { word: string; tone: StatusTone } {
  if (!health.data) return { word: health.loading ? "Reading" : "Unknown", tone: "muted" };
  if (list.some((e) => e.healthClass === "failing")) return { word: "Failing", tone: "bad" };
  if (list.some((e) => e.healthClass === "degraded")) return { word: "Degraded", tone: "warn" };
  if (list.some((e) => e.healthClass === "healthy")) return { word: "Healthy", tone: "ok" };
  return { word: "Unknown", tone: "muted" };
}

/** The hero's one caption line. */
export function integrationCaption(list: readonly ProviderEntity[]): string {
  const bad = list.filter((e) => e.healthClass === "failing" || e.healthClass === "degraded").length;
  const unassessed = list.filter((e) => e.healthClass === "not-assessed").length;
  const head = bad === 0 ? "No provider needs attention" : `${plural(bad, "provider")} need${bad === 1 ? "s" : ""} attention`;
  return unassessed > 0 ? `${head} · ${n(unassessed)} without a health authority` : head;
}

/** The estimated spend this cycle across providers with a rate card. */
export function cycleSpendTotal(list: readonly ProviderEntity[]): Money {
  return sumMoney(list.filter((e) => e.key === "PLAID" || e.key === "OPENAI").map((e) => e.spend));
}

export function providerKpis(list: readonly ProviderEntity[], inp: ProviderInputs): Kpi[] {
  const healthy = list.filter((e) => e.healthClass === "healthy").length;
  const unassessed = list.filter((e) => e.healthClass === "not-assessed").length;
  const out: Kpi[] = [{
    key: "healthy", label: "Providers healthy",
    value: inp.health.data ? `${n(healthy)}/${n(list.length)}` : "—",
    sub: inp.health.data ? (unassessed ? `${n(unassessed)} not assessed` : "all assessed") : inp.health.loading ? "reading…" : "unavailable",
    tone: inp.health.data ? undefined : "muted",
  }];
  const ops = inp.operations.data;
  if (ops) {
    const calls = ops.operations.reduce((a, o) => a + o.calls, 0);
    const failed = ops.operations.reduce((a, o) => a + o.failed, 0);
    const limited = ops.operations.reduce((a, o) => a + o.rateLimited, 0);
    out.push({ key: "failed", label: `Failed calls · ${OPS_WINDOW_DAYS} d`, value: n(failed), sub: `of ${n(calls)} attempts · measured`, tone: failed > 0 ? "warn" : undefined });
    out.push({ key: "limited", label: `Rate-limited · ${OPS_WINDOW_DAYS} d`, value: n(limited), sub: "provider attempts · measured", tone: limited > 0 ? "warn" : undefined });
  } else {
    const sub = inp.operations.loading ? "reading…" : "unavailable";
    out.push({ key: "failed", label: `Failed calls · ${OPS_WINDOW_DAYS} d`, value: "—", sub, tone: "muted" });
    out.push({ key: "limited", label: `Rate-limited · ${OPS_WINDOW_DAYS} d`, value: "—", sub, tone: "muted" });
  }
  const spend = cycleSpendTotal(list);
  out.push(spend.kind === "ESTIMATED"
    ? { key: "spend", label: "Est. spend · cycle", value: usd(spend.usd), sub: spend.partial ? "estimated · partial" : "estimated · Plaid + OpenAI" }
    : { key: "spend", label: "Est. spend · cycle", value: "Unknown", sub: "no rate card answered", tone: "muted" });
  return out;
}

/** "1,204 calls today · cap unknown" — the tile's usage words (no cap number, ever). */
export function usageText(e: ProviderEntity): string {
  if (e.key === "RESEND" && e.email) return `${plural(e.email.counts.total, "delivery")} · ${e.email.windowDays} d`;
  return e.usage ? `${plural(e.usage.today, "call")} today · ${CAP_UNKNOWN}` : `not metered · ${CAP_UNKNOWN}`;
}

/** "3 failed · 7 d" / "no failures · 7 d" / "failures not recorded". */
export function failuresText(e: ProviderEntity): string {
  const f = e.failures7d;
  if (f.count === null) return "failures not recorded";
  const limited = f.rateLimited ? ` · ${n(f.rateLimited)} rate-limited` : "";
  return f.count === 0 ? `no failures · ${OPS_WINDOW_DAYS} d${limited}` : `${n(f.count)} failed · ${OPS_WINDOW_DAYS} d${limited}`;
}

/** Fleet-wide diagnostics that belong to no single provider (each a hosted section). ≤ 5. */
export const FLEET_DIAGNOSTICS: readonly { id: string; name: string; keys: readonly string[] }[] = [
  { id: "diag:connections", name: "Connections", keys: ["ops_connection_diagnostics", "ops_provider_cleanup"] },
  { id: "diag:health", name: "Provider health table", keys: ["ops_provider_health"] },
  { id: "diag:operations", name: "Provider operations", keys: ["ops_provider_operations"] },
  { id: "diag:freshness", name: "Resource freshness", keys: ["ops_resource_freshness"] },
  { id: "diag:usage", name: "Usage ledger", keys: ["ops_api_usage", "ops_email_delivery"] },
];

/** Human titles for the hosted diagnostics inside a provider's detail. */
export const DIAGNOSTIC_TITLE: Readonly<Record<string, string>> = {
  ops_provider_health: "Provider health (all providers)",
  ops_provider_operations: "Provider operations (all providers)",
  ops_resource_freshness: "Resource freshness",
  ops_api_usage: "Usage ledger",
  ops_email_delivery: "Email delivery",
  ops_connection_diagnostics: "Connection diagnostics",
  ops_provider_cleanup: "Provider cleanup",
};
