/**
 * lib/transactions/debt-service.ts   (post-M1 D3)
 *
 * THE answer to "how much of what I paid toward debt actually REDUCED debt?"
 *
 * Pure: no DB, no React, no clock. It adds NO classifier — every fact below is
 * read from an authority that already exists:
 *
 *   · which rows are debt payments      → selectDebtPaymentCashLegs
 *   · which account is a liability      → LiquidityContext.tierOf
 *   · which rows are costs / refunds    → flow-predicates (isCostFlow / isRefund)
 *   · which inflow is borrowed money    → classifyLiquidity reason DEBT_PROCEEDS
 *   · how refunds net against spend     → clampEconomicSpend
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * The economic net (`income − spending`) counts a purchase made ON A CARD as
 * spending the day it happened — correctly; that is what the economic axis is
 * for. The card payment that later settles that purchase is a DEBT_PAYMENT cash
 * leg. `economic net − debt payments` therefore subtracts the same consumption
 * TWICE: once as the purchase, once as its settlement. A household that earns
 * 10,000, puts 6,000 of spending on a card and pays the card in full has a
 * 4,000 surplus; the old subtraction reported −2,000 and graded the deficit
 * `DEBT_DRIVEN`.
 *
 * ── The identity ────────────────────────────────────────────────────────────
 *
 * Split spending by WHERE it was charged. Spending charged to a liquid account
 * drained cash when it happened. Spending charged to a liability did not — it
 * raised what is owed, and cash leaves later, inside a debt payment. So on a
 * cash basis, with respect to liabilities:
 *
 *     cash net = income − spending(liquid) − payments + borrowed cash
 *              = economic net + newChargesOnLiabilities + debtProceeds − payments
 *              = economic net − (payments − newChargesOnLiabilities − debtProceeds)
 *
 * The bracket is the NET PAYDOWN: the part of the cash sent to liabilities that
 * did not merely settle charges the economic net already counted, and was not
 * itself funded by new borrowing. It is, by the same identity, the flow-side
 * reconstruction of how far what is owed FELL over the window on the
 * liabilities the ledger can see. When it is negative the window was a net
 * BORROWING one (charges and advances outran payments).
 *
 * This is deterministic from the window's own rows. It does not need to know
 * WHICH purchases a given payment settled: a full-payer's payments settle last
 * month's statement while this month's charges accrue, and in steady state the
 * two cancel; where they do not, the difference is a real change in the balance
 * owed, which is exactly what the figure claims and no more.
 *
 * ── What each case resolves to ──────────────────────────────────────────────
 *
 *   · Settlement of purchases already in spending — payments ≈ new charges ⇒
 *     net paydown ≈ 0 ⇒ no deficit is manufactured.
 *   · Principal reduction of pre-existing / revolving debt — payments exceed new
 *     charges ⇒ net paydown > 0: a real use of cash that is NOT consumption.
 *   · Interest and fees charged to a liability — they are COST flows, already in
 *     spending, and they sit in `newChargesOnLiabilities`, so the payment that
 *     covers them is not counted against the household a second time.
 *   · Loan / mortgage payments (owner F6, approved 2026-11-08) — a payment to a
 *     CONNECTED installment loan (mortgage, auto, student, personal, other
 *     installment — `liabilityKind` / `debtType`, lib/debt/liability-kind.ts) is
 *     NOT net paydown. It carries interest (and escrow, for a mortgage) that the
 *     lender usually does not post as a separate charge row, so calling it
 *     "paydown" would present the whole payment as principal reduction. Its share
 *     is reported UNSPLIT in `unsplitLoanPayments` (together with F10's untracked
 *     loan payments — ONE figure, one label), never in `netPaydown`. A charge the
 *     lender DID post on that loan (an interest row — already in spending) is
 *     netted out of the loan's share exactly as a card charge nets out of a card
 *     payment, so nothing is counted twice. `netPaydown` covers REVOLVING
 *     liabilities only (cards, HELOCs, lines of credit, overdraft — the same
 *     revolving definition utilization uses).
 *     Unknown-type liabilities (no subtype evidence, no usable limit) are treated
 *     CONSERVATIVELY as unsplit loan payments ("loan payment (not split)"): the
 *     module cannot vouch that their payment was principal. A payment leg whose
 *     creditor account is not established is attributed by the row's provider
 *     loan category when it names an installment loan; otherwise it is revolving
 *     when the Space has no non-revolving liability, else unknown (unsplit).
 *     ⚠️ ATTRIBUTION ONLY — the cash subtracted is unchanged: the window's net
 *     (payments − newCharges − proceeds) is computed exactly as before, and the
 *     installment share is carved OUT of it (capped at it), so
 *     `netPaydown + installment share` equals the pre-F6 netPaydown for every
 *     input. Edge case: when new borrowing (card charges outrunning card
 *     payments, a cash advance, loan proceeds) financed part of a loan payment,
 *     the installment share is capped at the window's positive net — borrowed
 *     money is still never credited as surplus, and the borrowed part of the loan
 *     payment is not reported twice.
 *     A liability that is NOT connected contributes no charges at all — correct,
 *     because its purchases never entered spending either.
 *   · Financing (charges outrun payments), cash advances, loan proceeds — new
 *     borrowing. It offsets payments (refinancing a card with a loan is not a
 *     paydown), and any excess is disclosed as `netNewBorrowing`. It NEVER
 *     improves the after-paydown net: borrowed money is not a surplus.
 *   · Balance transfers — liability → liability, no liquid leg: not a payment,
 *     not a charge, not proceeds. Nothing here moves.
 *   · Mortgage F10 — a payment to an installment loan that is NOT connected (the
 *     liquidity reason UNTRACKED_LOAN_PAYMENT: the provider named the loan payee,
 *     no owned account qualified). It is debt SERVICE, unsplit (principal +
 *     interest, + escrow for a mortgage — owner F6: components not individually
 *     verified), so it is in neither `payments` (the debt-payment
 *     authority counts only attested legs) nor `netPaydown` (there is no tracked
 *     liability it paid down). It is folded into `unsplitLoanPayments` (and kept
 *     as the disclosed subset `untrackedLoanPayments`), and `netAfterDebtPaydown`
 *     subtracts it: the economic net never contained
 *     any of it (it is not spending), so subtracting it once is the cash truth,
 *     and omitting it would report the payment as surplus.
 *
 * ⚠️ Evidence is POSITIVE (the v2.6-DEBT-1 rule). A charge offsets payments only
 * when its own account is a known liability; proceeds only when the liquidity
 * authority names them DEBT_PROCEEDS on a liquid account. An account of unknown
 * tier offsets nothing — the figure then errs toward reporting a paydown, never
 * toward hiding one.
 *
 * ── Four quantities share the words "debt payment"; this is ONE of them ─────
 *
 *   1. OBSERVED flow — counted cash legs (`payments` here; `debtPaymentTotal`,
 *      `measure_flows(cardAndDebtPayments)`). History. Not an obligation.
 *   2. Σ stated minimums NOW — lib/debt/aggregates.ts. A contractual floor.
 *   3. The payoff planner's CHOSEN payment — lib/debt/payoff.ts. A user budget.
 *   4. L1's PROJECTED minimums — lib/ai/conversation/scenario-ledger.ts. A forecast.
 *   Nothing in this module may be substituted for 2–4, or they for it.
 */

