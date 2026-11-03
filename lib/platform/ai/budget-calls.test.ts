/**
 * lib/platform/ai/budget-calls.test.ts  (AI & Costs — the 24 h budget KPI's records)
 *
 * The per-call drilldown's total IS the KPI: the loader reads the SAME grouped
 * query and the SAME fold the budget utilization read model does, over the
 * KPI's exact window, and every listed call is priced by the fold's own pricer
 * — so Σ priced rows = the KPI's estimate, returned rows = the KPI's calls,
 * unpriced rows = the KPI's unpriced count. Unpriced and failure rows are never
 * $0. The route is a PLATFORM_OPS READ gate. pct() with a zero denominator is
 * null. Injected readers; no database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/budget-calls.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildFleetWindow, loadAiBudgetUtilization, pct } from "./ai-budget";
import { loadBudgetCalls } from "./budget-calls";
import { BUDGET_CALLS_PAGE_SIZE, parseBudgetCallsQuery, priceCall, projectCall, type BudgetCallSource } from "./budget-calls-core";
import { fleetSpendStatus } from "./fleet-spend-status";
import { CUSTOMER_SURFACES } from "./spend-by-surface-core";
import { opaqueUserRef, type UserSpendGroup } from "./spend-health";
import type { CostControlsReadClient } from "./cost-controls";
import { CODE_CATALOGUE } from "@/lib/entitlements/policy-groups";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});

const NOW = new Date("2026-10-15T18:00:00.000Z");
const H = 60 * 60 * 1000;
const close = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 1e-9;

const controls = (rows: { key: string; value: string }[] = []): CostControlsReadClient => ({
  platformSetting: { findMany: async () => rows.map((r) => ({ ...r, updatedAt: NOW, updatedById: null })) },
  user: { findMany: async () => [] },
  jobRun: { findMany: async () => [] },
  customerPolicyAssignment: { findMany: async () => [], count: async () => 0 },
});

let seq = 0;
/**
 * One AiInvocation row. gpt-5.1 is on the rate card; gpt-99-x is not. cached ⊆
 * prompt on every row, as the ledger contract states (schema: "cached ⊆ prompt") —
 * the pricer's clamp is per group, so only a contradictory row could price
 * differently alone than inside its group.
 */
const call = (over: Partial<BudgetCallSource> & { at: number }): BudgetCallSource => ({
  id: `inv_${String(++seq).padStart(4, "0")}`,
  occurredAt: new Date(over.at),
  provider: "OPENAI", model: "gpt-5.1", surface: "chat", outcome: "RETURNED", errorCode: null,
  promptTokens: 12_000, cachedPromptTokens: 2_000, completionTokens: 900, userId: "usr_aaa111",
  ...over,
});

/** The fixture window: priced chat + brief across the UTC day boundary, unpriced, zero-token, failures, a harness row and rows outside the window. */
const ROWS: BudgetCallSource[] = [
  ...Array.from({ length: 30 }, (_, i) => call({ at: NOW.getTime() - (i + 1) * 20 * 60 * 1000, userId: i % 3 === 0 ? "usr_bbb222" : "usr_aaa111", surface: i % 4 === 0 ? "brief" : "chat", promptTokens: 1_000 * (i + 1), cachedPromptTokens: Math.min(2_000, 1_000 * (i + 1)), completionTokens: 100 * i })),
  call({ at: NOW.getTime() - 2 * H, model: "gpt-99-x" }),
  call({ at: NOW.getTime() - 3 * H, model: "gpt-99-x", surface: "brief", userId: "usr_ccc333" }),
  call({ at: NOW.getTime() - 4 * H, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }),
  call({ at: NOW.getTime() - 5 * H, outcome: "RATE_LIMITED", errorCode: "429", promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }),
  call({ at: NOW.getTime() - 6 * H, outcome: "TIMEOUT", errorCode: "abort", promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }),
  call({ at: NOW.getTime() - 23 * H, userId: null }),
  call({ at: NOW.getTime() - 1 * H, surface: "harness", userId: null, promptTokens: 9_000_000 }),
  call({ at: NOW.getTime() - 25 * H }),
  call({ at: NOW.getTime() + 1 * H }),
];

