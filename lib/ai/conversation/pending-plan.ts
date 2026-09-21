/**
 * lib/ai/conversation/pending-plan.ts
 *
 * WHAT THE USER HAS SAID A CALCULATION SHOULD ASSUME, BEFORE IT HAS RUN.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 * "Starting January my income increases 10%." / "Keep nine months of expenses in
 * cash." / "Pay highest APR debt first." / "Invest everything above the floor." /
 * "What do I have next December?" — measured on the production path, n=6: the
 * scenario that finally ran contained all four clauses 0/6. The raise lived only in
 * prose. The floor and debt order survived as DURABLE Memory V2 rows, written every
 * bare turn, and still never reached execution, because memory correctly never
 * activates anything. The last turn ran a baseline projection 6/6.
 *
 * No carrier held "a condition stated in this conversation that has not run yet".
 * The executed-scenario envelope means "this ran". Memory means "the user wants this
 * kept". Prose means nothing a program can read. This is the fourth thing.
 *
 * ── What it is, exactly ─────────────────────────────────────────────────────
 * A short list of CLAUSES, each one item of an existing scenario argument
 * (`incomeChanges`, `contributions`, `outflows`, …), in exactly the shape that
 * argument takes. There is no second schema: the keys are read off
 * `SCENARIO_INPUTS`, an item's fields are checked against that same literal, and a
 * new scenario argument is stageable the moment it is declared AND given an
 * identity rule here — which a test demands.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 *  · not financial truth — nothing reads it but the next scenario run
 *  · not durable — it lives in the sealed per-conversation runtime state and dies
 *    with the conversation; nothing here writes memory, and memory never enters it
 *  · not executed — the envelope says what ran; this says what was stated
 *  · not a result — a clause is an ARGUMENT; the type has no place for a figure a
 *    calculation produced
 *
 * ⚠️ PURE. No I/O, no clock, no model. Stage, retract, merge, consume.
 */

import { SCENARIO_INPUTS, scenarioAssumptionKeys } from './scenario-inputs';
import type { ContinuityLoss } from './runtime-state';
import {
  boundedLabel, contributionBasis, refuseUnknownItemKeys, type RefusedInput,
} from './scenario-rules';
import { userStatedFigure, type GatedFigure, type TurnEvidence } from './memory-model';
import { resolveTransformableCategory } from '@/lib/transactions/category-vocabulary';

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * ⚠️ BOUNDED BECAUSE IT SHARES A COOKIE WITH THE EXECUTED SCENARIO — and the byte
 * cap is now a MEASUREMENT, not the hex-era guess (S1-0).
 *
 * 600 was set when the seal spent two characters per byte and an oversize seal
 * was discarded WHOLE. Neither is true any more (FM-AUDIT-018): the seal is
 * base64url, and state that does not fit becomes an explicit continuity marker.
 * Measured with the real serializer (`runtime-state-capacity.test.ts` §8 pins it):
 *
 *   · staging is refused once a scenario has run, so a plan AT THIS CAP normally
 *     rides ALONE — and alone it seals to ~2,450 of the 3,900 characters (≥35%
 *     headroom; a pending plan alone overflows only past ~2,690 bytes);
 *   · eight of the LARGEST realistic clauses (S1 spending rules carrying a
 *     category, both dates and a multiplier) measure ~1,590 bytes — so the clause
 *     cap, not this one, is what binds a real conversation;
 *   · the canonical S1 plan (Dining cut + raise + months-of-expenses floor with
 *     its highest-APR → investments waterfall merged in) is ~480 bytes;
 *   · the one case where a plan sits BESIDE an executed scenario — clauses a run
 *     could not confirm, kept — can exceed the ceiling, and then the seal carries
 *     the continuity marker naming both. Never a silent drop.
 */
export const MAX_PENDING_CLAUSES = 8;
export const MAX_PENDING_BYTES = 1_600;

// ── Types ────────────────────────────────────────────────────────────────────

export interface PendingClause {
  /** Stable for the life of the clause: a restatement of the same rule keeps it. */
  id: string;
  /** The scenario argument this is an item of. */
  key: string;
  /** Which rule it is, derived from its fields by `IDENTITY` — never from text. */
  identity: string;
  /** One item of that argument (or its scalar), in the argument's own shape. */
  value: unknown;
  /** The user turn (0-based) it was last stated in. */
  stagedAt: number;
}

