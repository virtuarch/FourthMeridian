/**
 * lib/forecast/projection.ts
 *
 * PROJECTION-1 — THE EVIDENCE-BASED CASH PATH.
 *
 * ── Why this is beside the engine and not inside it ─────────────────────────
 * `forecastCash` computes what the evidence ENTAILS, and its refusals are the
 * product of F7's conclusion licence and F8's policy. Adding a weaker path to it
 * would put two different standards of proof behind one set of field names, and
 * the first thing to go would be the meaning of `fullCashPath`. So this is a
 * separate pure function over the same inputs, producing a separate result that
 * a caller may render BESIDE the licensed one and never in place of it.
 *
 * ── What it changes, exactly ────────────────────────────────────────────────
 * Two things, both narrow:
 *   · income is taken from `observedCashContribution`, which additionally admits
 *     an amount observed settling into a depository account (GROSS still refused);
 *   · spending is taken from an `ObservedSpendingRate` over a disclosed window,
 *     instead of F6's baseline, which is UNKNOWN for this user by measurement.
 * Opening cash is the same licensed figure. Nothing else differs.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 * It does not run when the licensed path succeeds: a FACTUALLY_LICENSED answer
 * is never replaced by a weaker one. It does not run when the user supplied a
 * spending assumption, because that assumption is stronger evidence about the
 * user's intent than the user's own history and the licensed path already
 * carries it — see `USER_OVERRIDE` in the result's `supersededBy`.
 *
 * ⚠️ IT PROJECTS NO DEBT PAYDOWN, and that is a finding rather than an omission.
 * Measured on the real Space, DEBT_PAYMENT since 2026-06-01 totals $55,710 —
 * but every payment appears TWICE, once as a debit on `CHASE COLLEGE` and once
 * as a credit on the card, so the economic total is about half that. Of what
 * remains, the part matching card purchases is already counted as SPENDING (the
 * cards carry $16,854 of the period's $17,012 of spending; checking carries
 * $157), so projecting both would double-count every purchase. The excess over
 * card spending was balance PAYDOWN, and the balances are now $11.09 and
 * -$86.19 — there is nothing left to pay down, so extrapolating it would project
 * an outflow against a debt that no longer exists.
 */

import { daysBetween } from './_time';
import { observedCashContribution, exactDateOf, type FutureCashEvent } from './future-cash-event';
import { ConclusionStatus, type ConclusionStatusKind } from './policy';
import { monthLabel, type ObservedSpendingRate } from './observed-spending';

/** One component of a projected total, named so the reply can attribute it. */
export interface ProjectionComponent {
  label: string;
  /** MAGNITUDE. Direction is the label's job — see the note at the push sites. */
  value: number;
  /** The measured evidence and the transformation applied to it. */
  derivation: string;
}

export interface ProjectedCash {
  status: ConclusionStatusKind;
  /** Null whenever the status is not EVIDENCE_BASED_PROJECTION. */
  closing: number | null;
  currency: string;
  openingCash: number | null;
  components: ProjectionComponent[];
  /** The `OBSERVED_CONTINUATION` claims this rests on, in the user's terms. */
  assumptions: string[];
  /** What stopped it, when it produced nothing. */
  missing: string[];
  /**
   * Low/high closing implied by the SPENDING WINDOW's own months.
   *
   * ⚠️ SUPPLEMENTAL, NEVER A REPLACEMENT for `closing`. Product policy is that a
   * central estimate is the answer; this exists so a 6.1x window does not read
   * as a settled level, and it is omitted when a single month was averaged.
   */
  range: { low: number; high: number } | null;
  /** Events the projection could not use, with the authority's own reason. */
  excluded: { id: string; reason: string }[];
}


/**
 * Where the spending term comes from.
 *
 * ⚠️ THE USER OUTRANKS THEIR OWN HISTORY. "Assume I spend $5,000/month" is a
 * statement about what they intend, and an average of what they did spend is
 * not evidence against it. So a user assumption REPLACES the observed term
 * rather than suppressing the projection — suppressing it was the first
 * implementation, and it answered an override with nothing at all.
 *
 * The standing changes with the source: an observed rate carries
 * OBSERVED_CONTINUATION and the window that produced it; a user rate carries
 * the existing USER_REQUESTED assumption semantics and no window, because there
 * is no measurement behind it to disclose.
 */
export type ProjectionSpending =
  | { kind: 'OBSERVED'; rate: ObservedSpendingRate }
  | { kind: 'USER_ASSUMED'; dailyRate: number; monthlyAmount: number | null; statedAs: string };

export interface ProjectCashInput {
  openingCash: number | null;
  events: readonly FutureCashEvent[];
  spending: ProjectionSpending | null;
  fromISO: string;
  toISO: string;
  currency: string;
}

