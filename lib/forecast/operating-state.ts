/**
 * lib/forecast/operating-state.ts
 *
 * FORECAST-7 — WHAT IS TRUE NOW, AND WHAT IS NOT KNOWN.
 *
 * Pure: no DB, no model, no clock of its own, no persistence. Substrate only.
 * Callers adapt live rows into the inputs; this module composes and refuses.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 * The composition boundary the whole program has been building toward. Six
 * authorities decided six different things, each with its own idea of what it
 * could not say. This assembles them into one current picture and — the actual
 * point — decides which conclusions that picture supports.
 *
 *   CurrentOperatingState + FutureCashEvent[] + ForecastPolicy → forecast
 *
 * All three are required. This state does not project, dated events do not
 * project, and the model never recomputes either.
 *
 * ── Why the refusals are code and not prose ────────────────────────────────
 * The measured failures were all arithmetic over a missing input. A monthly
 * surplus computed against an unknown spending baseline. A runway computed from
 * a burn rate nobody had. A "months of cash" figure that treated an absent
 * number as zero. Every one of those is the same mistake, and no prompt
 * instruction survives contact with a model that has an income figure and a
 * balance in front of it.
 *
 * So the licence is a function. A conclusion names the components it needs, and
 * a component that is not ASSERTABLE withholds every conclusion that requires
 * it. There is no field on this state from which a runway can be read.
 *
 * ── Empty is not unknown, and neither is zero ──────────────────────────────
 * Three genuinely different facts, kept apart throughout:
 *
 *   no obligations are LICENSED   a fact about evidence. The user certainly has
 *                                 bills; nothing here can name one.
 *   spending baseline UNKNOWN     not zero spending. Not a low estimate.
 *   income amount UNKNOWN         not zero income.
 *
 * The vocabulary is CF-7's `ComponentState` rather than a fourth synonym set.
 * ASSERTABLE / ABSENT / UNKNOWN already carry exactly these three meanings, and
 * ABSENT is what the brief calls EMPTY_BUT_KNOWN. A separate UNAVAILABLE was
 * considered and not minted: it would behave identically to UNKNOWN at every
 * decision point, and a distinction with no decision behind it is vocabulary.
 */

import { money } from './_num';
import { ComponentState, type ComponentStateKind, type ConceptComposition } from '../ai/economic-concepts';
import { annualFactor, monthlyEquivalent, type CadenceKindName } from './cadence';
import type { ActivityStateName } from './stream-activity';
import { AmountBasis, FlowRole, type AmountBasisKind, type EventProvenanceKind, type FlowRoleKind, type FutureCashEvent } from './future-cash-event';
import { EventProvenance } from './future-cash-event';
import { PeriodBasis, type PeriodBasisKind } from './spending-baseline';

// ── Components ──────────────────────────────────────────────────────────────

/** A single measured quantity and how well it is known. */
export interface BalanceComponent {
  state: ComponentStateKind;
  /** Null unless ASSERTABLE or ABSENT. Never a placeholder. */
  amount: number | null;
  currency: string;
  accountCount: number;
  /** When the figure was observed, when the caller knows. */
  asOfISO: string | null;
  reason: string | null;
}

/**
 * How an income stream relates to ordinary living.
 *
 * ⚠️ DELIBERATELY COARSE, AND IT STOPS SHORT OF PAYROLL. The ledger separates
 * INTEREST from INCOME, so interest can be kept out of anything resembling
 * salary. It does NOT separate a paycheck from a bonus — FORECAST-3 established
 * that both are INCOME — so `OPERATING_CANDIDATE` means "not interest", never
 * "salary".
 *
 * That is why this state exposes NO aggregate income figure. A total labelled
 * operating income would be a claim the evidence cannot support, and the honest
 * alternative is the one the brief allows: expose the component streams.
 */
export const IncomeClass = {
  /** Ordinary inflow. NOT a claim that it is salary. */
  OPERATING_CANDIDATE: 'OPERATING_CANDIDATE',
  /** Periodic, and not living income — interest, and anything like it. */
  OTHER_PERIODIC: 'OTHER_PERIODIC',
  UNKNOWN_ROLE: 'UNKNOWN_ROLE',
} as const;

export type IncomeClassKind = typeof IncomeClass[keyof typeof IncomeClass];

