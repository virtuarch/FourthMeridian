/**
 * lib/forecast/obligation.ts
 *
 * FORECAST-4 — WHAT THE USER IS ACTUALLY COMMITTED TO PAY.
 *
 * Pure: no DB, no model, no clock of its own, no persistence. Substrate only.
 * Producers adapt live rows into the inputs here; this module decides.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * Asked to project spending, the system read history as commitment. A $7,500
 * card payoff, a holiday, and a round of gifts all landed in "normal monthly
 * spending", and the forecast inherited them. None of those is an obligation.
 * Neither is a merchant seen often.
 *
 * An obligation is a future outflow backed by evidence that the user is
 * COMMITTED to pay it. Having paid before is not that evidence.
 *
 * ── The trap this is built against ──────────────────────────────────────────
 * Measured on the real ledger, the most obligation-shaped thing in the data is
 * not an obligation:
 *
 *   Amazon Prime   26 charges · EVERY ONE exactly $16.32 · monthly · 2 years
 *   T-Mobile       25 charges · the 8th of every month · $108.79–$174.95
 *
 * Prime is more regular than any paycheck in this corpus — zero variance, a
 * clean cadence, two years of history. Any rule built on frequency or amount
 * stability licenses it, and licensing it would be wrong: nothing here says the
 * user is contractually committed, and a subscription can be cancelled between
 * one charge and the next without leaving a trace in the ledger.
 *
 * So regularity is not evidence, and this module cannot see it — it takes no
 * transaction history at all. What it takes is a declared evidence class.
 *
 * ── Why FORECAST-2's activity rule is NOT reused ────────────────────────────
 * It was evaluated and rejected. Income activity infers from silence: expected
 * occurrences missed inside ledger coverage means the stream may not project.
 * That inference inverts for obligations. Missing a mortgage payment does not
 * extinguish a mortgage — it makes the user delinquent, and the obligation is
 * MORE real, not less. Silence cannot cancel a commitment, so an obligation
 * ends only on positive evidence, never on absence.
 */

import { CadenceKind, isCadence, type Cadence } from './cadence';
import {
  AmountBasis, EventProvenance, FlowRole,
  type AmountBasisKind, type EventProvenanceKind, type FlowRoleKind, type FutureCashEvent,
} from './future-cash-event';

// ── Evidence ────────────────────────────────────────────────────────────────

/**
 * Why we believe a future outflow will occur.
 *
 * Two classes, and the list is short because the repository is. The candidates
 * in the brief that were investigated and NOT minted:
 *
 *   provider-attested scheduled payment — does not exist. The database holds
 *     zero forward-dated transactions (established in FORECAST-3). No provider
 *     tells this system about a scheduled debit.
 *
 *   contractual recurring charge — no authority exists. There is no
 *     subscription, bill, rent, utility or membership model anywhere in the
 *     schema; the only thing resembling one is the `Subscriptions` spending
 *     CATEGORY, which classifies what already happened.
 *
 * ⚠️ There is deliberately no evidence class for observed regularity, and none
 * may be added without a real authority behind it. That absence is what makes
 * Amazon Prime's flawless two-year cadence unlicensable.
 */
export const ObligationEvidence = {
  /**
   * The canonical debt terms — `lib/debt/effective-terms.ts`, DebtProfile over
   * the flat column. A minimum payment is a requirement an issuer states, not
   * a pattern inferred from payments made.
   */
  DEBT_TERMS: 'DEBT_TERMS',
  /** The user stated the commitment. */
  USER_ASSERTED: 'USER_ASSERTED',
  /**
   * No evidence class applies. Historical frequency lands here, and it licenses
   * nothing — this value exists so an unlicensed candidate can be REPRESENTED
   * and reviewed rather than silently dropped or silently promoted.
   */
  NONE: 'NONE',
} as const;

export type ObligationEvidenceKind = typeof ObligationEvidence[keyof typeof ObligationEvidence];

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * Whether this obligation may generate events.
 *
 * ⚠️ TERMINATED requires POSITIVE evidence — the user cancelling, or a debt
 * reaching a zero balance. Silence never reaches it, for the reason in the
 * header: not paying a bill does not end the bill.
 */
export const ObligationStatus = {
  ACTIVE: 'ACTIVE',
  TERMINATED: 'TERMINATED',
  /** No evidence class licenses this as an obligation at all. */
  UNLICENSED: 'UNLICENSED',
} as const;

export type ObligationStatusKind = typeof ObligationStatus[keyof typeof ObligationStatus];

// ── Amount ──────────────────────────────────────────────────────────────────

