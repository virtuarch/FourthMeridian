/**
 * lib/platform/ai/platform-ai-usage-today.test.ts  (PLATFORM AI COST MANAGEMENT — today's usage)
 *
 *   1. the fold: priced exactly like the reservation (sumTodaySpend), failures counted not priced,
 *      a turn = a distinct correlationId of any outcome, unpriced counted never $0;
 *   2. by model / by feature: labels, order; the feature codes equal the ledger's;
 *   3. budget ⇔ reservation: EXHAUSTED exactly when platformAiSpendDecision refuses COST_CAP (grid);
 *   4. FAIL CLOSED: CAP_MISSING / CAP_INVALID / UNPRICED / LEDGER_UNTRUSTED ⇒ REFUSING, no headroom figure;
 *   5. one operator: own cap / platform cap / daily turn cap — the worst wins, named;
 *   6. CONCURRENCY: simultaneous reservations through reservePlatformAiSpend are seen as in-flight,
 *      the page's EXHAUSTED agrees with the next reservation's verdict, releases return the room;
 *   7. the loader: Production with no caps refuses; invalid setting / override refuse; overrides read
 *      only for the operators asked about; a read error degrades to null;
 *   8. AUTHORIZATION: the PLATFORM_OPS READ projection carries no other operator's id or figures;
 *      the per-operator views travel only on the SYSTEM_ADMIN route;
 *   9. the wording + the card: ESTIMATED everywhere, no write affordance, a refusing budget shows no "$ left".
 * No database, no provider, no env file.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/platform-ai-usage-today.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sumTodaySpend } from "@/lib/ai/allowance-core";
import { PLATFORM_AI_DAILY_TURNS, PLATFORM_AI_SUB_SURFACE } from "@/lib/platform/intelligence/ai/core";
import { PLATFORM_AI_CONVERSATION_SUB_SURFACE } from "@/lib/platform/intelligence/ai/ledger";
import { PLATFORM_AI_CAP_SETTING_KEYS, platformAiReserveUsd, platformAiSpendDecision, type CapInputs } from "./platform-ai-spend.core";
import { reservePlatformAiSpend, type SpendClient, type SpendTxClient } from "./platform-ai-spend";
import { LEDGER_FAILURE_KEY } from "./ledger-health";
import {
  PLATFORM_AI_CAPS_PAGE_HREF, PLATFORM_AI_FEATURE_LABELS, UNLABELLED_FEATURE, byFeature, platformAiManageLimitsHref, byModel, foldPlatformAiUsage, platformAiBudget, platformAiOperatorUsage,
  spendGroupsOf, type PlatformAiUsageFigure, type PlatformAiUsageRow,
} from "./platform-ai-usage-today.core";
import { loadPlatformAiFleetUsageToday, loadPlatformAiUsageToday, withPlatformAiUsageToday, type UsageTodayReadClient } from "./platform-ai-usage-today";
import type { PlatformAiCapsReadModel } from "./platform-ai-caps-admin";
import { MANAGE_LIMITS_LABEL, estUsd, operatorTodayLine, remainingLine, spentLine } from "@/components/platform/widgets/platform-ai-usage-view";
import { decideAdminApiAccess } from "@/lib/admin-totp-enrollment";
import { PlatformAiUsageTodayCard } from "@/components/platform/widgets/PlatformAiUsageToday";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const NOW = new Date("2026-11-12T10:59:30.000Z");
const TODAY = "2026-11-12";
const MODEL = "gpt-4o-mini";
const RESERVE = platformAiReserveUsd(MODEL, TODAY)!;
/** Rows are whole tokens, so a row "costing $x" is within a millionth of a dollar of x. */
const close = (a: number, b: number) => Math.abs(a - b) < 1e-5;
const PROD = (operatorRaw?: string, platformRaw?: string): CapInputs => ({ operatorRaw, platformRaw, vercelEnv: "production" });
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const original = { warn: console.warn, error: console.error };
  console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, original); }
};

let seq = 0;
/** A platform_ai row costing exactly `usd` on gpt-4o-mini (output $0.60 / M). */
function row(userId: string | null, usd: number, over: Partial<PlatformAiUsageRow> = {}): PlatformAiUsageRow {
  return {
    userId, provider: "OPENAI", model: MODEL, subSurface: PLATFORM_AI_SUB_SURFACE, outcome: "RETURNED", correlationId: `t${++seq}`,
    promptTokens: 0, cachedPromptTokens: 0, completionTokens: Math.round(usd / 0.6e-6), ...over,
  };
}
const fig = (over: Partial<PlatformAiUsageFigure> = {}): PlatformAiUsageFigure =>
  ({ estimatedUsd: 0, calls: 0, failedCalls: 0, unpricedCalls: 0, turns: 0, tokens: 0, ...over });