export interface PendingPlan {
  v: 1;
  clauses: PendingClause[];
  /** The next id's ordinal. Monotonic, so a retracted id is never reused. */
  next: number;
}

export const emptyPlan = (): PendingPlan => ({ v: 1, clauses: [], next: 1 });

/**
 * The conversation's staged conditions, for the duration of one turn.
 *
 * ⚠️ OWNED BY THE CALLER, LIKE THE SCENARIO SLOT. It is restored from the sealed
 * runtime state at the start of a turn and sealed back at the end; nothing on the
 * server holds it between requests.
 */
export interface PlanSlot {
  pending: PendingPlan;
  /**
   * Whether a scenario has already RUN in this conversation (an envelope is held).
   *
   * ⚠️ MEASURED: after a scenario ran, "actually make the raise 15%" was STAGED 6/6
   * and nothing re-ran — the answer said the change would apply "next time", and
   * the recompute I1 had at 6/6 fell to 0/6. A change to something that already
   * ran only matters when it runs again, so the staging result says so.
   */
  scenarioRan?: boolean;
  /**
   * FM-AUDIT-018 — a plan built earlier in this conversation that could NOT be
   * carried to this turn (too large for the carrier). Its own slot: it is neither
   * pending nor executed, and it is never a result. While it stands the plan is
   * still in play — the turn is told it is not in force.
   */
  continuity?: ContinuityLoss;
}

/**
 * What a successful run leaves behind: the same plan with every clause it applied
 * removed. The ids stay reserved (`next` is kept), so a later clause can never
 * reuse one a reader already saw.
 *
 * ⚠️ CONSUMED, BECAUSE IT NOW LIVES SOMEWHERE TRUER. The envelope carries the
 * merged arguments that ran; a staged clause left behind would be applied a
 * second time over the envelope's copy of itself on the next run.
 */
export function consumePlan(plan: PendingPlan, appliedIds: readonly string[]): PendingPlan {
  const gone = new Set(appliedIds);
  return { ...plan, clauses: plan.clauses.filter((c) => !gone.has(c.id)) };
}

// ── Identity — the closed registry ───────────────────────────────────────────

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * WHICH RULE A CLAUSE IS, per scenario argument. Null means "cannot tell", and a
 * clause whose identity cannot be told is refused, because supersession is only
 * safe when it is exact.
 *
 * ⚠️ EVERY ASSUMPTION KEY HAS ONE ENTRY, AND A TEST DEMANDS IT. This is the whole
 * cost of a new scenario primitive reaching conversational continuity: when S1
 * declares `spendingChanges`, the suite goes red until one line is added here.
 * Not a new carrier, not a memory class, not a field.
 */
export const IDENTITY: Record<string, (v: unknown) => string | null> = {
  annualReturnPct: () => 'annualReturnPct',
  assumedMonthlySpending: () => 'assumedMonthlySpending',
  returns: (v) => (s(o(v).from) ? `from:${s(o(v).from)}` : null),
  // SCALE and SET_RATE both say what the rate IS from a date, so "actually it's
  // $180k, not 10%" replaces rather than stacking two answers to one question.
  incomeChanges: (v) => {
    const c = o(v);
    const op = s(c.op);
    if (!op || !s(c.from)) return null;
    const kind = op === 'SCALE' || op === 'SET_RATE' ? 'RATE'
      : op === 'START' ? `START:${boundedLabel(c.label) ?? ''}` : op;
    return `${kind}|${s(c.source) || '*'}|${s(c.from)}`;
  },
  contributions: (v) => {
    const c = o(v);
    const basis = contributionBasis(c);
    if (basis === 'UNDETERMINED') return null;
    if (basis === 'AMOUNT' || basis === 'BALANCE_SHARE') {
      const when = s(c.onDate) || s(c.from);
      return when ? `${basis}|${when}` : null;
    }
    return basis;
  },
  // ⚠️ A DATE ALONE IS NOT A THING (review blocker 3): a $3,000 car and $500
  // insurance on the same day were one identity, and the second silently replaced
  // the first. The named thing — or, unnamed, the amount — is part of it.
  outflows: (v) => {
    const c = o(v);
    if (!s(c.onDate)) return null;
    return `onDate:${s(c.onDate)}|${boundedLabel(c.label) ?? `amount:${String(c.amount)}`}`;
  },
  liabilityAssumptions: (v) => {
    const id = s(o(v).liabilityId) || s(o(v).id);
    return id ? `liability:${id}` : null;
  },
  // S1 — SCALE, DELTA and SET_RATE all say what a line's rate IS from a date, so
  // "actually make the January cut 15%" replaces the 20% rather than stacking on it.
  // The line is the RESOLVED one ("food" and "Dining" are one rule); `*` is all
  // spending. A word that resolves to no line has no identity — staging refuses it
  // first, with the vocabulary's reason.
  spendingChanges: (v) => {
    const c = o(v);
    if (!s(c.op) || !s(c.from)) return null;
    const line = spendingLineOf(c);
    return line === null ? null : `RATE|${line}|${s(c.from)}`;
  },
};

