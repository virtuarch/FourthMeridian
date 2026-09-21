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

import type { DatedMovement, LedgerResult, AllocationTarget } from './scenario-ledger';
import type { IncomeChangeExecution } from '@/lib/forecast/income-change';

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

/** The keys of `raw` that are stated (not undefined) and that `known` does not contain. */
export function unknownKeys(raw: Record<string, unknown>, known: readonly string[]): string[] {
  const set = new Set<string>(known);
  return Object.keys(raw).filter((k) => !set.has(k) && raw[k] !== undefined);
}

/**
 * The WORDS a `target` may be, in the one place anything outside the ledger reads
 * them from. The ledger's third form, `{ liability: id }`, is an identifier and
 * not a word — ids churn when a connection is re-linked, so nothing durable keeps one.
 *
 * ⚠️ TIED TO THE LEDGER'S OWN TYPE BY THE COMPILER, because the ledger is
 * import-free and cannot read this constant: `satisfies` refuses a word the
 * ledger's `AllocationTarget` does not have, and `_EveryTargetWord` refuses to
 * compile if the ledger gains a word this list lacks.
 */
type TargetWord = Extract<AllocationTarget, string>;
export const ALLOCATION_TARGET_WORDS = ['investments', 'highest_apr'] as const satisfies readonly TargetWord[];
export type AllocationTargetWord = typeof ALLOCATION_TARGET_WORDS[number];
type _EveryTargetWord = [TargetWord] extends [AllocationTargetWord] ? true : never;
const _everyTargetWord: _EveryTargetWord = true;

/** Is this value one of the contract's target words? */
export function isAllocationTargetWord(t: unknown): t is AllocationTargetWord {
  return typeof t === 'string' && (ALLOCATION_TARGET_WORDS as readonly string[]).includes(t);
}

/** The keys on a raw contribution that the contract does not define. */
export function unknownContributionKeys(raw: Record<string, unknown>): string[] {
  return unknownKeys(raw, CONTRIBUTION_KEYS);
}

// ── The closed ARGUMENT set ──────────────────────────────────────────────────

/**
 * ⚠️ THE SCHEMA IS THE ONE LITERAL. `CONTRIBUTION_KEYS` closes a contribution;
 * nothing closed the scenario's own arguments. `prepareScenario` reads the keys
 * it knows and never looked at the rest, so `incomeChanges`, `contribution`,
 * `floor` — a premature, misspelt or invented argument — ran the scenario
 * WITHOUT that clause and said nothing: the same silent substitution, one level
 * up. The only guard was `additionalProperties: false` in the tool schema, which
 * is a request to the provider, not a check.
 *
 * The closed set is therefore not a second list to keep in step. It is read off
 * the SAME object the model was shown — the tool's `parameters` — so an argument
 * the schema gains (I1's `incomeChanges`) is accepted the moment it is
 * declared, and never before.
 */
type SchemaNode = { properties?: unknown; items?: unknown } | null | undefined;

/** The property names an object schema declares, or null when it declares none. */
export function schemaKeys(schema: unknown): string[] | null {
  const props = (schema as SchemaNode)?.properties;
  return props && typeof props === 'object' ? Object.keys(props as Record<string, unknown>) : null;
}

/** The property names the ITEMS of one array argument declare (`outflows`, `returns`, …). */
export function schemaItemKeys(schema: unknown, arrayKey: string): string[] | null {
  const props = (schema as SchemaNode)?.properties as Record<string, SchemaNode> | undefined;
  return schemaKeys(props?.[arrayKey]?.items);
}

/**
 * One input that was NOT applied, by name.
 *
 * `argument` is set when a whole top-level argument was refused — the envelope
 * reads it to avoid remembering an argument no execution honoured.
 */
export interface RefusedInput { input: string; reason: string; argument?: string }

const code = (keys: readonly string[]) => keys.map((k) => `\`${k}\``).join(', ');

/** Refusals for every top-level argument the tool's own schema does not declare. */
export function refuseUnknownArguments(args: Record<string, unknown>, schema: unknown): RefusedInput[] {
  const known = schemaKeys(schema);
  if (!known) return [];
  return unknownKeys(args, known).map((k) => ({
    input: `argument \`${k}\``, argument: k,
    reason: `\`${k}\` is not an argument of this tool, so whatever it stated was NOT applied — `
      + 'this result was computed without it. Express the condition with the arguments that '
      + `exist (${code(known)}), or tell the user it cannot be modelled; do not describe it as `
      + 'included.' }));
}

