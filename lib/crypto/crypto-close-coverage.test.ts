/**
 * lib/crypto/crypto-close-coverage.test.ts
 *
 * CRYPTO-LATCH-1/2 — THE LATCH, PINNED.
 *
 * The 2026-10-01 incident was not an outage. BTC's valuation is a DB read, and
 * when it missed it closed the gate on its own repair:
 *
 *     valuation needs a RAW_CLOSE within 7 days
 *       → the only RAW_CLOSE refresher ran behind wealth regeneration
 *       → wealth regeneration is gated on `outcomeRevalued`
 *       → `outcomeRevalued` is false exactly when the valuation was UNAVAILABLE
 *
 * So once the newest close aged past the walk-back, every BTC refresh was
 * unpriced FOREVER — by Refresh and by cron alike. It was broken only because a
 * SOLANA sync happened to run, through an accident (`undefined !==
 * "UNAVAILABLE"`). A BTC-only holder could never have recovered.
 *
 * Every assertion below would have FAILED, or been vacuous, before the repair.
 * No database, no network: the coverage module takes an injected deps seam.
 */

process.env.DATABASE_URL = "postgresql://stub@127.0.0.1:1/fintracker_unit_stub";

import { readFileSync } from "fs";
import { join } from "path";
import {
  ensureCryptoCloseCoverage, newestUsableCloseISO, coverageCanValue,
  type CryptoCloseCoverageDeps,
} from "./crypto-close-coverage";
import { CRYPTO_CLOSE_MAX_STALE_DAYS } from "./crypto-price-window";
import { outcomeRevalued } from "./wallet-sync-dispatch";
import { BTC_NATIVE, ETH_NATIVE, SOL_NATIVE } from "./native-asset";

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
const read = (...seg: string[]) => readFileSync(join(process.cwd(), ...seg), "utf8");
/** Source with comments stripped — a source scan must assert on CODE, not on prose
 *  that merely describes the defect being removed. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const INSTRUMENT = "inst-btc";

/**
 * A fake archive. `closes` is the RAW_CLOSE series; `vendor` is what an
 * acquisition would add. Records every acquisition window so a test can assert
 * the repair is BOUNDED, not merely effective.
 */
function harness(opts: {
  closes?: string[];
  vendor?: string[];
  instrumentId?: string | null;
  throwOnAcquire?: boolean;
}) {
  const closes = new Set(opts.closes ?? []);
  const vendor = opts.vendor ?? [];
  const acquisitions: { fromISO: string; toISO: string }[] = [];
  let reads = 0;
  const deps: CryptoCloseCoverageDeps = {
    lookupInstrumentId: async () => (opts.instrumentId === undefined ? INSTRUMENT : opts.instrumentId),
    readCloses: async (_id, fromISO, toISO) => {
      reads++;
      return [...closes].filter((d) => d >= fromISO && d <= toISO).sort()
        .map((dateISO) => ({ dateISO, price: 80_000 }));
    },
    acquire: async (_id, fromISO, toISO) => {
      acquisitions.push({ fromISO, toISO });
      if (opts.throwOnAcquire) throw new Error("coingecko unreachable");
      // Only dates the vendor actually HAS and that fall inside the request.
      const added = vendor.filter((d) => d >= fromISO && d <= toISO && !closes.has(d));
      for (const d of added) closes.add(d);
      return { inserted: added.length, detail: `${added.length} row(s) written, outcomes OK=1` };
    },
  };
  return { deps, acquisitions, closes, reads: () => reads };
}