/** S1 — the transformable line a spending clause names, `*` for all spending, or null. */
function spendingLineOf(c: Obj): string | null {
  const word = s(c.category).trim();
  if (!word) return '*';
  const r = resolveTransformableCategory(word);
  return r.ok ? r.category : null;
}

/**
 * THE SUBJECT A RULE IS ABOUT, which is wider than its identity.
 *
 * ⚠️ REVIEW BLOCKER 3. Two rules can be about the same thing and differ in a
 * field that is part of identity — "up 10% from January" then "actually 15%,
 * starting February" were two identities, both were kept, and from February the
 * income was ×1.265. Code cannot tell a correction ("actually…") from a second
 * rule ("and another 5% in July") by reading fields, so when a new rule shares a
 * SUBJECT with a staged one under a different identity, the choice is made
 * explicit: `replace` (it corrects the earlier one) or `inAddition` (both apply).
 * Null means the key has no such notion: its identity is its subject.
 */
export function subjectOf(key: string, v: unknown): string | null {
  const c = o(v);
  if (key === 'incomeChanges') {
    const op = s(c.op);
    if (op === 'SCALE' || op === 'SET_RATE') return `RATE|${s(c.source) || '*'}`;
    if (op === 'STOP') return `STOP|${s(c.source) || '*'}`;
    return null;
  }
  if (key === 'contributions') {
    const b = contributionBasis(c);
    return b === 'AMOUNT' || b === 'BALANCE_SHARE' ? b : null;
  }
  // S1 — every spending rule on one line is about that line's rate: "another 10% in
  // July" after "20% from January" shares the subject under a different identity,
  // so the caller must say `inAddition` (both apply) or `replace` (it corrects).
  // All spending (`*`) overlaps every line, as an unqualified income rule does.
  if (key === 'spendingChanges') {
    const line = spendingLineOf(c);
    return line === null ? null : `RATE|${line}`;
  }
  return null;
}

/** Do two income scopes overlap? `*` (every income stream) overlaps everything. */
const scopesOverlap = (a: string, b: string) => a === b
  || a.endsWith('|*') && a.split('|')[0] === b.split('|')[0]
  || b.endsWith('|*') && a.split('|')[0] === b.split('|')[0];

// ── Provenance — which fields are figures, and of what kind ──────────────────

/**
 * Every numeric field a clause may carry, by argument, with the kind of quantity
 * it is. `MULTIPLIER` is licensed by the percentage the user said ("10%" → 1.1).
 *
 * ⚠️ AN UNMAPPED NUMBER IS REFUSED, NOT WAVED THROUGH. A field this table does not
 * know is a figure no gate has looked at, and the fail-closed direction is the
 * only one that keeps a tool-derived number out.
 */
type Gate = GatedFigure | 'MULTIPLIER';
const FIGURES: Record<string, Record<string, Gate>> = {
  annualReturnPct: { '': 'Percent' },
  assumedMonthlySpending: { '': 'Money' },
  returns: { annualPct: 'Percent' },
  incomeChanges: { amount: 'Money', multiplier: 'MULTIPLIER' },
  contributions: {
    amount: 'Money', liquidFloor: 'Money', liquidFloorMonthsOfExpenses: 'Months',
    fractionOfExcess: 'Fraction', surplusFraction: 'Fraction', fractionOfLiquid: 'Fraction',
  },
  outflows: { amount: 'Money' },
  liabilityAssumptions: { apr: 'Percent', minimumPayment: 'Money' },
  // S1 — "a 20% cut" licenses 0.8 through the MULTIPLIER gate; "spend $500 less"
  // licenses −500 (the gate compares magnitudes).
  spendingChanges: { multiplier: 'MULTIPLIER', monthly: 'Money' },
};

