/**
 * components/platform/leads/platform-visual-providers-ai.test.ts  (Platform Ops visual spec §5)
 *
 * The Providers and AI & Costs dashboards, pinned:
 *   1. Providers model — health classes (provider-health verdict; provider-ops
 *      may only DOWNGRADE), the hero verdict, the donut sums to the providers,
 *      KPIs, and no number for an unknown cap or cost;
 *   2. AI & Costs model — ESTIMATED vs UNKNOWN (billed is always Unknown),
 *      calendar-exact windows with gaps (real points only), the cycle spend,
 *      cost per call, the surface donut sums, the budget meter;
 *   3. render — ≤ 5 items per default section, no paragraphs on the default
 *      screens, the Economics slot carries no numbers, nothing hosted mounts on
 *      the default screen, every hosted widget is reachable from a drawer;
 *   4. source rules — no access-level literal, no viewport read, no raw fetch,
 *      Personal components imported (not forked).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/platform-visual-providers-ai.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PLATFORM_AREA_WORKSPACES } from "@/lib/platform/workspaces";
import {
  CAP_UNKNOWN,
  FLEET_DIAGNOSTICS,
  callsDegrade,
  cycleSpendTotal,
  healthDistribution,
  integrationVerdict,
  providerEntities,
  providerKpis,
  usageText,
  type ProviderInputs,
} from "./providers-model";
import {
  BILLED_UNKNOWN,
  aiKpis,
  aiSpend30d,
  budgetMeter,
  calendarDays,
  costByProvider,
  costPerCall,
  currentCycle,
  invocationDays,
  openAiCycleSpend,
  spendBySurface,
  spendSeries,
  sumMoney,
  tokenDays,
  topCustomers,
} from "./ai-costs-model";
import { ProvidersDrawerBody, ProvidersLeadSurface, TILE_ROWS } from "./ProvidersLead";
import { AI_DRAWERS, AiCostsDrawerBody, AiCostsLeadSurface, CUSTOMER_ROWS } from "./AiCostsLead";

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
function lists(html: string): { label: string; items: number }[] {
  const out: { label: string; items: number }[] = [];
  for (const m of html.matchAll(/<ul aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/ul>/g)) out.push({ label: m[1], items: (m[2].match(/<li[ >]/g) ?? []).length });
  return out;
}
const paragraphs = (html: string) => (html.match(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g) ?? []).map(text);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const health = (key: string, label: string, trust: string, over: Record<string, unknown> = {}) => ({
  key, label, kind: key === "PLAID" ? "BANKING" : "FX", trust, availability: 1, lastSuccessAt: AGO(30), lastFailureAt: null, latencyMs: 900,
  quota: null, remainingQuota: null, coverage: null, coverageUnit: null,
  freshness: { state: "fresh", asOf: AGO(30), ageDays: 0, source: "connection-health", detail: "All connections fresh" },
  syncFailures: 0, errorRate: 0, callsToday: 10, calls30d: 300, notes: [], ...over,
});
const day = (d: string, prompt: number, completion: number, spend: number | null) => ({ day: d, calls: 1, promptTokens: prompt, completionTokens: completion, estimatedSpendUsd: spend });
const trendData = (over: Record<string, unknown> = {}) => ({
  since: "2026-10-01",
  days: [day("2026-10-02", 900, 100, 1), day("2026-10-26", 0, 0, null), day("2026-10-27", 500, 50, null), day("2026-10-29", 1000, 200, 0.5), day("2026-10-30", 400, 50, 0.25)],
  totals: { calls: 5, promptTokens: 2800, completionTokens: 400, estimatedSpendUsd: 1.75 }, models: ["gpt"], pricingConfigured: true, tier: "estimated",
  unpricedTokens: 550, unpricedDays: ["2026-10-27"], checkedAt: AGO(0), ...over,
});
const opsRow = (provider: string, calls: number, failedN: number, rateLimited = 0) => ({ provider, operation: "op", calls, succeeded: calls - failedN, failed: failedN, rateLimited, meanDurationMs: 1, maxDurationMs: 1, attemptDistribution: [], maxAttempt: 1, paginationConfounded: false, attemptSemantics: "" });
const inputs = (over: Partial<ProviderInputs> = {}): ProviderInputs => ({
  health: ok({ checkedAt: AGO(1), counts: {}, providers: [health("PLAID", "Plaid", "OPERATIONAL"), health("OPEN_EXCHANGE_RATES", "Open Exchange Rates", "OPERATIONAL")] }),
  apiUsage: ok({ since: AGO(43200), providers: [
    { provider: "PLAID", callsToday: 1204, calls7d: 8000, calls30d: 30000 },
    { provider: "ALCHEMY", callsToday: 500, calls7d: 4000, calls30d: 9000 },
    { provider: "ESPLORA", callsToday: 20, calls7d: 200, calls30d: 900 },
    { provider: "COINGECKO", callsToday: 40, calls7d: 300, calls30d: 1200 },
    { provider: "OPENAI", callsToday: 7, calls7d: 70, calls30d: 400 },
  ], models: [{ metric: "chat:gpt", promptTokens30d: 1, completionTokens30d: 1 }], pricingConfigured: true, estimatedSpendUsd: 4.2, unpricedTokens: 0, unpricedDays: [] }),
  email: ok({ windowDays: 7, counts: { sent: 9, captured: 1, error: 0, skipped: 0, total: 10 }, recentErrors: [] }),
  plaid: ok({ priceAuthority: { configured: true, tier: "ESTIMATED", rates: [], note: "" }, cycles: [{ label: "current", agree: true, cycle: { start: "2026-10-01", end: "2026-10-31" }, during: { usd: 12.5, unpricedItemMonths: 0 }, atEnd: { usd: 12.5 } }] }),
  operations: ok({ window: { from: "2026-10-24", to: "2026-10-30" }, deterministic: false, indeterminacyReason: "open", checkedAt: AGO(1), totalCalls: 100, tier: "observed",
    operations: [opsRow("PLAID", 80, 2, 1), opsRow("ALCHEMY", 20, 0)] }),
  trend: ok(trendData()),
  nowMs: NOW,
  ...over,
} as never);
const daily = ok({ envelope: { window: { from: "2026-10-17", to: "2026-10-30" }, deterministic: false, indeterminacyReason: null, checkedAt: AGO(1) },
  days: [{ day: "2026-10-29", total: 10, byStatus: { SUCCEEDED: 9, FAILED: 1, PARTIAL: 0, SKIPPED: 0, RUNNING: 0 }, bySourceKind: { PLAID_ITEM: 8, WALLET: 2 }, admissionDenied: 0, settled: true }],
  windowDays: 14, maxWindowDays: 30, executions: 10, floor: false, notes: [], tier: "observed" });

// ── 1. Providers model ───────────────────────────────────────────────────────

console.log("1. Providers — health classes, verdict, distribution, KPIs, honest cap / cost");
{
  const ents = providerEntities(inputs());
  const by = new Map(ents.map((e) => [e.key, e] as const));
  check("provider-health verdict → class (OPERATIONAL = healthy); no health authority = not assessed",
    by.get("PLAID")!.healthClass === "healthy" && by.get("OPEN_EXCHANGE_RATES")!.healthClass === "healthy"
      && ["ALCHEMY", "ESPLORA", "COINGECKO", "OPENAI", "RESEND"].every((k) => by.get(k)!.healthClass === "not-assessed"));
  check("call counts alone never make a provider 'healthy' (Alchemy: 20 clean calls, still not assessed)", by.get("ALCHEMY")!.status.word === "Not assessed");
  check("downgrade rule: ≥ 5 % of ≥ 20 calls failed; 1 of 19 or 2 of 80 does not",
    callsDegrade(20, 1) && callsDegrade(100, 5) && !callsDegrade(19, 1) && !callsDegrade(80, 2) && !callsDegrade(0, 0));
  const degradedByCalls = providerEntities(inputs({ operations: ok({ ...(inputs().operations.data as object), operations: [opsRow("PLAID", 40, 4)] }) as never }));
  const plaid = degradedByCalls.find((e) => e.key === "PLAID")!;
  check("provider-ops DOWNGRADES a healthy verdict (10 % of 40 calls failed ⇒ Degraded, with the basis)",
    plaid.healthClass === "degraded" && plaid.status.word === "Degraded" && /10% of 40 provider calls failed in 7 d/.test(plaid.statusBasis), plaid.statusBasis);
  const failing = providerEntities(inputs({ health: ok({ checkedAt: AGO(1), counts: {}, providers: [health("PLAID", "Plaid", "FAILING"), health("OPEN_EXCHANGE_RATES", "Open Exchange Rates", "STALE")] }) as never }));
  check("worst first: failing, then degraded, then healthy, then not assessed", failing[0].key === "PLAID" && failing[1].key === "OPEN_EXCHANGE_RATES");
  check("verdict: Failing > Degraded > Healthy; Unknown when nothing assessed; Reading while loading",
    integrationVerdict(failing, inputs().health).word === "Failing"
      && integrationVerdict(degradedByCalls, inputs().health).word === "Degraded"
      && integrationVerdict(ents, inputs().health).word === "Healthy"
      && integrationVerdict(ents.filter((e) => e.healthClass === "not-assessed"), inputs().health).word === "Unknown"
      && integrationVerdict([], loading as never).word === "Reading" && integrationVerdict([], failed("x") as never).word === "Unknown");
  const dist = healthDistribution(ents);
  check("donut sums to the providers listed; zero slices dropped", dist.reduce((a, i) => a + i.value, 0) === ents.length && dist.every((i) => i.value > 0) && dist.map((i) => i.id).join() === "healthy,not-assessed");
  const kpis = providerKpis(ents, inputs());
  check("KPIs: healthy 2/7 · failed 2 of 100 · rate-limited 1 · est. spend this cycle $14.25 (Plaid $12.50 + OpenAI Oct $1.75)",
    kpis.map((k) => `${k.label}=${k.value}`).join() === "Providers healthy=2/7,Failed calls · 7 d=2,Rate-limited · 7 d=1,Est. spend · cycle=$14.25", kpis.map((k) => `${k.label}=${k.value}`).join());
  check("…the spend KPI is partial (an OpenAI day in the cycle had unpriced tokens)", cycleSpendTotal(ents).kind === "ESTIMATED" && (cycleSpendTotal(ents) as { partial: boolean }).partial);
  const noRates = providerEntities(inputs({ plaid: ok({ priceAuthority: { configured: false }, cycles: [] }) as never, trend: ok(trendData({ pricingConfigured: false })) as never }));
  check("no rate card anywhere ⇒ spend KPI 'Unknown', never $0", providerKpis(noRates, inputs()).find((k) => k.key === "spend")!.value === "Unknown");
  check("ops unread ⇒ failed / rate-limited KPIs are '—', never 0",
    providerKpis(ents, inputs({ operations: failed("x") as never })).filter((k) => k.key === "failed" || k.key === "limited").every((k) => k.value === "—"));
  check("every provider says 'cap unknown' and never prints a cap number", ents.every((e) => e.cap === CAP_UNKNOWN && usageText(e).endsWith(CAP_UNKNOWN) || e.key === "RESEND"));
}

// ── 2. AI & Costs model ──────────────────────────────────────────────────────

console.log("2. AI & Costs — provenance, calendar windows with gaps, cycle spend, budget");
{
  const t = trendData();
  const hero = aiSpend30d(ok(t) as never);
  check("hero: ESTIMATED 30 d spend from tokens × rate card, partial when tokens were unpriced", hero.kind === "ESTIMATED" && hero.usd === 1.75 && hero.partial);
  check("hero: no rate card ⇒ UNKNOWN with the reason (never $0)", aiSpend30d(ok(trendData({ pricingConfigured: false })) as never).kind === "UNKNOWN");
  check("hero: unread ⇒ UNKNOWN", aiSpend30d(failed("500") as never).kind === "UNKNOWN");
  check("billed is always Unknown — no invoice data", BILLED_UNKNOWN === "Unknown — no invoice data");

  const keys7 = calendarDays(NOW, 7);
  check("calendar windows are exact UTC days ending today", keys7.length === 7 && keys7[0] === "2026-10-24" && keys7[6] === "2026-10-30" && calendarDays(NOW, 30)[0] === "2026-10-01");
  const s7 = spendSeries(t as never, NOW, 7);
  check("7 d spend: real points only — 10-26 (no tokens) is $0, 10-27 (unpriced) and missing days are gaps",
    s7.points.map((p) => `${p.date}=${p.value}`).join() === "2026-10-26=0,2026-10-29=0.5,2026-10-30=0.25" && s7.gaps === 4, JSON.stringify(s7));
  const s30 = spendSeries(t as never, NOW, 30);
  check("30 d spend: 10-01 (no counter row) is a gap; Σ points = priced spend", s30.points[0].date === "2026-10-02" && s30.usd === 1.75 && s30.gaps === 30 - 4);
  check("no rate card ⇒ no spend line at all", spendSeries(trendData({ pricingConfigured: false }) as never, NOW, 7).points.length === 0);
  const tok = tokenDays(t as never, NOW, 7);
  check("tokens per day: prompt bottom, completion top; a missing counter day is a gap, never 0",
    tok.find((d) => d.day === "2026-10-29")!.succeeded === 1000 && tok.find((d) => d.day === "2026-10-29")!.other === 200 && tok.find((d) => d.day === "2026-10-28")!.observed === false);
  const inv = { byDay: [{ key: "2026-10-30", invocations: 4 }, { key: "2026-10-29", invocations: 2 }] };
  const id = invocationDays(inv as never, NOW, 7);
  check("invocations per day from the ledger's day buckets; days without a bucket are gaps", id.filter((d) => d.observed).map((d) => `${d.day}=${d.succeeded}`).join() === "2026-10-29=2,2026-10-30=4");

  check("cycle = the calendar month", JSON.stringify(currentCycle(NOW)) === JSON.stringify({ start: "2026-10-01", end: "2026-10-31" }));
  const oai = openAiCycleSpend(ok(t) as never, NOW);
  check("OpenAI cycle spend = priced days since the 1st (partial: 10-27 unpriced)", oai.kind === "ESTIMATED" && oai.usd === 1.75 && oai.partial);
  check("…UNKNOWN when the 30-day trend starts after the cycle start (would drop the 1st)",
    openAiCycleSpend(ok(trendData({ since: "2026-10-02" })) as never, Date.parse("2026-10-31T12:00:00Z")).kind === "UNKNOWN");
  check("sumMoney: Σ estimated parts, partial if any part unknown; UNKNOWN when none",
    (() => { const m = sumMoney([{ kind: "ESTIMATED", usd: 1, partial: false, basis: "a" }, { kind: "UNKNOWN", reason: "x" }]); return m.kind === "ESTIMATED" && m.usd === 1 && m.partial; })()
      && sumMoney([{ kind: "UNKNOWN", reason: "x" }]).kind === "UNKNOWN");
  const cbp = costByProvider({ trend: ok(t) as never, plaid: inputs().plaid as never, apiUsage: inputs().apiUsage.data as never, nowMs: NOW });
  check("cost by provider: OpenAI + Plaid estimated; Alchemy / Esplora / CoinGecko UNKNOWN (no rate card)",
    cbp.filter((c) => c.money.kind === "ESTIMATED").map((c) => c.id).join() === "OPENAI,PLAID" && cbp.filter((c) => c.money.kind === "UNKNOWN").map((c) => c.id).join() === "ALCHEMY,ESPLORA,COINGECKO");

  const ai = (over: Record<string, unknown> = {}) => ({ totals: { invocations: 100, usd: 2, unpricedTokens: 0 }, failures: { failed: 3, timeouts: 1, rateLimited: 1, quota: 0, total: 5 }, pricingConfigured: true, byDay: [], ...over });
  const per = costPerCall(ai() as never);
  check("cost per call = priced USD ÷ returned calls (ESTIMATED)", per.kind === "ESTIMATED" && per.usd === 0.02 && !per.partial);
  check("cost per call: unpriced ⇒ UNKNOWN; no calls ⇒ UNKNOWN", costPerCall(ai({ totals: { invocations: 10, usd: null, unpricedTokens: 5 } }) as never).kind === "UNKNOWN" && costPerCall(ai({ totals: { invocations: 0, usd: null, unpricedTokens: 0 } }) as never).kind === "UNKNOWN");
  const budget = { checkedAt: AGO(0), windowHours: 24, fleet: { estimatedUsd: 4, thresholdUsd: 5, alertEnabled: true, utilizationPct: 80, invocations: 9, customers: 2 }, overhead: { estimatedUsd: 1, invocations: 1 },
    customers: [{ ref: "c_aaa", rolling24hUsd: 1, todayUsd: 0.5, allowanceUsd: 1, allowanceSource: "PLATFORM_SETTING", allowanceUtilizationPct: 50, alertUtilizationPct: 10 },
      { ref: "c_bbb", rolling24hUsd: 2, todayUsd: 1.5, allowanceUsd: 1, allowanceSource: "POLICY", allowanceUtilizationPct: 150, alertUtilizationPct: 40 },
      { ref: "c_ccc", rolling24hUsd: 0, todayUsd: 0.1, allowanceUsd: 1, allowanceSource: "POLICY", allowanceUtilizationPct: 10, alertUtilizationPct: 0 },
      { ref: "c_ddd", rolling24hUsd: 0, todayUsd: 0.2, allowanceUsd: 1, allowanceSource: "POLICY", allowanceUtilizationPct: 20, alertUtilizationPct: 0 }],
    bySurface: [], unpriced: { invocations: 0, models: [] }, recentAlerts: [], controls: { allowanceEnforced: true, allowanceDefaultUsd: 1, userAlertEnabled: true, userAlertThresholdUsd: 2, paused: false }, estimateNote: "" };
  const kp = aiKpis({ budget: ok(budget) as never, inv7: ok(ai()) as never });
  check("AI KPIs: budget 80 % (warn) · calls 105 · error rate 4.8 % · est. $0.02 / call",
    kp.map((k) => `${k.key}=${k.value}`).join() === "budget=80%,calls=105,errors=4.8%,per-call=$0.02" && kp[0].tone === "warn", kp.map((k) => `${k.key}=${k.value}`).join());
  check("AI KPIs unread ⇒ '—' everywhere, never 0", aiKpis({ budget: failed("x") as never, inv7: failed("x") as never }).every((k) => k.value === "—"));
  const m = budgetMeter(budget as never)!;
  check("budget meter: pct from the reader, tone by threshold, unpriced ⇒ null pct + UNKNOWN spend",
    m.pct === 80 && m.tone === "warn" && budgetMeter({ ...budget, fleet: { ...budget.fleet, estimatedUsd: null, utilizationPct: null } } as never)!.pct === null
      && budgetMeter({ ...budget, fleet: { ...budget.fleet, estimatedUsd: null, utilizationPct: null } } as never)!.spend.kind === "UNKNOWN");
  check("top customers: by today's spend, capped at 3", topCustomers(budget as never).map((c) => c.ref).join() === "c_bbb,c_aaa,c_ddd");
  const spend = { spend: { customer: { chat: { usd: 3 }, brief: { usd: 1 }, total: { usd: 4 } }, overhead: { harness: { usd: 0.5 }, other: { usd: null }, total: { usd: 0.5 } }, unpriced: { tokens: 1, invocations: 2, models: [] }, byDay: [], window: { days: 30, from: "2026-10-01", to: "2026-10-30" } }, safeguards: {} };
  const sbs = spendBySurface(spend as never);
  check("cost by surface: Σ slices = the priced total; an unpriced surface is no slice (never $0)", sbs.total === 4.5 && sbs.items.map((i) => i.id).join() === "chat,brief,harness" && sbs.unpricedInvocations === 2);
}

// ── 3. Render ────────────────────────────────────────────────────────────────

console.log("3. Render — compact default screens, drawers host every former widget");
{
  const hostedCalls: string[] = [];
  const pHtml = renderToStaticMarkup(createElement(ProvidersLeadSurface, {
    inputs: inputs(), daily, drawer: null, onOpenDrawer: () => {}, onCloseDrawer: () => {},
    hasHosted: () => true, renderHosted: (k: string) => { hostedCalls.push(k); return null; }, onOpenWorkspace: () => {},
  } as never));
  const pT = text(pHtml);
  check("Providers: hero 'Integration health' with verdict + checked time + 4 KPI tiles", /Integration health/.test(pT) && /Healthy/.test(pT) && /Checked 11:59 UTC/.test(pT) && /Providers healthy/.test(pT) && /Est\. spend · cycle/.test(pT));
  check("Providers: sync DayBars + health donut (centre counts providers)", /data-day-bars/.test(pHtml) && /data-center-total="true">7<\/p><p[^>]*>providers<\/p>/.test(pHtml));
  check(`Providers: ${TILE_ROWS} tiles worst first, 'See all 7'`, (lists(pHtml).find((l) => l.label === "Providers")?.items ?? 0) === TILE_ROWS && /See all 7/.test(pT));
  check("Providers: every default list ≤ 5", lists(pHtml).every((l) => l.items <= 5), JSON.stringify(lists(pHtml)));
  check("Providers: no paragraph on the default screen (every text line ≤ 90 chars)", paragraphs(pHtml).every((p) => p.length <= 90), paragraphs(pHtml).filter((p) => p.length > 90).join(" | "));
  check("Providers: tiles say 'cap unknown'; an unknown-cost tile prints no $", (pHtml.match(/cap unknown/g) ?? []).length >= 3
    && pHtml.split("data-provider-tile=").slice(1).filter((t) => /Unknown/.test(t)).every((t) => !/\$/.test(t.slice(0, t.indexOf("</button>")))));
  check("Providers: the old stacked Provider Health card is gone from the default screen", !/data-hosted|Provider health \(all providers\)/.test(pHtml));
  check("Providers: nothing hosted mounts on the default screen", hostedCalls.length === 0);
  check("Providers: the fleet detail nav is ≤ 5 drawers", (pHtml.match(/<nav aria-label="Provider detail"[\s\S]*?<\/nav>/)?.[0].match(/<button/g) ?? []).length === FLEET_DIAGNOSTICS.length && FLEET_DIAGNOSTICS.length <= 5);

  // Every Providers hosted key is reachable: a fleet drawer or a provider detail.
  const view = PLATFORM_AREA_WORKSPACES.PLATFORM_OPS.find((w) => w.workspaceId === "platform-providers")!.views![0];
  const ents = providerEntities(inputs());
  const reach = new Set([...FLEET_DIAGNOSTICS.flatMap((d) => d.keys), ...ents.flatMap((e) => e.diagnostics)]);
  check("Providers: every hosted key is reachable from a drawer", (view.hosted ?? []).every((k) => reach.has(k)), (view.hosted ?? []).filter((k) => !reach.has(k)).join());
  for (const d of FLEET_DIAGNOSTICS) {
    const got: string[] = [];
    renderToStaticMarkup(createElement(ProvidersDrawerBody, { drawer: { kind: "fleet", id: d.id }, entities: ents, nowMs: NOW, hasHosted: () => true, renderHosted: (k: string) => { got.push(k); return null; }, onOpenDrawer: () => {}, onOpenWorkspace: () => {} }));
    check(`Providers drawer '${d.name}' hosts ${d.keys.join(" + ")} once each`, got.join() === d.keys.join());
  }
  const all = renderToStaticMarkup(createElement(ProvidersDrawerBody, { drawer: { kind: "all" }, entities: ents, nowMs: NOW, hasHosted: () => true, renderHosted: () => null, onOpenDrawer: () => {}, onOpenWorkspace: () => {} }));
  check("Providers 'See all' drawer lists every provider", (lists(all).find((l) => l.label === "All providers")?.items ?? 0) === ents.length);

  // AI & Costs.
  const inv = (window: string) => ({ window: { key: window }, totals: { invocations: 40, usd: 0.8, unpricedTokens: 0 }, failures: { failed: 1, timeouts: 0, rateLimited: 1, quota: 0, total: 2 }, pricingConfigured: true,
    byDay: [{ key: "2026-10-29", invocations: 20 }, { key: "2026-10-30", invocations: 20 }] });
  const budget = { checkedAt: AGO(0), windowHours: 24, fleet: { estimatedUsd: 1, thresholdUsd: 5, alertEnabled: true, utilizationPct: 20, invocations: 9, customers: 2 }, overhead: { estimatedUsd: 0, invocations: 0 },
    customers: Array.from({ length: 6 }, (_, i) => ({ ref: `c_${i}`, rolling24hUsd: i, todayUsd: i / 10, allowanceUsd: 1, allowanceSource: "POLICY", allowanceUtilizationPct: i * 10, alertUtilizationPct: 0 })),
    bySurface: [], unpriced: { invocations: 0, models: [] }, recentAlerts: [], controls: { allowanceEnforced: true, allowanceDefaultUsd: 1, userAlertEnabled: false, userAlertThresholdUsd: 2, paused: false }, estimateNote: "" };
  const spend = { spend: { customer: { chat: { usd: 1 }, brief: { usd: 0.5 }, total: { usd: 1.5 } }, overhead: { harness: { usd: 0.25 }, other: { usd: null }, total: { usd: 0.25 } }, unpriced: { tokens: 0, invocations: 0, models: [] }, byDay: [], window: { days: 30, from: "2026-10-01", to: "2026-10-30" } }, safeguards: {} };
  const aiProps = (over: Record<string, unknown> = {}) => ({
    trend: ok(trendData()), spend: ok(spend), inv7: ok(inv("7d")), inv30: ok(inv("30d")), budget: ok(budget), plaid: inputs().plaid, apiUsage: inputs().apiUsage,
    nowMs: NOW, hasHosted: () => true, onOpenDrawer: () => {}, ...over,
  });
  const aHtml = renderToStaticMarkup(createElement(AiCostsLeadSurface, aiProps() as never));
  const aT = text(aHtml);
  check("AI: hero 'AI spend · 30 d' = $1.75 Estimated, billed Unknown — no invoice data", /AI spend · 30 d/.test(aT) && /\$1\.75/.test(aT) && /Estimated/.test(aT) && /billed: Unknown — no invoice data/.test(aT));
  check("AI: the hero never calls the estimate a bill", !/billed: \$/.test(aT) && !/Billed \$/.test(aT));
  check("AI: KPIs — budget used · calls 7 d · error rate 7 d · est. cost / call", /Budget used/.test(aT) && /Calls · 7 d/.test(aT) && /Error rate · 7 d/.test(aT) && /Est\. cost \/ call/.test(aT));
  check("AI: charts — daily spend (TrendChart) · cost by surface donut · tokens DayBars · provider bars", /Daily spend/.test(aT) && /Cost by surface/.test(aT) && /data-day-bars/.test(aHtml) && /Cost by provider/.test(aT) && /<svg width="180" height="180"/.test(aHtml));
  check("AI: window toggle 7 d / 30 d and series toggle Tokens / Invocations", /aria-label="Spend window"/.test(aHtml) && /aria-pressed="true"[^>]*>30 d/.test(aHtml) && /aria-label="Series"/.test(aHtml));
  check("AI: budget meter drawn from the reader's percentage", /role="meter" aria-label="Fleet AI budget used"[^>]*aria-valuenow="20"/.test(aHtml));
  check(`AI: customers capped at ${CUSTOMER_ROWS}; policy-group cost is an honest 'not yet available'`, (lists(aHtml).find((l) => l.label === "Top customers by AI spend today")?.items ?? 0) === CUSTOMER_ROWS && /Cost by policy group · not yet available/.test(aT));
  const econ = /data-economics-slot(?:="[^"]*")?>([^<]*)</.exec(aHtml)?.[1] ?? "";
  check("AI: the Economics (Phase 3) slot carries no numbers", econ.length > 0 && !/[\d$]/.test(econ) && /Phase 3/.test(aT));
  check("AI: every default list ≤ 5", lists(aHtml).every((l) => l.items <= 5), JSON.stringify(lists(aHtml)));
  check("AI: no paragraph on the default screen (every text line ≤ 90 chars)", paragraphs(aHtml).every((p) => p.length <= 90), paragraphs(aHtml).filter((p) => p.length > 90).join(" | "));
  check("AI: provenance words throughout (Estimated + Unknown + measured)", /data-provenance="ESTIMATED"/.test(aHtml) && /data-provenance="UNKNOWN"/.test(aHtml) && /measured/.test(aT));
  const navBtns = (aHtml.match(/<nav aria-label="AI &amp; Costs detail"[\s\S]*?<\/nav>/)?.[0].match(/<button/g) ?? []).length;
  check("AI: five drawers in the detail nav (≤ 5)", navBtns === AI_DRAWERS.length && AI_DRAWERS.length <= 5);
  check("AI: without hosted rows, no drawer doorway renders", !/AI &amp; Costs detail/.test(renderToStaticMarkup(createElement(AiCostsLeadSurface, aiProps({ hasHosted: () => false }) as never))));
  const unknownHtml = text(renderToStaticMarkup(createElement(AiCostsLeadSurface, aiProps({ trend: ok(trendData({ pricingConfigured: false })), inv7: failed("x"), budget: failed("x") }) as never)));
  check("AI: unpriced ⇒ the hero says Unknown and prints no dollar figure", /AI spend · 30 d Unknown/.test(unknownHtml) && /Spend Unknown — no AI rate card configured/.test(unknownHtml));

  const aiView = PLATFORM_AREA_WORKSPACES.PLATFORM_OPS.find((w) => w.workspaceId === "platform-ai")!.views![0];
  const drawerKeys = AI_DRAWERS.flatMap((d) => d.keys);
  check("AI: every hosted key is in exactly one drawer", (aiView.hosted ?? []).every((k) => drawerKeys.filter((x) => x === k).length === 1) && drawerKeys.length === (aiView.hosted ?? []).length);
  for (const d of AI_DRAWERS) {
    const got: string[] = [];
    renderToStaticMarkup(createElement(AiCostsDrawerBody, { drawer: d.key, renderHosted: (k: string) => { got.push(k); return null; }, onOpenWorkspace: () => {} }));
    check(`AI drawer '${d.label}' hosts ${d.keys.join(" + ")} through renderHosted`, got.join() === d.keys.join());
  }
}

// ── 4. Source rules ──────────────────────────────────────────────────────────

console.log("4. Source rules");
for (const f of ["components/platform/leads/AiCostsLead.tsx", "components/platform/leads/ProvidersLead.tsx", "components/platform/leads/visual-kit.tsx", "components/platform/leads/ai-costs-model.ts", "components/platform/leads/providers-model.ts", "components/platform/ops-visual/HealthHero.tsx", "components/platform/ops-visual/DayBars.tsx"]) {
  const src = code(f);
  check(`${f}: no access-level literal / control flag`, !/\bCONTROL\b/.test(src) && !/canControl/.test(src));
  check(`${f}: no viewport read, no raw fetch`, !/matchMedia|innerWidth/.test(src) && !/\bfetch\(/.test(src));
}
check("Personal components are imported, not forked (TrendChart, BreakdownWidget, CompactKpiStrip via HealthHero)",
  /from "@\/components\/space\/widgets\/charts\/TrendChart"/.test(code("components/platform/leads/AiCostsLead.tsx"))
    && /from "@\/components\/space\/widgets\/BreakdownWidget"/.test(code("components/platform/leads/AiCostsLead.tsx"))
    && /from "@\/components\/space\/widgets\/BreakdownWidget"/.test(code("components/platform/leads/ProvidersLead.tsx"))
    && /CompactKpiStrip/.test(code("components/platform/ops-visual/HealthHero.tsx")));

if (failures > 0) {
  console.error(`\nplatform-visual-providers-ai: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nplatform-visual-providers-ai: all checks passed.");