async function main(): Promise<void> {
  // ── 1. THE HAPPY PATH COSTS NOTHING ───────────────────────────────────────
  {
    const h = harness({ closes: ["2026-09-30"] });
    const c = await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    check("1. a fresh close ⇒ COVERED", c.status === "COVERED", c.status);
    check("1. …and NO vendor request is issued", h.acquisitions.length === 0);
    check("1. …and the close it will value against is stated", c.closeDateISO === "2026-09-30", String(c.closeDateISO));
    check("1. COVERED can value", coverageCanValue(c));
  }

  // ── 2. THE EXACT INCIDENT, REPLAYED ───────────────────────────────────────
  // Newest RAW_CLOSE 2026-09-20; today 2026-10-01; walk-back floor 2026-09-24.
  // Before the repair this returned "no close" in 29–36 ms and stopped. Forever.
  {
    const h = harness({ closes: ["2026-09-19", "2026-09-20"], vendor: ["2026-09-30"] });
    const before = await newestUsableCloseISO(BTC_NATIVE, "2026-10-01", { deps: h.deps });
    check("2. the incident archive genuinely cannot value 2026-10-01", before.closeDateISO === null);
    check("2. …because the walk-back floor is 2026-09-24, four days past the newest close",
      before.fromISO === "2026-09-24", before.fromISO);

    const c = await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    check("2. ⇒ REPAIRED (the latch is broken)", c.status === "REPAIRED", `${c.status}: ${c.reason ?? ""}`);
    check("2. …and it can now value", coverageCanValue(c) && c.closeDateISO === "2026-09-30", String(c.closeDateISO));
    check("2. …having written exactly the one row it needed", c.inserted === 1, String(c.inserted));
  }

  // ── 3. THE REPAIR IS BOUNDED TO THE WALK-BACK WINDOW ──────────────────────
  {
    const h = harness({ closes: ["2026-09-20"], vendor: ["2026-09-30"] });
    await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    check("3. exactly ONE acquisition request", h.acquisitions.length === 1, JSON.stringify(h.acquisitions));
    check("3. …over the walk-back window only, clamped to yesterday (no unbounded history pull)",
      h.acquisitions[0]?.fromISO === "2026-09-24" && h.acquisitions[0]?.toISO === "2026-09-30",
      JSON.stringify(h.acquisitions[0]));
  }

  // ── 4. THE CLOSED-DATE CLAMP ──────────────────────────────────────────────
  // The archive cannot hold TODAY (assertClosedDateISO), so asking a vendor for
  // today's close is asking for a row the archive would refuse.
  {
    const h = harness({ closes: ["2026-09-20"], vendor: ["2026-09-30"] });
    await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    check("4. the acquisition never asks for today", h.acquisitions[0]?.toISO === "2026-09-30", String(h.acquisitions[0]?.toISO));
  }

  // ── 5. RAW_CLOSE IS NOT INTRADAY ──────────────────────────────────────────
  // The incident's archive held an INTRADAY quote for 2026-10-01 at $84,406 the
  // whole time. Consuming it would have "fixed" the symptom by destroying the
  // distinction between a dated close and a live quote.
  {
    const src = read("lib/crypto/crypto-close-coverage.ts");
    check("5. the module names RAW_CLOSE and never INTRADAY",
      /PriceBasis\.RAW_CLOSE/.test(code(src)) && !/INTRADAY/.test(code(src)));
    // Behavioural: a vendor that returns NOTHING usable leaves it refusing,
    // even though an INTRADAY row for the day exists in the real archive.
    const h = harness({ closes: ["2026-09-20"], vendor: [] });
    const c = await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    check("5. no acquirable close ⇒ UNRESOLVED, never a silent substitution",
      c.status === "UNRESOLVED" && c.closeDateISO === null, c.status);
    check("5. …and it cannot value", !coverageCanValue(c));
    check("5. …and it says what it tried", (c.reason ?? "").includes("after acquisition"), c.reason);
  }

  // ── 6. THE TOLERANCE BOUNDARY IS NOT WIDENED ──────────────────────────────
  // The real-world instance: the walk-back still reached 09-20 on 09-27 and
  // missed it on 09-28. That is the day every BTC refresh went silently unpriced.
  {
    check("6. the tolerance is 7 days and ONE constant", CRYPTO_CLOSE_MAX_STALE_DAYS === 7, String(CRYPTO_CLOSE_MAX_STALE_DAYS));
    const h1 = harness({ closes: ["2026-09-20"] });
    const on27 = await newestUsableCloseISO(BTC_NATIVE, "2026-09-27", { deps: h1.deps });
    check("6. on 2026-09-27 the 09-20 close is exactly 7 days back ⇒ still usable", on27.closeDateISO === "2026-09-20");
    const h2 = harness({ closes: ["2026-09-20"] });
    const on28 = await newestUsableCloseISO(BTC_NATIVE, "2026-09-28", { deps: h2.deps });
    check("6. on 2026-09-28 it is 8 days back ⇒ NOT usable (the day the latch armed)", on28.closeDateISO === null);
    // And the repair must not paper over it by reaching further back.
    const src = read("lib/crypto/crypto-close-coverage.ts");
    check("6. the repair window is DERIVED from the tolerance, not a second literal",
      /minusDaysISO\(asOfISO, maxStaleDays\)/.test(src));
  }

  // ── 7. A VENDOR FAILURE IS REPORTED, NEVER FABRICATED ─────────────────────
  {
    const h = harness({ closes: ["2026-09-20"], throwOnAcquire: true });
    const c = await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    check("7. an acquisition that throws ⇒ FAILED, not a price", c.status === "FAILED", c.status);
    check("7. …carrying the provider's reason", (c.reason ?? "").includes("coingecko unreachable"), c.reason);
    check("7. …and never claims a close", c.closeDateISO === null && c.inserted === 0);
    check("7. …and does not throw out of maintenance", true);
  }

  // ── 8. NO INSTRUMENT IS A STATED OUTCOME, AND MINTS NOTHING ───────────────
  {
    const h = harness({ instrumentId: null });
    const c = await ensureCryptoCloseCoverage(SOL_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    check("8. no canonical instrument ⇒ NO_INSTRUMENT", c.status === "NO_INSTRUMENT", c.status);
    check("8. …and nothing was acquired against it", h.acquisitions.length === 0);
    const src = read("lib/crypto/crypto-close-coverage.ts");
    check("8. resolution is the READ-ONLY lookup, never the minter",
      /lookupCryptoInstrumentId/.test(code(src)) && !/\bresolveCryptoInstrumentId\b/.test(code(src)));
  }

  // ── 9. IDEMPOTENCE ────────────────────────────────────────────────────────
  {
    const h = harness({ closes: ["2026-09-20"], vendor: ["2026-09-30"] });
    const a = await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    const b = await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    const c = await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps: h.deps, yesterdayISO: "2026-09-30" });
    check("9. first run REPAIRED", a.status === "REPAIRED", a.status);
    check("9. re-runs are COVERED, not repeated repairs", b.status === "COVERED" && c.status === "COVERED");
    check("9. …so exactly ONE vendor request was ever issued", h.acquisitions.length === 1, String(h.acquisitions.length));
    check("9. …and no duplicate rows", b.inserted === 0 && c.inserted === 0);
  }

  // ── 10. BTC-ONLY RECOVERY — NO ETH, NO SOL, NO OTHER CHAIN ────────────────
  // The incident's recovery came from a Solana sync. This asserts the BTC path
  // is now self-sufficient: the asset under repair is the asset asked for.
  {
    const perAsset: string[] = [];
    const deps: CryptoCloseCoverageDeps = {
      lookupInstrumentId: async (a) => `inst-${a.symbol}`,
      readCloses: async (id, fromISO) => (id === "inst-BTC" && fromISO <= "2026-09-30" ? [] : []),
      acquire: async (id, fromISO, toISO) => { perAsset.push(id); return { inserted: 0, detail: `window ${fromISO}..${toISO}` }; },
    };
    await ensureCryptoCloseCoverage(BTC_NATIVE, "2026-10-01", { deps, yesterdayISO: "2026-09-30" });
    check("10. a BTC repair acquires against BTC's OWN instrument",
      perAsset.length === 1 && perAsset[0] === "inst-BTC", JSON.stringify(perAsset));
    check("10. …and never requires ETH or SOL to have synced",
      !perAsset.includes("inst-ETH") && !perAsset.includes("inst-SOL"));
    // The structural half: the price authority repairs itself, and the schedule
    // maintains the archive, neither gated on a valuation having succeeded.
    const btc = read("lib/crypto/btc-sync.ts");
    check("10. BTC's default close authority performs its own maintenance",
      /canonicalBtcCloseUsdMaintained/.test(btc) && /ensureCryptoCloseCoverage/.test(btc));
    const job = read("jobs/sync-crypto.ts");
    check("10. the scheduled sweep maintains the archive BEFORE the sweep, not behind outcomeRevalued",
      job.indexOf("maintainHeldCryptoCloseCoverage") < job.indexOf("refreshScheduledWallets({ deps: options.refresh })")
      && job.indexOf("maintainHeldCryptoCloseCoverage") > 0);
  }

  // ── 11. CRYPTO-LATCH-2 — THE ACCIDENT IS GONE ─────────────────────────────
  {
    check("11. ADAPTER_VALUED + PRICED ⇒ revalued",
      outcomeRevalued({ ok: true, valuationModel: "ADAPTER_VALUED", valuation: { status: "PRICED" } }));
    check("11. ADAPTER_VALUED + UNAVAILABLE ⇒ NOT revalued",
      !outcomeRevalued({ ok: true, valuationModel: "ADAPTER_VALUED", valuation: { status: "UNAVAILABLE", reason: "no close" } }));
    // THE REGRESSION: this was accidentally TRUE, and that accident was the
    // only thing repairing Bitcoin's archive.
    check("11. ADAPTER_VALUED with an ABSENT valuation ⇒ NOT revalued (fails CLOSED)",
      !outcomeRevalued({ ok: true, valuationModel: "ADAPTER_VALUED" }));
    check("11. READ_TIME_VALUED ⇒ revalued, BY DECLARATION",
      outcomeRevalued({ ok: true, valuationModel: "READ_TIME_VALUED" }));
    check("11. a failed run is never revalued, whatever the model",
      !outcomeRevalued({ ok: false, valuationModel: "READ_TIME_VALUED" })
      && !outcomeRevalued({ ok: false, valuationModel: "ADAPTER_VALUED" }));
    const src = read("lib/crypto/wallet-sync-dispatch.ts");
    check("11. the predicate no longer compares against UNAVAILABLE to infer success",
      !/valuation\?\.status\s*!==\s*"UNAVAILABLE"/.test(code(src)));
    check("11. …and every adapter DECLARES its valuation model",
      (src.match(/valuationModel:\s*"(ADAPTER_VALUED|READ_TIME_VALUED)"/g) ?? []).length >= 5);
  }

  // ── 12. ASSET IDENTITY IS NEVER CROSSED ───────────────────────────────────
  {
    const seen: string[] = [];
    const deps: CryptoCloseCoverageDeps = {
      lookupInstrumentId: async (a) => { seen.push(a.assetKey); return `inst-${a.symbol}`; },
      readCloses: async () => [{ dateISO: "2026-09-30", price: 3_000 }],
      acquire: async () => ({ inserted: 0, detail: "" }),
    };
    const e = await ensureCryptoCloseCoverage(ETH_NATIVE, "2026-10-01", { deps, yesterdayISO: "2026-09-30" });
    check("12. the coverage is reported against the asset asked for",
      e.assetKey === ETH_NATIVE.assetKey && seen[0] === ETH_NATIVE.assetKey, e.assetKey);
    check("12. ETH's key is not BTC's", ETH_NATIVE.assetKey !== BTC_NATIVE.assetKey);
  }

  console.log(`\ncrypto-close-coverage: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