/**
 * S1 — STOP IS AN OPERATION, NOT A FIGURE. "Stop spending on Travel from June" is
 * `SET_RATE 0` (or `SCALE 0`), and the user never says "$0" to mean it. Only that
 * exact zero on those two fields passes without a stated figure; every other value
 * is still gated.
 */
function isStop(key: string, item: Obj, field: string, v: number): boolean {
  return key === 'spendingChanges' && v === 0
    && ((field === 'monthly' && item.op === 'SET_RATE') || (field === 'multiplier' && item.op === 'SCALE'));
}

function licensed(gate: Gate, v: number, evidence: TurnEvidence): boolean {
  if (gate === 'MULTIPLIER') {
    // "up 10%" → 1.1; "a 20% cut" → 0.8. The percentage is what was said.
    return userStatedFigure('Percent', Math.round(Math.abs(v - 1) * 1e6) / 1e4, evidence);
  }
  return userStatedFigure(gate, v, evidence);
}

// ── Shape ────────────────────────────────────────────────────────────────────

const INPUTS = SCENARIO_INPUTS as Record<string, { type?: string; enum?: unknown[];
  items?: { properties?: Record<string, { type?: string; enum?: unknown[]; anyOf?: unknown[] }> } }>;

const isArrayKey = (key: string) => INPUTS[key]?.type === 'array';

