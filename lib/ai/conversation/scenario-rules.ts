/**
 * lib/ai/conversation/scenario-rules.ts
 *
 * WHAT RAN, SAID BY CODE — the clauses a scenario actually executed, stated as a
 * closed roster in which ABSENT is a value, and the one place a caller's free
 * text is kept from standing where a rule is read.
 *
 * ⚠️ THE FAILURE THIS EXISTS FOR (G5). "Keep six months of expenses, pay my
 * highest-interest cards first, then invest" was executed as
 * `{ surplusFraction: 1, target: ['highest_apr','investments'] }` — a FLOW rule
 * standing in for a STOCK rule — 2/8 in a short sequence, 5/8 across twelve
 * turns, and 6/6 once the active-scenario envelope held the substitution. The
 * result DID echo a `surplusRule`. What it could not do was say that no floor
 * ran: the floor was simply not there, and a missing key is not a statement. The
 * contribution's free-text `label` filled the silence — it rode into every
 * settled movement and into the envelope, in the model's own words.
 *
 * ⚠️ WHY THIS IS NOT A LABEL CHECK. Measured over the investigation's traces, 57
 * scenario calls ran a surplus share with no floor anywhere in the call. The
 * label claimed a buffer in 16 of them, with a digit in 5; in 41 the label said
 * nothing about a floor at all — the clause had vanished without leaving a word
 * behind. Policing labels, in English or by digit, can at best see the minority
 * of substitutions that announce themselves. So correctness here does not depend
 * on reading the label. It depends on two things code can do exactly:
 *
 *   1. THE ROSTER (`clausesInForce`). Every clause KIND the contribution contract
 *      can represent is reported on every scenario result, read back off the
 *      settled movements: it ran, with the figures it ran at, or it did NOT run.
 *      The set is closed, so a clause cannot be absent from the echo by being
 *      absent from the arguments.
 *   2. THE NAME (`contributionName`). A settled movement is named by code from
 *      the structured fields that sized it. A caller's label survives only on a
 *      fixed-amount contribution, quoted and bounded, as the name of a THING
 *      ("Roth IRA") — never on a rule, where the only thing a label can be is the
 *      rule restated in unverified English.
 *
 * ⚠️ PURE. No I/O, no clock, no money arithmetic beyond summing what the ledger
 * already settled. The ledger is still the one authority on what a rule does;
 * this module only reports it.
 */

import type { DatedMovement, PlannedMovement, LedgerResult } from './scenario-ledger';

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── The contribution contract's vocabulary ───────────────────────────────────

/**
 * Every key a contribution may carry. CLOSED: a key outside this set names a
 * clause the contract cannot represent, and running the rest of the rule without
 * it would be the silent approximation the evidence rule forbids.
 */
export const CONTRIBUTION_KEYS = [
  'amount', 'fractionOfLiquid', 'surplusFraction', 'liquidFloor',
  'liquidFloorMonthsOfExpenses', 'fractionOfExcess', 'target',
  'onDate', 'from', 'to', 'cadence', 'label',
] as const;

/** The keys on a raw contribution that the contract does not define. */
export function unknownContributionKeys(raw: Record<string, unknown>): string[] {
  const known = new Set<string>(CONTRIBUTION_KEYS);
  return Object.keys(raw).filter((k) => !known.has(k) && raw[k] !== undefined);
}

/**
 * How a contribution is SIZED — the distinction the whole module turns on.
 *
 *   FLOOR         a STOCK rule: what the balance holds above a line.
 *   SURPLUS_SHARE a FLOW rule: a share of what one month adds.
 *   BALANCE_SHARE a share of the whole balance on a date.
 *   AMOUNT        fixed dollars.
 *   UNDETERMINED  none or several — the ledger refuses it by name.
 */
export type ContributionBasis = 'FLOOR' | 'SURPLUS_SHARE' | 'BALANCE_SHARE' | 'AMOUNT' | 'UNDETERMINED';

export function contributionBasis(raw: Record<string, unknown>): ContributionBasis {
  const has = (k: string) => raw[k] !== undefined && raw[k] !== null;
  const bases: ContributionBasis[] = [];
  if (has('liquidFloor') || has('liquidFloorMonthsOfExpenses') || has('fractionOfExcess')) bases.push('FLOOR');
  if (has('surplusFraction')) bases.push('SURPLUS_SHARE');
  if (has('fractionOfLiquid')) bases.push('BALANCE_SHARE');
  if (has('amount')) bases.push('AMOUNT');
  return bases.length === 1 ? bases[0] : 'UNDETERMINED';
}