/** One income stream, with its four independent facts kept independent. */
export interface IncomeStreamState {
  sourceKey: string;
  role: FlowRoleKind;
  incomeClass: IncomeClassKind;
  cadence: CadenceKindName | null;
  /** Occurrences per year. Null when no cadence was established. */
  annualOccurrences: number | null;
  activity: ActivityStateName | 'NONE';
  /** FORECAST-2's licence. Independent of whether an amount is known. */
  projectionEligible: boolean;
  amountState: ComponentStateKind;
  amount: number | null;
  amountProvenance: EventProvenanceKind | null;
  /**
   * ⚠️ ALWAYS UNKNOWN for a derived amount. Historical deposits landing as cash
   * proves those were cash; it establishes nothing about a future payment.
   *
   * NET or GROSS reaches here only from FORECAST-5's `assertedAmountBasis` —
   * somebody said so — and this composer carries that verdict rather than
   * forming one. Until FORECAST-9A the field was hard-coded UNKNOWN here, which
   * meant a truthful user assertion could not reach the licence at all while a
   * forecast-policy supposition could: a supposition was more expressive than a
   * fact.
   */
  basis: AmountBasisKind;
  /**
   * Who established the basis. Null exactly when `basis` is UNKNOWN.
   *
   * Carried separately from `amountProvenance` because the two honestly differ:
   * a ledger-derived level the user confirms is take-home is DERIVED in one
   * field and USER_ASSERTED in the other, and collapsing them would lose which
   * half to re-ask about.
   */
  basisProvenance: EventProvenanceKind | null;
  /**
   * The periodic amount expressed per month, via FORECAST-1's factor.
   *
   * ⚠️ NOMINAL. Present only when the stream is projection-eligible AND its
   * amount is assertable — a good number about a dead stream is not income.
   * Never spendable cash while `basis` is UNKNOWN.
   */
  nominalMonthly: number | null;
  currency: string;
}

/** Known future obligations, as FORECAST-4 licensed them. */
export interface ObligationState {
  state: ComponentStateKind;
  /** Dated events FORECAST-4 licensed. Zero is a fact about evidence. */
  licensedEventCount: number;
  /** Obligations that exist but cannot be dated or priced. */
  activeButUndatedCount: number;
  reason: string;
}

/** Current-normal discretionary spending, as FORECAST-6 decided it. */
export interface BaselineState {
  state: ComponentStateKind;
  amount: number | null;
  periodBasis: PeriodBasisKind | null;
  provenance: EventProvenanceKind | null;
  currency: string;
  reason: string;
}

/** Everything known about now. */
export interface CurrentOperatingState {
  asOfISO: string;
  liquidity: BalanceComponent;
  debt: BalanceComponent;
  /** CF-7's composition, components preserved. Null when the concept is empty. */
  investments: ConceptComposition | null;
  incomeStreams: IncomeStreamState[];
  knownObligations: ObligationState;
  discretionaryBaseline: BaselineState;
  /**
   * Days between the oldest and newest component observation.
   *
   * ⚠️ Carried rather than resolved. Stamping one "current" date over
   * components observed a month apart would assert a coherence that does not
   * exist. The band vocabulary for judging it already lives in
   * `lib/freshness/observation.ts` and is not duplicated here.
   */
  freshnessSpreadDays: number | null;
}

// ── Composition ─────────────────────────────────────────────────────────────

/** What the caller supplies. Every field comes from an existing authority. */
export interface OperatingStateInput {
  asOfISO: string;
  /** From the canonical accounts payload — never recomputed from history. */
  accounts: {
    totalLiquid: number;
    totalLiabilities: number;
    counts: { liquid: number; liabilities: number };
    redactedCount?: number;
    totalsUnconverted?: boolean;
    asOfISO?: string | null;
  } | null;
  /** CF-7's `composeInvestments` result, passed through untouched. */
  investments: ConceptComposition | null;
  incomeStreams: readonly IncomeStreamInput[];
  obligations: {
    /** Events FORECAST-4 licensed. */
    licensedEvents: readonly FutureCashEvent[];
    /** ACTIVE obligations that produced no dated events. */
    activeButUndatedCount: number;
    /** False when obligations were never evaluated — UNKNOWN, not ABSENT. */
    evaluated: boolean;
  };
  baseline: {
    assertable: boolean;
    amount?: number;
    periodBasis?: PeriodBasisKind;
    provenance?: EventProvenanceKind;
    currency?: string;
    reason: string;
  } | null;
}