/** A field's value against its declared JSON type. Null means "not stated". */
function wrongType(prop: { type?: string; enum?: unknown[]; anyOf?: unknown[] } | undefined, v: unknown): boolean {
  if (v === null || v === undefined || !prop) return false;
  if (prop.anyOf) {
    return !(typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')));
  }
  if (prop.type === 'number') return typeof v !== 'number' || !Number.isFinite(v);
  if (prop.type === 'string') {
    return typeof v !== 'string' || (Array.isArray(prop.enum) && !prop.enum.includes(v));
  }
  if (prop.type === 'boolean') return typeof v !== 'boolean';
  return false;
}

/** Why this clause cannot be staged, or null. Shape and provenance only — never money. */
function invalid(key: string, value: unknown, evidence: TurnEvidence, name: string): RefusedInput | null {
  const schema = { properties: SCENARIO_INPUTS };
  const figures = FIGURES[key] ?? {};
  const refuse = (reason: string): RefusedInput => ({ input: name, reason });

  if (!isArrayKey(key)) {
    if (wrongType(INPUTS[key], value) || value === null || value === undefined) {
      return refuse(`\`${key}\` must be a ${INPUTS[key]?.type ?? 'value'}.`);
    }
    // ⚠️ ZERO IS A FIGURE (review). Skipping the gate for 0 let an unstated
    // "spend nothing" or "no return" in; Memory V2 refuses a zero outright.
    if (typeof value === 'number' && figures[''] && !licensed(figures[''], value, evidence)) {
      return refuse(`${value} was not stated by the user for \`${key}\`, so it was NOT staged. `
        + 'Only a figure the user said may be carried; ask them, or use their exact number.');
    }
    return null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return refuse(`a \`${key}\` entry must be an object.`);
  }
  const item = value as Obj;
  const unknownKeyRefusal = refuseUnknownItemKeys(item, schema, key, name, key === 'liabilityAssumptions' ? ['id'] : []);
  if (unknownKeyRefusal) return unknownKeyRefusal;

  const props = INPUTS[key]?.items?.properties ?? {};
  for (const [f, v] of Object.entries(item)) {
    if (wrongType(props[f], v)) return refuse(`\`${f}\` has the wrong type, so this entry was NOT staged.`);
    if (typeof v === 'number') {
      const gate = figures[f];
      if (!gate) {
        return refuse(`\`${f}\` is a figure this state has no provenance rule for, so it was NOT `
          + 'staged. Nothing is carried that no gate has checked.');
      }
      if (!isStop(key, item, f, v) && !licensed(gate, v, evidence)) {
        return refuse(`\`${f}: ${v}\` was not stated by the user, so this entry was NOT staged. A `
          + 'figure a tool produced, or one remembered and not restated, is not theirs to carry — '
          + 'use the exact number they said, or ask.');
      }
    }
  }
  // ⚠️ S1 — A LINE THE DATA CANNOT CHANGE IS NEVER HELD. "Cut Medical 30%", "cut
  // restaurants 20%", "cut my interest" are refused HERE, with the vocabulary's own
  // reason (and the bucket it offers), so no later run can pick them up.
  if (key === 'spendingChanges' && typeof item.category === 'string' && item.category.trim() !== '') {
    const r = resolveTransformableCategory(item.category);
    if (!r.ok) return refuse(`${r.unavailable} It was NOT staged.`);
  }
  // ⚠️ A LABEL NAMES A THING WHERE THE CONTRACT KEEPS ONE, AND NOWHERE ELSE — the
  // same boundary the scenario tools enforce, so a clause cannot be staged with a
  // sentence the executor would have refused.
  if (typeof item.label === 'string') {
    const allowed = key === 'outflows'
      || (key === 'contributions' && contributionBasis(item) === 'AMOUNT')
      || (key === 'incomeChanges' && item.op === 'START');
    if (!allowed) {
      return refuse('`label` names a thing and is not part of this rule; a condition written only '
        + 'there cannot run. Drop it and stage the fields.');
    }
  }
  return null;
}

/** The label, bounded, wherever one is kept. */
function bounded(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const v = value as Obj;
  if (typeof v.label !== 'string') return value;
  const name = boundedLabel(v.label);
  const { label: _dropped, ...rest } = v;
  return name ? { ...rest, label: name } : rest;
}

const bytesOf = (plan: PendingPlan) => JSON.stringify(plan.clauses).length;

// ── Stage ────────────────────────────────────────────────────────────────────

export interface StageResult {
  plan: PendingPlan;
  /**
   * A field a merge REPLACED on a staged rule — said, because a merge cannot tell
   * "instead" from "then". Measured: "pay highest APR first" then "invest
   * everything above the floor" staged `target: ['investments']` over
   * `['highest_apr']` 4/6, and the debt order silently left the plan.
   */
  replacedFields: { id: string; field: string; was: unknown; now: unknown }[];
  /** Ids of the clauses this call added or restated. */
  staged: string[];
  /** Ids this call removed. */
  retracted: string[];
  refused: RefusedInput[];
}

/**
 * Add, restate or retract clauses.
 *
 * ⚠️ RESTATING A RULE REPLACES IT, BY IDENTITY. "Actually make the raise 15%"
 * replaces the 10% clause — same id, new value — rather than appending a second
 * raise the executor would run in sequence. A CONTRIBUTION instead merges field by
 * field into the same rule, the way a Memory V2 `amend` does, because the product's
 * central plan is said in pieces: "keep nine months" → "highest APR first" →
 * "invest everything above the floor" is ONE floor rule stated over three turns.
 *
 * ⚠️ A CONTRIBUTION THAT DOES NOT SAY WHAT MONEY ("pay highest APR first", a target
 * alone) merges into the one contribution already staged, or is refused by name —
 * never guessed into a rule of its own.
 */
export function stagePlan(
  plan: PendingPlan,
  input: {
    stage?: Record<string, unknown>; retract?: readonly string[];
    /**
     * The new rule CORRECTS the staged one it overlaps: narrow a waterfall, or
     * replace a same-subject rule stated with a different date. Explicit, or refused.
     */
    replace?: boolean;
    /** The new rule applies AS WELL AS a staged same-subject rule (a second raise). */
    inAddition?: boolean;
  },
  ctx: { turn: number; evidence: TurnEvidence },
): StageResult {
  let clauses = [...plan.clauses];
  let next = plan.next;
  const staged: string[] = [];
  const refused: RefusedInput[] = [];
  const replacedFields: StageResult['replacedFields'] = [];
  const keys = new Set(scenarioAssumptionKeys());

  const retracted: string[] = [];
  for (const id of input.retract ?? []) {
    if (clauses.some((c) => c.id === id)) { clauses = clauses.filter((c) => c.id !== id); retracted.push(id); }
    else refused.push({ input: `retract \`${id}\``, reason: `no staged clause is called \`${id}\`.` });
  }

  for (const [key, raw] of Object.entries(input.stage ?? {})) {
    if (raw === undefined || raw === null) continue;
    if (!keys.has(key)) {
      refused.push({ input: `\`${key}\``, reason: `\`${key}\` is not a scenario assumption, so it `
        + 'was NOT staged. The horizon and the table are chosen when the scenario runs.' });
      continue;
    }
    if (!IDENTITY[key]) {
      refused.push({ input: `\`${key}\``, reason: `\`${key}\` has no identity rule, so a restatement `
        + 'could not be told from a new rule; it was NOT staged.' });
      continue;
    }
    const items = isArrayKey(key) ? (Array.isArray(raw) ? raw : [raw]) : [raw];
    items.forEach((item, i) => {
      const name = `\`${key}\`${isArrayKey(key) ? ` entry ${i + 1}` : ''}`;
      const bad = invalid(key, item, ctx.evidence, name);
      if (bad) { refused.push(bad); return; }
      let value = bounded(item);
      let identity = IDENTITY[key](value);

      // A contribution that names no basis amends the one contribution in force.
      if (identity === null && key === 'contributions') {
        const existing = clauses.filter((c) => c.key === 'contributions');
        if (existing.length !== 1) {
          refused.push({ input: name, reason: 'this contribution does not say what money moves (a '
            + 'floor, a share, or an amount), and there is not exactly one staged contribution for '
            + 'it to amend. Say what money, and it was NOT staged.' });
          return;
        }
        for (const [f, now] of Object.entries(value as Obj)) {
          const was = (existing[0].value as Obj)[f];
          if (was !== undefined && JSON.stringify(was) !== JSON.stringify(now)) {
            replacedFields.push({ id: existing[0].id, field: f, was, now });
          }
        }
        value = { ...(existing[0].value as Obj), ...(value as Obj) };
        identity = IDENTITY[key](value);
      }
      if (identity === null) {
        refused.push({ input: name, reason: 'which rule this is cannot be told from its fields (a date '
          + 'or an operation is missing), so it was NOT staged.' });
        return;
      }

      let same = clauses.find((c) => c.key === key && c.identity === identity);
      const subject = subjectOf(key, value);
      if (!same && subject !== null) {
        const rivals = clauses.filter((c) => c.key === key && c.identity !== identity
          && subjectOf(key, c.value) !== null && scopesOverlap(subjectOf(key, c.value)!, subject));
        if (rivals.length > 0 && !input.replace && !input.inAddition) {
          refused.push({ input: name, reason: `this is about the same thing as the staged `
            + `${rivals.map((r) => `\`${r.id}\``).join(', ')} (${JSON.stringify(rivals[0].value)}) but differs `
            + 'in a date or a scope, and code cannot tell a correction from a second rule. If it '
            + 'CORRECTS the staged one, stage it again with `replace: true`; if BOTH apply (e.g. a '
            + 'second raise later), with `inAddition: true`. It was NOT staged.' });
          return;
        }
        if (rivals.length > 0 && input.replace) {
          // The correction takes the rival's place — and its id, so the reader's
          // "p1" is still the raise.
          same = rivals[0];
          clauses = clauses.filter((c) => !rivals.slice(1).some((r) => r.id === c.id));
          replacedFields.push({ id: same.id, field: '(whole rule)', was: same.value, now: value });
        }
      }
      // ⚠️ NARROWING A WATERFALL IS A WITHDRAWAL, AND A WITHDRAWAL IS EXPLICIT — the
      // rule Memory V2's `amend` already keeps (a write that would drop fields is
      // refused unless `replace`). Measured: "pay highest APR first" staged
      // `['highest_apr','investments']`; "invest everything above the floor" then
      // staged `'investments'` over it 2/6, the result's replacement notice was not
      // acted on, and the debt order left the plan without anyone deciding it
      // should. A merge that would DROP a target word already staged is refused
      // unless the call says `replace: true`.
      const targetWords = (t: unknown): string[] => (Array.isArray(t) ? t.map(String) : t === undefined ? [] : [String(t)]);
      const holder = same ?? (key === 'contributions' && IDENTITY[key](item) === null
        ? clauses.find((c) => c.key === 'contributions') : undefined);
      // ⚠️ NOT EVEN WITH `replace` (measured 1/6, twice): the refusal once offered
      // `replace: true` as the way out, and the model took it for "invest everything
      // above the floor" — a NEXT destination, not a withdrawal. Withdrawing part of
      // a rule is now two deliberate acts: retract it, then stage it again.
      if (holder && key === 'contributions' && (value as Obj).target !== undefined) {
        const kept = targetWords((value as Obj).target);
        const dropped = targetWords((holder.value as Obj).target).filter((w) => !kept.includes(w));
        if (dropped.length > 0) {
          refused.push({ input: name, reason: `this would DROP ${dropped.map((w) => `\`${w}\``).join(', ')} `
            + `from the staged rule \`${holder.id}\`, whose target is `
            + `${JSON.stringify((holder.value as Obj).target)}. If the user meant "then", stage the ordered `
            + `list (e.g. ${JSON.stringify([...targetWords((holder.value as Obj).target), ...kept.filter((w) => !targetWords((holder.value as Obj).target).includes(w))])}); `
            + `only if the user explicitly withdrew it, retract \`${holder.id}\` and stage the rule again. `
            + 'It was NOT staged.' });
          return;
        }
      }
      if (same && key === 'contributions' && same.identity === identity) {
        // ⚠️ A FLOOR IS STATED ONCE, IN ONE UNIT (review blocker 3). "Keep nine
        // months" then "actually keep $50,000" merged into a rule carrying BOTH,
        // which the executor refuses — taking the whole floor, debt order and
        // "invest the rest" with it. Setting one unit clears the other, exactly as
        // Memory V2's `amend` swaps mutually exclusive fields.
        const nv = value as Obj; const sv = { ...(same.value as Obj) };
        if (nv.liquidFloor !== undefined) delete sv.liquidFloorMonthsOfExpenses;
        if (nv.liquidFloorMonthsOfExpenses !== undefined) delete sv.liquidFloor;
        same = { ...same, value: sv };
        for (const [f, now] of Object.entries(value as Obj)) {
          const was = (same.value as Obj)[f];
          if (was !== undefined && JSON.stringify(was) !== JSON.stringify(now)) {
            replacedFields.push({ id: same.id, field: f, was, now });
          }
        }
        value = { ...(same.value as Obj), ...(value as Obj) };
        if (IDENTITY[key](value) !== identity) {
          refused.push({ input: name, reason: 'merged into the staged rule it would state two bases '
            + 'at once; retract the staged rule first, and it was NOT staged.' });
          return;
        }
      }
      if (same && key !== 'contributions' && same.identity === identity
        && JSON.stringify(same.value) !== JSON.stringify(value)) {
        // Every key reports a restatement, not only contributions (review).
        replacedFields.push({ id: same.id, field: '(whole rule)', was: same.value, now: value });
      }
      const clause: PendingClause = same
        ? { ...same, identity, value, stagedAt: ctx.turn }
        : { id: `p${next}`, key, identity, value, stagedAt: ctx.turn };

      const candidate = same
        ? clauses.map((c) => (c.id === same.id ? clause : c))
        : [...clauses, clause];
      if (candidate.length > MAX_PENDING_CLAUSES) {
        refused.push({ input: name, reason: `at most ${MAX_PENDING_CLAUSES} conditions can be held `
          + 'before a scenario runs; run it, or retract one. This one was NOT staged.' });
        return;
      }
      if (bytesOf({ ...plan, clauses: candidate }) > MAX_PENDING_BYTES) {
        refused.push({ input: name, reason: 'the staged conditions would be too large to carry; run '
          + 'the scenario, or retract one. This one was NOT staged.' });
        return;
      }
      if (!same) next += 1;
      clauses = candidate;
      staged.push(clause.id);
    });
  }
  return { plan: { v: 1, clauses, next }, staged, retracted, refused, replacedFields };
}