/**
 * What is known about how much leaves.
 *
 * ⚠️ MINIMUM IS NOT FIXED, and the difference decides whether cash may be
 * asserted. A $2,400 rent means exactly $2,400 leaves. An $85 card minimum
 * means AT LEAST $85 leaves and the real figure is whatever the user chooses to
 * pay — so a minimum is a known floor and an unknown movement.
 *
 * On the brief's §9 question — whether NET/GROSS applies to outflows — the
 * existing vocabulary holds without widening, but only two of its three values
 * are reachable. NET means "exactly this much moves", which is right for a
 * fixed obligation. GROSS is genuinely inapplicable: an outflow has no
 * deductions taken from it. UNKNOWN carries both the variable bill and, more
 * interestingly, the minimum — because for a minimum the amount that will
 * actually move is not established, even though a number is known. The floor
 * lives here, on the obligation, where it is true; it does not become a basis.
 */
export const ObligationAmountKind = {
  /** Exactly this much leaves. */
  FIXED: 'FIXED',
  /** At least this much leaves; the actual figure is not established. */
  MINIMUM: 'MINIMUM',
  /** A schedule is known and the figure is not. A variable utility bill. */
  UNKNOWN: 'UNKNOWN',
} as const;

export type ObligationAmountKindName =
  typeof ObligationAmountKind[keyof typeof ObligationAmountKind];

export interface ObligationAmount {
  kind: ObligationAmountKindName;
  /** Null for UNKNOWN. For MINIMUM this is the floor, not the expected payment. */
  value: number | null;
  currency: string;
  /** Independent of the amount KIND — who established the figure. */
  provenance: EventProvenanceKind;
}

/**
 * The FORECAST-3 basis an obligation amount licenses.
 *
 * ⚠️ ONLY FIXED reaches NET. This is the single place the two vocabularies meet,
 * and it is a narrowing, never a promotion.
 */
export function basisForAmount(amount: ObligationAmount): AmountBasisKind {
  return amount.kind === ObligationAmountKind.FIXED && amount.value !== null
    ? AmountBasis.NET
    : AmountBasis.UNKNOWN;
}

// ── The obligation ──────────────────────────────────────────────────────────

/**
 * A commitment to pay, and the limits of what is known about it.
 *
 * ⚠️ There is no `recurring` flag. Recurrence is carried by the cadence or it
 * is not carried at all; a boolean would be exactly the substitute for
 * semantics that turns "seen monthly" into "owed monthly".
 */
export interface Obligation {
  id: string;
  evidence: ObligationEvidenceKind;
  status: ObligationStatusKind;
  role: FlowRoleKind;
  /**
   * When it falls due. Null when no timing authority supplies one — which is
   * the ordinary case for debt today, since due dates live only on DebtProfile.
   *
   * ⚠️ This is the BILLING schedule, never the settlement history. A payment
   * made two days late does not move the due date, which is why this is a
   * declared cadence rather than one derived from past payments.
   */
  schedule: Cadence | null;
  amount: ObligationAmount;
  /** The liability or funding account, where one applies. */
  sourceAccountId?: string;
  /** Why this obligation is in the state it is in. */
  reason: string;
}

// ── Producers ───────────────────────────────────────────────────────────────

