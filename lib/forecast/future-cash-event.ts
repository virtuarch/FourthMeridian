/**
 * lib/forecast/future-cash-event.ts
 *
 * FORECAST-3 — WHAT IS KNOWN ABOUT A FUTURE CASH MOVEMENT.
 *
 * Pure: no DB, no model, no clock of its own, no persistence. Substrate only.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * Measured live: a user mentions a $15,500 completion bonus and $1,500 vacation
 * pay, neither with any statement about tax treatment, and the answer offered
 * $17,000 of spendable cash. The two amounts were known. Whether either was
 * money the user could spend was not known, and the sum silently asserted it.
 *
 * An amount and a spendable amount are different facts. This module refuses to
 * expose them through one number:
 *
 *   nominal stated amounts        $17,000     known, and sayable
 *   assertable net contribution   NOT ASSERTABLE — basis is unestablished
 *
 * ── Why basis cannot be inferred ────────────────────────────────────────────
 * There is no safe default. A bonus quoted by an employer is nearly always
 * gross; a deposit already sitting in a checking account is unambiguously net;
 * a number a user types is whichever they meant. Guessing turns a 30-40% tax
 * wedge into silent error, always in the direction that flatters the forecast.
 * So GROSS and UNKNOWN are structurally unable to become NET, and the only
 * route to NET is somebody actually establishing it.
 *
 * ── What this module does NOT decide ────────────────────────────────────────
 * Not tax (no withholding rate exists here, by design), not whether an inflow
 * is recurring operating income, not baseline spending, and not what a future
 * paycheck will be worth — see AMOUNT AUTHORITY below, where the evidence is
 * measured and found insufficient.
 */

import { isCadence, type CadenceResult } from './cadence';
import { expectedOccurrencesBetween, type StreamActivity } from './stream-activity';

// ── Basis ───────────────────────────────────────────────────────────────────

/**
 * What an amount is an amount OF.
 *
 * Economic definitions, not labels:
 *
 *   NET      licensed to affect projected spendable cash AT THE STATED AMOUNT.
 *   GROSS    known before deductions. Real money, but NOT equal to cash the
 *            user receives, and never substitutable for it.
 *   UNKNOWN  an amount is known; whether it is gross or net is not.
 *
 * ⚠️ GROSS and UNKNOWN are the same for spendability — neither may be counted —
 * and different for truthfulness. GROSS says "this figure excludes deductions";
 * UNKNOWN says "nobody established which figure this is". Collapsing them would
 * lose the difference between a resolvable question and an answered one.
 */
export const AmountBasis = {
  NET:     'NET',
  GROSS:   'GROSS',
  UNKNOWN: 'UNKNOWN',
} as const;

export type AmountBasisKind = typeof AmountBasis[keyof typeof AmountBasis];

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * Where a fact came from.
 *
 * Three values, and the shortness of the list is a finding rather than a
 * simplification. The candidates considered and rejected:
 *
 *   KNOWN_SCHEDULED / provider-attested — DOES NOT EXIST. Measured: the
 *     database holds ZERO forward-dated transactions, and the single pending
 *     income row is a $6.34 refund. No provider tells this system about future
 *     income, so a provenance for it would be a name with nothing behind it.
 *
 *   ESTIMATED — no producer. Nothing in this slice estimates an amount, and
 *     minting the value would invite one.
 *
 * ⚠️ PROVENANCE IS ORTHOGONAL TO BASIS. A user-asserted amount can have UNKNOWN
 * basis ("I'm getting a $15,500 bonus" — said with certainty, tax treatment
 * unstated). A derived date can carry a user-asserted amount. The two questions
 * are "who says so" and "what is it an amount of", and answering one never
 * answers the other.
 */
export const EventProvenance = {
  /** The user stated it. */
  USER_ASSERTED: 'USER_ASSERTED',
  /** Computed from evidence in the ledger — a cadence, an observation. */
  DERIVED: 'DERIVED',
  /**
   * A supposition the system is exploring — "what if you received $10,000".
   *
   * ⚠️ NOT EVIDENCE, and it must never be presented as any. Nothing in this
   * slice produces one; the representation exists so a later forecast-policy
   * slice has somewhere truthful to put a scenario, rather than borrowing
   * USER_ASSERTED and making a supposition look like something the user said.
   */
  HYPOTHETICAL: 'HYPOTHETICAL',
} as const;