export interface IncomeStreamInput {
  sourceKey: string;
  role: FlowRoleKind;
  cadence: CadenceKindName | null;
  activity: ActivityStateName | 'NONE';
  projectionEligible: boolean;
  /**
   * FORECAST-5's result, already decided — basis included.
   *
   * ⚠️ `basis` IS REQUIRED, NOT OPTIONAL-DEFAULTING-TO-UNKNOWN. An optional
   * field would leave this composer choosing the value again, which is the
   * defect FORECAST-9A exists to close in a smaller costume. A caller with a
   * derived amount passes UNKNOWN and says so.
   */
  amount: {
    value: number; currency: string; provenance: EventProvenanceKind;
    basis: AmountBasisKind; basisProvenance: EventProvenanceKind | null;
  } | null;
}

const CURRENCY = 'USD';

/** Interest is not living income. Nothing here claims the rest is salary. */
function classifyIncome(role: FlowRoleKind): IncomeClassKind {
  if (role === FlowRole.INTEREST) return IncomeClass.OTHER_PERIODIC;
  if (role === FlowRole.INCOME) return IncomeClass.OPERATING_CANDIDATE;
  return IncomeClass.UNKNOWN_ROLE;
}

/**
 * Compose the current state.
 *
 * ⚠️ EVERY COMPONENT ARRIVES ALREADY DECIDED. This function consumes verdicts
 * and never re-derives one: it does not average transactions into a balance,
 * does not re-infer activity, and does not compute a spending level. A
 * composition that could disagree with its own inputs would become a seventh
 * authority, and the value of the previous six is that there is exactly one
 * place each question is answered.
 */