/** The longest caller-supplied name that is echoed. A name, not a sentence. */
export const MAX_LABEL_CHARS = 40;

/** A caller's label as a bounded name, or null when there is none worth keeping. */
export function boundedLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const clean = label.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > MAX_LABEL_CHARS ? `${clean.slice(0, MAX_LABEL_CHARS - 1)}…` : clean;
}

/**
 * The name a settled movement carries.
 *
 * ⚠️ A RULE IS NAMED BY CODE; ONLY A THING KEEPS ITS CALLER'S NAME. For the three
 * rule bases the name is derived from the basis and nothing else — the caller's
 * label is not consulted, so it cannot put a clause into the result that the
 * structured fields did not. A flow rule's name SAYS it keeps no floor, because
 * that name is repeated on every dated amount, which is exactly where a reader
 * deciding "was the buffer kept?" is looking. A fixed amount keeps its label,
 * quoted, because "Roth IRA" is information code cannot derive and asserts no
 * condition.
 */
export function contributionName(raw: Record<string, unknown>): string {
  switch (contributionBasis(raw)) {
    case 'FLOOR':
      return raw.liquidFloorMonthsOfExpenses !== undefined
        ? `cash above a floor of ${Number(raw.liquidFloorMonthsOfExpenses)} months of expenses`
        : 'cash above the floor';
    case 'SURPLUS_SHARE': return 'share of the month\'s surplus — keeps no cash floor';
    case 'BALANCE_SHARE': return 'share of the cash balance — keeps no cash floor';
    case 'AMOUNT': {
      const name = boundedLabel(raw.label);
      return name ? `fixed amount, named "${name}" by the caller` : 'fixed amount';
    }
    default: return 'contribution';
  }
}

/**
 * Scenario arguments with the free text the contract never applies taken off
 * the rules, for anything that REMEMBERS the arguments (the active-scenario
 * envelope).
 *
 * ⚠️ EVERY STRUCTURED FIELD IS UNTOUCHED, so the arguments still re-run to the
 * same figures. Only a rule's `label` goes — it sized nothing, and left in place
 * it is a sentence about the scenario that no execution vouches for, re-read on
 * every later turn. A fixed amount's label stays, bounded. Outflow labels are
 * names of things ("car", "bonus") and are not touched.
 */
export function withoutUnappliedLabels(args: Record<string, unknown>): Record<string, unknown> {
  const contributions = args.contributions;
  if (!Array.isArray(contributions)) return args;
  return { ...args, contributions: contributions.map((c) => {
    if (!c || typeof c !== 'object' || !('label' in c)) return c;
    const { label, ...rest } = c as Record<string, unknown>;
    const name = contributionBasis(rest) === 'AMOUNT' ? boundedLabel(label) : null;
    return name ? { ...rest, label: name } : rest;
  }) };
}

// ── The roster ───────────────────────────────────────────────────────────────

/** A floor as months of expenses, when that is how it was stated. */
export interface FloorIdentity {
  liquidFloor: number;
  derivedFrom: { monthsOfExpenses: number; baseline: { amount: number; basis: string } };
}

type Settled = DatedMovement & { kind: 'CONTRIBUTION' | 'OUTFLOW' };
type OneOrMany<T> = T | T[];
const oneOrMany = <T>(xs: T[]): OneOrMany<T> => (xs.length === 1 ? xs[0] : xs);

export interface ClausesInForce {
  /** STOCK: cash held at or above a line. The clause G5 lost. */
  cashFloor:
    | { ran: true; keep: OneOrMany<number>; fractionOfExcess: OneOrMany<number>;
        statedAs?: OneOrMany<{ monthsOfExpenses: number; atMonthlySpending: number; spendingBasis: string }>;
        /** Other rules that ran beside the floor rule and are NOT bound by it. */
        notBoundByFloor?: { rules: string[]; meaning: string } }
    | { ran: false; lowestLiquid?: { date: string; amount: number }; meaning?: string };
  /** FLOW: a share of what each month adds. */
  surplusShare: { ran: true; share: OneOrMany<number> } | { ran: false };
  /** A share of the whole balance on a date. */
  balanceShare: { ran: true; share: OneOrMany<number> } | { ran: false };
  fixedAmounts: { ran: true; count: number; total: number } | { ran: false };
  /** WHERE: whether any rule named a liability, the order it named, and what reached one. */
  debtPaydown:
    | { ran: true; order: OneOrMany<string[]>; paidToDebt: number }
    | { ran: false; meaning?: string };
}

