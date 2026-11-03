/**
 * lib/snapshots/stale-bank-snapshot.test.ts
 *
 * FM-AUDIT-021 — a STALE bank balance must not be stamped onto today's live
 * snapshot as an observation (which the history regenerator then freezes
 * forever). Standalone tsx script:
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/snapshots/stale-bank-snapshot.test.ts
 *
 * Synthetic fixtures only. No database: the writer runs against an in-memory
 * fake through its injection seam.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { staleMaterialBankAccountIds, isFedBankAccount, countedReportingMagnitudes } from "./stale-bank-balance.core";
import type { ConversionContext } from "@/lib/money/types";
import type { Resolution } from "@/lib/fx/types";
import { STALE_AFTER_DAYS } from "@/lib/freshness/observation";
import { MATERIAL_VALUE_SHARE } from "@/lib/freshness/space-freshness";
import { regenerateDay, type DayRegenInput } from "./regenerate-history.core";
import { resolveSnapshotCompleteness } from "./snapshot-completeness.core";
import { resolveCryptoValuationState, isCryptoAssertable } from "./crypto-valuation-status.core";
import { cryptoHoldersNotValued, valueCryptoDay } from "@/lib/crypto/historical-crypto-valuation.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOW = new Date("2026-03-20T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const SNAP_DATE = new Date(Date.UTC(2026, 2, 20));

interface FakeAccount {
  id: string; type: string; balance: number; currency: string;
  syncStatus: string | null; lastUpdated: Date; balanceLastUpdatedAt: Date | null;
  walletChain?: string | null;
}

function acct(id: string, type: string, balance: number, ageDays: number, over: Partial<FakeAccount> = {}): FakeAccount {
  return {
    id, type, balance, currency: "USD", syncStatus: "active",
    lastUpdated: ago(ageDays), balanceLastUpdatedAt: null, ...over,
  };
}

type UpsertArgs = { where: any; create: any; update: any };

function makeFake(accounts: FakeAccount[], existingRow: { isEstimated: boolean } | null = null) {
  const calls: Array<{ name: string; args?: any }> = [];
  let upserted: UpsertArgs | null = null;
  const client = {
    spaceAccountLink: {
      async findMany() {
        calls.push({ name: "spaceAccountLink.findMany" });
        return accounts.map((a) => ({
          visibilityLevel: "FULL",
          financialAccount: {
            id: a.id, type: a.type, balance: a.balance, currency: a.currency,
            walletChain: a.walletChain ?? null, lastUpdated: a.lastUpdated, availableBalance: null,
          },
        }));
      },
    },
    financialAccount: {
      async findMany(args: any) {
        calls.push({ name: "financialAccount.findMany", args });
        // The consent gate (select { id }) finds no gated investment accounts.
        if (!args?.select?.lastUpdated) return [];
        const ids: string[] = args.where?.id?.in ?? [];
        return accounts.filter((a) => ids.includes(a.id)).map((a) => ({
          id: a.id, type: a.type, syncStatus: a.syncStatus,
          lastUpdated: a.lastUpdated, balanceLastUpdatedAt: a.balanceLastUpdatedAt,
        }));
      },
    },
    space: { async findUnique() { calls.push({ name: "space.findUnique" }); return { reportingCurrency: "USD" }; } },
    spaceSnapshot: {
      async upsert(args: UpsertArgs) { calls.push({ name: "spaceSnapshot.upsert" }); upserted = args; return {}; },
      async findUnique() { calls.push({ name: "spaceSnapshot.findUnique" }); return existingRow; },
    },
    // Nothing observed for any wallet: a spine-chain wallet resolves NO_OBSERVATION.
    positionObservation: { async findMany() { return []; }, async groupBy() { return []; } },
    manualAssetValuation: { async findMany() { return []; } },
  };
  return { client, calls, get upserted() { return upserted; } };
}

const FIELDS = ["stocks", "crypto", "total", "cash", "savings", "debt", "netWorth", "totalAssets", "netLiquid", "cashOnHand"] as const;

/** The exact payload keys the live writer produced before FM-AUDIT-021. */
const PRE_FIX_CREATE_KEYS = [
  "spaceId", "date", ...FIELDS, "reportingCurrency",
  "completenessTier", "contributingComponentCount", "totalComponentCount", "cryptoValuationStatus",
];
const PRE_FIX_UPDATE_KEYS = PRE_FIX_CREATE_KEYS.filter((k) => k !== "spaceId" && k !== "date");