import { classifyLiquidity, type LiquidityContext, type LiquidityTx } from "@/lib/transactions/liquidity";
import { selectDebtPaymentCashLegs } from "@/lib/transactions/debt-payment-authority";
import { isCostFlow, isRefund } from "@/lib/transactions/flow-predicates";
import { clampEconomicSpend } from "@/lib/transactions/cash-flow";
import { round2 } from "@/lib/money/round";
import {
  isInstallmentLoanPaymentDetail, liabilityKind, unsplitLoanKind, unsplitLoanKindOf, viewerDebtType,
  UNSPLIT_LOAN_PAYMENT_LABEL_BY_KIND,
  type DebtLabelAccess, type LiabilityKindInput, type UnsplitLoanKind,
} from "@/lib/debt/liability-kind";
import { isRevolvingLine } from "@/lib/accounts/credit-utilization";

/** What the cash sent toward liabilities in a window actually did. All ≥ 0. */
export interface DebtService {
  /** Σ|amount| over the debt-payment authority's counted CASH legs. */
  payments: number;
  /**
   * Cost flows (SPENDING + FEE + INTEREST) charged to liability-tier accounts,
   * net of refunds to those accounts, clamped ≥ 0. A SUBSET of economic
   * spending — the part a debt payment settles rather than adds to.
   */
  newChargesOnLiabilities: number;
  /** Borrowed money that arrived as cash (advance / loan funded to a liquid account). */
  debtProceeds: number;
  /**
   * The part of max(0, payments − newChargesOnLiabilities − debtProceeds) that
   * went to REVOLVING liabilities (cards, HELOCs, lines of credit): cash that
   * reduced what is owed on revolving credit. Owner F6 — payments to installment
   * (and unknown-type) loans are NOT in it; see `unsplitLoanPayments`.
   */
  netPaydown: number;
  /** max(0, newChargesOnLiabilities + debtProceeds − payments): what is owed grew by this, from flows. */
  netNewBorrowing: number;
  /**
   * Owner F6 — THE one unsplit loan-payment figure: the installment (and
   * unknown-type) share of the window's net debt cash, connected loans
   * (net of any lender-posted charge already in spending), PLUS F10's untracked
   * loan payments. Principal, interest and (for a mortgage) escrow are NOT split
   * and NOT individually verified — never principal reduction, never paydown.
   * Labelled by `unsplitLoanPaymentLabel`.
   */
  unsplitLoanPayments: number;
  /** The loan-type variant of `unsplitLoanPayments` (mixed / none ⇒ "unknown"). Viewer-tier aware (P1-R1). */
  unsplitLoanKind: UnsplitLoanKind;
  /** The F6 label for `unsplitLoanPayments` (UNSPLIT_LOAN_PAYMENT_LABEL_BY_KIND). */
  unsplitLoanPaymentLabel: string;
  /**
   * Mortgage F10 — Σ|amount| of cash legs paid to an installment loan that is
   * NOT connected (liquidity reason UNTRACKED_LOAN_PAYMENT). A disclosed SUBSET
   * of `unsplitLoanPayments` — never add the two. In Cash Out; NOT in `payments`,
   * NOT in `netPaydown`, NOT in spending.
   */
  untrackedLoanPayments: number;
}


