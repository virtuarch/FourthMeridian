/**
 * lib/crypto/spl-history-prices.test.ts
 *
 * SPL history's FIRST-TIME QUOTE PROBE (parity with ERC-20): a mint sold before
 * capture began (verified held rows, no quote marker) is probed once through
 * the shared probe (token-history-probe.ts), then priced historically. Against
 * in-memory fakes only — no network, no database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/spl-history-prices.test.ts
 */

import {
  acquireSplHistoricalPrices, splProbeGate, SPL_PROBE_LEDGER, SPL_PROBE_USAGE_PROVIDER, SPL_PROBE_USAGE_METRIC, SPL_PROBE_USAGE_UNIT,
} from "./spl-history-prices";
import {
  ERC20_PROBE_LEDGER, ERC20_PROBE_USAGE_PROVIDER, ERC20_PROBE_USAGE_METRIC, ERC20_PROBE_USAGE_UNIT, ERC20_PROBE_RETRY_MS,
  erc20ProbeConfig, defaultProbeGate,
} from "./erc20-history-prices";
import { TOKEN_PROBE_RETRY_MS, tokenProbeConfig, probeAllowance } from "./token-history-probe";
import { splTokenAssetKey } from "./token-asset";
import { reconstructedTokenValuation, tokenValuationLimits } from "./token-valuation.core";
import { SPL_PRICE_RUN_SEVERITY } from "./spl-history.core";
import { solBackfillJobOutcome } from "@/jobs/sol-history-backfill";
import { acquireTokenHistoricalCloses } from "@/lib/prices/token-history-prices";
import { TOKEN_QUOTE_METRIC_PREFIX, COINGECKO_USAGE_PROVIDER } from "@/lib/prices/coingecko-budget";
import type { TokenQuoteTarget } from "@/lib/prices/current-quotes";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const KEY = splTokenAssetKey(MINT);
const ACC = "acc-sol";
const INST = "inst-bonk";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const TOKEN_META = { token: true, standard: "SPL", contract: MINT, decimals: 5, symbol: null, name: null };
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** A durable ApiUsageCounter shared by every "run" (the real gate reads and writes it). */
interface UsageRow { provider: string; metric: string; unit: string; count: number }