/** The fixture ledger seen through the window predicate the SQL applies: [since, until], customer surfaces. */
const inWindow = (since: Date, until: Date) => ROWS.filter((r) => r.occurredAt >= since && r.occurredAt <= until && (CUSTOMER_SURFACES as readonly string[]).includes(r.surface ?? ""));

/** readUserSpendGroups over the fixture: RETURNED rows grouped per (userId, provider, model, surface, UTC day). */
function groupsOver(since: Date, until: Date): UserSpendGroup[] {
  const m = new Map<string, UserSpendGroup>();
  for (const r of inWindow(since, until).filter((x) => x.outcome === "RETURNED")) {
    const day = r.occurredAt.toISOString().slice(0, 10);
    const k = [r.userId, r.provider, r.model, r.surface, day].join("|");
    const g = m.get(k) ?? { userId: r.userId, provider: r.provider, model: r.model, surface: r.surface, day, invocations: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };
    g.invocations += 1; g.promptTokens += r.promptTokens; g.cachedPromptTokens += r.cachedPromptTokens; g.completionTokens += r.completionTokens;
    m.set(k, g);
  }
  return [...m.values()];
}

const seen: string[] = [];
const deps = (ctl = controls([{ key: "ai_spend_alert_fleet_usd_24h", value: "10" }])) => ({
  controls: ctl,
  groups: async (since: Date, until: Date) => { seen.push(`groups ${since.toISOString()} ${until.toISOString()}`); return groupsOver(since, until); },
  list: async (since: Date, until: Date, skip: number, take: number) => {
    seen.push(`list ${since.toISOString()} ${until.toISOString()} ${skip} ${take}`);
    return inWindow(since, until).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : -1)).slice(skip, skip + take);
  },
  countByOutcome: async (since: Date, until: Date) => {
    seen.push(`count ${since.toISOString()} ${until.toISOString()}`);
    const by = new Map<string, number>();
    for (const r of inWindow(since, until)) by.set(r.outcome, (by.get(r.outcome) ?? 0) + 1);
    return [...by.entries()].map(([outcome, count]) => ({ outcome, count }));
  },
});

