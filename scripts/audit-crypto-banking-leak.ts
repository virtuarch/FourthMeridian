/**
 * scripts/audit-crypto-banking-leak.ts
 *
 * v2.6-CRYPTO-1 — the separation guard. READ-ONLY, writes nothing.
 *
 * Built first as a measuring instrument (report the leak per consumer BEFORE any
 * separation existed), now REQUIRED in CI: it fails the build if a single
 * on-chain movement re-enters a banking population or a banking meaning.
 *
 *   npx tsx --env-file=.env.local scripts/audit-crypto-banking-leak.ts
 *
 * ── What it measures ────────────────────────────────────────────────────────
 *
 * On-chain movements are stored in the banking `Transaction` table and are
 * admitted to the banking population, where every banking authority then
 * assigns them a banking meaning they have no basis for. This script reports,
 * per consumer, exactly how many rows leak and what each one does with them —
 * BEFORE any separation exists, and again after, as the proof.
 *
 * Separation signal: `flowAuthority = CRYPTO_LEDGER`, and nothing else. Not the
 * account name, the institution, the symbol, the description, the
 * classifierVersion or the wallet address. The authority that WROTE the row
 * names itself (v2.6-OWN-1); that is the only honest discriminator, and it is
 * the one a future non-BTC chain inherits for free.
 *
 * ── The doctrine this exists to enforce ─────────────────────────────────────
 *
 *   An on-chain receipt is not automatically income.
 *   An on-chain send is not automatically spending.
 *   A wallet-to-wallet movement is not automatically a banking transfer.
 *
 * Fees, swaps, staking and mining rewards, airdrops and exchange movements
 * belong to a crypto-domain authority that does not exist yet. Until it does,
 * the banking domain must REFUSE meaning rather than guess. Refusing is not a
 * gap — a wrong number is worse than an absent one.
 *
 * ⚠️ Amounts below are NATIVE units (BTC), not dollars. They are reported with
 * the unit named precisely because the defect is that a banking fold reads them
 * as dollar-like. `FxRate` being empty is the only thing that has kept that from
 * becoming a headline.
 */

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

import { BANKING_POPULATION, bankingTransactionWhere } from "@/lib/data/banking-population";
import { isBankingPopulation, isIncome, isCostFlow, isTransfer, isRefund, isDebtPayment } from "@/lib/transactions/flow-predicates";
import { attributeIncome } from "@/lib/transactions/income-source";
import { describeRowNature } from "@/lib/transactions/flow-presentation";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const CRYPTO = "CRYPTO_LEDGER" as const;

/** The population every banking consumer shares, restricted to crypto-owned rows. */
const cryptoOwned: Prisma.TransactionWhereInput = { flowAuthority: CRYPTO };