// ── Merge into an execution, and consume ─────────────────────────────────────

export interface Attribution {
  id: string;
  key: string;
  /** Always EARLIER_IN_CONVERSATION: nothing else may enter this state. */
  source: 'EARLIER_IN_CONVERSATION';
  stagedAt: number;
}

export interface MergeResult {
  args: Record<string, unknown>;
  /** Staged clauses laid into the arguments, with the exact object each became. */
  applied: (Attribution & { value: unknown })[];
  /**
   * Staged clauses this call SUPERSEDED — it states the same rule, or another rule
   * about the same subject — and which therefore did not run. Said, never silent.
   */
  supersededByCall: { id: string; key: string }[];
}

/**
 * The call's arguments with the staged clauses added, where the call has not
 * restated them.
 *
 * ⚠️ THE CALL WINS, AND THE REASON IS THE STATE MACHINE (review blocker 1). The
 * first version let the staged clause win, on the theory that a model re-running a
 * scenario copies stale arguments forward from the envelope. But staging is refused
 * once a scenario has run, so whenever a plan is non-empty NO envelope exists to
 * copy from — the call's items are this turn's words, and this turn is newer than
 * anything staged. Measured before the fix: staged "up 10%", then "actually 15%",
 * called with 1.15 — and it RAN AT 1.1 while the echo credited the 1.1 as the
 * user's newer statement.
 *
 * ⚠️ "THE SAME RULE" INCLUDES "THE SAME SUBJECT". A staged raise on every income
 * and a called raise on the salary, from different dates, are both about the rate
 * of that income; running both compounded them (×1.21). A staged clause is
 * superseded by any call item with its identity, or with an overlapping subject.
 *
 * ⚠️ APPENDED IN THE ORDER STATED, because the income primitive applies rules in
 * array order and order changes the answer.
 */
