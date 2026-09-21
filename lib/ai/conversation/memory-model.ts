/**
 * lib/ai/conversation/memory-model.ts
 *
 * WHAT DURABLE MEMORY CAN MEAN — the semantic classes, their typed fields, and
 * the one reader, one validator, one merger and one renderer every memory
 * surface goes through.
 *
 * ⚠️ THE DEFECT THIS EXISTS FOR. V1 memory could hold a number and a label; users
 * state rules, multipliers and bases. Every admissible V1 intention REQUIRED a
 * number, validation checked that a key was PRESENT rather than that it had a
 * value, and the refusal named the missing key — so the model supplied one. Of
 * 201 recorded `remember` calls not one stored row held the user's rule: six
 * months of expenses became a frozen dollar level (six times one month's measured
 * spending), `amount: 6`, `amount: 0` or `byDate: null`, and one projected net
 * worth became the user's goal.
 *
 * ⚠️ THREE SENTENCES THIS FILE KEEPS TRUE. Memory is not financial truth. Memory
 * is not an active scenario. A scenario is not memory. Nothing here computes a
 * figure, reads a balance, calls a tool or touches the scenario slot.
 *
 * ⚠️ A RULE IS STORED IN THE SCENARIO CONTRACT'S OWN VOCABULARY, imported — never
 * copied — from `scenario-rules.ts`. "Keep six months of expenses, then the
 * highest-APR debt, then invest" is
 * `{liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: [...]}`: the
 * object a `contributions[]` item takes. There is nothing to compile, so there
 * is no compiler to drift; and because `unknownContributionKeys` refuses a whole
 * rule on any foreign key, a stored rule holds EXACTLY contract keys.
 *
 * ⚠️ TWO VALIDATORS, ON PURPOSE.
 *   `validateShape` is TIMELESS: types, closed keys, one basis. It runs on every
 *     read, every write and every merge, so a row that was valid when written is
 *     valid forever — a goal whose date has passed is LAPSED, not unreadable.
 *   `admitWrite` is about THIS CALL: the provenance gate and the future-date
 *     checks, applied only to fields the call itself supplies and never to a
 *     value inherited unchanged from the current version.
 *
 * ⚠️ PURE. No database, no clock, no model, no Prisma import (kinds and statuses
 * are their string values). The store and the tools are the only I/O.
 */

import { extractFigures } from '@/lib/ai/figures';
import {
  CONTRIBUTION_KEYS, ALLOCATION_TARGET_WORDS, unknownContributionKeys, contributionBasis,
  contributionName, isAllocationTargetWord,
} from './scenario-rules';

// ── Classes ──────────────────────────────────────────────────────────────────

export const MEMORY_VERSION = 2;

/** What a user can state. */
export const STATED_CLASSES = ['GOAL', 'PLANNED_EXPENSE', 'RULE', 'BASELINE'] as const;
export type StatedClass = typeof STATED_CLASSES[number];
/** …and the one thing the system observes about itself. Written by code only. */
export type MemoryClass = StatedClass | 'PROJECTION';

export type StoredKind = 'INTENTION' | 'ASSUMPTION' | 'CHECKPOINT';

/** The existing `MemoryKind` each class is stored under. No enum value is added. */
export const KIND_OF_CLASS: Record<MemoryClass, StoredKind> = {
  GOAL: 'INTENTION', PLANNED_EXPENSE: 'INTENTION', RULE: 'INTENTION',
  BASELINE: 'ASSUMPTION', PROJECTION: 'CHECKPOINT',
};

/**
 * The stamp on a remembered planning figure.
 *
 * ⚠️ NEVER `STATED`, `DECLARED` OR `MEASURED`. Those are M1's words for the three
 * rungs of the expense baseline, and a remembered figure is NOT a fourth rung: no
 * resolver reads it and no tool reads it. It reaches a calculation only when the
 * model passes it as an explicit argument in a conversation where the user asked
 * to plan with it.
 */
export const REMEMBERED = 'REMEMBERED';
export const PLANNING_SCOPE = 'PLANNING';

export const GOAL_METRICS = ['netWorth', 'liquid', 'investments', 'debt'] as const;
/** The metrics V1 documented. A legacy goal naming anything else is unreadable. */
const LEGACY_GOAL_METRICS: readonly string[] = ['netWorth', 'liquid', 'investments'];
/**
 * The `intent` words V1 actually documented for a planned outlay — every value
 * that appears in the V1 code, tests and live check (`buy`, `purchase`, `spend`).
 * `intent` was otherwise free text, and in the recorded traces it is where a rule
 * was smuggled ("keep-buffer", "allocation-rule", whole sentences). A legacy
 * `{intent, amount, label}` row is readable only under one of these.
 */
const LEGACY_OUTLAY_INTENTS: readonly string[] = ['buy', 'purchase', 'spend'];

// ── Field types — units are part of the type ─────────────────────────────────

type FieldType = 'Money' | 'Months' | 'Fraction' | 'Percent' | 'ISODate' | 'Metric' | 'Label' | 'Target';

export const MAX_LABEL_CHARS = 40;
export const MAX_WORDS_CHARS = 280;
const SUBJECT = /^[a-z0-9][a-z0-9-]{1,47}$/;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as YYYY-MM-DD, or null. */
export function isoDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DAY.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days ? value : null;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const twoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v));

