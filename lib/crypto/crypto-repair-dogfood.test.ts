/**
 * lib/crypto/crypto-repair-dogfood.test.ts
 *
 * CRYPTO REPAIR — DOGFOOD A–J, ON DETERMINISTIC FIXTURES.
 *
 * The repair authorization asked for ten scenarios to be exercised, and
 * explicitly NOT against live wallet state. So these run the REAL
 * `syncBtcWallet` against an in-memory stand-in for the Prisma delegates the
 * single-address path touches — the same harness shape as
 * btc-partial-sync.test.ts — with injected balance, transaction, price and
 * close-coverage providers.
 *
 * The DB URL is pointed at an unreachable, clone-named address before @/lib/db
 * loads, so a delegate this file forgot to stub fails fast and can never reach a
 * real database. No network, no DB, no live state.
 *
 * Scenario J is the one that mattered most in the incident: after a partial BTC
 * outcome the user must be able to see
 *
 *     Position: Updated today
 *     USD valuation: unavailable / stale
 *     Transaction history: couldn't refresh; existing history kept
 *
 * and must NOT see "Transactions: Updated today".
 */

process.env.DATABASE_URL = "postgresql://stub@127.0.0.1:1/fintracker_unit_stub";
process.env.INVESTMENT_OBSERVATIONS_ENABLED = "true";

import type { RawBtcTx } from "@/lib/crypto/btc-explorer";
import type { CryptoCloseCoverage } from "./crypto-close-coverage";

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("unexpected unhandled rejection:", err);
  process.exit(1);
});

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const ADDRESS = "bc1qdogfoodstubaddress";
const ACCOUNT = "acc-btc-dogfood";
const SATS = 24_060_252;          // the live cold wallet's figure
const BTC = SATS / 100_000_000;

interface Store {
  lastUpdated: Date | null;
  nativeBalance: number | null;
  balance: number | null;
  syncStatus: string;
  observations: { date: string; quantity: number }[];
  transactions: { externalTransactionId: string; amount: number }[];
  facetWrites: { transactionsSyncedAt?: Date; historyRebuiltAt?: Date }[];
  issues: { stage: string; message: string }[];
}

function freshStore(over: Partial<Store> = {}): Store {
  return {
    lastUpdated: new Date("2026-09-21T15:39:29Z"),
    nativeBalance: BTC,
    balance: 20_000,
    syncStatus: "synced",
    observations: [],
    transactions: [],
    facetWrites: [],
    issues: [],
    ...over,
  };
}

/**
 * Install the in-memory delegates. Returns the store so a scenario can assert on
 * exactly what was written — and, just as importantly, on what was NOT.
 */
async function install(store: Store) {
  const { db } = await import("@/lib/db");
  type Any = Record<string, unknown>;
  const d = db as unknown as Any;

  d.financialAccount = {
    findUnique: async () => ({
      id: ACCOUNT, ownerUserId: "user-1", walletChain: "BTC", walletAddress: ADDRESS,
      deletedAt: null, nativeBalance: store.nativeBalance, balance: store.balance,
      currency: "USD", lastUpdated: store.lastUpdated, syncStatus: store.syncStatus,
    }),
    update: async ({ data }: Any) => {
      const dd = data as Any;
      if (dd.lastUpdated !== undefined)   store.lastUpdated   = dd.lastUpdated as Date;
      if (dd.nativeBalance !== undefined) store.nativeBalance = dd.nativeBalance as number;
      if (dd.balance !== undefined)       store.balance       = dd.balance as number;
      if (dd.syncStatus !== undefined)    store.syncStatus    = dd.syncStatus as string;
      return {};
    },
    findMany: async () => [],
  };
  d.providerAccountIdentity = {
    findMany:  async () => [{ externalAccountId: ADDRESS }],
    findFirst: async () => ({ id: "pai-1", financialAccountId: ACCOUNT, provider: "WALLET", connectionId: "conn-1" }),
    upsert:    async () => ({}),
    update:    async () => ({}),
    create:    async () => ({}),
  };
  d.accountConnection = {
    findFirst:  async () => ({ connectionId: "conn-1", credential: ADDRESS, cursor: null }),
    updateMany: async () => ({}),
  };
  d.connection = {
    findFirst:  async () => ({ id: "conn-1", errorCode: null, userId: "user-1", provider: "WALLET", credential: ADDRESS, cursor: null }),
    create:     async () => ({ id: "conn-1" }),
    upsert:     async () => ({ id: "conn-1" }),
    findUnique: async () => ({ id: "conn-1", errorCode: null, userId: "user-1", provider: "WALLET" }),
    update:     async ({ data }: Any) => {
      const dd = data as Any;
      if (dd.transactionsSyncedAt !== undefined || dd.historyRebuiltAt !== undefined) {
        store.facetWrites.push({
          ...(dd.transactionsSyncedAt !== undefined ? { transactionsSyncedAt: dd.transactionsSyncedAt as Date } : {}),
          ...(dd.historyRebuiltAt !== undefined ? { historyRebuiltAt: dd.historyRebuiltAt as Date } : {}),
        });
      }
      return {};
    },
  };
  d.positionObservation = {
    upsert:    async ({ create }: Any) => { const c = create as Any; store.observations.push({ date: String(c.date), quantity: Number(c.quantity) }); return {}; },
    findFirst: async () => null,
    findMany:  async () => [],
    groupBy:   async () => [],
    updateMany: async () => ({}),
  };
  d.transaction = {
    findMany:   async () => store.transactions.map((t) => ({ externalTransactionId: t.externalTransactionId, amount: t.amount, currency: "BTC", deletedAt: null, settlementState: "POSTED" })),
    createMany: async ({ data }: Any) => { const rows = data as Any[]; for (const r of rows) store.transactions.push({ externalTransactionId: String(r.externalTransactionId), amount: Number(r.amount) }); return { count: rows.length }; },
    findFirst:  async () => null,
    groupBy:    async () => [],
  };
  d.syncIssue  = { create: async () => ({ id: "iss-1" }), findFirst: async () => null, findUnique: async () => null, update: async () => ({}), updateMany: async () => ({}) };
  // The incident lifecycle behind recordSyncIssue — stubbed so a best-effort
  // issue write is silent rather than noisy. Its failure is already non-fatal.
  d.syncIssueOccurrence = { create: async () => ({}), count: async () => 0, findMany: async () => [] };
  d.auditLog   = { create: async () => ({}), findMany: async () => [] };
  d.instrument = { findFirst: async () => ({ id: "inst-btc" }) };
  d.instrumentAlias = { findUnique: async () => ({ instrumentId: "inst-btc" }) };
  d.priceObservation = { findMany: async () => [], groupBy: async () => [] };
  return store;
}