export type EventProvenanceKind = typeof EventProvenance[keyof typeof EventProvenance];

// ── Economic role ───────────────────────────────────────────────────────────

/**
 * What kind of movement this is, in the vocabulary the ledger already uses.
 *
 * These are `FlowType` members (`prisma/schema.prisma`), not a new taxonomy —
 * the transaction classifier already decided what INTEREST, REFUND and TRANSFER
 * mean, and a second vocabulary would immediately disagree with the first. The
 * names are duplicated as string literals rather than imported so this module
 * stays free of the Prisma client; a test pins every value against the schema.
 *
 * ⚠️ A ROLE IS NOT A RECURRENCE CLAIM, and INFLOW is not operating income. A
 * bonus and a paycheck are both INCOME here; what separates them is that one
 * came from a licensed cadence and the other is a single asserted event — a
 * structural fact, not a taxonomic one. Deciding what belongs in recurring
 * operating income is a later authority's job, and this module deliberately
 * gives it no shortcut.
 */
export const FlowRole = {
  INCOME:       'INCOME',
  INTEREST:     'INTEREST',
  REFUND:       'REFUND',
  TRANSFER:     'TRANSFER',
  SPENDING:     'SPENDING',
  DEBT_PAYMENT: 'DEBT_PAYMENT',
  FEE:          'FEE',
  UNKNOWN:      'UNKNOWN',
} as const;

export type FlowRoleKind = typeof FlowRole[keyof typeof FlowRole];

// ── Timing ──────────────────────────────────────────────────────────────────

/**
 * When the movement happens.
 *
 * A user can know "a bonus in October" without knowing October 15th, and
 * inventing the 15th to make arithmetic convenient is the same class of error
 * as inventing a pay date. So an unresolved month stays a month.
 *
 * ⚠️ `RANGE` and `UNKNOWN` have no exact date, and `exactDateOf` returns null
 * for them rather than a midpoint. Choosing a day inside a range is a POLICY
 * decision with consequences for which month a forecast lands in; it belongs to
 * a forecast-policy authority that can record having made it.
 */
export type EventTiming =
  | { kind: 'EXACT'; dateISO: string }
  | { kind: 'RANGE'; fromISO: string; toISO: string }
  | { kind: 'UNKNOWN' };

/** The exact date, or null when timing is unresolved. Never a guess. */
export function exactDateOf(timing: EventTiming): string | null {
  return timing.kind === 'EXACT' ? timing.dateISO : null;
}

/** A short human statement of timing. "2026-09-11", "2026-10", "date unknown". */
export function describeTiming(timing: EventTiming): string {
  if (timing.kind === 'EXACT') return timing.dateISO;
  if (timing.kind === 'UNKNOWN') return 'date unknown';
  const [a, b] = [timing.fromISO, timing.toISO];
  return a.slice(0, 7) === b.slice(0, 7) ? a.slice(0, 7) : `${a}..${b}`;
}

// ── The event ───────────────────────────────────────────────────────────────

/**
 * An amount, and everything needed to know what may be concluded from it.
 *
 * There is no bare number on a FutureCashEvent. A caller reaching for `.value`
 * has to walk past `basis` to get there, and the composition helpers below
 * never sum across bases.
 */