/** Why `value` is not a `type`, or null when it is. Null, '' and NaN are never values. */
function typeProblem(type: FieldType, value: unknown): string | null {
  switch (type) {
    case 'Money':
      if (!isNumber(value)) return `${show(value)} is not an amount — a money field holds a number of dollars`;
      if (value === 0) return '0 is a placeholder, not an amount. Leave out what the user did not state';
      if (value < 0) return 'a money field holds a positive amount';
      if (value > 1e12 || !twoDecimals(value)) return `${value} is not a dollar amount`;
      return null;
    case 'Months':
      if (!isNumber(value)) return `${show(value)} is not a number of months`;
      return value > 0 && value <= 120 ? null
        : `${value} is not a number of months (more than 0, at most 120). A dollar level is \`liquidFloor\`, and only when the user stated dollars`;
    case 'Fraction':
      if (!isNumber(value)) return `${show(value)} is not a fraction`;
      return value > 0 && value <= 1 ? null
        : `${value} is not a share: use a fraction above 0 and at most 1 (75% is 0.75). A share of 0 is no rule at all`;
    case 'Percent':
      if (!isNumber(value)) return `${show(value)} is not a percentage`;
      return value >= 0 && value <= 100 ? null : `${value} is not a percentage between 0 and 100`;
    case 'ISODate':
      return isoDay(value) ? null : `${show(value)} is not a calendar date (YYYY-MM-DD). Leave a date out when the user gave none`;
    case 'Metric':
      return typeof value === 'string' && (GOAL_METRICS as readonly string[]).includes(value) ? null
        : `${show(value)} is not a measure a goal can name — one of ${GOAL_METRICS.join(', ')}`;
    case 'Label': {
      if (typeof value !== 'string') return `${show(value)} is not a name`;
      const clean = value.replace(/\s+/g, ' ').trim();
      if (clean.length < 1 || clean.length > MAX_LABEL_CHARS) return `a label is a short name, 1–${MAX_LABEL_CHARS} characters`;
      if (!/\p{L}/u.test(clean) || /[_[\]{}"]/.test(clean)) return 'a label is the plain name of the thing ("car", "kitchen remodel")';
      return null;
    }
    case 'Target': {
      const list = Array.isArray(value) ? value : [value];
      if (list.length === 0) return 'an empty target names nowhere for the money to go';
      if (!list.every(isAllocationTargetWord)) {
        return `a remembered target is ${ALLOCATION_TARGET_WORDS.map((w) => `\`${w}\``).join(' or ')}, or an ordered list of them. `
          + 'A liability id is not remembered: ids change when an account is reconnected';
      }
      return new Set(list).size === list.length ? null : 'a target list names each destination once';
    }
  }
}

/** The closed field set of each class. No class has a field that could name a balance. */
const FIELDS: Record<StatedClass, Record<string, FieldType>> = {
  GOAL: { targetMetric: 'Metric', targetAmount: 'Money', byDate: 'ISODate' },
  PLANNED_EXPENSE: { label: 'Label', amount: 'Money', earliest: 'ISODate' },
  // ⚠️ A SUBSET OF `CONTRIBUTION_KEYS`, with the contract's own names and meanings.
  // Not remembered: `amount`+`cadence` and `fractionOfLiquid`+`cadence` (a bare
  // money field beside a rule is where a month count was coerced), `onDate` (a
  // one-off is a planned event, not a standing rule), `label` (non-authoritative:
  // a rule is named by code from its fields), and `{liability: id}` targets.
  RULE: {
    liquidFloorMonthsOfExpenses: 'Months', liquidFloor: 'Money', fractionOfExcess: 'Fraction',
    surplusFraction: 'Fraction', target: 'Target', from: 'ISODate', to: 'ISODate',
  },
  BASELINE: { monthlySpending: 'Money', annualReturnPct: 'Percent' },
};

export const fieldNames = (cls: StatedClass): string[] => Object.keys(FIELDS[cls]);

/**
 * A Money field that has a RELATIONAL sibling — the same clause said as a
 * multiplier. Such a field needs POSITIVE evidence that the user said dollars;
 * otherwise the sibling is what they meant, and the dollars are one month's
 * evaluation of it — the frozen-dollar defect.
 */
const RELATIONAL_SIBLING: Record<string, string> = { liquidFloor: 'liquidFloorMonthsOfExpenses' };

export type Fields = Record<string, unknown>;

export type Verdict = { ok: true } | { ok: false; reason: string; field?: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Keys the model was observed to reach for, mapped to the field that means it —
 * FOR REFUSAL TEXT ONLY. Nothing here is ever accepted or coerced: a table that
 * changed what is stored would be guessing; one that improves the message is
 * diagnostics.
 */
const SYNONYMS: Record<string, string> = {
  monthsOfExpenses: 'liquidFloorMonthsOfExpenses', months: 'liquidFloorMonthsOfExpenses',
  bufferMonths: 'liquidFloorMonthsOfExpenses', cashBufferMonths: 'liquidFloorMonthsOfExpenses',
  cashFloorMonthsOfExpenses: 'liquidFloorMonthsOfExpenses', floorMonths: 'liquidFloorMonthsOfExpenses',
  allocationOrder: 'target', priority: 'target', priorityOrder: 'target', ordering: 'target',
  order: 'target', surplusAllocationOrder: 'target', targets: 'target',
  assumedMonthlySpending: 'monthlySpending', statedMonthlySpending: 'monthlySpending',
};

/** Timeless validation of one class's fields. */
export function validateFields(cls: StatedClass, fields: unknown): Verdict {
  if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
    return { ok: false, reason: `a ${cls} needs at least one field the user stated` };
  }
  const spec = FIELDS[cls];
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);

  if (cls === 'RULE') {
    const foreign = unknownContributionKeys(fields);
    if (foreign.length > 0) {
      const hint = foreign.map((k) => SYNONYMS[k]).find(Boolean);
      return { ok: false, field: foreign[0],
        reason: `\`${foreign.join('`, `')}\` is not a rule field. A rule uses the same fields, with the same meanings, as a `
          + `\`contributions\` item${hint ? ` — for that, \`${hint}\`` : ''}` };
    }
  }
  const unknown = keys.filter((k) => !(k in spec));
  if (unknown.length > 0) {
    const k = unknown[0];
    const canon = SYNONYMS[k] ?? k;
    const home = (STATED_CLASSES as readonly StatedClass[]).find((c) => c !== cls && canon in FIELDS[c]);
    return { ok: false, field: k,
      reason: cls === 'RULE' && (CONTRIBUTION_KEYS as readonly string[]).includes(k)
        ? `\`${k}\` is a scenario field that is not remembered as a standing rule. A rule keeps a cash floor `
          + '(`liquidFloorMonthsOfExpenses`, or `liquidFloor` when the user said dollars) or a share of the monthly surplus (`surplusFraction`)'
        : `\`${k}\` is not a ${cls} field${home ? `. \`${canon}\` belongs to a ${home}, which is its own item` : ''}. `
          + `A ${cls} holds ${Object.keys(spec).map((f) => `\`${f}\``).join(', ')}. Memory never holds a current balance` };
  }
  for (const k of keys) {
    const problem = typeProblem(spec[k], fields[k]);
    // The one zero that is a value: "debt-free" is a debt goal of 0.
    if (problem && !(cls === 'GOAL' && k === 'targetAmount' && fields[k] === 0 && fields.targetMetric === 'debt')) {
      return { ok: false, field: k, reason: `\`${k}\`: ${problem}` };
    }
  }

  const has = (k: string) => fields[k] !== undefined;
  if (cls === 'GOAL') {
    if (!has('targetMetric') || !has('targetAmount')) {
      return { ok: false, reason: 'a goal is a measure and the level the user wants it to reach: `targetMetric` and `targetAmount`. '
        + '`byDate` only if they gave a date. "Keep N months of expenses" is not a goal — it is a `rule`' };
    }
  } else if (cls === 'PLANNED_EXPENSE') {
    if (!has('label') || !has('amount')) {
      return { ok: false, reason: 'a planned expense is what it is for and roughly how much, as the user said: `label` and `amount`. '
        + 'A standing policy with no price is a `rule`, not a planned expense' };
    }
  } else if (cls === 'BASELINE') {
    if (keys.length !== 1) return { ok: false, reason: 'a planning figure is exactly one of `monthlySpending` or `annualReturnPct` — two figures are two items' };
  } else {
    const basis = contributionBasis(fields);
    if (basis !== 'FLOOR' && basis !== 'SURPLUS_SHARE') {
      return { ok: false, reason: has('target') && !has('surplusFraction')
        ? '`target` says where money goes but not what money. Add what the user said: a cash floor '
          + '(`liquidFloorMonthsOfExpenses`) the rest is above, or a share of the monthly surplus (`surplusFraction`)'
        : 'a rule rests on exactly one basis: a cash floor, or a share of the monthly surplus — not both. Two rules are two items' };
    }
    if (basis === 'FLOOR') {
      const floors = Object.keys(RELATIONAL_SIBLING).concat(Object.values(RELATIONAL_SIBLING)).filter(has);
      if (floors.length === 0) return { ok: false, field: 'fractionOfExcess', reason: '`fractionOfExcess` has no floor to be above. State the floor the user gave: `liquidFloorMonthsOfExpenses`' };
      if (floors.length > 1) return { ok: false, field: 'liquidFloor', reason: 'a floor is said once: months of expenses OR dollars, whichever the user said' };
    } else if (has('fractionOfExcess')) {
      return { ok: false, field: 'fractionOfExcess', reason: '`fractionOfExcess` belongs to a cash floor, not to a surplus share' };
    }
    const [from, to] = [isoDay(fields.from), isoDay(fields.to)];
    if (from && to && from > to) return { ok: false, field: 'to', reason: '`to` is before `from`' };
  }
  return { ok: true };
}

