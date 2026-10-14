/**
 * lib/platform/ops/overview-core.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The PURE derivation of the operations overview: one status per operational
 * domain, each derived from evidence its authority actually recorded, never
 * from the absence of an error row.
 *
 * STATES — used only where the evidence supports them:
 *   HEALTHY   the authority recorded work in the window and none of it failed
 *   DEGRADED  some work failed AND some succeeded (or a source needs attention
 *             while others are fine)
 *   FAILED    work was attempted and nothing succeeded, or a job is dead/failing
 *   STALE     nothing failed, but something is overdue against its policy
 *   UNKNOWN   no evidence in the window, or the authority cannot observe the
 *             property at all (the AI ledger records successes only)
 *
 * Every domain carries its `basis` — the authority the verdict came from — so
 * the operator can answer "what says that?" without leaving the page.
 */

import type { PipelineStatus } from "@/lib/platform/refresh/types";
import type { ConnectionHealthResult } from "@/lib/connections/health";
import type { RefreshPolicies } from "@/lib/platform/refresh-policy";
import type { ProviderHealthResult, ProviderTrust } from "@/lib/platform/provider-health";
import type { ResourceFreshnessResult } from "@/lib/platform/resource-freshness";
import type { EnvReport } from "@/lib/env";
import type { AlertLatestEvaluation } from "@/lib/alerts/latest-evaluation";

export type DomainState = "HEALTHY" | "DEGRADED" | "FAILED" | "STALE" | "UNKNOWN";

export interface DomainFact {
  label: string;
  value: string;
  /** Presentation hint; the fact's meaning is in its label and value. */
  tone?: "ok" | "warn" | "bad" | "muted";
}

/**
 * UX-P1 — the ONE figure a domain is judged by on the status board, chosen
 * here so the client derives nothing. `value` is short enough to earn the
 * figure size ("0 of 1 failed"); `qualifier` is the one line beneath it.
 */
export interface DomainFigure {
  value: string;
  qualifier: string;
}

export interface DomainStatus {
  key: "pipeline" | "sources" | "jobs" | "ai" | "brief" | "plaid";
  title: string;
  state: DomainState;
  /** One sentence an operator can act on. */
  headline: string;
  /** The status board's figure for this domain (server-chosen). */
  figure: DomainFigure;
  facts: readonly DomainFact[];
  /** The authority this verdict was derived from. */
  basis: string;
  /** Rail workspace id an operator drills into. */
  workspace: string;
}

// ── Inputs (already read by their authorities) ──────────────────────────────

export interface JobHealthCounts { healthy: number; running: number; overdue: number; failing: number; dead: number; neverRan: number }

export interface AiOverviewInput {
  /** Billed (RETURNED) invocations in the window. */
  invocations: number;
  usd: number | null;
  unpricedTokens: number;
  cacheShare: number | null;
  windowLabel: string;
  /**
   * OPERATIONALIZATION P0 — provider calls in the window that threw, from the
   * ledger's failure rows (lib/ai/invocation.ts). Before these existed the AI
   * domain was UNKNOWN by construction; now it is a real health domain.
   */
  failures: { failed: number; timeouts: number; rateLimited: number; quota: number };
}

export interface BriefOverviewInput {
  windowLabel: string;
  generated: number;
  failed: number;
  inProgress: number;
  versionStale: number;
  usd: number | null;
  uncorrelatedGenerations: number;
}

export interface PlaidOverviewInput {
  billableItems: number;
  byStatus: Readonly<Record<string, number>>;
  currentCycle: { transactions: number; investments: number; usd: number | null; agree: boolean; label: string };
  priceConfigured: boolean;
}

export interface OverviewInputs {
  pipeline: PipelineStatus;
  pipelineWindowLabel: string;
  sources: ConnectionHealthResult;
  jobs: JobHealthCounts;
  ai: AiOverviewInput;
  brief: BriefOverviewInput;
  plaid: PlaidOverviewInput;
  policies: RefreshPolicies;
}

// ── Formatting helpers (pure, locale-free) ───────────────────────────────────