// ── One in-memory fm_system for BOTH the reservation (tx, serialised) and the usage read (root) ──
function makeStore(opts: { rows?: PlatformAiUsageRow[]; settings?: Record<string, string>; overrides?: Record<string, unknown>; ledgerFailures?: number; failRead?: boolean } = {}) {
  const buckets = new Map<string, number>();
  const overrideReads: Array<{ where: { userId: { in: string[] } } }> = [];
  const bk = (key: string, w: Date) => `${key}@${w.toISOString()}`;
  const rateLimitFindMany = async ({ where }: { where: { key: string | { startsWith: string }; windowStart: { in: Date[] } } }) => {
    if (typeof where.key === "string") return where.key === LEDGER_FAILURE_KEY && opts.ledgerFailures ? [{ count: opts.ledgerFailures }] : [];
    const prefix = where.key.startsWith;
    const out: { key: string; count: number }[] = [];
    for (const [k, n] of buckets) { const [key, iso] = k.split("@"); if (key.startsWith(prefix) && where.windowStart.in.some((w) => w.toISOString() === iso)) out.push({ key, count: n }); }
    return out;
  };
  const settingsFindMany = async (args: { where: { key: { in: string[] } } }) =>
    Object.entries(opts.settings ?? {}).filter(([k]) => args.where.key.in.includes(k)).map(([key, value]) => ({ key, value }));
  const rowsFor = () => {
    if (opts.failRead) throw new Error("read failed");
    return (opts.rows ?? []).map((r) => ({ ...r }));
  };
  const tx = {
    $executeRaw: async () => 1,
    aiInvocation: { findMany: async () => rowsFor().filter((r) => r.outcome === "RETURNED") },
    platformSetting: { findMany: settingsFindMany },
    platformAiOperatorCap: {
      findUnique: async (args: { where: { userId: string } }) => {
        const o = opts.overrides ?? {};
        return Object.prototype.hasOwnProperty.call(o, args.where.userId) ? { dailyUsd: o[args.where.userId] } : null;
      },
    },
    rateLimit: {
      findMany: rateLimitFindMany,
      upsert: async ({ where, create }: { where: { key_windowStart: { key: string; windowStart: Date } }; create: { count: number } }) => {
        const k = bk(where.key_windowStart.key, where.key_windowStart.windowStart); const n = (buckets.get(k) ?? 0) + create.count; buckets.set(k, n); return { count: n };
      },
    },
  } as unknown as SpendTxClient;
  let chain: Promise<unknown> = Promise.resolve();
  const spend = {
    $transaction: <T,>(fn: (t: SpendTxClient) => Promise<T>): Promise<T> => { const run = chain.then(() => fn(tx)); chain = run.catch(() => undefined); return run; },
    rateLimit: {
      updateMany: async ({ where, data }: { where: { key: string; windowStart: Date; count: { gt: number } }; data: { count: { decrement: number } } }) => {
        const k = bk(where.key, where.windowStart); const n = buckets.get(k) ?? 0; if (n <= where.count.gt) return { count: 0 }; buckets.set(k, n - data.count.decrement); return { count: 1 };
      },
    },
  } as unknown as SpendClient;
  const read: UsageTodayReadClient = {
    aiInvocation: { findMany: async () => rowsFor() },
    rateLimit: { findMany: rateLimitFindMany as UsageTodayReadClient["rateLimit"]["findMany"] },
    platformSetting: { findMany: settingsFindMany as UsageTodayReadClient["platformSetting"]["findMany"] },
    platformAiOperatorCap: {
      findMany: async (args: unknown) => {
        const a = args as { where: { userId: { in: string[] } } };
        overrideReads.push(a);
        const o = opts.overrides ?? {};
        return a.where.userId.in.filter((id) => Object.prototype.hasOwnProperty.call(o, id)).map((userId) => ({ userId, dailyUsd: o[userId] }));
      },
    },
  };
  return { spend, read, overrideReads, inflight: () => [...buckets.values()].reduce((a, b) => a + b, 0) };
}

const SETTINGS = (perOp: number, platform: number) => ({ [PLATFORM_AI_CAP_SETTING_KEYS.perOperator]: String(perOp), [PLATFORM_AI_CAP_SETTING_KEYS.platform]: String(platform) });