// ── Stored payloads ──────────────────────────────────────────────────────────

/** The closed, code-written basis of a recorded projection. */
export const PROJECTION_BASIS_KEYS = ['spendingSource', 'dailyRate', 'monthsAveraged', 'incomeEvents',
  'userAssumptions', 'openingCash'] as const;

/** The payload a class is stored as. `basis`/`scope` on a BASELINE are stamped here, never supplied. */
export function toPayload(cls: StatedClass, fields: Fields): Record<string, unknown> {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (cls === 'RULE') return { v: MEMORY_VERSION, class: cls, rule: clean };
  if (cls === 'BASELINE') return { v: MEMORY_VERSION, class: cls, ...clean, basis: REMEMBERED, scope: PLANNING_SCOPE };
  return { v: MEMORY_VERSION, class: cls, ...clean };
}

/** A retirement marker: when, and in what words, an item was withdrawn. */
export const tombstonePayload = (cls: MemoryClass): Record<string, unknown> =>
  ({ v: MEMORY_VERSION, class: cls, retired: true });

export type ShapeResult =
  | { ok: true; cls: MemoryClass; fields: Fields }
  | { ok: true; cls: MemoryClass; tombstone: true }
  | { ok: false; reason: string };

/** Timeless validation of a STORED V2 payload. Used by every read and every write. */
export function validateShape(payload: unknown): ShapeResult {
  if (!isPlainObject(payload) || payload.v !== MEMORY_VERSION) return { ok: false, reason: 'not a version-2 memory payload' };
  const cls = payload.class;
  const { v: _v, class: _c, ...rest } = payload;
  void _v; void _c;
  if (cls !== 'PROJECTION' && !(STATED_CLASSES as readonly unknown[]).includes(cls)) return { ok: false, reason: `unknown class ${show(cls)}` };
  if (rest.retired === true && Object.keys(rest).length === 1) return { ok: true, cls: cls as MemoryClass, tombstone: true };

  if (cls === 'PROJECTION') {
    const extra = Object.keys(rest).filter((k) => !['metric', 'horizon', 'value', 'basis'].includes(k));
    if (extra.length) return { ok: false, reason: `a projection cannot carry ${extra.join(', ')}` };
    if (typeof rest.metric !== 'string' || !rest.metric) return { ok: false, reason: 'a projection says what it measured' };
    // ⚠️ THE HORIZON IS THE SAFETY PROPERTY: a value without one would be a balance.
    if (!isoDay(rest.horizon)) return { ok: false, reason: 'a projection without a horizon states nothing' };
    if (!isNumber(rest.value)) return { ok: false, reason: 'a projection carries the value it stated' };
    if (rest.basis !== undefined) {
      if (!isPlainObject(rest.basis)) return { ok: false, reason: 'a projection basis is the code-written key set' };
      const foreign = Object.keys(rest.basis).filter((k) => !(PROJECTION_BASIS_KEYS as readonly string[]).includes(k));
      if (foreign.length) return { ok: false, reason: `a projection basis cannot carry ${foreign.join(', ')}` };
    }
    return { ok: true, cls, fields: rest };
  }

  const stated = cls as StatedClass;
  let fields: unknown = rest;
  if (stated === 'RULE') {
    if (Object.keys(rest).length !== 1 || !('rule' in rest)) return { ok: false, reason: 'a RULE payload holds exactly its `rule` clause' };
    fields = rest.rule;
  } else if (stated === 'BASELINE') {
    const { basis, scope, ...measures } = rest;
    if (basis !== REMEMBERED || scope !== PLANNING_SCOPE) return { ok: false, reason: 'a planning figure carries the code-written REMEMBERED / PLANNING stamp' };
    fields = measures;
  }
  const verdict = validateFields(stated, fields);
  return verdict.ok ? { ok: true, cls: stated, fields: fields as Fields } : { ok: false, reason: verdict.reason };
}

// ── Reading a row back — fail closed ─────────────────────────────────────────

/** The part of a stored row the model reads. Structural, so the pure layer needs no Prisma type. */
export interface MemoryRow {
  id: string; kind: string; subject: string; status: string;
  payload: unknown; statedAs: string; statedAt: string;
  appliesFrom: string | null; appliesTo: string | null; supersedesId: string | null;
}

export type ReadMemory =
  | { readable: true; cls: MemoryClass; fields: Fields; legacy: boolean }
  | { readable: false; tombstone: boolean; why: string };

const onlyKeys = (p: Record<string, unknown>, allowed: string[]) => Object.keys(p).every((k) => allowed.includes(k));

/**
 * What a stored row MEANS, or that it cannot be read reliably.
 *
 * ⚠️ EVERY READER GOES THROUGH THIS BUT ONE, WHICH CANNOT. A V2 row is validated
 * by the same function
 * as a write. A row with no `v` was written under V1 and is judged against the
 * contract it was written under, BY VALUE, deterministically:
 *   • `{targetMetric, targetAmount, byDate}` with a V1 metric, a positive amount
 *     and a real date is a GOAL (LAPSED once the date passes);
 *   • `{intent, amount, label[, earliest]}` is a PLANNED_EXPENSE only under one of
 *     the three documented `intent` words, a positive amount and a short label;
 *   • `{metric, horizon, value[, basis]}` is a PROJECTION;
 *   • everything else — nulls, zeros, free-text metrics, a rule squeezed into an
 *     outlay, a standalone V1 assumption — is UNREADABLE.
 * ⚠️ NOTHING IS REINTERPRETED. `amount: 6` is never read as six months; it is
 * simply not rendered as money. Nothing is rewritten and nothing is destroyed:
 * an unreadable row is hidden from the model's line, the starters and the Brief,
 * and shown to its owner with its date and a delete.
 *
 * ⚠️ THE ONE EXCEPTION, NAMED. `reconcile.ts` is held import-free by a source
 * guard, so `readCheckpoint` cannot call this; it reads a projection itself and
 * fails closed the same way. Making the claim literally true would mean
 * loosening that guard, which is a worse trade than a caveat.
 */