function partOneRule(): void {
  console.log("1. The rule (stale-bank-balance.core.ts) reuses the existing definitions");
  const counted = (rows: Array<[string, number]>) => rows.map(([id, v]) => ({ id, absValue: Math.abs(v) }));

  const fresh = acct("chk", "checking", 4_000, 1);
  const stale = acct("chk", "checking", 4_000, STALE_AFTER_DAYS + 1);
  check("fresh checking ⇒ not stale", staleMaterialBankAccountIds(counted([["chk", 4_000]]), [fresh], NOW).length === 0);
  check(`checking older than STALE_AFTER_DAYS (${STALE_AFTER_DAYS}) ⇒ stale`,
    staleMaterialBankAccountIds(counted([["chk", 4_000]]), [stale], NOW).join() === "chk");
  check("just inside the horizon ⇒ not stale",
    staleMaterialBankAccountIds(counted([["chk", 4_000]]), [acct("chk", "checking", 4_000, STALE_AFTER_DAYS - 0.5)], NOW).length === 0);
  check("savings and debt are bank balances too",
    staleMaterialBankAccountIds(counted([["sav", 900], ["card", 300]]),
      [acct("sav", "savings", 900, 20), acct("card", "debt", 300, 20)], NOW).join() === "sav,card");
  check("a provider attestation (balanceLastUpdatedAt) is the clock when present",
    staleMaterialBankAccountIds(counted([["chk", 4_000]]),
      [acct("chk", "checking", 4_000, 0.1, { balanceLastUpdatedAt: ago(STALE_AFTER_DAYS + 2) })], NOW).join() === "chk");
  check("manual accounts are not feeds ⇒ never stale-bank",
    !isFedBankAccount({ type: "checking", syncStatus: "manual" })
    && staleMaterialBankAccountIds(counted([["m", 4_000]]), [acct("m", "checking", 4_000, 90, { syncStatus: "manual" })], NOW).length === 0);
  check("investment / crypto / other are not bank balances",
    staleMaterialBankAccountIds(counted([["i", 1], ["c", 1], ["o", 1]]),
      [acct("i", "investment", 1, 90), acct("c", "crypto", 1, 90), acct("o", "other", 1, 90)], NOW).length === 0);
  check("zero balance is never material",
    staleMaterialBankAccountIds(counted([["chk", 0]]), [acct("chk", "checking", 0, 90)], NOW).length === 0);
  // MATERIAL_VALUE_SHARE of the Space's total |value| (space-freshness.ts).
  const total = 100_000;
  const below = total * MATERIAL_VALUE_SHARE * 0.5;
  check(`below MATERIAL_VALUE_SHARE (${MATERIAL_VALUE_SHARE}) of total value ⇒ immaterial`,
    staleMaterialBankAccountIds(counted([["big", total - below], ["tiny", below]]),
      [acct("big", "checking", total - below, 1), acct("tiny", "savings", below, 90)], NOW).length === 0);
  check("at/above the share ⇒ material",
    staleMaterialBankAccountIds(counted([["big", 90_000], ["small", 10_000]]),
      [acct("big", "checking", 90_000, 1), acct("small", "savings", 10_000, 90)], NOW).join() === "small");
}