const usd = (v: number | null): string => (v === null ? "not priced" : `$${v.toFixed(2)}`);
const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);
const span = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
};
const relative = (iso: string | null, now: Date): string => {
  if (!iso) return "never recorded";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never recorded";
  if (Math.abs(ms) < 60_000) return "just now";
  return ms > 0 ? `${span(ms)} ago` : `in ${span(-ms)}`;
};

// ── Domain derivations ───────────────────────────────────────────────────────

export function derivePipeline(p: PipelineStatus, windowLabel: string, now: Date): DomainStatus {
  const failed = (p.byStatus.FAILED ?? 0) + (p.byStatus.PARTIAL ?? 0);
  const succeeded = p.byStatus.SUCCEEDED ?? 0;
  const attempted = failed + succeeded;
  const state: DomainState =
    p.executions === 0 ? "UNKNOWN"
    : attempted === 0 ? "UNKNOWN"
    : failed === 0 ? "HEALTHY"
    : succeeded === 0 ? "FAILED"
    : "DEGRADED";
  const wallet = p.kinds.find((k) => k.kind === "WALLET");
  const plaid = p.kinds.find((k) => k.kind === "PLAID_ITEM");
  const failingNetworks = p.networks.filter((n) => n.lastStatus === "FAILED" || n.lastStatus === "PARTIAL").map((n) => n.network);
  const headline =
    state === "UNKNOWN" ? `No refresh executions recorded in the ${windowLabel}.`
    : state === "HEALTHY" ? `${succeeded} refresh execution${succeeded === 1 ? "" : "s"} in the ${windowLabel}, none failed.`
    : state === "FAILED" ? `${failed} refresh execution${failed === 1 ? "" : "s"} failed in the ${windowLabel} and none succeeded${failingNetworks.length ? ` (${failingNetworks.join(", ")})` : ""}.`
    : `${failed} of ${attempted} refresh executions failed in the ${windowLabel}${failingNetworks.length ? `; last run failed on ${failingNetworks.join(", ")}` : ""}.`;
  const facts: DomainFact[] = [
    { label: "Executions", value: String(p.executions) },
    { label: "Failed", value: String(failed), tone: failed > 0 ? "bad" : "ok" },
    { label: "Running now", value: String(p.openExecutions), tone: p.openExecutions > 0 ? "warn" : undefined },
    { label: "Last bank success", value: relative(plaid?.lastSucceededAt ?? null, now), tone: plaid?.lastSucceededAt ? undefined : "muted" },
    { label: "Last wallet success", value: relative(wallet?.lastSucceededAt ?? null, now), tone: wallet?.lastSucceededAt ? undefined : "muted" },
  ];
  const figure: DomainFigure =
    state === "UNKNOWN"
      ? { value: "none recorded", qualifier: `${p.executions} execution${p.executions === 1 ? "" : "s"} in the ${windowLabel}` }
      : { value: `${failed} of ${attempted} failed`, qualifier: `${p.executions} execution${p.executions === 1 ? "" : "s"}${p.openExecutions ? ` · ${p.openExecutions} running` : ""} · ${windowLabel}` };
  return { key: "pipeline", title: "Refresh pipeline", state, headline, figure, facts, basis: "RefreshExecution ledger", workspace: "platform-refresh" };
}

