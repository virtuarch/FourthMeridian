/**
 * lib/platform/intelligence/ai/eval/cases/cost-cap.ts  (E0-CI — P2b: the daily $ caps, I-10 + S2 ruling 8)
 *
 * COST_CAP — through the REAL ask route (the route's own reservePlatformAiSpend, the fixture
 *   ledger, the test caps lib/test-support/route-env.ts sets: $100 operator / $500 platform):
 *   · an operator whose spend today has reached the operator cap ⇒ 429 COST_CAP, 0 provider requests;
 *   · other operators' spend that has reached the platform cap ⇒ 429 COST_CAP, 0 provider requests;
 *   · just under the cap ⇒ the turn runs unchanged (and the runner asserts every reservation
 *     the route cases took was released).
 * Unit (handlePlatformAiAsk + the REAL reservation over an in-memory fm_system stand-in, scripted model):
 *   · production + caps MISSING ⇒ refused (503) before any provider request; unknown / absent
 *     VERCEL_ENV likewise; preview + MISSING ⇒ the test default caps admit the turn (S2 ruling 8);
 *   · concurrency: N simultaneous turns where the cap has room for k reserves ⇒ exactly k reach
 *     the provider, the rest are refused COST_CAP before it (the reservation prevents overshoot).
 */

import { handlePlatformAiAsk, type PlatformAiAskDeps, type PlatformAiBinding } from "../../core";
import { reservePlatformAiSpend, type SpendClient, type SpendTxClient } from "@/lib/platform/ai/platform-ai-spend";
import { platformAiReserveUsd, type CapInputs } from "@/lib/platform/ai/platform-ai-spend.core";
import { todayUTCISO } from "@/lib/time/clock";
import { scriptedGenerate } from "../scripted-model";
import type { RouteCase, UnitCase, UnitContext } from "./types";

const refusedCostCap = ([o]: Parameters<RouteCase["check"]>[0]) => [
  ...(o.status === 429 ? [] : [`status ${o.status}, expected 429`]),
  ...(o.body.reason === "COST_CAP" && o.body.code === "AI_UNAVAILABLE" ? [] : [`reason ${String(o.body.reason)}`]),
  ...(o.requests.length === 0 ? [] : [`${o.requests.length} provider request(s) were made`]),
];

export const COST_CAP_ROUTE_CASES: readonly RouteCase[] = [
  {
    kind: "route", id: "cost-cap.operator-cap-reached", pack: "boundary", gates: ["COST_CAP"], operator: "ops",
    ledger: [{ operator: "ops", usd: 100 }],
    turns: [{ question: "How many incidents are broken right now?", steps: [{ calls: [{ name: "list_metrics", args: {} }] }, { content: "x" }] }],
    check: refusedCostCap,
  },
  {
    kind: "route", id: "cost-cap.platform-cap-reached-by-others", pack: "boundary", gates: ["COST_CAP"], operator: "ops",
    ledger: [{ operator: "cs", usd: 499.99 }],
    turns: [{ question: "How many incidents are broken right now?", steps: [{ calls: [{ name: "list_metrics", args: {} }] }, { content: "x" }] }],
    check: refusedCostCap,
  },
  {
    kind: "route", id: "cost-cap.under-cap-unchanged", pack: "boundary", gates: ["COST_CAP"], operator: "ops",
    ledger: [{ operator: "ops", usd: 99 }, { operator: "cs", usd: 400 }],
    turns: [{ question: "Which metrics can I read?", steps: [{ calls: [{ name: "list_metrics", args: {} }] }, { content: "Here is what I can read." }] }],
    check: ([o]) => [
      ...(o.status === 200 ? [] : [`status ${o.status}`]),
      ...(o.requests.length === 2 ? [] : [`${o.requests.length} provider requests, expected 2`]),
    ],
  },
];

// ── unit: the env fallback (ruling 8) and concurrency, through the handler + the REAL reservation ──

const MODEL = "gpt-4o-mini";

/** An in-memory fm_system stand-in: transactions serialised (the advisory locks' effect), RateLimit buckets kept. */
function memoryClient(): { client: SpendClient; held(): number } {
  const buckets = new Map<string, number>();
  let chain: Promise<unknown> = Promise.resolve();
  const bk = (key: string, w: Date) => `${key}@${w.toISOString()}`;
  const tx = {
    $executeRaw: async () => 1,
    aiInvocation: { findMany: async () => [] },
    rateLimit: {
      findMany: async ({ where }: { where: { key: string | { startsWith: string } } }) =>
        typeof where.key === "string" ? [] : [...buckets].filter(([k]) => k.startsWith((where.key as { startsWith: string }).startsWith)).map(([k, count]) => ({ key: k.split("@")[0], count })),
      upsert: async ({ where }: { where: { key_windowStart: { key: string; windowStart: Date } } }) => {
        const k = bk(where.key_windowStart.key, where.key_windowStart.windowStart); buckets.set(k, (buckets.get(k) ?? 0) + 1); return { count: buckets.get(k) };
      },
    },
  } as unknown as SpendTxClient;
  const client = {
    $transaction: <T,>(fn: (t: SpendTxClient) => Promise<T>): Promise<T> => { const run = chain.then(() => fn(tx)); chain = run.catch(() => undefined); return run; },
    rateLimit: {
      updateMany: async ({ where }: { where: { key: string; windowStart: Date } }) => {
        const k = bk(where.key, where.windowStart); const n = buckets.get(k) ?? 0; if (n > 0) buckets.set(k, n - 1); return { count: n > 0 ? 1 : 0 };
      },
    },
  } as unknown as SpendClient;
  return { client, held: () => [...buckets.values()].reduce((a, b) => a + b, 0) };
}

