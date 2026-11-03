/**
 * lib/platform/ai/fleet-ceiling.test.ts  (SEC-AI-001 — the optional hard fleet AI spend ceiling)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/fleet-ceiling.test.ts
 *
 * Pins:
 *   1. the pure core — resolution (absent = OFF), the decision, the read-only text;
 *   2. ABSENT ⇒ the reservation is unchanged: no fleet lock, no fleet read, the
 *      same verdict as before;
 *   3. SET ⇒ a turn that would reach the ceiling is REFUSED (FLEET_CEILING_REACHED,
 *      the transient refusal path), nothing reserved;
 *   4. two concurrent edge reservations (different customers, real per-key
 *      locks in the fake) never overshoot — and WITHOUT the fleet lock they would;
 *   5. UNAVAILABLE fleet spend ⇒ admitted (fail open) and logged;
 *   6. the fleet lock is taken ONLY when a ceiling is set;
 *   7. the existing alert raises a critical `:ceiling:` signal, only when set;
 *   8. the setting is registered ABSENT_MEANS_OFF with no value; Budget & controls
 *      reads "Fleet daily ceiling: not set".
 * All fixtures synthetic. No live database.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { RESERVE_USD, allowanceRefusalBody, allowanceRefusalStatus } from "@/lib/ai/allowance-core";
import { reserveAiTurn, inflightBucket, inflightKey, type ReservationClient, type ReservationTx } from "./allowance-reservation";
import {
  FLEET_CEILING_LOCK_KEY, FLEET_CEILING_NOT_SET, FLEET_CEILING_SETTING_KEY,
  fleetCeilingDecision, fleetCeilingText, fleetCeilingUsdOf, resolveFleetCeiling,
} from "./fleet-ceiling.core";
import type { UserSpendGroup } from "./spend-health";
import { buildAiSpendHealth, getAiSpendHealth } from "./spend-health";
import { AI_SPEND_THRESHOLD_KEYS, loadAiSpendThresholds } from "./spend-thresholds";
import { evaluateAiSpendFleetHigh } from "@/lib/alerts/evaluate";
import { ALERT_RULES } from "@/lib/alerts/rules";
import { PlatformSettingKey, SETTING_DESCRIPTORS, validateSetting } from "@/lib/platform-settings";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});
const NOW = new Date("2026-10-15T10:30:00.000Z");
const DAY = "2026-10-15";
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** gpt-5.1: $1.25 / M prompt ⇒ `usd` dollars of spend as prompt tokens. */
const fleetGroup = (usd: number, over: Partial<UserSpendGroup> = {}): UserSpendGroup => ({
  userId: "u-other", provider: "OPENAI", model: "gpt-5.1", surface: "chat", day: DAY,
  invocations: 1, promptTokens: Math.round((usd / 1.25) * 1_000_000), cachedPromptTokens: 0, completionTokens: 0, ...over,
});

/**
 * A fake fm_system client with REAL per-key advisory locks: a transaction body
 * runs concurrently with others until it calls `pg_advisory_xact_lock(k)`,
 * which waits for every earlier holder of `k`; locks release at the body's end
 * (commit). `honourFleetLock: false` simulates the defect (no fleet lock).
 */