export function deriveSources(s: ConnectionHealthResult, policies: RefreshPolicies): DomainStatus {
  const c = s.counts;
  const broken = (c.ERROR ?? 0) + (c.NEEDS_REAUTH ?? 0) + (c.REVOKED ?? 0);
  const degraded = c.DEGRADED ?? 0;
  const stale = c.STALE ?? 0;
  const state: DomainState =
    s.total === 0 ? "UNKNOWN"
    : broken > 0 && broken === s.total ? "FAILED"
    : broken > 0 || degraded > 0 ? "DEGRADED"
    : stale > 0 ? "STALE"
    : "HEALTHY";
  const headline =
    state === "UNKNOWN" ? "No connected sources."
    : state === "HEALTHY" ? `All ${s.total} sources are within their refresh policy.`
    : state === "STALE" ? `${stale} of ${s.total} sources are overdue against policy (banks ${policies.BANK.cadence}, wallets ${policies.WALLET.cadence}).`
    : `${broken} of ${s.total} sources need attention${degraded ? `; ${degraded} degraded` : ""}${stale ? `; ${stale} stale` : ""}.`;
  const facts: DomainFact[] = [
    { label: "Sources", value: String(s.total) },
    { label: "Healthy", value: String(c.HEALTHY ?? 0), tone: "ok" },
    { label: "Stale", value: String(stale), tone: stale ? "warn" : undefined },
    { label: "Need reconnect", value: String(c.NEEDS_REAUTH ?? 0), tone: c.NEEDS_REAUTH ? "bad" : undefined },
    { label: "Error", value: String((c.ERROR ?? 0) + (c.REVOKED ?? 0)), tone: (c.ERROR ?? 0) + (c.REVOKED ?? 0) ? "bad" : undefined },
  ];
  const figure: DomainFigure =
    s.total === 0 ? { value: "none connected", qualifier: "no syncing source in the live fleet" }
    : broken > 0 ? { value: `${broken} need attention`, qualifier: `of ${s.total} sources${degraded ? ` · ${degraded} degraded` : ""}${stale ? ` · ${stale} stale` : ""}` }
    : degraded > 0 ? { value: `${degraded} degraded`, qualifier: `of ${s.total} sources${stale ? ` · ${stale} stale` : ""}` }
    : { value: `${stale} stale`, qualifier: `of ${s.total} sources · banks ${policies.BANK.cadence}, wallets ${policies.WALLET.cadence}` };
  return { key: "sources", title: "Sources", state, headline, figure, facts, basis: "PlaidItem + Connection status, judged against the refresh policy", workspace: "platform-providers" };
}

export function deriveJobs(j: JobHealthCounts, nextSlotAt: string | null, now: Date): DomainStatus {
  const recorded = j.healthy + j.running + j.overdue + j.failing + j.dead;
  const state: DomainState =
    j.dead > 0 || j.failing > 0 ? "FAILED"
    : j.overdue > 0 ? "STALE"
    : recorded === 0 ? "UNKNOWN"
    : "HEALTHY";
  const headline =
    state === "FAILED" ? `${j.dead + j.failing} job${j.dead + j.failing === 1 ? "" : "s"} failing or dead.`
    : state === "STALE" ? `${j.overdue} job${j.overdue === 1 ? "" : "s"} overdue against the registry cadence.`
    : state === "UNKNOWN" ? `No job has recorded a run yet (${j.neverRan} registered).`
    : `${recorded} scheduled job${recorded === 1 ? "" : "s"} recorded runs and all are healthy${j.neverRan ? `; ${j.neverRan} never ran` : ""}.`;
  const facts: DomainFact[] = [
    { label: "Healthy", value: String(j.healthy), tone: "ok" },
    { label: "Running", value: String(j.running) },
    { label: "Overdue", value: String(j.overdue), tone: j.overdue ? "warn" : undefined },
    { label: "Failing / dead", value: String(j.failing + j.dead), tone: j.failing + j.dead ? "bad" : undefined },
    { label: "Never ran", value: String(j.neverRan), tone: j.neverRan ? "muted" : undefined },
    { label: "Next slot", value: nextSlotAt ? relative(nextSlotAt, now) : "not derivable" },
  ];
  const neverRan = j.neverRan ? `${j.neverRan} never ran` : null;
  const next = nextSlotAt ? `next due ${relative(nextSlotAt, now)}` : "next due not derivable";
  const figure: DomainFigure =
    state === "FAILED" ? { value: `${j.dead + j.failing} failing`, qualifier: [neverRan, next].filter(Boolean).join(" · ") }
    : state === "STALE" ? { value: `${j.overdue} overdue`, qualifier: [neverRan, next].filter(Boolean).join(" · ") }
    : state === "UNKNOWN" ? { value: "no runs yet", qualifier: [neverRan ?? "none registered", next].join(" · ") }
    : { value: `${recorded} healthy`, qualifier: [neverRan, next].filter(Boolean).join(" · ") };
  return { key: "jobs", title: "Scheduled jobs", state, headline, figure, facts, basis: "JobRun ledger against the job registry", workspace: "platform-jobs" };
}