async function partTwoWriter(): Promise<void> {
  const { regenerateSpaceSnapshot } = await import("@/lib/snapshots/regenerate");

  console.log("\n2. FRESH bank balance ⇒ observed, byte-identical payload");
  const freshAccounts = [
    acct("chk", "checking", 3_000, 0.2),
    acct("sav", "savings", 1_000, 0.2),
    acct("card", "debt", 500, 0.2),
    acct("inv", "investment", 10_000, 0.2),
  ];
  const fresh = makeFake(freshAccounts);
  await regenerateSpaceSnapshot("space-f", SNAP_DATE, fresh.client as never, NOW);
  const f = fresh.upserted as UpsertArgs | null;
  check("wrote a row", f !== null);
  if (f) {
    check("create keys are exactly the pre-fix set (no isEstimated ⇒ schema default false)",
      JSON.stringify(Object.keys(f.create)) === JSON.stringify(PRE_FIX_CREATE_KEYS), Object.keys(f.create).join(","));
    check("update keys are exactly the pre-fix set (isEstimated untouched — no new freeze)",
      JSON.stringify(Object.keys(f.update)) === JSON.stringify(PRE_FIX_UPDATE_KEYS), Object.keys(f.update).join(","));
    const expected = JSON.stringify({
      spaceId: "space-f", date: SNAP_DATE.toISOString(),
      stocks: 10_000, crypto: 0, total: 10_000, cash: 3_000, savings: 1_000, debt: 500,
      netWorth: 13_500, totalAssets: 14_000, netLiquid: 3_500, cashOnHand: 3_000,
      reportingCurrency: "USD",
      completenessTier: null, contributingComponentCount: null, totalComponentCount: null, cryptoValuationStatus: null,
    });
    check("create payload byte-identical to the pre-fix observation", JSON.stringify(f.create) === expected, JSON.stringify(f.create));
  }

  console.log("\n3. STALE bank balance ⇒ same numbers, written as an ESTIMATE");
  const staleAccounts = freshAccounts.map((a) => a.id === "chk" ? { ...a, lastUpdated: ago(STALE_AFTER_DAYS + 5) } : a);
  const stale = makeFake(staleAccounts);
  await regenerateSpaceSnapshot("space-s", SNAP_DATE, stale.client as never, NOW);
  const s = stale.upserted as UpsertArgs | null;
  check("wrote a row (not skipped — W6b: a stale reading is still the best number)", s !== null);
  if (s && f) {
    check("isEstimated: true on create AND update", s.create.isEstimated === true && s.update.isEstimated === true);
    check("completenessTier recorded as 'estimated'", s.create.completenessTier === "estimated" && s.update.completenessTier === "estimated");
    check("numbers unchanged — the stamp qualifies, never rewrites",
      FIELDS.every((k) => s.create[k] === f.create[k] && s.update[k] === f.update[k]));
    const c = resolveSnapshotCompleteness({ isEstimated: true, completenessTier: s.create.completenessTier });
    check("the canonical resolver reads it as a recorded estimate", c.tier === "estimated" && c.recorded === true);
    check("the freshness evidence was read through the injected client, for bank-typed ids only",
      stale.calls.some((x) => x.name === "financialAccount.findMany"
        && x.args?.select?.balanceLastUpdatedAt === true
        && JSON.stringify(x.args.where.id.in) === JSON.stringify(["chk", "sav", "card"])));
  }

  console.log("\n4. A later regeneration REPLACES the estimated row (no freeze)");
  if (s && f) {
    const stored = Object.fromEntries(FIELDS.map((k) => [k, s.create[k]])) as any;
    const regen = (existingIsEstimated: boolean | null): ReturnType<typeof regenerateDay> => regenerateDay({
      date: "2026-03-20",
      existingIsEstimated,
      existing: stored,
      // After the reconnect the true checking balance for that day was 3,600.
      base: { totalInvestments: 10_000, totalDigitalAssets: 0, totalChecking: 3_600, totalSavings: 1_000, totalLiabilities: 500, totalRealAssets: 0 },
      investmentValue: 10_000, investmentTier: "derived", hasInvestmentEvidence: true,
      digitalAssetValue: 0, digitalAssetTier: "observed", hasDigitalAssetEvidence: false,
      cashCardTier: "derived", membershipChangedSince: false,
    } as DayRegenInput);
    const r = regen(s.create.isEstimated);
    check("stale-written row ⇒ regenerateDay writes (not skip-frozen)", r.action === "write", r.action);
    check("…and the corrected cash replaces the stale figure", r.fieldPatch?.cash === 3_600, JSON.stringify(r.fieldPatch));
    // Contrast pin: the pre-fix stamp (schema default false) froze the day.
    check("contrast: an observed (isEstimated=false) row still freezes — the guard is unchanged",
      regen(false).action === "skip-frozen");
    check("no existing row ⇒ writes", regen(null).action === "write");
  }

  console.log("\n5. Crypto staleness behaviour unchanged");
  {
    // Fresh bank + material crypto: exactly as before (status null, observed).
    const fx = makeFake([acct("chk", "checking", 3_000, 0.2), acct("w", "crypto", 2_000, 0.2)]);
    await regenerateSpaceSnapshot("space-c1", SNAP_DATE, fx.client as never, NOW);
    const u = fx.upserted as UpsertArgs | null;
    check("fresh bank + crypto ⇒ cryptoValuationStatus null, no isEstimated key (unchanged)",
      u?.create.cryptoValuationStatus === null && !("isEstimated" in (u?.create ?? {})));
    // Stale bank + material crypto: the row leaves the observation class, so the
    // crypto figure is recorded `supported` — it stays assertable, as before.
    const sx = makeFake([acct("chk", "checking", 3_000, 30), acct("w", "crypto", 2_000, 0.2)]);
    await regenerateSpaceSnapshot("space-c2", SNAP_DATE, sx.client as never, NOW);
    const v = sx.upserted as UpsertArgs | null;
    check("stale bank + crypto ⇒ crypto recorded 'supported'", v?.create.cryptoValuationStatus === "supported");
    check("…which stays assertable (no demotion to legacy-unrecorded)",
      isCryptoAssertable(resolveCryptoValuationState({ crypto: v?.create.crypto, isEstimated: true, cryptoValuationStatus: v?.create.cryptoValuationStatus })));
    const nx = makeFake([acct("chk", "checking", 3_000, 30)]);
    await regenerateSpaceSnapshot("space-c3", SNAP_DATE, nx.client as never, NOW);
    check("stale bank, no crypto ⇒ cryptoValuationStatus null", (nx.upserted as UpsertArgs | null)?.create.cryptoValuationStatus === null);
  }
}

