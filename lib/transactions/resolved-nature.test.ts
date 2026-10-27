/**
 * lib/transactions/resolved-nature.test.ts   (v2.7-P0)
 *
 * THE RESOLVED TRANSACTION NATURE CONTRACT — regression probes.
 *
 *     A transfer between two owned depository accounts NEVER reduces debt.
 *
 * Pure, in-memory. No DB, no Plaid, no model. The fixture is the anonymised
 * Production pattern of 2026-10-23..26 (docs/plans/P1-AMEX-TRANSFER-
 * CLASSIFICATION-AUDIT-2026-10-27.md §2): Chase checking legs out to an Amex HYSA,
 * Amex checking, Schwab checking, a Chase card, an Apple Cash P2P send, plus a real
 * loan payment. "Before" = the HISTORICAL UNREPAIRED rows (provider DEBT_PAYMENT);
 * "after" = the same rows once the transfer authority's write
 * (decideTransferDebtPaymentCorrection) has reached them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveTransactionNature, categoryForNature, natureEvidenceFromRow, NATURE_DESCRIPTION,
  INTERNAL_NATURES, MOVEMENT_NATURES, type NatureEvidence, type TransactionNature,
} from "./resolved-nature";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "./liquidity";
import { selectDebtPaymentCashLegs, totalDebtPaid } from "./debt-payment-authority";
import { computeDebtService } from "./debt-service";
import { foldEconomicRow, type EconomicAccumulator } from "./cash-flow";
import { rollupDebtPaymentsByAccount } from "@/lib/debt";
import { describeRowNature } from "./flow-presentation";
import { decideTransferDebtPaymentCorrection, CORRECTION_SHAPES } from "./transfer-debt-payment-correction";

// ── The anonymised Production fixture ────────────────────────────────────────

const ACCOUNTS = [
  { id: "chaseChk", type: "checking" },
  { id: "schwabChk", type: "checking" },
  { id: "amexChk", type: "checking" },
  { id: "amexHysa", type: "savings" },
  { id: "chaseCard", type: "debt" },
  { id: "autoLoan", type: "debt" },
];
const TYPE = new Map(ACCOUNTS.map((a) => [a.id, a.type]));
const typeOf = (id: string) => TYPE.get(id);
const CTX = tierResolver(ACCOUNTS);

interface Row {
  id: string; own: string; amount: number; flowType: string; category: string;
  maturity?: string | null; cp?: string | null; disposition?: string | null;
  flowAuthority?: string; categorySource?: string | null;
  pfcPrimary?: string | null; pfcDetailed?: string | null;
  evidenceLevel?: string; pending?: boolean;
  classificationReason?: string; classificationConfidence?: number;
}

/** BEFORE the repair: exactly as stored on Production (provider DEBT_PAYMENT on the Amex pulls). */
const BEFORE: Row[] = [
  // Chase checking → Amex HYSA, unpaired (type-certain), pending, provider "Payment".
  { id: "hysa1500", own: "chaseChk", amount: -1500, flowType: "DEBT_PAYMENT", category: "Payment",
    maturity: "SAVINGS_TRANSFER", cp: null, evidenceLevel: "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS",
    pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT", pending: true },
  // Chase checking → Amex HYSA, paired.
  { id: "hysa125", own: "chaseChk", amount: -125.41, flowType: "DEBT_PAYMENT", category: "Payment",
    maturity: "SAVINGS_TRANSFER", cp: "amexHysa", evidenceLevel: "ACCOUNT_CERTAIN",
    pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT", pending: true },
  // Chase checking → Amex checking, paired.
  { id: "amexChk747", own: "chaseChk", amount: -747.26, flowType: "DEBT_PAYMENT", category: "Payment",
    maturity: "CASH_TRANSFER", cp: "amexChk", evidenceLevel: "ACCOUNT_CERTAIN",
    pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT", pending: true },
  // Chase checking → Schwab checking (always TRANSFER).
  { id: "schwab1500", own: "chaseChk", amount: -1500, flowType: "TRANSFER", category: "Transfer",
    maturity: "CASH_TRANSFER", cp: "schwabChk", evidenceLevel: "ACCOUNT_CERTAIN", pfcPrimary: "TRANSFER_OUT" },
  // Chase checking → Chase card — a GENUINE card payment.
  { id: "card300", own: "chaseChk", amount: -300, flowType: "DEBT_PAYMENT", category: "Payment",
    maturity: "DEBT_PAYMENT", cp: "chaseCard", evidenceLevel: "ACCOUNT_CERTAIN",
    pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
  // Chase checking → auto loan — a GENUINE loan payment.
  { id: "loan450", own: "chaseChk", amount: -450, flowType: "DEBT_PAYMENT", category: "Payment",
    maturity: "DEBT_PAYMENT", cp: "autoLoan", evidenceLevel: "ACCOUNT_CERTAIN",
    pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CAR_PAYMENT" },
  // Apple Cash person-to-person send — external, purpose unknown.
  { id: "apple150", own: "chaseChk", amount: -150, flowType: "TRANSFER", category: "Transfer",
    maturity: "EXTERNAL_PERSON_TRANSFER", disposition: "PAYMENT_APP_MOVEMENT", pfcPrimary: "TRANSFER_OUT" },
  // The matching destination credits.
  { id: "hysaIn1500", own: "amexHysa", amount: 1500, flowType: "TRANSFER", category: "Transfer",
    maturity: "CASH_TRANSFER", cp: "chaseChk" },
  { id: "hysaIn125", own: "amexHysa", amount: 125.41, flowType: "TRANSFER", category: "Transfer",
    maturity: "CASH_TRANSFER", cp: "chaseChk" },
  { id: "amexChkIn", own: "amexChk", amount: 747.26, flowType: "TRANSFER", category: "Transfer",
    maturity: "CASH_TRANSFER", cp: "chaseChk" },
  { id: "schwabIn", own: "schwabChk", amount: 1500, flowType: "TRANSFER", category: "Transfer",
    maturity: "CASH_TRANSFER", cp: "chaseChk" },
  { id: "cardIn300", own: "chaseCard", amount: 300, flowType: "DEBT_PAYMENT", category: "Payment",
    maturity: "DEBT_PAYMENT", cp: "chaseChk" },
  { id: "loanIn450", own: "autoLoan", amount: 450, flowType: "DEBT_PAYMENT", category: "Payment", cp: "chaseChk" },
  // Ordinary economic activity, so the totals are not trivially zero.
  { id: "salary", own: "chaseChk", amount: 4800, flowType: "INCOME", category: "Income" },
  { id: "grocer", own: "chaseChk", amount: -212.5, flowType: "SPENDING", category: "Groceries" },
  { id: "cardBuy", own: "chaseCard", amount: -640, flowType: "SPENDING", category: "Shopping" },
].map((r) => ({ flowAuthority: "CLASSIFIER", categorySource: null, ...r }));

/** AFTER: apply the transfer authority's write rule to every row, exactly as the sync / repair would. */
function applyCorrection(rows: Row[]): Row[] {
  return rows.map((r) => {
    const d = decideTransferDebtPaymentCorrection({
      ownAccountType: typeOf(r.own) ?? null, flowType: r.flowType, flowAuthority: r.flowAuthority ?? null,
      rowCategorySource: r.categorySource ?? null, category: r.category,
      pfcPrimary: r.pfcPrimary ?? null, pfcDetailed: r.pfcDetailed ?? null,
      classificationReason: r.classificationReason ?? null, classificationConfidence: r.classificationConfidence ?? null,
      deleted: false, supersededByPosted: false,
      persistedCounterpartyAccountType: null,
      assessment: r.maturity && r.evidenceLevel ? { evidenceLevel: r.evidenceLevel, maturity: r.maturity } : null,
    });
    if (d.action !== "WRITE") return r;
    return { ...r, ...d.write, flowAuthority: "TRANSFER_AUTHORITY" };
  });
}
const AFTER = applyCorrection(BEFORE);

const evidenceOf = (r: Row): NatureEvidence => ({
  flowType: r.flowType, amount: r.amount, flowAuthority: r.flowAuthority ?? null,
  categorySource: r.categorySource ?? null, transferMaturity: r.maturity ?? null,
  transferDisposition: r.disposition ?? null, ownAccountType: typeOf(r.own) ?? null,
  counterpartyAccountType: r.cp ? typeOf(r.cp) ?? null : null, hasOwnedCounterparty: r.cp != null,
});
const natureOf = (rows: Row[], id: string) => resolveTransactionNature(evidenceOf(rows.find((r) => r.id === id)!));

const asLiquidityTx = (r: Row): LiquidityTx => ({
  id: r.id, accountId: r.own, financialAccountId: r.own, counterpartyAccountId: r.cp ?? null,
  amount: r.amount, flowType: r.flowType, transferMaturity: r.maturity ?? null,
  transferDisposition: r.disposition ?? null, date: "2026-10-24", merchant: "m",
  category: r.category, pending: r.pending ?? false, currency: "USD",
} as unknown as LiquidityTx);

// ── 1. Natures ───────────────────────────────────────────────────────────────

test("1. the fixture correction actually rewrote the three mislabelled Amex pulls (and nothing else)", () => {
  const changed = AFTER.filter((r, i) => r.flowType !== BEFORE[i].flowType).map((r) => r.id).sort();
  assert.deepEqual(changed, ["amexChk747", "hysa125", "hysa1500"]);
  assert.ok(AFTER.filter((r) => changed.includes(r.id)).every((r) => r.flowType === "TRANSFER"
    && r.category === CORRECTION_SHAPES.TRANSFER_CERTAIN.category));
});

const EXPECTED: Record<string, TransactionNature> = {
  hysa1500: "INTERNAL_SAVINGS_TRANSFER",
  hysa125: "INTERNAL_SAVINGS_TRANSFER",
  amexChk747: "INTERNAL_CHECKING_TRANSFER",
  schwab1500: "INTERNAL_CHECKING_TRANSFER",
  card300: "LIABILITY_PAYMENT",
  loan450: "LIABILITY_PAYMENT",
  apple150: "EXTERNAL_TRANSFER",
  hysaIn1500: "INTERNAL_CHECKING_TRANSFER",
  cardIn300: "LIABILITY_PAYMENT",
  loanIn450: "LIABILITY_PAYMENT",
  salary: "INCOME",
  grocer: "SPENDING",
};

for (const [label, rows] of [["BEFORE repair (historical rows)", BEFORE], ["AFTER repair", AFTER]] as const) {
  test(`2. ${label}: every row resolves to its true nature`, () => {
    for (const [id, nature] of Object.entries(EXPECTED)) {
      assert.equal(natureOf(rows, id).nature, nature, id);
    }
  });

  test(`3. ${label}: internal transfers (Amex HYSA, Amex checking, Schwab checking) never reduce debt and are never spending/income`, () => {
    for (const id of ["hysa1500", "hysa125", "amexChk747", "schwab1500", "hysaIn1500", "hysaIn125", "amexChkIn", "schwabIn"]) {
      const n = natureOf(rows, id);
      assert.equal(n.reducesDebt, false, id);
      assert.equal(n.flow, "TRANSFER", id);
      assert.ok(INTERNAL_NATURES.has(n.nature), id);
      assert.equal(n.betweenOwnAccounts, true, id);
      assert.ok(!/lowers what is owed/.test(NATURE_DESCRIPTION[n.nature]), id);
    }
  });

  test(`4. ${label}: the Chase card and the loan payment still reduce debt — cash leg once, card/loan leg named`, () => {
    for (const id of ["card300", "loan450"]) {
      const n = natureOf(rows, id);
      assert.equal(n.reducesDebt, true, id); assert.equal(n.leg, "CASH", id); assert.equal(n.flow, "DEBT_PAYMENT", id);
    }
    for (const id of ["cardIn300", "loanIn450"]) {
      const n = natureOf(rows, id);
      assert.equal(n.reducesDebt, true, id); assert.equal(n.leg, "LIABILITY", id); assert.equal(n.basis, "LIABILITY_LEG", id);
    }
  });

  test(`5. ${label}: the contract never claims a debt reduction the debt-payment authority does not count`, () => {
    const counted = new Set(selectDebtPaymentCashLegs(rows.map(asLiquidityTx), CTX).counted.map((t) => t.id));
    for (const r of rows) {
      if (typeOf(r.own) !== "checking" && typeOf(r.own) !== "savings") continue;
      const n = resolveTransactionNature(evidenceOf(r));
      assert.equal(n.reducesDebt && n.leg === "CASH", counted.has(r.id), r.id);
    }
  });
}

test("6. the Apple Cash P2P send is external, purpose not stated — never debt, never 'between your accounts'", () => {
  const n = natureOf(BEFORE, "apple150");
  assert.equal(n.nature, "EXTERNAL_TRANSFER"); assert.equal(n.reducesDebt, false); assert.equal(n.betweenOwnAccounts, false);
});

// ── 2. Historical unrepaired row, ambiguous rows, precedence ─────────────────

test("7. provider-mislabelled ACH pull: persisted DEBT_PAYMENT + SAVINGS_TRANSFER evidence ⇒ internal transfer, category Transfer", () => {
  const r = BEFORE.find((x) => x.id === "hysa125")!;
  const e = evidenceOf(r);
  const n = resolveTransactionNature(e);
  assert.equal(n.nature, "INTERNAL_SAVINGS_TRANSFER");
  assert.equal(n.basis, "TRANSFER_EVIDENCE");
  assert.equal(categoryForNature("Payment", e, n), "Transfer");
  // The presentation authority already agrees (rung 2 of describeRowNature).
  assert.equal(describeRowNature({ flowType: r.flowType, transferMaturity: r.maturity, amount: r.amount }).nature, "INTERNAL_TRANSFER");
});

test("8. partial / unmatched: a provider DEBT_PAYMENT with no attestation is an UNCLASSIFIED movement — no claim", () => {
  const base: NatureEvidence = { flowType: "DEBT_PAYMENT", amount: -900, flowAuthority: "CLASSIFIER", ownAccountType: "checking" };
  for (const e of [
    base,
    { ...base, transferMaturity: "UNRESOLVED_TRANSFER" },
    // an owned counterparty the viewer cannot type: could be the card — refuse to call it internal
    { ...base, hasOwnedCounterparty: true },
  ]) {
    const n = resolveTransactionNature(e);
    assert.equal(n.nature, "UNCLASSIFIED_MOVEMENT", JSON.stringify(e));
    assert.equal(n.reducesDebt, false); assert.equal(n.flow, "TRANSFER"); assert.equal(n.betweenOwnAccounts, false);
    assert.equal(categoryForNature("Payment", e, n), "Transfer");
  }
  // The transfer authority's own low-confidence write (TYPE_AMBIGUOUS / unpaired) — still unclassified.
  const amb = resolveTransactionNature({ flowType: "TRANSFER", amount: -900, flowAuthority: "TRANSFER_AUTHORITY", ownAccountType: "checking" });
  assert.equal(amb.nature, "UNCLASSIFIED_MOVEMENT"); assert.equal(amb.basis, "PROVIDER");
});

test("9. user override precedence: a human 'Payment' wins over transfer evidence; a human category is never rewritten", () => {
  const e: NatureEvidence = { flowType: "DEBT_PAYMENT", amount: -125.41, categorySource: "USER_OVERRIDE",
    transferMaturity: "SAVINGS_TRANSFER", ownAccountType: "checking", counterpartyAccountType: "savings", hasOwnedCounterparty: true };
  const n = resolveTransactionNature(e);
  assert.equal(n.nature, "LIABILITY_PAYMENT"); assert.equal(n.basis, "USER");
  assert.equal(categoryForNature("Payment", e, n), "Payment");
  // A human "Spending" on a row the authority matured to savings stays spending.
  const s = resolveTransactionNature({ ...e, flowType: "SPENDING", categorySource: "USER_RULE" });
  assert.equal(s.nature, "SPENDING"); assert.equal(s.reducesDebt, false);
  // A human "Transfer" still gets its destination from the evidence — never a debt claim.
  const t = resolveTransactionNature({ ...e, flowType: "TRANSFER" });
  assert.equal(t.nature, "INTERNAL_SAVINGS_TRANSFER"); assert.equal(t.reducesDebt, false);
});

test("10. transfer-authority precedence: a TRANSFER_AUTHORITY DEBT_PAYMENT is a payment; its TRANSFER is not", () => {
  const p = resolveTransactionNature({ flowType: "DEBT_PAYMENT", amount: -300, flowAuthority: "TRANSFER_AUTHORITY", ownAccountType: "checking" });
  assert.equal(p.nature, "LIABILITY_PAYMENT"); assert.equal(p.basis, "TRANSFER_AUTHORITY");
  const t = natureOf(AFTER, "hysa125");
  assert.equal(t.nature, "INTERNAL_SAVINGS_TRANSFER"); assert.equal(t.basis, "TRANSFER_AUTHORITY");
});

test("11. pending and posted legs resolve identically (pending is not evidence of purpose)", () => {
  const pending = BEFORE.find((r) => r.id === "hysa125")!;
  const posted = { ...pending, id: "hysa125posted", pending: false };
  assert.deepEqual(resolveTransactionNature(evidenceOf(pending)), resolveTransactionNature(evidenceOf(posted)));
});

test("12. resync stability: re-applying the correction to AFTER changes nothing, and every nature is unchanged", () => {
  const again = applyCorrection(AFTER);
  assert.deepEqual(again, AFTER);
  for (const r of BEFORE) assert.deepEqual(natureOf(BEFORE, r.id).nature, natureOf(AFTER, r.id).nature, r.id);
});

test("13. a TRANSFER-typed cash leg into an owned card is a payment (the money layer counts it too)", () => {
  const n = resolveTransactionNature({ flowType: "TRANSFER", amount: -200, ownAccountType: "checking",
    counterpartyAccountType: "debt", hasOwnedCounterparty: true });
  assert.equal(n.nature, "LIABILITY_PAYMENT"); assert.equal(n.flow, "DEBT_PAYMENT"); assert.equal(n.leg, "CASH");
  const liq = classifyLiquidity(asLiquidityTx({ id: "x", own: "chaseChk", amount: -200, flowType: "TRANSFER", category: "Transfer", cp: "chaseCard" }), CTX);
  assert.equal(liq.reason, "DEBT_PAYMENT");
});

test("14. natureEvidenceFromRow reads only what the DTO carries and the caller's account lookup", () => {
  const e = natureEvidenceFromRow({ flowType: "DEBT_PAYMENT", amount: -125.41, accountId: "chaseChk",
    transferMaturity: "SAVINGS_TRANSFER", counterpartyAccountId: "amexHysa" }, typeOf);
  assert.equal(e.ownAccountType, "checking"); assert.equal(e.counterpartyAccountType, "savings"); assert.equal(e.hasOwnedCounterparty, true);
  assert.equal(resolveTransactionNature(e).nature, "INTERNAL_SAVINGS_TRANSFER");
});

// ── 3. Money identity before / after ─────────────────────────────────────────

function money(rows: Row[]) {
  const eco: EconomicAccumulator = { income: 0, spendGross: 0, refunds: 0 };
  for (const r of rows) foldEconomicRow(eco, { flowType: r.flowType, amount: r.amount, incomeClass: null } as never);
  const tx = rows.map(asLiquidityTx);
  let cashIn = 0, cashOut = 0;
  for (const t of tx) {
    const c = classifyLiquidity(t, CTX);
    if (c.effect === "CASH_IN") cashIn += Math.abs(t.amount);
    if (c.effect === "CASH_OUT") cashOut += Math.abs(t.amount);
  }
  const debtPaid = totalDebtPaid(tx, CTX, (t) => Math.abs(t.amount));
  const svc = computeDebtService(tx, CTX, (t) => Math.abs(t.amount));
  const rollup = rollupDebtPaymentsByAccount(
    rows.filter((r) => typeOf(r.own) === "debt").map((r) => ({ accountId: r.own, amount: r.amount, flowType: r.flowType, date: "2026-10-24", currency: "USD" })) as never);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    income: round(eco.income), spending: round(eco.spendGross), refunds: round(eco.refunds),
    netCash: round(cashIn - cashOut), debtPaid: round(debtPaid.total), debtPaidCount: debtPaid.count,
    netPaydown: svc.netPaydown, payments: svc.payments, netNewBorrowing: svc.netNewBorrowing,
    rollup: rollup.map((x) => `${x.accountId}:${round(x.total)}`).join(","),
  };
}

test("15. Production-pattern fixture: income, spending, net cash flow, debt totals and payoff analytics are IDENTICAL before vs after", () => {
  const before = money(BEFORE);
  const after = money(AFTER);
  assert.deepEqual(after, before);
  // …and they are the right numbers: only the $300 card and $450 loan payments are debt paid.
  assert.equal(before.debtPaid, 750); assert.equal(before.debtPaidCount, 2);
  assert.equal(before.income, 4800); assert.equal(before.spending, 852.5);
  assert.equal(before.rollup, "autoLoan:450,chaseCard:300");
});

test("16. contract debt reductions on the fixture sum to the debt-payment authority's total (cash legs)", () => {
  for (const rows of [BEFORE, AFTER]) {
    const sum = rows.map((r) => ({ r, n: resolveTransactionNature(evidenceOf(r)) }))
      .filter(({ n }) => n.reducesDebt && n.leg === "CASH")
      .reduce((s, { r }) => s + Math.abs(r.amount), 0);
    assert.equal(sum, 750);
  }
});

// ── 4. Purity ────────────────────────────────────────────────────────────────

test("17. the contract reads no descriptor, merchant, institution or category string", () => {
  const src = readFileSync(join(process.cwd(), "lib/transactions/resolved-nature.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.(merchant|description|merchantDisplayName|institution\w*)\b/.test(src), "reads a descriptor/institution");
  assert.ok(!/amex|american\s*express|chase|schwab|apple/i.test(src), "names an institution");
  // The only category string it knows is the provider's structural "Payment" label, to relabel it.
  const strings = [...src.matchAll(/"(Payment|Transfer)"/g)].map((m) => m[1]);
  assert.ok(strings.every((s) => s === "Payment" || s === "Transfer"));
});

// ── Owner ruling (PR #63) — an unmatched generic bank transfer is NOT "external" ──
test("ruling 1: a derived EXTERNAL_DEPOSITORY_TRANSFER leaf is 'destination not yet confirmed', never external", async () => {
  const { MATURITY_LABEL } = await import("./transfer-maturation");
  const n = resolveTransactionNature({
    flowType: "TRANSFER", amount: -1500, flowAuthority: null, categorySource: null,
    transferMaturity: "EXTERNAL_DEPOSITORY_TRANSFER", transferDisposition: "EXTERNAL_BANK_TRANSFER",
    ownAccountType: "checking", counterpartyAccountType: null, hasOwnedCounterparty: false,
  });
  assert.equal(n.nature, "TRANSFER_DESTINATION_UNCONFIRMED");
  assert.equal(n.reducesDebt, false);
  assert.ok(MOVEMENT_NATURES.has(n.nature), "still a movement — never spending or income");
  assert.equal(MATURITY_LABEL.EXTERNAL_DEPOSITORY_TRANSFER, "Destination not yet confirmed");
  assert.ok(!/not yours|someone else|external/i.test(NATURE_DESCRIPTION.TRANSFER_DESTINATION_UNCONFIRMED));
});
