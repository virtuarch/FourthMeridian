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

export type DomainState = "HEALTHY" | "DEGRADED" | "FAILED" | "STALE" | "UNKNOWN";

export interface DomainFact {
  label: string;
  value: string;
  /** Presentation hint; the fact's meaning is in its label and value. */
  tone?: "ok" | "warn" | "bad" | "muted";
}

export interface DomainStatus {
  key: "pipeline" | "sources" | "jobs" | "ai" | "brief" | "plaid";
  title: string;
  state: DomainState;
  /** One sentence an operator can act on. */
  headline: string;
  facts: readonly DomainFact[];
  /** The authority this verdict was derived from. */
  basis: string;
  /** Rail workspace id an operator drills into. */
  workspace: string;
}

// ── Inputs (already read by their authorities) ──────────────────────────────

export interface JobHealthCounts { healthy: number; running: number; overdue: number; failing: number; dead: number; neverRan: number }

export interface AiOverviewInput {
  invocations: number;
  usd: number | null;
  unpricedTokens: number;
  cacheShare: number | null;
  windowLabel: string;
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
  return { key: "pipeline", title: "Refresh pipeline", state, headline, facts, basis: "RefreshExecution ledger", workspace: "platform-refresh" };
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
  return { key: "sources", title: "Sources", state, headline, facts, basis: "PlaidItem + Connection status, judged against the refresh policy", workspace: "platform-providers" };
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
  return { key: "jobs", title: "Scheduled jobs", state, headline, facts, basis: "JobRun ledger against the job registry", workspace: "platform-jobs" };
}

export function deriveAi(a: AiOverviewInput): DomainStatus {
  // The ledger records billed, returned calls only, so health is not observable.
  const state: DomainState = "UNKNOWN";
  const headline = a.invocations === 0
    ? `No AI invocations recorded in the ${a.windowLabel}.`
    : `${a.invocations} invocation${a.invocations === 1 ? "" : "s"} in the ${a.windowLabel}, ${usd(a.usd)} estimated; failures are not recorded, so health is unknown.`;
  const facts: DomainFact[] = [
    { label: "Invocations", value: String(a.invocations) },
    { label: "Estimated spend", value: usd(a.usd), tone: a.usd === null && a.invocations > 0 ? "muted" : undefined },
    { label: "Cache share", value: pct(a.cacheShare) },
    { label: "Unpriced tokens", value: String(a.unpricedTokens), tone: a.unpricedTokens ? "warn" : undefined },
  ];
  return { key: "ai", title: "AI invocations", state, headline, facts, basis: "AiInvocation ledger priced by the code-owned rate card", workspace: "platform-ai" };
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
  return { key: "brief", title: "Daily Brief", state, headline, facts, basis: "DailyBrief rows joined to AiInvocation by correlationId", workspace: "platform-ai" };
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
  return { key: "plaid", title: "Plaid", state, headline, facts, basis: "PlaidItem census × invoice-derived Item-month rates", workspace: "platform-costs" };
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