/**
 * Owner F6 — what this module may know about a liability account: the canonical
 * debt-type evidence (lib/debt/liability-kind.ts) and the viewer's label tier
 * (S2 PRIVACY P1-R1: a non-FULL viewer's label variant comes from the COARSE
 * type only, so "escrow" can never disclose that a shared loan is a mortgage).
 */
export interface DebtServiceLiability extends LiabilityKindInput {
  labelAccess: DebtLabelAccess;
}

export interface DebtServiceOptions {
  /**
   * Account id → its liability facts, for liability-tier accounts. OMITTED ⇒
   * every liability is attributed as revolving (the pre-F6 attribution; test
   * fixtures only). The production assembler always passes it — pinned by
   * lib/transactions/debt-service.test.ts.
   */
  liabilityOf?: (accountId: string) => DebtServiceLiability | undefined;
  /** True when the Space holds any liability that is not revolving (installment
   *  or unknown type). Decides where an unattributed payment leg goes. */
  hasNonRevolvingLiability?: boolean;
}

type Bucket = "revolving" | "unsplit";

/**
 * The F6 bucket of one liability account. Revolving = the utilization
 * definition (`liabilityKind` revolving, or `isRevolvingLine`: not installment
 * and a usable limit — the legacy limit-bearing untyped card). Installment ⇒
 * unsplit. Unknown (no evidence, no limit) ⇒ unsplit — conservative.
 */
export function debtServiceBucket(l: LiabilityKindInput | undefined): Bucket {
  if (!l) return "unsplit";
  const input = { ...l, type: l.type ?? "debt" };
  if (liabilityKind(input) === "revolving" || isRevolvingLine(input)) return "revolving";
  return "unsplit";
}

/** The label variant for one liability, through the viewer's tier (P1-R1). */
function unsplitKindOfLiability(l: DebtServiceLiability): UnsplitLoanKind {
  return unsplitLoanKind(null, viewerDebtType({ ...l, type: l.type ?? "debt" }, l.labelAccess));
}

/** The provider's loan-payee evidence the caller attached (lib/data/transactions.ts / the AI assembler). */
type RowDetail = { loanPaymentDetail?: string | null };

/**
 * Decompose a window's debt service from ANY row set (both legs, the whole
 * banking population — selection is this module's job, not the caller's).
 *
 * `magnitude` converts and absolutes a row (the caller owns the money context,
 * so this stays pure); returning `null` EXCLUDES the row — the caller's rule for
 * unconvertible or non-economic rows applies here exactly as it does to the
 * totals this sits beside.
 */
