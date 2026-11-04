/**
 * lib/snapshots/live-snapshot-restricted-cash.test.ts   (FIN-E F1 — B10 rollback rehearsal)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/snapshots/live-snapshot-restricted-cash.test.ts
 *
 * DEFECT: today's LIVE writer (regenerateSpaceSnapshot) read its accounts through
 * readSpaceAccountsForSnapshot, whose select never carried `providerSubtype`. The
 * classifier's restricted split (liquidityAccess) therefore saw no subtype, so an
 * HSA checking account counted as unrestricted cash and today's row recorded
 * `restrictedCash = 0` — a RECORDED value, so readers that trust the unrestricted
 * series "only when complete" read it as complete and wrong. The backfill and
 * history writers select the subtype and were right.
 *
 * Pinned here, by EXECUTING the live writer over an in-memory store whose fake
 * honours Prisma `select` (an unselected column is not returned, exactly as in
 * production — so the pre-fix code fails these checks):
 *   1. HSA checking ⇒ today's row restrictedCash = the HSA balance, and the
 *      reader's liquid (cash + savings − restrictedCash) excludes it.
 *   2. PARITY: live writer = backfill writer = history writer for the same Space
 *      and day — the backfill/history per-day computation (classifyAccounts →
 *      computeSnapshotFields + snapshotRestrictedCash; regenerateDay) over the
 *      same accounts produces the identical row.
 *   3. No HSA ⇒ restrictedCash 0 and every other column unchanged.
 *   4. The live account select includes providerSubtype (behavioural + source),
 *      as do the backfill and history selects; all three writers name the ONE
 *      shared classifier (classifyAccounts) and helper (snapshotRestrictedCash).
 * Synthetic figures only. No DB.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Snapshot } from "@/types";
import { classifyAccounts } from "@/lib/account-classifier";
import { computeSnapshotFields, snapshotRestrictedCash } from "./backfill-core";
import { regenerateDay, type DayRegenInput } from "./regenerate-history.core";
import { projectSnapshotSection } from "@/lib/ai/assemblers/snapshot";
import { clipCashHistory } from "@/lib/liquidity/cash-history";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const NOW = new Date("2026-03-10T12:00:00Z");
const DAY = new Date(Date.UTC(2026, 2, 10));
const DAY_ISO = "2026-03-10";

interface FakeAccount {
  id: string; name: string; type: string; balance: number; currency: string;
  providerSubtype: string | null; debtSubtype: string | null; creditLimit: number | null;
  walletChain: string | null; lastUpdated: Date; availableBalance: number | null; balanceObserved: boolean;
  syncStatus: string; balanceLastUpdatedAt: Date; createdAt: Date;
}
const acct = (id: string, type: string, balance: number, over: Partial<FakeAccount> = {}): FakeAccount => ({
  id, name: id, type, balance, currency: "USD", providerSubtype: null, debtSubtype: null, creditLimit: null,
  walletChain: null, lastUpdated: NOW, availableBalance: null, balanceObserved: true, syncStatus: "active",
  balanceLastUpdatedAt: NOW, createdAt: new Date("2025-01-01T00:00:00Z"), ...over,
});

/** Prisma `select` projection: an unselected column is simply not returned. */
function project(row: Record<string, unknown>, select: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) if (v === true && k in row) out[k] = row[k];
  return out;
}

async function runLive(accounts: FakeAccount[]) {
  const upserts: any[] = [];
  const selects: any[] = [];
  const client: any = {
    spaceAccountLink: {
      async findMany(a: any) {
        selects.push(a.select);
        return accounts.map((fa) => ({
          visibilityLevel: "FULL",
          financialAccount: project(fa as any, a.select.financialAccount.select),
        }));
      },
    },
    transaction: { async findMany() { return []; }, async groupBy() { return []; } },
    financialAccount: {
      async findMany(a: any) {
        // The consent gate (select { id } only): no account is consent-pending.
        if (Object.keys(a.select).length === 1) return [];
        const ids: string[] = a.where?.id?.in ?? [];
        return accounts.filter((x) => ids.includes(x.id)).map((x) => project(x as any, a.select));
      },
    },
    space: { async findUnique() { return { reportingCurrency: "USD" }; } },
    spaceSnapshot: { async upsert(a: any) { upserts.push(a); return {}; }, async findUnique() { return null; } },
    positionObservation: { async findMany() { return []; }, async groupBy() { return []; } },
    positionReconstruction: { async findMany() { return []; } },
    manualAssetValuation: { async findMany() { return []; } },
    plaidInvestmentsConsent: { async findMany() { return []; } },
  };
  const { regenerateSpaceSnapshot } = await import("./regenerate");
  await regenerateSpaceSnapshot("space-synthetic", DAY, client, NOW);
  assert.equal(upserts.length, 1, "the live writer upserts exactly today's row");
  return { row: upserts[0].create, update: upserts[0].update, select: selects[0] };
}

