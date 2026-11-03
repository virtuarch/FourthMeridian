/**
 * lib/platform/economics/snapshot.test.ts  (Platform Economics — PR A: the Overview reader)
 *
 * Pins the EconomicsSnapshot contract:
 *   1. every status path — MEASURED (counts), ESTIMATED, PARTIAL (lower bound,
 *      missing parts named), UNAVAILABLE (null with its reason);
 *   2. missing telemetry is NEVER $0 — no ledger rows, no rate card, an unpriced
 *      model, an unpriced Plaid cycle, unmetered infrastructure;
 *   3. revenue and margin are ALWAYS UNAVAILABLE ("no billing source"), with no
 *      drill, under every fixture;
 *   4. every KPI total equals its drill list (Σ rows; a count = its row count),
 *      for every drillable figure × window, through the SAME reader;
 *   5. the reader: one read at the window end, PB-10 engagement (never sessions),
 *      opaque references only (no user id in the output), gated routes.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/economics/snapshot.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import type { PlaidItemFact, PlaidItemTransition } from "@/lib/platform/plaid/item-months";
import { PLAID_RATES } from "@/lib/usage/pricing";
import {
  DRILLABLE, ECONOMICS_FIGURES, REASON_INFRA_NOT_METERED, REASON_NO_AI_CALLS,
  REASON_NO_AI_RATE_CARD, REASON_NO_BILLING, REASON_NO_ENGAGED, REASON_NO_PLAID_RATE, TREND_WINDOWS,
  buildEconomicsDrill, buildEconomicsSnapshot, cycleOf, parseEconomicsDrillQuery, readSince, windowRange,
  type EconomicsFigureKey, type EconomicsInputs, type EconomicsSnapshot, type EconomicsWindow,
} from "@/lib/platform/economics/snapshot-core";
import { getEconomicsDrill, getEconomicsSnapshot, loadEconomicsInputs, type EconomicsDeps } from "@/lib/platform/economics/snapshot";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Synthetic fixtures (no real figures) ────────────────────────────────────────

const NOW = Date.parse("2026-11-03T12:00:00Z");
const grp = (day: string, surface: string | null, o: Partial<SpendGroup> = {}): SpendGroup => ({
  provider: "OPENAI", model: "gpt-5-mini", surface, day, invocations: 2,
  // 1M prompt × $0.25/M + 0.5M completion × $2/M = $1.25 per group (gpt-5-mini).
  promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 500_000, ...o,
});
const GROUPS_PRICED: SpendGroup[] = [
  grp("2026-11-01", "chat"), grp("2026-11-02", "brief"), grp("2026-11-03", "harness"),
  grp("2026-10-20", "chat"), grp("2026-09-10", "chat"),
];
const GROUPS_UNPRICED_PART: SpendGroup[] = [...GROUPS_PRICED, grp("2026-11-02", "chat", { model: "not-a-rated-model" })];
const GROUPS_ALL_UNPRICED: SpendGroup[] = [grp("2026-11-02", "chat", { model: "not-a-rated-model" })];

const item = (id: string, o: Partial<PlaidItemFact> = {}): PlaidItemFact => ({
  id, externalItemId: `ext_${id}`, createdAt: "2026-08-01T00:00:00Z", status: "ACTIVE",
  investmentsConsent: null, environment: "production", plaidEnvironment: "production", ...o,
});
const ITEMS: PlaidItemFact[] = [item("p1"), item("p2", { investmentsConsent: "ENABLED" }), item("p3"), item("sbx", { plaidEnvironment: "sandbox" })];
// Retirement evidence from before the cycle (so the census is complete): p3 revoked in August.
const TRANSITIONS: PlaidItemTransition[] = [{ plaidItemId: "p3", at: "2026-08-15T00:00:00Z", from: "ACTIVE", to: "REVOKED" }];

const USER_IDS = ["cuid_user_aaaaaaaaaaaa", "cuid_user_bbbbbbbbbbbb", "cuid_user_cccccccccccc"];

function deps(o: Partial<EconomicsDeps> & { groupsList?: SpendGroup[]; items?: PlaidItemFact[]; transitions?: PlaidItemTransition[]; users?: string[] } = {}): EconomicsDeps & { calls: { groups: [Date, Date][]; engaged: Date[] } } {
  const calls = { groups: [] as [Date, Date][], engaged: [] as Date[] };
  return {
    calls,
    groups: async (since, until) => { calls.groups.push([since, until]); return o.groupsList ?? GROUPS_PRICED; },
    plaidReaders: { items: async () => o.items ?? ITEMS, transitions: async () => o.transitions ?? TRANSITIONS },
    engagedSince: async (since) => { calls.engaged.push(since); return new Set(o.users ?? USER_IDS); },
    aiPricingConfigured: o.aiPricingConfigured ?? true,
    plaidRates: o.plaidRates ?? PLAID_RATES,
    ref: (id) => `user #${id.slice(-4)}x`,
  };
}

async function inputsOf(o: Parameters<typeof deps>[0] = {}): Promise<EconomicsInputs> {
  return loadEconomicsInputs(NOW, deps(o));
}

const near = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);

async function main() {
  // ── 0. Calendar ──────────────────────────────────────────────────────────────
  console.log("0. windows");
  check("cycle = the calendar month", JSON.stringify(cycleOf(NOW)) === JSON.stringify({ start: "2026-11-01", end: "2026-11-30" }));
  check("7 d / 30 d / 90 d end today, inclusive", windowRange("7d", NOW).from === "2026-10-28" && windowRange("30d", NOW).from === "2026-10-05"
    && windowRange("90d", NOW).from === "2026-08-06" && windowRange("90d", NOW).to === "2026-11-03");
  check("the reader reads from the earliest window start", readSince(NOW).toISOString() === "2026-08-06T00:00:00.000Z");

  // ── 1. Status paths ──────────────────────────────────────────────────────────
  console.log("1. status paths");
  const base = buildEconomicsSnapshot(await inputsOf());
  const F = base.figures;
  // AI this cycle: Nov 1 (chat) + Nov 2 (brief) + Nov 3 (harness) = 3 × $1.25.
  check("AI this cycle: ESTIMATED, every surface, Σ priced days", F.ai_cost.status === "ESTIMATED" && near(F.ai_cost.value, 3.75), `${F.ai_cost.status} ${F.ai_cost.value}`);
  // Plaid Nov: p1 + p2 Transactions (2 × $0.30) + p2 Investments ($0.35); p3 revoked, sandbox excluded.
  check("Plaid this cycle: Item-months × rate, sandbox + revoked excluded — PARTIAL (other providers not metered)",
    F.provider_cost.status === "PARTIAL" && near(F.provider_cost.value, 0.95) && F.provider_cost.coverage.missing.some((m) => /not metered/.test(m)), `${F.provider_cost.status} ${F.provider_cost.value} ${F.provider_cost.coverage.missing}`);
  check("operating cost: AI + Plaid, PARTIAL (lower bound) — infrastructure and other providers named as missing",
    F.operating_cost.status === "PARTIAL" && near(F.operating_cost.value, 4.7)
      && F.operating_cost.coverage.missing.some((m) => m.includes(REASON_INFRA_NOT_METERED)) && /lower bound/.test(F.operating_cost.reason ?? ""), `${F.operating_cost.value} ${F.operating_cost.reason}`);
  check("infrastructure: UNAVAILABLE (not metered), null, no drill", F.infra_cost.status === "UNAVAILABLE" && F.infra_cost.value === null && F.infra_cost.reason === REASON_INFRA_NOT_METERED && F.infra_cost.drill === null);
  check("active customers: MEASURED count of PB-10-engaged customers", F.active_customers.status === "MEASURED" && F.active_customers.value === 3 && F.active_customers.unit === "count");
  check("cost per active customer: operating cost ÷ engaged, PARTIAL like its numerator", F.cost_per_active_customer.status === "PARTIAL" && near(F.cost_per_active_customer.value, 4.7 / 3), `${F.cost_per_active_customer.value}`);
  check("trend windows: 7 d ESTIMATED; 30 d includes Oct 20; 90 d includes Sep 10",
    base.trend.windows["7d"].status === "ESTIMATED" && near(base.trend.windows["7d"].value, 3.75) && near(base.trend.windows["30d"].value, 5) && near(base.trend.windows["90d"].value, 6.25),
    TREND_WINDOWS.map((w) => base.trend.windows[w].value).join());
  check("every figure carries coverage, freshness (asOf + window) and a basis",
    ECONOMICS_FIGURES.every((k) => F[k].freshness.asOf === base.checkedAt && F[k].freshness.from <= F[k].freshness.to && F[k].basis.length > 0 && Array.isArray(F[k].coverage.missing)));
  check("MEASURED is never a dollar figure (no invoice is read)", ECONOMICS_FIGURES.every((k) => F[k].status !== "MEASURED" || F[k].unit === "count"));
  check("PARTIAL ⇔ a non-empty 'missing' with a value; UNAVAILABLE ⇔ null",
    ECONOMICS_FIGURES.every((k) => (F[k].status === "PARTIAL" ? F[k].value !== null && F[k].coverage.missing.length > 0 : true) && (F[k].status === "UNAVAILABLE") === (F[k].value === null)));

  const partAi = buildEconomicsSnapshot(await inputsOf({ groupsList: GROUPS_UNPRICED_PART }));
  check("an unpriced model this cycle ⇒ AI PARTIAL; the unpriced day is named, its calls never folded in at $0",
    partAi.figures.ai_cost.status === "PARTIAL" && near(partAi.figures.ai_cost.value, 3.75) && partAi.figures.ai_cost.coverage.missing.some((m) => /unpriced/.test(m)), `${partAi.figures.ai_cost.status} ${partAi.figures.ai_cost.coverage.missing}`);

  // ── 2. Never $0 for missing data ───────────────────────────────────────────
  console.log("2. missing telemetry is never $0");
  const empty = buildEconomicsSnapshot(await inputsOf({ groupsList: [], items: [], transitions: [], users: [] }));
  check("no ledger rows ⇒ AI UNAVAILABLE (null), never $0", empty.figures.ai_cost.value === null && empty.figures.ai_cost.status === "UNAVAILABLE" && empty.figures.ai_cost.reason === REASON_NO_AI_CALLS, `${empty.figures.ai_cost.value} ${empty.figures.ai_cost.reason}`);
  check("…and every trend window is null; every day is a GAP (observed false, total null)",
    TREND_WINDOWS.every((w) => empty.trend.windows[w].value === null) && empty.trend.days.length === 90 && empty.trend.days.every((d) => !d.observed && d.totalUsd === null));
  check("no Items ⇒ providers UNAVAILABLE, operating cost UNAVAILABLE (nothing priced), never $0",
    empty.figures.provider_cost.value === null && empty.figures.operating_cost.value === null && empty.figures.operating_cost.status === "UNAVAILABLE");
  check("no engaged customer ⇒ active customers is a measured 0; cost per customer UNAVAILABLE (never ÷ 0, never $0)",
    empty.figures.active_customers.value === 0 && empty.figures.active_customers.status === "MEASURED"
      && empty.figures.cost_per_active_customer.value === null && empty.figures.cost_per_active_customer.reason === REASON_NO_ENGAGED);
  const noRate = buildEconomicsSnapshot(await inputsOf({ aiPricingConfigured: false }));
  check("no AI rate card ⇒ AI UNAVAILABLE with its reason and NO drill; operating cost keeps Plaid as a lower bound",
    noRate.figures.ai_cost.value === null && noRate.figures.ai_cost.reason === REASON_NO_AI_RATE_CARD && noRate.figures.ai_cost.drill === null
      && noRate.figures.operating_cost.status === "PARTIAL" && near(noRate.figures.operating_cost.value, 0.95));
  const allUnpriced = buildEconomicsSnapshot(await inputsOf({ groupsList: GROUPS_ALL_UNPRICED }));
  check("only unpriced calls ⇒ AI UNAVAILABLE ('none priced'), the day is observed but its total is null",
    allUnpriced.figures.ai_cost.value === null && allUnpriced.figures.ai_cost.reason !== null
      && allUnpriced.trend.days.find((d) => d.day === "2026-11-02")?.observed === true && allUnpriced.trend.days.find((d) => d.day === "2026-11-02")?.totalUsd === null,
    `${allUnpriced.figures.ai_cost.reason}`);
  check("…the reason says why (an unpriced invocation, not 'no calls')", allUnpriced.figures.ai_cost.reason !== REASON_NO_AI_CALLS && /unpriced/.test(allUnpriced.figures.ai_cost.reason ?? ""), allUnpriced.figures.ai_cost.reason ?? "");
  const noPlaidRate = buildEconomicsSnapshot(await inputsOf({ plaidRates: [] }));
  check("no Plaid rate ⇒ each product row is null (Item-months counted), providers UNAVAILABLE, never $0",
    noPlaidRate.figures.provider_cost.value === null && noPlaidRate.figures.provider_cost.status === "UNAVAILABLE" && REASON_NO_PLAID_RATE.length > 0);
  const noRateDrill = buildEconomicsDrill(await inputsOf({ plaidRates: [] }), "provider_cost", "cycle");
  check("…and its drill rows carry the Item-months with a null value", noRateDrill.rows.some((r) => r.value === null && /Item-month/.test(r.detail)) && noRateDrill.total === null);
  check("no UNAVAILABLE figure anywhere carries a value", [empty, noRate, allUnpriced, noPlaidRate].every((s) => Object.values(s.figures).every((f) => f.status !== "UNAVAILABLE" || f.value === null)));

  // ── 3. Revenue and margin ──────────────────────────────────────────────────
  console.log("3. revenue and margin are always UNAVAILABLE");
  for (const [name, s] of [["base", base], ["empty", empty], ["no rate", noRate], ["partial", partAi]] as [string, EconomicsSnapshot][]) {
    for (const k of ["revenue", "margin"] as const) {
      const f = s.figures[k];
      check(`${name}: ${k} UNAVAILABLE · "${REASON_NO_BILLING}" · null · no drill`, f.status === "UNAVAILABLE" && f.value === null && f.reason === REASON_NO_BILLING && f.drill === null);
    }
  }
  check("revenue and margin have no records endpoint", parseEconomicsDrillQuery(new URLSearchParams({ figure: "revenue" }), NOW) === null && parseEconomicsDrillQuery(new URLSearchParams({ figure: "margin" }), NOW) === null);
  const core = readFileSync(path.join(process.cwd(), "lib/platform/economics/snapshot-core.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("source: no revenue / margin / profit / CAC is ever computed (no arithmetic names them)", !/\b(revenueUsd|marginUsd|profit|cac)\b/i.test(core));

  // ── 4. KPI total = its drill list ──────────────────────────────────────────
  console.log("4. every KPI total equals its drill list");
  for (const [name, o] of [["base", {}], ["partial AI", { groupsList: GROUPS_UNPRICED_PART }], ["empty", { groupsList: [], items: [], transitions: [], users: [] }], ["no AI rate", { aiPricingConfigured: false }], ["no Plaid rate", { plaidRates: [] }]] as [string, Parameters<typeof deps>[0]][]) {
    const inputs = await inputsOf(o);
    const snap = buildEconomicsSnapshot(inputs);
    for (const key of Object.keys(DRILLABLE) as EconomicsFigureKey[]) {
      for (const w of DRILLABLE[key]!) {
        const d = buildEconomicsDrill(inputs, key, w);
        const kpi = w === "cycle" ? snap.figures[key] : snap.trend.windows[w as "7d"];
        const kpiValue = key === "ai_cost" && w !== "cycle" ? snap.trend.windows[w as "7d"].value : kpi.value;
        check(`${name}: ${key}.${w} — drill total ${d.total} = KPI ${kpiValue}; same status`, near(d.total, kpiValue) && d.figure.status === kpi.status && near(d.figure.value, kpiValue));
        if (kpi.drill) {
          const q = parseEconomicsDrillQuery(new URL(kpi.drill.href, "http://x").searchParams, NOW + 60_000);
          check(`${name}: ${key}.${w} — its href parses back to the same figure, window and window END`, q !== null && q.figure === key && q.window === w && q.untilMs === NOW);
        }
      }
    }
  }
  check("every drillable figure with a value has a drill ref; the non-drillable never do",
    ECONOMICS_FIGURES.every((k) => (DRILLABLE[k] ? true : base.figures[k].drill === null)) && base.figures.operating_cost.drill !== null && base.figures.ai_cost.drill !== null);
  check("parse: unknown figure / window refused; a window the figure lacks refused; until clamped to now",
    parseEconomicsDrillQuery(new URLSearchParams({ figure: "nope" }), NOW) === null
      && parseEconomicsDrillQuery(new URLSearchParams({ figure: "operating_cost", window: "30d" }), NOW) === null
      && parseEconomicsDrillQuery(new URLSearchParams({ figure: "ai_cost", window: "30d", until: String(NOW + 1) }), NOW)?.untilMs === NOW
      && parseEconomicsDrillQuery(new URLSearchParams({ figure: "ai_cost", window: "bogus" as EconomicsWindow }), NOW) === null);

  // ── 5. The reader ──────────────────────────────────────────────────────────
  console.log("5. the reader");
  const d1 = deps();
  const snap = await getEconomicsSnapshot(NOW, d1);
  check("one grouped AI read, [earliest window start, now]", d1.calls.groups.length === 1 && d1.calls.groups[0][0].toISOString() === "2026-08-06T00:00:00.000Z" && d1.calls.groups[0][1].getTime() === NOW);
  check("engagement read since the cycle start (PB-10 loader)", d1.calls.engaged.length === 1 && d1.calls.engaged[0].toISOString() === "2026-11-01T00:00:00.000Z");
  const out = JSON.stringify(snap);
  check("no user id leaves the reader (opaque refs only)", USER_IDS.every((id) => !out.includes(id)));
  const d2 = deps();
  const drill = await getEconomicsDrill({ figure: "active_customers", window: "cycle", untilMs: NOW - 3_600_000 }, d2);
  check("the drill reads at the KPI's window END (until), not now", d2.calls.groups[0][1].getTime() === NOW - 3_600_000);
  check("active-customer records are the opaque refs, one per engaged id; total = the count",
    drill.rows.length === 3 && drill.total === 3 && drill.rows.every((r) => r.label.startsWith("user #")) && USER_IDS.every((id) => !JSON.stringify(drill).includes(id)));

  const src = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
  const reader = src("lib/platform/economics/snapshot.ts");
  check("reader reuses the existing readers (spend groups, Plaid census, PB-10 engagement, opaque refs)",
    /readSpendGroups/.test(reader) && /buildPlaidUsage/.test(reader) && /loadEngagedUserIdsSince/.test(reader) && /opaqueUserRef/.test(reader));
  check("reader never counts sessions or presence", !/userSession|lastActiveAt|SESSION_ACTIVE_DAY|presence/i.test(reader.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
  check("reader writes nothing", !/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|\$executeRaw/.test(reader));
  for (const r of ["app/api/platform/platform-ops/economics/route.ts", "app/api/platform/platform-ops/economics/drill/route.ts"]) {
    const t = src(r);
    check(`${r}: PLATFORM_OPS READ gate, no-store, GET only`, /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(t) && /no-store/.test(t) && !/export async function (POST|PUT|PATCH|DELETE)/.test(t));
  }

  if (failures > 0) { console.error(`\neconomics snapshot: ${failures} failure(s).`); process.exit(1); }
  console.log("\neconomics snapshot: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