function makeClient(opts: { ceiling?: string | null; customerSpentUsd?: number; honourFleetLock?: boolean; fleetGroups?: UserSpendGroup[] } = {}) {
  const buckets = new Map<string, number>();
  const lockLog: string[] = [];
  const fleetReads: number[] = [];
  const held = new Map<string, Promise<void>>();
  const bucketKey = (key: string, w: Date) => `${key}@${w.toISOString()}`;
  const customerGroups = opts.customerSpentUsd
    ? [{ provider: "OPENAI", model: "gpt-5.1", _count: { _all: 1 }, _sum: { promptTokens: Math.round((opts.customerSpentUsd / 1.25) * 1_000_000), cachedPromptTokens: 0, completionTokens: 0 } }]
    : [];
  const settings = new Map<string, string>();
  if (opts.ceiling != null) settings.set(FLEET_CEILING_SETTING_KEY, opts.ceiling);
  const platformSetting = { findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { value: settings.get(where.key)! } : null) };
  const yieldTick = () => new Promise<void>((r) => setTimeout(r, 1));

  const makeTx = (releases: (() => void)[]): ReservationTx => ({
    aiInvocation: { groupBy: async () => customerGroups },
    platformSetting,
    $executeRaw: async (_q: TemplateStringsArray, ...v: unknown[]) => {
      const k = String(v[0]);
      lockLog.push(k);
      if (k === FLEET_CEILING_LOCK_KEY && opts.honourFleetLock === false) return 1;
      const prior = held.get(k) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => { release = r; });
      held.set(k, prior.then(() => mine));
      await prior;
      releases.push(release);
      return 1;
    },
    rateLimit: {
      findMany: async ({ where }: { where: { key: string | { startsWith: string }; windowStart: { in: Date[] } } }) => {
        // The statement's snapshot is taken at its START; the result arrives later
        // (a real round trip) — so concurrent bodies interleave as on Postgres.
        const ws = new Set(where.windowStart.in.map((d) => d.toISOString()));
        const out: { count: number }[] = [];
        for (const [bk, n] of buckets) {
          const [k, w] = bk.split("@");
          const keyOk = typeof where.key === "string" ? k === where.key : k.startsWith(where.key.startsWith);
          if (keyOk && ws.has(w) && n > 0) out.push({ count: n });
        }
        await yieldTick();
        return out;
      },
      upsert: async ({ where, create }: { where: { key_windowStart: { key: string; windowStart: Date } }; create: { count: number } }) => {
        const k = bucketKey(where.key_windowStart.key, where.key_windowStart.windowStart);
        const n = (buckets.get(k) ?? 0) + create.count; buckets.set(k, n); return { count: n };
      },
    },
  } as unknown as ReservationTx);

  const client = {
    aiInvocation: { groupBy: async () => customerGroups },
    platformSetting,
    $transaction: async <T,>(fn: (t: ReservationTx) => Promise<T>): Promise<T> => {
      const releases: (() => void)[] = [];
      try { return await fn(makeTx(releases)); }
      finally { for (const r of releases) r(); }
    },
    rateLimit: { updateMany: async ({ where, data }: { where: { key: string; windowStart: Date; count: { gt: number } }; data: { count: { decrement: number } } }) => { const k = bucketKey(where.key, where.windowStart); const n = buckets.get(k) ?? 0; if (n <= where.count.gt) return { count: 0 }; buckets.set(k, n - data.count.decrement); return { count: 1 }; } },
  } as unknown as ReservationClient;
  const fleetDeps = { groups: async () => { fleetReads.push(1); await yieldTick(); return opts.fleetGroups ?? []; } };
  const inflight = () => [...buckets.values()].reduce((a, b) => a + b, 0);
  return { client, fleetDeps, lockLog, fleetReads, inflight, buckets };
}