export interface EventAmount {
  value: number;
  /** ISO-4217, or a crypto symbol. Never assumed. */
  currency: string;
  basis: AmountBasisKind;
  /** Who established the AMOUNT — independent of who established the date. */
  provenance: EventProvenanceKind;
  /**
   * PROJECTION-1 — the amount is the level of SETTLED CREDITS that already
   * landed in a depository account.
   *
   * ⚠️ THIS IS NOT A BASIS, AND IT DOES NOT MAKE ONE. `basis` stays UNKNOWN and
   * `netCashContribution` still refuses it, because whether the employer's
   * figure was gross or net remains genuinely unknown. What this records is that
   * the QUESTION does not arise for this amount: the money was observed arriving
   * in a checking account, and an observed bank credit has no gross/net to
   * resolve — that distinction belongs to a STATED payroll figure.
   *
   * Measured, this is the whole of the income blocker on the real Space: 20
   * settled Vectrus deposits into `CHASE COLLEGE` (type `checking`), a level of
   * $5,286.64 held within 1.29% across 11 of them, and every projected
   * occurrence refused for want of a basis assertion about money that had
   * already arrived.
   *
   * ⚠️ IT NEVER APPLIES TO A STATED FUTURE AMOUNT. A $15,500 bonus the user
   * mentions is GROSS and stays GROSS; nothing about it was observed settling
   * anywhere. Only a derived level from settled depository credits sets this.
   */
  observedSettled?: boolean;
}

/** A future cash movement, and the limits of what is known about it. */
export interface FutureCashEvent {
  /** Stable within a composition, so components can be named. */
  id: string;
  timing: EventTiming;
  /** Who established the TIMING. A derived date may carry an asserted amount. */
  timingProvenance: EventProvenanceKind;
  direction: 'INFLOW' | 'OUTFLOW';
  role: FlowRoleKind;
  /**
   * Null when no amount is established at all.
   *
   * ⚠️ Null is not zero, and it is not an error. Cadence-derived payroll events
   * land here today: the date is known and the amount is not. See AMOUNT
   * AUTHORITY below.
   */
  amount: EventAmount | null;
  /** The stream this came from, where one exists. */
  sourceKey?: string;
}

// ── Spendability ────────────────────────────────────────────────────────────

/**
 * What this event contributes to projected SPENDABLE cash.
 *
 * Deliberately not a number. A function returning `number | null` gets summed
 * with `?? 0` at the first call site, and the whole failure this module exists
 * to close is a sum that swallowed an unresolved basis.
 */
export type NetContribution =
  | { assertable: true; value: number; currency: string }
  | { assertable: false; reason: string };

/**
 * The ONLY route from an event to spendable cash.
 *
 * NET passes at its stated amount. Everything else refuses, and says why.
 * No tax is estimated here and no withholding rate exists to estimate it with —
 * a GROSS amount does not become "roughly 70% of gross", it stays unassertable
 * until somebody establishes the net figure.
 */
export function netCashContribution(event: FutureCashEvent): NetContribution {
  const a = event.amount;
  if (!a) return { assertable: false, reason: 'no amount is established for this event' };
  if (a.basis === AmountBasis.NET) {
    return { assertable: true, value: a.value, currency: a.currency };
  }
  if (a.basis === AmountBasis.GROSS) {
    return {
      assertable: false,
      reason: `${a.value} ${a.currency} is a GROSS amount — it excludes deductions and is not the cash received`,
    };
  }
  return {
    assertable: false,
    reason: `${a.value} ${a.currency} is stated, but whether it is gross or net was never established`,
  };
}

/**
 * PROJECTION-1 — cash contribution for an EVIDENCE-BASED PROJECTION.
 *
 * ⚠️ A SECOND FUNCTION, NOT A LOOSENED FIRST ONE. `netCashContribution` is the
 * FACTUALLY_LICENSED rule and is unchanged: it admits NET and nothing else, so
 * every licensed forecast keeps exactly the guarantees F1–F17 gave it. This one
 * is consulted only by the projection path, and it admits one further case —
 * an amount that was OBSERVED SETTLING into a depository account.
 *
 * GROSS is still refused here, and deliberately so. A gross figure is not the
 * cash received no matter which path asks; the observed-settled case is not
 * "we relaxed the basis rule", it is "no basis question was ever open".
 */
export function observedCashContribution(event: FutureCashEvent): NetContribution {
  const a = event.amount;
  if (!a) return { assertable: false, reason: 'no amount is established for this event' };
  if (a.basis === AmountBasis.NET) return { assertable: true, value: a.value, currency: a.currency };
  if (a.basis === AmountBasis.GROSS) {
    return {
      assertable: false,
      reason: `${a.value} ${a.currency} is a GROSS amount — it excludes deductions and is not the cash received`,
    };
  }
  if (a.observedSettled) {
    return { assertable: true, value: a.value, currency: a.currency };
  }
  return {
    assertable: false,
    reason: `${a.value} ${a.currency} is stated, but whether it is gross or net was never established`,
  };
}

