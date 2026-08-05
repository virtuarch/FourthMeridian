/**
 * scripts/audit-ui-truth-convergence.ts
 *
 * Financial Truth — UI convergence audit. READ-ONLY. Writes nothing, ever.
 *
 * It runs the REAL read boundary and the REAL widget predicates over the live
 * corpus and reports where a presentation surface disagrees with the canonical
 * authority it is supposed to be reading. Every number below is measured, not
 * asserted.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-ui-truth-convergence.ts
 */

import { db } from "@/lib/db";
import { serializeTransactionRow } from "@/lib/transactions/serialize";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { isDebtPayment, isIncome, isTransfer, isRefund } from "@/lib/transactions/flow-predicates";
import type { Transaction } from "@/types";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  // The largest Space — a 151-row demo Space would make every parity check vacuous.
  const spaces = await db.space.findMany({ select: { id: true, name: true, _count: { select: { accountLinks: true } } } });
  const counts = await Promise.all(
    spaces.map(async (s) => ({
      ...s,
      n: await db.transaction.count({ where: { deletedAt: null, financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: s.id, status: "ACTIVE" } } } } }),
    })),
  );
  const space = counts.sort((a, b) => b.n - a.n)[0];
  console.log(`\n[AUDIT] UI truth convergence — READ-ONLY`);
  console.log(`  Space: ${space.name}  (${space.n} transactions)`);

  const accounts = await db.financialAccount.findMany({ select: { id: true, type: true, name: true } });
  const A = new Map(accounts.map((a) => [a.id, a]));

  // ⚠️ `getTransactions` cannot run under tsx — its import graph reaches
  // `server-only`, which only Next resolves. So this probe calls the SAME
  // projection the read boundary calls (`serializeTransactionRow`) over the same
  // rows. It is the boundary's own DTO, not a second derivation.
  const rawRows = await db.transaction.findMany({
    where: { deletedAt: null, flowType: { not: "INVESTMENT" },
             financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: space.id, status: "ACTIVE" } } } },
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } } },
    orderBy: { economicDate: { sort: "desc", nulls: "last" } },
  });
  const tx = rawRows.map((r) => ({
    ...serializeTransactionRow({ ...r, accountType: A.get(r.financialAccountId ?? "")?.type ?? null } as never),
    financialAccountId: r.financialAccountId,
  })) as (Transaction & { financialAccountId: string | null; incomeSubtype?: string | null })[];
  const liqCtx = tierResolver(accounts.map((a) => ({ id: a.id, type: a.type })));
  console.log(`  rows through the canonical projection: ${tx.length}`);

  const liq = (t: Transaction) => classifyLiquidity(t as unknown as LiquidityTx, liqCtx);

  // ── SYMPTOM 1 — what the Debt Payments widget actually counts ────────────
  bar("SYMPTOM 1 — Debt Payments membership vs. flowType");
  const inWidget = tx.filter((t) => { const c = liq(t); return c.effect === "CASH_OUT" && c.reason === "DEBT_PAYMENT"; });
  const byFlow = new Map<string, { n: number; sum: number }>();
  for (const t of inWidget) {
    const k = t.flowType ?? "(null)";
    const g = byFlow.get(k) ?? { n: 0, sum: 0 };
    g.n++; g.sum += Math.abs(t.amount); byFlow.set(k, g);
  }
  console.log(`  rows the widget counts as debt payments: ${inWidget.length}`);
  for (const [k, g] of [...byFlow].sort((a, b) => b[1].sum - a[1].sum)) {
    const flag = k === "DEBT_PAYMENT" ? "" : "   ⚠️ NOT a canonical DEBT_PAYMENT";
    console.log(`    ${k.padEnd(14)} ${String(g.n).padStart(4)} rows  ${money(g.sum).padStart(14)}${flag}`);
  }
  const nonDebt = inWidget.filter((t) => !isDebtPayment(t.flowType));
  if (nonDebt.length) {
    console.log(`\n  the ${nonDebt.length} non-DEBT_PAYMENT rows the widget counts:`);
    for (const t of nonDebt.slice(0, 15)) {
      const own = t.financialAccountId ? A.get(t.financialAccountId) : undefined;
      const cp = t.counterpartyAccountId ? A.get(t.counterpartyAccountId) : undefined;
      console.log(`    ${String(t.date).slice(0, 10)}  ${money(t.amount).padStart(12)}  ${t.flowType}` +
        `\n        ${(t.merchant ?? "").slice(0, 62)}` +
        `\n        own=${own?.name} (${own?.type})  →  cp=${cp ? `${cp.name} (${cp.type})` : "(none)"}`);
    }
  }
  // The other direction: canonical debt payments the widget does NOT show.
  const canonicalDP = tx.filter((t) => isDebtPayment(t.flowType));
  const missed = canonicalDP.filter((t) => { const c = liq(t); return !(c.effect === "CASH_OUT" && c.reason === "DEBT_PAYMENT"); });
  const missedBy = new Map<string, number>();
  for (const t of missed) { const c = liq(t); const k = `${c.effect}/${c.reason}`; missedBy.set(k, (missedBy.get(k) ?? 0) + 1); }
  console.log(`\n  canonical DEBT_PAYMENT rows: ${canonicalDP.length}; not shown by the widget: ${missed.length}`);
  for (const [k, n] of [...missedBy].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${n}`);

  // ── SYMPTOM 2 — issuer credits / refunds presented as income ─────────────
  bar("SYMPTOM 2 — issuer credits & refunds presented as income");
  const incomeRows = tx.filter((t) => isIncome(t.flowType));
  console.log(`  rows carrying flowType=INCOME: ${incomeRows.length}`);
  // The DTO the read boundary ALREADY emits — not a re-derivation. If the
  // drawer disagrees with these fields, the drawer is the thing that is wrong.
  const buckets = new Map<string, { n: number; sum: number; sample: string[] }>();
  for (const t of incomeRows) {
    const k = (t as { incomeSubtype?: string | null }).incomeSubtype ?? "(no attribution emitted)";
    const g = buckets.get(k) ?? { n: 0, sum: 0, sample: [] };
    g.n++; g.sum += t.amount;
    if (g.sample.length < 3) g.sample.push(`${money(t.amount)} ${(t.merchant ?? "").slice(0, 44)}`);
    buckets.set(k, g);
  }
  for (const [k, g] of [...buckets].sort((a, b) => b[1].sum - a[1].sum)) {
    const flag = /SALARY|CONTRACT|GIG|SELF_EMPLOY/.test(k) ? "" : "   ⚠️ NOT earned income";
    console.log(`    ${k.padEnd(26)} ${String(g.n).padStart(4)} rows  ${money(g.sum).padStart(14)}${flag}`);
    for (const s2 of g.sample) console.log(`        · ${s2}`);
  }
  // Merchant credits that landed on a liability but are typed INCOME.
  const onLiability = incomeRows.filter((t) => t.financialAccountId && A.get(t.financialAccountId)?.type === "debt");
  console.log(`\n  ⚠️ INCOME rows sitting on a LIABILITY account: ${onLiability.length}` +
    ` — a card credit is a refund/issuer credit, never earned income`);
  for (const t of onLiability.slice(0, 12)) {
    console.log(`    ${String(t.date).slice(0, 10)}  ${money(t.amount).padStart(11)}` +
      `  subtype=${String((t as { incomeSubtype?: string | null }).incomeSubtype)}` +
      `  ${(t.merchant ?? "").slice(0, 42)}  [${A.get(t.financialAccountId!)?.name}]`);
  }
  const microsoft = tx.filter((t) => /microsoft|msft/i.test(`${t.merchant ?? ""} ${t.description ?? ""}`));
  console.log(`\n  Microsoft-matching rows in this Space: ${microsoft.length}`);
  for (const t of microsoft.slice(0, 10)) {
    const c = liq(t);
    console.log(`    ${String(t.date).slice(0, 10)}  ${money(t.amount).padStart(11)}  flow=${String(t.flowType).padEnd(13)}` +
      ` liq=${c.effect}/${c.reason}  ${(t.merchant ?? "").slice(0, 40)}  [${A.get(t.financialAccountId ?? "")?.type}]`);
  }

  // ── SYMPTOM 3 — internal transfers inside debt-payment totals ────────────
  bar("SYMPTOM 3 — transfers contributing to debt-payment totals");
  const transfersInDebt = inWidget.filter((t) => isTransfer(t.flowType));
  const sum = transfersInDebt.reduce((s, t) => s + Math.abs(t.amount), 0);
  console.log(`  TRANSFER rows inside the Debt Payments total: ${transfersInDebt.length}  ${money(sum)}`);
  const withCp = transfersInDebt.filter((t) => t.counterpartyAccountId);
  console.log(`  ...with a resolved counterparty account     : ${withCp.length}`);
  console.log(`  ...with NO counterparty (tier inferred)     : ${transfersInDebt.length - withCp.length}`);

  // ── Two debt totals, two surfaces ────────────────────────────────────────
  bar("CROSS-SURFACE PARITY — the same question, two answers");
  const widgetTotal = inWidget.reduce((a, t) => a + Math.abs(t.amount), 0);
  // DebtClient path: `totalDebtPaid` over rows scoped to DEBT accounts, by
  // flowType alone (lib/debt.ts). No liquidity classification.
  const debtAcctRows = tx.filter((t) => t.financialAccountId && A.get(t.financialAccountId)?.type === "debt");
  const clientTotal = debtAcctRows.filter((t) => isDebtPayment(t.flowType)).reduce((a, t) => a + Math.abs(t.amount), 0);
  // What lib/debt.ts would produce if handed BOTH legs (any unscoped caller).
  const bothLegs = tx.filter((t) => isDebtPayment(t.flowType)).reduce((a, t) => a + Math.abs(t.amount), 0);
  console.log(`  DebtPaymentsWidget  (classifyLiquidity, cash leg)   ${money(widgetTotal).padStart(14)}   ${inWidget.length} rows`);
  console.log(`  DebtClient          (flowType, liability leg)       ${money(clientTotal).padStart(14)}   ${debtAcctRows.filter((t) => isDebtPayment(t.flowType)).length} rows`);
  console.log(`  ⚠️ divergence                                       ${money(Math.abs(widgetTotal - clientTotal)).padStart(14)}`);
  console.log(`  totalDebtPaid over BOTH legs (unscoped caller)      ${money(bothLegs).padStart(14)}   ← double count`);
  const xfersOnDebt = debtAcctRows.filter((t) => isTransfer(t.flowType));
  console.log(`\n  TRANSFER rows sitting on a debt account             ${money(xfersOnDebt.reduce((a,t)=>a+Math.abs(t.amount),0)).padStart(14)}   ${xfersOnDebt.length} rows`);
  console.log(`     (SpaceDashboard's "Debt Space preview = the PAYMENTS story" shows every`);
  console.log(`      row on a debt account, so these appear under a payments heading.)`);

  // ── The economic-date and event-identity coverage the DTO carries ────────
  bar("ECONOMIC DATE / EVENT IDENTITY coverage at the read boundary");
  const raw = await db.transaction.findMany({
    where: { deletedAt: null, financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: space.id, status: "ACTIVE" } } } },
    select: { id: true, date: true, economicDate: true, transactionEventId: true },
  });
  const drift = raw.filter((r) => r.economicDate && r.economicDate.toISOString().slice(0, 10) !== r.date.toISOString().slice(0, 10));
  console.log(`  rows                        : ${raw.length}`);
  console.log(`  with economicDate           : ${raw.filter((r) => r.economicDate).length}`);
  console.log(`  economicDate ≠ posting date : ${drift.length}  (a surface reading .date shows a different day for these)`);
  console.log(`  linked to a TransactionEvent: ${raw.filter((r) => r.transactionEventId).length}`);
  console.log(`  refunds (flowType=REFUND)   : ${tx.filter((t) => isRefund(t.flowType)).length}`);

  console.log(`\n[AUDIT] complete — nothing was written.\n`);
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