export function readMemory(row: Pick<MemoryRow, 'kind' | 'payload'>): ReadMemory {
  const p = row.payload;
  if (!isPlainObject(p)) return { readable: false, tombstone: false, why: 'the payload is not an object' };

  if ('v' in p) {
    const shape = validateShape(p);
    if (!shape.ok) return { readable: false, tombstone: false, why: shape.reason };
    if (KIND_OF_CLASS[shape.cls] !== row.kind) return { readable: false, tombstone: false, why: `a ${shape.cls} is not stored under ${row.kind}` };
    if ('tombstone' in shape) return { readable: false, tombstone: true, why: 'a retirement marker' };
    // Postgres `jsonb` does not keep key order; every reader sees the class's declared order.
    const order = shape.cls === 'PROJECTION' ? [] : Object.keys(FIELDS[shape.cls]);
    const fields = { ...Object.fromEntries(order.filter((k) => k in shape.fields).map((k) => [k, shape.fields[k]])), ...shape.fields };
    return { readable: true, cls: shape.cls, fields, legacy: false };
  }

  const no = (why: string): ReadMemory => ({ readable: false, tombstone: false, why });
  if (row.kind === 'INTENTION') {
    if ('targetMetric' in p || 'targetAmount' in p || 'byDate' in p) {
      if (!onlyKeys(p, ['targetMetric', 'targetAmount', 'byDate'])) return no('a legacy target mixed with other keys');
      if (typeof p.targetMetric !== 'string' || !LEGACY_GOAL_METRICS.includes(p.targetMetric)) return no('the metric is not one V1 documented');
      if (!isNumber(p.targetAmount) || p.targetAmount <= 0) return no('the target is not a positive amount');
      if (!isoDay(p.byDate)) return no('the date is not a calendar date');
      return { readable: true, cls: 'GOAL', legacy: true,
        fields: { targetMetric: p.targetMetric, targetAmount: p.targetAmount, byDate: p.byDate } };
    }
    if (!onlyKeys(p, ['intent', 'amount', 'label', 'earliest'])) return no('not a documented V1 shape');
    if (typeof p.intent !== 'string' || !LEGACY_OUTLAY_INTENTS.includes(p.intent)) return no('the intent is not a documented planned outlay');
    if (!isNumber(p.amount) || p.amount <= 0) return no('the amount is not a positive amount');
    const label = typeof p.label === 'string' ? p.label.replace(/\s+/g, ' ').trim() : '';
    if (label.length < 1 || label.length > MAX_LABEL_CHARS) return no('the label is not a short name');
    if (p.earliest !== undefined && !isoDay(p.earliest)) return no('`earliest` is not a calendar date');
    return { readable: true, cls: 'PLANNED_EXPENSE', legacy: true,
      fields: { label, amount: p.amount, ...(p.earliest !== undefined ? { earliest: p.earliest } : {}) } };
  }
  if (row.kind === 'CHECKPOINT') {
    if (typeof p.metric !== 'string' || !p.metric) return no('the checkpoint does not say what it measured');
    if (!isoDay(typeof p.horizon === 'string' ? p.horizon.slice(0, 10) : p.horizon)) return no('the checkpoint carries no horizon');
    if (!isNumber(p.value)) return no('the checkpoint carries no value');
    return { readable: true, cls: 'PROJECTION', legacy: true,
      fields: { metric: p.metric, horizon: (p.horizon as string).slice(0, 10), value: p.value,
        ...(isPlainObject(p.basis) ? { basis: p.basis } : {}) } };
  }
  return no('a standalone V1 assumption has no V2 reading');
}

// ── State — one definition for every reader ──────────────────────────────────

export type MemoryState = 'IN_FORCE' | 'STALE' | 'NOT_YET' | 'LAPSED' | 'SETTLED' | 'SUPERSEDED' | 'RETIRED';

/** A planning figure older than this is shown as stale. Displayed, never enforced. */
export const BASELINE_STALE_AFTER_DAYS = 180;

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Derived, never stored. `today` is YYYY-MM-DD. */
export function stateOf(
  row: Pick<MemoryRow, 'status' | 'statedAt' | 'appliesFrom' | 'appliesTo'>,
  read: Extract<ReadMemory, { readable: true }>, today: string,
): MemoryState {
  if (row.status === 'SUPERSEDED') return 'SUPERSEDED';
  if (row.status !== 'ACTIVE') return 'RETIRED';
  const until = isoDay(row.appliesTo?.slice(0, 10));
  if (until && until < today) return 'LAPSED';
  const starts = isoDay(row.appliesFrom?.slice(0, 10));
  if (read.cls === 'PROJECTION') return (read.fields.horizon as string) < today ? 'SETTLED' : 'IN_FORCE';
  if (read.cls === 'GOAL' && typeof read.fields.byDate === 'string' && read.fields.byDate < today) return 'LAPSED';
  if (read.cls === 'RULE' && typeof read.fields.to === 'string' && read.fields.to < today) return 'LAPSED';
  if (starts && starts > today) return 'NOT_YET';
  if (read.cls === 'BASELINE' && daysBetween(row.statedAt.slice(0, 10), today) > BASELINE_STALE_AFTER_DAYS) return 'STALE';
  return 'IN_FORCE';
}

// ── Words — one renderer ─────────────────────────────────────────────────────

const amountWords = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const METRIC_WORDS: Record<string, string> = { netWorth: 'net worth', liquid: 'cash', investments: 'investments', debt: 'debt' };
const TARGET_WORDS: Record<string, string> = { investments: 'investments', highest_apr: 'the highest-APR debt' };
const shareWords = (f: number) => (f === 1 ? 'all' : `${Math.round(f * 1000) / 10}%`);

function targetWords(target: unknown): string {
  const list = (Array.isArray(target) ? target : [target]).map((t) => TARGET_WORDS[String(t)] ?? String(t));
  return list.length === 1 ? list[0] : `${list[0]} first, then ${list.slice(1).join(', then ')}`;
}

/**
 * An item as one plain sentence, from its FIELDS — never from `statedAs`, which
 * is the model's paraphrase and has carried scenario language into this table.
 * A rule's clause is named by the contract's own namer (`contributionName`), so
 * memory and a scenario echo describe the same rule in the same words.
 */
