/**
 * components/platform/widgets/overview/ai-economics-activity.test.ts  (UX-P1 · Agent 5)
 *
 * THE THREE AGENT-5 OVERVIEW BLOCKS, RENDERED — AI activity, Economics, Recent
 * operator activity — through their prop-driven surfaces, plus the pure
 * view-models. Pins: estimate labels on every dollar, gaps ≠ zero, no fabricated
 * failure series, opaque targets and result words on the feed, one
 * SectionSurface per block, doorways only through onOpenWorkspace.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/overview/ai-economics-activity.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import type { AiOperations } from "@/lib/platform/ai/invocations";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { OperatorFeedResponse } from "@/lib/platform/activity/operator-feed-core";
import { AiActivitySurface } from "./AiActivityBlock";
import { EconomicsSurface } from "./EconomicsBlock";
import { ActivityFeedSurface } from "./ActivityFeedBlock";
import { AiTrendSurface } from "../OpsAiTrendWidget";
import {
  aiOutcomeSegments, aiSpendReading, callsPerDay, plaidCycleReading, spendPerDay, utcDayKeys,
} from "./ai-economics-view";
import { relativeText, resultTone, resultWord, utcStamp } from "./activity-feed-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const loading = { data: null, loading: true, error: null };
const failed = { data: null, loading: false, error: "Request failed (500)" };

const trend = (over: Partial<AiUsageTrend> = {}): AiUsageTrend => ({
  since: "2026-09-15",
  days: [
    { day: "2026-10-12", calls: 40, promptTokens: 120_000, completionTokens: 8_000, estimatedSpendUsd: 0.42 },
    { day: "2026-10-14", calls: 12, promptTokens: 30_000, completionTokens: 2_000, estimatedSpendUsd: 0.11 },
  ],
  totals: { calls: 52, promptTokens: 150_000, completionTokens: 10_000, estimatedSpendUsd: 0.53 },
  models: ["gpt-5.1"], pricingConfigured: true, tier: "estimated", unpricedTokens: 0, unpricedDays: [], checkedAt: new Date(NOW).toISOString(),
  ...over,
});
const ops = (over: Partial<AiOperations> = {}): AiOperations => ({
  totals: { invocations: 50, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0, toolCalls: 0, meanLatencyMs: null, maxLatencyMs: null, usd: null, unpricedTokens: 0, cacheShare: null },
  bySurface: [], byModel: [], byEnvironment: [], byDay: [], unattributedSurfaceKey: "(none)",
  window: { key: "30d", from: "", to: "" }, filter: { surface: null, model: null, environment: null },
  available: { surfaces: [], models: [], environments: [] }, recent: [], pricingConfigured: true,
  failures: { failed: 2, timeouts: 1, rateLimited: 3, quota: 0, total: 6 },
  limits: { failuresRecorded: true, userDimension: "RECORDED_NOT_EXPOSED", spaceDimension: "RECORDED_NOT_EXPOSED", note: "" },
  checkedAt: "", ...over,
});
const cycleCost = (usd: number | null, tx = 3, inv = 1) => ({
  itemMonths: { transactions: tx, investments: inv }, usd, unpricedItemMonths: usd === null ? tx + inv : 0, unevidencedProductItemMonths: 0,
  coverage: { incomplete: false }, byEnvironment: [],
});
const plaid = (over: Partial<PlaidUsage> = {}): PlaidUsage => ({
  checkedAt: "", population: { total: 5, billable: 4, seeded: 1, byStatus: { ACTIVE: 4 }, byEnvironment: { production: 4 }, investmentsConsented: 1, withTransitions: 2 },
  cycles: [
    { cycle: { start: "2026-10-01", end: "2026-10-31" }, label: "current", during: cycleCost(1.4) as never, atEnd: cycleCost(1.05, 2, 1) as never, agree: false },
    { cycle: { start: "2026-09-01", end: "2026-09-30" }, label: "previous", during: cycleCost(1.2) as never, atEnd: cycleCost(1.2) as never, agree: true },
  ],
  priceAuthority: { configured: true, tier: "ESTIMATED", rates: [{ product: "transactions", usdPerItemMonth: 0.3, effectiveFrom: "2026-07-01", source: "invoice" }], note: "" },
  limits: { dailyAllocation: false, note: "" }, ...over,
});
const feed = (over: Partial<OperatorFeedResponse> = {}): OperatorFeedResponse => ({
  scope: "PLATFORM_OPS", depth: { requested: 20, returned: 2 },
  note: "Last 20 recorded actions on platform objects; security events live in Security Operations.",
  items: [
    { id: "a", at: "2026-10-14T11:57:00.000Z", operator: "chris", action: "OPERATOR_REFRESH_ALL", actionLabel: "Refreshed a customer's authorities",
      target: "user …123456", result: "SUCCESS", reasonCode: "SUPPORT_REQUEST", evidence: { refreshExecutionId: "exec_abc123def456", workspace: "platform-refresh" } },
    { id: "b", at: "2026-10-13T09:00:00.000Z", operator: "dana", action: "PLATFORM_OPERATION_EXECUTED", actionLabel: "Ran a manual operation",
      target: "job …-banks", result: "FAILURE", reasonCode: null, evidence: { jobRunId: "run_000000abc123", workspace: "platform-jobs" } },
  ],
  checkedAt: new Date(NOW).toISOString(), ...over,
});

const surfaces = (html: string) => (html.match(/<section/g) ?? []).length;

console.log("1. view: UTC day keys and gaps");
{
  const keys = utcDayKeys(NOW, 30);
  check("30 keys ending today, oldest first", keys.length === 30 && keys[29] === "2026-10-14" && keys[0] === "2026-09-15");
  const pts = callsPerDay(trend(), NOW);
  check("observed days carry their counts; every other day is a GAP (null), never 0",
    pts.find((p) => p.key === "2026-10-12")?.value === 40 && pts.find((p) => p.key === "2026-10-13")?.value === null && pts.filter((p) => p.value === 0).length === 0);
  const spend = spendPerDay(trend({ days: [{ day: "2026-10-13", calls: 5, promptTokens: 1, completionTokens: 1, estimatedSpendUsd: null }, ...trend().days] }), NOW);
  check("an observed but UNPRICED day is a gap with its reason, not $0",
    spend.find((p) => p.key === "2026-10-13")?.value === null && /unpriced/.test(spend.find((p) => p.key === "2026-10-13")?.title ?? ""));
  check("pricing not configured ⇒ every spend point is a gap", spendPerDay(trend({ pricingConfigured: false }), NOW).every((p) => p.value === null));
}

console.log("\n2. view: readings label every dollar an estimate");
{
  const r = aiSpendReading(trend());
  check("AI spend figure + estimate qualifier", r.kind === "figure" && r.value === "$0.53" && /estimate, not a bill/.test(r.qualifier));
  const partial = aiSpendReading(trend({ unpricedTokens: 500, unpricedDays: ["2026-10-01", "2026-10-02"] }));
  check("partial coverage is stated", partial.kind === "figure" && /2 days unpriced/.test(partial.qualifier));
  const none = aiSpendReading(trend({ pricingConfigured: false, totals: { ...trend().totals, estimatedSpendUsd: null } }));
  check("no pricing ⇒ unavailable with the reason", none.kind === "unavailable" && /no AI pricing configured/.test(none.reason));
  const p = plaidCycleReading(plaid());
  check("Plaid current cycle: Item-months, disagreeing readings named, estimate, a range when readings disagree",
    p.kind === "figure" && p.value === "$1.40 – $1.05" && /4 Item-months this cycle/.test(p.qualifier) && /readings disagree/.test(p.qualifier) && /estimate, not a bill/.test(p.qualifier));
  const unpriced = plaidCycleReading(plaid({ cycles: [{ ...plaid().cycles[0], during: cycleCost(null) as never, atEnd: cycleCost(null) as never, agree: true }] }));
  check("a cycle before the rate's evidence: unavailable with the reason, usage still in the qualifier",
    unpriced.kind === "unavailable" && /predates/.test(unpriced.reason) && /Item-months/.test(unpriced.qualifier));
  const noAuthority = plaidCycleReading(plaid({ priceAuthority: { ...plaid().priceAuthority, configured: false } }));
  check("no price authority ⇒ unavailable, never $0", noAuthority.kind === "unavailable" && /no Plaid price authority/.test(noAuthority.reason));
  const seg = aiOutcomeSegments(50, ops().failures);
  check("outcome segments: returned ok, failed/timeout/quota bad, rate limited warn — words + counts",
    seg.map((s) => `${s.word}:${s.count}:${s.tone}`).join() === "returned:50:ok,failed:2:bad,timeout:1:bad,rate limited:3:warn,quota:0:bad");
}

console.log("\n3. AI activity surface");
{
  const html = renderToStaticMarkup(createElement(AiActivitySurface, { trend: ok(trend()), ops: ok(ops()), nowMs: NOW, onOpenWorkspace: () => {} }));
  check("one SectionSurface titled AI activity", surfaces(html) === 1 && /AI activity/.test(html));
  check("bars: 30 buckets, 2 observed, 28 without observation, peak named", /30 buckets, 2 observed, 28 without observation/.test(html) && /peak 40 calls on 2026-10-12/.test(html));
  check("gaps render as dashed hairlines, never as zero-height bars", (html.match(/border-dashed/g) ?? []).length === 28 && !/: 0 calls/.test(html));
  check("outcomes as a DistributionBar with words + counts; no per-day failure series", /returned/.test(html) && /rate limited/.test(html) && /no daily failure series is drawn/.test(html));
  check("estimated spend carries the estimate caption", /\$0\.53/.test(html) && /estimate, not a bill/.test(html));
  check("aggregate-only statement", /no per-user attribution/.test(html));
  check("doorway opens the AI workspace through the switcher (a button, no link)", /aria-label="Open AI"/.test(html) && !/<a /.test(html));
  const noDoor = renderToStaticMarkup(createElement(AiActivitySurface, { trend: ok(trend()), ops: ok(ops()), nowMs: NOW }));
  check("without a switcher no doorway is rendered", !/Open AI/.test(noDoor));
  const unpriced = renderToStaticMarkup(createElement(AiActivitySurface, { trend: ok(trend({ pricingConfigured: false, totals: { ...trend().totals, estimatedSpendUsd: null } })), ops: ok(ops()), nowMs: NOW }));
  check("no pricing: Unavailable with the reason, no dollar figure", /no AI pricing configured/.test(unpriced) && !/\$\d/.test(unpriced));
  const opsFailed = renderToStaticMarkup(createElement(AiActivitySurface, { trend: ok(trend()), ops: failed, nowMs: NOW }));
  check("outcomes failing to load is an alert beside the bars, not a hidden block", /role="alert"/.test(opsFailed) && /30 buckets/.test(opsFailed));
  const load = renderToStaticMarkup(createElement(AiActivitySurface, { trend: loading, ops: loading, nowMs: NOW }));
  check("loading is a status line in the same surface", /role="status"/.test(load) && surfaces(load) === 1);
}

console.log("\n4. Economics surface");
{
  const html = renderToStaticMarkup(createElement(EconomicsSurface, { plaid: ok(plaid()), trend: ok(trend()), nowMs: NOW, onOpenWorkspace: () => {} }));
  check("one SectionSurface titled Economics", surfaces(html) === 1 && />Economics</.test(html));
  check("Plaid stat with its range and qualifier", /\$1\.40 – \$1\.05/.test(html) && /4 Item-months this cycle/.test(html));
  check("AI stat with estimate qualifier", /\$0\.53/.test(html) && (html.match(/estimate, not a bill/g) ?? []).length >= 3);
  check("spend-per-day bars present with the never-\\$0 caption", /Estimated AI spend per UTC day/.test(html) && /never \$0/.test(html));
  check("the no-ledger sentence is stated", /No actual-charge ledger exists/.test(html));
  check("doorway opens Economics", /aria-label="Open Economics"/.test(html));
  const noPricing = renderToStaticMarkup(createElement(EconomicsSurface, { plaid: ok(plaid()), trend: ok(trend({ pricingConfigured: false, totals: { ...trend().totals, estimatedSpendUsd: null } })), nowMs: NOW }));
  check("no AI pricing: Unavailable with reason and NO spend bars", /no AI pricing configured/.test(noPricing) && !/Estimated AI spend per UTC day/.test(noPricing));
  const plaidFailed = renderToStaticMarkup(createElement(EconomicsSurface, { plaid: failed, trend: ok(trend()), nowMs: NOW }));
  check("each authority keeps its own fetch state: Plaid alert beside a live AI figure", /role="alert"/.test(plaidFailed) && /\$0\.53/.test(plaidFailed));
}

console.log("\n5. activity feed view");
{
  check("result words + tones from the ledger vocabulary", resultWord("SUCCESS") === "succeeded" && resultTone("FAILURE") === "bad" && resultTone("REFUSED") === "warn" && resultWord(null) === "recorded" && resultTone(null) === "muted");
  check("UTC stamp is stable", utcStamp("2026-10-14T11:57:00.000Z") === "14 Oct, 11:57 UTC");
  check("relative text from nowMs", relativeText("2026-10-14T11:57:00.000Z", NOW) === "3 min ago" && relativeText("2026-10-13T09:00:00.000Z", NOW) === "1 d ago" && relativeText("2026-10-14T12:30:00.000Z", NOW) === "just now");
}

console.log("\n6. Recent operator activity surface");
{
  const html = renderToStaticMarkup(createElement(ActivityFeedSurface, { state: ok(feed()), nowMs: NOW, onOpenWorkspace: () => {}, onInspectExecution: () => {} }));
  check("one SectionSurface titled Recent operator activity, count pill 2", surfaces(html) === 1 && /Recent operator activity/.test(html) && />2</.test(html));
  check("rows: when (relative + UTC), operator, action, opaque target, result word", /3 min ago/.test(html) && /14 Oct, 11:57 UTC/.test(html) && /by chris/.test(html) && /user …123456/.test(html) && /succeeded/.test(html) && /failed/.test(html));
  check("reason code label shown, never a note", /support request/.test(html) && !/note/i.test(html.replace(/footnote/g, "")));
  check("tone dots are aria-hidden beside the result word", (html.match(/aria-hidden="true" class="rounded-full"/g) ?? []).length === 2);
  check("evidence: refresh execution opens the drawer; job run is an Open Jobs doorway", /Inspect refresh execution …def456/.test(html) && /Open Jobs for run …abc123/.test(html));
  check("depth stated and security events named as elsewhere", /Showing 2 of the last 20/.test(html) && /security events live in Security Operations/.test(html));
  check("no email, no id-shaped operator, no link", !/@/.test(html) && !/<a /.test(html) && /aria-label="Open Trends"/.test(html));
  const empty = renderToStaticMarkup(createElement(ActivityFeedSurface, { state: ok(feed({ items: [], depth: { requested: 20, returned: 0 } })), nowMs: NOW }));
  check("empty is the honest sentence, as a status", /No operator actions recorded on platform objects in the window/.test(empty) && /role="status"/.test(empty));
  const err = renderToStaticMarkup(createElement(ActivityFeedSurface, { state: failed, nowMs: NOW }));
  check("error is an alert", /role="alert"/.test(err));
}

console.log("\n6b. the AI usage trend widget (AI + Economics workspaces) renders the daily series as bars");
{
  const section = { id: "s", key: "ops_ai_trend", label: "AI Usage Trend" };
  const html = renderToStaticMarkup(createElement(AiTrendSurface, { section, data: trend(), nowMs: NOW }));
  check("one SectionSurface with the section label", surfaces(html) === 1 && /AI Usage Trend/.test(html));
  check("three BigStats: calls, tokens, estimated spend with the estimate caption", /52/.test(html) && /160\.0k/.test(html) && /\$0\.53/.test(html) && /estimate, not a bill/.test(html));
  check("calls bars with 28 gaps and spend bars present when priced", (html.match(/role="img"/g) ?? []).length === 2 && /28 without observation/.test(html) && /Estimated AI spend per UTC day/.test(html),
    `${(html.match(/role="img"/g) ?? []).length} imgs · ${(html.match(/aria-label="[^"]*"/g) ?? []).join(" | ")}`);
  check("no five-row tail of dates", !/<li/.test(html));
  const unpriced = renderToStaticMarkup(createElement(AiTrendSurface, { section, data: trend({ pricingConfigured: false, totals: { ...trend().totals, estimatedSpendUsd: null } }), nowMs: NOW }));
  check("unpriced: one chart (calls), spend Unavailable with reason", (unpriced.match(/role="img"/g) ?? []).length === 1 && /no AI pricing configured/.test(unpriced));
}

console.log("\n7. source: client boundary and the frame rule");
{
  const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of ["AiActivityBlock.tsx", "EconomicsBlock.tsx", "ActivityFeedBlock.tsx"]) {
    const s = strip(`components/platform/widgets/overview/${f}`);
    check(`${f}: use client, exactly one SectionSurface, no Link/router, no server module value import`,
      /^"use client"/.test(readFileSync(`components/platform/widgets/overview/${f}`, "utf8")) && (s.match(/<SectionSurface/g) ?? []).length === 1
        && !/next\/link|useRouter|customer-core|server-only/.test(s)
        && [...s.matchAll(/import (?!type)[^;]*from "@\/lib\/[^"]+"/g)].length === 0);
    check(`${f}: fetches only through the house hooks with static literals`, /use(Shared)?WidgetFetch<[^>]+>\("\/api\/platform\/platform-ops\/[^"]+"\)/.test(s) && !/fetch\(/.test(s.replace(/useWidgetFetch|useSharedWidgetFetch/g, "")));
    check(`${f}: no hex colour, no text-gray`, !/#[0-9a-f]{3,6}\b/i.test(s) && !/text-gray/.test(s));
  }
  const view = strip("components/platform/widgets/overview/ai-economics-view.ts");
  check("the view-model is pure (no React, no clock)", !/from "react"|Date\.now\(\)|new Date\(\)/.test(view));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