async function partFourUnvalued(): Promise<void> {
  const { regenerateSpaceSnapshot } = await import("@/lib/snapshots/regenerate");

  console.log("\n7. FM-AUDIT-022 — a snapshot EXCLUDING an unvalued wallet is marked incomplete");
  {
    const wallet = acct("w-unobs", "crypto", 999, 0.2, { walletChain: "SOL" }); // stale column, nothing observed
    const fx = makeFake([acct("chk", "checking", 3_000, 0.2), wallet]);
    await regenerateSpaceSnapshot("space-u1", SNAP_DATE, fx.client as never, NOW);
    const u = fx.upserted as UpsertArgs | null;
    check("the unvalued wallet is excluded (crypto 0, never the 999 column)", u?.create.crypto === 0 && u?.create.netWorth === 3_000,
      JSON.stringify(u?.create));
    check("…and the row is stamped completenessTier 'incomplete' (create AND update)",
      u?.create.completenessTier === "incomplete" && u?.update.completenessTier === "incomplete");
    check("…still an observation otherwise (fresh bank ⇒ no isEstimated key)", !("isEstimated" in (u?.create ?? {})));
    check("…which the canonical resolver reads as recorded incomplete",
      resolveSnapshotCompleteness({ isEstimated: false, completenessTier: u?.create.completenessTier }).tier === "incomplete");

    const sx = makeFake([acct("chk", "checking", 3_000, 30), wallet]);
    await regenerateSpaceSnapshot("space-u2", SNAP_DATE, sx.client as never, NOW);
    const v = sx.upserted as UpsertArgs | null;
    check("stale bank + unvalued wallet ⇒ estimate, worst tier 'incomplete' wins over 'estimated'",
      v?.create.isEstimated === true && v?.create.completenessTier === "incomplete");

    const ok = makeFake([acct("chk", "checking", 3_000, 0.2)]);
    await regenerateSpaceSnapshot("space-u3", SNAP_DATE, ok.client as never, NOW);
    check("no unvalued wallet ⇒ tier stays null (unchanged)", (ok.upserted as UpsertArgs | null)?.create.completenessTier === null);
  }

  console.log("\n8. History: a crypto wallet with nativeBalance == null is a holder NOT valued");
  {
    // A licensed day valuing one wallet; a second wallet has no native quantity.
    const valued = { financialAccountId: "w-ok", name: "W1", nativeBalance: 1, assetKey: "BTC", symbol: "BTC", applicable: true };
    const valuation = valueCryptoDay({ accounts: [valued], unitPriceByAssetKey: { BTC: 100 }, quantityLicensed: true });
    const unq = (applicable: boolean) => ({ financialAccountId: "w-null", name: "W2", nativeBalance: null, assetKey: null, symbol: null, applicable });
    check("guard: inside its existence interval it is reported missing",
      cryptoHoldersNotValued({ accounts: [valued, unq(true)] }, valuation).join() === "w-null");
    check("guard: outside it, nothing is claimed", cryptoHoldersNotValued({ accounts: [valued, unq(false)] }, valuation).length === 0);
    const day = regenerateDay({
      date: "2026-03-01", existingIsEstimated: true,
      existing: { stocks: 0, crypto: 50, total: 50, cash: 1_000, savings: 0, debt: 0, netWorth: 1_050, totalAssets: 1_050, netLiquid: 1_000, cashOnHand: 1_000 },
      base: { totalInvestments: 0, totalDigitalAssets: 999, totalChecking: 1_000, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
      investmentValue: 0, investmentTier: "observed", hasInvestmentEvidence: false,
      digitalAssetValue: 100, digitalAssetTier: "estimated", hasDigitalAssetEvidence: true,
      cashCardTier: "derived", membershipChangedSince: false,
      cryptoHoldersNotValued: ["w-null"],
    } as DayRegenInput);
    check("core: that day's crypto is 'unavailable', never 'supported'", day.cryptoValuationStatus === "unavailable", String(day.cryptoValuationStatus));
    check("core: the stored crypto is preserved — neither the 100 partial nor the 999 column is written",
      day.fieldPatch?.crypto === undefined && day.components?.find((c) => c.component === "crypto")?.action === "preserved");

    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    const H = read("lib/snapshots/regenerate-history.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("binding: null-native crypto wallets are collected", /unquantifiedCryptoAccounts = accounts\.filter\(\(a\) => a\.type === "crypto" && a\.nativeBalance == null\)/.test(H));
    check("binding: …and handed to the holder guard with quantity null inside their floor",
      /cryptoHoldersNotValued\(\{\s*accounts: \[\s*\.\.\.cryptoDayAccounts,\s*\.\.\.unquantifiedCryptoAccounts\.map\(\(a\) => \(\{[\s\S]{0,120}nativeBalance: null[\s\S]{0,120}applicable: floorByAccount\.get\(a\.id\)!\.getTime\(\) <= d\.getTime\(\)/.test(H));
    check("binding: crypto is never held flat (the shared predicate admits only checking/savings/debt)",
      /if \(a\.type !== "checking" && a\.type !== "savings" && a\.type !== "debt"\) return false;/.test(read("lib/snapshots/backfill-core.ts")));
  }
}

async function partFiveReview(): Promise<void> {
  const { regenerateSpaceSnapshot } = await import("@/lib/snapshots/regenerate");

  console.log("\n9. S2 review — same-day fresh after stale ⇒ observation; fresh on fresh byte-identical");
  {
    const accounts = [acct("chk", "checking", 3_000, 0.2), acct("sav", "savings", 1_000, 0.2)];
    const afterStale = makeFake(accounts, { isEstimated: true });
    await regenerateSpaceSnapshot("space-r1", SNAP_DATE, afterStale.client as never, NOW);
    const a = afterStale.upserted as UpsertArgs | null;
    check("stale→fresh: update writes isEstimated false", a?.update.isEstimated === false);
    check("stale→fresh: tier cleared (null)", a?.update.completenessTier === null);
    check("stale→fresh: create is still the pre-fix payload (no isEstimated key)",
      JSON.stringify(Object.keys(a?.create ?? {})) === JSON.stringify(PRE_FIX_CREATE_KEYS));
    check("stale→fresh: the row then FREEZES as an observation in history (real evidence)",
      regenerateDay({
        date: "2026-03-20", existingIsEstimated: a?.update.isEstimated,
        base: { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 1, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
        investmentValue: 0, investmentTier: "observed", hasInvestmentEvidence: false,
        digitalAssetValue: 0, digitalAssetTier: "observed", hasDigitalAssetEvidence: false,
        cashCardTier: "derived", membershipChangedSince: false,
      } as DayRegenInput).action === "skip-frozen");

    const onFresh = makeFake(accounts, { isEstimated: false });
    await regenerateSpaceSnapshot("space-r2", SNAP_DATE, onFresh.client as never, NOW);
    const noRow = makeFake(accounts, null);
    await regenerateSpaceSnapshot("space-r2", SNAP_DATE, noRow.client as never, NOW);
    const b = onFresh.upserted as UpsertArgs | null;
    const c = noRow.upserted as UpsertArgs | null;
    check("fresh→fresh: update keys exactly the pre-fix set (byte-identical)",
      JSON.stringify(Object.keys(b?.update ?? {})) === JSON.stringify(PRE_FIX_UPDATE_KEYS));
    check("fresh→fresh and no-row payloads are byte-identical", JSON.stringify(b) === JSON.stringify(c));

    const staleOnStale = makeFake([acct("chk", "checking", 3_000, 30)], { isEstimated: true });
    await regenerateSpaceSnapshot("space-r3", SNAP_DATE, staleOnStale.client as never, NOW);
    check("stale path never reads the same-day row and never writes isEstimated false",
      !staleOnStale.calls.some((x) => x.name === "spaceSnapshot.findUnique")
      && (staleOnStale.upserted as UpsertArgs | null)?.update.isEstimated === true);
  }

  console.log("\n10. S2 review — materiality is measured in the REPORTING currency");
  {
    const D = "2026-03-19";
    const rate = (r: number): Resolution => ({ kind: "rate", rate: r, requestedDateISO: D, effectiveDates: { from: D, to: D }, staleness: "exact" });
    const table: Record<string, Resolution> = { [`JPY|${D}`]: rate(0.007), [`EUR|${D}`]: rate(1.1) };
    const ctx: ConversionContext = {
      target: "USD",
      resolve: (from, dateISO) => table[`${from}|${dateISO}`] ?? { kind: "miss", quote: from, requestedDateISO: dateISO },
    };
    const eligible = [
      { id: "usd", balance: 100_000, currency: "USD" },
      { id: "jpy", balance: 50_000,  currency: "JPY" }, // ¥50,000 ≈ $350 — 33% in native units, 0.3% converted
      { id: "eur", balance: 2_000,   currency: "EUR" }, // €2,000 = $2,200 — over 1%
      { id: "gbp", balance: 10,      currency: "GBP" }, // no rate
    ];
    const counted = countedReportingMagnitudes(eligible, ctx, D);
    const by = new Map(counted.map((x) => [x.id, x.absValue]));
    check("USD passes through, JPY/EUR converted", by.get("usd") === 100_000 && Math.abs(by.get("jpy")! - 350) < 1e-9 && Math.abs(by.get("eur")! - 2_200) < 1e-9);
    check("a rate miss maps to null (unmeasurable)", by.get("gbp") === null);
    const fresh = [acct("usd", "checking", 0, 0.2), acct("jpy", "savings", 0, 30), acct("eur", "savings", 0, 30), acct("gbp", "savings", 0, 30)];
    const ids = staleMaterialBankAccountIds(counted, fresh, NOW);
    check("stale JPY savings worth $350 of $102,550 is IMMATERIAL once converted", !ids.includes("jpy"));
    check("stale EUR savings worth $2,200 is material", ids.includes("eur"));
    check("stale GBP savings with no rate is MATERIAL (fail toward disclosure)", ids.includes("gbp"));
    check("native-unit comparison would have called JPY material (the defect this prevents)",
      staleMaterialBankAccountIds(eligible.map((e) => ({ id: e.id, absValue: e.balance })), fresh, NOW).includes("jpy"));
    check("an unvalued wallet counts nothing", countedReportingMagnitudes([{ id: "w", balance: 5, currency: "USD", valuationUnknown: true }], ctx, D)[0].absValue === 0);

    const R = readFileSync(join(process.cwd(), "lib/snapshots/regenerate.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("the writer converts with the SAME ctx and valuation date it built for classifyAccounts",
      /const valuationDateISO = yesterdayUTCISO\(\);/.test(R)
      && /dates:\s*\[valuationDateISO\]/.test(R)
      && /staleBankAccountIdsForSnapshot\(client, eligible, ctx, valuationDateISO, now\)/.test(R)
      && /countedReportingMagnitudes\(eligible, ctx, valuationDateISO\)/.test(R));
  }
}

function partThreeStatic(): void {
  console.log("\n6. Static pins — one gate, every caller through it");
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  const REGEN = code(read("lib/snapshots/regenerate.ts"));
  const CRYPTO = code(read("jobs/sync-crypto.ts"));
  const PRICES = code(read("jobs/fetch-security-prices.ts"));
  const HIST = code(read("lib/snapshots/regenerate-history.core.ts"));

  check("regenerate.ts has exactly ONE spaceSnapshot.upsert", (REGEN.match(/spaceSnapshot\.upsert\(/g) ?? []).length === 1);
  const gateAt = REGEN.indexOf("staleBankAccountIdsForSnapshot(client, eligible, ctx, valuationDateISO, now)");
  check("the stale-bank gate runs inside regenerateSpaceSnapshot, before its upsert",
    gateAt > REGEN.indexOf("export async function regenerateSpaceSnapshot")
    && gateAt < REGEN.indexOf("spaceSnapshot.upsert("));
  check("the upsert spreads the gated composition on create AND update",
    (REGEN.match(/\.\.\.written,/g) ?? []).length === 2 && !/\.\.\.composition,\s*\n\s*\}/.test(REGEN));
  check("the fresh path IS the unchanged composition object", /staleBankIds\.length === 0 \? composition :/.test(REGEN));
  check("the rule is delegated to the shared core (no per-site threshold)",
    /staleMaterialBankAccountIds\(/.test(REGEN) && !/STALE_AFTER_DAYS|MATERIAL_VALUE_SHARE/.test(REGEN));
  check("regenerateSnapshotsForAccounts routes every space through regenerateSpaceSnapshot",
    /export async function regenerateSnapshotsForAccounts[\s\S]*?await regenerateSpaceSnapshot\(id\)/.test(REGEN));
  check("W6b crypto stale stamp unchanged", /cryptoValuationStatus: accounts\.some\(\(a\) => a\.cryptoStale === true\) \? "stale" as const : null/.test(REGEN));
  check("…and preserved on the stale-bank path", /cryptoValuationStatus: composition\.cryptoValuationStatus\s*\n?\s*\?\?/.test(REGEN));

  for (const [name, src] of [["jobs/sync-crypto.ts", CRYPTO], ["jobs/fetch-security-prices.ts", PRICES]] as const) {
    check(`${name} writes today's snapshot only via regenerateSnapshotsForAccounts (the gated path)`,
      /regenerateSnapshotsForAccounts\(/.test(src) && /from "@\/lib\/snapshots\/regenerate"|import\("@\/lib\/snapshots\/regenerate"\)/.test(src));
    check(`${name} never upserts a SpaceSnapshot itself`, !/spaceSnapshot\.(upsert|create|update)/.test(src));
    check(`${name} carries no per-caller staleness logic`, !/staleMaterialBankAccountIds|stale-bank-balance/.test(src));
  }

  check("history frozen guard keys on isEstimated === false ONLY (estimated rows stay writable)",
    /if \(!isAmendment && existingIsEstimated === false\) \{[\s\S]{0,80}action: "skip-frozen"/.test(HIST)
    && (HIST.match(/"skip-frozen"/g) ?? []).length === 2);
}

void (async () => {
  console.log("FM-AUDIT-021 — stale bank balances are estimates, not observations");
  partOneRule();
  await partTwoWriter();
  partThreeStatic();
  await partFourUnvalued();
  await partFiveReview();
  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll FM-AUDIT-021 checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