export function describeMemory(cls: MemoryClass, f: Fields): string {
  switch (cls) {
    case 'GOAL':
      return f.targetMetric === 'debt' && f.targetAmount === 0
        ? `Be debt-free${f.byDate ? ` by ${f.byDate}` : ''}.`
        : `Reach ${amountWords(f.targetAmount as number)} of ${METRIC_WORDS[String(f.targetMetric)] ?? f.targetMetric}${f.byDate ? ` by ${f.byDate}` : ''}.`;
    case 'PLANNED_EXPENSE':
      return `A planned expense: ${f.label}, about ${amountWords(f.amount as number)}${f.earliest ? `, not before ${f.earliest}` : ''}.`;
    case 'BASELINE':
      return f.monthlySpending !== undefined
        ? `Plan with ${amountWords(f.monthlySpending as number)} a month of spending — a planning figure they gave, not their measured spending.`
        : `Plan with a ${f.annualReturnPct}% annual return — a planning figure they gave, not an observed return.`;
    case 'PROJECTION':
      return `We projected ${amountWords(f.value as number)} of ${METRIC_WORDS[String(f.metric)] ?? f.metric} for ${f.horizon}.`;
    case 'RULE': {
      const where = f.target !== undefined ? targetWords(f.target) : null;
      const window = `${f.from ? `, from ${f.from}` : ''}${f.to ? `, until ${f.to}` : ''}`;
      if (f.surplusFraction !== undefined) {
        return `Each month move ${shareWords(f.surplusFraction as number)} of the month's surplus to ${where ?? 'investments'} `
          + `(${contributionName(f)})${window}.`;
      }
      const floor = f.liquidFloorMonthsOfExpenses !== undefined
        ? `${f.liquidFloorMonthsOfExpenses} months of expenses` : amountWords(f.liquidFloor as number);
      const excess = f.fractionOfExcess !== undefined
        ? `; each month-end move ${shareWords(f.fractionOfExcess as number)} of the ${contributionName(f)}${where ? ` to ${where}` : ''}`
        : where ? `; what is above it goes to ${where} (the share was not stated)` : ' (what happens to the rest was not stated)';
      return `Keep ${floor} in cash${excess}${window}.`;
    }
  }
}

// ── Amendment — field-wise, whole rule re-validated ──────────────────────────

export interface FieldChange { field: string; from: unknown; to: unknown }

export type MergeResult =
  | { ok: true; fields: Fields; changed: FieldChange[]; kept: Fields }
  | { ok: false; reason: string; wouldRemain: Fields };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merge `set` / `unset` onto the current version, then validate the WHOLE result.
 *
 * ⚠️ MUTUALLY EXCLUSIVE FIELDS SWAP RATHER THAN ACCUMULATE, and which fields
 * exclude each other is the CONTRACT'S answer, not a table kept here: a rule has
 * one basis (`contributionBasis`), so setting a member of another basis removes
 * the fields of the current one; a floor is said once (months or dollars); a
 * planning figure is one measure.
 */
export function mergeAmend(cls: StatedClass, current: Fields, set: Fields = {}, unset: readonly string[] = []): MergeResult {
  const merged: Fields = { ...current };
  for (const k of unset) delete merged[k];
  const setKeys = Object.keys(set).filter((k) => set[k] !== undefined);

  if (cls === 'RULE') {
    const stated = contributionBasis(set);
    for (const k of Object.keys(merged)) {
      if (k in set) continue;
      const own = contributionBasis({ [k]: merged[k] });
      const swappedFloor = setKeys.some((s) => RELATIONAL_SIBLING[s] === k || RELATIONAL_SIBLING[k] === s);
      if (swappedFloor || (stated !== 'UNDETERMINED' && own !== 'UNDETERMINED' && own !== stated)) delete merged[k];
    }
  } else if (cls === 'BASELINE' && setKeys.length > 0) {
    for (const k of Object.keys(merged)) if (!(k in set)) delete merged[k];
  }
  for (const k of setKeys) merged[k] = set[k];

  const verdict = validateFields(cls, merged);
  if (!verdict.ok) {
    return { ok: false, wouldRemain: merged,
      reason: `${verdict.reason}. That change would leave ${JSON.stringify(merged)}. Retire the whole item, or set what replaces it in the same call` };
  }
  const changed: FieldChange[] = [];
  for (const k of new Set([...Object.keys(current), ...Object.keys(merged)])) {
    if (!same(current[k], merged[k])) changed.push({ field: k, from: current[k] ?? null, to: merged[k] ?? null });
  }
  const kept = Object.fromEntries(Object.entries(merged).filter(([k, v]) => same(current[k], v)));
  return { ok: true, fields: merged, changed, kept };
}

/** Fields the current version holds that a full re-statement would silently lose. */
export function droppedFields(current: Fields, next: Fields): string[] {
  return Object.keys(current).filter((k) => next[k] === undefined);
}

// ── Provenance — a figure we produced is not something the user stated ───────

/**
 * What one turn knows about who said what.
 *
 * ⚠️ `userTexts` IS PASSED IN EXPLICITLY BY THE TURN'S CALLER — the conversation's
 * user turns and nothing else. It is NEVER derived from the transcript: the
 * financial orientation rides in as a `role: 'user'` message and the active
 * scenario as a trailing `role: 'system'` one, so "the user messages" of a
 * transcript include every balance we hold. `ours()` is everything else: the
 * orientation, the scenario envelope, assistant prose, and this turn's tool
 * results including their string leaves.
 */
export interface TurnEvidence {
  userTexts: readonly string[];
  ours: () => readonly unknown[];
}

/**
 * The evidence for one turn, from the explicit user texts and the live transcript.
 *
 * ⚠️ `messages` IS READ FOR WHAT IS *OURS* ONLY. A `role: 'user'` message counts
 * as the user's only when its content is one of the explicit `userTexts`; the
 * orientation is a `role: 'user'` message too and is ours. `ours()` is lazy, so a
 * `remember` call sees the tool results that landed earlier in the same turn. A
 * memory write's own echo (`{"stored": …`) is left out: a refusal hands the
 * caller's payload back, and that echo must not become the reason the retry is
 * refused.
 */
export function turnEvidence(userTexts: readonly string[], messages: readonly unknown[]): TurnEvidence {
  const stated = new Set(userTexts);
  return {
    userTexts,
    ours: () => {
      const out: unknown[] = [];
      for (const raw of messages) {
        const m = raw as { role?: string; content?: unknown };
        if (typeof m?.content !== 'string' || !m.content) continue;
        if (m.role === 'user' && stated.has(m.content)) continue;
        if (m.role === 'tool' && m.content.startsWith('{"stored":')) continue;
        out.push(m.content);
      }
      return out;
    },
  };
}

const EPS = 1e-9;

/**
 * How close a stored figure must be to what the user said: half a cent. EXACTLY,
 * not "a faithful rounding of".
 *
 * ⚠️ THE TOLERANCE RAN THE WRONG WAY, AND IT REOPENED THE DEFECT THE GATE EXISTS
 * FOR. The first implementation reused the Brief licence's rule,
 * `min(writtenUnit, max(1, 3%))`. That rule is right for the licence, which asks
 * whether ROUNDED PROSE is a fair rendering of a PRECISE figure code computed.
 * Memory asks the mirror question — and the mirror of "may prose round our
 * figure?" is not "may a stored figure be a rounding of what was said?", it is
 * "did they say THIS figure?". Run the wrong way round, a user loosely echoing
 * our own number licensed our number, to the cent: "so about 270k?" admitted the
 * projection's 271,433.12 as their goal, "$300k" admitted 295,000, "1.2m"
 * admitted 1,230,000, and "so keep about 36k?" admitted a derived $35,739.18
 * cash floor — the original frozen-dollar defect, reached through an echo. A
 * stored figure may be no more precise than the words it came from: the model
 * stores 270000, or asks.
 */