const NO_FLOOR_MEANING =
  'NO cash floor ran. Every rule in this scenario moves its amount whatever the balance is, so '
  + 'cash is not held at any level (`lowestLiquid` is the lowest checkpoint). This result is NOT '
  + '"keep a buffer / $X / N months of expenses, then…". If the user asked for that, re-run with '
  + '`liquidFloor` or `liquidFloorMonthsOfExpenses` + `fractionOfExcess` (same `target`); if they '
  + 'did not, do not describe a buffer as kept.';

/**
 * ⚠️ A FLOOR BINDS THE FLOOR RULE AND NOTHING ELSE. Measured live: a nine-month
 * floor stated beside a 50% surplus share ended $2,046 UNDER the floor, because
 * the share moves its cut of every month whatever the balance is. The contract
 * has no floor-as-a-constraint on another basis (one basis per rule, and the
 * ledger refuses two) — so when both run, the roster says which rules the floor
 * does not govern rather than letting `ran: true` read as "cash was kept".
 */
const UNBOUND_MEANING =
  'The floor binds only the floor rule. These rules also ran and move their amount whatever the '
  + 'balance is, so cash can end BELOW the floor — read the checkpoints and '
  + '`floorRule.monthsBelowFloor` before saying it was kept. If the user wants the floor to come '
  + 'first, run the floor rule alone.';

const NO_DEBT_MEANING =
  'No rule named a liability: every contribution went to investments, and debts moved only by '
  + 'interest and their stated minimums. If the user asked to pay debt first, re-run with `target`.';

const targetWord = (t: unknown): string =>
  typeof t === 'string' ? t
    : t && typeof t === 'object' && typeof (t as { liability?: unknown }).liability === 'string'
      ? (t as { liability: string }).liability : String(t);

/**
 * The closed roster of contribution clauses, as they RAN.
 *
 * ⚠️ READ OFF THE SETTLED MOVEMENTS, like `surplusRule` and `floorRule` beside
 * it — never off the arguments and never off a label. A rule the ledger rejected
 * settled nothing and is therefore reported as not having run, which is the
 * truth about it. The allocation ORDER alone comes from the planned movements
 * (a settled movement records where money went, not the order it was offered),
 * and only from rules that actually settled.
 *
 * ⚠️ ABSENCE IS ONLY EXPLAINED WHEN IT CAN MATTER. A floor constrains rules that
 * move cash; with no contribution in force there is nothing for it to constrain,
 * and the existing "no contributions were in force" note already says so. The
 * two sentences appear when some rule ran WITHOUT a floor, or without a debt
 * target — the two clauses measured to vanish.
 */
