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
// v2.6-OWN-2 — the probe must read the population the UI actually reads.
// It previously matched `spaceAccountLinks: { status: ACTIVE }` alone, OMITTING
// the KD-15 visibilityLevel gate that every live transaction read applies. Its
// population was therefore WIDER than any surface it claimed to audit: a
// BALANCE_ONLY/SUMMARY_ONLY shared account contributed rows here and to nothing
// in the product. `bankingTransactionWhere` is the same fragment the list reads,
// the explorer and the count share, so the probe can no longer disagree with
// them about what is in scope.
import { bankingTransactionWhere } from "@/lib/data/banking-population";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";
import { serializeTransactionRow } from "@/lib/transactions/serialize";
import { resolveTransferAssessments } from "@/lib/transactions/transfer-resolution";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { isDebtPayment, isIncome, isTransfer, isRefund } from "@/lib/transactions/flow-predicates";
import { describeRowNature } from "@/lib/transactions/flow-presentation";
import { totalDebtPaid, selectDebtPaymentCashLegs } from "@/lib/transactions/debt-payment-authority";
import type { Transaction } from "@/types";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  \u2713 ${name}`);
  else { failures++; console.error(`  \u2717 ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  // The largest Space — a 151-row demo Space would make every parity check vacuous.
  const spaces = await db.space.findMany({ select: { id: true, name: true, _count: { select: { accountLinks: true } } } });
  const counts = await Promise.all(
    spaces.map(async (s) => ({
      ...s,
      n: await db.transaction.count({
        where: { deletedAt: null, financialAccount: { deletedAt: null, spaceAccountLinks: {
          some: { spaceId: s.id, status: "ACTIVE", visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } } } },
      }),
    })),
  );
  const space = counts.sort((a, b) => b.n - a.n)[0];
  console.log(`\n[AUDIT] UI truth convergence — READ-ONLY`);
  console.log(`  Space: ${space.name}  (${space.n} transactions)`);

  const accounts = await db.financialAccount.findMany({ select: { id: true, type: true, ...ACCOUNT_NAME_SELECT } });
  // v2.6-TRUTH-10 — resolve as the app does; a raw-name probe is not the live path.
  const A = new Map(accounts.map((a) => [a.id, { ...a, name: accountDisplayName(a) }]));

  // ⚠️ `getTransactions` cannot run under tsx — its import graph reaches
  // `server-only`, which only Next resolves. So this probe calls the SAME
  // projection the read boundary calls (`serializeTransactionRow`) over the same
  // rows. It is the boundary's own DTO, not a second derivation.
  const rawRows = await db.transaction.findMany({
    // The CANONICAL banking population — identical to getTransactions,
    // queryTransactions and countTransactions, event projection included.
    where: bankingTransactionWhere(space.id),
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
  // v2.6-OWN-2 — the four named credits are the EVIDENCE TRAIL of a fixed defect
  // (v2.6-TRUTH-3/7), not an invariant. Their PRESENCE is a fact about one
  // database; asserting it made this audit fail on every other corpus, including
  // a fresh seed, for a reason that has nothing to do with correctness.
  //
  // What IS invariant is stated below over the whole population: no issuer credit
  // renders as Income, on any corpus. The named rows are checked when present and
  // reported as absent when not.
  console.log(`\n  the four historically-reported issuer credits, as presentation now labels them:`);
  for (const name of ["MICROSOFT", "HUNGERSTATION", "EasyTime", "Uber"]) {
    const row = incomeRows.find((t) => (t.merchant ?? "").toUpperCase().startsWith(name.toUpperCase()));
    if (!row) { console.log(`    ${name.padEnd(14)} — not in this corpus (reported, not asserted)`); continue; }
    const n = describeRowNature({
      flowType: row.flowType ?? null, incomeSubtype: (row as { incomeSubtype?: string }).incomeSubtype ?? null,
      amount: row.amount, hasOwnedCounterparty: row.counterpartyAccountId != null,
    });
    console.log(`    ${money(row.amount).padStart(11)}  ${name.padEnd(14)} → "${n.label}"  (${n.basis}, tone=${n.tone})`);
    check(`${name} no longer renders as Income`, n.label !== "Income" && n.nature === "ISSUER_CREDIT",
      `renders as "${n.label}"`);
  }
  // THE INVARIANT, corpus-independent: no ISSUER_CREDIT row anywhere renders as
  // Income. Holds vacuously on a corpus with none, which is the correct verdict.
  const issuerCredits = incomeRows.filter(
    (t) => (t as { incomeSubtype?: string }).incomeSubtype === "ISSUER_CREDIT");
  const creditMislabelled = issuerCredits.filter((t) => describeRowNature({
    flowType: t.flowType ?? null, incomeSubtype: (t as { incomeSubtype?: string }).incomeSubtype ?? null,
    amount: t.amount, hasOwnedCounterparty: t.counterpartyAccountId != null,
  }).label === "Income");
  check(`no issuer credit renders as earned income (${issuerCredits.length} row(s))`,
    creditMislabelled.length === 0, `${creditMislabelled.length} mislabelled`);

  // Interest must not read as earned income anywhere.
  const interestRows = incomeRows.filter((t) => (t as { incomeSubtype?: string }).incomeSubtype === "DEPOSIT_INTEREST");
  const interestMislabelled = interestRows.filter((t) => describeRowNature({
    flowType: t.flowType ?? null, incomeSubtype: "DEPOSIT_INTEREST", amount: t.amount,
  }).nature === "EARNED_INCOME");
  check(`interest never renders as earned income (${interestRows.length} rows)`, interestMislabelled.length === 0);

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
  bar("CROSS-SURFACE PARITY — the same question, one answer");
  // Both surfaces now call the SAME authority. The widget passes its windowed
  // rows; the Credit page passes getDebtPaymentRows(). Over the same corpus they
  // must agree exactly.
  const widget = totalDebtPaid(tx as unknown as LiquidityTx[], liqCtx, (t) => Math.abs(t.amount));
  const credit = totalDebtPaid(
    tx.filter((t) => isDebtPayment(t.flowType)) as unknown as LiquidityTx[],
    liqCtx, (t) => Math.abs(t.amount));
  console.log(`  DebtPaymentsWidget scope (all rows)          ${money(widget.total).padStart(14)}   ${widget.count} rows`);
  console.log(`  Credit page scope (DEBT_PAYMENT rows)        ${money(credit.total).padStart(14)}   ${credit.count} rows`);
  check("the two debt surfaces agree exactly", Math.abs(widget.total - credit.total) < 0.005,
    `${widget.total} vs ${credit.total}`);
  console.log(`  liability legs present and EXCLUDED         ${String(widget.excludedLiabilityLegCount).padStart(15)}`);
  // The double count the old lib/debt.ts was one caller away from.
  const naive = tx.filter((t) => isDebtPayment(t.flowType)).reduce((a, t) => a + Math.abs(t.amount), 0);
  console.log(`  naive abs-sum over BOTH legs (the old bug)  ${money(naive).padStart(14)}`);
  // Only meaningful when BOTH legs are present: with no liability leg in the
  // corpus the naive sum and the authority's total legitimately coincide, and
  // asserting a difference would be asserting a property of the data.
  if (widget.excludedLiabilityLegCount > 0) {
    check("the authority does not double-count", Math.abs(naive - widget.total) > 1,
      "naive and authority agree despite liability legs being present");
  } else {
    console.log("  — no liability leg in this corpus; the double-count check is vacuous (reported)");
  }

  const xfersInDebt = selectDebtPaymentCashLegs(tx as unknown as LiquidityTx[], liqCtx)
    .counted.filter((t) => isTransfer((t as unknown as Transaction).flowType));
  check("no transfer is counted as a debt payment", xfersInDebt.length === 0, `${xfersInDebt.length} found`);
  const savingsInDebt = selectDebtPaymentCashLegs(tx as unknown as LiquidityTx[], liqCtx)
    .counted.filter((t) => {
      const cp = (t as unknown as Transaction).counterpartyAccountId;
      return cp != null && ["savings", "checking"].includes(A.get(cp)?.type ?? "");
    });
  check("no savings/checking-destined transfer sits under debt", savingsInDebt.length === 0,
    `${savingsInDebt.length} found`);

  // ── The economic-date and event-identity coverage the DTO carries ────────
  bar("ECONOMIC DATE / EVENT IDENTITY coverage at the read boundary");
  const raw = await db.transaction.findMany({
    where: { deletedAt: null, financialAccount: { deletedAt: null, spaceAccountLinks: {
      some: { spaceId: space.id, status: "ACTIVE", visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } } } },
    select: { id: true, date: true, economicDate: true, transactionEventId: true },
  });
  const drift = raw.filter((r) => r.economicDate && r.economicDate.toISOString().slice(0, 10) !== r.date.toISOString().slice(0, 10));
  console.log(`  rows                        : ${raw.length}`);
  console.log(`  with economicDate           : ${raw.filter((r) => r.economicDate).length}`);
  console.log(`  economicDate ≠ posting date : ${drift.length}  (a surface reading .date shows a different day for these)`);
  console.log(`  linked to a TransactionEvent: ${raw.filter((r) => r.transactionEventId).length}`);
  console.log(`  refunds (flowType=REFUND)   : ${tx.filter((t) => isRefund(t.flowType)).length}`);

  bar("VERDICT");
  if (failures > 0) {
    console.error(`\n[AUDIT] FAILED — ${failures} convergence check(s) still broken.\n`);
    await db.$disconnect();
    process.exit(1);
  }
  console.log(`\n[AUDIT] PASSED — every surface reads its authority. Nothing was written.\n`);
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