/** The backfill writer's per-day computation (backfill.ts), over the rows it maps. */
function backfillRow(accounts: FakeAccount[]) {
  const mapped = accounts.map((a) => ({
    id: a.id, type: a.type, balance: a.balance, currency: a.currency,
    debtSubtype: a.debtSubtype, creditLimit: a.creditLimit, providerSubtype: a.providerSubtype,
  }));
  const c = classifyAccounts(mapped, undefined, DAY_ISO);
  return { ...computeSnapshotFields(c), restrictedCash: snapshotRestrictedCash(c), c };
}

/** The history writer's day rule (regenerate-history.core.ts) over the same base. */
function historyRow(accounts: FakeAccount[]) {
  const { c } = backfillRow(accounts);
  const res = regenerateDay({
    date: DAY_ISO, existingIsEstimated: true, existing: null,
    base: {
      totalInvestments: c.totalInvestments, totalDigitalAssets: c.totalDigitalAssets, totalChecking: c.totalChecking,
      totalSavings: c.totalSavings, totalLiabilities: c.totalLiabilities, totalRealAssets: c.totalRealAssets,
      totalRestrictedCash: c.totalRestrictedCash,
    },
    investmentValue: c.totalInvestments, investmentTier: "derived", hasInvestmentEvidence: true,
    digitalAssetValue: c.totalDigitalAssets, digitalAssetTier: "estimated", hasDigitalAssetEvidence: false,
    cashCardTier: "derived",
  } as DayRegenInput);
  assert.equal(res.action, "write", "history day rule writes the day");
  return { ...res.fields, restrictedCash: res.restrictedCash } as any;
}

const FIELDS = ["stocks", "crypto", "total", "cash", "savings", "debt", "netWorth", "totalAssets", "netLiquid", "cashOnHand", "restrictedCash"] as const;

const asSnapshot = (r: any): Snapshot => ({
  date: DAY_ISO, isEstimated: false, totalCash: r.cash, totalSavings: r.savings, totalInvestments: r.stocks,
  totalCrypto: r.crypto, totalDebt: r.debt, totalAssets: r.totalAssets, netWorth: r.netWorth,
  netLiquid: r.netLiquid, cashOnHand: r.cashOnHand, restrictedCash: r.restrictedCash,
} as Snapshot);

const WITH_HSA = [
  acct("chk", "checking", 10_000),
  acct("hsa", "checking", 5_000, { providerSubtype: "hsa" }),
  acct("sav", "savings", 2_000),
  acct("card", "debt", 500, { creditLimit: 3_000, providerSubtype: "credit card" }),
  acct("brk", "investment", 8_000, { providerSubtype: "brokerage" }),
];
const NO_HSA = WITH_HSA.map((a) => (a.id === "hsa" ? { ...a, providerSubtype: null } : a));

