/**
 * lib/platform/ai/spend-by-surface.test.ts  (BETA C6 + C7)
 *
 * The spend-by-surface fold, the spend authority the alert engine reads, the
 * threshold resolution and the ai-spend route's gate. Standalone tsx, NO LIVE
 * DATABASE: pure folds over fixture groups; the readers run against injected
 * group loaders.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/spend-by-surface.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { AI_RATES, type AiRate } from "@/lib/usage/pricing";
import { buildAiSpendBySurface, isCustomerSurface, priceSpendGroup, type SpendGroup } from "./spend-by-surface-core";
import { getAiSpendOverview } from "./spend-by-surface";
import { buildAiSpendHealth, getAiSpendHealth, opaqueUserRef, type UserSpendGroup } from "./spend-health";
import { AI_SPEND_THRESHOLD_KEYS, loadAiSpendThresholds, resolveAiSpendThreshold } from "./spend-thresholds";
import { allowanceDimensionView, getCostSafeguards } from "./cost-safeguards";
import { readCustomerSpendGroupsToday, utcDayStart } from "./customer-spend-today";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-10-15T12:00:00.000Z");
const DAY = "2026-10-15";
/** 1,000,000 uncached prompt tokens on gpt-5.1 = $1.25; 1,000,000 completion = $10.00. */
const g = (over: Partial<SpendGroup>): SpendGroup => ({
  provider: "OPENAI", model: "gpt-5.1", surface: "chat", day: DAY, invocations: 1,
  promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 0, ...over,
});
const close = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;