export function mergeIntoArgs(plan: PendingPlan, args: Record<string, unknown>): MergeResult {
  const out: Record<string, unknown> = { ...args };
  const applied: MergeResult['applied'] = [];
  const supersededByCall: MergeResult['supersededByCall'] = [];
  const ordered = [...plan.clauses].sort((a, b) => a.stagedAt - b.stagedAt || a.id.localeCompare(b.id));

  for (const c of ordered) {
    if (isArrayKey(c.key)) {
      const callItems = Array.isArray(args[c.key]) ? args[c.key] as unknown[] : [];
      const mySubject = subjectOf(c.key, c.value);
      const restated = callItems.some((item) => {
        if (IDENTITY[c.key]?.(item) === c.identity) return true;
        const theirs = subjectOf(c.key, item);
        return mySubject !== null && theirs !== null && scopesOverlap(mySubject, theirs);
      });
      if (restated) { supersededByCall.push({ id: c.id, key: c.key }); continue; }
      out[c.key] = [...(Array.isArray(out[c.key]) ? out[c.key] as unknown[] : []), c.value];
    } else {
      if (args[c.key] !== undefined) { supersededByCall.push({ id: c.id, key: c.key }); continue; }
      out[c.key] = c.value;
    }
    applied.push({ id: c.id, key: c.key, source: 'EARLIER_IN_CONVERSATION', stagedAt: c.stagedAt, value: c.value });
  }
  return { args: out, applied, supersededByCall };
}