async function main() {
  console.log("1. the pure core");
  {
    check("absent row ⇒ OFF", resolveFleetCeiling(null).state === "OFF" && resolveFleetCeiling(undefined).state === "OFF");
    const s = resolveFleetCeiling("40");
    check("a valid row ⇒ SET with its dollars", s.state === "SET" && fleetCeilingUsdOf(s) === 40);
    check("0, negative, decimal, words, '' ⇒ INVALID (treated as no ceiling, never a $0 ceiling)",
      ["0", "-5", "2.5", "lots", "", "100001"].every((v) => resolveFleetCeiling(v).state === "INVALID"));
    const est = (usd: number | null, status: "ESTIMATED" | "PARTIAL" | "UNAVAILABLE" = "ESTIMATED") => ({ status, pricedUsd: usd, reason: usd === null ? "no customer invocation in the window could be priced" : null });
    check("ESTIMATED under ⇒ WITHIN", fleetCeilingDecision({ spend: est(5), ceilingUsd: 10, fleetInFlight: 0, reserveUsd: 0.5 }).outcome === "WITHIN");
    check("ESTIMATED at the line ⇒ REACHED (the next turn would cost something)", fleetCeilingDecision({ spend: est(10), ceilingUsd: 10, fleetInFlight: 0, reserveUsd: 0.5 }).outcome === "REACHED");
    check("in-flight reserves count: 9 + 2 × 0.5 ≥ 10 ⇒ REACHED", fleetCeilingDecision({ spend: est(9), ceilingUsd: 10, fleetInFlight: 2, reserveUsd: 0.5 }).outcome === "REACHED");
    check("PARTIAL is judged on its priced lower bound", fleetCeilingDecision({ spend: est(11, "PARTIAL"), ceilingUsd: 10, fleetInFlight: 0, reserveUsd: 0 }).outcome === "REACHED"
      && fleetCeilingDecision({ spend: est(3, "PARTIAL"), ceilingUsd: 10, fleetInFlight: 0, reserveUsd: 0 }).outcome === "WITHIN");
    const u = fleetCeilingDecision({ spend: est(null, "UNAVAILABLE"), ceilingUsd: 10, fleetInFlight: 50, reserveUsd: 0.5 });
    check("UNAVAILABLE ⇒ FAIL_OPEN with the reason (never blocks on unknown spend)", u.outcome === "FAIL_OPEN" && /could be priced/.test((u as { reason: string }).reason));
    check("Budget & controls text: off ⇒ 'Fleet daily ceiling: not set'", fleetCeilingText(null) === "Fleet daily ceiling: not set" && FLEET_CEILING_NOT_SET === fleetCeilingText(null));
    check("…set ⇒ the figure over the window", fleetCeilingText(1500) === "Fleet daily ceiling: $1,500 / 24 h");
  }

  console.log("\n2. ABSENT ⇒ unchanged: no fleet lock, no fleet read");
  {
    const { client, fleetDeps, lockLog, fleetReads, inflight } = makeClient({ ceiling: null, customerSpentUsd: 1.25, fleetGroups: [fleetGroup(999)] });
    const r = await reserveAiTurn("u1", 5, NOW, client, RESERVE_USD, fleetDeps);
    check("admitted on the customer allowance exactly as before", r.verdict.allowed && r.verdict.reservation === "RESERVED" && close(r.verdict.spentUsd, 1.25) && r.verdict.inFlight === 0);
    check("ONLY the customer lock was taken", lockLog.join() === "ai-allowance:u1", lockLog.join());
    check("the fleet ledger was never read (even with $999 of fleet spend there)", fleetReads.length === 0);
    check("one reservation held, released once", inflight() === 1 && (await r.release(), inflight() === 0));
    const invalid = makeClient({ ceiling: "nonsense", customerSpentUsd: 1.25, fleetGroups: [fleetGroup(999)] });
    const ri = await reserveAiTurn("u1", 5, NOW, invalid.client, RESERVE_USD, invalid.fleetDeps);
    check("an INVALID row behaves as absent (admitted, no fleet lock, no fleet read)", ri.verdict.allowed && invalid.lockLog.join() === "ai-allowance:u1" && invalid.fleetReads.length === 0);
  }

  console.log("\n3. SET ⇒ a turn that would reach the ceiling is refused");
  {
    const { client, fleetDeps, lockLog, inflight } = makeClient({ ceiling: "10", customerSpentUsd: 1.25, fleetGroups: [fleetGroup(10.5)] });
    const r = await reserveAiTurn("u1", 5, NOW, client, RESERVE_USD, fleetDeps);
    check("REFUSED FLEET_CEILING_REACHED while the customer is well under their own allowance",
      !r.verdict.allowed && r.verdict.reason === "FLEET_CEILING_REACHED" && close(r.verdict.spentUsd, 1.25) && r.verdict.allowanceUsd === 5);
    check("nothing reserved", inflight() === 0);
    check("customer lock FIRST, then the fleet lock (one lock order)", lockLog.join() === `ai-allowance:u1,${FLEET_CEILING_LOCK_KEY}`, lockLog.join());
    const v = r.verdict as Extract<typeof r.verdict, { allowed: false }>;
    const body = allowanceRefusalBody(v, "Conversations");
    check("the EXISTING refusal path: AI_ALLOWANCE code, the transient copy, 503 + Retry-After, the reason code",
      allowanceRefusalStatus(v) === 503 && body.code === "AI_ALLOWANCE" && body.reason === "FLEET_CEILING_REACHED" && body.retryable === true
        && body.error === allowanceRefusalBody({ ...v, reason: "RESERVATION_UNAVAILABLE" }, "Conversations").error);
    const under = makeClient({ ceiling: "10", customerSpentUsd: 1.25, fleetGroups: [fleetGroup(2)] });
    const ok = await reserveAiTurn("u1", 5, NOW, under.client, RESERVE_USD, under.fleetDeps);
    check("under the ceiling ⇒ admitted and reserved as before", ok.verdict.allowed && under.inflight() === 1);
    const exhausted = makeClient({ ceiling: "10", customerSpentUsd: 6, fleetGroups: [fleetGroup(2)] });
    const ex = await reserveAiTurn("u1", 5, NOW, exhausted.client, RESERVE_USD, exhausted.fleetDeps);
    check("a customer already refused by THEIR allowance takes no fleet lock (the customer verdict decides first)",
      !ex.verdict.allowed && ex.verdict.reason === "ALLOWANCE_EXHAUSTED" && exhausted.lockLog.join() === "ai-allowance:u1");
  }

  console.log("\n4. concurrent edge reservations never overshoot");
  {
    // Ceiling $1; fleet spent $0.70 ⇒ exactly ONE more turn fits (0.70 < 1; 0.70 + reserve ≥ 1).
    const spent = 0.70;
    check("fixture: one reserve crosses the line", spent < 1 && spent + RESERVE_USD >= 1, String(RESERVE_USD));
    const locked = makeClient({ ceiling: "1", fleetGroups: [fleetGroup(spent)] });
    const both = await Promise.all([
      reserveAiTurn("uA", 5, NOW, locked.client, RESERVE_USD, locked.fleetDeps),
      reserveAiTurn("uB", 5, NOW, locked.client, RESERVE_USD, locked.fleetDeps),
    ]);
    const admitted = both.filter((r) => r.verdict.allowed).length;
    check("WITH the fleet lock: exactly one of two simultaneous turns (two customers) is admitted", admitted === 1, both.map((r) => r.verdict.allowed ? "admit" : (r.verdict as { reason: string }).reason).join());
    check("…the other is FLEET_CEILING_REACHED, and only one reservation is held", both.some((r) => !r.verdict.allowed && r.verdict.reason === "FLEET_CEILING_REACHED") && locked.inflight() === 1);
    // The defect this lock exists for: the same race with the fleet lock NOT honoured admits both.
    const racy = makeClient({ ceiling: "1", fleetGroups: [fleetGroup(spent)], honourFleetLock: false });
    const raced = await Promise.all([
      reserveAiTurn("uA", 5, NOW, racy.client, RESERVE_USD, racy.fleetDeps),
      reserveAiTurn("uB", 5, NOW, racy.client, RESERVE_USD, racy.fleetDeps),
    ]);
    check("control: WITHOUT the fleet lock both are admitted (overshoot) — the lock is what prevents it",
      raced.every((r) => r.verdict.allowed) && racy.inflight() === 2);
    // An admitted turn elsewhere (any customer's bucket) counts fleet-wide.
    const busy = makeClient({ ceiling: "1", fleetGroups: [fleetGroup(spent)] });
    busy.buckets.set(`${inflightKey("u-elsewhere")}@${inflightBucket(NOW).toISOString()}`, 1);
    const r = await reserveAiTurn("uA", 5, NOW, busy.client, RESERVE_USD, busy.fleetDeps);
    check("another customer's in-flight turn is in the fleet count ⇒ refused", !r.verdict.allowed && r.verdict.reason === "FLEET_CEILING_REACHED" && r.verdict.inFlight === 0);
  }

  console.log("\n5. UNAVAILABLE fleet spend ⇒ fail open, logged");
  {
    const warn = console.warn; const lines: string[] = [];
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const unpriced = makeClient({ ceiling: "1", fleetGroups: [fleetGroup(50, { model: "gpt-unpriced-test" })] });
      const r = await reserveAiTurn("uA", 5, NOW, unpriced.client, RESERVE_USD, unpriced.fleetDeps);
      check("nothing in the window could be priced ⇒ ADMITTED (does not block on unknown spend)", r.verdict.allowed && unpriced.inflight() === 1);
      check("…and the fleet lock WAS taken (the ceiling is set; it judged and failed open)", unpriced.lockLog.includes(FLEET_CEILING_LOCK_KEY));
      const empty = makeClient({ ceiling: "1", fleetGroups: [] });
      const e = await reserveAiTurn("uA", 5, NOW, empty.client, RESERVE_USD, empty.fleetDeps);
      check("no customer calls in the window ⇒ ADMITTED", e.verdict.allowed);
    } finally { console.warn = warn; }
    check("both fail-open decisions were logged with the reason", lines.length === 2 && lines.every((l) => /fleet spend UNAVAILABLE/.test(l) && /fails open/.test(l)), lines.join(" | "));
  }

  console.log("\n6. the alert: the existing fleet rule raises a critical ceiling signal, only when set");
  {
    const rule = ALERT_RULES.find((r) => r.id === "ai-spend-fleet-high")!;
    const th = { fleetUsd: 10, userUsd: 3 };
    const base = buildAiSpendHealth([fleetGroup(12)], th, 24, NOW);
    const before = evaluateAiSpendFleetHigh(rule, base);
    const withCeiling = evaluateAiSpendFleetHigh(rule, { ...base, fleetCeilingUsd: 11 });
    check("no ceiling ⇒ the signals are exactly as before (no ceiling key)", !before.some((s) => s.dedupeKey.includes(":ceiling:")));
    const c = withCeiling.find((s) => s.dedupeKey === `ai-spend-fleet-high:ceiling:${DAY}`);
    check("ceiling reached ⇒ a CRITICAL `:ceiling:<day>` signal on the same rule", c?.severity === "critical" && /fleet daily ceiling of \$11/.test(c.summary));
    check("…beside the unchanged threshold signal", JSON.stringify(withCeiling.filter((s) => s !== c)) === JSON.stringify(before));
    check("ceiling not yet reached ⇒ no ceiling signal", !evaluateAiSpendFleetHigh(rule, { ...base, fleetCeilingUsd: 50 }).some((s) => s.dedupeKey.includes(":ceiling:")));
  }

  console.log("\n7. the settings source: the fleet threshold's own read");
  {
    const at = new Date("2026-10-01T00:00:00.000Z");
    const none = await loadAiSpendThresholds({ platformSetting: { findMany: async ({ where }) => { check("one query asks for the two thresholds AND the ceiling", where.key.in.includes(FLEET_CEILING_SETTING_KEY) && where.key.in.includes(AI_SPEND_THRESHOLD_KEYS.fleet)); return []; } } });
    check("no row ⇒ OFF", none.fleetCeiling?.state === "OFF");
    const set = await loadAiSpendThresholds({ platformSetting: { findMany: async () => [{ key: FLEET_CEILING_SETTING_KEY, value: "25", updatedAt: at }] } });
    check("a row ⇒ SET", set.fleetCeiling?.state === "SET" && fleetCeilingUsdOf(set.fleetCeiling!) === 25);
    const off = await getAiSpendHealth(24, { now: NOW, groups: async () => [fleetGroup(1)], thresholds: async () => none });
    check("getAiSpendHealth with no ceiling OMITS fleetCeilingUsd (byte-identical report)", !("fleetCeilingUsd" in off));
    const on = await getAiSpendHealth(24, { now: NOW, groups: async () => [fleetGroup(1)], thresholds: async () => set });
    check("…and carries it when set", on.fleetCeilingUsd === 25);
    const d = SETTING_DESCRIPTORS[PlatformSettingKey.AI_FLEET_DAILY_CEILING_USD];
    check("the key is registered under the core's constant", PlatformSettingKey.AI_FLEET_DAILY_CEILING_USD === FLEET_CEILING_SETTING_KEY && d.key === FLEET_CEILING_SETTING_KEY);
    check("ABSENT_MEANS_OFF, integer, CONTROL, resettable", d.missingRow === "ABSENT_MEANS_OFF" && d.valueType === "integer" && d.writeCapability === "CONTROL" && d.resettable);
    check("NO value: the documented default is empty and is not a valid ceiling", d.default === "" && !validateSetting(PlatformSettingKey.AI_FLEET_DAILY_CEILING_USD, d.default).ok);
    check("0 refused, 1 accepted (a ceiling is never $0)", !validateSetting(PlatformSettingKey.AI_FLEET_DAILY_CEILING_USD, "0").ok && validateSetting(PlatformSettingKey.AI_FLEET_DAILY_CEILING_USD, "1").ok);
  }

  console.log("\n8. no value is set, seeded or migrated; editing is not in this change");
  {
    const root = process.cwd();
    const strip = (rel: string) => readFileSync(path.join(root, rel), "utf8");
    const { execSync } = await import("node:child_process");
    const hits = execSync(`git grep -l "${FLEET_CEILING_SETTING_KEY}" -- prisma scripts || true`, { encoding: "utf8" }).trim();
    check("no migration, seed or script mentions the key", hits === "", hits);
    const types = strip("lib/platform/ai/cost-controls.types.ts");
    check("the ceiling is NOT a PATCH-able cost control (not in AI_COST_CONTROL_KEYS)", !/AI_COST_CONTROL_KEYS = \[[^\]]*fleetCeiling/.test(types));
    const widget = strip("components/platform/widgets/OpsAiBudgetWidget.tsx");
    check("Budget & controls renders the read-only ceiling line", /fleetCeilingText\(data\.controls\.fleetCeilingUsd \?\? null\)/.test(widget));
  }

  console.log(failures === 0 ? "\nAll fleet-ceiling checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
