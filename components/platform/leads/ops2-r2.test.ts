/**
 * components/platform/leads/ops2-r2.test.ts  (Platform Operations 2.0 — R2, plan §4.2–§4.3)
 *
 * The Operations and Providers redesign, pinned:
 *   A. the Operations default screen shows ≤ 5 items per section, never renders
 *      a fleet control, and opens every former widget only from a drawer;
 *   B. the Providers master lists only providers a reader REPORTS, ≤ 5 per
 *      section, and never prints a number for an unknown allowance or cost;
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
import { OperationsLead, OperationsLeadSurface } from "./OperationsLead";
import { ProviderDetail, ProvidersLeadSurface, ProvidersMaster } from "./ProvidersLead";
import { PipelineLeadSurface, pipelineKpis } from "./PipelineLead";
import { ALLOWANCE_UNKNOWN, FLEET_DIAGNOSTICS, NOT_ASSESSED, groupEntities, providerEntities, type ProviderInputs } from "./providers-model";
import { PLATFORM_AREA_WORKSPACES, viewComposedKeys } from "@/lib/platform/workspaces";
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

const attentionItem = (i: number, sev: string) => ({
  id: `a${i}`, severity: sev, entity: { kind: "connection", label: `Connection ${i}` }, problem: `Problem ${i}`, since: AGO(30 + i),
  evidence: { kind: "connection", workspace: "platform-providers" }, actions: [{ kind: "resync", connectionId: `c${i}`, source: "PLAID" }], basis: "b",
});
const attentionData = {
  checkedAt: AGO(1), items: Array.from({ length: 8 }, (_, i) => attentionItem(i, i < 2 ? "critical" : "warning")),
  counts: { critical: 2, error: 0, warning: 6, info: 0 }, authoritiesChecked: { count: 7, names: [] }, authoritiesFailed: [], floors: [],
  recentFirings: { runs: 0, newestEvaluatedAt: null, oldestEvaluatedAt: null, count: 0, items: [] }, userImpact: {},
} as never;
const convergenceData = { window: { from: AGO(1440), to: AGO(0) }, episodes: [
  { id: "e1", from: AGO(100), to: AGO(90), title: "t", subjects: [], participants: [], events: [], narrative: { happened: "h", caused: null, recovered: null }, trust: "observed" },
  { id: "e2", from: AGO(100), to: AGO(90), title: "t", subjects: [], participants: [], events: [], narrative: { happened: "h", caused: null, recovered: "r" }, trust: "observed" },
], events: [], eventCount: 14, participants: [], checkedAt: AGO(1) } as never;
const jobsData = { healthy: false, checkedAt: AGO(1), counts: { healthy: 8, running: 1, overdue: 1, failing: 1, dead: 0, neverRan: 2 }, jobs: [] } as never;
const schedulerData = { observed: { lastRecordedExecutionAt: AGO(3), recordedExecutions: 37, overdue: [], externalCrons: [] }, expected: { nextSlotAt: null, jobsInNextSlot: [], registeredJobs: 13 }, notes: [], window: { from: AGO(1440), to: AGO(0) }, checkedAt: AGO(1) } as never;
const execRow = (i: number) => ({ id: `x${i}`, runId: `r${i}`, plaidItemId: `item_${i}abcdef`, sourceKind: "PLAID_ITEM", sourceRef: null, network: null, trigger: "CRON", profile: "p", startedAt: AGO(i * 7), completedAt: AGO(i * 7 - 1), durationMs: 4200, overallStatus: i === 2 ? "FAILED" : "SUCCEEDED", parentJobRunId: null, hasError: i === 2, deploymentSha: null, errorSummary: null, admissionReason: null, failureStage: null, failureCategory: null, outcome: null });
const execData = { rows: Array.from({ length: 8 }, (_, i) => execRow(i + 1)), nextCursor: "c", audience: "operator", scopeDenied: false } as never;

const ALL_OPS_HOSTED = new Set(["ops_overview", "ops_platform_health", "ops_convergence", "ops_timeline", "ops_manual_operations"]);
const opsSurface = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(OperationsLeadSurface, {
  overview: ok(overviewData), attention: ok(attentionData), convergence: ok(convergenceData), jobs: ok(jobsData), scheduler: ok(schedulerData), executions: ok(execData),
  nowMs: NOW, hasHosted: (k: string) => ALL_OPS_HOSTED.has(k), onOpenDrawer: () => {}, onOpenWorkspace: () => {}, onSelectExecution: () => {}, ...over,
} as never));

// ── A. Operations default screen ─────────────────────────────────────────────

console.log("A. Operations — summary-first default screen");
{
  const html = opsSurface();
  const t = text(html);
  const ls = lists(html);
  check("every list on the default screen shows ≤ 5 items", ls.length === 3 && ls.every((l) => l.items <= 5), JSON.stringify(ls));
  const attention = (html.match(/<li[^>]*>(?:(?!<\/li>)[\s\S])*?aria-haspopup="dialog" class="group flex min-h-11/g) ?? []).length;
  check("attention: the top 5 of 8, each opening the full list in a drawer", attention === 5, String(attention));
  check("attention: 'View all (8)' opens the full list (with its resync / reauth actions) in place", /View all \(8\)/.test(t));
  check("attention rows name the item's own next action", /Resync/.test(t) && /Problem 0/.test(t) && !/Problem 5/.test(t));
  check("status header: the overview's verdict word + its sentence + checked time", /Degraded/.test(t) && /Something is degraded/.test(t) && /Checked 11:58 UTC/.test(t));
  check("status facts: attention total, open incidents (unrecovered episodes), jobs, pipeline", /Needs attention 8/.test(t) && /Open incidents 1/.test(t) && /Scheduled jobs 11 healthy/.test(t) && /Refresh pipeline 0 of 12 failed/.test(t));
  check("jobs KPIs come from the scheduler + job-health counts only (each a MEASURED figure)", /Runs · 24 h Measured 37/.test(t) && /Failing Measured 1/.test(t) && /Overdue Measured 1/.test(t) && /Running Measured 1/.test(t));
  check("five recent executions (of 8 returned), rows 4–5 hidden below sm", (ls.find((l) => l.label === "Recent executions")?.items ?? 0) === 5 && (html.match(/<li><div class="max-sm:hidden">/g) ?? []).length === 2);
  check("detail doorways: Domains & sources · Incidents · Platform health · Pipeline · Activity & usage", ["Domains &amp; sources", "Incidents", "Platform health", "Pipeline", "Activity &amp; usage"].every((w) => html.includes(w)) && (ls.find((l) => l.label === "Operations detail")?.items ?? 0) === 5);

  // Fleet / destructive controls are never on the default screen.
  check("no fleet or run control on the default screen (only the deliberate opener)", !/Run now|Dry run|Run fleet|Yes, run/i.test(t) && /Run an operation…/.test(t));
  check("the manual-operations entry is a dialog opener, never a commit button", /<button type="button" aria-haspopup="dialog"[^>]*>Run an operation…<\/button>/.test(html));
  check("without the hosted Manual operations row, the entry is not offered at all", !/Run an operation/.test(text(opsSurface({ hasHosted: (k: string) => k !== "ops_manual_operations" }))));
  check("without ops_overview hosted, the board / activity doorways and 'View all' disappear (gated by the row)",
    (() => { const h = text(opsSurface({ hasHosted: (k: string) => k !== "ops_overview" })); return !/Domains &amp; sources|Domains & sources/.test(h) && !/Activity & usage/.test(h) && !/View all/.test(h); })());

  // Unknown is never healthy, never zero.
  const down = text(opsSurface({ overview: failed("Request failed (500)"), jobs: failed("Request failed (500)"), scheduler: loading }));
  check("an unread overview is 'Unknown' with the reason — never Healthy", /Unknown/.test(down) && /Health cannot be established/.test(down) && !/Healthy/.test(down));
  check("unread job KPIs render '—' + reason, never 0", /Failing — job health unavailable/.test(down) && !/Failing (Measured )?0/.test(down));

  // The container renders nothing hosted until a drawer opens.
  const calls: string[] = [];
  renderToStaticMarkup(createElement(OperationsLead, { renderHosted: (k: string) => { calls.push(k); return null; }, hasHosted: () => true, onOpenWorkspace: () => {} } as never));
  check("the lead mounts NO hosted widget on the default screen (drawers closed)", calls.length === 0, calls.join());
}

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

const health = (key: string, label: string, trust: string, over: Record<string, unknown> = {}) => ({
  key, label, kind: key === "PLAID" ? "BANKING" : "FX", trust, availability: 1, lastSuccessAt: AGO(30), lastFailureAt: null, latencyMs: 900,
  quota: null, remainingQuota: null, coverage: null, coverageUnit: null,
  freshness: { state: "fresh", asOf: AGO(30), ageDays: 0, source: "connection-health", detail: "All connections fresh" },
  syncFailures: 0, errorRate: 0, callsToday: 10, calls30d: 300,
  notes: key === "PLAID" ? ["Plaid exposes no pollable quota/billing API — quota is not reportable."] : [], ...over,
});
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
  operations: ok({ window: { from: AGO(1440), to: AGO(0) }, deterministic: true, indeterminacyReason: null, checkedAt: AGO(1), totalCalls: 50, tier: "observed",
    operations: [{ provider: "PLAID", operation: "transactionsSync", calls: 50, succeeded: 47, failed: 3, rateLimited: 1, meanDurationMs: 1, maxDurationMs: 1, attemptDistribution: [], maxAttempt: 1, paginationConfounded: false, attemptSemantics: "" }] }),
  ...over,
} as never);

console.log("B. Providers — one row per REPORTED provider, honest allowance and cost");
{
  const ents = providerEntities(providerInputs());
  check("providers are exactly those the readers report", ents.map((e) => e.key).sort().join() === "ALCHEMY,COINGECKO,ESPLORA,OPENAI,OPEN_EXCHANGE_RATES,PLAID,RESEND", ents.map((e) => e.key).join());
  check("grouped into sections of ≤ 5", groupEntities(ents).every((g) => g.items.length <= 5) && groupEntities(ents).map((g) => g.label).join() === "Banking & market data,Wallet networks,Platform services");
  check("no provider has a known allowance (no reader exposes one)", ents.every((e) => e.allowance.known === false));
  const byKey = new Map(ents.map((e) => [e.key, e] as const));
  check("status: provider-health words for Plaid / OXR; 'Not assessed' (muted) elsewhere",
    byKey.get("PLAID")!.status.word === "Operational" && byKey.get("OPEN_EXCHANGE_RATES")!.status.word === "Stale data"
      && ["ALCHEMY", "ESPLORA", "COINGECKO", "OPENAI", "RESEND"].every((k) => byKey.get(k)!.status.word === NOT_ASSESSED && byKey.get(k)!.status.tone === "muted"));
  check("spend: ESTIMATED only where a rate card answered (Plaid cycle, OpenAI tokens), else UNKNOWN",
    byKey.get("PLAID")!.spend.kind === "ESTIMATED" && byKey.get("OPENAI")!.spend.kind === "ESTIMATED"
      && ["ALCHEMY", "ESPLORA", "COINGECKO", "RESEND", "OPEN_EXCHANGE_RATES"].every((k) => byKey.get(k)!.spend.kind === "UNKNOWN"));
  check("errors: provider-health failed runs + ProviderCall failures / rate limits + delivery errors",
    byKey.get("PLAID")!.errors.text === "3 failed calls · 1 rate-limited" && byKey.get("OPEN_EXCHANGE_RATES")!.errors.text === "2 failed runs"
      && byKey.get("RESEND")!.errors.text === "2 delivery errors" && byKey.get("ALCHEMY")!.errors.text === "errors not recorded");

  const master = renderToStaticMarkup(createElement(ProvidersMaster, { entities: ents, selected: "PLAID", onSelect: () => {}, hasHosted: () => true, loading: false }));
  check("every master list shows ≤ 5 rows", lists(master).every((l) => l.items <= 5), JSON.stringify(lists(master)));
  // Each row is one <button>: split the master into rows and inspect each.
  const rows = master.split(/<button type="button"/).slice(1);
  const rowFor = (label: string) => rows.find((r) => r.includes(`>${label}<`)) ?? "";
  for (const label of ["Alchemy", "Esplora (Blockstream)", "CoinGecko", "Resend", "Open Exchange Rates"]) {
    const r = rowFor(label);
    check(`${label}: row prints 'allowance unknown' and no number/currency for allowance or cost`, r.includes(ALLOWANCE_UNKNOWN) && !/\$/.test(r) && />Unknown</.test(r));
  }
  check("Plaid row: spend is an estimate labelled as such; allowance still unknown", /Spend · est\./.test(rowFor("Plaid")) && /\$12\.50/.test(rowFor("Plaid")) && rowFor("Plaid").includes(ALLOWANCE_UNKNOWN));
  check("fleet diagnostics: Connections · Resource freshness · Usage ledger", /Connections/.test(master) && /Resource freshness/.test(master) && /Usage ledger/.test(master));

  // When a reader fails: the registry pair stays visible and says so; nothing is invented.
  const down = providerEntities(providerInputs({ health: failed("Request failed (500)") as never, apiUsage: failed("Request failed (500)") as never, operations: failed("x") as never }));
  check("provider-health down ⇒ Plaid / OXR listed as 'Unavailable' (muted), not dropped",
    down.filter((e) => ["PLAID", "OPEN_EXCHANGE_RATES"].includes(e.key)).every((e) => e.status.word === "Unavailable" && e.status.tone === "muted"));
  check("api-usage down ⇒ no OpenAI / wallet rows are invented", !down.some((e) => ["OPENAI", "ALCHEMY", "ESPLORA", "COINGECKO"].includes(e.key)));
  check("…and OpenAI spend is UNKNOWN (never $0) when usage is unread", providerEntities(providerInputs({ apiUsage: { data: { ...(providerInputs().apiUsage.data as object), estimatedSpendUsd: null } , loading: false, error: null } as never })).find((e) => e.key === "OPENAI")!.spend.kind === "UNKNOWN");

  // The detail.
  const detail = (key: string, hasHosted = (_k: string) => true) => renderToStaticMarkup(createElement(ProviderDetail, { e: byKey.get(key)!, hasHosted, renderHosted: (k: string) => createElement("div", { "data-hosted": k }), onSelect: () => {}, onOpenWorkspace: () => {} }));
  const alchemy = text(detail("ALCHEMY"));
  check("detail: allowance tile is '—' + 'allowance unknown' with an Unknown chip, never a number", /Allowance Unknown — allowance unknown/.test(alchemy));
  check("detail: unknown spend is '—' + its reason, never $0", /Spend Unknown — no rate card for this provider/.test(alchemy) && !/\$0/.test(alchemy));
  check("detail: usage today with the persisted 7 d / 30 d windows (no invented daily series)", /Calls today Measured 500/.test(alchemy) && /7 d 4,000 · 30 d 9,000/.test(alchemy));
  check("detail: wallet providers link to connection diagnostics", /Connection diagnostics/.test(alchemy));
  const plaidDetail = detail("PLAID");
  check("detail: technical diagnostics are lazily-mounted disclosures (nothing hosted renders until opened)", /aria-expanded="false"/.test(plaidDetail) && !/data-hosted=/.test(plaidDetail) && /Provider health \(all providers\)/.test(plaidDetail));
  check("detail: Resend shows deliveries + recent errors (email delivery hosted)", /Deliveries · 7 d/.test(text(detail("RESEND"))) && /550 rejected/.test(detail("RESEND")) && /Email delivery/.test(detail("RESEND")));
}

// ── C. Connection diagnostics hosted unchanged ───────────────────────────────

console.log("C. Connection diagnostics + provider cleanup — hosted, never re-gated");
{
  const hosted: string[] = [];
  const html = renderToStaticMarkup(createElement(ProvidersLeadSurface, {
    inputs: providerInputs(), selected: "diag:connections", sheetOpen: false, onSelect: () => {}, onCloseSheet: () => {},
    hasHosted: () => true, renderHosted: (k: string) => { hosted.push(k); return createElement("div", { "data-hosted": k }); }, onOpenWorkspace: () => {},
  }));
  check("the Connections detail renders BOTH hosted widgets through renderHosted", hosted.join() === "ops_connection_diagnostics,ops_provider_cleanup" && /data-hosted="ops_connection_diagnostics"/.test(html));
  // R2 review fix — a MOBILE selection open in the sheet must not ALSO mount in
  // the CSS-hidden desktop pane (double fetches, duplicate dialogs/ids).
  const mobileHosted: string[] = [];
  renderToStaticMarkup(createElement(ProvidersLeadSurface, {
    inputs: providerInputs(), selected: "diag:connections", sheetOpen: true, desktopDetail: false, onSelect: () => {}, onCloseSheet: () => {},
    hasHosted: () => true, renderHosted: (k: string) => { mobileHosted.push(k); return createElement("div", { "data-hosted": k }); }, onOpenWorkspace: () => {},
  }));
  check("with a mobile selection open, the hidden desktop pane mounts nothing (no double mount)",
    !mobileHosted.includes("ops_connection_diagnostics") || mobileHosted.filter((k) => k === "ops_connection_diagnostics").length <= 1);
  const lead = code("components/platform/leads/ProvidersLead.tsx");
  check("…desktop pane is gated on desktopDetail, and a mobile selection is released when its sheet closes",
    /\{current && desktopDetail && \(/.test(lead) && /desktopDetail=\{!sheetOpen && origin !== "mobile"\}/.test(lead)
      && /if \(origin === "mobile"\) \{ setSelected\(null\); setOrigin\(null\); \}/.test(lead));
  check("FLEET_DIAGNOSTICS names the connection widget + cleanup together", FLEET_DIAGNOSTICS[0].keys.join() === "ops_connection_diagnostics,ops_provider_cleanup");
  for (const f of ["ProvidersLead.tsx", "providers-model.ts", "OperationsLead.tsx", "PipelineLead.tsx"]) {
    const src = code(`components/platform/leads/${f}`);
    check(`${f}: imports neither the diagnostics widget nor the recovery panel (hosted, never re-wrapped)`, !/OpsConnectionDiagnosticsWidget|WalletHistoryRecoveryPanel|OpsProviderCleanupWidget|OpsManualOperationsWidget/.test(src));
  }
  const dash = code("components/platform/PlatformSpaceDashboard.tsx");
  check("the dashboard renders a hosted key through the SAME registry widget with the operator's access",
    /const renderHosted: RenderHosted = \(key, onOpenWorkspace\) => \{[\s\S]{0,260}<Widget section=\{row\} onOpenWorkspace=\{onOpenWorkspace \?\? onOpen\} access=\{access\} \/>/.test(dash));
  check("…the registry still maps the diagnostics + cleanup + manual-operations keys to their own widgets",
    /ops_connection_diagnostics: OpsConnectionDiagnosticsWidget/.test(dash) && /ops_provider_cleanup:\s+OpsProviderCleanupWidget/.test(dash) && /ops_manual_operations:\s+OpsManualOperationsWidget/.test(dash));
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
    "ops_connection_diagnostics", "ops_provider_cleanup", "ops_api_usage", "ops_email_delivery"];
  const reachable = new Set(ops.flatMap((w) => (w.views ?? []).flatMap((v) => [...viewComposedKeys(v)])));
  check("every Operations / Providers key composed before R2 is still reachable", BEFORE.every((k) => reachable.has(k)), BEFORE.filter((k) => !reachable.has(k)).join());

  const row = (key: string) => ({ id: `row-${key}`, key, label: `DB::${key}` });
  const overview = ops[0].views![0];
  const dbByKey = new Map([...(overview.hosted ?? [])].map((k) => [k, row(k)] as const));
  const body = renderToStaticMarkup(createElement(PlatformWorkspaceBody, { sectionKeys: overview.sections, dbByKey, onOpen: () => {}, lead: overview.lead, hosted: overview.hosted }));
  check("a lead view renders its lead and NO inline section anchor for hosted keys", !/id="platform-section-/.test(body) && /Jobs &amp; activity/.test(body));
  check("…and no 'No sections enabled' message on a lead view", !/No sections enabled/.test(body));
}

// ── E. Source rules ──────────────────────────────────────────────────────────

console.log("E. Source rules (leads)");
for (const f of ["OperationsLead.tsx", "PipelineLead.tsx", "ProvidersLead.tsx", "lead-kit.tsx", "operations-model.ts", "providers-model.ts", "lead-contract.ts"]) {
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