async function main() {
  // ── §1 HSA ⇒ restricted share recorded, liquid excludes it ─────────────────
  const live = await runLive(WITH_HSA);
  {
    assert.equal(live.row.restrictedCash, 5_000, `today's row: restrictedCash = the HSA balance (got ${live.row.restrictedCash})`);
    assert.equal(live.update.restrictedCash, 5_000, "update carries the same value");
    assert.equal(live.row.cash, 15_000, "cash column still ALL checking (HSA included), as every writer stores it");
    assert.equal(live.row.savings, 2_000);
    const ai = projectSnapshotSection([asSnapshot(live.row)], "full")!;
    assert.equal(ai.latest!.liquid, 12_000, "reader liquid = cash + savings − restrictedCash (HSA excluded)");
    const hist = clipCashHistory([asSnapshot(live.row)], DAY_ISO, null, "USD")!;
    assert.equal(hist.basis, "UNRESTRICTED");
    assert.ok(hist.points.every((p) => p.cashNow === 12_000), "Liquidity history: today's point excludes the HSA");
    ok("§1 HSA checking ⇒ today's restrictedCash = 5,000; reader liquid 12,000 (was 17,000)");
  }

  // ── §2 parity: live = backfill = history for the same Space and day ────────
  for (const [label, accounts, liveRow] of [["HSA", WITH_HSA, live.row], ["no HSA", NO_HSA, (await runLive(NO_HSA)).row]] as const) {
    const bf = backfillRow(accounts);
    const rh = historyRow(accounts);
    for (const f of FIELDS) {
      assert.equal(liveRow[f], (bf as any)[f], `${label}: live.${f} (${liveRow[f]}) = backfill.${f} (${(bf as any)[f]})`);
      assert.equal(liveRow[f], rh[f], `${label}: live.${f} (${liveRow[f]}) = history.${f} (${rh[f]})`);
    }
  }
  ok("§2 parity: live writer = backfill writer = history writer, every column, with and without an HSA");

  // ── §3 no HSA ⇒ 0, everything else unchanged ───────────────────────────────
  {
    const plain = await runLive(NO_HSA);
    assert.equal(plain.row.restrictedCash, 0, "no restricted account ⇒ a measured 0");
    for (const f of FIELDS.filter((x) => x !== "restrictedCash")) {
      assert.equal(plain.row[f], live.row[f], `no HSA: ${f} identical to the HSA case (only the split moves)`);
    }
    const ai = projectSnapshotSection([asSnapshot(plain.row)], "full")!;
    assert.equal(ai.latest!.liquid, 17_000, "no HSA ⇒ liquid = all cash + savings, unchanged");
    ok("§3 no HSA ⇒ restrictedCash 0; every stored column and the reader's liquid unchanged");
  }

  // ── §4 the select + the one shared classifier ──────────────────────────────
  {
    assert.equal(live.select.financialAccount.select.providerSubtype, true, "live account read SELECTS providerSubtype");
    const sa = src("./space-accounts.ts");
    assert.ok(/select: \{[^}]*\bproviderSubtype: true\b[^}]*\}/.test(sa), "space-accounts.ts: the select names providerSubtype");
    assert.ok(/providerSubtype: fa\.providerSubtype/.test(sa), "space-accounts.ts: the row forwards providerSubtype to the classifier");
    const live_ = src("./regenerate.ts"), bf = src("./backfill.ts"), rh = src("./regenerate-history.ts");
    assert.ok(/readSpaceAccountsForSnapshot\(spaceId, client\)/.test(live_), "live writer reads through readSpaceAccountsForSnapshot");
    assert.ok(/providerSubtype: true/.test(bf) && /providerSubtype: l\.financialAccount\.providerSubtype/.test(bf), "backfill selects + forwards it");
    assert.ok(/providerSubtype: true/.test(rh) && /providerSubtype: l\.financialAccount\.providerSubtype/.test(rh), "history selects + forwards it");
    for (const [name, s] of [["regenerate", live_], ["backfill", bf], ["regenerate-history", rh]] as const) {
      assert.ok(/from "@\/lib\/account-classifier"/.test(s) && /classifyAccounts\(/.test(s), `${name}: the ONE classifier, classifyAccounts`);
    }
    assert.ok(/snapshotRestrictedCash\(c\)/.test(live_) && /snapshotRestrictedCash\(c\)/.test(bf), "live + backfill: snapshotRestrictedCash(c)");
    assert.ok(/snapshotRestrictedCash\(base\)/.test(src("./regenerate-history.core.ts")), "history core: snapshotRestrictedCash(base)");
    assert.ok(!/liquidityAccess\(|RESTRICTED_DEPOSITORY_SUBTYPES/.test(live_ + sa), "no re-derived restricted rule in the live path");
    ok("§4 live select includes providerSubtype; all three writers share classifyAccounts + snapshotRestrictedCash");
  }

  for (const c of checks) console.log(`  ✓ ${c}`);
  console.log(`live-snapshot-restricted-cash (FIN-E F1): ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
