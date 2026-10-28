/**
 * lib/usage/provider-budget.test.ts
 *
 * The shared daily provider budget (2026-10-28): one durable counter per
 * provider (ApiUsageCounter, provider ALCHEMY) that the Solana worker, Solana
 * sync history and Ethereum history all record into, and that the worker's
 * daily cap reads. Deterministic fakes only — no database, no network.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/usage/provider-budget.test.ts
 */

import { readFileSync } from "node:fs";
import {
  meterTotal, meterDelta, effectiveDailyUsage, splitLedgerCalls, usageMetric, recordProviderMeter, providerCallsOn,
  ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK, type UsageRecorder, type ProviderUsageClient,
} from "./provider-budget";
import { finalizedHead, readAccountStateAt, callBatchWithBackoff, type EthRpcTransport } from "@/lib/crypto/eth-history";
import { solHistoryBackfill, type SolBackfillJobDeps } from "@/jobs/sol-history-backfill";
import { workerConfig } from "@/lib/crypto/sol-backfill-worker.core";
import { emptyCheckpoint, serializeCheckpoint, parseCheckpoint, type SolBackfillCheckpoint } from "@/lib/crypto/sol-history-backfill.core";
import type { SolBackfillStore } from "@/lib/crypto/sol-history-backfill";
import type { PriceGapRun } from "@/lib/prices/price-gap";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A shared in-memory ApiUsageCounter: (provider|metric|unit|day) → count. */
function ledger(day: string) {
  const rows = new Map<string, number>();
  const record: UsageRecorder = async (provider, metric, unit, n) => {
    const k = `${provider}|${metric}|${unit}|${day}`;
    rows.set(k, (rows.get(k) ?? 0) + n);
  };
  const callsToday = (provider: string) => [...rows].filter(([k]) => k.startsWith(`${provider}|`) && k.endsWith(`|calls|${day}`)).reduce((a, [, n]) => a + n, 0);
  const split = (provider: string) => splitLedgerCalls([...rows].filter(([k]) => k.startsWith(`${provider}|`) && k.endsWith(`|calls|${day}`))
    .map(([k, n]) => ({ metric: k.split("|")[1], count: n })));
  return { rows, record, callsToday, split };
}