/** The canonical debt facts, as resolved by `lib/debt/effective-terms.ts`. */
export interface DebtObligationInput {
  accountId: string;
  accountName: string;
  /** Amount owed. Zero or less means the debt is discharged. */
  balanceOwed: number;
  currency: string;
  /** From `resolveEffectiveDebtTerms` — NEVER re-derived from raw columns. */
  minimumPayment: number | null;
  /**
   * True when the minimum came from `estimateMinimumPayment`, the balance×APR
   * heuristic in `lib/debt.ts`, rather than from an issuer or the user.
   *
   * ⚠️ An estimated minimum is NOT evidence of an obligation amount. The
   * heuristic exists to populate a display, and treating its output as a known
   * commitment would launder a guess into a licensed future payment.
   */
  minimumPaymentIsEstimated?: boolean;
  /** `DebtProfile.dueDay`. Null on every account in the corpus today. */
  dueDay: number | null;
  /** Anchors generated dates; supplied by the caller, never read from a clock. */
  asOfISO: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A monthly billing schedule on a given day of the month.
 *
 * Provenance is USER_ASSERTED or DERIVED per the caller: this is a DECLARED
 * schedule, not one inferred from settlements, so its anchor is the most recent
 * slot on or before the as-of date rather than an observed payment.
 */
export function monthlySchedule(dueDay: number, asOfISO: string): Cadence {
  const [y, m] = [Number(asOfISO.slice(0, 4)), Number(asOfISO.slice(5, 7))];
  const day = Math.min(Math.max(dueDay, 1), 31);
  const thisMonth = `${y}-${pad(m)}-${pad(Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate()))}`;
  const anchorISO = thisMonth <= asOfISO
    ? thisMonth
    : `${m === 1 ? y - 1 : y}-${pad(m === 1 ? 12 : m - 1)}-${pad(day)}`;
  return {
    kind: CadenceKind.MONTHLY,
    anchorISO,
    provenance: 'DERIVED',
    daysOfMonth: [day],
  };
}

/**
 * Build an obligation from canonical debt terms.
 *
 * ⚠️ A DISCHARGED DEBT IS TERMINATED. A zero balance is positive evidence, and
 * it is the only kind this producer can see — which is exactly the §13 case: a
 * $7,500 payoff in the transaction history is not consulted here at all, so it
 * cannot become future spending. History is not an input to this function.
 */
export function debtObligation(input: DebtObligationInput): Obligation {
  const base = {
    id: `debt:${input.accountId}`,
    role: FlowRole.DEBT_PAYMENT,
    sourceAccountId: input.accountId,
  };

  if (input.balanceOwed <= 0) {
    return {
      ...base, evidence: ObligationEvidence.DEBT_TERMS, status: ObligationStatus.TERMINATED,
      schedule: null,
      amount: { kind: ObligationAmountKind.UNKNOWN, value: null, currency: input.currency,
        provenance: EventProvenance.DERIVED },
      reason: `${input.accountName} carries no balance; there is nothing owed to pay`,
    };
  }

  if (input.minimumPayment === null || input.minimumPaymentIsEstimated) {
    return {
      ...base,
      // Canonical debt terms exist, but nothing in them STATES a required
      // payment — so there is no evidence class for the outflow itself.
      evidence: ObligationEvidence.NONE,
      status: ObligationStatus.UNLICENSED,
      schedule: input.dueDay !== null ? monthlySchedule(input.dueDay, input.asOfISO) : null,
      amount: { kind: ObligationAmountKind.UNKNOWN, value: null, currency: input.currency,
        provenance: EventProvenance.DERIVED },
      reason: input.minimumPaymentIsEstimated
        ? `${input.accountName}'s minimum payment is an estimate computed from balance and APR, not a stated requirement`
        : `${input.accountName} has no stated minimum payment`,
    };
  }

  // A minimum is a floor, not an expected payment — see ObligationAmountKind.
  return {
    ...base,
    evidence: ObligationEvidence.DEBT_TERMS,
    status: ObligationStatus.ACTIVE,
    schedule: input.dueDay !== null ? monthlySchedule(input.dueDay, input.asOfISO) : null,
    amount: { kind: ObligationAmountKind.MINIMUM, value: input.minimumPayment,
      currency: input.currency, provenance: EventProvenance.DERIVED },
    reason: input.dueDay !== null
      ? `${input.accountName} requires at least ${input.minimumPayment} ${input.currency} on day ${input.dueDay} of each month`
      : `${input.accountName} requires at least ${input.minimumPayment} ${input.currency} per cycle, but no due date is recorded`,
  };
}

/** What a user can state about a commitment. */
export interface AssertedObligationInput {
  id: string;
  role: FlowRoleKind;
  /** Day of the month it falls due, when the user gave one. */
  dueDay: number | null;
  /** The figure stated, or null for "I have a bill but don't know the amount". */
  value: number | null;
  currency: string;
  /** FIXED when the user stated an exact figure; MINIMUM for a floor. */
  amountKind: ObligationAmountKindName;
  /** "This subscription is cancelled" — positive termination evidence. */
  cancelled?: boolean;
  asOfISO: string;
  sourceAccountId?: string;
}

/**
 * Build an obligation from what the user said.
 *
 * The assertion is the evidence, and it is never persisted — no canonical home
 * for a user-declared bill exists in the schema, and inventing one would be
 * storing speculative commitment state.
 */
export function assertedObligation(input: AssertedObligationInput): Obligation {
  const amount: ObligationAmount = {
    kind: input.value === null ? ObligationAmountKind.UNKNOWN : input.amountKind,
    value: input.value,
    currency: input.currency,
    provenance: EventProvenance.USER_ASSERTED,
  };
  if (input.cancelled) {
    return {
      id: input.id, evidence: ObligationEvidence.USER_ASSERTED,
      status: ObligationStatus.TERMINATED, role: input.role, schedule: null, amount,
      sourceAccountId: input.sourceAccountId,
      reason: 'the user stated this commitment has ended',
    };
  }
  return {
    id: input.id, evidence: ObligationEvidence.USER_ASSERTED,
    status: ObligationStatus.ACTIVE, role: input.role,
    schedule: input.dueDay !== null ? monthlySchedule(input.dueDay, input.asOfISO) : null,
    amount, sourceAccountId: input.sourceAccountId,
    reason: input.dueDay !== null
      ? `the user stated this is due on day ${input.dueDay} of each month`
      : 'the user stated this commitment, without a due date',
  };
}

/**
 * A candidate with nothing behind it but repetition.
 *
 * This is the honest representation of Amazon Prime's twenty-six identical
 * charges: something worth showing a user and asking about, and not a
 * commitment. It is UNLICENSED by construction — there is no argument, no
 * threshold and no count that moves it, because the function accepts no counts.
 */
export function unlicensedCandidate(id: string, label: string): Obligation {
  return {
    id, evidence: ObligationEvidence.NONE, status: ObligationStatus.UNLICENSED,
    role: FlowRole.SPENDING, schedule: null,
    amount: { kind: ObligationAmountKind.UNKNOWN, value: null, currency: 'USD',
      provenance: EventProvenance.DERIVED },
    reason: `${label} recurs in the transaction history, which is a habit and not a commitment; `
      + 'no authority establishes that this must be paid',
  };
}

// ── Event generation ────────────────────────────────────────────────────────

/**
 * Expected outflow events for an obligation, over a window.
 *
 * Requires ALL of: an evidence class, ACTIVE status, and a schedule. Any one
 * missing yields zero events — a commitment with no due date cannot be dated,
 * and dating it would be inventing the very thing FORECAST-1 exists to prevent.
 *
 * ⚠️ An ACTIVE obligation with an unknown amount produces DATED events with
 * `amount: null`, exactly as FORECAST-3 intends. Nothing here reaches for a
 * historical average to fill the gap; an unresolved amount stays unresolved and
 * composition reports it.
 */
export function obligationEvents(
  obligation: Obligation, fromISO: string, toISO: string,
): FutureCashEvent[] {
  if (obligation.status !== ObligationStatus.ACTIVE) return [];
  if (obligation.evidence === ObligationEvidence.NONE) return [];
  const schedule = obligation.schedule;
  if (!schedule || !isCadence(schedule)) return [];

  // Local generation over the declared schedule. FORECAST-2's licensed
  // generator is deliberately NOT used: it answers a question about an income
  // stream's continuation from observed silence, and that inference is wrong
  // here — see the header. The licence for an obligation is the obligation.
  const dates = monthlyOccurrences(schedule, fromISO, toISO);
  const known = obligation.amount.value !== null
    && obligation.amount.kind === ObligationAmountKind.FIXED;

  return dates.map((dateISO) => ({
    id: `${obligation.id}@${dateISO}`,
    timing: { kind: 'EXACT' as const, dateISO },
    timingProvenance: obligation.evidence === ObligationEvidence.USER_ASSERTED
      ? EventProvenance.USER_ASSERTED : EventProvenance.DERIVED,
    direction: 'OUTFLOW' as const,
    role: obligation.role,
    amount: known
      ? {
        value: obligation.amount.value as number,
        currency: obligation.amount.currency,
        basis: basisForAmount(obligation.amount),
        provenance: obligation.amount.provenance,
      }
      : null,
    sourceKey: obligation.id,
  }));
}

/** Monthly slots in a window, clamped to each month's length. */
function monthlyOccurrences(schedule: Cadence, fromISO: string, toISO: string): string[] {
  if (fromISO > toISO) return [];
  const day = schedule.daysOfMonth?.[0] ?? Number(schedule.anchorISO.slice(8, 10));
  const out: string[] = [];
  let y = Number(fromISO.slice(0, 4)), m = Number(fromISO.slice(5, 7));
  const endY = Number(toISO.slice(0, 4)), endM = Number(toISO.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const iso = `${y}-${pad(m)}-${pad(Math.min(day, last))}`;
    if (iso >= fromISO && iso <= toISO) out.push(iso);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** A compact statement of an obligation. Not wired into any prompt. */
export function describeObligation(o: Obligation): string {
  const amt = o.amount.value === null
    ? 'amount unknown'
    : `${o.amount.kind === ObligationAmountKind.MINIMUM ? 'at least ' : ''}${o.amount.value} ${o.amount.currency}`;
  return `${o.id} · ${o.status} · ${o.role.toLowerCase()} · ${amt} · evidence ${o.evidence} — ${o.reason}`;
}