const SAID_EXACTLY = 0.005;

/**
 * The number words a COUNT may be spoken in. Closed, and bounded by the type it
 * serves (`Months`: 0 < n ≤ 120). Months are the one quantity users habitually
 * say in words — "keep six months of expenses" — so digits alone would refuse
 * the product's central sentence.
 */
const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20,
  'twenty-four': 24, 'twenty four': 24, thirty: 30, 'thirty-six': 36, 'thirty six': 36,
  forty: 40, 'forty-eight': 48, 'forty eight': 48, sixty: 60,
};

/** The shares a user states in words. "All of it" is not here — see `userStated`. */
const FRACTION_WORDS: Record<string, number> = {
  half: 0.5, quarter: 0.25, third: 1 / 3, 'two thirds': 2 / 3, 'three quarters': 0.75,
};

/**
 * The user's words with everything that is not a stated amount blanked out.
 *
 * ⚠️ A FRAGMENT OF A NUMBER IS NOT A NUMBER. Scanned raw, "5 000" offered a `5`
 * (stored as $5 a month) and "06/30/2027" offered a `30` (stored as a $30 planned
 * expense). A digit group belonging to a larger number or to a date licenses
 * NOTHING — neither the fragment nor the whole, because which was meant is a
 * guess, and a guess is what this gate refuses to make.
 */
function maskNonAmounts(text: string): string {
  return text
    // ⚠️ THE GUARDS MATTER AS MUCH AS THE PATTERN. Without them this very mask cut
    // "200-1" out of the middle of "$1,200-1,500", leaving "$1" — a fragment it
    // had itself created, and one that licensed a $1 planning figure.
    .replace(/(?<![\d,])\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?(?![\d,])/g, ' ')  // 06/30/2027 · 2027-06-30 · 6-12
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')                                    // clock times
    .replace(/(?<![\d,])\d{1,3}(?:\s+\d{3})+(?![\d,])/g, ' ');              // "5 000"
}

/** What the user's own words state, by the kind of quantity each is. */
interface StatedAmounts { money: number[]; counts: number[]; fractions: number[]; percents: number[] }

const matchesWord = (words: string, word: string) => new RegExp(`(?<![a-z])${word}(?![a-z])`).test(words);

/**
 * The amounts in the user's own turns — digits, plus a closed word list for the
 * two quantities people say in words rather than figures: how many months, and
 * how much of the rest.
 *
 * ⚠️ MONEY IS THE LICENCE'S DEFINITION OF A FIGURE AND NOTHING ELSE: a currency
 * mark, a k/m suffix, thousands grouping, decimals, a spelled currency word, or a
 * bare integer of 1,000 or more that is not a year (`extractFigures`). A bare
 * SMALL integer is a count — "keep 6 months", "make it 9", "3 cards" — and the
 * V1 corpus is what that rule is for: every coerced row in it was a count
 * standing in a money field, and after a months statement "make it 9" still
 * licensed `monthlySpending: 9`. The cost is that "a bike for 800" must be said
 * as "$800" or "800 dollars"; the refusal says exactly that, and costs one turn.
 */
function statedAmounts(texts: readonly string[]): StatedAmounts {
  const out: StatedAmounts = { money: [], counts: [], fractions: [], percents: [] };
  for (const raw of texts) {
    const text = maskNonAmounts(raw);
    for (const f of extractFigures(text)) {
      if (f.kind === 'PERCENT') { out.percents.push(f.value); out.fractions.push(f.value / 100); }
      else out.money.push(f.value);
    }
    // A figure the licence cannot see, because it carries no mark of its own.
    for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|usd|bucks)\b/gi)) {
      const n = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(n)) out.money.push(n);
    }
    for (const m of text.matchAll(/(?<![\w.,$])(\d{1,3})(?![\w]|[.,]\d)/g)) out.counts.push(Number(m[1]));
    for (const m of text.matchAll(/(?<![\w.,$])(0?\.\d+)(?![\w])/g)) out.fractions.push(Number(m[1]));
    const words = raw.toLowerCase();
    for (const [word, n] of Object.entries(COUNT_WORDS)) if (matchesWord(words, word)) out.counts.push(n);
    for (const [word, n] of Object.entries(FRACTION_WORDS)) if (matchesWord(words, word)) out.fractions.push(n);
  }
  // "Assume 7" answers "what return should I plan on?" as surely as "7%" does.
  out.percents.push(...out.counts);
  return out;
}