async function main() {
  console.log("core");
  {
    check("meterTotal sums methods and ignores junk", meterTotal({ a: 3, b: 4, c: Number.NaN, d: -2 }) === 7);
    check("meterDelta is what was not yet flushed", JSON.stringify(meterDelta({ a: 5, b: 2 }, { a: 3, b: 2 })) === JSON.stringify({ a: 2 }));
    check("metric = network:method", usageMetric(ALCHEMY_USAGE_NETWORK.SOLANA, "getTransaction") === "solana:getTransaction");
    check("budget = ledger(other) + max(ledger(solana), checkpoints): SOL checkpoints are a SUBSET of the Solana ledger, never added to it",
      effectiveDailyUsage({ ledger: { solana: 500, other: 0 }, checkpointCalls: 120 }) === 500);
    check("…a SOL run killed before its flush still counts via the checkpoints", effectiveDailyUsage({ ledger: { solana: 100, other: 0 }, checkpointCalls: 140 }) === 140);
    check("REVIEW FIX: ETH 3,000 + SOL checkpoints 2,000 + ledger-SOL 0 ⇒ 5,000 (a killed SOL run is not hidden under ETH calls)",
      effectiveDailyUsage({ ledger: { solana: 0, other: 3_000 }, checkpointCalls: 2_000 }) === 5_000);
    check("…ETH 3,000 + flushed SOL 2,000 (= checkpoints) ⇒ 5,000, not 7,000", effectiveDailyUsage({ ledger: { solana: 2_000, other: 3_000 }, checkpointCalls: 2_000 }) === 5_000);
    check("…an unreadable ledger falls back to the checkpoints", effectiveDailyUsage({ ledger: null, checkpointCalls: 37 }) === 37);
    check("the split is by metric prefix", JSON.stringify(splitLedgerCalls([{ metric: "solana:getTransaction", count: 5 }, { metric: "ethereum:eth_getBalance", count: 7 }, { metric: "solanaX", count: 1 }])) === JSON.stringify({ solana: 5, other: 8 }));
  }

  console.log("recording");
  {
    const L = ledger("2026-10-28");
    const meter: Record<string, number> = { getTransaction: 30, getSignaturesForAddress: 1 };
    const flushed: Record<string, number> = {};
    const n1 = await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, "solana", meter, { flushed, record: L.record });
    meter.getTransaction += 5;
    const n2 = await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, "solana", meter, { flushed, record: L.record });
    const n3 = await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, "solana", meter, { flushed, record: L.record });
    check("repeated flushes of one meter never double count", n1 === 31 && n2 === 5 && n3 === 0 && L.callsToday(ALCHEMY_USAGE_PROVIDER) === 36);
    check("one row per network:method, unit calls", L.rows.get("ALCHEMY|solana:getTransaction|calls|2026-10-28") === 35);
    const thrower: UsageRecorder = async () => { throw new Error("db down"); };
    let threw = false;
    try { await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, "solana", { x: 1 }, { record: thrower }); } catch { threw = true; }
    check("recording never throws (metering must not fail a sync)", !threw);

    const client: ProviderUsageClient = { apiUsageCounter: { findMany: async (a) => a.where.provider === "ALCHEMY" && a.where.unit === "calls" && a.where.day.toISOString() === "2026-10-28T00:00:00.000Z"
      ? [{ metric: "solana:getTransaction", count: BigInt(1000) }, { metric: "ethereum:eth_getBalance", count: BigInt(234) }] : [] } };
    const got = await providerCallsOn(client, ALCHEMY_USAGE_PROVIDER, "2026-10-28");
    check("providerCallsOn reads the day bucket, split Solana / other (BigInt-safe)", got?.solana === 1000 && got?.other === 234, JSON.stringify(got));
    const broken: ProviderUsageClient = { apiUsageCounter: { findMany: async () => { throw new Error("x"); } } };
    check("…and reads null, never throws, when unreadable", (await providerCallsOn(broken, ALCHEMY_USAGE_PROVIDER, "2026-10-28")) === null);
  }

  console.log("Ethereum transport metering (observation only)");
  {
    const bodies: unknown[] = [];
    const transport: EthRpcTransport = async (body) => {
      bodies.push(body);
      const calls = (Array.isArray(body) ? body : [body]) as Array<{ id: number; method: string }>;
      const res = calls.map((c) => ({ jsonrpc: "2.0", id: c.id,
        result: c.method === "eth_getBlockByNumber" ? { number: "0x10", timestamp: "0x5", hash: "0xh" } : c.method === "eth_getCode" ? "0x" : "0x1" }));
      return JSON.stringify(Array.isArray(body) ? res : res[0]);
    };
    const meter: Record<string, number> = {};
    const head = await finalizedHead({ transport, meter });
    await readAccountStateAt("0x000000000000000000000000000000000000abcd", 16, { transport, meter });
    check("a single call counts 1; a batch of 3 counts 3, by method",
      meter.eth_getBlockByNumber === 1 && meter.eth_getBalance === 1 && meter.eth_getTransactionCount === 1 && meter.eth_getCode === 1 && meterTotal(meter) === 4, JSON.stringify(meter));
    check("…and the requests and answers are unchanged", head.number === 16 && bodies.length === 2);
    const noMeter: unknown[] = [];
    await callBatchWithBackoff([{ method: "eth_chainId", params: [] }], async (b) => { noMeter.push(b); return JSON.stringify({ jsonrpc: "2.0", id: 0, result: "0x1" }); });
    check("without a meter the transport is the raw one", noMeter.length === 1);
  }

  console.log("one budget across the worker, Solana sync history and Ethereum history");
  {
    const DAY = "2026-10-28";
    const ADDR = "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN";
    const L = ledger(DAY);
    // Earlier today: an ETH history run (inline in a sync) and a SOL sync's head-only history.
    await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK.ETHEREUM, { eth_getBalance: 600, eth_getBlockByNumber: 300 }, { record: L.record });
    await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK.SOLANA, { getTransaction: 40, getSignaturesForAddress: 2 }, { record: L.record });
    // That SOL sync also stamped its checkpoint (a subset of the ledger).
    const mk = (id: string, over: Partial<SolBackfillCheckpoint> = {}) => serializeCheckpoint({ ...emptyCheckpoint(id, ADDR, `${DAY}T00:00:00Z`), usage: { dayISO: DAY, requests: 42 }, ...over });
    const cursors: Record<string, string | null> = { a: mk("a"), b: null };
    let t = Date.parse(`${DAY}T10:00:00Z`);
    const budgets: number[] = [];
    const world = (o: { gaps?: (ids: string[]) => PriceGapRun; regenLog?: string[] } = {}): SolBackfillJobDeps => ({
      now: () => t, sleep: async (ms) => { t += ms; },
      wakeStartedAt: async () => null,
      wallets: async () => Object.keys(cursors).map((id) => ({ accountId: id, connectionId: `c-${id}`, address: ADDR, cursor: cursors[id] })),
      claimLock: async () => true, renewLock: async () => true, releaseLock: async () => {},
      reconstruct: async ({ accountId, deps: d }) => {
        const deps = d!;
        budgets.push(deps.requestBudget ?? -1);
        const spend = Math.min(deps.requestBudget ?? 0, 50);
        for (let i = 0; i < spend; i++) { await deps.beforeRequest?.(); deps.meter!.getTransaction = (deps.meter!.getTransaction ?? 0) + 1; }
        t += 2_000;
        return { accountId, ok: true, derivedRowsWritten: spend > 0 ? 5 : 0, mode: spend > 0 ? "INCREMENTAL" : "NO_CHANGE", impactedFromISO: spend > 0 ? "2026-01-01" : null,
          backfill: { status: { state: "IMPORTING", historyFromISO: "2026-01-01" } as never, progressed: spend > 0, rowsWritten: 5, impactedFromISO: "2026-01-01", signaturesProcessed: spend, pagesFetched: 1, stoppedBecause: "BUDGET", failure: null } };
      },
      store: async (id): Promise<SolBackfillStore> => ({
        async readCursor() { return cursors[id] ?? null; }, async anchor() { return null; },
        async commit(c) { if (c.expectedCursor !== cursors[id]) throw new Error("cas"); cursors[id] = c.nextCursor; },
      }),
      regenerationEnabled: () => true,
      regenerate: async (id) => { o.regenLog?.push(`regen:${id}`); },
      providerUsageToday: async () => L.split(ALCHEMY_USAGE_PROVIDER),
      recordUsage: (meter, flushed) => recordProviderMeter(ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK.SOLANA, meter, { flushed, record: L.record }).then(() => {}),
      ...(o.gaps ? { acquirePriceGaps: async (ids: string[]) => o.gaps!(ids) } : {}),
    });
    const cfg = (cap: number) => ({ ...workerConfig({ SOL_BACKFILL_ENABLED: "true" }), dailyRequestCap: cap });

    const s1 = await solHistoryBackfill({ config: cfg(1_000), deps: world() });
    check("the worker's cap reads the SHARED ledger (942 = 900 ETH + 42 SOL sync), not the SOL checkpoints alone (42)",
      s1.providerRequestsUsedBefore === 942 && s1.dailyRequestsUsedBefore === 942, JSON.stringify(s1));
    check("…so the first wallet's allowance is cap − 942 = 58", budgets[0] === 58, budgets.join(","));
    check("…every request it sent is recorded on the ledger (942 + this run)", L.callsToday(ALCHEMY_USAGE_PROVIDER) === 942 + s1.requests.total && s1.requests.total > 0, `${L.callsToday(ALCHEMY_USAGE_PROVIDER)} ${s1.requests.total}`);
    check("…and never past the cap within the run", L.callsToday(ALCHEMY_USAGE_PROVIDER) <= 1_000);

    budgets.length = 0;
    const s2 = await solHistoryBackfill({ config: cfg(1_000), deps: world() });
    check("cap enforcement: once ETH + SOL syncs + the worker reach the cap, the next run sends nothing (DAILY_CAP)",
      s2.stoppedBecause === "DAILY_CAP" && budgets.length === 0 && s2.requests.total === 0, JSON.stringify({ s: s2.stoppedBecause, b: budgets, used: s2.dailyRequestsUsedBefore }));

    // Without the ledger wired (older deps), the checkpoints still bound it.
    const legacy = world(); delete legacy.providerUsageToday; delete legacy.recordUsage;
    const s3 = await solHistoryBackfill({ config: cfg(100_000), deps: legacy });
    check("checkpoint usage keeps working without the ledger", s3.providerRequestsUsedBefore === null && s3.dailyRequestsUsedBefore >= 42);

    // Price gaps: run before the regeneration; other holders whose history the new prices reach are marked pending.
    const order: string[] = [];
    const regenLog: string[] = [];
    cursors.a = mk("a", { usage: null, licensedFromISO: "2024-01-01", licensedToISO: DAY });
    cursors.b = mk("b", { usage: null, licensedFromISO: "2025-01-01", licensedToISO: DAY });
    cursors.c = mk("c", { usage: null, licensedFromISO: "2026-10-15", licensedToISO: DAY }); // already inside the old archive
    const gapRun = (ids: string[]): PriceGapRun => {
      order.push(`gaps:${ids.join()}`);
      return ids.includes("b") || order.length > 1 ? { decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null }
        : { decisions: [], acquired: 1, inserted: 334, failures: 0, instruments: [{ instrumentId: "SOL", earliestBeforeISO: "2026-09-27", earliestAfterISO: "2025-10-28" }], newlyPricedFromISO: "2025-10-28" };
    };
    const deps4 = world({ gaps: gapRun, regenLog });
    const regen = deps4.regenerate;
    deps4.regenerate = async (id, from, s) => { order.push(`regen:${id}`); return regen(id, from, s); };
    const big = await solHistoryBackfill({ config: { ...cfg(10_000_000), jobBudgetMs: 240_000 }, deps: deps4 });
    check("the price-gap pass runs BEFORE the wallet's regeneration", order[0] === "gaps:a" && order[1] === "regen:a", order.join(","));
    // b is later in the same run's work list, so the flag (also applied in memory) makes it regenerate THIS run and clear it.
    check("…a wallet whose licensed history starts before the old floor is flagged (marker = new floor) and revalued",
      parseCheckpoint(cursors.b, "b", ADDR)?.valuationCheckedFloorISO === "2025-10-28" && order.indexOf("regen:b") > order.indexOf("regen:a"), `${order.join(",")} ${cursors.b}`);
    check("…a wallet already inside the old archive is not", !parseCheckpoint(cursors.c, "c", ADDR)?.snapshotPendingFromISO);
    check("…counted, and the job self-continues", big.holdersMarkedPending === 1 && big.deferred > 0 && big.priceGaps.acquired === 1 && big.priceGaps.inserted === 334, JSON.stringify(big));
  }

  console.log("wiring");
  {
    const read = (f: string) => readFileSync(f, "utf8");
    const refresh = read("lib/crypto/wallet-history-refresh.ts");
    check("SOL sync history and ETH history record into the ALCHEMY budget; BTC does not",
      /metered\(ALCHEMY_USAGE_NETWORK\.SOLANA/.test(refresh) && /metered\(ALCHEMY_USAGE_NETWORK\.ETHEREUM/.test(refresh) && !/metered\([^)]*BTC/.test(refresh));
    // 2026-10-28: crash-safe — flushed while the run sends AND when it ends, refused or not.
    check("…flushed while the run sends and when it ends, refused or not",
      /incrementalMeter\(\(meter, flushed\) => recordProviderMeter\(ALCHEMY_USAGE_PROVIDER, network, meter, \{ flushed \}\)/.test(refresh) && /run\(m\.meter\)\.finally\(\(\) => m\.flush\(\)\)/.test(refresh));
    const eth = read("lib/crypto/eth-history.ts");
    check("every ETH transport is the metered one (one construction site)", /function buildTransport\(deps: EthHistoryDeps\): EthRpcTransport \{\s*return meteredTransport\(buildRawTransport\(deps\), deps\.meter\);/.test(eth));
    const job = read("jobs/sol-history-backfill.ts");
    check("the worker reads the ledger with fm_system and flushes after each wallet", /providerCallsOn\(systemDb, ALCHEMY_USAGE_PROVIDER/.test(job) && /summary\.walletsRun\+\+;\s*await flushUsage\(\);/.test(job));
    check("the shared counter is ApiUsageCounter through the one writer (no new table)", /recordApiUsage/.test(read("lib/usage/provider-budget.ts")) && !/model ProviderUsage/.test(read("prisma/schema.prisma")));
  }

  if (failures > 0) { console.error(`\nprovider-budget: ${failures} failed.`); process.exit(1); }
  console.log("\nprovider-budget: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