async function main() {
  console.log("1. the fold: customer vs overhead vs unpriced");
  {
    check("chat and brief are customer surfaces; harness, null and anything else are not",
      isCustomerSurface("chat") && isCustomerSurface("brief") && !isCustomerSurface("harness") && !isCustomerSurface(null) && !isCustomerSurface("ops"));
    const s = buildAiSpendBySurface([
      g({ surface: "chat" }),                                   // $1.25
      g({ surface: "brief", completionTokens: 100_000, promptTokens: 0 }), // $1.00
      g({ surface: "harness", invocations: 7 }),                // $1.25 overhead
      g({ surface: null, invocations: 2 }),                     // $1.25 overhead (unattributed)
      g({ surface: "chat", model: "gpt-7-preview", invocations: 3 }), // unpriced
    ]);
    check("customer = chat + brief", close(s.customer.chat.usd, 1.25) && close(s.customer.brief.usd, 1.0) && close(s.customer.total.usd, 2.25));
    check("harness and unattributed are OVERHEAD, never customer", close(s.overhead.harness.usd, 1.25) && close(s.overhead.other.usd, 1.25) && close(s.overhead.total.usd, 2.5)
      && s.overhead.harness.invocations === 7 && s.overhead.other.invocations === 2);
    check("the unpriced group is COUNTED on its bucket and in the coverage statement, never priced at $0",
      s.customer.chat.unpricedInvocations === 3 && s.customer.chat.invocations === 4 && s.customer.chat.pricedInvocations === 1
      && s.unpriced.invocations === 3 && s.unpriced.tokens === 1_000_000 && s.unpriced.models.join() === "OPENAI:gpt-7-preview"
      && close(s.customer.chat.usd, 1.25));
    check("byDay splits customer from overhead and carries the unpriced count",
      s.byDay.length === 1 && close(s.byDay[0].customerUsd, 2.25) && close(s.byDay[0].overheadUsd, 2.5) && s.byDay[0].unpricedInvocations === 3);
    const empty = buildAiSpendBySurface([]);
    check("an empty window prices to null everywhere, not $0", empty.customer.total.usd === null && empty.overhead.total.usd === null && empty.unpriced.invocations === 0 && empty.byDay.length === 0);
    const onlyUnpriced = buildAiSpendBySurface([g({ model: "nope" })]);
    check("a window where nothing could be priced: usd null, unpriced counted", onlyUnpriced.customer.total.usd === null && onlyUnpriced.unpriced.invocations === 1);
    check("a zero-token group is neither priced nor unpriced", !priceSpendGroup(g({ promptTokens: 0, completionTokens: 0 })).unpriced);
    // Subset arithmetic is inherited from the one reducer: cached tokens are a SUBSET of prompt tokens.
    const cached = buildAiSpendBySurface([g({ promptTokens: 1_000_000, cachedPromptTokens: 1_000_000 })]);
    check("fully cached prompt prices at the cached rate ($0.125), never input + cached", close(cached.customer.chat.usd, 0.125));
    // Effective dating: usage before the rate's evidence is unpriced, not $0.
    const early = buildAiSpendBySurface([g({ day: "2026-09-01" })]);
    check("usage before the rate's effectiveFrom is unpriced (coverage), not priced at $0", early.customer.total.usd === null && early.unpriced.invocations === 1);
    // Injected rates: the fold holds no price of its own.
    const rates: AiRate[] = [{ provider: "OPENAI", model: "gpt-5.1", effectiveFrom: "2026-01-01", source: "t", usdPerMillion: { input: 2, cachedInput: 1, output: 4 } }];
    check("every dollar comes from the injected rate card", close(buildAiSpendBySurface([g({})], rates).customer.chat.usd, 2));
  }

  console.log("\n2. the overview reader (injected groups)");
  {
    const seen: { since: Date; until: Date }[] = [];
    const o = await getAiSpendOverview({ now: NOW, days: 30, groups: async (since, until) => { seen.push({ since, until }); return [g({}), g({ surface: "harness" })]; } });
    check("window = last 30 UTC days, today included", o.window.days === 30 && o.window.from === "2026-09-16" && o.window.to === DAY && seen.length === 1 && seen[0].since.toISOString() === "2026-09-16T00:00:00.000Z" && seen[0].until === NOW);
    check("customer and overhead carried, pricing flagged, the estimate sentence present", close(o.customer.total.usd, 1.25) && close(o.overhead.total.usd, 1.25) && o.pricingConfigured === AI_RATES.length > 0 && /Not a bill/.test(o.estimateNote));
    const src = strip("lib/platform/ai/spend-by-surface.ts");
    check("the reader groups RETURNED rows only and selects no user, Space or conversation column",
      /"outcome" = 'RETURNED'/.test(src) && !/userId|spaceId|conversationId|email/.test(src));
    check("the reader runs on fm_system", /import \{ systemDb \} from "@\/lib\/db"/.test(src) && !/\bdb\./.test(src.replace(/systemDb\./g, "")));
  }

  console.log("\n3. the spend authority (fleet + max per customer + unpriced)");
  {
    const u = (over: Partial<UserSpendGroup>): UserSpendGroup => ({ ...g({}), userId: "user_000000alpha1", ...over });
    const th = { fleetUsd: 10, userUsd: 3 };
    const h = buildAiSpendHealth([
      u({ userId: "user_000000alpha1" }),                                  // $1.25
      u({ userId: "user_000000alpha1", surface: "brief", completionTokens: 100_000, promptTokens: 0 }), // $1.00 ⇒ alpha1 $2.25
      u({ userId: "user_000000beta22", invocations: 4, promptTokens: 4_000_000 }), // $5.00
      u({ userId: null }),                                                 // $1.25 fleet only
      u({ userId: "user_000000beta22", model: "gpt-7-preview", invocations: 2 }), // unpriced
    ], th, 24, NOW);
    check("fleet USD sums every priced customer-surface group, attributed or not", close(h.fleetUsd, 8.5));
    check("max per customer is the largest priced per-user sum, as an OPAQUE ref", close(h.maxUserUsd, 5) && h.maxUserRef === "user …beta22" && !/user_000000/.test(JSON.stringify(h)));
    check("customers counted distinct; invocations include the unpriced", h.customers === 2 && h.customerInvocations === 9);
    check("how many customers are at or over the per-customer threshold ($3): beta22 only", h.customersAtOrOverThreshold === 1);
    check("…and when two are, both are counted (the rule names the largest, this says it is not alone)",
      buildAiSpendHealth([u({ userId: "user_000000alpha1", invocations: 3, promptTokens: 3_000_000 }), u({ userId: "user_000000beta22", invocations: 4, promptTokens: 4_000_000 })], th, 24, NOW).customersAtOrOverThreshold === 2);
    check("unpriced invocations counted with their models, never in a dollar", h.unpricedInvocations === 2 && h.unpricedModels.join() === "OPENAI:gpt-7-preview");
    check("thresholds and window carried for the engine", h.thresholds.fleetUsd === 10 && h.thresholds.userUsd === 3 && h.windowHours === 24 && h.checkedAt === NOW.toISOString());
    const quiet = buildAiSpendHealth([], th, 24, NOW);
    check("an empty window is null spend, not $0", quiet.fleetUsd === null && quiet.maxUserUsd === null && quiet.maxUserRef === null && quiet.customersAtOrOverThreshold === 0);
    check("the opaque ref is the last six characters", opaqueUserRef("cmabc123xyz789") === "user …xyz789");

    const got = await getAiSpendHealth(24, {
      now: NOW,
      groups: async (since) => { check("the authority window is the trailing 24h", since.toISOString() === "2026-10-14T12:00:00.000Z"); return [u({})]; },
      thresholds: async () => ({
        fleet: { key: AI_SPEND_THRESHOLD_KEYS.fleet, label: "f", usd: 7, defaultUsd: 10, origin: "SETTING", updatedAt: null },
        user: { key: AI_SPEND_THRESHOLD_KEYS.user, label: "u", usd: 2, defaultUsd: 3, origin: "DEFAULT", updatedAt: null },
      }),
    });
    check("the read carries the resolved thresholds", got.thresholds.fleetUsd === 7 && got.thresholds.userUsd === 2 && close(got.fleetUsd, 1.25));
    const src = strip("lib/platform/ai/spend-health.ts");
    check("the authority reads customer surfaces only, RETURNED only, on fm_system",
      /"surface" IN \(/.test(src) && /"outcome" = 'RETURNED'/.test(src) && /import \{ systemDb \} from "@\/lib\/db"/.test(src));
    check("the authority never selects an email or name", !/email|\bname\b|username/.test(src));
  }

  console.log("\n4. the thresholds resolve through the descriptors");
  {
    const at = new Date("2026-10-14T09:00:00.000Z");
    const d = resolveAiSpendThreshold(AI_SPEND_THRESHOLD_KEYS.fleet, null);
    check("no row ⇒ the descriptor default ($10), origin DEFAULT", d.usd === 10 && d.defaultUsd === 10 && d.origin === "DEFAULT" && d.updatedAt === null);
    const s = resolveAiSpendThreshold(AI_SPEND_THRESHOLD_KEYS.user, { value: "5", updatedAt: at });
    check("a valid row ⇒ its value, origin SETTING, version carried", s.usd === 5 && s.defaultUsd === 3 && s.origin === "SETTING" && s.updatedAt === at.toISOString());
    const bad = resolveAiSpendThreshold(AI_SPEND_THRESHOLD_KEYS.user, { value: "lots", updatedAt: at });
    check("an unreadable row ⇒ the default in force, origin INVALID_SETTING (never 'no threshold')", bad.usd === 3 && bad.origin === "INVALID_SETTING");
    const zero = resolveAiSpendThreshold(AI_SPEND_THRESHOLD_KEYS.fleet, { value: "0", updatedAt: at });
    check("a value below the descriptor's minimum is invalid, so the default stands", zero.usd === 10 && zero.origin === "INVALID_SETTING");
    const loaded = await loadAiSpendThresholds({ platformSetting: { findMany: async () => [{ key: AI_SPEND_THRESHOLD_KEYS.fleet, value: "25", updatedAt: at }] } });
    check("the loader resolves both keys from one read", loaded.fleet.usd === 25 && loaded.fleet.origin === "SETTING" && loaded.user.usd === 3 && loaded.user.origin === "DEFAULT");
    check("the loader's labels come from the descriptors", /fleet/.test(loaded.fleet.label) && /per customer/.test(loaded.user.label));
  }

  console.log("\n5. the safeguards view");
  {
    const a = allowanceDimensionView();
    check("the allowance dimension: BETA $5, FOUNDER $20, ceiling $20", a.policy.usd === 5 && a.overlay.usd === 20 && a.ceilingUsd === 20 && a.key === "aiDailyUsdAllowance");
    const c = await getCostSafeguards({ now: NOW, thresholds: async () => ({
      fleet: { key: AI_SPEND_THRESHOLD_KEYS.fleet, label: "f", usd: 10, defaultUsd: 10, origin: "DEFAULT", updatedAt: null },
      user: { key: AI_SPEND_THRESHOLD_KEYS.user, label: "u", usd: 3, defaultUsd: 3, origin: "DEFAULT", updatedAt: null },
    }) });
    check("names the rule and the write path, never a control", c.alertRuleId === "ai-spend-high" && /admin settings/.test(c.thresholdWritePath));
  }

  console.log("\n6. the allowance's ledger read — ONE customer, today (BETA C7)");
  {
    const seen: unknown[] = [];
    const client = { aiInvocation: { groupBy: async (args: unknown) => { seen.push(args); return [{ provider: "OPENAI", model: "gpt-5.1", _count: { _all: 2 }, _sum: { promptTokens: 10, cachedPromptTokens: null, completionTokens: 3 } }]; } } };
    const groups = await readCustomerSpendGroupsToday("usr_7", NOW, client as never);
    check("groups by (provider, model); null sums read as 0", groups.length === 1 && groups[0].invocations === 2 && groups[0].promptTokens === 10 && groups[0].cachedPromptTokens === 0 && groups[0].completionTokens === 3);
    const w = (seen[0] as { where: { userId: string; outcome: string; surface: { in: string[] }; occurredAt: { gte: Date } } }).where;
    check("the predicate is the GIVEN userId, RETURNED, customer surfaces, since midnight UTC — nothing wider", w.userId === "usr_7" && w.outcome === "RETURNED" && w.surface.in.join() === "chat,brief" && w.occurredAt.gte.toISOString() === "2026-10-15T00:00:00.000Z");
    check("utcDayStart is midnight UTC of the instant", utcDayStart(new Date("2026-10-15T23:59:59.000Z")).toISOString() === "2026-10-15T00:00:00.000Z");
    const src = strip("lib/platform/ai/customer-spend-today.ts");
    check("the reader runs on fm_system and selects no email, Space, conversation or content column", /import \{ systemDb \} from "@\/lib\/db"/.test(src) && !/email|spaceId|conversationId|content/.test(src));
  }

  console.log("\n7. the ai-spend route");
  {
    const src = strip("app/api/platform/platform-ops/ai-spend/route.ts");
    check("requires PLATFORM_OPS READ and returns the error first", /requirePlatformAccess\(\s*"PLATFORM_OPS",\s*"READ"\s*\)/.test(src) && /if \(err\) return err/.test(src));
    check("never WRITE, no mutating verb, no db import, no process.env", !/"WRITE"/.test(src) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(src) && !/@\/lib\/db/.test(src) && !/process\.env/.test(src));
    check("never cached", /no-store/.test(src));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
void main();