/**
 * Project cash forward from measured evidence.
 *
 * PURE. Full f64 throughout; rounding belongs at the display edge (D-4).
 */
export function projectCash(input: ProjectCashInput): ProjectedCash {
  const { openingCash, events, spending, fromISO, toISO, currency } = input;
  const missing: string[] = [];
  if (openingCash === null) missing.push('current cash balance');
  if (!spending) missing.push('a complete calendar month of spending to average');

  const components: ProjectionComponent[] = [];
  const excluded: { id: string; reason: string }[] = [];
  let inflow = 0, outflow = 0;

  for (const e of events) {
    const date = exactDateOf(e.timing);
    if (date === null || date < fromISO || date > toISO) continue;
    const c = observedCashContribution(e);
    if (!c.assertable) { excluded.push({ id: e.id, reason: c.reason }); continue; }
    if (e.direction === 'INFLOW') inflow += c.value; else outflow += c.value;
  }

  // ⚠️ THE CLAMP IS AT THE CALL SITE NOW, NOT INSIDE THE HELPER (V26-REASONING
  // Slice 0). The private `daysBetween` this module used to carry silently
  // returned 0 for a reversed horizon, and two sibling modules had the same name
  // with different semantics. A horizon whose end precedes its start spends zero
  // days, which is a decision this line makes visibly.
  const days = Math.max(0, daysBetween(fromISO, toISO));
  const dailyRate = spending === null ? null
    : spending.kind === 'OBSERVED' ? spending.rate.dailyRate : spending.dailyRate;
  const spend = dailyRate === null ? null : dailyRate * days;

  if (openingCash === null || spending === null || spend === null) {
    return {
      status: ConclusionStatus.REFUSED, closing: null, currency, openingCash,
      components, assumptions: [], missing, range: null, excluded,
    };
  }

  // ⚠️ THE LABELS SAY PROJECTED, BECAUSE THAT IS WHAT THEY ARE. This figure is
  // the sum of FUTURE occurrences — 8 x $5,286.64 on the real Space — generated
  // from an observed pattern. Calling it "observed income" was measured in the
  // live UI and is a semantic error of exactly the kind this programme exists to
  // prevent: it renames a projection into a measurement, which is the same move
  // as calling a historical average "normal".
  if (inflow > 0) {
    components.push({
      label: 'projected income from the observed payroll pattern', value: inflow,
      derivation: `${days} day(s) of the established cadence at the level those deposits `
        + 'have actually been settling at',
    });
  }
  if (outflow > 0) {
    components.push({
      label: 'projected outflows from dated obligations', value: outflow,
      derivation: 'dated known obligations falling inside the horizon',
    });
  }
  const obs = spending.kind === 'OBSERVED' ? spending.rate : null;
  // ⚠️ MAGNITUDES, NOT SIGNED VALUES. The renderer used to print "USD -16672.27";
  // the model quoted "$16,672.27" and `output-validator`'s NUMBER_RE captures the
  // minus, so the licensed figure and the quoted figure did not reconcile and a
  // correct answer collected "could not be automatically verified". Direction is
  // carried by the label, where a reader gets it too.
  components.push({
    label: obs ? 'projected spending at the observed rate' : 'projected spending at your assumed rate',
    value: spend,
    derivation: obs
      ? `${obs.monthlyRate.toFixed(2)}/month across the ${obs.monthCount} `
        + `complete month(s) ${obs.months.map(monthLabel).join(' and ')}, accrued over `
        + `${days} day(s)`
      : `${spending.kind === 'USER_ASSUMED' ? spending.statedAs : ''} — the user's own figure, `
        + `accrued over ${days} day(s)`,
  });

  const closing = openingCash + inflow - outflow - spend;
  // The same arithmetic at the window's own extremes. Not a distribution, and
  // meaningless for a user-supplied rate, which has no window to vary over.
  const range = obs && obs.monthCount > 1
    ? {
      low:  openingCash + inflow - outflow - (obs.high / (365 / 12)) * days,
      high: openingCash + inflow - outflow - (obs.low  / (365 / 12)) * days,
    }
    : null;

  const assumptions = [
    obs
      ? `spending continues at the ${obs.monthCount}-month observed average of `
        + `${obs.monthlyRate.toFixed(2)}/month, measured over `
        + `${obs.months.map(monthLabel).join(' and ')} and no other period`
      : `spending is ${spending.kind === 'USER_ASSUMED' ? spending.statedAs : 'as the user supposed'} `
        + '— the user\'s supposition for this conversation, not a measurement',
    'settled recurring deposits continue at their observed level and cadence',
  ];

  return {
    status: ConclusionStatus.EVIDENCE_BASED_PROJECTION,
    closing, currency, openingCash, components, assumptions, missing: [], range, excluded,
  };
}