function world(o: { held?: "SOLD" | "NEVER"; ledgerBroken?: boolean } = {}) {
  const meta: Record<string, unknown> = { ...TOKEN_META };
  const usage: UsageRow[] = [];
  const inserted: Array<{ instrumentId: string; date: Date }> = [];
  const touched: string[] = [];
  const held = o.held ?? "SOLD";
  const client = {
    instrumentAlias: {
      findUnique: async (a: { select?: { instrumentId?: boolean } }) => { touched.push("instrumentAlias.findUnique"); return { instrumentId: INST, metadata: JSON.parse(JSON.stringify(meta)) }; },
      update: async ({ data }: { data: { metadata: Record<string, unknown> } }) => { touched.push("instrumentAlias.update"); for (const k of Object.keys(meta)) delete meta[k]; Object.assign(meta, data.metadata); return {}; },
    },
    positionObservation: {
      groupBy: async ({ where }: { where: { quantity?: unknown } }) => {
        touched.push("positionObservation.groupBy");
        if (held === "NEVER") return JSON.stringify(where.quantity) === JSON.stringify({ gt: 0 }) ? [] : [{ financialAccountId: ACC, instrumentId: INST, _max: { date: D("2026-03-01") } }];
        // Held Jan..Jun, sold to zero on Jul 1 (no balance today ⇒ no marker from capture).
        return JSON.stringify(where.quantity) === JSON.stringify({ gt: 0 })
          ? [{ financialAccountId: ACC, instrumentId: INST, _min: { date: D("2026-01-10") }, _max: { date: D("2026-06-30") } }]
          : [{ financialAccountId: ACC, instrumentId: INST, _max: { date: D("2026-07-01") } }];
      },
    },
    priceObservation: { createMany: async ({ data }: { data: Array<{ instrumentId: string; date: Date }> }) => { touched.push("priceObservation.createMany"); inserted.push(...data); return { count: data.length }; } },
    apiUsageCounter: {
      findMany: async ({ where }: { where: { provider: string; unit: string } }) => {
        touched.push(`apiUsageCounter.findMany:${where.provider}`);
        if (o.ledgerBroken && where.provider === SPL_PROBE_USAGE_PROVIDER) throw new Error("ledger unreadable");
        return usage.filter((r) => r.provider === where.provider && r.unit === where.unit).map((r) => ({ metric: r.metric, count: r.count }));
      },
    },
  };
  const recordUsage = async (provider: string, metric: string, unit: string, n: number) => {
    const r = usage.find((x) => x.provider === provider && x.metric === metric && x.unit === unit);
    if (r) r.count += n; else usage.push({ provider, metric, unit, count: n });
  };
  const probes: TokenQuoteTarget[] = [];
  /** The quote path's effect on the marker (as refreshCurrentTokenQuotes writes it). */
  const probe = (answer: "PRICED" | "THIN" | "UNLISTED" | "SILENT") => async (t: TokenQuoteTarget) => {
    probes.push(t);
    if (answer === "SILENT") throw new Error("vendor timeout");
    meta.quote = { attemptedAt: new Date(NOW).toISOString(), outcome: answer, ...(answer === "PRICED" ? { pricedAt: new Date(NOW).toISOString() } : {}) };
    return 1;
  };
  const acquire: typeof acquireTokenHistoricalCloses = (a) => acquireTokenHistoricalCloses({ ...a, now: new Date(NOW), historyDays: 365,
    budget: { remaining: async () => 50, record: async () => {}, pace: async () => {} },
    fetchCloses: async () => ({ configured: true, unlisted: false, closes: [{ dateISO: "2026-01-10", price: 0.00002 }, { dateISO: "2026-01-11", price: 0.00003 }] }) });
  const env = (e: Record<string, string> = {}) => ({ COINGECKO_DAILY_CALL_CAP: "250", COINGECKO_TOKEN_SHARE: "0.6", ...e });
  const gate = (e: Record<string, string> = {}) => splProbeGate(client as never, env(e), recordUsage);
  const run = (p: Partial<Parameters<typeof acquireSplHistoricalPrices>[0]> = {}) => acquireSplHistoricalPrices({
    client: client as never, accountId: ACC, mint: MINT, fromISO: "2026-01-10", toISO: "2026-10-27", enabled: true,
    acquire, probe: probe("PRICED"), probeGate: gate(), now: () => NOW, ...p,
  });
  const spentToken = (n: number) => usage.push({ provider: COINGECKO_USAGE_PROVIDER, metric: `${TOKEN_QUOTE_METRIC_PREFIX}:x`, unit: "calls", count: n });
  const probesRecorded = () => usage.filter((r) => r.provider === SPL_PROBE_USAGE_PROVIDER).reduce((a, r) => a + r.count, 0);
  return { client, meta, usage, inserted, touched, probes, probe, acquire, gate, run, spentToken, probesRecorded, recordUsage };
}

const valuation = (meta: unknown, closesFromISO: string | null) =>
  reconstructedTokenValuation({ licence: { fromISO: "2026-01-10", toISO: "2026-10-27" }, held: { fromISO: "2026-01-10", toISO: "2026-06-30" }, closesFromISO, closesToISO: closesFromISO ? "2026-06-30" : null }, meta);