/** Is this value a plan this module produced? Structural, for the seal's reader. */
export function isPendingPlan(v: unknown): v is PendingPlan {
  if (!v || typeof v !== 'object') return false;
  const p = v as Obj;
  const keys = new Set(scenarioAssumptionKeys());
  return p.v === 1 && typeof p.next === 'number' && Array.isArray(p.clauses)
    && p.clauses.length <= MAX_PENDING_CLAUSES
    && JSON.stringify(p.clauses).length <= MAX_PENDING_BYTES
    && (p.clauses as unknown[]).every((c) => {
      const x = o(c);
      return typeof x.id === 'string' && typeof x.identity === 'string' && typeof x.stagedAt === 'number'
        && typeof x.key === 'string' && keys.has(x.key) && x.value !== undefined
        && IDENTITY[x.key]?.(x.value) === x.identity;
    });
}

// ── What the model reads ─────────────────────────────────────────────────────

/**
 * ⚠️ A MARKER THAT SAYS WHAT THIS IS AND IS NOT, AND NOTHING ABOUT WHAT TO DO. It
 * sits beside the ACTIVE SCENARIO marker and must never be mistaken for it: these
 * clauses have not run, and no figure here is a result.
 */
export const PENDING_MARKER = 'PENDING ASSUMPTIONS (stated in this conversation, not yet run)';

export function pendingMessage(plan: PendingPlan): { role: 'system'; content: string } {
  const body = {
    clauses: plan.clauses.map((c) => ({ id: c.id, [c.key]: c.value })),
    appliesTo: 'the next scenario_projection, scenario_crossing or scenario_goal_seek in this '
      + 'conversation, merged with its arguments; no figure here is a result',
  };
  return { role: 'system', content: `${PENDING_MARKER}\n${JSON.stringify(body)}` };
}

const isPendingMessage = (m: unknown): boolean =>
  typeof (m as { content?: unknown })?.content === 'string'
  && (m as { content: string }).content.startsWith(PENDING_MARKER);

/**
 * Put the pending slot in place — replaced, never appended; removed when empty.
 * Placed immediately BEFORE the active-scenario slot when there is one, so the
 * last thing before the question is still what ran.
 */
export function injectPending(messages: unknown[], plan: PendingPlan | null): unknown[] {
  for (let i = messages.length - 1; i >= 0; i--) if (isPendingMessage(messages[i])) messages.splice(i, 1);
  if (!plan || plan.clauses.length === 0) return messages;
  messages.push(pendingMessage(plan));
  return messages;
}
