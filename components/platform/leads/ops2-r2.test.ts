/**
 * components/platform/leads/ops2-r2.test.ts  (Platform Operations 2.0 — R2, plan §4.2–§4.3)
 *
 * The Operations and Providers redesign, pinned:
 *   A. the Operations default screen shows ≤ 5 items per section, never renders
 *      a fleet control, and opens every former widget only from a drawer;
 *   B. Providers lists only providers a reader REPORTS and never prints a
 *      number for an unknown cap or cost (visual spec §5 dashboard);
 *   C. connection diagnostics (with its history-recovery panel) and provider
 *      cleanup are HOSTED unchanged: rendered by the registry with the
 *      operator's access, never imported or re-gated by a lead;
 *   D. the dashboard renders a lead + hosted keys without inline anchors, and
 *      every hosted key is opened by its lead's source;
 *   E. source rules (no access-level literal, no viewport read, no raw fetch).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/ops2-r2.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDetail, ProvidersDrawerBody, ProvidersLeadSurface } from "./ProvidersLead";
import { PipelineLeadSurface, pipelineKpis } from "./PipelineLead";
import { CAP_UNKNOWN, FLEET_DIAGNOSTICS, NOT_ASSESSED, failuresText, providerEntities, type ProviderInputs } from "./providers-model";
import { PLATFORM_AREA_WORKSPACES, PLATFORM_SECTION_REPRESENTATION, viewComposedKeys } from "@/lib/platform/workspaces";
import { PlatformWorkspaceBody } from "../PlatformSpaceDashboard";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const failed = (error: string) => ({ data: null, loading: false, error });
const loading = { data: null, loading: true, error: null };
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const AGO = (min: number) => new Date(NOW - min * 60_000).toISOString();

/** Every <ul aria-label="…"> in `html` with its direct <li> count (lists here never nest). */
function lists(html: string): { label: string; items: number }[] {
  const out: { label: string; items: number }[] = [];
  const re = /<ul aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/ul>/g;
  for (const m of html.matchAll(re)) out.push({ label: m[1], items: (m[2].match(/<li[ >]/g) ?? []).length });
  return out;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const overviewData = {
  checkedAt: "2026-10-30T11:58:00.000Z", worst: "DEGRADED",
  domains: [
    { key: "pipeline", title: "Refresh pipeline", state: "HEALTHY", headline: "h", figure: { value: "0 of 12 failed", qualifier: "12 executions · since yesterday" }, facts: [], basis: "b", workspace: "platform-refresh" },
    { key: "sources", title: "Sources", state: "DEGRADED", headline: "h", figure: { value: "2 need attention", qualifier: "of 9" }, facts: [], basis: "b", workspace: "platform-providers" },
    { key: "jobs", title: "Scheduled jobs", state: "HEALTHY", headline: "h", figure: { value: "11 healthy", qualifier: "" }, facts: [], basis: "b", workspace: "platform-jobs" },
    { key: "brief", title: "Daily Brief", state: "HEALTHY", headline: "h", figure: { value: "x", qualifier: "" }, facts: [], basis: "b", workspace: "platform-ai" },
    { key: "ai", title: "AI", state: "UNKNOWN", headline: "h", figure: { value: "x", qualifier: "" }, facts: [], basis: "b", workspace: "platform-ai" },
    { key: "plaid", title: "Plaid", state: "HEALTHY", headline: "h", figure: { value: "x", qualifier: "" }, facts: [], basis: "b", workspace: "platform-costs" },
  ],
  policies: { bank: "24h", wallet: "6h", bankOrigin: "SETTING", walletOrigin: "DEFAULT" },
  windows: { pipeline: "since yesterday", ai: "24 h", brief: "24 h" },
  latestFailures: [], nextSlotAt: null,
  posture: [{ key: "alerts", label: "Alerts", word: "Clear", tone: "ok", count: "0", state: "observed", workspace: "platform-policies:alerts", basis: "b" }],
} as never;

const execRow = (i: number) => ({ id: `x${i}`, runId: `r${i}`, plaidItemId: `item_${i}abcdef`, sourceKind: "PLAID_ITEM", sourceRef: null, network: null, trigger: "CRON", profile: "p", startedAt: AGO(i * 7), completedAt: AGO(i * 7 - 1), durationMs: 4200, overallStatus: i === 2 ? "FAILED" : "SUCCEEDED", parentJobRunId: null, hasError: i === 2, deploymentSha: null, errorSummary: null, admissionReason: null, failureStage: null, failureCategory: null, outcome: null });

// ── A. Operations default screen ─────────────────────────────────────────────
// PLATFORM OPS VISUAL SPEC (2026-10-30) — the R2 Operations lead was REPLACED
// after the owner's rejection (status header + KPI tiles + doorway lists → the
// Personal-Space-language dashboard with the unified Jobs list). Its default
// screen, honest job health, grouping, reachability and fleet gating are pinned
// in components/platform/ops-visual/ops-visual.test.ts; this file keeps the
// Pipeline / Providers / hosting / source-rule checks.

// ── A2. Pipeline lead ────────────────────────────────────────────────────────

console.log("A2. Pipeline — KPI + top failures + drawers, the table inline");
{
  const summary = { window: { from: "2026-10-29", to: "2026-10-30" }, deterministic: false, indeterminacyReason: "open", checkedAt: AGO(1), executions: 12, byStatus: { SUCCEEDED: 10, FAILED: 1, PARTIAL: 1 }, byTrigger: {}, byProfile: {}, openExecutions: 0, withParentJob: 0, meanDurationMs: null, maxDurationMs: null, endpoints: [], tier: "observed" } as never;
  const k = pipelineKpis(ok(summary) as never);
  check("pipeline KPIs are the projection's own counts", k.map((x) => `${x.label}=${x.value}`).join() === "Executions=12,Failed=1,Partial=1,Running=0");
  const empty = pipelineKpis(ok({ ...(summary as object), executions: 0, byStatus: {} }) as never);
  check("an empty window is 'not observed' (—), never Failed 0", empty[1].value === null && empty[1].unavailableReason === "no executions in the window");
  const overview = { ...(overviewData as object), latestFailures: Array.from({ length: 7 }, (_, i) => execRow(i)) } as never;
  const html = renderToStaticMarkup(createElement(PipelineLeadSurface, { summary: ok(summary), daily: loading, overview: ok(overview), hasHosted: () => true, onOpenDrawer: () => {}, onSelectExecution: () => {} } as never));
  const ls = lists(html);
  check("≤ 5 latest failures, 3 detail drawers", (ls.find((l) => l.label === "Latest failed executions")?.items ?? 0) === 5 && (ls.find((l) => l.label === "Pipeline detail")?.items ?? 0) === 3);
}

// ── B. Providers ─────────────────────────────────────────────────────────────
// PLATFORM OPS VISUAL SPEC §5 — the R2 master–detail list was REPLACED by the
// Providers dashboard (hero · sync trend · health donut · tiles · one drawer).
// The honesty pins carry over (only REPORTED providers; no number for an unknown
// cap or cost); the dashboard itself is pinned in
// components/platform/leads/platform-visual-providers-ai.test.ts.

const health = (key: string, label: string, trust: string, over: Record<string, unknown> = {}) => ({
  key, label, kind: key === "PLAID" ? "BANKING" : "FX", trust, availability: 1, lastSuccessAt: AGO(30), lastFailureAt: null, latencyMs: 900,
  quota: null, remainingQuota: null, coverage: null, coverageUnit: null,
  freshness: { state: "fresh", asOf: AGO(30), ageDays: 0, source: "connection-health", detail: "All connections fresh" },
  syncFailures: 0, errorRate: 0, callsToday: 10, calls30d: 300,
  notes: key === "PLAID" ? ["Plaid exposes no pollable quota/billing API — quota is not reportable."] : [], ...over,
});
const aiTrend = { since: "2026-10-01", days: [
  { day: "2026-10-02", calls: 3, promptTokens: 900, completionTokens: 100, estimatedSpendUsd: 1 },
  { day: "2026-10-29", calls: 5, promptTokens: 1000, completionTokens: 200, estimatedSpendUsd: 0.5 },
  { day: "2026-10-30", calls: 2, promptTokens: 400, completionTokens: 50, estimatedSpendUsd: 0.25 },
], totals: { calls: 10, promptTokens: 2300, completionTokens: 350, estimatedSpendUsd: 1.75 }, models: ["gpt"], pricingConfigured: true, tier: "estimated", unpricedTokens: 0, unpricedDays: [], checkedAt: AGO(0) };
const providerInputs = (over: Partial<ProviderInputs> = {}): ProviderInputs => ({
  health: ok({ checkedAt: AGO(1), counts: {}, providers: [health("PLAID", "Plaid", "OPERATIONAL"), health("OPEN_EXCHANGE_RATES", "Open Exchange Rates", "STALE", { syncFailures: 2 })] }),
  apiUsage: ok({ since: AGO(43200), providers: [
    { provider: "PLAID", callsToday: 1204, calls7d: 8000, calls30d: 30000 },
    { provider: "ALCHEMY", callsToday: 500, calls7d: 4000, calls30d: 9000 },
    { provider: "ESPLORA", callsToday: 20, calls7d: 200, calls30d: 900 },
    { provider: "COINGECKO", callsToday: 40, calls7d: 300, calls30d: 1200 },
    { provider: "OPENAI", callsToday: 7, calls7d: 70, calls30d: 400 },
  ], models: [{ metric: "chat:gpt", promptTokens30d: 1, completionTokens30d: 1 }], pricingConfigured: true, estimatedSpendUsd: 4.2, unpricedTokens: 0, unpricedDays: [] }),
  email: ok({ windowDays: 7, counts: { sent: 9, captured: 1, error: 2, skipped: 0, total: 12 }, recentErrors: [{ id: "m1", error: "550 rejected", at: AGO(60) }] }),
  plaid: ok({ priceAuthority: { configured: true, tier: "ESTIMATED", rates: [], note: "" }, cycles: [{ label: "current", agree: true, cycle: { start: "2026-10-01", end: "2026-10-31" }, during: { usd: 12.5, unpricedItemMonths: 0 }, atEnd: { usd: 12.5 } }] }),
  operations: ok({ window: { from: "2026-10-24", to: "2026-10-30" }, deterministic: false, indeterminacyReason: "open", checkedAt: AGO(1), totalCalls: 50, tier: "observed",
    operations: [{ provider: "PLAID", operation: "transactionsSync", calls: 50, succeeded: 49, failed: 1, rateLimited: 1, meanDurationMs: 1, maxDurationMs: 1, attemptDistribution: [], maxAttempt: 1, paginationConfounded: false, attemptSemantics: "" }] }),
  trend: ok(aiTrend),
  nowMs: NOW,
  ...over,
} as never);

console.log("B. Providers — one entity per REPORTED provider, honest cap and cost");
{
  const ents = providerEntities(providerInputs());
  check("providers are exactly those the readers report", ents.map((e) => e.key).sort().join() === "ALCHEMY,COINGECKO,ESPLORA,OPENAI,OPEN_EXCHANGE_RATES,PLAID,RESEND", ents.map((e) => e.key).join());
  check("no provider has a known cap (no reader exposes one)", ents.every((e) => e.cap === CAP_UNKNOWN));
  const byKey = new Map(ents.map((e) => [e.key, e] as const));
  check("status: provider-health words for Plaid / OXR; 'Not assessed' (muted) elsewhere",
    byKey.get("PLAID")!.status.word === "Operational" && byKey.get("OPEN_EXCHANGE_RATES")!.status.word === "Stale data"
      && ["ALCHEMY", "ESPLORA", "COINGECKO", "OPENAI", "RESEND"].every((k) => byKey.get(k)!.status.word === NOT_ASSESSED && byKey.get(k)!.status.tone === "muted"));
  check("spend: ESTIMATED only where a rate card answered (Plaid cycle, OpenAI tokens this cycle), else UNKNOWN",
    byKey.get("PLAID")!.spend.kind === "ESTIMATED" && byKey.get("OPENAI")!.spend.kind === "ESTIMATED"
      && ["ALCHEMY", "ESPLORA", "COINGECKO", "RESEND", "OPEN_EXCHANGE_RATES"].every((k) => byKey.get(k)!.spend.kind === "UNKNOWN"));
  check("failures 7 d: ProviderCall failures / rate limits + delivery errors; else 'not recorded'",
    failuresText(byKey.get("PLAID")!) === "1 failed · 7 d · 1 rate-limited" && failuresText(byKey.get("RESEND")!) === "2 failed · 7 d"
      && failuresText(byKey.get("ALCHEMY")!) === "failures not recorded" && byKey.get("OPEN_EXCHANGE_RATES")!.failedRuns === 2);

  // When a reader fails: the registry pair stays visible and says so; nothing is invented.
  const down = providerEntities(providerInputs({ health: failed("Request failed (500)") as never, apiUsage: failed("Request failed (500)") as never, operations: failed("x") as never }));
  check("provider-health down ⇒ Plaid / OXR listed as 'Unavailable' (muted), not dropped",
    down.filter((e) => ["PLAID", "OPEN_EXCHANGE_RATES"].includes(e.key)).every((e) => e.status.word === "Unavailable" && e.status.tone === "muted"));
  check("api-usage down ⇒ no OpenAI / wallet rows are invented", !down.some((e) => ["OPENAI", "ALCHEMY", "ESPLORA", "COINGECKO"].includes(e.key)));
  check("…and OpenAI spend is UNKNOWN (never $0) when usage is unpriced",
    providerEntities(providerInputs({ trend: ok({ ...aiTrend, pricingConfigured: false }) as never })).find((e) => e.key === "OPENAI")!.spend.kind === "UNKNOWN");

  // The detail (inside the one drawer).
  const detail = (key: string, hasHosted = (_k: string) => true) => renderToStaticMarkup(createElement(ProviderDetail, { e: byKey.get(key)!, hasHosted, renderHosted: (k: string) => createElement("div", { "data-hosted": k }), onOpenWorkspace: () => {}, onOpenFleet: () => {}, nowMs: NOW }));
  const alchemy = text(detail("ALCHEMY"));
  check("detail: cap tile is '—' + 'cap unknown' with an Unknown chip, never a number", /Cap Unknown — cap unknown/.test(alchemy));
  check("detail: unknown spend is '—' + its reason, never $0", /Spend · this cycle Unknown — no rate card for this provider/.test(alchemy) && !/\$0/.test(alchemy));
  check("detail: usage today with the persisted 7 d / 30 d windows (no invented daily series)", /Calls today Measured 500/.test(alchemy) && /7 d 4,000 · 30 d 9,000/.test(alchemy));
  check("detail: wallet providers reach connection diagnostics", /All connections/.test(alchemy) && /Connection diagnostics/.test(alchemy));
  const plaidDetail = detail("PLAID");
  check("detail: technical diagnostics are lazily-mounted disclosures (nothing hosted renders until opened)", /aria-expanded="false"/.test(plaidDetail) && !/data-hosted=/.test(plaidDetail) && /Provider health \(all providers\)/.test(plaidDetail));
  check("detail: Resend shows deliveries + recent errors (email delivery hosted)", /Deliveries · 7 d/.test(text(detail("RESEND"))) && /550 rejected/.test(detail("RESEND")) && /Email delivery/.test(detail("RESEND")));
}

// ── C. Connection diagnostics hosted unchanged ───────────────────────────────

console.log("C. Connection diagnostics + provider cleanup — hosted, never re-gated, mounted once");
{
  const ents = providerEntities(providerInputs());
  const hosted: string[] = [];
  const html = renderToStaticMarkup(createElement(ProvidersDrawerBody, {
    drawer: { kind: "fleet", id: "diag:connections" }, entities: ents, nowMs: NOW, onOpenDrawer: () => {},
    hasHosted: () => true, renderHosted: (k: string) => { hosted.push(k); return createElement("div", { "data-hosted": k }); }, onOpenWorkspace: () => {},
  }));
  check("the Connections drawer renders BOTH hosted widgets through renderHosted, each exactly once",
    hosted.join() === "ops_connection_diagnostics,ops_provider_cleanup" && /data-hosted="ops_connection_diagnostics"/.test(html), hosted.join());
  // R2 review fix, kept — a hosted widget must never mount twice (duplicate
  // fetches / dialogs / ids). The dashboard has ONE drawer whose body exists only
  // while it is open, and nothing hosted renders on the default screen.
  const onDefault: string[] = [];
  renderToStaticMarkup(createElement(ProvidersLeadSurface, {
    inputs: providerInputs(), daily: loading, drawer: null, onOpenDrawer: () => {}, onCloseDrawer: () => {},
    hasHosted: () => true, renderHosted: (k: string) => { onDefault.push(k); return createElement("div", { "data-hosted": k }); }, onOpenWorkspace: () => {},
  } as never));
  check("the default screen mounts no hosted widget", onDefault.length === 0, onDefault.join());
  const lead = code("components/platform/leads/ProvidersLead.tsx");
  check("…exactly ONE DetailDrawer, opened only with a body; no second (desktop) detail pane",
    (lead.match(/<DetailDrawer\b/g) ?? []).length === 1 && /open=\{p\.drawer !== null && body !== null\}/.test(lead) && !/desktopDetail|lg:col-span-7">\s*\{current/.test(lead));
  check("FLEET_DIAGNOSTICS names the connection widget + cleanup together", FLEET_DIAGNOSTICS[0].keys.join() === "ops_connection_diagnostics,ops_provider_cleanup");
  for (const f of ["ProvidersLead.tsx", "providers-model.ts", "OperationsLead.tsx", "PipelineLead.tsx", "AiCostsLead.tsx", "ai-costs-model.ts"]) {
    const src = code(`components/platform/leads/${f}`);
    check(`${f}: imports neither the diagnostics widget nor the recovery panel (hosted, never re-wrapped)`, !/OpsConnectionDiagnosticsWidget|WalletHistoryRecoveryPanel|OpsProviderCleanupWidget|OpsManualOperationsWidget/.test(src));
  }
  const dash = code("components/platform/PlatformSpaceDashboard.tsx");
  check("the dashboard renders a hosted key through the SAME registry widget with the operator's access",
    // VISUAL SPEC §5 (Policies) — re-ruled: a lead may pass the variant an inline
    // view entry would (the Policies drawers); the bare form is unchanged.
    /const renderHosted: RenderHosted = \(key, onOpenWorkspace, variant\) => \{[\s\S]{0,600}<Widget section=\{row\} onOpenWorkspace=\{onOpenWorkspace \?\? onOpen\} access=\{access\} variant=\{variant\} \/>[\s\S]{0,40}<Widget section=\{row\} onOpenWorkspace=\{onOpenWorkspace \?\? onOpen\} access=\{access\} \/>/.test(dash));
  // PLATFORM OPS VISUAL SPEC §3 — ops_manual_operations is absorbed by the unified
  // Jobs section (ops_job_health → OpsJobsWidget); its widget is no longer registered.
  check("…the registry still maps the diagnostics + cleanup keys to their own widgets, and jobs to the unified Jobs widget",
    /ops_connection_diagnostics: OpsConnectionDiagnosticsWidget/.test(dash) && /ops_provider_cleanup:\s+OpsProviderCleanupWidget/.test(dash)
      && /ops_job_health:\s+OpsJobsWidget/.test(dash) && !/ops_manual_operations:/.test(dash));
  check("…and a hosted key needs an enabled DB row and a widget (fails safe)", /hosted\.includes\(key\) && dbByKey\.has\(key\) && PLATFORM_WIDGET_REGISTRY\[key\] != null/.test(dash));
}

// ── D. Composition: leads, hosting, reachability ─────────────────────────────

console.log("D. Dashboard + composition");
{
  const ops = PLATFORM_AREA_WORKSPACES.PLATFORM_OPS;
  const leadFiles: Record<string, string> = {
    operations: code("components/platform/leads/OperationsLead.tsx"),
    pipeline: code("components/platform/leads/PipelineLead.tsx"),
    providers: code("components/platform/leads/ProvidersLead.tsx") + code("components/platform/leads/providers-model.ts"),
    // VISUAL SPEC §5 — the AI & Costs dashboard hosts the former AI / Costs views' widgets.
    "ai-costs": code("components/platform/leads/AiCostsLead.tsx"),
    // VISUAL SPEC §5 — the Policies dashboard hosts ops_policies + ops_alerts in drawers.
    policies: code("components/platform/leads/PoliciesLead.tsx"),
  };
  for (const w of ops) for (const v of w.views ?? []) {
    if (!v.lead) continue;
    for (const k of v.hosted ?? []) {
      check(`${w.workspaceId}:${v.id} — hosted "${k}" is opened by its ${v.lead} lead`, leadFiles[v.lead].includes(`"${k}"`));
    }
  }
  // Every key the Phase 1 composition rendered is still reachable from some view.
  const BEFORE = ["ops_overview", "ops_platform_health", "ops_convergence", "ops_timeline", "ops_scheduler", "ops_job_health", "ops_manual_operations", "ops_history",
    "ops_refresh_executions", "ops_refresh_summary", "ops_connection_health", "ops_refresh_coverage", "ops_provider_health", "ops_provider_operations", "ops_resource_freshness",
    "ops_connection_diagnostics", "ops_provider_cleanup", "ops_api_usage", "ops_email_delivery",
    // VISUAL SPEC §5 — and every AI & Costs key (now hosted in its dashboard's drawers).
    "ops_ai_invocations", "ops_ai_trend", "ops_ai_budget", "ops_brief_ops", "ops_plaid_usage", "ops_cost"];
  const reachable = new Set(ops.flatMap((w) => (w.views ?? []).flatMap((v) => [...viewComposedKeys(v)])));
  // …or absorbed by a reachable key (ops_manual_operations → ops_job_health, spec §3).
  const ok2 = (k: string) => reachable.has(k) || (PLATFORM_SECTION_REPRESENTATION[k] !== undefined && reachable.has(PLATFORM_SECTION_REPRESENTATION[k]));
  check("every Operations / Providers / AI & Costs key composed before is still reachable", BEFORE.every(ok2), BEFORE.filter((k) => !ok2(k)).join());

  const row = (key: string) => ({ id: `row-${key}`, key, label: `DB::${key}` });
  const overview = ops[0].views![0];
  const dbByKey = new Map([...(overview.hosted ?? [])].map((k) => [k, row(k)] as const));
  const body = renderToStaticMarkup(createElement(PlatformWorkspaceBody, { sectionKeys: overview.sections, dbByKey, onOpen: () => {}, lead: overview.lead, hosted: overview.hosted }));
  check("a lead view renders its lead and NO inline section anchor for hosted keys", !/id="platform-section-/.test(body) && /data-ops-dashboard/.test(body));
  check("…and no 'No sections enabled' message on a lead view", !/No sections enabled/.test(body));
}

// ── E. Source rules ──────────────────────────────────────────────────────────

console.log("E. Source rules (leads)");
for (const f of ["OperationsLead.tsx", "PipelineLead.tsx", "ProvidersLead.tsx", "AiCostsLead.tsx", "PoliciesLead.tsx", "visual-kit.tsx", "lead-kit.tsx", "operations-model.ts", "providers-model.ts", "ai-costs-model.ts", "policies-model.ts", "lead-contract.ts"]) {
  const src = code(`components/platform/leads/${f}`);
  check(`${f}: no access-level literal / control flag (capability ratchet)`, !/\bCONTROL\b/.test(src) && !/canControl/.test(src));
  check(`${f}: no viewport read (responsive by classes)`, !/matchMedia|innerWidth/.test(src));
  check(`${f}: no raw fetch (reads through the shared workspace session)`, !/\bfetch\(/.test(src));
}

if (failures > 0) {
  console.error(`\nops2-r2: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nops2-r2: all checks passed.");
