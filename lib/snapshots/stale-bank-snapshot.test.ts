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
import { staleMaterialBankAccountIds, isFedBankAccount } from "./stale-bank-balance.core";
import { STALE_AFTER_DAYS } from "@/lib/freshness/observation";
import { MATERIAL_VALUE_SHARE } from "@/lib/freshness/space-freshness";
import { regenerateDay, type DayRegenInput } from "./regenerate-history.core";
import { resolveSnapshotCompleteness } from "./snapshot-completeness.core";
import { resolveCryptoValuationState, isCryptoAssertable } from "./crypto-valuation-status.core";

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
}

function acct(id: string, type: string, balance: number, ageDays: number, over: Partial<FakeAccount> = {}): FakeAccount {
  return {
    id, type, balance, currency: "USD", syncStatus: "active",
    lastUpdated: ago(ageDays), balanceLastUpdatedAt: null, ...over,
  };
}

type UpsertArgs = { where: any; create: any; update: any };

function makeFake(accounts: FakeAccount[]) {
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
            walletChain: null, lastUpdated: a.lastUpdated, availableBalance: null,
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
    },
    positionObservation: { async findMany() { return []; } },
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

function partThreeStatic(): void {
  console.log("\n6. Static pins — one gate, every caller through it");
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  const REGEN = code(read("lib/snapshots/regenerate.ts"));
  const CRYPTO = code(read("jobs/sync-crypto.ts"));
  const PRICES = code(read("jobs/fetch-security-prices.ts"));
  const HIST = code(read("lib/snapshots/regenerate-history.core.ts"));

  check("regenerate.ts has exactly ONE spaceSnapshot.upsert", (REGEN.match(/spaceSnapshot\.upsert\(/g) ?? []).length === 1);
  const gateAt = REGEN.indexOf("staleBankAccountIdsForSnapshot(client, eligible, now)");
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
  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll FM-AUDIT-021 checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