async function main(): Promise<void> {
  console.log("\n[AUDIT] Crypto → banking leak, per consumer. READ-ONLY\n");

  // ── 0. The population itself ──────────────────────────────────────────────
  bar("0. THE CRYPTO-OWNED POPULATION");
  const total = await db.transaction.count({ where: cryptoOwned });
  const live = await db.transaction.count({ where: { ...cryptoOwned, deletedAt: null } });
  const byFlow = await db.transaction.groupBy({
    by: ["flowType", "currency"], where: { ...cryptoOwned, deletedAt: null }, _count: true, _sum: { amount: true },
  });
  console.log(`  rows owned by ${CRYPTO}      : ${total}  (live: ${live})`);
  for (const g of byFlow) {
    console.log(`    flowType=${String(g.flowType).padEnd(13)} currency=${String(g.currency).padEnd(5)} ` +
      `n=${String(g._count).padStart(4)}  Σ=${g._sum.amount} ${g.currency ?? "(none)"}  ← NATIVE units`);
  }
  const fx = await db.fxRate.count();
  console.log(`\n  FxRate rows in this database : ${fx}` +
    (fx === 0 ? "   ⚠️ the ONLY reason the native magnitudes below are not dollars on a headline" : ""));

  // ── 1. Per-Space: what each banking consumer admits ───────────────────────
  bar("1. PER-CONSUMER LEAK");
  const spaces = await db.space.findMany({ select: { id: true, name: true } });

  let anyLeak = false;
  for (const s of spaces) {
    const where = bankingTransactionWhere(s.id);
    const bankingTotal = await db.transaction.count({ where });
    if (bankingTotal === 0) continue;

    const leaked = await db.transaction.count({ where: { AND: [where, cryptoOwned] } });
    if (leaked === 0) {
      console.log(`  ${s.name.padEnd(26)} banking=${String(bankingTotal).padStart(5)}   crypto-owned admitted: 0  ✓`);
      continue;
    }
    anyLeak = true;
    console.log(`\n  ${s.name}  —  banking population ${bankingTotal}, of which ${leaked} are crypto-owned  ✗`);

    // Load the leaked rows once and ask each authority what it does with them.
    const rows = await db.transaction.findMany({
      where: { AND: [where, cryptoOwned] },
      select: {
        id: true, flowType: true, amount: true, currency: true, merchant: true,
        counterpartyAccountId: true, pfcPrimary: true, pfcDetailed: true,
        financialAccount: { select: { type: true, name: true } },
      },
    });

    // ── the banking predicates, one row at a time ──
    const buckets: Record<string, { n: number; sum: number }> = {};
    const bump = (k: string, amt: number) => {
      buckets[k] = buckets[k] ?? { n: 0, sum: 0 };
      buckets[k].n++; buckets[k].sum += amt;
    };
    for (const r of rows) {
      const f = r.flowType ?? null;
      if (isIncome(f))      bump("bank INCOME", r.amount);
      if (isCostFlow(f))    bump("bank SPENDING (cost flow)", r.amount);
      if (isTransfer(f))    bump("bank TRANSFER", r.amount);
      if (isRefund(f))      bump("bank REFUND", r.amount);
      if (isDebtPayment(f)) bump("bank DEBT_PAYMENT", r.amount);
      if (isBankingPopulation(f)) bump("banking population (row predicate)", r.amount);
    }
    for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1].n - a[1].n)) {
      console.log(`      ${k.padEnd(38)} n=${String(v.n).padStart(3)}  Σ=${v.sum} NATIVE`);
    }

    // ── the income taxonomy's verdict ──
    const incomeVerdicts = new Map<string, { n: number; sum: number }>();
    for (const r of rows) {
      if (!(r.amount > 0 && isIncome(r.flowType ?? null))) continue;
      const a = attributeIncome({
        flowType: r.flowType ?? null,
        providerFamily: r.pfcPrimary ?? null,
        providerDetail: r.pfcDetailed ?? null,
        accountType: (r.financialAccount?.type as string | null) ?? "other",
        amount: r.amount,
        isOwnedInternalTransfer: r.counterpartyAccountId != null,
        sourceAccountId: null,
        liabilityInflowIsIssuerCredit: false,
      });
      const k = `${a.subtype} → ${a.incomeClass}`;
      const g = incomeVerdicts.get(k) ?? { n: 0, sum: 0 };
      g.n++; g.sum += r.amount; incomeVerdicts.set(k, g);
    }
    if (incomeVerdicts.size > 0) {
      console.log(`\n      INCOME TAXONOMY assigns these on-chain receipts:`);
      for (const [k, v] of incomeVerdicts) {
        console.log(`        ${k.padEnd(44)} n=${v.n}  Σ=${v.sum} NATIVE` +
          (k.includes("OTHER_INCOME") ? "   ⚠️ an INCLUDED income class" : ""));
      }
    }

    // ── the label a user sees ──
    const labels = new Map<string, number>();
    for (const r of rows) {
      const n = describeRowNature({
        flowType: r.flowType ?? null, amount: r.amount,
        hasOwnedCounterparty: r.counterpartyAccountId != null,
      });
      labels.set(`${n.label} (${n.direction})`, (labels.get(`${n.label} (${n.direction})`) ?? 0) + 1);
    }
    console.log(`\n      LABEL a user sees on these rows:`);
    for (const [k, n] of [...labels].sort((a, b) => b[1] - a[1])) console.log(`        ${k.padEnd(32)} n=${n}`);
  }

  // ── 2. AI + exports ───────────────────────────────────────────────────────
  bar("2. AI SUMMARIES AND EXPORTS");
  // Both consume BANKING_POPULATION (the AI directly; exports via getTransactions).
  const inFragment = await db.transaction.count({
    where: { AND: [BANKING_POPULATION, cryptoOwned, { deletedAt: null }] },
  });
  console.log(`  rows admitted by the shared BANKING_POPULATION fragment : ${inFragment}`);
  console.log(`    · lib/ai/assemblers/transactions.ts spreads this fragment  → AI summaries ${inFragment > 0 ? "INCLUDE" : "exclude"} them`);
  console.log(`    · lib/export/assemble.ts → getTransactions → same population → exports ${inFragment > 0 ? "INCLUDE" : "exclude"} them`);
  console.log(`    · lib/data/transaction-count.ts + transaction-query.ts     → explorer/count ${inFragment > 0 ? "INCLUDE" : "exclude"} them`);

  // ── 3. What must NOT move ─────────────────────────────────────────────────
  bar("3. THE CRYPTO LEDGER ITSELF — must be untouched by any separation");
  const wallets = await db.financialAccount.findMany({
    where: { type: "crypto", deletedAt: null },
    select: { id: true, name: true, nativeBalance: true, balance: true, walletAddress: true },
  });
  for (const w of wallets) {
    const movements = await db.transaction.count({
      where: { financialAccountId: w.id, deletedAt: null, currency: "BTC" },
    });
    console.log(`  ${w.name.padEnd(28)} native=${String(w.nativeBalance ?? "—").padStart(12)} ` +
      `usd=${String(w.balance).padStart(10)}  wallet=${w.walletAddress ? "Y" : "n"}  movements=${movements}`);
  }
  const obs = await db.positionObservation.count().catch(() => -1);
  const snaps = await db.spaceSnapshot.count();
  console.log(`\n  PositionObservation rows: ${obs}    SpaceSnapshot rows: ${snaps}`);
  console.log("  (reported so a separation that disturbs them is visible immediately)");

  // ── INV-C4 — the taxonomy refuses crypto rows regardless of evidence ──────
  bar("INV-C4 — income attribution refuses an on-chain row whatever else is true");
  // The structural guarantee: adding FX data, a provider family, or a plausible
  // counterparty must NOT be able to turn an on-chain receipt into banking
  // income. Asserted over the REAL rows, with the most income-like evidence a
  // caller could supply.
  const cryptoRows = await db.transaction.findMany({
    where: { ...cryptoOwned, deletedAt: null },
    select: { id: true, flowType: true, amount: true, flowAuthority: true },
  });
  const notRefused = cryptoRows.filter((r) => {
    const a = attributeIncome({
      flowType: r.flowType ?? null,
      flowAuthority: r.flowAuthority as never,
      // Deliberately the most income-shaped evidence available.
      providerFamily: "INCOME",
      providerDetail: "INCOME_WAGES",
      accountType: "checking",
      amount: Math.abs(r.amount) || 1,
      isOwnedInternalTransfer: false,
      liabilityInflowIsIssuerCredit: false,
    });
    return a.incomeClass !== "NOT_INCOME";
  });
  console.log(`  crypto rows tested with maximally income-like evidence : ${cryptoRows.length}`);
  console.log(`  ...attributed to an INCOME class                       : ${notRefused.length}`);
  const c4 = notRefused.length === 0;
  console.log(c4
    ? "  ✓ every one refused — NOT_INCOME / ON_CHAIN_MOVEMENT"
    : `  ✗ ${notRefused.length} on-chain row(s) attributed as banking income`);

  // ── Verdict ───────────────────────────────────────────────────────────────
  bar("VERDICT");
  const clean = !anyLeak && inFragment === 0 && c4;
  if (!clean) {
    console.error("  ✗ on-chain movements are carrying banking meanings.");
    console.error("    The separation signal is on every one of them: flowAuthority = CRYPTO_LEDGER.");
    console.error(
      "\n[AUDIT] FAILED — the banking domain is assigning meaning to an on-chain movement.\n" +
      "A receipt is not income; a send is not spending; a wallet-to-wallet move is not a\n" +
      "banking transfer. Until a crypto-domain authority exists, the banking domain must\n" +
      "REFUSE. See lib/transactions/flow-authority.ts (carriesBankingSemantics).\n",
    );
    process.exitCode = 1;
    return;
  }
  console.log("  ✓ no crypto-owned row enters any banking population or meaning.");
  console.log("\n[AUDIT] PASSED — banking and on-chain are separate. Nothing was written.\n");
}

main()
  .catch((err) => { console.error("audit-crypto-banking-leak failed:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