async function main() {
  console.log("1. the fold — priced like the reservation");
  {
    const rows = [row("op_a", 0.3), row("op_a", 0.2, { correlationId: "same" }), row("op_a", 0, { correlationId: "same", outcome: "FAILED", completionTokens: 0 }), row("op_b", 0.1)];
    const f = foldPlatformAiUsage(rows, TODAY);
    const ref = sumTodaySpend(spendGroupsOf(rows), TODAY);
    check("estimatedUsd equals the reservation's sumTodaySpend over the same rows", close(f.estimatedUsd, ref.spentUsd) && close(f.estimatedUsd, 0.6), f);
    check("RETURNED calls 3, failed 1 (zero tokens, never priced)", f.calls === 3 && f.failedCalls === 1, f);
    check("a turn = a distinct correlationId of ANY outcome (the turn cap's count)", f.turns === 3, f);
    check("spendGroupsOf drops non-RETURNED rows", spendGroupsOf(rows).reduce((n, g) => n + g.invocations, 0) === 3);
    const unpriced = foldPlatformAiUsage([row("op_a", 0.5), row("op_a", 0, { model: "no-such-model", completionTokens: 1000 })], TODAY);
    check("an unpriced call is COUNTED, excluded from dollars, never $0-priced as if known", unpriced.unpricedCalls === 1 && close(unpriced.estimatedUsd, 0.5) && unpriced.calls === 2, unpriced);
    const empty = foldPlatformAiUsage([], TODAY);
    check("no rows ⇒ zeros", empty.estimatedUsd === 0 && empty.calls === 0 && empty.turns === 0);
  }

  console.log("\n2. by model / by feature");
  {
    check("feature labels key on the ledger's own sub-surface codes",
      Object.prototype.hasOwnProperty.call(PLATFORM_AI_FEATURE_LABELS, PLATFORM_AI_SUB_SURFACE) && Object.prototype.hasOwnProperty.call(PLATFORM_AI_FEATURE_LABELS, PLATFORM_AI_CONVERSATION_SUB_SURFACE));
    const rows = [row("op_a", 0.1), row("op_a", 0.5, { subSurface: PLATFORM_AI_CONVERSATION_SUB_SURFACE }), row("op_a", 0.05, { subSurface: null, model: "gpt-4o" })];
    const f = byFeature(rows, TODAY);
    check("by feature: most expensive first, named; null ⇒ Unlabelled", f[0].label === "Conversations" && f[1].label === PLATFORM_AI_FEATURE_LABELS[PLATFORM_AI_SUB_SURFACE] && f.some((s) => s.label === UNLABELLED_FEATURE), f.map((s) => s.label));
    const m = byModel(rows, TODAY);
    check("by model: one slice per (provider, model), labelled by model", m.length === 2 && m.some((s) => s.key === "OPENAI:gpt-4o-mini" && s.calls === 2) && m.some((s) => s.label === "gpt-4o"), m);
  }

  console.log("\n3. budget ⇔ the reservation's own decision");
  {
    let agree = 0, total = 0;
    const mismatches: unknown[] = [];
    for (const cap of [0, 1, 2, 5]) for (const spent of [0, 0.4, 0.9, 1, 1.5, 4.99]) for (const inFlight of [0, 1, 2, 5]) {
      total++;
      const rows = spent > 0 ? [row("op_a", spent)] : [];
      const usage = foldPlatformAiUsage(rows, TODAY);
      const b = platformAiBudget({ cap: { usd: cap, refusal: null }, usage, inFlight, reserveUsd: RESERVE, ledgerUntrusted: false });
      const v = platformAiSpendDecision({
        caps: { state: "OK", operatorUsd: cap, platformUsd: 1000, source: { operator: "PLATFORM_SETTING", platform: "PLATFORM_SETTING" } },
        operatorGroups: spendGroupsOf(rows), platformGroups: spendGroupsOf(rows), todayISO: TODAY, operatorInFlight: inFlight, platformInFlight: inFlight, reserveUsd: RESERVE,
      });
      const refused = !v.allowed && v.detail === "COST_CAP";
      if ((b.state === "EXHAUSTED") === refused) agree++; else mismatches.push({ cap, spent, inFlight, state: b.state });
    }
    check(`EXHAUSTED ⇔ the reservation refuses COST_CAP, every case of the grid (${total})`, agree === total, mismatches);
    const b = platformAiBudget({ cap: { usd: 10, refusal: null }, usage: fig({ estimatedUsd: 2 }), inFlight: 2, reserveUsd: 1, ledgerUntrusted: false });
    check("remaining = cap − spent − in-flight × reserve; questions that fit; reserved shown", b.remainingUsd === 6 && b.turnsLeft === 6 && b.reservedUsd === 2 && b.state === "OK", b);
    const low = platformAiBudget({ cap: { usd: 10, refusal: null }, usage: fig({ estimatedUsd: 7.5 }), inFlight: 0, reserveUsd: 1, ledgerUntrusted: false });
    check("≤ 2 questions fit ⇒ LOW", low.state === "LOW" && low.turnsLeft === 2, low);
    const over = platformAiBudget({ cap: { usd: 1, refusal: null }, usage: fig({ estimatedUsd: 1.7 }), inFlight: 0, reserveUsd: 0.5, ledgerUntrusted: false });
    check("spent over the cap ⇒ EXHAUSTED, remaining floored at $0 (never negative), 0 questions", over.state === "EXHAUSTED" && over.remainingUsd === 0 && over.turnsLeft === 0, over);
    const zero = platformAiBudget({ cap: { usd: 0, refusal: null }, usage: fig(), inFlight: 0, reserveUsd: 0.5, ledgerUntrusted: false });
    check("a $0 cap ⇒ EXHAUSTED (0 means off, never unlimited)", zero.state === "EXHAUSTED", zero);
  }

  console.log("\n4. FAIL CLOSED — no headroom is ever invented");
  {
    for (const refusal of ["CAP_MISSING", "CAP_INVALID"] as const) {
      const b = platformAiBudget({ cap: { usd: null, refusal }, usage: fig({ estimatedUsd: 0.2 }), inFlight: 0, reserveUsd: RESERVE, ledgerUntrusted: false });
      check(`${refusal} ⇒ REFUSING ${refusal}, remaining null, questions null`, b.state === "REFUSING" && b.refusal === refusal && b.remainingUsd === null && b.turnsLeft === null && b.capUsd === null, b);
      check(`…the wording names the cause and shows no "$ left" (${refusal})`, !/left/.test(remainingLine(b)) && /refused/.test(remainingLine(b)), remainingLine(b));
    }
    const nullCap = platformAiBudget({ cap: { usd: null, refusal: null }, usage: fig(), inFlight: 0, reserveUsd: RESERVE, ledgerUntrusted: false });
    check("a null cap with no stated cause ⇒ REFUSING CAP_MISSING (never OK)", nullCap.state === "REFUSING" && nullCap.refusal === "CAP_MISSING");
    const unpricedModel = platformAiBudget({ cap: { usd: 5, refusal: null }, usage: fig(), inFlight: 0, reserveUsd: null, ledgerUntrusted: false });
    check("unpriced model (no reserve) ⇒ REFUSING UNPRICED", unpricedModel.state === "REFUSING" && unpricedModel.refusal === "UNPRICED" && unpricedModel.remainingUsd === null);
    const unpricedRow = platformAiBudget({ cap: { usd: 5, refusal: null }, usage: fig({ unpricedCalls: 1 }), inFlight: 0, reserveUsd: RESERVE, ledgerUntrusted: false });
    check("an unpriced row today ⇒ REFUSING UNPRICED (the reservation refuses it too)", unpricedRow.state === "REFUSING" && unpricedRow.refusal === "UNPRICED");
    const ledger = platformAiBudget({ cap: { usd: 5, refusal: null }, usage: fig(), inFlight: 0, reserveUsd: RESERVE, ledgerUntrusted: true });
    check("ledger failing its writes ⇒ REFUSING LEDGER_UNTRUSTED", ledger.state === "REFUSING" && ledger.refusal === "LEDGER_UNTRUSTED");
  }

  console.log("\n5. one operator — the worst limit wins, named");
  {
    const ok = platformAiBudget({ cap: { usd: 10, refusal: null }, usage: fig(), inFlight: 0, reserveUsd: 1, ledgerUntrusted: false });
    const exhausted = platformAiBudget({ cap: { usd: 1, refusal: null }, usage: fig({ estimatedUsd: 1 }), inFlight: 0, reserveUsd: 1, ledgerUntrusted: false });
    const refusing = platformAiBudget({ cap: { usd: null, refusal: "CAP_MISSING" }, usage: fig(), inFlight: 0, reserveUsd: 1, ledgerUntrusted: false });
    const a = platformAiOperatorUsage({ usage: fig({ turns: 3 }), budget: ok, platform: ok, turnsCap: 20 });
    check("all clear ⇒ OK, no limit named", a.state === "OK" && a.limitedBy === null && a.turnsUsed === 3);
    const b = platformAiOperatorUsage({ usage: fig(), budget: ok, platform: exhausted, turnsCap: 20 });
    check("platform exhausted ⇒ EXHAUSTED by PLATFORM", b.state === "EXHAUSTED" && b.limitedBy === "PLATFORM");
    const c = platformAiOperatorUsage({ usage: fig({ turns: PLATFORM_AI_DAILY_TURNS }), budget: ok, platform: ok, turnsCap: PLATFORM_AI_DAILY_TURNS });
    check("turn cap used up ⇒ EXHAUSTED by DAILY_TURNS", c.state === "EXHAUSTED" && c.limitedBy === "DAILY_TURNS");
    const d = platformAiOperatorUsage({ usage: fig(), budget: exhausted, platform: exhausted, turnsCap: 20 });
    check("own and platform both exhausted ⇒ the operator's own cap is named first", d.limitedBy === "OPERATOR");
    const e = platformAiOperatorUsage({ usage: fig({ turns: 20 }), budget: refusing, platform: ok, turnsCap: 20 });
    check("REFUSING outranks EXHAUSTED and carries its cause", e.state === "REFUSING" && e.refusal === "CAP_MISSING" && e.limitedBy === "OPERATOR");
  }

  console.log("\n6. CONCURRENCY — simultaneous reservations, as the page sees them");
  {
    // Operator cap $1, platform $100: exactly floor(1 / reserve) questions fit; twice that arrive at once.
    const s = makeStore({ settings: SETTINGS(1, 100) });
    const fit = Math.floor(1 / RESERVE);
    const outs = await quiet(() => Promise.all(Array.from({ length: fit * 2 }, () => reservePlatformAiSpend("op_a", NOW, { client: s.spend, caps: PROD(), model: MODEL }))));
    const admitted = outs.filter((o) => o.verdict.allowed).length;
    check(`${fit * 2} simultaneous questions, room for ${fit}: exactly ${fit} admitted`, admitted === fit, { admitted, fit });
    const held = await loadPlatformAiUsageToday(MODEL, { client: s.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0 });
    const v = held.byOperator.get("op_a")!;
    check("while held: the page counts every admitted question as in flight (operator and platform)", v.budget.inFlight === fit && held.fleet.platform.budget.inFlight === fit, { op: v.budget.inFlight, platform: held.fleet.platform.budget.inFlight });
    check("…reserved = in flight × reserve, remaining = cap − reserved", close(v.budget.reservedUsd!, fit * RESERVE) && close(v.budget.remainingUsd!, 1 - fit * RESERVE), v.budget);
    const next = await quiet(() => reservePlatformAiSpend("op_a", NOW, { client: s.spend, caps: PROD(), model: MODEL }));
    check("…the page says EXHAUSTED (own cap) and the next reservation is indeed refused COST_CAP OPERATOR",
      v.state === "EXHAUSTED" && v.limitedBy === "OPERATOR" && !next.verdict.allowed && next.verdict.detail === "COST_CAP" && next.verdict.scope === "OPERATOR", { state: v.state, verdict: next.verdict });
    check("…counted as active and at a limit in the fleet counts (no id)", held.fleet.operatorCounts.activeToday === 1 && held.fleet.operatorCounts.exhausted === 1);
    await Promise.all(outs.map((o) => o.release()));
    const after = await loadPlatformAiUsageToday(MODEL, { client: s.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0 });
    const w = after.byOperator.get("op_a");
    const again = await quiet(() => reservePlatformAiSpend("op_a", NOW, { client: s.spend, caps: PROD(), model: MODEL }));
    check("after release: nothing in flight, the operator drops out of today's list, the next reservation is admitted",
      s.inflight() === 1 && w === undefined && after.fleet.platform.budget.inFlight === 0 && again.verdict.allowed, { inflight: s.inflight() });
    await again.release();

    // Platform cap across operators: page EXHAUSTED by PLATFORM ⇔ the next reservation refused PLATFORM.
    const p = makeStore({ settings: SETTINGS(1, 2) });
    const per = Math.floor(1 / RESERVE);
    const total = Math.floor(2 / RESERVE);
    const ops = ["op_a", "op_b", "op_c"];
    const pOuts = await quiet(() => Promise.all(ops.flatMap((op) => Array.from({ length: per }, () => reservePlatformAiSpend(op, NOW, { client: p.spend, caps: PROD(), model: MODEL })))));
    check(`three operators at once, platform room for ${total}: exactly ${total} admitted`, pOuts.filter((o) => o.verdict.allowed).length === total);
    const pv = await loadPlatformAiUsageToday(MODEL, { client: p.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0, operatorIds: ["op_c"] });
    const pNext = await quiet(() => reservePlatformAiSpend("op_c", NOW, { client: p.spend, caps: PROD(), model: MODEL }));
    check("…the page: platform EXHAUSTED; an operator with room is EXHAUSTED by PLATFORM; the reservation agrees",
      pv.fleet.platform.budget.state === "EXHAUSTED" && pv.byOperator.get("op_c")!.state === "EXHAUSTED" && !pNext.verdict.allowed && pNext.verdict.detail === "COST_CAP" && pNext.verdict.scope === "PLATFORM",
      { platform: pv.fleet.platform.budget.state, op: pv.byOperator.get("op_c")?.limitedBy, verdict: pNext.verdict });
    await Promise.all(pOuts.map((o) => o.release()));
  }

  console.log("\n7. the loader");
  {
    const prodNone = makeStore({ rows: [row("op_a", 0.2)] });
    const u = await loadPlatformAiUsageToday(MODEL, { client: prodNone.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0 });
    const reserveNone = await quiet(() => reservePlatformAiSpend("op_a", NOW, { client: prodNone.spend, caps: PROD(), model: MODEL }));
    check("Production, nothing set ⇒ platform and operator REFUSING CAP_MISSING; the reservation refuses CAP_MISSING too",
      u.fleet.platform.budget.state === "REFUSING" && u.fleet.platform.budget.refusal === "CAP_MISSING" && u.byOperator.get("op_a")!.state === "REFUSING"
        && !reserveNone.verdict.allowed && reserveNone.verdict.detail === "UNAVAILABLE" && reserveNone.verdict.cause === "CAP_MISSING", u.fleet.platform.budget);
    check("…spend is still reported (estimated) when the cap is missing", close(u.fleet.platform.usage.estimatedUsd, 0.2) && u.fleet.operatorCounts.refusing === 1);
    const bad = makeStore({ settings: { [PLATFORM_AI_CAP_SETTING_KEYS.perOperator]: "3", [PLATFORM_AI_CAP_SETTING_KEYS.platform]: "lots" } });
    const ub = await loadPlatformAiUsageToday(MODEL, { client: bad.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0 });
    check("an invalid stored platform setting ⇒ REFUSING CAP_INVALID", ub.fleet.platform.budget.refusal === "CAP_INVALID");
    const badEnv = await loadPlatformAiUsageToday(MODEL, { client: makeStore({ settings: SETTINGS(3, 10) }).read, capInputs: PROD("5.", undefined), now: NOW, consecutiveFailures: 0, operatorIds: ["op_a"] });
    check("an INVALID env value refuses even when a setting would win (E2), as in the reservation", badEnv.byOperator.get("op_a")!.budget.refusal === "CAP_INVALID");
    const ov = makeStore({ settings: SETTINGS(3, 10), overrides: { op_a: 7, op_z: 50 }, rows: [row("op_a", 0.1)] });
    const uo = await loadPlatformAiUsageToday(MODEL, { client: ov.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0, operatorIds: ["op_b", "op_z"] });
    check("an operator's override is their cap; the default applies to the others", uo.byOperator.get("op_a")!.budget.capUsd === 7 && uo.byOperator.get("op_b")!.budget.capUsd === 3);
    check("an override row above the ceiling ⇒ that operator REFUSING CAP_INVALID", uo.byOperator.get("op_z")!.state === "REFUSING" && uo.byOperator.get("op_z")!.refusal === "CAP_INVALID");
    check("override rows are read only for the operators asked about or active today", ov.overrideReads.length === 1 && [...ov.overrideReads[0].where.userId.in].sort().join() === "op_a,op_b,op_z");
    check("operators with no usage are described but not counted as active", uo.fleet.operatorCounts.activeToday === 1);
    const ledger = await loadPlatformAiUsageToday(MODEL, { client: makeStore({ settings: SETTINGS(3, 10), ledgerFailures: 5 }).read, capInputs: PROD(), now: NOW, consecutiveFailures: 0 });
    check("the durable ledger-failure signal ⇒ REFUSING LEDGER_UNTRUSTED", ledger.fleet.platform.budget.refusal === "LEDGER_UNTRUSTED");
    const failing = makeStore({ failRead: true });
    const fleetNull = await quiet(() => loadPlatformAiFleetUsageToday(MODEL, "op_a", { client: failing.read, capInputs: PROD(), now: NOW }));
    check("a read error ⇒ the fleet projection is null (\"not available\"), never zeros", fleetNull === null);
    const capsModel = { model: MODEL, operators: [{ userId: "op_a" }] } as unknown as PlatformAiCapsReadModel;
    const saNull = await quiet(() => withPlatformAiUsageToday(capsModel, { client: failing.read, capInputs: PROD(), now: NOW }));
    check("…and on the SA page: usageToday null, each operator's today null; the caps still render", saNull.usageToday === null && saNull.operators[0].today === null);
  }

  console.log("\n8. AUTHORIZATION — who sees whose figures");
  {
    const s = makeStore({ settings: SETTINGS(3, 10), rows: [row("op_self", 0.2), row("op_other_secret", 0.9)] });
    const fleet = (await loadPlatformAiFleetUsageToday(MODEL, "op_self", { client: s.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0 }))!;
    const json = JSON.stringify(fleet);
    check("the PLATFORM_OPS READ projection names no other operator (no id anywhere)", !json.includes("op_other_secret") && !json.includes("op_self"));
    check("…its own figures are the viewer's only", close(fleet.self!.usage.estimatedUsd, 0.2) && fleet.self!.budget.capUsd === 3);
    check("…the platform total includes everyone (estimated), counts only", close(fleet.platform.usage.estimatedUsd, 1.1) && fleet.operatorCounts.activeToday === 2);
    check("…no per-operator map, no userId field", !("byOperator" in fleet) && !/"userId"/.test(json));
    const sa = await withPlatformAiUsageToday({ model: MODEL, operators: [{ userId: "op_self" }, { userId: "op_other_secret" }] } as unknown as PlatformAiCapsReadModel, { client: s.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0 });
    check("the SYSTEM_ADMIN model carries each operator's own view", close(sa.operators[1].today!.usage.estimatedUsd, 0.9) && sa.usageToday !== null && !("self" in sa.usageToday!));
    const saRoute = strip("app/api/admin/platform-ai-caps/route.ts");
    check("the per-operator views travel only on the SYSTEM_ADMIN caps route (GET requireSystemAdmin, POST requireFreshSystemAdmin)",
      (saRoute.match(/withPlatformAiUsageToday\(/g) ?? []).length === 2 && /requireSystemAdmin\(\)/.test(saRoute) && /requireFreshSystemAdmin\(\)/.test(saRoute));
    const opsRoute = strip("app/api/platform/platform-ops/ai-cost-controls/route.ts");
    check("the PLATFORM_OPS READ route uses only the fleet projection for the signed-in viewer",
      /loadPlatformAiFleetUsageToday\(aiModel, viewerId\)/.test(opsRoute) && !/withPlatformAiUsageToday|loadPlatformAiUsageToday\(/.test(opsRoute));
    const loader = strip("lib/platform/ai/platform-ai-usage-today.ts");
    check("the loader is read-only fm_system: no write verb, no transaction, no provider",
      /import \{ systemDb \} from "@\/lib\/db"/.test(loader) && !/\.(create|update|upsert|delete|updateMany|deleteMany|createMany)\(|\$transaction|\$executeRaw|openai|@\/lib\/ai\/provider/.test(loader));
    check("the ledger read selects ids + counts only (never prompt or answer text)", !/prompt:|content|message|answer/.test(loader.slice(loader.indexOf("aiInvocation.findMany"), loader.indexOf("rateLimit.findMany"))));
    const logs = loader.split("\n").filter((l) => /console\.\w+\(/.test(l));
    check("logs are codes only (no id, no figure)", logs.length >= 1 && logs.every((l) => !/viewerId|userId|Usd|spent/.test(l)), logs);
    const core = strip("lib/platform/ai/platform-ai-usage-today.core.ts");
    check("the core is pure: no db, env, clock or server-only", !/@\/lib\/db|@\/lib\/env|process\.env|new Date\(|Date\.now|server-only/.test(core));
  }

  console.log("\n9. wording + the card — ESTIMATED, read-only");
  {
    check("estUsd: cents; a sub-cent positive amount is <$0.01, never $0.00", estUsd(0.4212) === "$0.42" && estUsd(0.001) === "<$0.01" && estUsd(0) === "$0.00");
    check("the spent line says estimated", /\(estimated\)/.test(spentLine(fig({ estimatedUsd: 1, turns: 2, calls: 3, failedCalls: 1, unpricedCalls: 1 }))));
    const s = makeStore({ settings: SETTINGS(3, 10), rows: [row("op_self", 0.2, { subSurface: PLATFORM_AI_CONVERSATION_SUB_SURFACE })] });
    const fleet = (await loadPlatformAiFleetUsageToday(MODEL, "op_self", { client: s.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0 }))!;
    const html = renderToStaticMarkup(createElement(PlatformAiUsageTodayCard, { usage: fleet }));
    check("the card: title, Estimated badge, the not-a-provider-charge note", html.includes("Platform AI usage today") && html.includes(">Estimated<") && /Not a provider charge/.test(html));
    check("…spent of the platform cap, remaining, by model, by feature, the viewer's own line",
      html.includes("$0.20") && html.includes("of $10 platform cap (estimated)") && /left of \$10 \(estimated\)/.test(html) && html.includes("By model") && html.includes("Conversations") && html.includes("You: "), html);
    check("…no write affordance", !/<button|<input|<select|<form/.test(html));
    const none = renderToStaticMarkup(createElement(PlatformAiUsageTodayCard, { usage: null }));
    check("null ⇒ an honest not-available line", /not available/.test(none));
    const refusing = renderToStaticMarkup(createElement(PlatformAiUsageTodayCard, { usage: { ...fleet, platform: { ...fleet.platform, budget: platformAiBudget({ cap: { usd: null, refusal: "CAP_MISSING" }, usage: fleet.platform.usage, inFlight: 0, reserveUsd: RESERVE, ledgerUntrusted: false }) } } }));
    check("a refusing platform budget: 'Refusing questions', the cause, no '$ left', no meter", refusing.includes("Refusing questions") && /cap is not set/.test(refusing) && !/left of/.test(refusing) && !/role="meter"/.test(refusing));
    check("the operator line names the limit", /Limit reached \(the platform cap\)/.test(operatorTodayLine({ ...fleet.self!, state: "EXHAUSTED", limitedBy: "PLATFORM" })));
    const panel = strip("components/platform/widgets/AiCostControlsPanel.tsx");
    check("Policies → AI Cost Controls renders the card (and the link decision) from its own server read model",
      /<PlatformAiUsageTodayCard usage=\{data\.platformAiUsageToday\} manageLimitsHref=\{data\.platformAiManageLimitsHref\} \/>/.test(panel));
    const card = strip("components/platform/widgets/PlatformAiUsageToday.tsx");
    check("the card makes no network call and holds no handler", !/fetch\(|mutate\(|onClick|onChange/.test(card));
  }

  console.log("\n10. \"Manage limits\" — System Admins only, decided server-side");
  {
    const access = (role: "USER" | "SYSTEM_ADMIN", over: { requireTotpSetup?: boolean; systemAdminDisabled?: boolean } = {}) =>
      decideAdminApiAccess({ role: role as never, requireTotpSetup: over.requireTotpSetup ?? false, systemAdminDisabled: over.systemAdminDisabled ?? false });
    // A Platform Ops READ grant holder is a USER with a grant: it passes requirePlatformAccess("PLATFORM_OPS", "READ") but not the admin rule.
    const readOnlyHref = platformAiManageLimitsHref(access("USER"));
    check("a Platform Ops read-only viewer (USER + READ grant) ⇒ no href", readOnlyHref === null);
    check("a System Admin passing the caps route's check ⇒ the caps PAGE (not its API)", platformAiManageLimitsHref(access("SYSTEM_ADMIN")) === PLATFORM_AI_CAPS_PAGE_HREF && PLATFORM_AI_CAPS_PAGE_HREF === "/admin/platform-ai-caps");
    check("a System Admin the caps route would refuse (TOTP enrolment pending / admin disabled) ⇒ no href, same as the route",
      platformAiManageLimitsHref(access("SYSTEM_ADMIN", { requireTotpSetup: true })) === null && platformAiManageLimitsHref(access("SYSTEM_ADMIN", { systemAdminDisabled: true })) === null);
    const s = makeStore({ settings: SETTINGS(3, 10) });
    const fleet = (await loadPlatformAiFleetUsageToday(MODEL, "op_ro", { client: s.read, capInputs: PROD(), now: NOW, consecutiveFailures: 0 }))!;
    for (const [name, usage] of [["with usage", fleet], ["usage unavailable", null]] as const) {
      const ro = renderToStaticMarkup(createElement(PlatformAiUsageTodayCard, { usage, manageLimitsHref: readOnlyHref }));
      check(`read-only viewer (${name}): no link, no href, no "Manage limits" text`, !/<a\b|href=/.test(ro) && !ro.includes(MANAGE_LIMITS_LABEL));
      const sa = renderToStaticMarkup(createElement(PlatformAiUsageTodayCard, { usage, manageLimitsHref: PLATFORM_AI_CAPS_PAGE_HREF }));
      check(`System Admin (${name}): exactly one "Manage limits" link to the caps page; still no edit control`,
        (sa.match(/<a\b/g) ?? []).length === 1 && sa.includes(`href="${PLATFORM_AI_CAPS_PAGE_HREF}"`) && sa.includes(MANAGE_LIMITS_LABEL) && !/<button|<input|<select|<form/.test(sa));
    }
    const opsRoute = strip("app/api/platform/platform-ops/ai-cost-controls/route.ts");
    check("the route decides the link from the SESSION with the caps route's own rule (adminApiAccess), on GET and PATCH replies",
      /platformAiManageLimitsHref: platformAiManageLimitsHref\(adminApiAccess\(viewer\)\)/.test(opsRoute)
        && /withPlatformAiCaps\(await loadAiCostControlsReadModel\(\), auth\.user\)/.test(opsRoute) && /withPlatformAiCaps\(applied\.model, auth\.user\)/.test(opsRoute));
    const session = strip("lib/session.ts");
    const guard = session.slice(session.indexOf("export async function requireSystemAdmin()"), session.indexOf("export function adminApiAccess"));
    check("…and requireSystemAdmin() enforces exactly that function", /if \(adminApiAccess\(user\) !== "ALLOW"\) return \[null, forbidden\(\)\];/.test(guard));
    const card = strip("components/platform/widgets/PlatformAiUsageToday.tsx");
    check("the card has no client-side role/flag of its own: the href comes only from its prop", !/\.role\b|SYSTEM_ADMIN|useSession|isAdmin|session/.test(card) && /<ManageLimitsLink href=\{manageLimitsHref\} \/>/.test(card));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
void main();