/** How many refusals the echo lists before it counts the rest. */
export const NOT_APPLIED_SHOWN = 8;

/**
 * What was stated and NOT applied, as part of the echo of what was.
 *
 * ⚠️ IT RIDES IN `scenarioAssumptions`, SO IT IS ON EVERY PATH. `rejected` sits
 * beside a projection and a crossing, but a goal seek that finds nothing feasible
 * returns no scenario at all — only `assumptionsInForce`. A refusal that lives
 * outside the echo is a refusal that path never shows; inside it, "what was in
 * force" and "what was not" are read in one place. Undefined when nothing was
 * refused, so an ordinary result is unchanged.
 */
export function notAppliedEcho(rejected: readonly RefusedInput[]) {
  if (rejected.length === 0) return undefined;
  return {
    count: rejected.length,
    inputs: rejected.slice(0, NOT_APPLIED_SHOWN),
    meaning: 'These were stated and NOT applied; the figures here were computed without them. '
      + 'Do not describe any of them as included — correct the call, or tell the user.',
  };
}

/**
 * The refusal for ONE item of an array argument that carries undeclared keys,
 * or null when it carries none. The item is not applied at all: running the rest
 * of it without the undeclared condition would be the weaker scenario.
 */
export function refuseUnknownItemKeys(
  raw: Record<string, unknown>, schema: unknown, arrayKey: string, name: string,
  /** Keys the parser READS although the schema does not offer them (an accepted alias). */
  alsoRead: readonly string[] = [],
): RefusedInput | null {
  const known = schemaItemKeys(schema, arrayKey);
  if (!known) return null;
  const unknown = unknownKeys(raw, [...known, ...alsoRead]);
  if (unknown.length === 0) return null;
  return { input: name,
    reason: `this \`${arrayKey}\` entry carries ${code(unknown)}, which is not a field of it `
      + `(${code(known)}), so that condition cannot be applied and the entry was NOT run without it. `
      + 'Express it with the fields that exist, or tell the user it cannot be modelled.' };
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
 * The name a one-off outflow carries.
 *
 * ⚠️ THE SAME DEMOTION, FOR THE SAME REASON (review NB4). An outflow's label is
 * the name of a thing — "car", "bonus" — and that is worth keeping; but it was
 * unbounded caller text reaching every settled movement and the envelope, which
 * is exactly the channel the contribution label was. It is now led by what code
 * knows (cash out, or cash in for a negative amount), and the caller's words
 * follow, quoted and bounded.
 */
export function outflowName(raw: Record<string, unknown>): string {
  const kind = Number(raw.amount) < 0 ? 'one-off inflow' : 'one-off outflow';
  const name = boundedLabel(raw.label);
  return name ? `${kind}, named "${name}" by the caller` : kind;
}

/**
 * Scenario arguments with the free text the contract never applies taken off
 * the rules, for anything that REMEMBERS the arguments (the active-scenario
 * envelope).
 *
 * ⚠️ EVERY STRUCTURED FIELD IS UNTOUCHED, so the arguments still re-run to the
 * same figures. Only a rule's `label` goes — it sized nothing, and left in place
 * it is a sentence about the scenario that no execution vouches for, re-read on
 * every later turn. A fixed amount's label stays, bounded; so does an outflow's
 * ("car", "bonus" — the name of a thing), bounded the same way.
 */
export function withoutUnappliedLabels(args: Record<string, unknown>): Record<string, unknown> {
  const relabel = (list: unknown, keeps: (rest: Record<string, unknown>) => boolean): unknown =>
    !Array.isArray(list) ? list : list.map((c) => {
      if (!c || typeof c !== 'object' || !('label' in c)) return c;
      const { label, ...rest } = c as Record<string, unknown>;
      const name = keeps(rest) ? boundedLabel(label) : null;
      // Key order is preserved for a label that was already a bounded name.
      return name === label ? c : name ? { ...rest, label: name } : rest;
    });
  if (!Array.isArray(args.contributions) && !Array.isArray(args.outflows)) return args;
  return { ...args,
    ...(Array.isArray(args.contributions)
      ? { contributions: relabel(args.contributions, (rest) => contributionBasis(rest) === 'AMOUNT') } : {}),
    ...(Array.isArray(args.outflows) ? { outflows: relabel(args.outflows, () => true) } : {}) };
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
        /**
         * Whether the floor ever BOUND. The first month-end the running balance was at
         * or above the floor (null = never, within this horizon), and how many month-ends
         * after that it sat under it.
         */
        firstReached: string | null; monthsBelowAfterReached: number; neverReached?: string;
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
  /**
   * I1 — WHETHER A DATED INCOME CHANGE ACTUALLY ALTERED ANY PAY DATE.
   *
   * ⚠️ THE ONE CLAUSE THAT CANNOT BE READ OFF A MOVEMENT. The five above are
   * proven by the settled movements, because each of them MOVES money and the
   * ledger records what it moved. An income change moves nothing — it changes
   * the shape of the cash curve those movements are settled against — so it
   * carries its own evidence, and the evidence is a DIFF the spine counted:
   * which occurrences it altered, between which dates, from what to what.
   *
   * ⚠️ AND IT IS STILL NOT READ OFF THE ARGUMENTS. `clausesInForce` cannot see
   * them: its `ledger` parameter is narrowed to three ledger fields precisely so
   * that it cannot, and the executions it now also takes are the SPINE'S OUTPUT,
   * not the caller's input. A rule the spine refused, or one whose window falls
   * outside the horizon, arrives here already saying `ran: false` with its
   * reason — and a caller's label cannot change that, because no label reaches it.
   */
  incomeChange:
    | { ran: true; rules: IncomeClauseLine[]; didNotRun?: IncomeClauseLine[];
        notCash?: { rules: string[]; meaning: string } }
    | { ran: false; didNotRun?: IncomeClauseLine[]; meaning?: string };
}

/** One income rule as the roster states it. Derived; no caller text. */
export interface IncomeClauseLine {
  id: string;
  op: string;
  /** The streams it reached, by label where one exists. Empty when it reached none. */
  of: string[];
  from: string;
  to: string;
  /** Pay dates whose amount the rule altered, created or removed. */
  payDatesChanged: number;
  first: string | null;
  last: string | null;
  /** Dated income inside the governed window, before and after. */
  incomeBefore: number;
  incomeAfter: number;
  /** Of `incomeAfter`, what the projection counts as spendable. Only when they differ. */
  countedAsCash?: number;
  reason?: string;
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

/**
 * ⚠️ A FLOOR RULE THAT RAN IS NOT A FLOOR THAT WAS KEPT (review NB3a). `ran: true`
 * is the truth about the rule and said nothing about the cash: a nine-month floor
 * over a balance that never gets there settles a zero every month, and the
 * envelope then showed `keep: 45000` beside `liquid: 13,300` with nothing to say
 * the line was never reached. The settled movements know (`availableBefore`
 * against the floor), so the roster says it.
 */
const NEVER_REACHED_MEANING =
  'The floor rule ran but cash never reached the floor within this horizon, so the rule moved '
  + 'nothing and cash was NOT held at the floor — it is still building toward it. Do not say the '
  + 'buffer is in place.';

const NO_INCOME_CHANGE_MEANING =
  'An income change was stated and NO pay date changed, so every figure here was computed at '
  + 'the CURRENT income. Read `didNotRun[].reason` and say what actually happened — do not '
  + 'describe the raise, the new salary or the ending income as included.';

/**
 * ⚠️ A RULE CAN EXECUTE PERFECTLY AND LOWER THE PROJECTION. A stated GROSS figure
 * is real money and is NOT cash the user can spend (FORECAST-3), so replacing an
 * observed take-home level with a gross salary removes it from the projected
 * balance. That is the correct answer and it is the one a reader calls a bug, so
 * the roster says it rather than leaving a smaller number to be explained.
 */
const NOT_CASH_MEANING =
  'These rules ran, and the income they set is GROSS — money before deductions, which is NOT '
  + 'spendable cash. The projection therefore does NOT count it, and the cash here may be '
  + 'LOWER than before the change. Say so; if the user meant take-home, re-run with NET.';

/**
 * ⚠️ AN UNQUALIFIED CHANGE IS A READING OF THE SENTENCE, AND THE RESULT SAYS SO.
 * "My income increases 10%" against four streams raises all four, which is what
 * the words mean and is not always what the speaker meant — and on a real Space
 * the streams a rule reaches include bank interest, because the flow classifier
 * files interest deposits as INCOME. Naming them is what lets a wrong reading be
 * corrected in one turn rather than going unnoticed for the rest of the
 * conversation.
 */
const EVERY_STREAM_MEANING =
  'This change named no income, so it was applied to EVERY income stream listed under `of` — '
  + 'which may include interest as well as pay. If the user meant one income, say which streams '
  + 'this covered and re-run with `source` (the keys are on get_pay_dates / get_income).';

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
 * truth about it. The allocation ORDER is the ledger's own record of the rules it
 * PLACED (`allocationOrders`), written by the settler at the placement — never
 * re-derived by matching movements back to a plan, which cannot tell two
 * same-date rules apart and once reported the order of a rule that was refused.
 *
 * ⚠️ ABSENCE IS ONLY EXPLAINED WHEN IT CAN MATTER. A floor constrains rules that
 * move cash; with no contribution in force there is nothing for it to constrain,
 * and the existing "no contributions were in force" note already says so. The
 * two sentences appear when some rule ran WITHOUT a floor, or without a debt
 * target — the two clauses measured to vanish.
 */
export function clausesInForce(
  ledger: Pick<LedgerResult, 'movements' | 'checkpoints' | 'allocationOrders'>,
  floors: readonly FloorIdentity[] = [],
  /** I1 — the SPINE's record of what each income rule altered. Never the arguments. */
  incomeExecutions: readonly IncomeChangeExecution[] = [],
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

  // The orders of the rules the settler actually placed, less any that name no liability.
  const orders = ledger.allocationOrders
    .filter((order) => order.some((t) => t !== 'investments'))
    .map((order) => order.map(targetWord));

  // Whether the floor ever bound: the running balance each floor movement read.
  const atOrAbove = (m: Settled) => (m.availableBefore ?? -Infinity) >= (m.liquidFloor as number);
  const firstAt = floor.findIndex(atOrAbove);
  const firstReached = firstAt === -1 ? null : floor[firstAt].date;
  const monthsBelowAfterReached = firstAt === -1 ? 0 : floor.slice(firstAt).filter((m) => !atOrAbove(m)).length;
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
          firstReached, monthsBelowAfterReached,
          ...(firstReached === null ? { neverReached: NEVER_REACHED_MEANING } : {}),
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
    incomeChange: incomeClause(incomeExecutions),
  };
}

/** One execution as a roster line. Every field is code's; none is the caller's. */
const incomeLine = (x: IncomeChangeExecution): IncomeClauseLine => ({
  id: x.ruleId, op: x.op,
  of: x.matched.map((m) => m.label ?? m.sourceKey),
  from: x.governed.fromISO, to: x.governed.toISO,
  payDatesChanged: x.occurrencesChanged,
  first: x.firstChangedISO, last: x.lastChangedISO,
  incomeBefore: round2(x.nominalBefore), incomeAfter: round2(x.nominalAfter),
  // ⚠️ SAID ONLY WHEN IT DIFFERS. On an ordinary rule over take-home pay these
  // two are the same number, and printing it twice on every line would train a
  // reader to skip the one row where it matters.
  ...(round2(x.spendableAfter) !== round2(x.nominalAfter)
    ? { countedAsCash: round2(x.spendableAfter) } : {}),
  ...(x.reason ? { reason: x.reason } : {}),
});

export function incomeClause(
  executions: readonly IncomeChangeExecution[],
): ClausesInForce['incomeChange'] {
  // ⚠️ NOTHING STATED IS SILENT; STATED-AND-INERT IS NOT. A scenario with no
  // income rule reports `ran: false` and stops — there is nothing to explain.
  // A scenario that WAS given one and changed no pay date has to say so, because
  // that is the case a reader would otherwise read as "the raise is in here".
  if (executions.length === 0) return { ran: false };
  const didRun = executions.filter((x) => x.ran);
  const didNot = executions.filter((x) => !x.ran).map(incomeLine);
  if (didRun.length === 0) {
    return { ran: false, didNotRun: didNot, meaning: NO_INCOME_CHANGE_MEANING };
  }
  // ⚠️ THE RULE PRODUCED INCOME THE PROJECTION WILL NOT COUNT AT ALL. Not "some
  // of what it touched was already unspendable" — a rule is not answerable for
  // what it inherited, and the first version of this fired on an ordinary +10%
  // for exactly that reason. This is the case where the rule SET a figure and the
  // figure buys nothing.
  const everyStream = didRun
    .filter((x) => x.scope === 'EVERY_INCOME_STREAM' && x.matched.length > 1)
    .map((x) => x.ruleId);
  const notCash = didRun
    .filter((x) => x.nominalAfter > 0 && round2(x.spendableAfter) === 0)
    .map((x) => x.ruleId);
  return {
    ran: true,
    rules: didRun.map(incomeLine),
    ...(didNot.length ? { didNotRun: didNot } : {}),
    ...(notCash.length ? { notCash: { rules: notCash, meaning: NOT_CASH_MEANING } } : {}),
    ...(everyStream.length
      ? { everyStream: { rules: everyStream, meaning: EVERY_STREAM_MEANING } } : {}),
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

export function compactClauses(
  /** A roster from THIS build, or one an older build wrote into a live envelope. */
  c: ClausesInForce | (Omit<ClausesInForce, 'incomeChange'> & { incomeChange?: undefined }),
): ClausesRan {
  return {
    cashFloor: c.cashFloor.ran
      ? { keep: c.cashFloor.keep,
          ...(c.cashFloor.statedAs && !Array.isArray(c.cashFloor.statedAs)
            ? { monthsOfExpenses: c.cashFloor.statedAs.monthsOfExpenses } : {}),
          // ⚠️ `false`, NOT A MISSING KEY: `keep: 45000` beside `liquid: 13300` has to
          // be readable as "never got there" without a second call.
          reached: c.cashFloor.firstReached ?? false,
          ...(c.cashFloor.monthsBelowAfterReached > 0 ? { monthsBelow: c.cashFloor.monthsBelowAfterReached } : {}),
          ...(c.cashFloor.notBoundByFloor ? { notBoundByFloor: c.cashFloor.notBoundByFloor.rules } : {}) }
      : 'NONE',
    surplusShare: c.surplusShare.ran ? c.surplusShare.share : 'NONE',
    balanceShare: c.balanceShare.ran ? c.balanceShare.share : 'NONE',
    fixedAmounts: c.fixedAmounts.ran ? { count: c.fixedAmounts.count, total: c.fixedAmounts.total } : 'NONE',
    debtPaydown: c.debtPaydown.ran ? c.debtPaydown.order : 'NONE',
    // ⚠️ THE ENVELOPE KEEPS THE RULE, NOT THE PAY DATES. A later turn saying
    // "make the raise 15%" has to inherit the SENTENCE — which income, from when,
    // what it became — and a hundred and thirty-five altered dates are an
    // accident of one horizon. `changed` is kept because "it ran" and "it changed
    // nothing" are the two readings this whole clause exists to separate.
    // ⚠️ OPTIONAL-CHAINED FOR THE SAME REASON `isClausesInForce` ACCEPTS IT
    // MISSING, and a test caught the two disagreeing. A roster can arrive from an
    // envelope written by an EARLIER build, where this clause did not exist; the
    // validator was taught to let that through and this was not, so a two-hour-old
    // cookie threw instead of degrading. Absent reads as 'NONE', which is the
    // truth about a scenario that had no income rule to run.
    incomeChange: c.incomeChange?.ran
      ? c.incomeChange.rules.map((r) => ({ op: r.op, of: r.of, from: r.from, to: r.to,
          changed: r.payDatesChanged }))
      : 'NONE',
  };
}

/** Is this value a roster `clausesInForce` produced? Structural, for the envelope's reader. */
export function isClausesInForce(v: unknown): v is ClausesInForce {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  // ⚠️ THE FIVE ARE REQUIRED AND `incomeChange` IS CHECKED ONLY IF PRESENT. This
  // reads a roster off a result that may have been produced by an EARLIER build —
  // an envelope lives in a two-hour cookie — and rejecting a pre-I1 roster whole
  // would throw away the five clauses it does carry to punish it for a sixth that
  // did not exist yet. Going forward `compactClauses` always writes it.
  const wellFormed = (v: unknown) =>
    v !== null && typeof v === 'object' && typeof (v as { ran?: unknown }).ran === 'boolean';
  return (['cashFloor', 'surplusShare', 'balanceShare', 'fixedAmounts', 'debtPaydown'] as const)
    .every((k) => wellFormed(o[k]))
    && (o.incomeChange === undefined || wellFormed(o.incomeChange));
}