// ── Cadence-derived events ──────────────────────────────────────────────────

/**
 * AMOUNT AUTHORITY — measured, and found insufficient.
 *
 * The question §6 asks is whether a current periodic amount can be derived from
 * the ledger. Measured on the real Vectrus payroll, 19 payments:
 *
 *   full series      min 923.50  max 6275.07  median 5306.12  CV 24.6%
 *   last six         5286.64 · 6275.07 · 5286.65 · 5286.63 · 5286.40 · 5306.12
 *
 * A stable current regime is visible — five of the last six sit inside a $19.72
 * band, 0.16% apart — and it is NOT derivable without policy. Reaching it means
 * excluding a partial first period ($2,306.42, started mid-cycle), excluding an
 * off-cycle payment ($923.50), excluding a high outlier ($6,275.07), and
 * detecting a regime change: the series steps down from ~$5,950 in January to
 * ~$5,290 from April onward. Each exclusion is a judgement about what counts as
 * a normal paycheck, and the naive alternatives are all wrong — the mean is
 * $5,108, the median $5,306, the most recent $5,306.12, and none of them is
 * "the amount" without someone deciding the outlier rule first.
 *
 * Abacus is worse and confirms the shape: CV 24.1%, with a $10,668.74 payment
 * sitting in an otherwise ~$4,400 series.
 *
 * So this slice does NOT establish an amount from observation. Cadence-derived
 * events carry a date and `amount: null`. That is a real answer — the dates
 * stop being invented, which was the point — and a changepoint/outlier
 * authority is the thing that would change it.
 */

/** What a caller must supply to attach an amount to generated events. */
export interface AssertedRecurringAmount {
  value: number;
  currency: string;
  basis: AmountBasisKind;
  provenance: EventProvenanceKind;
  /** PROJECTION-1 — see `EventAmount.observedSettled`. */
  observedSettled?: boolean;
}

/**
 * Expected cash events for a stream, over a window.
 *
 * ⚠️ THE LICENSED CHAIN, and it cannot be short-circuited: this reaches dates
 * only through `expectedOccurrencesBetween`, which requires a FORECAST-2
 * activity decision. A SILENT, ENDED or UNKNOWN stream yields an empty array,
 * so no amount of cadence strength can turn a stopped payroll into expected
 * cash. Calling FORECAST-1's `occurrencesBetween` instead would skip the
 * licence, which is exactly why the two functions are not the same function.
 *
 * `assertedAmount` is optional and never inferred. Without it the events carry
 * dates and no amount, per AMOUNT AUTHORITY above.
 */
export function cadenceDerivedEvents(
  activity: StreamActivity,
  cadence: CadenceResult,
  fromISO: string,
  toISO: string,
  role: FlowRoleKind,
  assertedAmount?: AssertedRecurringAmount,
): FutureCashEvent[] {
  const dates = expectedOccurrencesBetween(activity, cadence, fromISO, toISO);
  const key = isCadence(cadence) ? cadence.sourceKey : undefined;
  return dates.map((dateISO) => ({
    id: `${key ?? 'stream'}@${dateISO}`,
    timing: { kind: 'EXACT', dateISO },
    // The DATE is derived from the cadence even when the AMOUNT was asserted.
    timingProvenance: EventProvenance.DERIVED,
    direction: 'INFLOW',
    role,
    amount: assertedAmount ? { ...assertedAmount } : null,
    sourceKey: key,
  }));
}

// ── Composition ─────────────────────────────────────────────────────────────

/** One event's place in a total, named so a caller can say what is in it. */
export interface CashComponent {
  id: string;
  role: FlowRoleKind;
  timing: string;
  value: number | null;
  basis: AmountBasisKind | null;
  countsTowardNet: boolean;
}

