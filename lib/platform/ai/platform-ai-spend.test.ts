/**
 * lib/platform/ai/platform-ai-spend.test.ts  (Platform AI P2b — the daily $ caps; design v2 §10, I-10, S2 ruling 8)
 *
 * 1. cap resolution: strict parse; INVALID ⇒ refuse everywhere; MISSING ⇒ refuse on production /
 *    absent / unknown VERCEL_ENV, test default on preview / development (S2 APPROVAL ruling 8);
 * 2. the reserve: priced from THE rate card at the higher per-token rate; unpriced ⇒ null;
 * 3. the decision: operator then platform, this turn's own reserve included, unpriced ⇒ refuse;
 * 4. the reservation: locks (operator, then fleet) first, concurrency bounded, release idempotent,
 *    every failure a refusal (no transaction ⇒ RESERVATION_UNAVAILABLE, failing ledger ⇒ LEDGER_UNTRUSTED);
 * 5. the handlers: COST_CAP ⇒ 429 + Retry-After before any provider call / store write; unavailable ⇒ 503;
 *    an admitted reservation is released after the turn, whatever the turn did;
 * 6. static pins: every Platform AI route passes the reservation; gate order; codes-only logs; fm_system.
 * No database, no provider, no env file.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/platform-ai-spend.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PLATFORM_AI_RESERVE_TOKENS, PLATFORM_AI_SPEND_TEST_DEFAULTS, platformAiReserveUsd, platformAiSpendDecision,
  resolveOneCap, resolvePlatformAiSpendCaps, type CapInputs,
} from "./platform-ai-spend.core";
import {
  PLATFORM_AI_SPEND_FLEET_LOCK_KEY, platformAiInflightKey, platformAiSpendLockKey, reservePlatformAiSpend,
  type SpendClient, type SpendTxClient,
} from "./platform-ai-spend";
import { LEDGER_FAILURE_KEY } from "./ledger-health";
import { sumTodaySpend } from "@/lib/ai/allowance-core";
import { inflightBucket } from "./allowance-reservation";
import {
  PLATFORM_AI_COMPLETION_TOKENS_REASONING, PLATFORM_AI_TURN_TOKEN_CEILING, handlePlatformAiAsk,
  type PlatformAiAskDeps, type PlatformAiBinding, type PlatformAiSpendGate,
} from "@/lib/platform/intelligence/ai/core";
import { handleAppendMessage, handleCreateConversation } from "@/lib/platform/intelligence/ai/conversations/handlers";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const NOW = new Date("2026-11-10T10:59:30.000Z");
const TODAY = "2026-11-10";
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const caps = (operatorRaw: string | undefined, platformRaw: string | undefined, vercelEnv: string | undefined): CapInputs => ({ operatorRaw, platformRaw, vercelEnv });

// ── an in-memory fm_system stand-in: serialises $transaction bodies (the advisory locks' effect) ──
interface Row { userId: string | null; provider: string; model: string; promptTokens: number; cachedPromptTokens: number; completionTokens: number }
function makeClient(opts: { rows?: Row[]; txFails?: boolean; ledgerFailures?: number } = {}) {
  const buckets = new Map<string, number>(); // `${key}@${iso}` → count
  const locks: string[] = [];
  const reads: unknown[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const bk = (key: string, w: Date) => `${key}@${w.toISOString()}`;
  const tx = {
    $executeRaw: async (_q: TemplateStringsArray, ...v: unknown[]) => { locks.push(String(v[0])); return 1; },
    aiInvocation: { findMany: async (args: unknown) => { reads.push(args); return opts.rows ?? []; } },
    rateLimit: {
      findMany: async ({ where }: { where: { key: string | { startsWith: string }; windowStart: { in: Date[] } } }) => {
        if (typeof where.key === "string") return where.key === LEDGER_FAILURE_KEY && opts.ledgerFailures ? [{ count: opts.ledgerFailures }] : [];
        const prefix = where.key.startsWith;
        const out: { key: string; count: number }[] = [];
        for (const [k, n] of buckets) { const [key, iso] = k.split("@"); if (key.startsWith(prefix) && where.windowStart.in.some((w) => w.toISOString() === iso)) out.push({ key, count: n }); }
        return out;
      },
      upsert: async ({ where, create }: { where: { key_windowStart: { key: string; windowStart: Date } }; create: { count: number } }) => {
        const k = bk(where.key_windowStart.key, where.key_windowStart.windowStart); const n = (buckets.get(k) ?? 0) + create.count; buckets.set(k, n); return { count: n };
      },
    },
  } as unknown as SpendTxClient;
  const client: SpendClient = {
    $transaction: <T,>(fn: (t: SpendTxClient) => Promise<T>): Promise<T> => {
      if (opts.txFails) return Promise.reject(new Error("no transaction"));
      const run = chain.then(() => fn(tx));
      chain = run.catch(() => undefined);
      return run;
    },
    rateLimit: {
      updateMany: async ({ where, data }: { where: { key: string; windowStart: Date; count: { gt: number } }; data: { count: { decrement: number } } }) => {
        const k = bk(where.key, where.windowStart); const n = buckets.get(k) ?? 0; if (n <= where.count.gt) return { count: 0 }; buckets.set(k, n - data.count.decrement); return { count: 1 };
      },
    },
  } as unknown as SpendClient;
  const inflight = () => [...buckets.values()].reduce((a, b) => a + b, 0);
  return { client, buckets, locks, reads, inflight };
}
/** A RETURNED platform_ai row costing exactly `usd` on gpt-4o-mini (output $0.60 / M ⇒ tokens = usd / 0.6e-6). */
const rowCosting = (userId: string, usd: number): Row => ({ userId, provider: "OPENAI", model: "gpt-4o-mini", promptTokens: 0, cachedPromptTokens: 0, completionTokens: Math.round(usd / 0.6e-6) });
const MODEL = "gpt-4o-mini";
const quiet = async <T,>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> => {
  const original = { warn: console.warn, error: console.error };
  const lines: string[] = [];
  console.warn = console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { value: await fn(), lines }; } finally { Object.assign(console, original); }
};

