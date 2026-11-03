/**
 * lib/platform/economics/platform-ai.test.ts  (Platform Economics — PR C: the Platform AI category)
 *
 *   1. the surface — PLATFORM_AI_SURFACES is exactly what the operator AI path
 *      records (COMMS_AUTHORING_SURFACE); every operator AI caller is wired
 *      (a ratchet: a new runWithAiInvocationContext under lib/platform,
 *      lib/notifications or app/api/platform must use a Platform AI surface);
 *   2. the split — the spend fold buckets it apart from harness / unattributed;
 *      the Overview's operating cost lists it as its own component, and overhead
 *      no longer contains it;
 *   3. status paths — ESTIMATED / PARTIAL (an unpriced call) / UNAVAILABLE (no
 *      usage: null with its reason, never $0; no rate card);
 *   4. drill = KPI — the day rows sum to the figure; the per-invocation records'
 *      returned cost sums to the same figure; failures "not counted", unpriced
 *      "unpriced", never $0; operators are opaque refs; latency + by-model;
 *   5. render + 375 px; the route is GET-only, gated, fm_system.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/economics/platform-ai.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMS_AUTHORING_SURFACE } from "@/lib/notifications/content/ai-allowance";
import { PLATFORM_AI_SURFACES, buildAiSpendBySurface, type SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import {
  REASON_NO_AI_RATE_CARD, REASON_NO_PLATFORM_AI, buildEconomicsDrill, buildEconomicsSnapshot, type EconomicsInputs,
} from "@/lib/platform/economics/snapshot-core";
import { getPlatformAiRecords, parsePlatformAiQuery, type PlatformAiInvocationSource } from "@/lib/platform/economics/platform-ai";
import { PlatformAiCallsList, PlatformAiSummary } from "@/components/platform/leads/PlatformAiCard";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);

const NOW = Date.parse("2026-11-03T12:00:00Z");
// gpt-5-mini: 1M prompt × $0.25/M + 0.5M completion × $2/M = $1.25 per (1M, 0.5M).
const g = (day: string, surface: string | null, o: Partial<SpendGroup> = {}): SpendGroup => ({
  provider: "OPENAI", model: "gpt-5-mini", surface, day, invocations: 1, promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 500_000, ...o,
});
const PLATFORM = COMMS_AUTHORING_SURFACE;
const base = (spendGroups: SpendGroup[], o: Partial<EconomicsInputs> = {}): EconomicsInputs => ({
  nowMs: NOW, spendGroups, aiPricingConfigured: true, plaidCycle: null, plaidReadingsAgree: true, plaidRates: [], engagedCustomerRefs: [], ...o,
});

const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) yield* walk(f);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) yield f;
  }
}

async function main() {
  // ── 1. The surface ───────────────────────────────────────────────────────────
  console.log("1. the Platform AI surface");
  check("PLATFORM_AI_SURFACES is exactly the operator path's recorded surface", JSON.stringify(PLATFORM_AI_SURFACES) === JSON.stringify([COMMS_AUTHORING_SURFACE]));
  const operatorCallers: string[] = [];
  for (const root of ["lib/platform", "lib/notifications", "app/api/platform"]) {
    for (const f of walk(path.join(process.cwd(), root))) {
      const t = readFileSync(f, "utf8");
      if (/runWithAiInvocationContext\(/.test(t) && !/^\s*import/m.test(t.slice(t.indexOf("runWithAiInvocationContext(") - 1, t.indexOf("runWithAiInvocationContext(")))) operatorCallers.push(path.relative(process.cwd(), f));
    }
  }
  check("ratchet: every operator AI call site records a Platform AI surface (add a new one to PLATFORM_AI_SURFACES)",
    operatorCallers.length > 0 && operatorCallers.every((f) => /COMMS_AUTHORING_SURFACE/.test(readFileSync(path.join(process.cwd(), f), "utf8"))), operatorCallers.join(", "));

  // ── 2. The split ─────────────────────────────────────────────────────────────
  console.log("2. the split");
  const groups = [g("2026-11-01", "chat"), g("2026-11-02", PLATFORM), g("2026-11-02", PLATFORM), g("2026-11-03", "harness"), g("2026-11-03", "mystery")];
  const fold = buildAiSpendBySurface(groups);
  check("spend fold: Platform AI is its own overhead bucket (not 'Unattributed')", near(fold.overhead.platform.usd, 2.5) && near(fold.overhead.other.usd, 1.25) && near(fold.overhead.total.usd, 5) && near(fold.customer.total.usd, 1.25));
  const s = buildEconomicsSnapshot(base(groups));
  const op = buildEconomicsDrill(base(groups), "operating_cost", "cycle");
  check("operating cost lists 'AI · Platform AI' as its own row; overhead excludes it; the whole is unchanged",
    near(op.rows.find((r) => r.id === "ai-platform")?.value ?? null, 2.5) && near(op.rows.find((r) => r.id === "ai-overhead")?.value ?? null, 2.5) && near(s.figures.operating_cost.value, 6.25));
  const noPlatformOp = buildEconomicsDrill(base([g("2026-11-01", "chat")]), "operating_cost", "cycle");
  check("no Platform AI usage ⇒ no Platform AI row (no usage is not a missing part)", !noPlatformOp.rows.some((r) => r.id === "ai-platform"));

  // ── 3. Status paths ──────────────────────────────────────────────────────────
  console.log("3. status paths");
  check("ESTIMATED: priced operator calls this cycle", s.figures.platform_ai_cost.status === "ESTIMATED" && near(s.figures.platform_ai_cost.value, 2.5));
  const part = buildEconomicsSnapshot(base([...groups, g("2026-11-02", PLATFORM, { model: "not-a-rated-model" })]));
  check("PARTIAL: an unpriced operator call is named, never folded in at $0", part.figures.platform_ai_cost.status === "PARTIAL" && near(part.figures.platform_ai_cost.value, 2.5));
  const none = buildEconomicsSnapshot(base([g("2026-11-01", "chat")]));
  check("UNAVAILABLE: no Platform AI usage ⇒ null with its reason, never $0", none.figures.platform_ai_cost.value === null && none.figures.platform_ai_cost.reason === REASON_NO_PLATFORM_AI
    && Object.values(none.trend.platformAi).every((f) => f.value === null));
  const noRate = buildEconomicsSnapshot(base(groups, { aiPricingConfigured: false }));
  check("UNAVAILABLE: no rate card ⇒ null, no drill", noRate.figures.platform_ai_cost.value === null && noRate.figures.platform_ai_cost.reason === REASON_NO_AI_RATE_CARD && noRate.figures.platform_ai_cost.drill === null);
  check("windows: 7 d / 30 d / 90 d carry the same figure shape", ["7d", "30d", "90d"].every((w) => s.trend.platformAi[w as "7d"].key === "platform_ai_cost" && near(s.trend.platformAi[w as "7d"].value, 2.5)));

  // ── 4. Drill = KPI ───────────────────────────────────────────────────────────
  console.log("4. drill = KPI");
  for (const w of ["cycle", "7d", "30d", "90d"] as const) {
    const d = buildEconomicsDrill(base(groups), "platform_ai_cost", w);
    const kpi = w === "cycle" ? s.figures.platform_ai_cost : s.trend.platformAi[w];
    check(`day rows: ${w} total = KPI`, near(d.total, kpi.value) && d.figure.status === kpi.status);
  }
  const inv = (id: string, o: Partial<PlatformAiInvocationSource>): PlatformAiInvocationSource => ({
    id, occurredAt: new Date("2026-11-02T10:00:00Z"), provider: "OPENAI", model: "gpt-5-mini", surface: PLATFORM, subSurface: `${PLATFORM}:polish`,
    outcome: "RETURNED", errorCode: null, promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 500_000, latencyMs: 900, userId: "op_user_secret_id", ...o,
  });
  const listed = [inv("a", {}), inv("b", { latencyMs: 1500 }), inv("c", { outcome: "FAILED", errorCode: "TIMEOUT", promptTokens: 0, completionTokens: 0, latencyMs: 30000 })];
  const rec = await getPlatformAiRecords({ window: "30d", untilMs: NOW, page: 1 }, {
    groups: async () => groups, plaidReaders: { items: async () => [], transitions: async () => [] }, engagedSince: async () => new Set(),
    aiPricingConfigured: true, plaidRates: [], ref: (id) => `user #${id.length}`, list: async () => listed,
  });
  check("records: Σ returned cost = the KPI (same pricer)", near(rec.returnedCostUsd, rec.figure.value) && near(rec.figure.value, 2.5), `${rec.returnedCostUsd} ${rec.figure.value}`);
  check("records: a failure is 'not counted' (null), counted aside", rec.page.rows.find((r) => r.id === "c")?.pricing === "NOT_COUNTED" && rec.page.rows.find((r) => r.id === "c")?.costUsd === null && rec.counts.failed === 1 && rec.counts.returned === 2);
  check("records: latency over returned calls; by-model rollup with in/out/cached tokens", rec.latencyMs?.p50 === 900 && rec.latencyMs?.p95 === 1500 && rec.byModel[0].model === "gpt-5-mini" && rec.byModel[0].calls === 3 && rec.byModel[0].promptTokens === 2_000_000);
  check("records: operators are opaque refs, never the id", !JSON.stringify(rec).includes("op_user_secret_id") && rec.page.rows.every((r) => r.operatorRef?.startsWith("user #")));
  check("query: window validated, until clamped, page ≥ 1", parsePlatformAiQuery(new URLSearchParams({ window: "bogus" }), NOW) === null
    && parsePlatformAiQuery(new URLSearchParams({ until: String(NOW + 5) }), NOW)?.untilMs === NOW && parsePlatformAiQuery(new URLSearchParams({ page: "-3" }), NOW)?.page === 1);

  // ── 5. Render + route ────────────────────────────────────────────────────────
  console.log("5. render + route");
  const ok = { loading: false, error: null };
  const sum = renderToStaticMarkup(createElement(PlatformAiSummary, { data: { data: rec, ...ok }, onOpenCalls: () => {} }));
  check("summary: figure, calls / failures, latency, top model", /data-platform-ai-value="true">\$2\.50</.test(sum) && /3 calls · 1 failed · measured/.test(sum) && /p50 900 ms/.test(sum) && /top model gpt-5-mini/.test(sum));
  const emptyRec = { ...rec, figure: none.figures.platform_ai_cost, counts: { total: 0, returned: 0, failed: 0, unpriced: 0 }, returnedCostUsd: null, latencyMs: null, byModel: [], page: { ...rec.page, total: 0, rows: [] } };
  const emptyHtml = renderToStaticMarkup(createElement(PlatformAiSummary, { data: { data: emptyRec, ...ok } }));
  check("summary with no usage: 'Unavailable', never $0.00, no Calls doorway", /data-platform-ai-value="true">Unavailable</.test(emptyHtml) && !/\$0\.00/.test(emptyHtml) && !/>Calls</.test(emptyHtml));
  const list = renderToStaticMarkup(createElement(PlatformAiCallsList, { data: rec }));
  check("calls list: priced rows show dollars, the failure 'not counted'", /data-platform-ai-pricing="NOT_COUNTED"/.test(list) && /not counted/.test(list) && (list.match(/\$1\.25/g) ?? []).length >= 2);
  const card = readFileSync(path.join(process.cwd(), "components/platform/leads/PlatformAiCard.tsx"), "utf8");
  check("375 px: no fixed pixel width, no table, rows shrink and wrap", !/\bw-\[\d+px\]/.test(card) && !/min-w-\[\d/.test(card) && !/<table/.test(card) && (card.match(/min-w-0/g) ?? []).length >= 6 && /flex-wrap/.test(card));
  const route = strip("app/api/platform/platform-ops/economics/platform-ai/route.ts");
  check("route: PLATFORM_OPS READ, GET only, no-store", /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route) && /no-store/.test(route));
  const reader = strip("lib/platform/economics/platform-ai.ts");
  check("reader: fm_system only, writes nothing", /import \{ systemDb \} from "@\/lib\/db"/.test(reader) && !/\bdb\./.test(reader)
    && !/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|\$executeRaw/.test(reader));
  check("AI & Costs mounts the Platform AI card", /<PlatformAiCard \/>/.test(readFileSync(path.join(process.cwd(), "components/platform/leads/AiCostsLead.tsx"), "utf8")));

  if (failures > 0) { console.error(`\nplatform ai: ${failures} failure(s).`); process.exit(1); }
  console.log("\nplatform ai: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