/**
 * What a collection of future events adds up to — and what it does not.
 *
 * Follows CF-1/CF-7: the producer owns the denominator, components are named,
 * and a combined figure exists only when every part of it is assertable. There
 * is deliberately no single `futureCashTotal`, because that is the field the
 * live failure would have been read out of.
 */
export interface CashComposition {
  currency: string | null;
  /** Stated amounts, regardless of basis. Sayable as "stated", never as cash. */
  nominalInflow: number;
  nominalOutflow: number;
  /** Spendable cash, present ONLY when every amount-bearing event is NET. */
  assertableNet: number | null;
  /** Why `assertableNet` is null, when it is. */
  netRefusalReason: string | null;
  /** Stated amounts that could not be counted, by why. */
  unresolved: { gross: number; unknownBasis: number; noAmount: number };
  components: CashComponent[];
  /** Currencies present, when more than one makes any total meaningless. */
  currencies: string[];
}

const isInflow = (e: FutureCashEvent) => e.direction === 'INFLOW';

/**
 * Compose a bounded collection of events.
 *
 * ⚠️ UNLIKE CURRENCIES ARE NEVER SUMMED. `FxRate` holds ZERO rows, and even a
 * full table would not help: a rate for a FUTURE date does not exist and cannot
 * be looked up. Converting at today's rate and presenting the result as a
 * future figure would invent a forecast of the exchange rate itself. Mixed
 * currencies therefore produce no totals and say so.
 *
 * Arithmetic is full-precision per D-4 (`lib/money/convert.ts`); nothing here
 * rounds, and display rounding stays at the edge.
 */
export function composeFutureCash(events: readonly FutureCashEvent[]): CashComposition {
  const currencies = [...new Set(events.map((e) => e.amount?.currency).filter(Boolean))] as string[];
  const components: CashComponent[] = events.map((e) => ({
    id: e.id, role: e.role, timing: describeTiming(e.timing),
    value: e.amount?.value ?? null,
    basis: e.amount?.basis ?? null,
    countsTowardNet: netCashContribution(e).assertable,
  }));

  const empty: CashComposition = {
    currency: currencies.length === 1 ? currencies[0] : null,
    nominalInflow: 0, nominalOutflow: 0,
    assertableNet: null, netRefusalReason: null,
    unresolved: { gross: 0, unknownBasis: 0, noAmount: 0 },
    components, currencies,
  };

  if (currencies.length > 1) {
    return {
      ...empty,
      netRefusalReason: `events span ${currencies.join(' and ')} and no exchange rate exists for a future date, `
        + 'so no combined figure can be stated',
    };
  }

  let nominalInflow = 0, nominalOutflow = 0, net = 0;
  const unresolved = { gross: 0, unknownBasis: 0, noAmount: 0 };
  for (const e of events) {
    const a = e.amount;
    if (!a) { unresolved.noAmount += 1; continue; }
    if (isInflow(e)) nominalInflow += a.value; else nominalOutflow += a.value;
    if (a.basis === AmountBasis.NET) net += isInflow(e) ? a.value : -a.value;
    else if (a.basis === AmountBasis.GROSS) unresolved.gross += a.value;
    else unresolved.unknownBasis += a.value;
  }

  // A net figure exists only when nothing is unresolved. This mirrors CF-7:
  // a combined total requires every component to be assertable, and a hidden
  // component may never quietly become zero.
  const blocked: string[] = [];
  if (unresolved.gross) blocked.push(`${unresolved.gross} stated as GROSS`);
  if (unresolved.unknownBasis) blocked.push(`${unresolved.unknownBasis} of unestablished basis`);
  if (unresolved.noAmount) blocked.push(`${unresolved.noAmount} event(s) with no amount`);

  return {
    ...empty, nominalInflow, nominalOutflow, unresolved,
    assertableNet: blocked.length === 0 ? net : null,
    netRefusalReason: blocked.length === 0 ? null
      : `spendable cash cannot be stated: ${blocked.join('; ')}`,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

// ⚠️ `describeFutureCash` DELETED (V26-REASONING Slice 0). A prose renderer for
// the composition, reachable only from this module's own test. The composition
// itself — `composeFutureCash`, and its refusal to call a GROSS or unknown-basis
// event spendable cash — is untouched and is what production consumes.