export function clausesInForce(
  ledger: Pick<LedgerResult, 'movements' | 'checkpoints'>,
  planned: readonly PlannedMovement[] = [],
  floors: readonly FloorIdentity[] = [],
): ClausesInForce {
  const ran: Settled[] = ledger.movements.filter((m) => m.kind === 'CONTRIBUTION');
  const uniq = <T>(xs: T[]) => [...new Set(xs)];
  const floor   = ran.filter((m) => m.liquidFloor !== undefined);
  const surplus = ran.filter((m) => m.surplusFraction !== undefined);
  const balance = ran.filter((m) => m.fractionOfLiquid !== undefined);
  const fixed   = ran.filter((m) => m.liquidFloor === undefined && m.surplusFraction === undefined
    && m.fractionOfLiquid === undefined);

  const lowest = ledger.checkpoints.reduce<{ date: string; amount: number } | null>((lo, c) =>
    c.liquid && (lo === null || c.liquid.amount < lo.amount) ? { date: c.date, amount: c.liquid.amount } : lo, null);

  const floorsKept = uniq(floor.map((m) => m.liquidFloor as number));
  const identities = floors.filter((f) => floorsKept.includes(f.liquidFloor)).map((f) => ({
    monthsOfExpenses: f.derivedFrom.monthsOfExpenses,
    atMonthlySpending: f.derivedFrom.baseline.amount,
    spendingBasis: f.derivedFrom.baseline.basis }));

  // The order each settled rule offered its cash in. A rule is matched to its
  // plan by date and size fields — the same fields the settler copied across.
  const settledKeys = new Set(ran.map((m) => `${m.date}|${m.liquidFloor ?? ''}|${m.surplusFraction ?? ''}|${m.fractionOfLiquid ?? ''}`));
  const orders = uniq(planned
    .filter((p) => p.targets && p.targets.some((t) => t !== 'investments')
      && settledKeys.has(`${p.date}|${p.liquidFloor ?? ''}|${p.surplusFraction ?? ''}|${p.fractionOfLiquid ?? ''}`))
    .map((p) => JSON.stringify((p.targets as readonly unknown[]).map(targetWord))))
    .map((s) => JSON.parse(s) as string[]);
  const paidToDebt = round2(ran.reduce((s, m) =>
    s + (m.placed ? m.placed.liabilities.reduce((t, l) => t + l.amount, 0) : 0), 0));

  // Rules that settled a positive amount beside a floor rule, by clause name.
  const moved = (ms: Settled[]) => ms.some((m) => m.amount > 0);
  const unbound = floor.length === 0 ? [] : [
    ...(moved(surplus) ? ['surplusShare'] : []),
    ...(moved(balance) ? ['balanceShare'] : []),
    ...(moved(fixed) ? ['fixedAmounts'] : []),
  ];

  return {
    cashFloor: floor.length > 0
      ? { ran: true, keep: oneOrMany(floorsKept),
          fractionOfExcess: oneOrMany(uniq(floor.map((m) => m.fractionOfExcess as number))),
          ...(identities.length ? { statedAs: oneOrMany(identities) } : {}),
          ...(unbound.length ? { notBoundByFloor: { rules: unbound, meaning: UNBOUND_MEANING } } : {}) }
      : ran.length > 0
        ? { ran: false, ...(lowest ? { lowestLiquid: lowest } : {}), meaning: NO_FLOOR_MEANING }
        : { ran: false },
    surplusShare: surplus.length > 0
      ? { ran: true, share: oneOrMany(uniq(surplus.map((m) => m.surplusFraction as number))) } : { ran: false },
    balanceShare: balance.length > 0
      ? { ran: true, share: oneOrMany(uniq(balance.map((m) => m.fractionOfLiquid as number))) } : { ran: false },
    fixedAmounts: fixed.length > 0
      ? { ran: true, count: fixed.length, total: round2(fixed.reduce((s, m) => s + m.amount, 0)) } : { ran: false },
    debtPaydown: orders.length > 0 || paidToDebt > 0
      ? { ran: true, order: oneOrMany(orders), paidToDebt }
      : ran.length > 0 ? { ran: false, meaning: NO_DEBT_MEANING } : { ran: false },
  };
}

/**
 * The roster at envelope size: every clause still present, `'NONE'` where it did
 * not run, no sentences.
 *
 * ⚠️ `'NONE'`, NOT A MISSING KEY AND NOT `null`. The envelope is re-read on every
 * later turn, and the substitution it used to propagate 6/6 was invisible there
 * for the same reason it was invisible in the result: nothing said the floor was
 * not in force. A word in a named slot does.
 */
export type ClausesRan = Record<keyof ClausesInForce, unknown>;

export function compactClauses(c: ClausesInForce): ClausesRan {
  return {
    cashFloor: c.cashFloor.ran
      ? { keep: c.cashFloor.keep,
          ...(c.cashFloor.statedAs && !Array.isArray(c.cashFloor.statedAs)
            ? { monthsOfExpenses: c.cashFloor.statedAs.monthsOfExpenses } : {}),
          ...(c.cashFloor.notBoundByFloor ? { notBoundByFloor: c.cashFloor.notBoundByFloor.rules } : {}) }
      : 'NONE',
    surplusShare: c.surplusShare.ran ? c.surplusShare.share : 'NONE',
    balanceShare: c.balanceShare.ran ? c.balanceShare.share : 'NONE',
    fixedAmounts: c.fixedAmounts.ran ? { count: c.fixedAmounts.count, total: c.fixedAmounts.total } : 'NONE',
    debtPaydown: c.debtPaydown.ran ? c.debtPaydown.order : 'NONE',
  };
}

/** Is this value a roster `clausesInForce` produced? Structural, for the envelope's reader. */
export function isClausesInForce(v: unknown): v is ClausesInForce {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (['cashFloor', 'surplusShare', 'balanceShare', 'fixedAmounts', 'debtPaydown'] as const)
    .every((k) => o[k] !== null && typeof o[k] === 'object'
      && typeof (o[k] as { ran?: unknown }).ran === 'boolean');
}