export function composeOperatingState(input: OperatingStateInput): CurrentOperatingState {
  const a = input.accounts;

  // The same indeterminacy rule CF-7 uses, for the same reason: a hidden
  // account might be anything, and an unconvertible balance was dropped from
  // whichever total it belonged to. Coarse on purpose.
  const hidden = (a?.redactedCount ?? 0) > 0;
  const unconverted = a?.totalsUnconverted === true;
  const indeterminate = !a
    ? 'no account payload was supplied'
    : hidden
      ? `${a.redactedCount} account(s) are hidden from this context, so the totals cannot be complete`
      : unconverted
        ? 'at least one balance could not be converted to the reporting currency and was excluded'
        : null;

  const balance = (amount: number | undefined, count: number): BalanceComponent => {
    if (indeterminate) {
      return { state: ComponentState.UNKNOWN, amount: null, currency: CURRENCY,
        accountCount: count, asOfISO: a?.asOfISO ?? null, reason: indeterminate };
    }
    if (count === 0) {
      return { state: ComponentState.ABSENT, amount: 0, currency: CURRENCY,
        accountCount: 0, asOfISO: a?.asOfISO ?? null, reason: null };
    }
    return { state: ComponentState.ASSERTABLE, amount: amount ?? 0, currency: CURRENCY,
      accountCount: count, asOfISO: a?.asOfISO ?? null, reason: null };
  };

  const liquidity = balance(a?.totalLiquid, a?.counts.liquid ?? 0);
  const debt = balance(a?.totalLiabilities, a?.counts.liabilities ?? 0);

  const incomeStreams: IncomeStreamState[] = input.incomeStreams.map((s) => {
    const amountState = s.amount ? ComponentState.ASSERTABLE : ComponentState.UNKNOWN;
    // A monthly figure requires BOTH licences: the stream must be allowed to
    // project, and its amount must be known. Either alone yields nothing.
    const nominalMonthly = s.amount && s.cadence && s.projectionEligible
      ? monthlyEquivalent(s.amount.value, s.cadence)
      : null;
    return {
      sourceKey: s.sourceKey,
      role: s.role,
      incomeClass: classifyIncome(s.role),
      cadence: s.cadence,
      annualOccurrences: s.cadence ? annualFactor(s.cadence) : null,
      activity: s.activity,
      projectionEligible: s.projectionEligible,
      amountState,
      amount: s.amount?.value ?? null,
      amountProvenance: s.amount?.provenance ?? null,
      // ⚠️ CARRIED. FORECAST-3 owns what a basis means and FORECAST-5 owns
      // whether one was established; this composer does neither, and a stream
      // with no amount has no basis question to answer.
      basis: s.amount?.basis ?? AmountBasis.UNKNOWN,
      basisProvenance: s.amount?.basisProvenance ?? null,
      nominalMonthly,
      currency: s.amount?.currency ?? CURRENCY,
    };
  });

  const obligations: ObligationState = !input.obligations.evaluated
    ? {
      state: ComponentState.UNKNOWN, licensedEventCount: 0,
      activeButUndatedCount: input.obligations.activeButUndatedCount,
      reason: 'future obligations were not evaluated',
    }
    : input.obligations.licensedEvents.length > 0
      ? {
        state: ComponentState.ASSERTABLE,
        licensedEventCount: input.obligations.licensedEvents.length,
        activeButUndatedCount: input.obligations.activeButUndatedCount,
        reason: `${input.obligations.licensedEvents.length} future obligation event(s) are licensed by canonical evidence`,
      }
      : {
        // ⚠️ ABSENT is a fact about EVIDENCE, not about the user's life. They
        // certainly have bills; nothing available can name or date one. The
        // wording matters because "you have no bills" is false.
        state: ComponentState.ABSENT,
        licensedEventCount: 0,
        activeButUndatedCount: input.obligations.activeButUndatedCount,
        reason: 'no future obligations are currently licensed from available evidence'
          + (input.obligations.activeButUndatedCount > 0
            ? `; ${input.obligations.activeButUndatedCount} obligation(s) are active but carry no due date`
            : '')
          + '. This is a statement about the evidence, not a statement that no bills exist.',
      };

  const b = input.baseline;
  const discretionaryBaseline: BaselineState = b?.assertable
    ? {
      state: ComponentState.ASSERTABLE, amount: b.amount ?? null,
      periodBasis: b.periodBasis ?? PeriodBasis.PER_28_DAYS,
      provenance: b.provenance ?? EventProvenance.DERIVED,
      currency: b.currency ?? CURRENCY, reason: b.reason,
    }
    : {
      // ⚠️ UNKNOWN, and never zero. No trailing average substitutes for it.
      state: ComponentState.UNKNOWN, amount: null, periodBasis: null, provenance: null,
      currency: CURRENCY,
      reason: b?.reason ?? 'no current-normal spending level was established',
    };

  const stamps = [a?.asOfISO].filter((x): x is string => Boolean(x));
  const freshnessSpreadDays = stamps.length > 1
    ? Math.round((Date.parse(stamps.sort().at(-1)!) - Date.parse(stamps[0])) / 86_400_000)
    : stamps.length === 1 ? 0 : null;

  return {
    asOfISO: input.asOfISO,
    liquidity, debt, investments: input.investments,
    incomeStreams, knownObligations: obligations, discretionaryBaseline,
    freshnessSpreadDays,
  };
}

// ── Conclusion licensing ────────────────────────────────────────────────────

/**
 * The conclusions anyone might want, and what each one costs in evidence.
 *
 * ⚠️ THIS TABLE IS THE POINT OF THE SLICE. Every measured forecast failure was
 * a conclusion drawn over a missing input, so the requirement is declared here
 * rather than remembered later. Adding a conclusion means declaring what it
 * needs; there is no way to add one that needs nothing.
 */
export const Conclusion = {
  CURRENT_LIQUID_BALANCE: 'CURRENT_LIQUID_BALANCE',
  CURRENT_DEBT_BALANCE: 'CURRENT_DEBT_BALANCE',
  CURRENT_INVESTMENT_TOTAL: 'CURRENT_INVESTMENT_TOTAL',
  NEXT_PAY_DATES: 'NEXT_PAY_DATES',
  NOMINAL_MONTHLY_INCOME: 'NOMINAL_MONTHLY_INCOME',
  KNOWN_OBLIGATION_SCHEDULE: 'KNOWN_OBLIGATION_SCHEDULE',
  MONTHLY_DISCRETIONARY_SPEND: 'MONTHLY_DISCRETIONARY_SPEND',
  MONTHLY_BURN_RATE: 'MONTHLY_BURN_RATE',
  MONTHLY_SURPLUS: 'MONTHLY_SURPLUS',
  SAVINGS_RATE: 'SAVINGS_RATE',
  CASH_RUNWAY: 'CASH_RUNWAY',
  SAFE_MONTHLY_BUDGET: 'SAFE_MONTHLY_BUDGET',
  NET_MONTHLY_INFLOW: 'NET_MONTHLY_INFLOW',
  FORECAST_ENDING_CASH: 'FORECAST_ENDING_CASH',
} as const;