const TX: RawBtcTx = {
  txid: "a".repeat(64),
  status: { confirmed: true, block_time: Math.floor(new Date("2026-02-01T00:00:00Z").getTime() / 1000) },
  vin:  [],
  vout: [{ scriptpubkey_address: ADDRESS, value: SATS }],
} as unknown as RawBtcTx;

const covered = (date: string): CryptoCloseCoverage => ({
  assetKey: "x", status: "COVERED", fromISO: "2026-09-24", toISO: date,
  closeDateISO: "2026-09-30", inserted: 0, attemptedRepair: false,
});
const repaired = (): CryptoCloseCoverage => ({
  assetKey: "x", status: "REPAIRED", fromISO: "2026-09-24", toISO: "2026-09-30",
  closeDateISO: "2026-09-30", inserted: 1, attemptedRepair: true,
  startedAt: new Date(), durationMs: 120,
});
const unresolved = (): CryptoCloseCoverage => ({
  assetKey: "x", status: "UNRESOLVED", fromISO: "2026-09-24", toISO: "2026-09-30",
  closeDateISO: null, inserted: 0, attemptedRepair: true,
  startedAt: new Date(), durationMs: 90, reason: "vendor served no close",
});

async function main(): Promise<void> {
  const { syncBtcWallet } = await import("./btc-sync");

  // ── A. CLEAN BTC REFRESH ──────────────────────────────────────────────────
  {
    const store = await install(freshStore());
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => SATS,
      txFetcher: async () => [TX],
      priceFetcher: async () => 83_648.98,
    });
    check("A. clean refresh succeeds", r.ok === true, r.reason);
    check("A. …position written to the spine", store.observations.length === 1, JSON.stringify(store.observations));
    check("A. …valuation PRICED", r.valuation?.status === "PRICED");
    // The USD column is a rounded price x quantity, so compare within a cent
    // rather than on float identity.
    check("A. …the legacy pair AND its clock advance on a priced run",
      store.balance !== null && Math.abs(store.balance - BTC * 83_648.98) < 0.01
      && store.lastUpdated !== null && store.lastUpdated.toISOString() > "2026-09-22",
      `balance=${store.balance} expected~${BTC * 83_648.98} lastUpdated=${store.lastUpdated?.toISOString()}`);
    check("A. …the import reported IMPORTED", r.transactionImport?.status === "IMPORTED");
  }

  // ── B. STALE RAW_CLOSE — the latch scenario ───────────────────────────────
  {
    const store = await install(freshStore());
    let coverageCalls = 0;
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => SATS,
      txFetcher: async () => [TX],
      // No priceFetcher ⇒ the DEFAULT authority runs, which performs maintenance.
      closeCoverage: async () => { coverageCalls++; return repaired(); },
    });
    // The archive read itself still cannot resolve (no price rows in the stub),
    // so the valuation ends UNAVAILABLE — but the MAINTENANCE was reached and
    // reported, which is the property under test. Before the repair, nothing
    // was attempted at all.
    check("B. a stale archive REACHES maintenance", coverageCalls === 1, String(coverageCalls));
    check("B. …the coverage outcome travels on the result",
      r.closeCoverage?.status === "REPAIRED", JSON.stringify(r.closeCoverage));
    check("B. …and the position is still written regardless", store.observations.length === 1);
    check("B. …the run stays ok (partial, never failed)", r.ok === true, r.reason);
  }

  // ── B2. MAINTENANCE THAT CANNOT RESOLVE IS SAID, NOT HIDDEN ───────────────
  {
    const store = await install(freshStore());
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => SATS,
      txFetcher: async () => [TX],
      closeCoverage: async () => unresolved(),
    });
    check("B2. an unresolved archive ⇒ valuation UNAVAILABLE", r.valuation?.status === "UNAVAILABLE");
    check("B2. …naming the maintenance attempt, not just 'no close'",
      (r.valuation as { reason?: string } | undefined)?.reason?.includes("archive maintenance") === true,
      (r.valuation as { reason?: string } | undefined)?.reason);
    check("B2. …the UNPRICED run does NOT move the legacy pair or its clock",
      store.balance === 20_000 && store.lastUpdated?.toISOString().startsWith("2026-09-21") === true,
      `balance=${store.balance} lastUpdated=${store.lastUpdated?.toISOString()}`);
    check("B2. …but the fresh QUANTITY is on the spine, dated today",
      store.observations.length === 1, JSON.stringify(store.observations));
  }

  // ── C. BTC HISTORY TIMEOUT — the incident's non-fatal half ────────────────
  {
    const store = await install(freshStore({ transactions: [{ externalTransactionId: "existing", amount: 1 }] }));
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => SATS,
      txFetcher: async () => { throw new Error("blockstream.info did not respond within 10000 ms"); },
      priceFetcher: async () => 83_648.98,
      closeCoverage: async () => covered("2026-10-01"),
    });
    check("C. a history timeout does NOT fail the run", r.ok === true, r.reason);
    check("C. …the import is reported FAILED", r.transactionImport?.status === "FAILED");
    check("C. …naming the provider and the budget",
      (r.transactionImport as { reason?: string } | undefined)?.reason?.includes("did not respond within 10000 ms") === true);
    check("C. …the position is still written", store.observations.length === 1);
    check("C. …EXISTING history is untouched (complete-or-throw)",
      store.transactions.length === 1 && store.transactions[0].externalTransactionId === "existing",
      JSON.stringify(store.transactions));
    check("C. …and NO transaction freshness clock is written",
      store.facetWrites.every((w) => w.transactionsSyncedAt === undefined), JSON.stringify(store.facetWrites));
  }

  // ── D. BTC QUOTE TIMEOUT (the shared current-quote provider) ──────────────
  // The quote is non-gating by construction: it runs in the dispatch, after the
  // adapter, and cannot change `ok`. Asserted at the dispatch in
  // wallet-refresh-invariants; here we assert the adapter is indifferent to it.
  {
    const store = await install(freshStore());
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => SATS,
      txFetcher: async () => [TX],
      priceFetcher: async () => 83_648.98,
    });
    check("D. the adapter's success does not depend on the current quote at all",
      r.ok === true && r.valuation?.status === "PRICED" && store.observations.length === 1);
  }

  // ── E. BTC QUANTITY TIMEOUT — must FAIL CLOSED ────────────────────────────
  {
    const store = await install(freshStore());
    const r = await syncBtcWallet(ACCOUNT, {
      balanceFetcher: async () => { throw new Error("blockstream.info did not respond within 10000 ms"); },
      txFetcher: async () => [TX],
      priceFetcher: async () => 83_648.98,
    });
    check("E. a failed authoritative quantity read FAILS the run", r.ok === false);
    check("E. …at the balance stage", r.stage === "balance", r.stage);
    check("E. …writes NO position", store.observations.length === 0, JSON.stringify(store.observations));
    check("E. …does NOT advance position freshness",
      store.lastUpdated?.toISOString().startsWith("2026-09-21") === true, store.lastUpdated?.toISOString());
    check("E. …and leaves the previous balance exactly as it was",
      store.nativeBalance === BTC && store.balance === 20_000);
    check("E. …writing no facet clock either", store.facetWrites.length === 0);
  }

  // ── F/G. ETH + SOL QUANTITY TIMEOUT — fail closed, no partial invented ────
  // These adapters make ONE network call and capture after it, so a timeout has
  // nothing to write. Pinned structurally in wallet-refresh-invariants; here we
  // assert the product-facing classification the user now sees.
  {
    const { walletSyncUserMessage } = await import("./wallet-sync-dispatch");
    const msg = walletSyncUserMessage("BALANCE_UNAVAILABLE", "network error: This operation was aborted", "ETH");
    check("F/G. an ETH/SOL abort tells the user the position was KEPT",
      msg === "Balance provider timed out. Existing position was kept.", msg);
    check("F/G. …and never shows undici's wording", !/aborted/i.test(msg));
  }

  // ── H. RECOVERY AFTER A TRANSIENT FAILURE ─────────────────────────────────
  {
    const store = await install(freshStore());
    let attempt = 0;
    const balanceFetcher = async () => {
      attempt++;
      if (attempt === 1) throw new Error("blockstream.info did not respond within 10000 ms");
      return SATS;
    };
    const first = await syncBtcWallet(ACCOUNT, { balanceFetcher, txFetcher: async () => [TX], priceFetcher: async () => 83_648.98 });
    check("H. the transient run fails and writes nothing", first.ok === false && store.observations.length === 0);
    const second = await syncBtcWallet(ACCOUNT, { balanceFetcher, txFetcher: async () => [TX], priceFetcher: async () => 83_648.98 });
    check("H. the next run recovers fully", second.ok === true, second.reason);
    check("H. …writing the position and the priced pair",
      store.observations.length === 1 && second.valuation?.status === "PRICED");
  }

  // ── I. HISTORICAL PRICE GAP REPAIR — idempotence, via the real module ─────
  {
    const { ensureCryptoCloseCoverage } = await import("./crypto-close-coverage");
    const { BTC_NATIVE } = await import("./native-asset");
    const closes = new Set<string>(["2026-09-20"]);
    const acquisitions: string[] = [];
    const deps = {
      lookupInstrumentId: async () => "inst-btc",
      readCloses: async (_i: string, f: string, t: string) =>
        [...closes].filter((d) => d >= f && d <= t).sort().map((dateISO) => ({ dateISO, price: 80_000 })),
      acquire: async (_i: string, f: string, t: string) => {
        acquisitions.push(`${f}..${t}`);
        for (const d of ["2026-09-30"]) if (d >= f && d <= t) closes.add(d);
        return { inserted: 1, detail: "1 row" };
      },
    };
    const a = await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps, yesterdayISO: "2026-09-30" });
    const b = await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps, yesterdayISO: "2026-09-30" });
    check("I. the gap is repaired on the first pass", a.status === "REPAIRED", a.status);
    check("I. …and the second pass is a no-op", b.status === "COVERED" && acquisitions.length === 1,
      `${b.status} acquisitions=${acquisitions.length}`);
  }

  // ── J. THE FRESHNESS UI AFTER A PARTIAL BTC OUTCOME ──────────────────────
  // The scenario the authorization singled out.
  {
    const { deriveConnectionIntelligence } = await import("@/lib/connections/intelligence");
    const TODAY = new Date("2026-10-01T17:10:20Z");
    const SEP21 = new Date("2026-09-21T15:39:29Z");
    const s = deriveConnectionIntelligence({
      provider: "WALLET", state: "ready",
      historySyncedAt: null,
      earliestTxDate: new Date("2022-01-01T00:00:00Z"),
      connectedAt: new Date("2026-06-01T00:00:00Z"),
      lastSyncedAt: TODAY,              // balance read today
      balancesUpdatedAt: SEP21,         // unpriced ⇒ valuation clock frozen
      positionObservedAt: TODAY,        // the spine advanced
      transactionsSyncedAt: null,       // the import FAILED
      valuationUpdatedAt: SEP21,
      valuationIsReadTime: false,
    }, new Date("2026-10-01T17:30:00Z"));

    check("J. 'Position: Updated today' IS available", s.positionObservedAt === TODAY.toISOString());
    check("J. 'USD valuation' shows the older, truthful instant",
      s.valuationUpdatedAt === SEP21.toISOString());
    check("J. 'Transaction history' claims NOTHING — the import failed",
      s.transactionsSyncedAt === null);
    check("J. ❗ it is NOT 'Updated today' (the incident's false claim)",
      s.transactionsSyncedAt !== TODAY.toISOString());
    check("J. 'Financial profile' claims nothing either — no rebuild ran",
      s.lastReconstructedAt === null);
    check("J. …and neither borrows the balance clock",
      s.transactionsSyncedAt !== s.lastSyncedAt && s.lastReconstructedAt !== s.lastSyncedAt);
  }

  console.log(`\ncrypto-repair-dogfood: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
