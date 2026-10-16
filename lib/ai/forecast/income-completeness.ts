/**
 * lib/ai/forecast/income-completeness.ts  (AI RELIABILITY 2026-10-16 — what the projection's income term HOLDS)
 *
 * PURE — no DB, no model, no clock. Given the income streams the spine resolved
 * and the events one projection run generated, say per stream what reached the
 * projected total and what did not, and whether the total is COMPLETE.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * On the live Space (2026-10-16) the primary payroll stream was CURRENT and
 * projection-eligible, but its amount authority refused a level after one
 * unusual paycheck. Every future paycheck was then excluded inside the fold
 * (lib/forecast/projection.ts), projected income fell from ~$31.7k to $0.65 of
 * interest, and `project_cash` still returned `EVIDENCE_BASED_ESTIMATE` with the
 * sentence "future payroll is inferred from the observed deposit cadence" and
 * `incomeEventsCounted: 12`. The only trace was a grouped `excluded` note. The
 * model, holding a −$21k variance and no tool output that named its cause,
 * narrated unsupported causes and then asked the customer for their income —
 * which the platform already held.
 *
 * So a CURRENT, projection-eligible INCOME stream whose occurrences inside the
 * horizon could not be priced makes the projection INCOMPLETE, by stream, with
 * the evidence the platform holds (last observed payment, its date) and one
 * stated arithmetic consequence: the ending figure if those occurrences arrived
 * at the last observed amount. Nothing here picks which level is right.
 *
 * ── What counts ─────────────────────────────────────────────────────────────
 * Only FlowRole.INCOME streams decide completeness. An INTEREST stream with no
 * assertable amount (balances vary month to month — cents on the live Space) is
 * reported but cannot make a projection incomplete; it is not what a customer
 * means by income, and flagging it would make every projection "incomplete".
 */

import { FlowRole, exactDateOf, observedCashContribution, type FutureCashEvent } from '@/lib/forecast/future-cash-event';
import type { ResolvedIncomeStream } from './streams';

export type RecurringIncomeStatus =
  /** Every occurrence in the horizon was priced at the stream's established level. */
  | 'PRESENT'
  /** Priced at the established level, but the NEWEST payment deviated and was held out (one-off or new level — not yet known). */
  | 'PRESENT_LATEST_DEVIATES'
  /** Current and expected to pay inside the horizon, but no level is established — its occurrences counted $0. */
  | 'AMOUNT_UNESTABLISHED'
  /** Priced, but its occurrences were not counted as spendable cash (e.g. settled outside a depository account) — by policy, not a gap. */
  | 'EXCLUDED'
  /** Not licensed to continue (silent / ended) — correctly not projected. */
  | 'LAPSED';

export interface StreamIncomeLine {
  stream: string;
  role: 'INCOME' | 'INTEREST';
  status: RecurringIncomeStatus;
  /** Occurrences the cadence places inside the horizon (0 for a lapsed stream). */
  occurrencesInHorizon: number;
  /** …of which reached the projected total. */
  counted: number;
  /** Their sum, as the fold counted it. */
  projectedTotal: number;
  /** The established level per occurrence, when there is one. */
  level: number | null;
  lastObserved: { date: string; amount: number } | null;
  latestDeviation?: { date: string; amount: number; pctFromLevel: number };
  /** AMOUNT_UNESTABLISHED only: what the omitted occurrences would add at the last observed amount. */
  omittedAtLastObserved?: number;
  /** AMOUNT_UNESTABLISHED only: whether that omission reaches MATERIALITY (unsizable ⇒ material). */
  material?: boolean;
  /** PRESENT_LATEST_DEVIATES only: what the counted payments would add if the newest amount were the level. */
  ifLatestIsNewLevel?: { perPayment: number; total: number };
}

export interface IncomeCompleteness {
  status: 'COMPLETE' | 'INCOMPLETE';
  streams: StreamIncomeLine[];
  /** Σ projectedTotal over INCOME + INTEREST — the projection's income term, restated per stream. */
  projectedIncomeTotal: number;
  /** Income events (INFLOW, derived from streams) that reached the total / were excluded. */
  incomeEventsCounted: number;
  incomeEventsExcluded: number;
  /** INCOMPLETE only: Σ omittedAtLastObserved over the INCOME streams that make it incomplete. */
  omittedAtLastObserved: number;
}