export function deriveAi(a: AiOverviewInput): DomainStatus {
  const f = a.failures;
  // Rate limits the caller retried are noise unless nothing got through; the
  // hard failures are the ones that mean a user saw "couldn't update".
  const hard = f.failed + f.timeouts + f.quota;
  const total = a.invocations + hard + f.rateLimited;
  const state: DomainState =
    total === 0 ? "UNKNOWN"
    : f.quota > 0 ? "FAILED"
    : hard > 0 && a.invocations === 0 ? "FAILED"
    : hard > 0 ? "DEGRADED"
    : f.rateLimited > 0 && a.invocations === 0 ? "DEGRADED"
    : "HEALTHY";
  const headline =
    state === "UNKNOWN" ? `No AI invocations recorded in the ${a.windowLabel}.`
    : f.quota > 0 ? `${f.quota} provider call${f.quota === 1 ? "" : "s"} refused for QUOTA in the ${a.windowLabel} — the OpenAI account is out of credit; waiting will not cure it.`
    : state === "FAILED" ? `${hard} provider call${hard === 1 ? "" : "s"} failed in the ${a.windowLabel} and none returned.`
    : state === "DEGRADED" && hard > 0 ? `${hard} of ${a.invocations + hard} provider calls failed in the ${a.windowLabel}; ${a.invocations} returned, ${usd(a.usd)} estimated.`
    : state === "DEGRADED" ? `${f.rateLimited} rate-limited attempt${f.rateLimited === 1 ? "" : "s"} and no returned call in the ${a.windowLabel}.`
    : `${a.invocations} invocation${a.invocations === 1 ? "" : "s"} returned in the ${a.windowLabel}, none failed, ${usd(a.usd)} estimated.`;
  const facts: DomainFact[] = [
    { label: "Returned", value: String(a.invocations) },
    { label: "Failed", value: String(hard), tone: hard > 0 ? "bad" : "ok" },
    { label: "Quota refusals", value: String(f.quota), tone: f.quota > 0 ? "bad" : undefined },
    { label: "Rate-limited", value: String(f.rateLimited), tone: f.rateLimited > 0 ? "warn" : undefined },
    { label: "Estimated spend", value: usd(a.usd), tone: a.usd === null && a.invocations > 0 ? "muted" : undefined },
    { label: "Cache share", value: pct(a.cacheShare) },
    { label: "Unpriced tokens", value: String(a.unpricedTokens), tone: a.unpricedTokens ? "warn" : undefined },
  ];
  const figure: DomainFigure =
    state === "UNKNOWN" ? { value: "none recorded", qualifier: `no invocation in the ${a.windowLabel}` }
    : f.quota > 0 ? { value: `${f.quota} quota refusal${f.quota === 1 ? "" : "s"}`, qualifier: `${a.invocations} returned · ${hard} failed · ${a.windowLabel}` }
    : { value: `${hard} failed`, qualifier: `${a.invocations} returned · ${usd(a.usd)} estimated${f.rateLimited ? ` · ${f.rateLimited} rate-limited` : ""} · ${a.windowLabel}` };
  return { key: "ai", title: "AI invocations", state, headline, figure, facts, basis: "AiInvocation ledger (billed and failed rows) priced by the code-owned rate card", workspace: "platform-ai" };
}