export type ConclusionKind = typeof Conclusion[keyof typeof Conclusion];

/** What a conclusion needs. `netIncome` means a NET basis, not merely an amount. */
interface Requirement {
  liquidity?: boolean;
  debt?: boolean;
  investments?: boolean;
  incomeAmount?: boolean;
  netIncomeBasis?: boolean;
  obligations?: boolean;
  baseline?: boolean;
}

const REQUIRES: Record<ConclusionKind, Requirement> = {
  CURRENT_LIQUID_BALANCE:      { liquidity: true },
  CURRENT_DEBT_BALANCE:        { debt: true },
  CURRENT_INVESTMENT_TOTAL:    { investments: true },
  // Dates come from cadence and activity alone — no amount required. This is
  // why readiness is a matrix: some questions are already answerable.
  NEXT_PAY_DATES:              {},
  NOMINAL_MONTHLY_INCOME:      { incomeAmount: true },
  KNOWN_OBLIGATION_SCHEDULE:   { obligations: true },
  MONTHLY_DISCRETIONARY_SPEND: { baseline: true },
  MONTHLY_BURN_RATE:           { baseline: true, obligations: true },
  MONTHLY_SURPLUS:             { baseline: true, netIncomeBasis: true },
  SAVINGS_RATE:                { baseline: true, netIncomeBasis: true },
  CASH_RUNWAY:                 { liquidity: true, baseline: true, obligations: true },
  SAFE_MONTHLY_BUDGET:         { liquidity: true, baseline: true, netIncomeBasis: true },
  NET_MONTHLY_INFLOW:          { netIncomeBasis: true },
  FORECAST_ENDING_CASH:        { liquidity: true, baseline: true, netIncomeBasis: true },
};

export type ConclusionLicence =
  | { licensed: true }
  | { licensed: false; missing: string[]; reason: string };

/**
 * Whether the state supports a conclusion.
 *
 * ⚠️ ABSENT SATISFIES A REQUIREMENT; UNKNOWN DOES NOT. A provably empty
 * obligation set is usable evidence — zero licensed obligations really do
 * contribute zero to a burn rate. An unknown spending baseline is not, because
 * treating it as zero is the exact failure this program set out to close.
 */
export function conclusionLicence(
  state: CurrentOperatingState, conclusion: ConclusionKind,
): ConclusionLicence {
  const req = REQUIRES[conclusion];
  const missing: string[] = [];
  const usable = (s: ComponentStateKind) => s === ComponentState.ASSERTABLE || s === ComponentState.ABSENT;

  if (req.liquidity && !usable(state.liquidity.state)) missing.push('current liquid balance');
  if (req.debt && !usable(state.debt.state)) missing.push('current debt balance');
  if (req.investments && (!state.investments || state.investments.combined === null)) {
    missing.push('investment composition');
  }
  if (req.incomeAmount && !state.incomeStreams.some((s) => s.nominalMonthly !== null)) {
    missing.push('a projection-eligible income stream with an assertable amount');
  }
  // ⚠️ THE MONTHLY FIGURE IS PART OF THE REQUIREMENT. A NET basis on a stream
  // with no monthly equivalent — a good amount on a stream that is not licensed
  // to continue — would license "net monthly inflow" with no number behind it.
  // Unreachable while basis was hard-coded UNKNOWN; reachable from FORECAST-9A,
  // and refused here for the same reason FORECAST-8 refuses the equivalent
  // supposition. This strictly tightens: it never licenses more than before.
  if (req.netIncomeBasis
    && !state.incomeStreams.some((s) => s.basis === AmountBasis.NET && s.nominalMonthly !== null)) {
    missing.push('net (after-tax) basis for income — only nominal amounts are established');
  }
  if (req.obligations && !usable(state.knownObligations.state)) missing.push('known future obligations');
  if (req.baseline && !usable(state.discretionaryBaseline.state)) {
    missing.push('current-normal discretionary spending');
  }

  if (missing.length === 0) return { licensed: true };
  return {
    licensed: false, missing,
    reason: `${conclusion} requires ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not established`,
  };
}

