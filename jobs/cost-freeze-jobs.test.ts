/**
 * jobs/cost-freeze-jobs.test.ts  (BETA LIFECYCLE L2 — Cost Freeze enforcement, background work)
 *
 * Every background producer of paid provider work, driven with injected deps
 * (no database, no provider): under a refusal the provider seam is NEVER
 * reached, nothing is marked complete, no lock / claim / cooldown / retry is
 * consumed, checkpoints are untouched — and after the restriction lifts the
 * same work resumes from where it stopped. A global `fetch` trap fails the run
 * on any network call.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/cost-freeze-jobs.test.ts
 */

import "@/lib/test-support/route-env";
import { createBillableBatchGate, BILLABLE_BATCH_MAX_AGE_MS, type BillableDecision } from "@/lib/entitlements/billable-gate";
import { CATALOGUE_TTL_MS } from "@/lib/platform/policies/policy-group-catalogue";
import { classifyJobHealth } from "@/lib/jobs/health";
import { billedPriceAccountIds } from "@/lib/snapshots/regenerate-history";
import { readFileSync } from "node:fs";
import { billableSkipCode } from "@/lib/entitlements/billable-gate-core";
import { syncBanks, type SyncBanksCandidate } from "@/jobs/sync-banks";
import { resumeStaleImports } from "@/jobs/resume-stale-imports";
import { syncPlaidItemFromWebhook } from "@/lib/plaid/webhook-sync";
import { refreshScheduledWallets, type WalletRefreshDeps } from "@/lib/crypto/wallet-refresh";
import { resolveRefreshPolicy } from "@/lib/platform/refresh-policy.core";
import { solHistoryBackfill, type SolBackfillJobDeps } from "@/jobs/sol-history-backfill";
import { workerConfig } from "@/lib/crypto/sol-backfill-worker.core";
import { btcWorkerConfig } from "@/lib/crypto/btc-backfill-worker.core";
import { ethWorkerConfig, queuedCheckpoint, serializeCheckpoint as serializeEthCheckpoint } from "@/lib/crypto/eth-history-backfill.core";
import { emptyCheckpoint, serializeCheckpoint } from "@/lib/crypto/sol-history-backfill.core";
import { syncCrypto } from "@/jobs/sync-crypto";
import { fetchFxRates } from "@/jobs/fetch-fx-rates";
import { fetchSecurityPrices } from "@/jobs/fetch-security-prices";
import { readGlobalCostFreeze, judgeGlobalCostFreeze, type GlobalCostFreezeVerdict } from "@/lib/platform/cost-freeze";
import { billableForAccounts, billableForPlaidItem } from "@/lib/platform/policies/billable-subjects";
import type { StampedAdmissionVerdict } from "@/lib/platform/admission/types";
import type { WalletSyncOutcome } from "@/lib/crypto/wallet-sync-dispatch";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
  const { log, warn } = console; console.log = () => {}; console.warn = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; }
};

// ── The network trap: any provider call through fetch is a failure ───────────
let fetchCalls = 0;
globalThis.fetch = (async (input: unknown) => { fetchCalls++; throw new Error(`network call attempted in a frozen test: ${String(input)}`); }) as typeof fetch;

const ALLOW: BillableDecision = { allowed: true };
const FROZEN: BillableDecision = { allowed: false, reason: "COST_FREEZE" };
const decisions = (m: Record<string, BillableDecision>, dflt: BillableDecision = ALLOW) =>
  async (ids: readonly string[]) => new Map(ids.map((id) => [id, m[id] ?? dflt] as const));
const ADMIT_WORD = "ADMIT" as const;
const DENY_WORD = "DENY" as const;
const admitted = { decision: ADMIT_WORD, reason: null, label: null, evidence: null, authority: "PlatformSetting", evaluatedAt: "2026-10-31T00:00:00.000Z" } as unknown as StampedAdmissionVerdict;
const frozenFlag: GlobalCostFreezeVerdict = judgeGlobalCostFreeze("true");
const openFlag: GlobalCostFreezeVerdict = judgeGlobalCostFreeze(null);