export function deriveBrief(b: BriefOverviewInput): DomainStatus {
  const attempted = b.generated + b.failed;
  const state: DomainState =
    attempted === 0 && b.inProgress === 0 ? "UNKNOWN"
    : b.failed > 0 && b.generated === 0 ? "FAILED"
    : b.failed > 0 ? "DEGRADED"
    : "HEALTHY";
  const headline =
    state === "UNKNOWN" ? `No Brief generated or failed in the ${b.windowLabel} — Briefs generate on demand.`
    : state === "HEALTHY" ? `${b.generated} Brief${b.generated === 1 ? "" : "s"} generated in the ${b.windowLabel}, none failed${b.versionStale ? `; ${b.versionStale} on an older generation version` : ""}.`
    : `${b.failed} Brief generation${b.failed === 1 ? "" : "s"} failed in the ${b.windowLabel}${b.generated ? `, ${b.generated} succeeded` : ""}.`;
  const facts: DomainFact[] = [
    { label: "Generated", value: String(b.generated), tone: "ok" },
    { label: "Failed", value: String(b.failed), tone: b.failed ? "bad" : undefined },
    { label: "In progress", value: String(b.inProgress) },
    { label: "Older version", value: String(b.versionStale), tone: b.versionStale ? "warn" : undefined },
    { label: "Generation spend", value: usd(b.usd), tone: b.uncorrelatedGenerations ? "warn" : undefined },
  ];
  const figure: DomainFigure =
    state === "UNKNOWN" ? { value: "none generated", qualifier: `on demand · ${b.inProgress} in progress · ${b.windowLabel}` }
    : { value: `${b.generated} generated`, qualifier: `${b.failed} failed${b.inProgress ? ` · ${b.inProgress} in progress` : ""}${b.versionStale ? ` · ${b.versionStale} older version` : ""} · ${b.windowLabel}` };
  return { key: "brief", title: "Daily Brief", state, headline, figure, facts, basis: "DailyBrief rows joined to AiInvocation by correlationId", workspace: "platform-ai" };
}

export function derivePlaid(p: PlaidOverviewInput): DomainStatus {
  const needsReauth = p.byStatus.NEEDS_REAUTH ?? 0;
  const error = p.byStatus.ERROR ?? 0;
  const state: DomainState = p.billableItems === 0 ? "UNKNOWN" : error > 0 || needsReauth > 0 ? "DEGRADED" : "HEALTHY";
  const c = p.currentCycle;
  const headline =
    state === "UNKNOWN" ? "No billable Plaid Items."
    : `${p.billableItems} billable Item${p.billableItems === 1 ? "" : "s"}; ${c.transactions} transactions and ${c.investments} investments Item-months this cycle, ${p.priceConfigured ? `${usd(c.usd)} estimated` : "cost authority not configured"}.`;
  const facts: DomainFact[] = [
    { label: "Billable Items", value: String(p.billableItems) },
    { label: "Active", value: String(p.byStatus.ACTIVE ?? 0), tone: "ok" },
    { label: "Need reconnect", value: String(needsReauth), tone: needsReauth ? "warn" : undefined },
    { label: "Item-months (cycle)", value: `${c.transactions} tx · ${c.investments} inv` },
    { label: "Estimated cost", value: p.priceConfigured ? usd(c.usd) : "not configured", tone: p.priceConfigured ? undefined : "muted" },
  ];
  const figure: DomainFigure =
    state === "UNKNOWN" ? { value: "0 billable Items", qualifier: "no Item is billable this cycle" }
    : { value: `${p.billableItems} billable Item${p.billableItems === 1 ? "" : "s"}`, qualifier: `${needsReauth + error} need attention · ${p.priceConfigured ? `${usd(c.usd)} estimated this cycle` : "cost authority not configured"}` };
  return { key: "plaid", title: "Plaid", state, headline, figure, facts, basis: "PlaidItem census × invoice-derived Item-month rates", workspace: "platform-costs" };
}

// ── UX-P1 · Posture (the four Platform Health groups, folded into the board) ──

export type PostureKey = "alerts" | "providers" | "freshness" | "configuration";

/** A posture chip's tone — the presentation vocabulary, declared server-side
 *  beside the word so the client maps nothing. */
export type PostureTone = "ok" | "warn" | "bad" | "muted";

export interface PostureChip {
  key: PostureKey;
  label: string;
  /** The verdict word, from the group's own authority. */
  word: string;
  tone: PostureTone;
  /** The short count text beside the word ("2 firing", "1 of 2 operational"). */
  count: string;
  /**
   * observed    the authority answered and was judged
   * unknown     the authority answered but has nothing to judge (never evaluated, empty registry)
   * unavailable the authority could not be asked — NOT zero, NOT fine
   */
  state: "observed" | "unknown" | "unavailable";
  /** Rail workspace id that holds the full read. */
  workspace: string;
  basis: string;
}