/**
 * Every conclusion's licence at once.
 *
 * A capability matrix rather than one readiness flag, because readiness is
 * genuinely question-specific: "when is my next payday" is answerable from
 * cadence and activity while "what is my cash in three months" is not, and a
 * single boolean would have to lie about one of them.
 */
export function forecastCapabilities(
  state: CurrentOperatingState,
): Array<{ conclusion: ConclusionKind; licence: ConclusionLicence }> {
  return (Object.values(Conclusion) as ConclusionKind[])
    .map((conclusion) => ({ conclusion, licence: conclusionLicence(state, conclusion) }));
}

/** The distinct blockers across all refused conclusions, most common first. */
export function forecastBlockers(state: CurrentOperatingState): string[] {
  const counts = new Map<string, number>();
  for (const { licence } of forecastCapabilities(state)) {
    if (licence.licensed) continue;
    for (const m of licence.missing) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

// ── Serialization ───────────────────────────────────────────────────────────


/**
 * A compact statement of the state. Designed and measured; NOT production-wired.
 *
 * Carries balances, streams, the two evidence states that block most
 * conclusions, and the refusals themselves — never raw transactions.
 */
export function describeOperatingState(state: CurrentOperatingState): string[] {
  const lines = [`Current financial state as at ${state.asOfISO}:`];

  lines.push(`  Liquid cash: ${state.liquidity.state === ComponentState.ASSERTABLE
    ? money(state.liquidity.amount) : `${state.liquidity.state} — ${state.liquidity.reason}`}`);
  lines.push(`  Debt owed: ${state.debt.state === ComponentState.ASSERTABLE
    ? money(state.debt.amount) : `${state.debt.state} — ${state.debt.reason}`}`);

  if (state.investments) {
    for (const c of state.investments.components) {
      lines.push(`  ${c.label}: ${c.state === ComponentState.UNKNOWN ? 'UNKNOWN' : money(c.amount)}`);
    }
    lines.push(`  Total investments: ${state.investments.combined === null
      ? `withheld — ${state.investments.withheldReason}` : money(state.investments.combined)}`);
  }
  lines.push('  Investments and digital assets are NOT liquid cash.');

  lines.push('  Income streams:');
  for (const s of state.incomeStreams) {
    lines.push(`   - ${s.sourceKey} · ${s.role.toLowerCase()} · ${s.cadence ?? 'no cadence'}`
      + ` · activity ${s.activity} · ${s.projectionEligible ? 'projection-eligible' : 'NOT projection-eligible'}`
      + ` · ${s.nominalMonthly !== null
        ? `${s.basis === AmountBasis.NET ? 'net' : 'nominal'} ${money(s.nominalMonthly, s.currency)}/month `
          + `(basis ${s.basis}${s.basisProvenance ? `, stated by ${s.basisProvenance.toLowerCase().replace(/_/g, ' ')}` : ''}`
          + `${s.basis === AmountBasis.NET ? '' : ' — not spendable cash'})`
        : `amount ${s.amountState}`}`);
  }

  lines.push(`  Known future obligations: ${state.knownObligations.state} — ${state.knownObligations.reason}`);
  lines.push(`  Current-normal discretionary spending: ${state.discretionaryBaseline.state === ComponentState.ASSERTABLE
    ? `${money(state.discretionaryBaseline.amount, state.discretionaryBaseline.currency)} per `
      + `${state.discretionaryBaseline.periodBasis === PeriodBasis.MONTHLY ? 'month' : '28 days'}`
    : `UNKNOWN — ${state.discretionaryBaseline.reason}`}`);

  const refused = forecastCapabilities(state).filter((c) => !c.licence.licensed);
  if (refused.length) {
    lines.push(`  These may NOT be stated: ${refused.map((r) => r.conclusion.toLowerCase().replace(/_/g, ' ')).join(', ')}.`);
    lines.push(`  Missing: ${forecastBlockers(state).join('; ')}.`);
    lines.push('  Do not substitute a historical average for any of them, and do not treat an '
      + 'unknown figure as zero.');
  }
  return lines;
}