async function main() {
  console.log("a sold SPL mint is probed once, then priced");
  {
    const w = world();
    const r1 = await w.run();
    check("a sold mint with verified held rows and no marker is quote-probed through the quote path (solana platform, its mint)",
      r1.probe === "PROBED" && w.probes.length === 1 && w.probes[0].platform === "solana" && w.probes[0].contract === MINT && w.probes[0].assetKey === KEY && w.probes[0].instrumentId === INST, JSON.stringify({ r1, p: w.probes }));
    check("…then its historical closes are acquired (it no longer vanishes from history)", r1.inserted === 2 && r1.earliestISO === "2026-01-10" && w.inserted.length === 2, JSON.stringify(r1));
    check("…and the probe is recorded under SPL_HISTORY / coingecko-probe / attempts (one attempt)",
      w.usage.length === 1 && w.usage[0].provider === "SPL_HISTORY" && w.usage[0].metric === "coingecko-probe" && w.usage[0].unit === "attempts" && w.usage[0].count === 1, JSON.stringify(w.usage));
    const r2 = await w.run({ now: () => NOW + 60_000 });
    check("a mint whose marker now exists (priced) is never probed again", r2.probe === "NOT_NEEDED" && w.probes.length === 1 && w.probesRecorded() === 1);
    check("a probe never touches balance rows or their coverage (no PositionObservation / PositionCoverage write)",
      w.touched.every((t) => !/positionCoverage|positionObservation\.(create|update|delete)/.test(t)), w.touched.join());
  }

  console.log("no probe when a marker already exists");
  {
    const w = world();
    w.meta.quote = { attemptedAt: new Date(NOW - 3_600_000).toISOString(), outcome: "PRICED", pricedAt: new Date(NOW - 3_600_000).toISOString() };
    const r = await w.run();
    check("a held-now mint (capture's PRICED marker) is not probed — and no attempt is counted", r.probe === "NOT_NEEDED" && w.probes.length === 0 && w.probesRecorded() === 0 && r.inserted === 2);
    const w2 = world();
    w2.meta.quote = { attemptedAt: new Date(NOW - 24 * 3_600_000).toISOString(), outcome: "THIN" };
    const r2 = await w2.run();
    check("a mint asked within the retry window (THIN a day ago) is not probed", r2.probe === "NOT_NEEDED" && w2.probes.length === 0);
    const r3 = await w2.run({ now: () => NOW + TOKEN_PROBE_RETRY_MS });
    check("…but is asked again once the window has passed", r3.probe === "PROBED" && w2.probes.length === 1);
    const w3 = world();
    const longAgo = new Date(NOW - 30 * 24 * 3_600_000).toISOString();
    w3.meta.quote = { attemptedAt: longAgo, outcome: "PRICED", pricedAt: longAgo };
    const r4 = await w3.run();
    check("a mint EVER priced is never probed, even long after its last quote (the shared path decides)", r4.probe === "NOT_NEEDED" && w3.probes.length === 0 && r4.inserted === 2);
    const w4 = world();
    w4.meta.quote = { attemptedAt: new Date(NOW - 3_600_000).toISOString(), outcome: "THIN", pricedAt: longAgo };
    const r5 = await w4.run();
    check("a once-priced mint that has gone THIN is not probed and not priced historically — NO_MARKET, not excluded",
      r5.probe === "NOT_NEEDED" && w4.probes.length === 0 && r5.inserted === 0 && valuation(w4.meta, null) === "NO_MARKET", JSON.stringify(r5));
  }

  console.log("never held");
  {
    const w = world({ held: "NEVER" });
    const r = await w.run();
    check("a never-held mint (zero-value spam rows only) is not probed, and spends no allowance read",
      r.probe === "NEVER_HELD" && w.probes.length === 0 && w.probesRecorded() === 0 && !w.touched.some((t) => t.startsWith(`apiUsageCounter.findMany:${SPL_PROBE_USAGE_PROVIDER}`)), JSON.stringify({ r, t: w.touched }));
  }

  console.log("the durable cap");
  {
    const w = world();
    let sent = 0;
    const counting = async (t: TokenQuoteTarget) => { sent++; void t; return 1; };
    for (let runNo = 0; runNo < 96; runNo++) { // a day of 15-minute wakes, a fresh gate (fresh process) each time
      delete w.meta.quote; // still never priced
      await w.run({ probe: counting, probeGate: w.gate({ SPL_HISTORY_PROBE_DAILY_CAP: "5" }), now: () => NOW + runNo * 900_000 });
    }
    check("probes per day never exceed SPL_HISTORY_PROBE_DAILY_CAP, however many runs (counted on the durable ledger)", sent === 5 && w.probesRecorded() === 5, `${sent} / ${w.probesRecorded()}`);
    delete w.meta.quote;
    const r = await w.run({ probe: counting, probeGate: w.gate({ SPL_HISTORY_PROBE_DAILY_CAP: "5" }) });
    check("…at the cap the mint is REFUSED (left NOT_VALUED_YET), never priced, never $0", r.probe === "REFUSED" && sent === 5 && r.inserted === 0 && valuation(w.meta, null) === "NOT_VALUED_YET");
    check("the default cap equals ERC-20's (20), each read from its own env name",
      tokenProbeConfig(SPL_PROBE_LEDGER, {}).dailyCap === erc20ProbeConfig({}).dailyCap && erc20ProbeConfig({}).dailyCap === 20
      && tokenProbeConfig(SPL_PROBE_LEDGER, { SPL_HISTORY_PROBE_DAILY_CAP: "3", ERC20_HISTORY_PROBE_DAILY_CAP: "9" }).dailyCap === 3
      && erc20ProbeConfig({ SPL_HISTORY_PROBE_DAILY_CAP: "3", ERC20_HISTORY_PROBE_DAILY_CAP: "9" }).dailyCap === 9);
    // ERC-20 probes on the same ledger do not spend SPL's cap (separate provider rows).
    const w2 = world();
    await w2.recordUsage(ERC20_PROBE_USAGE_PROVIDER, ERC20_PROBE_USAGE_METRIC, ERC20_PROBE_USAGE_UNIT, 20);
    const r2 = await w2.run();
    check("SPL's cap is its own: 20 ERC-20 probes today leave SPL's allowance untouched", r2.probe === "PROBED" && w2.probesRecorded() === 1);
  }

  console.log("the held reserve");
  {
    // Token share = floor(250 × 0.6) = 150; reserve = ceil(150 × 0.5) = 75. Spent 75 ⇒ remaining 75 = the reserve.
    const w = world();
    w.spentToken(75);
    const r = await w.run();
    check("no probe once the TOKEN share is down to the held-quote reserve", r.probe === "REFUSED" && w.probes.length === 0 && w.probesRecorded() === 0, JSON.stringify(r));
    const w2 = world();
    w2.spentToken(74);
    const r2 = await w2.run();
    check("…one call above the reserve ⇒ the probe is allowed", r2.probe === "PROBED" && w2.probes.length === 1);
    const w3 = world();
    w3.spentToken(70);
    const r3 = await w3.run({ probeGate: w3.gate({ SPL_HISTORY_PROBE_HELD_RESERVE: "0.9" }) });
    check("the reserve is configurable (SPL_HISTORY_PROBE_HELD_RESERVE)", r3.probe === "REFUSED" && w3.probes.length === 0);
    // N3 — a non-integer share × reserve rounds the reserve UP (never spends into the held part).
    // Cap 252 × 0.6 ⇒ share floor(151.2) = 151; reserve ceil(151 × 0.5 = 75.5) = 76. Spent 75 ⇒ remaining 76 = the reserve.
    const w4 = world();
    w4.spentToken(75);
    const r4 = await w4.run({ probeGate: w4.gate({ COINGECKO_DAILY_CALL_CAP: "252" }) });
    check("N3: a fractional reserve (75.5) is rounded UP — at 76 remaining no probe is sent", r4.probe === "REFUSED" && w4.probes.length === 0, JSON.stringify(r4));
    check("N3: probeAllowance rounds the reserve up (151 × 0.5 ⇒ 76)",
      probeAllowance({ probesToday: 0, tokenRemaining: 80, tokenShareCap: 151, dailyCap: 20, heldReserve: 0.5 }) === 4);
  }

  console.log("an unreadable ledger");
  {
    const w = world({ ledgerBroken: true });
    const r = await w.run();
    check("an unreadable SPL_HISTORY ledger ⇒ no probe (REFUSED, reported), nothing priced, never $0",
      r.probe === "REFUSED" && w.probes.length === 0 && r.inserted === 0 && valuation(w.meta, null) === "NOT_VALUED_YET", JSON.stringify(r));
  }

  console.log("thin / unlisted ⇒ NO_MARKET; unanswered ⇒ NOT_VALUED_YET");
  for (const answer of ["THIN", "UNLISTED"] as const) {
    const w = world();
    const r = await w.run({ probe: w.probe(answer) });
    const v = valuation(w.meta, null);
    check(`a probed ${answer} mint is never priced historically and reads NO_MARKET — disclosed and limiting, NOT excluded`,
      r.probe === "PROBED" && r.inserted === 0 && w.inserted.length === 0 && v === "NO_MARKET" && tokenValuationLimits(v), JSON.stringify({ r, v }));
  }
  {
    const w = world();
    const r = await w.run({ probe: w.probe("SILENT") });
    const v = valuation(w.meta, null);
    check("an unanswered probe (vendor failure) leaves the mint NOT_VALUED_YET (disclosed, limiting), attempt still counted",
      r.probe === "PROBED" && r.inserted === 0 && v === "NOT_VALUED_YET" && tokenValuationLimits(v) && w.probesRecorded() === 1, JSON.stringify({ r, v }));
  }

  console.log("N1: a failed read is never a silent probe");
  {
    const w = world();
    (w.client.positionObservation as { groupBy: unknown }).groupBy = async () => { throw new Error("held-span read failed"); };
    const err = await w.run().then(() => null, (e: unknown) => e);
    check("N1: an unreadable held-span read throws to the run loop (which reports STEP_FAILED) — no probe sent, no attempt counted",
      err instanceof Error && /held-span/.test(err.message) && w.probes.length === 0 && w.probesRecorded() === 0);
    const w2 = world();
    (w2.client.instrumentAlias as { findUnique: unknown }).findUnique = async () => { throw new Error("alias read failed"); };
    const err2 = await w2.run().then(() => null, (e: unknown) => e);
    check("N1: an unreadable alias read throws to the run loop — no probe, nothing priced", err2 instanceof Error && w2.probes.length === 0 && w2.inserted.length === 0);
  }

  console.log("flag-gated");
  {
    const w = world();
    const r = await w.run({ enabled: false });
    check("with SPL_HISTORY_ENABLED off nothing is probed or counted", r.probe === "DISABLED" && w.probes.length === 0 && w.probesRecorded() === 0);
  }

  console.log("accounting: SPL ≠ ERC-20, ERC-20 unchanged");
  {
    check("SPL ledger = SPL_HISTORY / coingecko-probe / attempts, env SPL_HISTORY_PROBE_*",
      SPL_PROBE_USAGE_PROVIDER === "SPL_HISTORY" && SPL_PROBE_USAGE_METRIC === "coingecko-probe" && SPL_PROBE_USAGE_UNIT === "attempts"
      && SPL_PROBE_LEDGER.dailyCapEnv === "SPL_HISTORY_PROBE_DAILY_CAP" && SPL_PROBE_LEDGER.heldReserveEnv === "SPL_HISTORY_PROBE_HELD_RESERVE");
    check("ERC-20 ledger unchanged = ERC20_HISTORY / coingecko-probe / attempts, env ERC20_HISTORY_PROBE_*, 7-day window",
      ERC20_PROBE_USAGE_PROVIDER === "ERC20_HISTORY" && ERC20_PROBE_USAGE_METRIC === "coingecko-probe" && ERC20_PROBE_USAGE_UNIT === "attempts"
      && ERC20_PROBE_LEDGER.dailyCapEnv === "ERC20_HISTORY_PROBE_DAILY_CAP" && ERC20_PROBE_LEDGER.heldReserveEnv === "ERC20_HISTORY_PROBE_HELD_RESERVE"
      && ERC20_PROBE_RETRY_MS === 7 * 24 * 3_600_000);
    // The ERC-20 gate still reads and writes ITS rows only.
    const w = world();
    const units: string[] = [];
    const g = defaultProbeGate(w.client as never, { COINGECKO_DAILY_CALL_CAP: "250" }, async (p, m, u) => { units.push(`${p}/${m}/${u}`); });
    await g.allowance(); await g.record(1);
    check("the ERC-20 gate reads ERC20_HISTORY rows and records ERC20_HISTORY/coingecko-probe/attempts",
      w.touched.includes(`apiUsageCounter.findMany:${ERC20_PROBE_USAGE_PROVIDER}`) && !w.touched.includes(`apiUsageCounter.findMany:${SPL_PROBE_USAGE_PROVIDER}`) && units.join() === "ERC20_HISTORY/coingecko-probe/attempts", JSON.stringify({ t: w.touched, units }));
  }

  console.log("the job reports a refused probe");
  {
    const reason = "quote-probe allowance exhausted; never-priced SPL mint(s) left NOT_VALUED_YET for a later run";
    const job = solBackfillJobOutcome({ splPrices: { status: "ALLOWANCE_EXHAUSTED", reason, mintsSkipped: 1, wallets: 1 } });
    check("an ALLOWANCE_EXHAUSTED SPL price run ⇒ job outcome PARTIAL (SPL_PRICES_ALLOWANCE_EXHAUSTED)", job.outcome === "PARTIAL" && job.partialReasons[0] === `SPL_PRICES_ALLOWANCE_EXHAUSTED: ${reason}`, JSON.stringify(job));
    const failed = solBackfillJobOutcome({ splPrices: { status: "STEP_FAILED", reason: "SPL price/probe step failed; mint(s) not priced this run: x", mintsSkipped: 1, wallets: 1 } });
    check("N1: a STEP_FAILED SPL price run ⇒ job outcome PARTIAL (SPL_PRICES_STEP_FAILED)", failed.outcome === "PARTIAL" && /^SPL_PRICES_STEP_FAILED: SPL price\/probe step failed/.test(failed.partialReasons[0] ?? ""), JSON.stringify(failed));
    check("BUDGET_STOPPED outranks ALLOWANCE_EXHAUSTED (worst wins)", SPL_PRICE_RUN_SEVERITY.BUDGET_STOPPED > SPL_PRICE_RUN_SEVERITY.ALLOWANCE_EXHAUSTED && SPL_PRICE_RUN_SEVERITY.ALLOWANCE_EXHAUSTED > SPL_PRICE_RUN_SEVERITY.COMPLETE);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