async function askWith(ctx: UnitContext, caps: CapInputs, client: SpendClient, now: Date): Promise<{ status: number; reason: unknown; requests: number }> {
  const scoped = ctx.scoped("ops", "PLATFORM_OPS");
  const g = scriptedGenerate([{ content: "Nothing to report." }]);
  const deps: PlatformAiAskDeps = {
    enabled: true, operatorId: ctx.operatorId("ops"), binding: scoped?.binding as PlatformAiBinding,
    admission: async () => ({ paused: false, state: "OFF" }), freeze: async () => ({ frozen: false, state: "OFF" }),
    turns: async () => ({ allowed: true, remaining: 5 }),
    spend: (id, at) => reservePlatformAiSpend(id, at, { client, caps, model: MODEL }),
    generate: g.generate, model: MODEL, now: () => now, classify: () => "PROVIDER",
  };
  const r = await handlePlatformAiAsk({ question: "Which metrics can I read?" }, deps);
  return { status: r.status, reason: r.body.reason, requests: g.requests.length };
}

const envCase = (id: string, caps: CapInputs, expectAdmitted: boolean): UnitCase => ({
  kind: "unit", id, pack: "boundary", gates: ["COST_CAP"],
  async run(ctx) {
    const m = memoryClient();
    const r = await askWith(ctx, caps, m.client, new Date());
    return expectAdmitted
      ? [...(r.status === 200 ? [] : [`status ${r.status} (${String(r.reason)})`]), ...(r.requests > 0 ? [] : ["no provider request"]), ...(m.held() === 0 ? [] : ["reservation not released"])]
      : [...(r.status === 503 && r.reason === "ALLOWANCE_UNAVAILABLE" ? [] : [`status ${r.status} reason ${String(r.reason)}`]), ...(r.requests === 0 ? [] : [`${r.requests} provider request(s)`])];
  },
});

export const COST_CAP_UNIT_CASES: readonly UnitCase[] = [
  envCase("cost-cap.production-missing-refused", { operatorRaw: undefined, platformRaw: undefined, vercelEnv: "production" }, false),
  envCase("cost-cap.unknown-env-missing-refused", { operatorRaw: undefined, platformRaw: undefined, vercelEnv: undefined }, false),
  envCase("cost-cap.unrecognised-env-missing-refused", { operatorRaw: undefined, platformRaw: undefined, vercelEnv: "staging" }, false),
  envCase("cost-cap.production-invalid-refused", { operatorRaw: "10 USD", platformRaw: "50", vercelEnv: "production" }, false),
  envCase("cost-cap.preview-missing-default", { operatorRaw: undefined, platformRaw: undefined, vercelEnv: "preview" }, true),
  {
    kind: "unit", id: "cost-cap.concurrent-turns-no-overshoot", pack: "boundary", gates: ["COST_CAP"],
    async run(ctx) {
      const now = new Date();
      const reserve = platformAiReserveUsd(MODEL, todayUTCISO(now));
      if (reserve === null) return ["the E0 model is unpriced"];
      const room = 3;
      // An operator cap with room for exactly `room` worst-case turns (and not one more).
      const cap = (reserve * room + reserve / 2).toFixed(2);
      const m = memoryClient();
      // Hold every admitted reservation open (the provider has not returned) by never releasing until all decided:
      const outs = await Promise.all(Array.from({ length: room * 2 }, () => reservePlatformAiSpend(ctx.operatorId("ops"), now, { client: m.client, caps: { operatorRaw: cap, platformRaw: "500", vercelEnv: "production" }, model: MODEL })));
      const admitted = outs.filter((o) => o.verdict.allowed).length;
      const capped = outs.filter((o) => !o.verdict.allowed && o.verdict.detail === "COST_CAP").length;
      const heldBefore = m.held();
      await Promise.all(outs.map((o) => o.release()));
      return [
        ...(admitted === room ? [] : [`${admitted} admitted, room for ${room}`]),
        ...(capped === room ? [] : [`${capped} refused COST_CAP, expected ${room}`]),
        ...(heldBefore === room && m.held() === 0 ? [] : [`held ${heldBefore} → ${m.held()} after release`]),
      ];
    },
  },
];