export interface IncomeCompletenessInput {
  streams: readonly ResolvedIncomeStream[];
  events: readonly FutureCashEvent[];
  excludedIds: ReadonlySet<string>;
  fromISO: string;
  toISO: string;
  /** The projection's opening cash — the base MATERIALITY is a share of (with counted income). */
  openingCash: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * When an omission changes what the figure IS. An omitted stream is ALWAYS listed;
 * it makes the projection INCOMPLETE only when what it would add at its last
 * observed amount reaches this share of the cash the projection works with
 * (opening cash + counted income), or when it cannot be sized at all.
 *
 * MEASURED on the live Space (2026-10-16): the dropped payroll was 5 × $6,770.32
 * against ~$19.5k of opening cash — far above any threshold — while an
 * interest-like deposit with varying amounts adds $57.68 against ~$46k (0.13%).
 * A rule that flagged the second would mark nearly every projection incomplete
 * and train the reader to ignore the flag. 1% sits between them by an order of
 * magnitude on both sides; the floor keeps a near-empty account from flagging cents.
 */
export const MATERIALITY = { SHARE: 0.01, FLOOR_USD: 50 } as const;
const keyOfEvent = (id: string): string => id.slice(0, id.lastIndexOf('@'));

export function incomeCompleteness(input: IncomeCompletenessInput): IncomeCompleteness {
  const { streams, events, excludedIds, fromISO, toISO } = input;
  const inWindow = events.filter((e) => {
    const d = exactDateOf(e.timing);
    return e.direction === 'INFLOW' && d !== null && d >= fromISO && d <= toISO;
  });
  const lines: StreamIncomeLine[] = [];
  let incomeEventsCounted = 0, incomeEventsExcluded = 0;

  for (const s of streams) {
    if (s.role !== FlowRole.INCOME && s.role !== FlowRole.INTEREST) continue;
    const own = inWindow.filter((e) => keyOfEvent(e.id) === s.sourceKey);
    const counted = own.filter((e) => !excludedIds.has(e.id));
    // The fold's own contribution, so the per-stream totals restate the projection's income term exactly.
    const projectedTotal = counted.reduce((n, e) => { const c = observedCashContribution(e); return n + (c.assertable ? c.value : 0); }, 0);
    incomeEventsCounted += counted.length;
    incomeEventsExcluded += own.length - counted.length;

    const verdicts = s.amount?.verdicts ?? [];
    const last = verdicts.length ? verdicts[verdicts.length - 1] : null;
    const lastObserved = last ? { date: last.dateISO, amount: last.value } : null;
    const level = s.amount?.assertable ? s.amount.value : null;
    const deviation = s.amount?.assertable ? s.amount.latestDeviation : undefined;
    const omitted = own.length - counted.length;

    const status: RecurringIncomeStatus = !s.projectionEligible ? 'LAPSED'
      : omitted > 0 ? (level === null ? 'AMOUNT_UNESTABLISHED' : 'EXCLUDED')
      : deviation ? 'PRESENT_LATEST_DEVIATES' : 'PRESENT';

    lines.push({
      stream: s.label,
      role: s.role === FlowRole.INTEREST ? 'INTEREST' : 'INCOME',
      status,
      occurrencesInHorizon: own.length,
      counted: counted.length,
      projectedTotal: round2(projectedTotal),
      level,
      lastObserved,
      ...(deviation ? { latestDeviation: { date: deviation.dateISO, amount: deviation.value, pctFromLevel: deviation.pctFromLevel },
        ifLatestIsNewLevel: { perPayment: round2(deviation.value - (level ?? 0)),
          total: round2((deviation.value - (level ?? 0)) * counted.length) } } : {}),
      ...(status === 'AMOUNT_UNESTABLISHED' && lastObserved
        ? { omittedAtLastObserved: round2(omitted * lastObserved.amount) } : {}),
    });
  }

  const base = Math.abs(input.openingCash) + lines.reduce((n, l) => n + l.projectedTotal, 0);
  const threshold = Math.max(MATERIALITY.FLOOR_USD, MATERIALITY.SHARE * base);
  for (const l of lines) {
    if (l.status !== 'AMOUNT_UNESTABLISHED') continue;
    l.material = l.omittedAtLastObserved === undefined || l.omittedAtLastObserved >= threshold;
  }
  const blocking = lines.filter((l) => l.role === 'INCOME' && l.status === 'AMOUNT_UNESTABLISHED' && l.material);
  return {
    status: blocking.length ? 'INCOMPLETE' : 'COMPLETE',
    streams: lines,
    projectedIncomeTotal: round2(lines.reduce((n, l) => n + l.projectedTotal, 0)),
    incomeEventsCounted,
    incomeEventsExcluded,
    omittedAtLastObserved: round2(blocking.reduce((n, l) => n + (l.omittedAtLastObserved ?? 0), 0)),
  };
}