export function computeDebtService<T extends LiquidityTx>(
  rows: readonly T[],
  ctx: LiquidityContext,
  magnitude: (row: T) => number | null,
  opts: DebtServiceOptions = {},
): DebtService {
  const counted = new Set<T>(selectDebtPaymentCashLegs(rows, ctx).counted);
  const { liabilityOf } = opts;

  let payments = 0;
  let charges  = 0;
  let refunds  = 0;
  let proceeds = 0;
  let untracked = 0;
  // Owner F6 — the unsplit (installment / unknown-type) share, by bucket.
  let unsplitPayments = 0;
  let unsplitCharges  = 0;
  let unsplitRefunds  = 0;
  const connectedKinds: UnsplitLoanKind[] = [];
  const untrackedKinds: UnsplitLoanKind[] = [];

  for (const r of rows) {
    const m = magnitude(r);
    if (m === null) continue;
    const mag = Math.abs(m);

    if (counted.has(r)) {
      payments += mag;
      if (liabilityOf) {
        const cp = r.counterpartyAccountId ?? null;
        const creditor = cp && ctx.tierOf(cp) === "liability" ? liabilityOf(cp) : undefined;
        const detail = (r as RowDetail).loanPaymentDetail ?? null;
        let bucket: Bucket;
        let kind: UnsplitLoanKind;
        if (creditor) {
          bucket = debtServiceBucket(creditor);
          kind = unsplitKindOfLiability(creditor);
        } else if (isInstallmentLoanPaymentDetail(detail)) {
          // Creditor not established, but the provider names an installment-loan payee.
          bucket = "unsplit";
          kind = unsplitLoanKind(detail);
        } else {
          bucket = opts.hasNonRevolvingLiability ? "unsplit" : "revolving";
          kind = "unknown";
        }
        if (bucket === "unsplit") { unsplitPayments += mag; connectedKinds.push(kind); }
      }
      continue;
    }

    const ownId = r.financialAccountId ?? r.accountId ?? null;
    const ownTier = ctx.tierOf(ownId);
    const ft = r.flowType ?? null;

    if (ownTier === "liability") {
      // Same membership as DayFacts.creditCardSpending (cash-flow-projection.ts):
      // a cost flow whose own account is a liability.
      const ownUnsplit = !!liabilityOf && !!ownId && debtServiceBucket(liabilityOf(ownId)) === "unsplit";
      if (isCostFlow(ft)) { charges += mag; if (ownUnsplit) unsplitCharges += mag; }
      else if (isRefund(ft)) { refunds += mag; if (ownUnsplit) unsplitRefunds += mag; }
      continue;
    }

    if (ownTier === "liquid") {
      const reason = classifyLiquidity(r, ctx).reason;
      if (reason === "DEBT_PROCEEDS") proceeds += mag;
      else if (reason === "UNTRACKED_LOAN_PAYMENT") {
        untracked += mag;
        untrackedKinds.push(unsplitLoanKind((r as RowDetail).loanPaymentDetail ?? null));
      }
    }
  }

  const newCharges = clampEconomicSpend(charges, refunds);
  const net = payments - newCharges - proceeds;
  // The pre-F6 figure, unchanged — the cash truth. F6 only ATTRIBUTES it.
  const totalNetPaydown = Math.max(0, net);
  const installmentShare = Math.min(
    totalNetPaydown,
    Math.max(0, unsplitPayments - Math.min(clampEconomicSpend(unsplitCharges, unsplitRefunds), newCharges)),
  );
  const unsplit = installmentShare + untracked;
  const kind = unsplitLoanKindOf([
    ...(installmentShare > 0 ? connectedKinds : []),
    ...(untracked > 0 ? untrackedKinds : []),
  ]);
  return {
    payments:                round2(payments),
    newChargesOnLiabilities: round2(newCharges),
    debtProceeds:            round2(proceeds),
    netPaydown:              round2(totalNetPaydown - installmentShare),
    netNewBorrowing:         round2(Math.max(0, -net)),
    unsplitLoanPayments:     round2(unsplit),
    unsplitLoanKind:         kind,
    unsplitLoanPaymentLabel: UNSPLIT_LOAN_PAYMENT_LABEL_BY_KIND[kind],
    untrackedLoanPayments:   round2(untracked),
  };
}

/**
 * The economic net after the cash that genuinely went to reducing REVOLVING debt
 * and after every unsplit loan payment (owner F6: connected installment loans +
 * Mortgage F10 untracked loans — debt service the economic net never contained;
 * see the module header). The sum subtracted is identical to the pre-F6 figure.
 *
 * ≤ the economic net, always: new borrowing is never credited as surplus, so a
 * household whose spending exceeds its income still reads as exactly that
 * however the gap was financed.
 */
export function netAfterDebtPaydown(
  economicNet: number,
  service: Pick<DebtService, "netPaydown">
    & Partial<Pick<DebtService, "unsplitLoanPayments" | "untrackedLoanPayments">>,
): number {
  // `unsplitLoanPayments` already contains `untrackedLoanPayments` — never add both.
  return economicNet - service.netPaydown - (service.unsplitLoanPayments ?? service.untrackedLoanPayments ?? 0);
}

/**
 * Owner F6 / S2 condition 2 — what the AI receives: ONE unsplit loan-payment
 * figure and its label. The internal subset (`untrackedLoanPayments`) and the
 * label variant are not sent, so the model cannot add a subset to the total it
 * already sits inside, nor read a type the label does not already state.
 */
export type DebtServiceAiView = Omit<DebtService, "untrackedLoanPayments" | "unsplitLoanKind">;

export function debtServiceForAi(s: DebtService): DebtServiceAiView {
  return {
    payments:                s.payments,
    newChargesOnLiabilities: s.newChargesOnLiabilities,
    debtProceeds:            s.debtProceeds,
    netPaydown:              s.netPaydown,
    netNewBorrowing:         s.netNewBorrowing,
    unsplitLoanPayments:     s.unsplitLoanPayments,
    unsplitLoanPaymentLabel: s.unsplitLoanPaymentLabel,
  };
}