/** Every number in what WE produced: JSON numbers, JSON inside strings, and figures in prose. */
export function producedNumbers(ours: readonly unknown[]): number[] {
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') { if (Number.isFinite(v)) out.push(Math.abs(v)); return; }
    if (typeof v === 'string') {
      // The orientation and the scenario envelope are a marker line, then JSON.
      const brace = v.search(/[{[]/);
      if (brace >= 0 && brace <= 80) {
        try { walk(JSON.parse(v.slice(brace))); return; } catch { /* prose */ }
      }
      for (const f of extractFigures(v)) if (f.kind !== 'PERCENT') out.push(f.value);
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  ours.forEach(walk);
  return out;
}

/** The unit a stored value was written at: its decimals, else its trailing zeros. */
function writtenUnit(v: number): number {
  if (!Number.isInteger(v)) return twoDecimals(v * 10) ? 0.1 : 0.01;
  const s = String(Math.abs(v));
  return 10 ** Math.min(s.match(/0+$/)?.[0].length ?? 0, Math.max(s.length - 1, 0));
}

/**
 * Is `v` a faithful rounding of something we produced?
 *
 * ⚠️ THIS ONE MAY BE LOOSE, BECAUSE IT ONLY CHOOSES THE SENTENCE. A value reaches
 * it having already failed to be licensed, so the question is no longer whether
 * to refuse but whether to say "that is our figure" or "nobody said that".
 */
function producedByUs(v: number, produced: readonly number[]): boolean {
  const unit = writtenUnit(v);
  return produced.some((o) => Math.abs(v - o) < Math.min(unit, Math.max(1, 0.03 * o)) + EPS);
}

/** The numeric types a value must be STATED in, not merely be well-formed as. */
const GATED_TYPES: readonly FieldType[] = ['Money', 'Months', 'Fraction', 'Percent'];

/** Did the user state `v`, read as a `type`? Exactly — to half a cent. */
function userStated(type: FieldType, v: number, said: StatedAmounts): boolean {
  const near = (xs: readonly number[]) => xs.some((x) => Math.abs(v - x) < SAID_EXACTLY);
  switch (type) {
    case 'Money':   return near(said.money);
    case 'Months':  return near(said.counts);
    case 'Percent': return near(said.percents);
    // ⚠️ ONE SHARE NEEDS NO FIGURE: ALL OF IT. "…and then invest" says where the
    // rest goes while holding nothing back, and the contract documents that share
    // as `1` ("the rest" = 1) — it is the absence of a share, not a number we
    // could have produced. Every other share is a figure and is held to the words.
    case 'Fraction': return v === 1 || near(said.fractions);
    default: return true;
  }
}

/**
 * Did the user's own words state this figure, as this kind of quantity?
 *
 * ⚠️ THE ONE PROVENANCE AUTHORITY, SHARED — not a second copy. The pending
 * planning state (`pending-plan.ts`) holds conditions the user stated for a
 * calculation that has not yet run, and a figure may enter it on exactly the terms
 * a figure may enter durable memory: the user said THIS figure, to half a cent.
 * A tool-derived number, a remembered number the user did not restate, and a loose
 * echo of our own projection are refused by the same rule in both places, because
 * two gates would drift and the looser one would become the laundering path.
 */
export type GatedFigure = 'Money' | 'Months' | 'Fraction' | 'Percent';
export function userStatedFigure(type: GatedFigure, value: number, evidence: TurnEvidence): boolean {
  return userStated(type, Math.abs(value), statedAmounts(evidence.userTexts));
}

/** What to tell a caller whose figure nobody stated. */
function notStated(type: FieldType, field: string, v: number): string {
  switch (type) {
    case 'Months':
      return `the user has not said ${v} in this conversation. \`${field}\` is a number of months, and memory keeps the `
        + 'number they gave — never a figure we worked out, such as how many months their cash currently covers';
    case 'Fraction':
      return `the user has not stated a share of ${v}. Record the share they said ("half" is 0.5, "the rest" is 1), or leave `
        + 'the clause out — a share we calculated is not a rule they set';
    case 'Percent':
      return `the user has not stated ${v}% in this conversation. A rate they asked to plan with is theirs to say; an observed `
        + 'or computed rate is not a planning figure';
    default:
      return `the user has not stated ${v} as an amount in this conversation. Memory holds money only in figures they gave, `
        + 'written as money — with a currency mark, a k/m suffix, thousands grouping, decimals, or the currency named in words. '
        + 'A bare small number is a count, not an amount. If the figure is theirs, ask them to say it; if what they said was a '
        + 'multiple or a rule, record that instead';
  }
}

export interface AdmitArgs {
  cls: StatedClass;
  /** ONLY the fields this call itself supplies (a record's fields, or an amend's `set`). */
  supplied: Fields;
  /** The current version's fields. A supplied value equal to one of these is inherited, not new. */
  current?: Fields | null;
  /** Null when the write path carries no conversation evidence: a figure then cannot be checked. */
  evidence: TurnEvidence | null;
  /** The conversation's clock, YYYY-MM-DD. */
  asOf: string;
}

/**
 * May THIS CALL write these values? The provenance gate and the future-date
 * checks — never applied to a field the call did not supply, and never to a
 * value equal to the current version's, so an amendment cannot re-gate what it
 * inherited.
 *
 * ⚠️ THE GATE: MEMORY ADMITS A FIGURE ONLY IN THE TERMS THE USER STATED IT.
 * Every new money amount, month count, share and rate must appear in the
 * conversation's user turns, read as that kind of quantity and matched exactly.
 * What we produced — the orientation's balances, the scenario envelope, our own
 * prose, this turn's tool results — licenses nothing; it only sharpens the
 * refusal ("a figure we produced" rather than "nobody said it").
 *
 * ⚠️ WHY POSITIVE EVIDENCE, NOT "REFUSE WHAT WE RECOGNISE". The design's first
 * gate refused only a value matching one of OUR figures. Replayed over the 201
 * recorded calls it still stored `amount: 6` for "I want six months cash" and
 * `amount: 9` for "use nine": a count spoken in words is found nowhere, so
 * nothing refused it. And the types beyond money were not gated at all, so our
 * own `coverageMonths: 3.1` and a computed `annualReturnPct: 12.34` were
 * admissible as the user's rule. The cost is a user who says "a million" in
 * words being asked for the number once; that is recoverable, and a figure we
 * invented for them is not.
 */
export function admitWrite(a: AdmitArgs): Verdict {
  const spec = FIELDS[a.cls];
  let said: StatedAmounts | null = null;
  let produced: number[] | null = null;

  for (const [field, value] of Object.entries(a.supplied)) {
    if (value === undefined || (a.current && same(a.current[field], value))) continue;
    const type = spec[field];

    if (type === 'ISODate' && (field === 'byDate' || field === 'to')) {
      const day = isoDay(value);
      if (day && day <= a.asOf.slice(0, 10)) {
        return { ok: false, field, reason: `\`${field}\` ${day} is not in the future (today is ${a.asOf.slice(0, 10)}). Leave the date out if the user gave none` };
      }
    }
    if (!GATED_TYPES.includes(type) || !isNumber(value) || value === 0) continue;

    if (!a.evidence) {
      return { ok: false, field, reason: 'this write path has no conversation evidence, so a figure cannot be checked against what the user said' };
    }
    said ??= statedAmounts(a.evidence.userTexts);
    if (userStated(type, value, said)) continue;

    produced ??= producedNumbers(a.evidence.ours());
    const sibling = RELATIONAL_SIBLING[field];
    return { ok: false, field,
      reason: sibling
        ? `the user did not state ${value} in dollars. A floor they gave as months of expenses is \`${sibling}\` — `
          + `the multiplier, never the dollars it works out to today. Use \`${field}\` only for a dollar level they said themselves`
        : producedByUs(value, produced)
          ? `${value} is a figure we produced — it is in this conversation's results or our own prose, and the user never stated it. `
            + 'A figure we computed is not theirs to have remembered. Record only a number they said; if they want this one, ask them to say it'
          : notStated(type, field, value) };
  }
  return { ok: true };
}
// ── Refusals that teach ──────────────────────────────────────────────────────

export const EXAMPLES: Record<StatedClass, Record<string, unknown>> = {
  // ⚠️ A FLOOR ALONE, ON PURPOSE. The first live run stored `fractionOfExcess` and a
  // debt-first `target` for a user who had said only "keep six months of expenses in
  // cash" — copied from a three-clause example. An example is a template.
  RULE: { subject: 'cash-buffer', statedAs: 'Keep six months of expenses in cash', rule: { liquidFloorMonthsOfExpenses: 6 } },
  BASELINE: { subject: 'planning-spending', statedAs: 'Use $5k monthly spending for planning', baseline: { monthlySpending: 5000 } },
  GOAL: { subject: 'net-worth-target', statedAs: 'I want $1M of net worth by the end of 2030',
    goal: { targetMetric: 'netWorth', targetAmount: 1000000, byDate: '2030-12-31' } },
  PLANNED_EXPENSE: { subject: 'car', statedAs: 'a car, around $20k', plannedExpense: { label: 'car', amount: 20000 } },
};

export const SHAPE_KEY: Record<StatedClass, string> = {
  GOAL: 'goal', PLANNED_EXPENSE: 'plannedExpense', RULE: 'rule', BASELINE: 'baseline' };

/**
 * The shape the caller APPEARS to have meant, built from their own payload —
 * what a refusal hands back instead of a list of missing keys. The measured
 * mechanism of the V1 defect was the refusal itself: "an INTENTION needs intent +
 * amount + label" is the sentence that produced `amount: 0`.
 *
 * ⚠️ DIAGNOSTIC ONLY. Nothing built here is ever stored; the caller must send it.
 */
export function expectedFrom(raw: unknown): Record<string, unknown> | null {
  const rule: Fields = {};
  const baseline: Fields = {};
  const visit = (o: unknown, depth: number): void => {
    if (!isPlainObject(o) || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      const canon = SYNONYMS[k] ?? k;
      if (canon === 'liquidFloorMonthsOfExpenses' && isNumber(v) && v > 0 && v <= 120) rule[canon] ??= v;
      else if ((canon === 'fractionOfExcess' || canon === 'surplusFraction') && isNumber(v) && v > 0 && v <= 1) rule[canon] ??= v;
      else if (canon === 'target' && typeProblem('Target', v) === null) rule.target ??= v;
      else if (canon === 'monthlySpending' && isNumber(v) && v > 0) baseline.monthlySpending ??= v;
      else if (isPlainObject(v)) visit(v, depth + 1);
      else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    }
  };
  visit(raw, 0);
  const out: Record<string, unknown> = {};
  if (Object.keys(rule).length && validateFields('RULE', rule).ok) out.rule = rule;
  if (Object.keys(baseline).length) out.baseline = baseline;
  return Object.keys(out).length ? out : null;
}

export const validSubject = (s: unknown): s is string => typeof s === 'string' && SUBJECT.test(s);

// ── The memory line — sent on every request, so bytes are budgeted ───────────

export const LINE_CAPS = { goals: 3, rules: 3, planningAssumptions: 2, planned: 3, horizons: 6 } as const;

/** How a rule appears in the line: its literal clause, or one plain sentence (the clause is then in `recall`). */
export type RuleRendering = 'clause' | 'sentence';

/**
 * How the PRODUCTION line shows a rule. `clause` is the faithful form — the
 * fields ARE the arguments, so "run my remembered strategy" is a copy rather
 * than a parse — but a literal clause on every request could prime the model to
 * apply it unasked. Which one ships is decided by measurement, recorded in
 * docs/plans/AI-FINANCIAL-MEMORY-V2-DESIGN.md (ruling R6), not by preference.
 */
export const MEMORY_LINE_RULES: RuleRendering = 'clause';

export const LINE_MEANING =
  'Remembered for this user, as stated on the dates shown. Nothing listed is in effect and none of it is a current '
  + 'figure. Use one only as explicit tool arguments, and say it was remembered.';

export const LINE_EMPTY =
  'Nothing has been remembered for this user yet. When they ask you to remember a goal, a plan, a standing rule or a '
  + 'planning figure — or change one — record it with `remember`.';

/**
 * Said ONCE, and only when a planning figure is listed.
 *
 * ⚠️ MEASURED, THEN ADDED. With the per-item sentence alone, "what will my cash be
 * next June?" in a fresh chat applied the remembered figure 4/6 — called "what you
 * asked us to plan with", with no word that it came from an earlier conversation
 * and no measured figure beside it — and answered on measured evidence 2/6 without
 * saying a planning figure existed.
 */
export const PLANNING_NOTE =
  'Unless they ask to use a planning figure, answer on measured evidence and mention that the figure is available. If you use one, '
  + 'say it is the figure they asked you to remember on its date, and give the measured figure beside it.';

export const PROJECTIONS_NOTE =
  'statements we made; `reconcile_projection` compares them with what happened. They are never current balances.';

/**
 * The orientation's memory block. PURE: rows in, JSON out.
 *
 * Rows must already be the authenticated user's own ACTIVE rows in this Space.
 * Only IN_FORCE and STALE items are listed; unreadable rows are left out (they
 * are counted by `recall` and shown in the user's panel), so the line's sentence
 * speaks for what it lists and the projections count speaks for itself.
 */
export function composeMemoryLine(
  rows: readonly MemoryRow[], todayISO: string, opts: { rules: RuleRendering } = { rules: 'clause' },
): Record<string, unknown> {
  const today = todayISO.slice(0, 10);
  const goals: unknown[] = []; const rules: unknown[] = []; const figures: unknown[] = []; const planned: unknown[] = [];
  const horizons: string[] = []; let projections = 0;

  for (const row of rows) {
    if (row.status !== 'ACTIVE') continue;
    const read = readMemory(row);
    if (!read.readable) continue;
    const state = stateOf(row, read, today);
    const head = { subject: row.subject, statedAt: row.statedAt.slice(0, 10) };
    if (read.cls === 'PROJECTION') {
      projections++;
      if (horizons.length < LINE_CAPS.horizons) horizons.push(read.fields.horizon as string);
      continue;
    }
    if (state !== 'IN_FORCE' && state !== 'STALE') continue;
    if (read.cls === 'GOAL' && goals.length < LINE_CAPS.goals) goals.push({ ...head, ...read.fields });
    else if (read.cls === 'PLANNED_EXPENSE' && planned.length < LINE_CAPS.planned) planned.push({ ...head, ...read.fields });
    else if (read.cls === 'RULE' && rules.length < LINE_CAPS.rules) {
      rules.push(opts.rules === 'clause' ? { ...head, rule: read.fields } : { ...head, inWords: describeMemory('RULE', read.fields) });
    } else if (read.cls === 'BASELINE' && figures.length < LINE_CAPS.planningAssumptions) {
      const f = read.fields;
      const kind = f.monthlySpending !== undefined ? 'spending' : 'return';
      const what = f.monthlySpending !== undefined ? `${amountWords(f.monthlySpending as number)}/month of spending` : `a ${f.annualReturnPct}% annual return`;
      figures.push({ ...head, ...f, basis: REMEMBERED, ...(state === 'STALE' ? { stale: true } : {}),
        meaning: `On ${head.statedAt} the user asked to plan with ${what} — not their measured ${kind}, and not in effect unless they say so.` });
    }
  }

  if (goals.length + rules.length + figures.length + planned.length + projections === 0) return { note: LINE_EMPTY };
  return {
    meaning: LINE_MEANING,
    ...(goals.length ? { goals } : {}),
    ...(rules.length ? { rules } : {}),
    planningAssumptions: figures.length ? figures : 'none remembered',
    ...(figures.length ? { planningNote: PLANNING_NOTE } : {}),
    ...(planned.length ? { planned } : {}),
    projectionsOnRecord: { count: projections, ...(horizons.length ? { horizons } : {}), ...(projections ? { note: PROJECTIONS_NOTE } : {}) },
  };
}