async function main() {
  console.log("1. cap resolution (S2 ruling 8 — fail closed in code)");
  {
    for (const env of ["production", undefined, "staging", "", "PRODUCTION", "Preview"]) {
      const r = resolvePlatformAiSpendCaps(caps(undefined, undefined, env));
      check(`MISSING + VERCEL_ENV=${JSON.stringify(env)} ⇒ REFUSE CAP_MISSING`, r.state === "REFUSE" && r.cause === "CAP_MISSING", r);
      const empty = resolvePlatformAiSpendCaps(caps("", "", env));
      check(`empty string counts as MISSING (VERCEL_ENV=${JSON.stringify(env)}) ⇒ REFUSE`, empty.state === "REFUSE" && empty.cause === "CAP_MISSING", empty);
    }
    const prodHalf = resolvePlatformAiSpendCaps(caps("12", undefined, "production"));
    check("production with ONE cap missing ⇒ REFUSE (the platform cap)", prodHalf.state === "REFUSE" && prodHalf.cause === "CAP_MISSING" && prodHalf.cap === "PLATFORM", prodHalf);
    const prodSet = resolvePlatformAiSpendCaps(caps("12.50", "40", "production"));
    check("production with both caps set ⇒ those values, source ENV", prodSet.state === "OK" && prodSet.operatorUsd === 12.5 && prodSet.platformUsd === 40 && prodSet.source.operator === "ENV" && prodSet.source.platform === "ENV", prodSet);
    for (const env of ["preview", "development"]) {
      const r = resolvePlatformAiSpendCaps(caps(undefined, undefined, env));
      check(`MISSING + VERCEL_ENV=${env} ⇒ the TEST defaults ($${PLATFORM_AI_SPEND_TEST_DEFAULTS.operatorUsd} / $${PLATFORM_AI_SPEND_TEST_DEFAULTS.platformUsd}), source TEST_DEFAULT`,
        r.state === "OK" && r.operatorUsd === PLATFORM_AI_SPEND_TEST_DEFAULTS.operatorUsd && r.platformUsd === PLATFORM_AI_SPEND_TEST_DEFAULTS.platformUsd && r.source.operator === "TEST_DEFAULT", r);
      const mixed = resolvePlatformAiSpendCaps(caps("3", undefined, env));
      check(`${env}: a set cap wins, the missing one defaults`, mixed.state === "OK" && mixed.operatorUsd === 3 && mixed.source.operator === "ENV" && mixed.source.platform === "TEST_DEFAULT", mixed);
    }
    const bad = [" 5", "5 ", "5.", ".5", "5.001", "1e3", "-1", "+5", "$5", "five", "05", "1,000", "Infinity", "NaN", "0x10", "1000000"];
    for (const env of ["production", "preview", "development", undefined]) {
      const allInvalid = bad.every((raw) => { const r = resolvePlatformAiSpendCaps(caps(raw, "50", env)); return r.state === "REFUSE" && r.cause === "CAP_INVALID" && r.cap === "OPERATOR"; });
      check(`INVALID operator cap ⇒ REFUSE CAP_INVALID on VERCEL_ENV=${JSON.stringify(env)} (no default rescues it): ${bad.length} shapes`, allInvalid);
      const pl = resolvePlatformAiSpendCaps(caps("5", "abc", env));
      check(`INVALID platform cap ⇒ REFUSE CAP_INVALID (VERCEL_ENV=${JSON.stringify(env)})`, pl.state === "REFUSE" && pl.cause === "CAP_INVALID" && pl.cap === "PLATFORM", pl);
    }
    const inv = resolvePlatformAiSpendCaps(caps(undefined, "x", "production"));
    check("INVALID is reported before MISSING", inv.state === "REFUSE" && inv.cause === "CAP_INVALID", inv);
    const good = ["0", "1", "12", "12.5", "12.50", "999999.99"];
    check(`strict shapes accepted: ${good.join(", ")}`, good.every((raw) => { const r = resolveOneCap(raw, "production", 1); return r.ok && r.source === "ENV" && r.usd === Number(raw); }));
    const zero = resolvePlatformAiSpendCaps(caps("0", "0", "production"));
    check("\"0\" is valid and means 0 (never unlimited)", zero.state === "OK" && zero.operatorUsd === 0 && zero.platformUsd === 0, zero);

    const envSrc = strip("lib/env.ts");
    check("lib/env.ts hands the RAW VERCEL_ENV to the resolver (not deploymentEnvironment(), which maps absent ⇒ development)",
      /get platformAiSpendCapInputs\(\) \{\s*return \{ operatorRaw: _e\.PLATFORM_AI_DAILY_USD_CAP_PER_OPERATOR, platformRaw: _e\.PLATFORM_AI_DAILY_USD_CAP_PLATFORM, vercelEnv: _e\.VERCEL_ENV \};/.test(envSrc));
    const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    check(".env.example documents both caps, empty, and that owner numbers must be set before Production activation",
      /\nPLATFORM_AI_DAILY_USD_CAP_PER_OPERATOR=\n/.test(example) && /\nPLATFORM_AI_DAILY_USD_CAP_PLATFORM=\n/.test(example) && /MUST be set \(owner numbers, OI-2\) before any Production\n# activation/.test(example));
  }

  console.log("\n2. the reserve (worst case of one turn, THE rate card)");
  {
    check("reserve tokens = 2 × turn ceiling + one reasoning completion", PLATFORM_AI_RESERVE_TOKENS === 2 * PLATFORM_AI_TURN_TOKEN_CEILING + PLATFORM_AI_COMPLETION_TOKENS_REASONING);
    const mini = platformAiReserveUsd("gpt-4o-mini", TODAY);
    check("gpt-4o-mini: every reserved token at the HIGHER (output) rate $0.60 / M", mini !== null && close(mini, PLATFORM_AI_RESERVE_TOKENS * 0.6 / 1e6), mini);
    const g51 = platformAiReserveUsd("gpt-5.1", TODAY);
    check("gpt-5.1: at $10 / M", g51 !== null && close(g51, PLATFORM_AI_RESERVE_TOKENS * 10 / 1e6), g51);
    check("an unpriced model ⇒ null (never a $0 reserve)", platformAiReserveUsd("gpt-unknown", TODAY) === null);
    check("a day before the model's rate is in force ⇒ null", platformAiReserveUsd("gpt-4o-mini", "2026-01-01") === null);
    const top = platformAiReserveUsd("gpt-5.5", TODAY)!;
    check("the Preview TEST default operator cap fits at least one turn on the most expensive priced model", top > 0 && top < PLATFORM_AI_SPEND_TEST_DEFAULTS.operatorUsd, top);
  }

  console.log("\n3. the decision (operator → platform; this turn's own reserve included)");
  {
    const ok = resolvePlatformAiSpendCaps(caps("1", "2", "production"));
    const reserve = 0.1;
    const g = (usd: number) => [{ provider: "OPENAI", model: "gpt-4o-mini", invocations: 1, promptTokens: 0, cachedPromptTokens: 0, completionTokens: Math.round(usd / 0.6e-6) }];
    const d = (opUsd: number, plUsd: number, opIn = 0, plIn = 0, r: number | null = reserve) =>
      platformAiSpendDecision({ caps: ok, operatorGroups: g(opUsd), platformGroups: g(plUsd), todayISO: TODAY, operatorInFlight: opIn, platformInFlight: plIn, reserveUsd: r });
    const under = d(0.5, 0.5);
    check("under both caps ⇒ admitted (remaining = cap − spent − reserve)", under.allowed && Math.abs(under.operatorRemainingUsd - 0.4) < 1e-6 && Math.abs(under.platformRemainingUsd - 1.4) < 1e-6, under);
    check("operator spent ≥ cap ⇒ COST_CAP OPERATOR", (() => { const v = d(1, 1); return !v.allowed && v.detail === "COST_CAP" && v.scope === "OPERATOR"; })());
    check("operator spent + reserve > cap ⇒ COST_CAP OPERATOR (the turn's worst case must fit)", (() => { const v = d(0.95, 0.95); return !v.allowed && v.detail === "COST_CAP" && v.scope === "OPERATOR"; })());
    {
      const spent = sumTodaySpend(g(0.9), TODAY).spentUsd; // what the rate card makes of it
      check("operator spent + reserve = cap exactly ⇒ admitted (the worst case lands ON the cap)", d(0.9, 0.9, 0, 0, 1 - spent).allowed, spent);
    }
    check("operator in-flight reserves count: 0.5 + (4 + 1) × 0.1 = 1.0 ≤ 1 admitted; 5 in flight ⇒ refused",
      d(0.5 - 1e-9, 0.5, 4, 4).allowed && (() => { const v = d(0.5, 0.5, 5, 5); return !v.allowed && v.detail === "COST_CAP" && v.scope === "OPERATOR"; })());
    check("platform spent + reserve > cap (operator fine) ⇒ COST_CAP PLATFORM", (() => { const v = d(0.1, 1.95); return !v.allowed && v.detail === "COST_CAP" && v.scope === "PLATFORM"; })());
    check("platform in-flight of OTHER operators count", (() => { const v = d(0.1, 1.5, 0, 5); return !v.allowed && v.detail === "COST_CAP" && v.scope === "PLATFORM"; })());
    check("cap 0 refuses every turn", (() => { const z = resolvePlatformAiSpendCaps(caps("0", "50", "production")); const v = platformAiSpendDecision({ caps: z, operatorGroups: [], platformGroups: [], todayISO: TODAY, operatorInFlight: 0, platformInFlight: 0, reserveUsd: reserve }); return !v.allowed && v.detail === "COST_CAP"; })());
    check("unpriced model (reserve null) ⇒ UNAVAILABLE UNPRICED", (() => { const v = d(0, 0, 0, 0, null); return !v.allowed && v.detail === "UNAVAILABLE" && v.cause === "UNPRICED"; })());
    const unpricedRow = [{ provider: "OPENAI", model: "gpt-unknown", invocations: 1, promptTokens: 10, cachedPromptTokens: 0, completionTokens: 10 }];
    check("an unpriced row today (operator) ⇒ UNAVAILABLE UNPRICED, whatever the priced part sums to",
      (() => { const v = platformAiSpendDecision({ caps: ok, operatorGroups: unpricedRow, platformGroups: unpricedRow, todayISO: TODAY, operatorInFlight: 0, platformInFlight: 0, reserveUsd: reserve }); return !v.allowed && v.detail === "UNAVAILABLE" && v.cause === "UNPRICED"; })());
    check("an unpriced row of ANOTHER operator ⇒ UNAVAILABLE UNPRICED (the platform spend is unknown)",
      (() => { const v = platformAiSpendDecision({ caps: ok, operatorGroups: [], platformGroups: unpricedRow, todayISO: TODAY, operatorInFlight: 0, platformInFlight: 0, reserveUsd: reserve }); return !v.allowed && v.detail === "UNAVAILABLE" && v.cause === "UNPRICED"; })());
    check("caps REFUSE ⇒ UNAVAILABLE with the cap's cause", (() => { const v = platformAiSpendDecision({ caps: resolvePlatformAiSpendCaps(caps(undefined, undefined, "production")), operatorGroups: [], platformGroups: [], todayISO: TODAY, operatorInFlight: 0, platformInFlight: 0, reserveUsd: reserve }); return !v.allowed && v.detail === "UNAVAILABLE" && v.cause === "CAP_MISSING"; })());
  }

  console.log("\n4. the reservation (fm_system transaction, locks, in-flight buckets)");
  {
    const prodCaps = caps("1", "2", "production");
    const reserve = platformAiReserveUsd(MODEL, TODAY)!;
    {
      const c = makeClient();
      const r = await reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: prodCaps, model: MODEL });
      check("admitted under the caps; ONE in-flight reservation held on the operator's key", r.verdict.allowed && c.inflight() === 1 && c.buckets.has(`${platformAiInflightKey("op_a")}@${inflightBucket(NOW).toISOString()}`), [...c.buckets]);
      check("the operator lock, THEN the fleet lock (one order — no deadlock)", c.locks.length === 2 && c.locks[0] === platformAiSpendLockKey("op_a") && c.locks[1] === PLATFORM_AI_SPEND_FLEET_LOCK_KEY, c.locks);
      const where = (c.reads[0] as { where: Record<string, unknown> }).where;
      check("the ledger read: surface platform_ai, RETURNED only, since UTC midnight; every operator (the operator's are a subset)",
        where.surface === "platform_ai" && where.outcome === "RETURNED" && (where.occurredAt as { gte: Date }).gte.toISOString() === "2026-11-10T00:00:00.000Z" && !("userId" in where), where);
      const sel = (c.reads[0] as { select: Record<string, unknown> }).select;
      check("selects ids + token counts only (no content column exists; none is asked for)", Object.keys(sel).sort().join() === "cachedPromptTokens,completionTokens,model,promptTokens,provider,userId", sel);
      await r.release(); await r.release();
      check("release returns the slot; idempotent (never below 0)", c.inflight() === 0);
    }
    {
      // Concurrency: cap $1 at this model's reserve ⇒ exactly floor(1 / reserve) turns fit; 2× that arrive at once.
      const c = makeClient();
      const fit = Math.floor(1 / reserve);
      const n = fit * 2;
      const { value: outs } = await quiet(() => Promise.all(Array.from({ length: n }, () => reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: prodCaps, model: MODEL }))));
      const admitted = outs.filter((o) => o.verdict.allowed).length;
      check(`${n} simultaneous turns, room for ${fit}: exactly ${fit} admitted, the rest COST_CAP OPERATOR (no overshoot)`,
        admitted === fit && outs.filter((o) => !o.verdict.allowed).every((o) => !o.verdict.allowed && o.verdict.detail === "COST_CAP" && o.verdict.scope === "OPERATOR"), { admitted, fit });
      await Promise.all(outs.map((o) => o.release()));
      check("…all released ⇒ nothing held; the next turn is admitted again", c.inflight() === 0 && (await reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: prodCaps, model: MODEL })).verdict.allowed);
    }
    {
      // Platform cap across operators: $2 platform, $1 operator ⇒ two operators fill it between them.
      const c = makeClient();
      const per = Math.floor(1 / reserve);
      const total = Math.floor(2 / reserve);
      const ops = ["op_a", "op_b", "op_c"];
      const { value: outs } = await quiet(() => Promise.all(ops.flatMap((op) => Array.from({ length: per }, () => reservePlatformAiSpend(op, NOW, { client: c.client, caps: prodCaps, model: MODEL })))));
      const admitted = outs.filter((o) => o.verdict.allowed).length;
      const platformRefused = outs.filter((o) => !o.verdict.allowed && o.verdict.detail === "COST_CAP" && o.verdict.scope === "PLATFORM").length;
      check(`three operators × ${per} simultaneous turns, platform room for ${total}: exactly ${total} admitted, the rest COST_CAP PLATFORM`, admitted === total && platformRefused === outs.length - total, { admitted, total, platformRefused });
    }
    {
      const c = makeClient({ rows: [rowCosting("op_a", 1)] });
      const { value: r, lines } = await quiet(() => reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: prodCaps, model: MODEL }));
      check("operator spent today ≥ cap ⇒ COST_CAP OPERATOR, nothing reserved", !r.verdict.allowed && r.verdict.detail === "COST_CAP" && r.verdict.scope === "OPERATOR" && c.inflight() === 0, r.verdict);
      check("…logged as codes only (scope enum; no id, no figure)", lines.length === 1 && /cost cap reached: scope=OPERATOR/.test(lines[0]) && !/op_a|\$|\d\.\d/.test(lines[0]), lines);
      const other = await quiet(() => reservePlatformAiSpend("op_b", NOW, { client: c.client, caps: prodCaps, model: MODEL }));
      check("another operator is unaffected by op_a's operator cap (platform $2 not reached)", other.value.verdict.allowed);
    }
    {
      const c = makeClient({ rows: [rowCosting("op_x", 1.99)] });
      const { value: r } = await quiet(() => reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: prodCaps, model: MODEL }));
      check("other operators' spend fills the platform cap ⇒ COST_CAP PLATFORM", !r.verdict.allowed && r.verdict.detail === "COST_CAP" && r.verdict.scope === "PLATFORM", r.verdict);
    }
    {
      const c = makeClient({ txFails: true });
      const { value: r, lines } = await quiet(() => reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: prodCaps, model: MODEL }));
      check("the transaction cannot run ⇒ REFUSED RESERVATION_UNAVAILABLE (fail closed), codes-only log", !r.verdict.allowed && r.verdict.detail === "UNAVAILABLE" && r.verdict.cause === "RESERVATION_UNAVAILABLE" && lines.every((l) => !/op_a/.test(l)), r.verdict);
    }
    {
      const c = makeClient({ ledgerFailures: 3 });
      const { value: r } = await quiet(() => reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: prodCaps, model: MODEL }));
      check("the AI ledger has been failing its writes ⇒ REFUSED LEDGER_UNTRUSTED, nothing reserved", !r.verdict.allowed && r.verdict.detail === "UNAVAILABLE" && r.verdict.cause === "LEDGER_UNTRUSTED" && c.inflight() === 0, r.verdict);
    }
    {
      const c = makeClient();
      const { value: r } = await quiet(() => reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: prodCaps, model: "gpt-unknown" }));
      check("an unpriced model ⇒ REFUSED UNPRICED, nothing reserved", !r.verdict.allowed && r.verdict.detail === "UNAVAILABLE" && r.verdict.cause === "UNPRICED" && c.inflight() === 0, r.verdict);
    }
    for (const [label, input, cause] of [
      ["production + MISSING", caps(undefined, undefined, "production"), "CAP_MISSING"],
      ["unknown env (absent) + MISSING", caps(undefined, undefined, undefined), "CAP_MISSING"],
      ["preview + INVALID", caps("ten", "50", "preview"), "CAP_INVALID"],
    ] as const) {
      const c = makeClient();
      const { value: r } = await quiet(() => reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: input, model: MODEL }));
      check(`${label} ⇒ REFUSED ${cause} before any transaction (no lock, no read, nothing reserved)`, !r.verdict.allowed && r.verdict.detail === "UNAVAILABLE" && r.verdict.cause === cause && c.locks.length === 0 && c.reads.length === 0 && c.inflight() === 0, r.verdict);
    }
    {
      const c = makeClient();
      const r = await reservePlatformAiSpend("op_a", NOW, { client: c.client, caps: caps(undefined, undefined, "preview"), model: MODEL });
      check("preview + MISSING ⇒ the test default caps admit the turn", r.verdict.allowed && r.verdict.operatorRemainingUsd < PLATFORM_AI_SPEND_TEST_DEFAULTS.operatorUsd, r.verdict);
    }
  }

  console.log("\n5. the handlers (refused before any provider call / store write; released after the turn)");
  {
    const binding = { surfaceLabel: "Ops", listMetrics: () => [], describeMetric: () => null, readMetric: async () => null, listPages: () => [], resolvePage: () => null } as unknown as PlatformAiBinding;
    const gate = (verdict: PlatformAiSpendGate["verdict"], log: string[]): PlatformAiSpendGate => ({ verdict, release: async () => { log.push("release"); } });
    const ask = (log: string[], spend: PlatformAiAskDeps["spend"], generate?: PlatformAiAskDeps["generate"]): PlatformAiAskDeps => ({
      enabled: true, operatorId: "op_1", binding,
      admission: async () => { log.push("admission"); return { paused: false, state: "OFF" }; },
      freeze: async () => { log.push("freeze"); return { frozen: false, state: "OFF" }; },
      turns: async () => { log.push("turns"); return { allowed: true, remaining: 5 }; },
      spend,
      generate: generate ?? (async () => { log.push("generate"); return { content: "ok", toolCalls: [], raw: { role: "assistant", content: "ok" }, usage: null }; }),
      model: MODEL, now: () => NOW, classify: () => "PROVIDER",
    });
    {
      const log: string[] = [];
      const r = await handlePlatformAiAsk({ question: "hi" }, ask(log, async () => { log.push("spend"); return gate({ allowed: false, detail: "COST_CAP" }, log); }));
      check("ask: COST_CAP ⇒ 429 reason COST_CAP, Retry-After to UTC midnight, the existing AI_UNAVAILABLE shape",
        r.status === 429 && r.body.code === "AI_UNAVAILABLE" && r.body.reason === "COST_CAP" && r.headers?.["Retry-After"] === String(13 * 3600 + 30), r);
      check("ask: …gate order kill switch → freeze → daily turns → $ caps, and NO provider request", log.join() === "admission,freeze,turns,spend", log);
    }
    for (const [label, spend] of [
      ["UNAVAILABLE (caps missing/invalid, ledger, lock)", async () => gate({ allowed: false, detail: "UNAVAILABLE" }, [])],
      ["a throwing reservation", async () => { throw new Error("boom"); }],
    ] as const) {
      const log: string[] = [];
      const r = await handlePlatformAiAsk({ question: "hi" }, ask(log, spend as PlatformAiAskDeps["spend"]));
      check(`ask: ${label} ⇒ 503 ALLOWANCE_UNAVAILABLE (fail closed), no provider request`, r.status === 503 && r.body.reason === "ALLOWANCE_UNAVAILABLE" && !log.includes("generate"), r);
    }
    {
      const log: string[] = [];
      const r = await handlePlatformAiAsk({ question: "hi" }, ask(log, async () => gate({ allowed: true }, log)));
      check("ask: admitted ⇒ the turn runs, THEN the reservation is released (once)", r.status === 200 && log.join() === "admission,freeze,turns,generate,release", log);
    }
    {
      const log: string[] = [];
      const r = await handlePlatformAiAsk({ question: "hi" }, ask(log, async () => gate({ allowed: true }, log), async () => { log.push("generate"); throw new Error("provider down"); }));
      check("ask: a failing turn still releases the reservation", r.status === 503 && log[log.length - 1] === "release" && log.filter((x) => x === "release").length === 1, log);
    }
    {
      const log: string[] = [];
      const r = await handlePlatformAiAsk({ question: "hi" }, { ...ask(log, undefined), turns: async () => { log.push("turns"); return { allowed: false, detail: "DAILY_TURNS", remaining: 0 }; }, spend: async () => { log.push("spend"); return gate({ allowed: true }, log); } });
      check("ask: the daily TURN cap refuses first — the $ reservation is never taken", r.status === 429 && r.body.reason === "DAILY_TURNS" && !log.includes("spend"), log);
    }

    // Conversations: create + append.
    const conv = { id: "c".repeat(25), area: "PLATFORM_OPS", createdAt: NOW, lastMessageAt: NOW, deletedAt: null, firstQuestion: null };
    const access = { binding, scope: null } as unknown;
    const convDeps = (log: string[], spend: (() => Promise<PlatformAiSpendGate>) | undefined, kind: "LIMIT" | "FULL") => ({
      areaAccess: async () => access, now: () => NOW,
      admission: async () => ({ paused: false }), freeze: async () => ({ frozen: false }), turns: async () => ({ allowed: true }),
      ...(spend ? { spend: async () => { log.push("spend"); return spend(); } } : {}),
      runTurn: async () => { log.push("runTurn"); return { status: "FAILED", failureCode: "PROVIDER" }; },
      store: {
        findCreateConversation: async () => null,
        findLiveConversation: async () => ({ id: conv.id, area: "PLATFORM_OPS" }),
        findTurnPair: async () => null,
        createConversation: async () => { log.push("store"); return { kind }; },
        appendTurn: async () => { log.push("store"); return { kind }; },
      },
    }) as unknown as Parameters<typeof handleCreateConversation>[2];
    const v = { operatorId: "op_1", area: "PLATFORM_OPS" as const };
    const body = { clientRequestId: "6f1c1a52-4d9b-4c6e-9a3e-1b2c3d4e5f60", question: "hi" };
    {
      const log: string[] = [];
      const r = await handleCreateConversation(v, body, convDeps(log, async () => gate({ allowed: false, detail: "COST_CAP" }, log), "LIMIT"));
      check("create: COST_CAP ⇒ 429 COST_CAP + Retry-After, NOTHING stored, no turn", r.status === 429 && r.body?.reason === "COST_CAP" && r.headers?.["Retry-After"] === String(13 * 3600 + 30) && !log.includes("store") && !log.includes("runTurn"), { r, log });
      const log2: string[] = [];
      const r2 = await handleCreateConversation(v, body, convDeps(log2, async () => gate({ allowed: false, detail: "UNAVAILABLE" }, log2), "LIMIT"));
      check("create: unavailable ⇒ 503 ALLOWANCE_UNAVAILABLE, nothing stored", r2.status === 503 && r2.body?.reason === "ALLOWANCE_UNAVAILABLE" && !log2.includes("store"), { r2, log2 });
      const log3: string[] = [];
      const r3 = await handleCreateConversation(v, body, convDeps(log3, async () => gate({ allowed: true }, log3), "LIMIT"));
      check("create: admitted but no turn ran (conversation LIMIT) ⇒ the reservation is still released", r3.status === 409 && log3.join() === "spend,store,release", log3);
    }
    {
      const log: string[] = [];
      const r = await handleAppendMessage(v, conv.id, body, convDeps(log, async () => gate({ allowed: false, detail: "COST_CAP" }, log), "FULL"));
      check("append: COST_CAP ⇒ 429 COST_CAP, nothing stored, no turn", r.status === 429 && r.body?.reason === "COST_CAP" && !log.includes("store"), { r, log });
      const log2: string[] = [];
      const r2 = await handleAppendMessage(v, conv.id, body, convDeps(log2, async () => gate({ allowed: true }, log2), "FULL"));
      check("append: admitted, conversation FULL ⇒ released", r2.status === 409 && log2.join() === "spend,store,release", log2);
    }
  }

  console.log("\n6. static pins");
  {
    const routes = ["app/api/platform/ai/ask/route.ts", "app/api/platform/ai/conversations/route.ts", "app/api/platform/ai/conversations/[id]/messages/route.ts"];
    for (const r of routes) {
      const s = strip(r);
      check(`${r}: passes the $ reservation (reservePlatformAiSpend) with the runner's model, right after the daily turn cap`,
        /spend: \((id|uid), now\) => reservePlatformAiSpend\(\1, now, \{ model(: platformAiModel\(\)\.model)? \}\),/.test(s) && s.indexOf("turns: (") < s.indexOf("spend: ("), r);
    }
    const core = strip("lib/platform/intelligence/ai/core.ts");
    const h = core.slice(core.indexOf("export async function handlePlatformAiAsk"));
    check("core.ts handlePlatformAiAsk: daily turns → $ caps → the turn, released in finally",
      h.indexOf("deps.turns(") < h.indexOf("admitPlatformAiSpend(deps.spend") && h.indexOf("admitPlatformAiSpend(deps.spend") < h.indexOf("runPlatformAiTurn(") && /finally \{\s*await held\.release\(\);\s*\}/.test(h));
    const handlers = strip("lib/platform/intelligence/ai/conversations/handlers.ts");
    for (const [fn, store] of [["handleCreateConversation", "deps.store.createConversation("], ["handleAppendMessage", "deps.store.appendTurn("]] as const) {
      const b = handlers.slice(handlers.indexOf(`export async function ${fn}`));
      check(`handlers.ts ${fn}: admit (kill → freeze → turns) → holdSpend → store → turn, released in finally`,
        b.indexOf("await admit(v, deps)") < b.indexOf("await holdSpend(v, deps)") && b.indexOf("await holdSpend(v, deps)") < b.indexOf(store) && /finally \{\s*await cost\.held\.release\(\);\s*\}/.test(b));
    }
    const spendSrc = strip("lib/platform/ai/platform-ai-spend.ts");
    check("platform-ai-spend.ts: fm_system, never the migration principal", /import \{ systemDb \} from "@\/lib\/db"/.test(spendSrc) && !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*"@\/lib\/db"/.test(spendSrc));
    check("the two advisory locks are the FIRST statements of the transaction (operator, then fleet), via $executeRaw (P2010)",
      /\$transaction\(async \(tx\) => \{\s*await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(\$\{platformAiSpendLockKey\(operatorId\)\}\)\)`;\s*await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(\$\{PLATFORM_AI_SPEND_FLEET_LOCK_KEY\}\)\)`;/.test(spendSrc) && !/\$queryRaw/.test(spendSrc));
    check("no provider import — the model call is never inside the lock", !/@\/lib\/ai\/provider|intelligence\/ai\/ledger|openai/.test(spendSrc));
    const logs = spendSrc.split("\n").filter((l) => /console\.\w+\(/.test(l));
    check("every log line is codes only (no operatorId, no figure, no raw error object)", logs.length >= 3 && logs.every((l) => !/operatorId|Usd|spent|\berr\b|, e\)/.test(l)), logs);
    const coreSpend = strip("lib/platform/ai/platform-ai-spend.core.ts");
    check("platform-ai-spend.core.ts is pure: no db, env, clock or provider", !/@\/lib\/db|@\/lib\/env|process\.env|new Date\(|Date\.now|server-only|provider/.test(coreSpend));
    check("the reservation key family is its own (never the customer allowance's `user:ai-inflight:` prefix)", !platformAiInflightKey("x").startsWith("user:ai-inflight:"));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
void main();