async function main() {
  console.log("0. the batch gate — one policy read per batch, ≤ 30 s propagation, fail closed");
  {
    let reads = 0; let t = 0;
    let state: BillableDecision = ALLOW;
    const gate = createBillableBatchGate(["u1", "u2", null], "plaid_sync", { load: async (ids) => { reads++; return new Map(ids.map((i) => [i, state] as const)); }, clock: () => t });
    await gate.decide("u1"); await gate.decide("u2"); await gate.decide("u1");
    check("three decisions for a known batch = ONE policy read (not N+1)", reads === 1 && gate.reads === 1);
    check("no billed user ⇒ NO_OWNER, without a read", !(await gate.decide(null)).allowed && (await gate.decide(undefined) as { reason?: string }).reason === "NO_OWNER" && reads === 1);
    state = FROZEN; t += BILLABLE_BATCH_MAX_AGE_MS;
    check(`a decision is reused at most ${BILLABLE_BATCH_MAX_AGE_MS} ms (still the old answer at exactly the bound)`, (await gate.decide("u1")).allowed && reads === 1);
    t += 1;
    check("…then re-read: a freeze that landed mid-run stops the NEXT item", !(await gate.decide("u1")).allowed && reads === 2);
    check("the bound: catalogue TTL (20 s, from read start) + batch reuse (5 s) + a read under 5 s ≤ 30 s",
      CATALOGUE_TTL_MS + BILLABLE_BATCH_MAX_AGE_MS + 5_000 <= 30_000, { CATALOGUE_TTL_MS });
    const broken = createBillableBatchGate(["u1"], "plaid_sync", { load: async () => { throw new Error("db down"); } });
    const d = await quiet(() => broken.decide("u1"));
    check("a policy read that THROWS ⇒ POLICY_UNAVAILABLE (fail closed)", !d.allowed && (d as { reason: string }).reason === "POLICY_UNAVAILABLE");
    let r2 = 0;
    const g2 = createBillableBatchGate(["a"], "crypto_backfill", { load: async (ids) => { r2++; return new Map(ids.map((i) => [i, ALLOW] as const)); } });
    await g2.decide("a"); await g2.prime(["b", "c", "d"]); await g2.decide("b"); await g2.decide("d");
    check("late-discovered keys are primed with ONE read for all of them", r2 === 2);
  }

  console.log("1. sync-banks cron (transactions, balances, investment events, wealth rebuild)");
  {
    const items: SyncBanksCandidate[] = [
      { id: "i-frozen", userId: "u-frozen", institutionName: "A", investmentsConsent: "ENABLED" as never, encryptedToken: "x", lastSyncedAt: null },
      { id: "i-ok", userId: "u-ok", institutionName: "B", investmentsConsent: null, encryptedToken: "x", lastSyncedAt: null },
      { id: "i-orphan", userId: null, institutionName: "C", investmentsConsent: null, encryptedToken: "x", lastSyncedAt: null },
    ];
    let reads = 0;
    const processed: string[] = []; const denials: string[] = [];
    const run = (m: Record<string, BillableDecision>) => quiet(() => syncBanks({
      costFreeze: async () => openFlag,
      loadItems: async () => items.map((i) => ({ ...i })),
      admit: async () => ({ decision: ADMIT_WORD, reason: null }),
      billable: async (ids) => { reads++; return decisions(m)(ids); },
      recordDenial: async (it, reason) => { denials.push(`${it.id}:${billableSkipCode(reason)}`); },
      processItem: async (it) => { processed.push(it.id); return "succeeded"; },
    }));
    const r = await run({ "u-frozen": FROZEN });
    check("the frozen customer's Item never reaches the pipeline (no lock, no Plaid, no investment events, no rebuild)", !processed.includes("i-frozen"), processed);
    check("an Item with no connector is refused (NO_OWNER), never guessed", !processed.includes("i-orphan"));
    check("the allowed customer's Item still runs", processed.includes("i-ok"));
    check("each refusal is recorded as a SKIPPED fact with the billable skip code", denials.join() === "i-frozen:BILLABLE_COST_FREEZE,i-orphan:BILLABLE_NO_OWNER", denials);
    check("refusals are NOT `deferred` (the continuation does not spin) and are tallied by reason",
      r.deferred === 0 && r.planRestricted === 2 && r.planRestrictedReasons?.COST_FREEZE === 1 && r.planRestrictedReasons?.NO_OWNER === 1, r);
    check("ONE policy read for the whole batch", reads === 1);
    processed.length = 0; denials.length = 0;
    await run({});
    check("after unfreezing, the same Item runs on the next sweep (its cursor was never moved)", processed.includes("i-frozen") && denials.length === 1 /* the orphan */);
    processed.length = 0;
    const failed = await quiet(() => syncBanks({ costFreeze: async () => openFlag, loadItems: async () => items.slice(0, 2), admit: async () => ({ decision: ADMIT_WORD, reason: null }),
      billable: async () => { throw new Error("policy store down"); }, recordDenial: async () => {}, processItem: async (it) => { processed.push(it.id); return "succeeded"; } }));
    check("fail closed: policy read throws ⇒ every Item refused POLICY_UNAVAILABLE, zero pipeline calls", processed.length === 0 && failed.planRestrictedReasons?.POLICY_UNAVAILABLE === 2, failed);

    // Review P3-2 — the GLOBAL freeze is ONE job-level finding, not a row per Item.
    processed.length = 0; denials.length = 0;
    const g = await quiet(() => syncBanks({ costFreeze: async () => frozenFlag, loadItems: async () => items.map((i) => ({ ...i })),
      admit: async () => ({ decision: ADMIT_WORD, reason: null }), billable: decisions({}),
      recordDenial: async (it, reason) => { denials.push(`${it.id}:${reason}`); }, processItem: async (it) => { processed.push(it.id); return "succeeded"; } }));
    check("GLOBAL freeze: ONE job-level finding (outcome SKIPPED, BILLABLE_COST_FREEZE), zero per-Item rows, zero pipeline calls",
      g.outcome === "SKIPPED" && g.skipReason === "BILLABLE_COST_FREEZE" && denials.length === 0 && processed.length === 0 && g.deferred === 0, g);
  }

  console.log("1b. job health: a refused run is SKIPPED, never a success (review P2-2)");
  {
    const job = { name: "fetch-fx-rates", hourUTC: 6 } as never;
    const now = new Date("2026-10-31T12:00:00Z");
    const run = (summary: unknown) => ({ startedAt: new Date(now.getTime() - 3_600_000), status: "succeeded", completedAt: now, durationMs: 10, trigger: "cron", errorSummary: null, summary });
    const skipped = classifyJobHealth(job, [run({ outcome: "SKIPPED", skipReason: "BILLABLE_COST_FREEZE" })], now);
    check("a run whose summary says SKIPPED ⇒ status `skipped`, with its reason; not counted as a success",
      skipped.status === "skipped" && skipped.lastSkipReason === "BILLABLE_COST_FREEZE" && skipped.succeededRuns === 0 && skipped.skippedRuns === 1, skipped);
    const ok = classifyJobHealth(job, [run({ outcome: "COMPLETE" })], now);
    check("an ordinary run stays `healthy`", ok.status === "healthy" && ok.succeededRuns === 1 && ok.lastSkipReason === null);
  }

  console.log("1c. operator views read a skipped job as SKIPPED, never Overdue (follow-up N1)");
  {
    const { honestJobStatus } = await import("@/components/platform/ops-visual/ops-visual-model");
    const row = { job: "fetch-fx-rates", status: "skipped", lastRunStatus: "succeeded", consecutiveFailures: 0, totalRuns: 3, lastSkipReason: "BILLABLE_COST_FREEZE" } as never;
    const h = honestJobStatus(row, { state: "active" } as never);
    check("honestJobStatus: \"Skipped (cost freeze)\" with the recorded reason", h.kind === "skipped" && h.word === "Skipped (cost freeze)" && h.reason.includes("BILLABLE_COST_FREEZE"), h);
    const src = readFileSync("app/api/platform/platform-ops/job-health/route.ts", "utf8");
    check("the job-health route counts skipped jobs (the counts add up) and returns lastSkipReason",
      /else if \(j\.status === "skipped"\) counts\.skipped = \(counts\.skipped \?\? 0\) \+ 1;/.test(src) && /lastSkipReason:\s+j\.lastSkipReason,/.test(src));
  }

  console.log("2. resume-stale-imports cron");
  {
    const driven: string[] = []; let attempts = 0; let reads = 0;
    const run = (m: Record<string, BillableDecision>) => quiet(() => resumeStaleImports({
      loadCandidates: async () => ({ candidates: 2, items: [{ id: "p1", institutionName: "A", userId: "u-frozen" }, { id: "p2", institutionName: "B", userId: "u-ok" }] }),
      admit: async () => admitted,
      billable: async (ids) => { reads++; return decisions(m)(ids); },
      drive: async (id, _adm, billable) => { driven.push(id); return billable.allowed ? "ran" : "plan-restricted"; },
      recordAttempt: async () => { attempts++; }, resetCompleted: async () => {},
    }));
    const r = await run({ "u-frozen": FROZEN });
    check("the frozen Item is not driven (no lock, no marker rewrite, no Plaid)", !driven.includes("p1") && driven.includes("p2"), driven);
    check("…and is NOT an attempt: the backoff counter is unchanged", attempts === 1 /* p2 only */);
    check("…tallied as plan-restricted, with ONE policy read for the pass", r.planRestricted === 1 && reads === 1 && r.attempted === 1, r);
    driven.length = 0;
    await run({});
    check("after unfreezing, the import resumes (driven with an allowed decision)", driven.includes("p1"));

    // Review P1-1 — STARVATION: six frozen customers' stale Items are OLDER than an allowed one. The
    // page (5 slots) must not be held by refusals forever: restricted connectors are excluded from it.
    const population = [...Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, institutionName: "F", userId: `u-f${i}` })), { id: "ok1", institutionName: "OK", userId: "u-ok" }];
    const frozenUsers = Object.fromEntries(population.filter((p) => p.userId !== "u-ok").map((p) => [p.userId, FROZEN] as const));
    let starvedReads = 0;
    for (let pass = 1; pass <= 3; pass++) {
      const drove: string[] = [];
      const r = await quiet(() => resumeStaleImports({
        loadCandidateUsers: async () => [...new Set(population.map((p) => p.userId))],
        loadCandidates: async (_c, take, opts) => {
          const pool = population.filter((p) => !(opts?.excludeUserIds ?? []).includes(p.userId));
          return { candidates: pool.length, items: pool.slice(0, take) };
        },
        admit: async () => admitted,
        billable: async (ids) => { starvedReads++; return decisions(frozenUsers)(ids); },
        drive: async (id) => { drove.push(id); return "ran"; },
        recordAttempt: async () => {}, resetCompleted: async () => {},
      }));
      check(`pass ${pass}: 6 refused Items ahead of an allowed one ⇒ the allowed import IS driven (no starvation)`,
        drove.join() === "ok1" && r.attempted === 1 && r.planRestrictedUsers === 6, { drove, r });
    }
    check("…one policy read per pass", starvedReads === 3);

    // Follow-up N2 — EVERY connector restricted (the global freeze): one SKIPPED finding, nothing driven.
    const drove: string[] = []; let attempts2 = 0;
    const all = await quiet(() => resumeStaleImports({
      loadCandidateUsers: async () => ["u1", "u2"],
      loadCandidates: async () => ({ candidates: 2, items: [{ id: "a", institutionName: "A", userId: "u1" }, { id: "b", institutionName: "B", userId: "u2" }] }),
      admit: async () => admitted, billable: decisions({}, FROZEN),
      drive: async (id) => { drove.push(id); return "ran"; }, recordAttempt: async () => { attempts2++; }, resetCompleted: async () => {},
    }));
    check("every connector restricted ⇒ outcome SKIPPED (BILLABLE_COST_FREEZE), nothing driven, no backoff recorded",
      all.outcome === "SKIPPED" && all.skipReason === "BILLABLE_COST_FREEZE" && drove.length === 0 && attempts2 === 0 && all.attempted === 0, all);
  }

  console.log("3. the shared deferred-sync choke point (Plaid webhook, connect follow-on, resume-sync, resume-stale-imports)");
  {
    for (const [trigger, profile] of [["WEBHOOK", "RECONNECT"], ["RECONNECT", "RECONNECT"], ["RESUME", "IMPORT_RECOVERY"]] as const) {
      let pipeline = 0; const recorded: string[] = []; let asked: string | null = null;
      const out = await quiet(() => syncPlaidItemFromWebhook("item-1", trigger, profile, admitted, {
        checkBillable: async (_id, op) => { asked = op; return FROZEN; },
        recordDenial: async (p) => { recorded.push(String(p.admissionReason)); return { runId: "r" }; },
        runPipeline: async () => { pipeline++; return "ran"; },
      }));
      check(`${trigger}: refused before the lock and the pipeline (outcome plan-restricted, pipeline never reached)`, out === "plan-restricted" && pipeline === 0, out);
      check(`${trigger}: the deferred fact is ledgered with BILLABLE_COST_FREEZE (visible in Platform Ops; webhook still ACKs — the receiver schedules this in after())`,
        recorded.join() === "BILLABLE_COST_FREEZE" && asked !== null, { recorded, asked });
    }
    let pipeline = 0;
    const unavailable = await quiet(() => syncPlaidItemFromWebhook("item-1", "WEBHOOK", "RECONNECT", admitted, {
      checkBillable: async () => ({ allowed: false, reason: "POLICY_UNAVAILABLE" }), recordDenial: async () => ({ runId: "r" }), runPipeline: async () => { pipeline++; return "ran"; } }));
    check("fail closed: an unverifiable policy refuses too", unavailable === "plan-restricted" && pipeline === 0);
    const ok = await quiet(() => syncPlaidItemFromWebhook("item-1", "WEBHOOK", "RECONNECT", admitted, { billable: ALLOW, runPipeline: async () => { pipeline++; return "ran"; } }));
    check("an allowed (or batch-threaded) decision reaches the pipeline exactly once", ok === "ran" && pipeline === 1);
    const missing = await quiet(() => billableForPlaidItem("nope", "plaid_webhook_sync", { client: { plaidItem: { findUnique: async () => null }, financialAccount: { findMany: async () => [] } } }));
    check("an Item that cannot be found has no billing owner ⇒ NO_OWNER", !missing.allowed && (missing as { reason: string }).reason === "NO_OWNER");
    const deact = await quiet(() => billableForPlaidItem("i", "plaid_webhook_sync", { client: { plaidItem: { findUnique: async () => ({ userId: "u", user: { deactivatedAt: new Date() } }) }, financialAccount: { findMany: async () => [] } }, decideUser: async () => ALLOW }));
    check("a deactivated connector ⇒ refused (NOT_ENTITLED) even if the plan would allow", !deact.allowed);
    const thrown = await quiet(() => billableForPlaidItem("i", "plaid_webhook_sync", { client: { plaidItem: { findUnique: async () => { throw new Error("down"); } }, financialAccount: { findMany: async () => [] } } }));
    check("an owner read that throws ⇒ POLICY_UNAVAILABLE", !thrown.allowed && (thrown as { reason: string }).reason === "POLICY_UNAVAILABLE");
  }

  console.log("4. the scheduled wallet sweep (sync-crypto + continuation)");
  {
    const NOW = new Date("2026-10-31T12:00:00Z");
    const synced: string[] = []; const claimed: string[] = []; let reads = 0;
    const ok = (accountId: string, chain: string): WalletSyncOutcome => ({ accountId, chain, support: "HISTORY_SUPPORTED", ok: true, syncStatus: "synced", netWorthParticipation: "NONE", valuationModel: "READ_TIME_VALUED" });
    const deps = (m: Record<string, BillableDecision>): WalletRefreshDeps => ({
      listWallets: async () => [
        { accountId: "w-frozen", chain: "BTC", lastSuccessAt: null, connectionId: "c1", ownerUserId: "u-frozen" },
        { accountId: "w-orphan", chain: "SOL", lastSuccessAt: null, connectionId: "c2", ownerUserId: null },
        { accountId: "w-ok", chain: "ETH", lastSuccessAt: null, connectionId: "c3", ownerUserId: "u-ok" },
      ],
      sync: async (id, chain) => { synced.push(id); return ok(id, chain); },
      policy: async () => resolveRefreshPolicy({ sourceKind: "WALLET" }, null),
      admit: async () => ({ decision: ADMIT_WORD }),
      billable: async (ids) => { reads++; return decisions(m)(ids); },
      clock: () => NOW.getTime(),
      lock: { claim: async (c) => { claimed.push(c); return true; }, release: async () => {} },
    });
    const r = await quiet(() => refreshScheduledWallets({ now: NOW, deps: deps({ "u-frozen": FROZEN }) }));
    check("a frozen owner's wallet: no provider sync, no lease claimed", !synced.includes("w-frozen") && !claimed.includes("c1"), { synced, claimed });
    check("an OWNERLESS wallet: no paid work at all (owner ruling — no billing owner ⇒ refused)", !synced.includes("w-orphan") && !claimed.includes("c2"));
    check("the allowed wallet still syncs", synced.includes("w-ok"));
    check("refusals are not attempted / failed / deferred; tallied by reason; ONE read",
      r.attempted === 1 && r.failed === 0 && r.deferred === 0 && r.planRestricted === 2 && r.planRestrictedReasons?.NO_OWNER === 1 && reads === 1, r);
    check("…so no success / failure clock moved for them (they are not in the synced set)", !r.syncedAccountIds.includes("w-frozen"));
    synced.length = 0;
    await quiet(() => refreshScheduledWallets({ now: NOW, deps: deps({}) }));
    check("after unfreezing, the same wallet syncs on the next sweep; the ownerless one stays refused", synced.includes("w-frozen") && !synced.includes("w-orphan"));
  }

  console.log("5. sync-crypto platform price steps under the GLOBAL cost freeze");
  {
    const before = fetchCalls;
    const r = await quiet(() => syncCrypto({ costFreeze: async () => frozenFlag, refresh: {
      listWallets: async () => [], sync: async () => { throw new Error("no"); }, policy: async () => resolveRefreshPolicy({ sourceKind: "WALLET" }, null),
      admit: async () => ({ decision: ADMIT_WORD }), clock: () => Date.now(), billable: decisions({}) } }));
    check("capability probe + close-archive maintenance SKIPPED, recorded BILLABLE_COST_FREEZE, zero vendor calls",
      r.platformSkipped?.reason === "BILLABLE_COST_FREEZE" && r.outcome === "SKIPPED" && r.closeCoverage.length === 0 && fetchCalls === before, r.platformSkipped);
    const u = await quiet(() => syncCrypto({ costFreeze: async () => judgeGlobalCostFreeze(null, true), refresh: {
      listWallets: async () => [], sync: async () => { throw new Error("no"); }, policy: async () => resolveRefreshPolicy({ sourceKind: "WALLET" }, null),
      admit: async () => ({ decision: ADMIT_WORD }), clock: () => Date.now(), billable: decisions({}) } }));
    check("an unreadable flag also skips them (BILLABLE_POLICY_UNAVAILABLE)", u.platformSkipped?.reason === "BILLABLE_POLICY_UNAVAILABLE" && fetchCalls === before);
  }

  console.log("6. FX + security-price jobs (and the FX refresh triggered on read) under the GLOBAL cost freeze");
  {
    const before = fetchCalls;
    const fx = await quiet(() => fetchFxRates({ costFreeze: async () => frozenFlag }));
    check("fetch-fx-rates: SKIPPED before any read or vendor call (Open Exchange Rates is key-metered; free fallback blocked by default)",
      fx.source === "skipped" && fx.inserted === 0 && fx.billableRestricted === "BILLABLE_COST_FREEZE" && fx.outcome === "SKIPPED" && fx.skipReason === "BILLABLE_COST_FREEZE" && fetchCalls === before, fx);
    check("fetch-fx-rates: an unfrozen run re-checks the previous days (bounded catch-up, FX_CATCH_UP_DAYS)",
      /FX_CATCH_UP_DAYS = 7/.test(readFileSync("jobs/fetch-fx-rates.ts", "utf8")) && /for \(let back = FX_CATCH_UP_DAYS; back >= 1; back--\)/.test(readFileSync("jobs/fetch-fx-rates.ts", "utf8")));
    const px = await quiet(() => fetchSecurityPrices(new Date("2026-10-31T12:00:00Z"), { costFreeze: async () => frozenFlag }));
    check("fetch-security-prices: SKIPPED (Tiingo), nothing fetched or written; status `skipped`, never `ok`",
      px.billableRestricted === "BILLABLE_COST_FREEZE" && px.status === "skipped" && px.outcome === "SKIPPED" && px.fetched === 0 && px.inserted === 0 && fetchCalls === before, px);
    check("the on-read FX refresh calls the SAME job body, so it serves the cache while frozen",
      /fetchFxRates\(\)/.test((await import("node:fs")).readFileSync("lib/money/server-context.ts", "utf8")));
    const read = (raw: string | null, throws = false) => readGlobalCostFreeze({ platformSetting: { findUnique: async () => { if (throws) throw new Error("down"); return raw === null ? null : { value: raw }; } } });
    check("the flag: absent ⇒ off; \"false\" ⇒ off; \"true\" ⇒ frozen", !(await read(null)).frozen && !(await read("false")).frozen && (await read("true")).frozen);
    const inv = await read("yes"); const down = await quiet(() => read(null, true));
    check("the flag: an invalid value or a failed read ⇒ FROZEN (POLICY_UNAVAILABLE) — fail closed", inv.frozen && inv.reason === "POLICY_UNAVAILABLE" && down.frozen && down.state === "UNAVAILABLE");
  }

  console.log("7. the history backfill worker — every pass (SOL, BTC, ETH, price gaps, revaluation)");
  {
    const DAY = "2026-10-28";
    const ADDR = "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN";
    const solCursor = serializeCheckpoint({ ...emptyCheckpoint("s1", ADDR, `${DAY}T00:00:00Z`), licensedFromISO: "2024-06-01", licensedToISO: DAY });
    const ethCursor = serializeEthCheckpoint(queuedCheckpoint("e1", "NO_COVERAGE", `${DAY}T10:00:00.000Z`));
    const world = (o: { accounts: (ids: readonly string[]) => Promise<Map<string, BillableDecision>>; admit?: "ADMIT" | "DENY"; freeze?: GlobalCostFreezeVerdict; solIds?: string[]; stepMs?: number }) => {
      let t = Date.parse(`${DAY}T10:00:00Z`);
      const log: string[] = [];
      const cursors: Record<string, string | null> = Object.fromEntries((o.solIds ?? ["s1"]).map((id) => [id, solCursor]));
      const deps: SolBackfillJobDeps = {
        admit: async () => ({ decision: o.admit === "DENY" ? DENY_WORD : ADMIT_WORD, reason: o.admit === "DENY" ? "INGESTION_PAUSED" as never : null }),
        costFreeze: async () => o.freeze ?? openFlag,
        billableAccounts: async (ids) => { log.push(`policy:${[...ids].sort().join("+")}`); return o.accounts(ids); },
        now: () => t, sleep: async (ms) => { t += ms; }, wakeStartedAt: async () => null,
        wallets: async () => Object.keys(cursors).map((id) => ({ accountId: id, connectionId: `c-${id}`, address: ADDR, cursor: cursors[id] })),
        claimLock: async (c) => { log.push(`lock:${c}`); return true; },
        renewLock: async () => true,
        releaseLock: async (c) => { log.push(`release:${c}`); },
        reconstruct: async ({ accountId }) => {
          log.push(`sol:${accountId}`); t += o.stepMs ?? 2_000;
          return { accountId, ok: true, derivedRowsWritten: 0, mode: "NO_CHANGE", impactedFromISO: null,
            backfill: { status: { state: "IMPORTING" } as never, progressed: true, rowsWritten: 0, impactedFromISO: null, signaturesProcessed: 1, pagesFetched: 1, stoppedBecause: "BUDGET", failure: null } };
        },
        store: async (id) => ({ async readCursor() { return cursors[id] ?? null; }, async anchor() { return null; },
          async commit(c) { log.push(`commit:${id}`); cursors[id] = c.nextCursor; } }),
        regenerationEnabled: () => true,
        regenerate: async (id) => { log.push(`regen:${id}`); },
        cryptoHolders: async () => ["s1", "b1", "h-orphan"],
        acquirePriceGaps: async (ids) => { log.push(`prices:${ids.join("+")}`); return { decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null }; },
        revalueHolders: async (ids) => { log.push(`revalue:${ids.join("+")}`); return { owed: 0, revalued: 0, deferred: 0, alreadyRevalued: 0, failures: 0, skippedForTime: false, priceGaps: null } as never; },
        btc: {
          wallets: async () => [{ accountId: "b1", connectionId: "c-b1", cursor: null }],
          reconstruct: async ({ accountId }) => { log.push(`btc:${accountId}`); return { accountId, ok: true, derivedRowsWritten: 0, mode: "NO_CHANGE", impactedFromISO: null, backfill: null } as never; },
          store: async () => null,
        },
        eth: {
          wallets: async () => [{ accountId: "e1", connectionId: "c-e1", cursor: ethCursor }],
          reconstruct: async ({ accountId }) => { log.push(`eth:${accountId}`); return { rowsWritten: 0, stoppedBecause: "COMPLETE", impactedFromISO: null, failure: null } as never; },
          store: async () => null,
        },
      };
      return { deps, log, cursors };
    };
    const cfg = { config: { ...workerConfig({ SOL_BACKFILL_ENABLED: "true" }), jobBudgetMs: 240_000 },
      btcConfig: btcWorkerConfig({ SOL_BACKFILL_ENABLED: "true" }), ethConfig: ethWorkerConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true" }) };
    const providerWork = (log: string[]) => log.filter((l) => /^(sol|btc|eth|prices|revalue|regen|lock|commit):/.test(l));

    // Positive control first: allowed ⇒ every pass reaches its seam (so the frozen assertions are not vacuous).
    const open = world({ accounts: decisions({}) });
    await quiet(() => solHistoryBackfill({ ...cfg, deps: open.deps }));
    check("control: allowed ⇒ the SOL, BTC and ETH passes and the price-gap pass all reach their provider seams",
      ["sol:s1", "btc:b1", "eth:e1"].every((x) => open.log.includes(x)) && open.log.some((l) => l.startsWith("prices:")), open.log);

    const before = fetchCalls;
    const frozen = world({ accounts: decisions({}, FROZEN) });
    const cursorBefore = frozen.cursors.s1;
    const s = await quiet(() => solHistoryBackfill({ ...cfg, deps: frozen.deps }));
    check("frozen: NO pass reaches a provider seam — no SOL/BTC/ETH step, no price-gap fetch, no revaluation, no lock", providerWork(frozen.log).length === 0, frozen.log);
    check("frozen: checkpoints untouched (no commit, cursor identical) — nothing marked complete", frozen.cursors.s1 === cursorBefore && s.completed === 0);
    check("frozen: refusals tallied by reason, NOT deferred (no self-continuation spin)",
      (s.planRestricted ?? 0) >= 4 && s.planRestrictedReasons?.COST_FREEZE === s.planRestricted && s.deferred === 0, s);
    check("frozen: the account policy was read in ONE batch for the planned wallets (+ one prime for late holders)", frozen.log.filter((l) => l.startsWith("policy:")).length <= 2, frozen.log.filter((l) => l.startsWith("policy:")));
    check("frozen: zero network calls", fetchCalls === before);

    const orphan = world({ accounts: async (ids) => new Map(ids.map((id) => [id, id === "h-orphan" ? { allowed: false, reason: "NO_OWNER" } as BillableDecision : ALLOW])) });
    await quiet(() => solHistoryBackfill({ ...cfg, deps: orphan.deps }));
    check("an OWNERLESS holder is excluded from the price lookup (no billing owner ⇒ no paid work)",
      orphan.log.filter((l) => l.startsWith("prices:")).every((l) => !l.includes("h-orphan")), orphan.log.filter((l) => l.startsWith("prices:")));

    const resumed = world({ accounts: decisions({}) });
    resumed.cursors.s1 = frozen.cursors.s1;
    await quiet(() => solHistoryBackfill({ ...cfg, deps: resumed.deps }));
    check("after unfreezing, the same wallets run from the checkpoint they kept", resumed.log.includes("sol:s1") && resumed.log.includes("btc:b1"));

    let n = 0;
    const midRun = world({ solIds: ["s1", "s2"], stepMs: BILLABLE_BATCH_MAX_AGE_MS + 1_000, accounts: async (ids) => { n++; return new Map(ids.map((id) => [id, n === 1 ? ALLOW : FROZEN] as const)); } });
    await quiet(() => solHistoryBackfill({ ...cfg, btcConfig: { ...cfg.btcConfig, enabled: false }, ethConfig: { ...cfg.ethConfig, enabled: false }, deps: midRun.deps }));
    check("a freeze landing MID-RUN stops the next wallet (re-read after the batch bound)",
      midRun.log.filter((l) => l.startsWith("sol:")).length === 1, midRun.log);

    const paused = world({ accounts: decisions({}), admit: "DENY" });
    const ps = await quiet(() => solHistoryBackfill({ ...cfg, deps: paused.deps }));
    check("platform admission now applies (the worker had none): not admitted ⇒ nothing runs, deferred 0",
      ps.stoppedBecause === "NOT_ADMITTED" && ps.notAdmitted === "INGESTION_PAUSED" && paused.log.length === 0 && ps.deferred === 0, ps);
    const g = world({ accounts: decisions({}), freeze: frozenFlag });
    const gs = await quiet(() => solHistoryBackfill({ ...cfg, deps: g.deps }));
    check("GLOBAL cost freeze ⇒ the whole run is SKIPPED (BILLABLE_COST_FREEZE), before any read that leads to a vendor",
      gs.stoppedBecause === "COST_FREEZE" && gs.platformSkipped === "BILLABLE_COST_FREEZE" && gs.outcome === "SKIPPED" && g.log.length === 0, gs);
    const gu = world({ accounts: decisions({}), freeze: judgeGlobalCostFreeze(null, true) });
    const gus = await quiet(() => solHistoryBackfill({ ...cfg, deps: gu.deps }));
    check("an unreadable global flag ⇒ SKIPPED (BILLABLE_POLICY_UNAVAILABLE)", gus.platformSkipped === "BILLABLE_POLICY_UNAVAILABLE" && gu.log.length === 0);
  }

  console.log("7b. shared-Space history rebuilds fetch prices only for allowed billed owners (review P2-1)");
  {
    const allowed = await billedPriceAccountIds(["a-mine", "a-frozen-comember", "a-orphan"], async (ids) => new Set(ids.filter((i) => i === "a-mine")));
    check("only the accounts whose billed owner is allowed feed the price fetch", [...allowed].join() === "a-mine");
    const failed = await quiet(() => billedPriceAccountIds(["a-mine"], async () => { throw new Error("policy down"); }));
    check("a failed decision ⇒ NO account priced (fail closed; stored prices still read)", failed.size === 0);
    const src = readFileSync("lib/snapshots/regenerate-history.ts", "utf8");
    check("both price fetches in the rebuild use the FILTERED accounts (crypto: pricedCryptoAccounts; equities: fetchInstrumentIds)",
      /assetsOf\(pricedCryptoAccounts\)/.test(src) && /backfillHeldInstrumentPrices\(fetchInstrumentIds,/.test(src) && (src.match(/await backfillHeldInstrumentPrices\(/g) ?? []).length === 2);
    check("…and the default decision is the billable gate's price_history operation, by billed OWNER", /billableAccountIds\(accountIds, "price_history"\)/.test(src));
  }

  console.log("8. wallet billing owners");
  {
    const client = { plaidItem: { findUnique: async () => null }, financialAccount: { findMany: async () => [
      { id: "a-owned", ownerUserId: "u1", ownerUser: { deactivatedAt: null } },
      { id: "a-orphan", ownerUserId: null, ownerUser: null },
      { id: "a-gone", ownerUserId: "u2", ownerUser: { deactivatedAt: new Date() } },
    ] } };
    const asked: string[] = [];
    const m = await billableForAccounts(["a-owned", "a-orphan", "a-gone", "a-missing"], "wallet_sync", { client, decideUsers: async (ids) => { asked.push(...ids); return new Map(ids.map((i) => [i, ALLOW] as const)); } });
    check("a wallet with NO owner ⇒ NO_OWNER (refused)", (m.get("a-orphan") as { reason?: string }).reason === "NO_OWNER");
    check("an unknown account ⇒ NO_OWNER", (m.get("a-missing") as { reason?: string }).reason === "NO_OWNER");
    check("a deactivated owner ⇒ refused without a policy read for them", !m.get("a-gone")!.allowed && !asked.includes("u2"));
    check("the owned wallet bills its OWNER (one batch read)", m.get("a-owned")!.allowed && asked.join() === "u1");
  }

  if (failures > 0) { console.error(`\ncost-freeze-jobs: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\ncost-freeze-jobs: all checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