async function main() {
  console.log("1. pure — query, per-call pricing, projection");
  {
    const now = NOW.getTime();
    check("no until ⇒ now; no page ⇒ 1", (() => { const q = parseBudgetCallsQuery(new URLSearchParams(), now); return q.untilMs === now && q.page === 1; })());
    check("until as epoch ms and as ISO", parseBudgetCallsQuery(new URLSearchParams({ until: String(now - H) }), now).untilMs === now - H
      && parseBudgetCallsQuery(new URLSearchParams({ until: new Date(now - H).toISOString() }), now).untilMs === now - H);
    check("future / > 7 d old / garbage until ⇒ now (a stale link opens the current window)",
      parseBudgetCallsQuery(new URLSearchParams({ until: String(now + 10 * 60 * 1000) }), now).untilMs === now
        && parseBudgetCallsQuery(new URLSearchParams({ until: String(now - 8 * 24 * H) }), now).untilMs === now
        && parseBudgetCallsQuery(new URLSearchParams({ until: "yesterday" }), now).untilMs === now);
    check("bad pages ⇒ 1", ["0", "-2", "1.5", "x", "100000"].every((p) => parseBudgetCallsQuery(new URLSearchParams({ page: p }), now).page === 1));
    const priced = priceCall(call({ at: now }));
    check("a rate-card model is PRICED with a positive estimate", priced.pricing === "PRICED" && (priced.costUsd ?? 0) > 0);
    const unp = priceCall(call({ at: now, model: "gpt-99-x" }));
    check("an unknown model is UNPRICED with NO dollar figure (never $0)", unp.pricing === "UNPRICED" && unp.costUsd === null);
    const zero = priceCall(call({ at: now, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }));
    check("a zero-token return is NO_TOKENS, no dollar figure", zero.pricing === "NO_TOKENS" && zero.costUsd === null);
    const failed = priceCall(call({ at: now, outcome: "QUOTA", promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 }));
    check("a failure fact is NOT_COUNTED (the fold prices RETURNED only), no dollar figure", failed.pricing === "NOT_COUNTED" && failed.costUsd === null);
    const row = projectCall(call({ at: now, userId: "usr_secret_full_id_999999", outcome: "FAILED", errorCode: "500" }), opaqueUserRef);
    check("projection: opaque ref only (never the full id), error code kept on a failure", row.customerRef === "user …999999" && !JSON.stringify(row).includes("usr_secret") && row.errorCode === "500");
    check("projection: no user ⇒ null ref", projectCall(call({ at: now, userId: null }), opaqueUserRef).customerRef === null);
  }

  console.log("\n2. THE PIN — the drilldown total equals the KPI over the same window");
  {
    seen.length = 0;
    const kpi = await loadAiBudgetUtilization({ now: NOW, loadCatalogue: async () => CODE_CATALOGUE, groups: async (s, u) => groupsOver(s, u),
      controls: controls([{ key: "ai_spend_alert_fleet_usd_24h", value: "10" }]), assignments: { customerPolicyAssignment: { findMany: async () => [] } } });
    const kpiStatus = fleetSpendStatus(kpi);
    const untilMs = Date.parse(kpi.checkedAt);
    const pages = [];
    for (let page = 1; page <= 3; page++) pages.push(await loadBudgetCalls({ untilMs, page }, deps()));
    const d = pages[0];
    const s = d.summary;
    check("fixture is PARTIAL (priced + 2 unpriced) — the hard case", kpiStatus.status === "PARTIAL" && kpiStatus.unpricedInvocations === 2, kpiStatus.status);
    check("summary status = the KPI's status", s.status === kpiStatus.status);
    check("summary priced USD = the KPI's priced USD", close(s.pricedUsd, kpiStatus.pricedUsd), `${s.pricedUsd} vs ${kpiStatus.pricedUsd}`);
    check("summary utilisation = the KPI's utilisation", s.utilisationPct === kpiStatus.utilisationPct);
    check("summary calls / unpriced = the KPI's", s.invocations === kpiStatus.invocations && s.unpricedInvocations === kpiStatus.unpricedInvocations);
    const all = pages.flatMap((p) => p.page.rows);
    check(`paged list covers every call in the window once (${d.page.total})`, all.length === d.page.total && new Set(all.map((r) => r.id)).size === all.length);
    const pricedSum = all.filter((r) => r.pricing === "PRICED").reduce((a, r) => a + (r.costUsd ?? 0), 0);
    check("Σ PRICED rows = the KPI's estimate (same pricer, same rows)", close(pricedSum, kpiStatus.pricedUsd), `${pricedSum} vs ${kpiStatus.pricedUsd}`);
    check("returned rows = counts.returned = the KPI's customer calls", all.filter((r) => r.outcome === "RETURNED").length === d.counts.returned && d.counts.returned === kpi.fleet.invocations);
    check("UNPRICED rows = the KPI's unpriced count", all.filter((r) => r.pricing === "UNPRICED").length === kpiStatus.unpricedInvocations);
    check("failure facts are listed as NOT_COUNTED and are the notCounted figure", all.filter((r) => r.pricing === "NOT_COUNTED").length === d.counts.notCounted && d.counts.notCounted === 2);
    check("no unpriced / not-counted / no-token row carries a dollar figure", all.filter((r) => r.pricing !== "PRICED").every((r) => r.costUsd === null));
    check("harness traffic and rows outside the window are not listed", !all.some((r) => r.surface === "harness") && all.every((r) => Date.parse(r.occurredAt) <= untilMs && Date.parse(r.occurredAt) >= untilMs - 24 * H));
    const since = new Date(untilMs - 24 * H).toISOString(), until = new Date(untilMs).toISOString();
    check("every reader got the KPI's exact window [checkedAt − 24 h, checkedAt]", seen.every((x) => x.includes(`${since} ${until}`)) && seen.some((x) => x.startsWith("groups")) && seen.some((x) => x.startsWith("count")), seen[0]);
    check("window echoed, 24 h", d.window.since === since && d.window.until === until && d.window.hours === 24);
    check(`pages of ${BUDGET_CALLS_PAGE_SIZE}, newest first; page 2 skips one page`, d.page.pageSize === BUDGET_CALLS_PAGE_SIZE && seen.some((x) => x.endsWith(` ${BUDGET_CALLS_PAGE_SIZE} ${BUDGET_CALLS_PAGE_SIZE}`))
      && Date.parse(d.page.rows[0].occurredAt) >= Date.parse(d.page.rows[d.page.rows.length - 1].occurredAt));
    check("the estimate sentence travels with the page", /not provider billing/.test(d.estimateNote));
  }

  console.log("\n3. an empty window is UNAVAILABLE, never $0");
  {
    const d = await loadBudgetCalls({ untilMs: NOW.getTime() - 3 * 24 * H, page: 1 }, deps());
    check("no calls ⇒ UNAVAILABLE, no figure, total 0", d.summary.status === "UNAVAILABLE" && d.summary.pricedUsd === null && d.summary.utilisationPct === null && d.page.total === 0 && d.counts.returned === 0);
  }

  console.log("\n4. zero threshold — pct() is null on a zero denominator, never 0");
  {
    check("pct(n, 0) / pct(n, NaN) / pct(n, −1) ⇒ null; pct(5, 10) = 50", pct(5, 0) === null && pct(0, 0) === null && pct(5, Number.NaN) === null && pct(5, -1) === null && pct(5, 10) === 50);
    // The controls layer refuses a 0 setting (it falls back to the default), so a $0 threshold reaches the fold
    // only through a direct value — exercised here through the shared pure fold both readers use.
    const fw = buildFleetWindow(groupsOver(new Date(NOW.getTime() - 24 * H), NOW), { fleetUsd: 0, userUsd: 0 }, 24, NOW, true);
    check("buildFleetWindow at a $0 threshold: the figure stays, utilizationPct null (was 0)", fw.fleet.estimatedUsd !== null && fw.fleet.utilizationPct === null);
    const st = fleetSpendStatus({ fleet: fw.fleet, windowHours: 24, bySurface: fw.bySurface, unpriced: fw.unpriced });
    check("fleetSpendStatus at a $0 threshold: thresholdSet false, utilisation null, status kept", !st.thresholdSet && st.utilisationPct === null && st.status === "PARTIAL" && st.pricedUsd !== null);
    const unset = fleetSpendStatus({ fleet: { ...fw.fleet, thresholdUsd: undefined as unknown as number, utilizationPct: null }, windowHours: 24, bySurface: fw.bySurface, unpriced: fw.unpriced });
    check("an unset (missing) threshold is the same: no threshold", !unset.thresholdSet && unset.utilisationPct === null);
    const set = await loadBudgetCalls({ untilMs: NOW.getTime(), page: 1 }, deps());
    check("a set threshold keeps its utilisation", set.summary.thresholdSet && set.summary.utilisationPct !== null);
  }

  console.log("\n5. the route — PLATFORM_OPS READ, error first, read-only, never cached");
  {
    const src = readFileSync(path.join(process.cwd(), "app/api/platform/platform-ops/ai-budget/calls/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    check("requires PLATFORM_OPS READ", /requirePlatformAccess\(\s*["']PLATFORM_OPS["']\s*,\s*["']READ["']\s*\)/.test(src));
    check("returns the auth error before reading", src.indexOf("if (err) return err") > -1 && src.indexOf("if (err) return err") < src.indexOf("loadBudgetCalls(q)"));
    check("no WRITE, no mutating verb, no db import, no-store", !/["']WRITE["']/.test(src) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(src) && !/@\/lib\/db/.test(src) && /no-store/.test(src));
    const reader = readFileSync(path.join(process.cwd(), "lib/platform/ai/budget-calls.ts"), "utf8");
    check("the loader folds through the KPI's own functions (readUserSpendGroups → buildFleetWindow → fleetSpendStatus)",
      /readUserSpendGroups/.test(reader) && /buildFleetWindow\(/.test(reader) && /fleetSpendStatus\(/.test(reader));
    check("the list selects no prompt, conversation, correlation or request id", !/(conversationId|correlationId|providerRequestId|spaceId|subSurface)\s*:\s*true/.test(reader));
  }

  if (failures > 0) { console.error(`\nbudget-calls: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\nbudget-calls: all checks passed.");
}

void main();