export interface PostureInputs {
  /** Null when the loader threw. `latest: null` inside means never evaluated. */
  alerts: { latest: AlertLatestEvaluation | null; rulesRegistered: number } | null;
  providers: ProviderHealthResult | null;
  freshness: ResourceFreshnessResult | null;
  configuration: EnvReport | null;
}

const TRUST_RANK: Record<ProviderTrust, number> = { FAILING: 0, STALE: 1, DEGRADED: 2, UNKNOWN: 3, OPERATIONAL: 4 };
const TRUST_WORD: Record<ProviderTrust, string> = { OPERATIONAL: "Operational", DEGRADED: "Degraded", STALE: "Stale data", FAILING: "Failing", UNKNOWN: "Unknown" };
const TRUST_TONE: Record<ProviderTrust, PostureTone> = { OPERATIONAL: "ok", DEGRADED: "warn", STALE: "warn", FAILING: "bad", UNKNOWN: "muted" };

const unavailable = (key: PostureKey, label: string, workspace: string, basis: string): PostureChip =>
  ({ key, label, word: "Unavailable", tone: "muted", count: "could not be asked", state: "unavailable", workspace, basis });

/**
 * ALERTS — firing NOW is the latest evaluation's verdict (lib/alerts/latest-evaluation.ts).
 * Delivery history never reaches this chip: a critical delivered two days ago is
 * the past, and the board must not keep it lit.
 */
export function deriveAlertsPosture(a: PostureInputs["alerts"]): PostureChip {
  const basis = "latest evaluate-alerts run (per-rule outcomes)";
  if (!a) return unavailable("alerts", "Alerts", "platform-policies", basis);
  if (a.rulesRegistered === 0) return { key: "alerts", label: "Alerts", word: "Unknown", tone: "muted", count: "no rules registered", state: "unknown", workspace: "platform-policies", basis };
  if (!a.latest) return { key: "alerts", label: "Alerts", word: "Unknown", tone: "muted", count: "never evaluated", state: "unknown", workspace: "platform-policies", basis };
  const firing = a.latest.rules.filter((r) => r.firing);
  const critical = firing.some((r) => r.severity === "critical");
  const evaluated = a.latest.rules.filter((r) => r.enabled).length;
  if (firing.length === 0) return { key: "alerts", label: "Alerts", word: "Quiet", tone: "ok", count: `0 of ${evaluated} firing`, state: "observed", workspace: "platform-policies", basis };
  return { key: "alerts", label: "Alerts", word: critical ? "Firing (critical)" : "Firing", tone: critical ? "bad" : "warn", count: `${firing.length} of ${evaluated} firing`, state: "observed", workspace: "platform-policies", basis };
}

/** PROVIDERS — the provider authority's own worst-wins trust roll-up. */
export function deriveProvidersPosture(p: PostureInputs["providers"]): PostureChip {
  const basis = "provider health roll-up (execution + content + connection)";
  if (!p) return unavailable("providers", "Providers", "platform-providers", basis);
  if (p.providers.length === 0) return { key: "providers", label: "Providers", word: "Unknown", tone: "muted", count: "none registered", state: "unknown", workspace: "platform-providers", basis };
  const worst = p.providers.reduce<ProviderTrust>((w, x) => (TRUST_RANK[x.trust] < TRUST_RANK[w] ? x.trust : w), "OPERATIONAL");
  return { key: "providers", label: "Providers", word: TRUST_WORD[worst], tone: TRUST_TONE[worst], count: `${p.counts.OPERATIONAL} of ${p.providers.length} operational`, state: "observed", workspace: "platform-providers", basis };
}

/**
 * FRESHNESS — mirrors lib/alerts/evaluate.ts exactly: `empty` is a failure
 * unless its trust is "unknown" (a known-blocked pipeline — honest, not a false
 * alarm); `stale` is a warning; fresh/idle are fine.
 */
