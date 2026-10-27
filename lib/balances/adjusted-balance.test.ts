/**
 * lib/balances/adjusted-balance.test.ts   (v2.7-P0 — adjusted cash balance)
 *
 * The owner-approved contract (docs/plans/P0-CASH-ADJUSTED-BALANCE-CONTRACT-2026-10-27.md):
 *
 *   NO_PENDING        no pending rows                        → C
 *   PENDING_EXCLUDED  A ≠ null and |C + P − A| ≤ ε           → C + P
 *   PENDING_INCLUDED  A ≠ null and |C − A| ≤ ε and P ≠ 0     → C
 *   UNPROVEN          anything else (A = null included)      → C, flagged
 *
 * Sections:
 *   1. the 11 regression cases of contract §6
 *   2. property test over random C / A / P
 *   3. the anonymized Production 10-26 FIXTURE, end to end through the REAL
 *      Space mount loader, the REAL snapshot writer and the REAL AI accounts
 *      assembler (in-memory fakes, no DB) — and the consistency of every total
 *      that reads it: classifier · hero/snapshot-today · donut · ledger ·
 *      net-worth composition · AI accounts totals
 *   4. forward-only basis disclosure
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/balances/adjusted-balance.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  adjustedDepositoryBalance, selectAdjustedBalance, resolveAccountBalances, reconcileAccount,
  ADJUSTED_BALANCE_EPSILON, type AccountBalances,
} from "@/lib/balances/account-balances";
import { NO_PENDING, type PendingContribution } from "@/lib/balances/pending-evidence";
import { ADJUSTED_CASH_BASIS_SINCE, adjustedCashBasisNote, spansAdjustedCashBasis } from "@/lib/balances/adjusted-basis";
import { classifyAccounts, countedBalance } from "@/lib/account-classifier";
import { computeSnapshotFields } from "@/lib/snapshots/backfill-core";
import type { ConversionContext } from "@/lib/money/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

const FRESH = { accountId: "x" } as never; // freshness is composed, never read here

function bal(type: string, C: number, A: number | null, currency = "USD"): AccountBalances {
  return resolveAccountBalances({
    accountId: "x", accountType: type, currency, balance: C, availableBalance: A, freshness: FRESH,
  });
}
function pend(...amounts: number[]): PendingContribution {
  return { count: amounts.length, sum: amounts.reduce((s, a) => s + a, 0), transactionIds: amounts.map((_, i) => `p${i}`) };
}

async function main() {
  // ── 1. Regression cases (contract §6) ──────────────────────────────────────
  console.log("1. contract §6 regression cases");
  {
    // (1) Pending debit NOT reflected in current.
    const r1 = adjustedDepositoryBalance(bal("checking", 1000, 900), pend(-100))!;
    check("(1) pending not in C → PENDING_EXCLUDED, C + P", r1.basis === "PENDING_EXCLUDED" && r1.adjusted === 900 && !r1.flagged);

    // (2) Pending debit already reflected (contract E4).
    const r2 = adjustedDepositoryBalance(bal("checking", 900, 900), pend(-100))!;
    check("(2) pending already in C → PENDING_INCLUDED, C (no second deduction)", r2.basis === "PENDING_INCLUDED" && r2.adjusted === 900);

    // (3) Pending → posted across three syncs: constant, then equals posted C.
    const s1 = adjustedDepositoryBalance(bal("checking", 1000, 900), pend(-60, -40))!;
    const s2 = adjustedDepositoryBalance(bal("checking", 940, 900), pend(-40))!;       // the −60 posted
    const s3 = adjustedDepositoryBalance(bal("checking", 900, 900), NO_PENDING)!;      // all posted
    check("(3) sync 1/2/3 adjusted constant at 900", s1.adjusted === 900 && s2.adjusted === 900 && s3.adjusted === 900);
    check("(3) final state is NO_PENDING and equals posted C", s3.basis === "NO_PENDING" && s3.adjusted === s3.reported);

    // (4) Internal transfer credited at the destination first (the Production pattern).
    const src = adjustedDepositoryBalance(bal("checking", 5000, 3500), pend(-1500))!;
    const dst = adjustedDepositoryBalance(bal("savings", 2500, 1000), NO_PENDING)!;    // posted credit, held
    check("(4) credited-first transfer counted ONCE (source C+P, destination C)",
      src.adjusted + dst.adjusted === 6000 && src.basis === "PENDING_EXCLUDED" && dst.basis === "NO_PENDING");

    // (5) Debited at the source first, destination not yet credited.
    const src5 = adjustedDepositoryBalance(bal("checking", 3500, 3500), NO_PENDING)!;  // posted debit in C
    const dst5 = adjustedDepositoryBalance(bal("savings", 1000, 1000), NO_PENDING)!;
    check("(5) debited-first transfer counted ZERO times (in transit; no disclosure implemented — see report)",
      src5.adjusted + dst5.adjusted === 4500);

    // (6) Available temporarily held (A2/A5): total keeps C; accessible drops.
    const b6 = bal("savings", 17000, 15374.59);
    const r6 = adjustedDepositoryBalance(b6, NO_PENDING)!;
    const rec6 = reconcileAccount(b6, NO_PENDING);
    check("(6) hold: adjusted = C 17,000; reachable = A 15,374.59", r6.adjusted === 17000 && rec6.reachable?.amount === 15374.59);

    // (7) Missing available balance (contract E5).
    const r7 = adjustedDepositoryBalance(bal("checking", 1000, null), pend(-50))!;
    check("(7) A = null → UNPROVEN, C (never 950), flagged", r7.basis === "UNPROVEN" && r7.adjusted === 1000 && r7.flagged);

    // (8) Duplicate pending + posted (contract E3): never C + 2P.
    const r8 = adjustedDepositoryBalance(bal("checking", 3751.68, 929.01), pend(-1500, -1500, -125.41, -747.26, -300, -150))!;
    check("(8) stale pending beside its posted twin → UNPROVEN, C, never C + 2P",
      r8.basis === "UNPROVEN" && r8.adjusted === 3751.68 && r8.adjusted !== 3751.68 + 2 * r8.pendingSum);

    // (9) Stale / mismatched sync instants: balance from a later sync than the pending set.
    const r9 = adjustedDepositoryBalance(bal("checking", 1200, 1150), pend(-100))!;
    check("(9) mismatched instants → identity fails → UNPROVEN, C", r9.basis === "UNPROVEN" && r9.adjusted === 1200);

    // (10) EUR account in a USD Space: identity in NATIVE, converted once.
    const usd: ConversionContext = Object.freeze({
      target: "USD",
      resolve(from: string, dateISO: string) {
        return { kind: "rate" as const, rate: from === "EUR" ? 1.0833 : 1, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" as const };
      },
    });
    const r10 = adjustedDepositoryBalance(bal("savings", 1000, 900, "EUR"), pend(-100))!;
    check("(10) EUR identity evaluated native → €900", r10.basis === "PENDING_EXCLUDED" && r10.adjusted === 900);
    const c10 = classifyAccounts([{ type: "savings", balance: 1000, adjustedBalance: r10.adjusted, currency: "EUR" }], usd);
    check("(10) converted ONCE at the account's rate (900 × 1.0833)", near(c10.totalSavings, 900 * 1.0833));

    // (11) No pending activity.
    const r11 = adjustedDepositoryBalance(bal("checking", 1234.56, 1000), NO_PENDING)!;
    check("(11) no pending → NO_PENDING, C", r11.basis === "NO_PENDING" && r11.adjusted === 1234.56 && !r11.flagged);

    // Non-depository accounts are untouched.
    check("non-depository → null (investment, crypto, debt, other)",
      ["investment", "crypto", "debt", "other"].every((t) => adjustedDepositoryBalance(bal(t, 100, 50), pend(-10)) === null));
    // ε boundary.
    check("ε: a one-cent mismatch still proves the identity; two cents does not",
      selectAdjustedBalance({ current: 100, available: 89.99, pendingSum: -10, pendingCount: 1 }).basis === "PENDING_EXCLUDED"
      && selectAdjustedBalance({ current: 100, available: 89.98, pendingSum: -10, pendingCount: 1 }).basis === "UNPROVEN");
    check("ε = 0.01", ADJUSTED_BALANCE_EPSILON === 0.01);
  }

  // ── 2. Property test ────────────────────────────────────────────────────────
  console.log("\n2. property: adjusted ∈ {C, C+P}; = C+P only when |C+P−A| ≤ ε");
  {
    let seed = 20261027;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const cents = (x: number) => Math.round(x * 100) / 100;
    let bad = 0, excluded = 0;
    for (let i = 0; i < 20000; i++) {
      const C = cents((rnd() - 0.2) * 20000);
      const count = rnd() < 0.25 ? 0 : 1 + Math.floor(rnd() * 6);
      let P = 0; for (let k = 0; k < count; k++) P = cents(P + (rnd() - 0.8) * 2000);
      const mode = rnd();
      const A = mode < 0.15 ? null : mode < 0.45 ? cents(C + P) : mode < 0.65 ? C : cents(C + (rnd() - 0.5) * 4000);
      const r = selectAdjustedBalance({ current: C, available: A, pendingSum: P, pendingCount: count });
      const inSet = r.adjusted === C || r.adjusted === C + P;
      const exclusiveOk = r.basis !== "PENDING_EXCLUDED" || (A !== null && Math.abs(C + P - A) <= 0.01 + 1e-9);
      const onlyWhen = r.adjusted !== C + P || P === 0 || (A !== null && Math.abs(C + P - A) <= 0.01 + 1e-9);
      const neverDouble = count === 0 || P === 0 || r.adjusted !== C + 2 * P;
      if (!inSet || !exclusiveOk || !onlyWhen || !neverDouble) bad++;
      if (r.basis === "PENDING_EXCLUDED") excluded++;
    }
    check("20,000 random cases satisfy the contract", bad === 0, `${bad} violations`);
    check("the property exercised the C + P branch", excluded > 1000, String(excluded));
  }

  // ── 3. Production 10-26 fixture, end to end ─────────────────────────────────
  console.log("\n3. Production 10-26 fixture — mount · snapshot writer · AI assembler · client totals");
  {
    // Anonymized: masked ids, no names/numbers. C / A / P exactly as observed.
    const NOW = new Date("2026-10-26T21:45:00Z");
    const fa = (id: string, type: string, balance: number, availableBalance: number | null, extra: Record<string, unknown> = {}) => ({
      id, type, institution: `Inst ${id}`, balance, availableBalance, currency: "USD",
      name: id.toUpperCase(), plaidName: null, officialName: null, nickname: null, customName: null, displayName: null, mask: null,
      lastUpdated: NOW, balanceLastUpdatedAt: NOW, creditLimit: null, debtSubtype: null, providerSubtype: null,
      syncStatus: "active", interestRate: null, minimumPayment: null, walletAddress: null, walletChain: null,
      debtProfile: null, connections: [], ...extra,
    });
    const ACCOUNTS = [
      fa("a1", "checking", 5251.68, 929.01),
      fa("a2", "checking", 1500, 0),
      fa("a3", "checking", 1000, 1000),
      fa("a4", "savings", 5000.08, 5000.08),
      fa("a5", "savings", 17000, 15374.59),
      // Non-depository: untouched by the contract.
      fa("inv", "investment", 901.66, 0, { providerSubtype: "brokerage" }),
      fa("card", "debt", 562.37, 33022.48, { creditLimit: 33700 }),
    ];
    const PENDING_A1 = [-1500, -1500, -125.41, -747.26, -300, -150]; // Σ −4,322.67 (6 rows)
    const pendingRows = PENDING_A1.map((amount, i) => ({
      id: `t${i}`, financialAccountId: "a1", amount, plaidTransactionId: null,
      settlementState: "PENDING", pending: true, deletedAt: null,
    }));

    let upserted: any = null;
    const client: any = {
      spaceAccountLink: {
        async findMany() {
          return ACCOUNTS.map((a) => ({
            id: `l-${a.id}`, visibilityLevel: "FULL", addedByUserId: "u1",
            addedByUser: { firstName: "Owner", name: "Owner" }, financialAccount: a,
          }));
        },
      },
      transaction: {
        async findMany(args: any) { return args?.where?.pending === true ? pendingRows : []; },
        async groupBy() { return []; },
      },
      financialAccount: {
        async findMany() { return []; },
      },
      space: { async findUnique() { return { reportingCurrency: "USD" }; } },
      spaceSnapshot: { async upsert(a: any) { upserted = a; return {}; } },
      // Wallet / history readers are reached with no qualifying rows.
      positionObservation: { async findMany() { return []; } },
      manualAssetValuation: { async findMany() { return []; } },
    };

    // (a) THE SPACE MOUNT LOADER — the client payload every Space surface reads.
    const { loadSpaceAccounts } = await import("@/lib/space/mount-composition");
    const spaceAccounts = await loadSpaceAccounts(client, "space-1");
    const byId = new Map(spaceAccounts.map((a: any) => [a.id, a]));
    const a1 = byId.get("a1") as any;
    check("mount: A1 basis PENDING_EXCLUDED, adjusted 929.01, P −4,322.67 (6 rows), balance stays reported",
      a1.currentState.basis === "PENDING_EXCLUDED" && near(a1.adjustedBalance, 929.01)
      && near(a1.currentState.pendingSum, -4322.67) && a1.currentState.pendingCount === 6 && a1.balance === 5251.68);
    check("mount: A2/A3/A4/A5 NO_PENDING, adjusted = reported",
      ["a2", "a3", "a4", "a5"].every((id) => { const r = byId.get(id) as any; return r.currentState.basis === "NO_PENDING" && r.adjustedBalance === r.balance; }));
    check("mount: non-depository rows carry no adjusted claim",
      (byId.get("inv") as any).adjustedBalance === undefined && (byId.get("card") as any).adjustedBalance === undefined);

    // (b) CLIENT TOTALS from that payload.
    const cash = spaceAccounts.filter((a: any) => a.type === "checking" || a.type === "savings");
    const reported = cash.reduce((s: number, a: any) => s + a.balance, 0);
    const c = classifyAccounts(spaceAccounts as any[]);
    const totalCash = c.totalLiquid + c.totalRestrictedCash;
    check("fixture: reported 29,751.76", near(reported, 29751.76));
    check("fixture: adjusted total cash 25,429.09 (classifier)", near(totalCash, 25429.09), String(totalCash));
    check("fixture: pending correction −4,322.67", near(totalCash - reported, -4322.67));

    const { buildCashAccounts } = await import("@/components/space/widgets/liquidity/cash-accounts");
    const { groupCashAccounts } = await import("@/components/space/widgets/liquidity/cash-accounts");
    const { reachableNow } = await import("@/components/space/widgets/liquidity-adapters");
    const ledger = buildCashAccounts(spaceAccounts as any[]);
    const reach = reachableNow(spaceAccounts as any[]);
    check("fixture: accessible 22,303.68 (unchanged, provider-attested)", near(reach.total, 22303.68) && near(ledger.accessible, 22303.68));
    check("fixture: holds 3,125.41", near(ledger.holds, 3125.41) && near(reach.unexplainedTotal, 3125.41));
    check("ledger: Σ rows = total cash; reported + correction = total cash",
      near(ledger.totalCash, totalCash) && near(ledger.reported, 29751.76) && near(ledger.reported + ledger.pendingCorrection, ledger.totalCash));
    for (const by of ["account", "institution", "type"] as const) {
      check(`donut (${by}): Σ groups = total cash`, near(groupCashAccounts(ledger, by).reduce((s, g) => s + g.value, 0), totalCash));
    }
    const { wealthAccountRows } = await import("@/components/space/widgets/wealth-adapters");
    const comp = wealthAccountRows(spaceAccounts as any[]);
    check("net-worth composition rows: Σ = classifyAccounts totalAssets",
      near(comp.reduce((s, r) => s + r.value, 0), c.totalAssets));
    check("net-worth composition: A1 row is 929.01", near(comp.find((r) => r.id === "a1")!.value, 929.01));
    check("countedBalance: depository → adjusted; investment → balance",
      countedBalance(a1) === a1.adjustedBalance && countedBalance(byId.get("inv") as any) === 901.66);

    // (c) THE SNAPSHOT WRITER — today's row.
    const { regenerateSpaceSnapshot } = await import("@/lib/snapshots/regenerate");
    await regenerateSpaceSnapshot("space-1", new Date(Date.UTC(2026, 9, 27)), client);
    const row = upserted?.create;
    check("snapshot today: cash + savings = 25,429.09 (adjusted)", row && near(row.cash + row.savings, 25429.09), row ? String(row.cash + row.savings) : "no row");
    check("snapshot today: totalAssets/netWorth equal the classifier's",
      row && near(row.totalAssets, c.totalAssets) && near(row.netWorth, c.netWorth));
    const fields = computeSnapshotFields(c);
    check("snapshot today ≡ computeSnapshotFields(classifier over the mount payload) — the Cash hero present-day",
      row && near(row.cash, fields.cash) && near(row.savings, fields.savings) && near(row.netLiquid, fields.netLiquid));

    // (d) THE AI ACCOUNTS ASSEMBLER.
    await import("@/lib/ai/assemblers/accounts");
    const { getAssembler } = await import("@/lib/ai/assembler-registry");
    const { FinanceDomains } = await import("@/lib/ai/types");
    const assemble = getAssembler(FinanceDomains.ACCOUNTS)!;
    const section = await assemble(client, { spaceId: "space-1", userId: "u1" } as any, { scopeHint: "full" } as any);
    const data = section?.data as any;
    check("AI: totalLiquid = 25,429.09 (adjusted)", data && near(data.totalLiquid, 25429.09), data ? String(data.totalLiquid) : "no data");
    check("AI: totalAssets / netWorth equal the classifier's", data && near(data.totalAssets, c.totalAssets) && near(data.netWorth, c.netWorth));
    const aiA1 = data?.accounts?.find((a: any) => a.id === "a1");
    check("AI: A1 row — balance reported, currentState.adjustedBalance 929.01, basis PENDING_EXCLUDED, reportingBalance adjusted",
      aiA1 && aiA1.balance === 5251.68 && near(aiA1.currentState.adjustedBalance, 929.01)
      && aiA1.currentState.balanceBasis === "PENDING_EXCLUDED" && near(aiA1.reportingBalance, 929.01) && !aiA1.currentState.pendingNotReconciled);
    const aiCashSum = (data?.accounts ?? [])
      .filter((a: any) => a.type === "checking" || a.type === "savings")
      .reduce((s: number, a: any) => s + a.reportingBalance, 0);
    check("AI: Σ per-account cash reportingBalance = totalLiquid (rows and totals reconcile)", near(aiCashSum, data?.totalLiquid ?? NaN));

    // (e) ALL SURFACES AGREE.
    const all = [totalCash, ledger.totalCash, row ? row.cash + row.savings : NaN, data?.totalLiquid ?? NaN,
      groupCashAccounts(ledger, "account").reduce((s, g) => s + g.value, 0)];
    check("hero/snapshot-today · classifier · donut · ledger · AI accounts all = Σ adjusted",
      all.every((v) => near(v, 25429.09)), all.join(" / "));
  }

  // ── 4. Forward-only basis disclosure ────────────────────────────────────────
  console.log("\n4. forward-only basis disclosure (no schema)");
  {
    check("ADJUSTED_CASH_BASIS_SINCE is the develop release date 2026-10-28", ADJUSTED_CASH_BASIS_SINCE === "2026-10-28");
    check("a window spanning the release discloses", spansAdjustedCashBasis("2026-09-28", "2026-10-28") && adjustedCashBasisNote("2026-09-28", "2026-10-30") !== null);
    check("a window entirely after the release does not", adjustedCashBasisNote("2026-10-28", "2026-11-30") === null);
    check("a window entirely before the release does not", adjustedCashBasisNote("2026-09-01", "2026-10-26") === null);
    check("the note names the date and both bases", /Oct 28, 2026/.test(adjustedCashBasisNote("2026-10-01", "2026-10-28") ?? "")
      && /bank-reported/.test(adjustedCashBasisNote("2026-10-01", "2026-10-28") ?? ""));
    const { readFileSync } = await import("node:fs");
    const src = (f: string) => readFileSync(f, "utf8");
    check("historical writers do NOT read the adjusted balance (posted anchor + posted deltas stay paired)",
      !/adjustedBalance|countedBalance|adjustedDepositoryBalance/.test(src("lib/snapshots/backfill.ts"))
      && !/adjustedBalance|countedBalance|adjustedDepositoryBalance/.test(src("lib/snapshots/regenerate-history.ts")));
    check("the Wealth trend renders the basis note", /<AdjustedBasisNote/.test(src("components/space/widgets/wealth/WealthWorkspace.tsx"))
      && /data-adjusted-basis-note/.test(src("components/space/widgets/wealth/AdjustedBasisNote.tsx")));
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { AdjustedBasisNote } = await import("@/components/space/widgets/wealth/AdjustedBasisNote");
    check("AdjustedBasisNote renders across the release, nothing otherwise",
      renderToStaticMarkup(createElement(AdjustedBasisNote, { from: "2026-10-01", to: "2026-10-28" })).includes("data-adjusted-basis-note")
      && renderToStaticMarkup(createElement(AdjustedBasisNote, { from: "2026-10-28", to: "2026-11-28" })) === "");
  }

  if (failures > 0) { console.error(`\n${failures} adjusted-balance check(s) failed`); process.exit(1); }
  console.log("\nAll adjusted-balance checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