export function deriveFreshnessPosture(f: PostureInputs["freshness"]): PostureChip {
  const basis = "resource freshness read from stored data, never a job's exit status";
  if (!f) return unavailable("freshness", "Freshness", "platform-providers", basis);
  if (f.resources.length === 0) return { key: "freshness", label: "Freshness", word: "Unknown", tone: "muted", count: "none registered", state: "unknown", workspace: "platform-providers", basis };
  const empty = f.resources.filter((r) => r.healthState === "empty" && r.trust.level !== "unknown").length;
  const blocked = f.resources.filter((r) => r.healthState === "empty" && r.trust.level === "unknown").length;
  const stale = f.resources.filter((r) => r.healthState === "stale").length;
  const notFresh = empty + stale;
  const count = `${notFresh} of ${f.resources.length} not fresh${blocked ? ` · ${blocked} blocked` : ""}`;
  if (empty > 0) return { key: "freshness", label: "Freshness", word: "Empty archive", tone: "bad", count, state: "observed", workspace: "platform-providers", basis };
  if (stale > 0) return { key: "freshness", label: "Freshness", word: "Stale", tone: "warn", count, state: "observed", workspace: "platform-providers", basis };
  if (blocked > 0 && blocked === f.resources.length) return { key: "freshness", label: "Freshness", word: "Unknown", tone: "muted", count, state: "unknown", workspace: "platform-providers", basis };
  return { key: "freshness", label: "Freshness", word: "Fresh", tone: "ok", count, state: "observed", workspace: "platform-providers", basis };
}

/** CONFIGURATION — lib/env.ts's own pass/warn/fail verdicts (names only, never values). */
export function deriveConfigurationPosture(e: PostureInputs["configuration"]): PostureChip {
  const basis = "environment report (variable names and verdicts only)";
  if (!e) return unavailable("configuration", "Configuration", "platform-policies", basis);
  const total = e.counts.pass + e.counts.warn + e.counts.fail;
  if (e.counts.fail > 0) return { key: "configuration", label: "Configuration", word: "Failing", tone: "bad", count: `${e.counts.fail} of ${total} failing · ${e.deploymentEnv}`, state: "observed", workspace: "platform-policies", basis };
  if (e.counts.warn > 0) return { key: "configuration", label: "Configuration", word: "Warning", tone: "warn", count: `${e.counts.warn} of ${total} warning · ${e.deploymentEnv}`, state: "observed", workspace: "platform-policies", basis };
  return { key: "configuration", label: "Configuration", word: "Set", tone: "ok", count: `${e.counts.pass} of ${total} set · ${e.deploymentEnv}`, state: "observed", workspace: "platform-policies", basis };
}

export function derivePosture(inputs: PostureInputs): readonly PostureChip[] {
  return [
    deriveAlertsPosture(inputs.alerts),
    deriveProvidersPosture(inputs.providers),
    deriveFreshnessPosture(inputs.freshness),
    deriveConfigurationPosture(inputs.configuration),
  ];
}

export interface OverviewCore {
  domains: readonly DomainStatus[];
  policies: { bank: string; wallet: string; bankOrigin: string; walletOrigin: string };
  worst: DomainState;
}

const RANK: Record<DomainState, number> = { FAILED: 0, DEGRADED: 1, STALE: 2, UNKNOWN: 3, HEALTHY: 4 };

export function buildOverview(inputs: OverviewInputs, nextSlotAt: string | null, now: Date): OverviewCore {
  const domains: DomainStatus[] = [
    derivePipeline(inputs.pipeline, inputs.pipelineWindowLabel, now),
    deriveSources(inputs.sources, inputs.policies),
    deriveJobs(inputs.jobs, nextSlotAt, now),
    deriveBrief(inputs.brief),
    deriveAi(inputs.ai),
    derivePlaid(inputs.plaid),
  ];
  // UNKNOWN never outranks a real verdict when computing the worst state.
  const known = domains.filter((d) => d.state !== "UNKNOWN");
  const worst = (known.length ? known : domains).reduce((w, d) => (RANK[d.state] < RANK[w] ? d.state : w), "HEALTHY" as DomainState);
  return {
    domains,
    policies: {
      bank: inputs.policies.BANK.cadence, wallet: inputs.policies.WALLET.cadence,
      bankOrigin: inputs.policies.BANK.origin, walletOrigin: inputs.policies.WALLET.origin,
    },
    worst,
  };
}
