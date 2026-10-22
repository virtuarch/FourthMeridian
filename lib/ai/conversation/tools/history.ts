/**
 * lib/ai/conversation/tools/history.ts
 *
 * Balance history: `get_net_worth_history` (with its change block) and
 * `find_in_balance_history`.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { getRecentSnapshots } from '@/lib/data/snapshots';
import { projectSnapshotSection } from '@/lib/ai/assemblers/snapshot';
import type { Snapshot } from '@/types';
import {
  observedChange, findObservation, NEEDS_THRESHOLD, type TemporalOperation,
} from '@/lib/data/snapshot-window';
import type { ToolDefinition } from './types';
import { obj, str, num } from './shared/schema';
import {
  round2, isoDay, SNAPSHOT_READ_ROWS, MAX_DAILY_POINTS, clampToCeiling, daysAgoISO,
} from './shared/values';
import { absentIn } from './shared/reads';

// ── 6. Net-worth history ─────────────────────────────────────────────────────

export const getNetWorthHistory: ToolDefinition = {
  name: 'get_net_worth_history',
  // ⚠️ THIS IS THE CHANGE TOOL, AND IT NOW SAYS SO. It already returned both
  // endpoints with every component; what it did not do was say that this is what
  // answers "what changed" — so the model reached for a tool whose NAME promised
  // change and whose payload was a composition, and read balances as movements
  // (58b352f, twice). The `change` block below is the same fact, subtracted by an
  // authority instead of by whoever is reading.
  description:
    'Net worth and its components over time, and what they CHANGED by across the ' +
    'requested range — `change` gives the measured movement of net worth, liquid, ' +
    'investments, digital assets and debt between the first and last observation. Use it ' +
    'for "what changed", "why did my net worth move", "how does this compare with a month ' +
    'ago". `liquid` is the recorded checking + savings balance; historical snapshots do not separate restricted accounts such as an HSA, so it is not comparable to today\'s unrestricted `liquid` when such accounts exist; `checking` is the checking bucket alone — there ' +
    'is deliberately no field called "cash". Ask for `granularity: "monthly"` to get one ' +
    'point per calendar month. A point whose net worth could not be established is returned ' +
    'as null WITH a reason; read `coverage` before describing older history as fact. For an ' +
    'EXACT date — the first or last time something crossed a number, a highest or a lowest — ' +
    'use `find_in_balance_history` instead: a long series here is downsampled and the day you ' +
    'need may not be in it.',
  parameters: obj({
    from: str('YYYY-MM-DD. Omit for the last 90 days.'),
    to:   str('YYYY-MM-DD. Omit for today.'),
    granularity: { type: 'string', enum: ['monthly', 'daily'],
      description: 'monthly = the last observation in each calendar month. Default '
        + 'monthly for ranges over 92 days, daily otherwise.' },
    maxPoints: num('Daily granularity only: downsample evenly to at most this many points.'),
  }),
  async run(a, ctx) {
    // ⚠️ THE CEILING APPLIES HERE TOO, AND DID NOT. `get_spending`,
    // `get_transactions` and `get_income` all clamp; this one took `to` raw, so a
    // retrospective read at `asOf: 2026-01-31` asking `to: 2026-09-12` returned
    // SEPTEMBER balances. Found while proving the new `change` block respects the
    // ceiling — which it could not, because the endpoints it subtracts did not.
    const ceiling = ctx.asOfISO;
    const to   = clampToCeiling((a.to as string) || ceiling, ceiling);
    const from = (a.from as string) || daysAgoISO(to, 89);

    // ⚠️ THROUGH THE ASSEMBLER'S OWN PROJECTION, NOT THE RAW ROWS. The canonical
    // snapshot read carries `aggregateAuthorisation` — for 407 of this Space's 770
    // points it says `netWorth.assertable: false` with
    // `HISTORICAL_CRYPTO_VALUATION_UNAVAILABLE` — and `projectSnapshotSection` is
    // the pure, tested function that turns that into nulls plus a reason. Reading
    // `r.netWorth` / `r.totalCrypto` directly (which this tool used to do) took the
    // depth and threw away the refusal, so a stale figure carried on a contaminated
    // row was reported as a fact and the model told the user he had negative net
    // worth in early 2025.
    const rows = await getRecentSnapshots(ctx.readClient, { rows: SNAPSHOT_READ_ROWS }, { spaceId: ctx.spaceId });
    const section = projectSnapshotSection(rows as Snapshot[], 'full');
    if (!section) {
      return absentIn(ctx, 'no usable snapshot history for this Space', 'any usable snapshot history');
    }

    const inRange = section.history.filter((p) => p.date >= from && p.date <= to);
    if (inRange.length === 0) {
      return { unavailable: `no snapshots between ${from} and ${to}`,
        earliestAvailable: section.oldestDate, latestAvailable: section.newestDate };
    }

    const spanDays = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    const granularity = (a.granularity as string) === 'daily' ? 'daily'
      : (a.granularity as string) === 'monthly' ? 'monthly'
      : spanDays > 92 ? 'monthly' : 'daily';

    // ⚠️ MONTH-END MEANS THE LAST OBSERVATION IN THE MONTH, not every Nth day. The
    // previous even downsample (`i % step`) never landed on a month boundary, so a
    // month-by-month question could only be answered by re-querying each month —
    // which is exactly what happened: 33 tool calls and 145,550 prompt tokens to
    // recover twelve rows that were already in the first payload.
    let picked = inRange;
    let clamped = false;
    if (granularity === 'monthly') {
      const byMonth = new Map<string, (typeof inRange)[number]>();
      for (const p of inRange) byMonth.set(p.date.slice(0, 7), p); // ordered ⇒ last wins
      picked = [...byMonth.values()];
    } else if (a.maxPoints !== undefined) {
      const cap = Math.min(Math.max(Number(a.maxPoints), 2), MAX_DAILY_POINTS);
      clamped = Number(a.maxPoints) > cap;
      const step = Math.max(1, Math.ceil(inRange.length / cap));
      picked = inRange.filter((_, i) => i % step === 0 || i === inRange.length - 1);
    }

    // ⚠️ NO FIELD HERE IS CALLED `cash`, AND THAT IS THE WHOLE POINT. It used to
    // be: `cash: p.liquid`, where `liquid` is checking PLUS savings. Meanwhile
    // `explain_net_worth_composition{lens:'cash'}` returns the CHECKING bucket alone.
    // Both were correct about their own population and both were called "cash",
    // so on 2026-01-01 one tool said $1,255.20 and the other said $9,517.46. The
    // model quoted the smaller one, built debt advice on it, and only corrected
    // when the user pushed back. A model cannot reconcile two fields that share a
    // name and not a population, and it should never have to.
    const pt = (p: (typeof inRange)[number]) => ({
      date: p.date,
      // Null means EXPLICITLY UNKNOWN and always travels with its reason.
      netWorth: p.netWorth, totalAssets: p.totalAssets,
      /** Checking + savings. The spendable total. */
      liquid: p.liquid,
      /** Checking only — the `cash` bucket, matching explain_net_worth_composition's `cash` lens. */
      checking: p.cashOnHand,
      investments: p.investments, digitalAssets: p.digitalAssets,
      debt: p.liabilities,
      ...(p.digitalAssetsUnavailableReason
        ? { unassertableBecause: p.digitalAssetsUnavailableReason } : {}),
      // RWA-2B — present only when the real-asset part of this point is modeled.
      ...(p.realAssetsModeled ? { realAssetsModeled: true } : {}),
    });

    const unassertable = picked.filter((p) => p.netWorth === null);
    const firstAssertable = inRange.find((p) => p.netWorth !== null)?.date ?? null;
    // RWA-2B — how many points in range rest on a modeled real-asset value, so a
    // series that is partly modeled is never described as wholly observed.
    const modeledRealAssets = inRange.filter((p) => p.realAssetsModeled).length;

    return {
      window: { from, to, granularity },
      // ⚠️ COVERAGE IS EVIDENCE, NOT A CAVEAT. It is the difference between "your
      // net worth was −$6,837" and "net worth cannot be established before
      // September 2025 because crypto could not be valued".
      coverage: {
        pointsReturned: picked.length,
        // ⚠️ HOW MANY THERE ACTUALLY ARE, BESIDE HOW MANY CAME BACK. A monthly
        // roll-up and a downsampled daily read both look exactly like the record
        // from inside the payload, and both have been read as it: a 786-day
        // range capped to 194 points does not contain the day debt first hit
        // zero, so every answer derived from scanning it was wrong before it
        // started. The series is for shape; exact days come from
        // `find_in_balance_history`, which searches all of them.
        observationsInRange: inRange.length,
        ...(picked.length < inRange.length ? {
          seriesIsSample: true,
          sampleNote:
            `This is ${picked.length} of ${inRange.length} observations in the range. Days `
            + 'not shown are NOT missing from the record, they are missing from this '
            + 'payload — never state a first, last, highest or lowest from it. '
            + 'Use find_in_balance_history for those.',
        } : {}),
        pointsUnassertable: unassertable.length,
        firstAssertableDate: firstAssertable,
        reason: unassertable.length > 0
          ? (unassertable[0] as { digitalAssetsUnavailableReason?: string })
              .digitalAssetsUnavailableReason ?? 'component unassertable'
          : null,
        note: unassertable.length > 0
          ? 'Points with netWorth null are NOT zero and NOT measured — the underlying '
            + 'component could not be valued for that date. Do not state them as amounts, '
            + 'and do not treat a series containing them as a complete trend.'
          : null,
        historyAvailableFrom: section.oldestDate,
        historyAvailableTo:   section.newestDate,
        ...(clamped ? { maxPointsClamped: MAX_DAILY_POINTS } : {}),
        ...(modeledRealAssets > 0 ? {
          pointsWithModeledRealAssets: modeledRealAssets,
          modeledRealAssetsNote:
            `On ${modeledRealAssets} observation(s) in this range (flagged realAssetsModeled) the real-asset part of `
            + 'netWorth and totalAssets is MODELED — a straight line between two of the user\'s dated estimates '
            + 'for a manual asset — not observed. liquid, checking, investments, digitalAssets and debt on '
            + 'those dates are unaffected. Describe such net worth as modeled or estimated, never observed.',
        } : {}),
      },
      first: pt(inRange[0]), last: pt(inRange[inRange.length - 1]),
      // ⚠️ MEASURED MOVEMENT, NOT ATTRIBUTION. Each entry is the closing
      // observation minus the opening one for that metric, computed by
      // `observedChange` and carrying the dates it actually compared. Nothing
      // here says WHY: investments rising is not a market gain, cash rising is
      // not income received, and debt falling is a debt fact whose effect on net
      // worth is the reader's to state. A metric that could not be established at
      // either end is absent rather than zero.
      change: changeBlock(pt(inRange[0]), pt(inRange[inRange.length - 1])),
      series: picked.map(pt),
    };
  },
};

// ── 6b. Exact temporal facts over the balance history ────────────────────────

const BALANCE_METRICS = {
  netWorth:      'net worth',
  liquid:        'the recorded checking + savings balance (restricted accounts such as an HSA are not separable in history)',
  checking:      'the checking bucket alone',
  investments:   'traditional investments',
  digitalAssets: 'crypto',
  debt:          'total debt owed',
} as const;
type BalanceMetric = keyof typeof BALANCE_METRICS;

const TEMPORAL_OPERATIONS: readonly TemporalOperation[] = [
  'minimum', 'maximum',
  'first_below', 'first_above', 'last_below', 'last_above',
];

/**
 * THE EXACT DAY, COMPUTED RATHER THAN READ OFF A LIST.
 *
 * ⚠️ IT EXISTS BECAUSE THE SERIES ANSWER WAS WRONG IN PRODUCTION. Asked when
 * debt first hit zero, the assistant answered 2026-04-24 — a date whose debt, in
 * the very payload it was reading, was $5,353.81. The true answer, 2026-07-22,
 * was in the same series. Scanning two hundred rows for a first/last/highest/
 * lowest is arithmetic, and arithmetic over money is not the model's to do.
 *
 * ⚠️ AND BECAUSE THE SERIES COULD NOT ALWAYS ANSWER IT. `get_net_worth_history`
 * downsamples a long daily range, so the day the answer lives on can simply not
 * be in the payload: a 786-day read capped to 194 points does not contain
 * 2026-07-22 at all, and every reading of it is wrong before the model starts.
 * This scans EVERY observation in range and returns one.
 */
export const findInBalanceHistory: ToolDefinition = {
  name: 'find_in_balance_history',
  description:
    'The EXACT date and amount for a question about one balance over time — the first ' +
    'or last time it crossed a number, and its highest or lowest point. Use it for ' +
    '"when did I first hit zero", "when did my debt first fall below 1,000", "when was ' +
    'the last time X was zero", "what was my highest debt", "my lowest cash balance", ' +
    '"when did I cross above/below". ALWAYS use this rather than reading dates off a ' +
    'series yourself: it checks every observation in the range, while a long history ' +
    'series is downsampled and may not even contain the day you need. Returns the ' +
    'matching observation, the observation before it, and the coverage it searched.',
  parameters: obj({
    metric: { type: 'string', enum: Object.keys(BALANCE_METRICS),
      description: 'Which balance. `liquid` is the recorded checking + savings balance; historical snapshots do not separate restricted accounts such as an HSA, so it is not comparable to today\'s unrestricted `liquid` when such accounts exist; `checking` is the '
        + 'checking bucket alone; `debt` is what is owed, as a positive amount.' },
    operation: { type: 'string', enum: [...TEMPORAL_OPERATIONS],
      description: 'minimum and maximum need no threshold. first_below, first_above, '
        + 'last_below and last_above each need one, and INCLUDE the threshold itself: '
        + '"the first time debt was zero" is first_below with threshold 0; "when did it '
        + 'first go over 10,000" is first_above with threshold 10000.' },
    threshold: num('The amount to compare against. Required for first_below, first_above, last_below and last_above.'),
    from: str('YYYY-MM-DD. Omit for the whole available history.'),
    to:   str('YYYY-MM-DD. Omit for today.'),
  }, ['metric', 'operation']),
  async run(a, ctx) {
    const metric = a.metric as BalanceMetric;
    const operation = a.operation as TemporalOperation;
    if (!BALANCE_METRICS[metric]) return { error: `unknown metric: ${String(a.metric)}` };
    if (!TEMPORAL_OPERATIONS.includes(operation)) {
      return { error: `unknown operation: ${String(a.operation)}` };
    }
    const threshold = a.threshold === undefined ? undefined : Number(a.threshold);
    if (NEEDS_THRESHOLD[operation] && (threshold === undefined || !Number.isFinite(threshold))) {
      return { error: `${operation} needs a numeric threshold` };
    }

    // The same read, the same projection, the same refusals as the series tool.
    // A second historical pipeline would be a second version of the truth.
    const ceiling = ctx.asOfISO;
    const to = clampToCeiling((a.to as string) || ceiling, ceiling);
    const rows = await getRecentSnapshots(ctx.readClient, { rows: SNAPSHOT_READ_ROWS }, { spaceId: ctx.spaceId });
    const section = projectSnapshotSection(rows as Snapshot[], 'full');
    // ⚠️ THE CONTRACT OF THIS TOOL IS "THE FIRST DAY DEBT HIT $0", so an empty
    // series does not merely fail to answer it — it answers it WRONGLY unless the
    // emptiness is established. This is the site the absence contract was written
    // for: `result: null` plus a licensed sentence, never a date.
    if (!section) {
      return absentIn(ctx, 'no usable snapshot history for this Space', 'any usable snapshot history',
        { metric, operation, ...(threshold !== undefined ? { threshold } : {}), result: null });
    }
    // ⚠️ THE WHOLE RECORD BY DEFAULT. "When did I FIRST" has no natural start
    // date, and defaulting to ninety days the way the series tool does would
    // answer a different question and sound certain doing it. `oldestDate` is
    // null only for an empty section, which is already refused above.
    const from = (a.from as string) || section.oldestDate || '0000-01-01';

    const inRange = section.history.filter((p) => p.date >= from && p.date <= to);
    const valueOf = (p: (typeof inRange)[number]): number | null =>
      metric === 'netWorth' ? p.netWorth
      : metric === 'liquid' ? p.liquid
      : metric === 'checking' ? p.cashOnHand
      : metric === 'investments' ? p.investments
      : metric === 'digitalAssets' ? p.digitalAssets
      : p.liabilities;

    // ⚠️ AN UNESTABLISHED VALUE IS NOT A LOW AND NOT A ZERO. Points the
    // assembler refused are removed from the scan and counted, so "crypto could
    // not be valued for 407 days" can never become "your net worth bottomed out".
    const usable = inRange
      .map((p) => ({ date: new Date(`${p.date}T00:00:00.000Z`), value: valueOf(p) }))
      .filter((p): p is { date: Date; value: number } => p.value !== null);
    const unassertable = inRange.length - usable.length;

    const coverage = {
      window: { from, to },
      observationsInRange: inRange.length,
      observationsSearched: usable.length,
      observationsUnassertable: unassertable,
      firstObservation: usable[0] ? isoDay(usable[0].date) : null,
      lastObservation: usable.length ? isoDay(usable[usable.length - 1].date) : null,
      historyAvailableFrom: section.oldestDate,
      historyAvailableTo:   section.newestDate,
      ...(unassertable > 0 ? { note:
        `${unassertable} observation(s) in this range could not be established and were `
        + 'not searched. They are not zeroes.' } : {}),
    };

    // ⚠️ TWO DIFFERENT ANSWERS, NEVER THE SAME ONE. "It never happened in a range
    // I can see" and "I cannot see that range" are opposite statements, and a
    // single empty result would let either be told as the other.
    if (usable.length === 0) {
      return { metric, operation, ...(threshold !== undefined ? { threshold } : {}),
        result: null,
        unavailable: inRange.length === 0
          ? 'NO_OBSERVATIONS_IN_RANGE'
          : 'NO_ESTABLISHED_OBSERVATIONS_IN_RANGE',
        coverage };
    }

    const found = findObservation(usable, operation, threshold);
    if (!found) {
      return { metric, operation, ...(threshold !== undefined ? { threshold } : {}),
        result: null, unmatched: 'NO_OBSERVATION_MEETS_THE_CONDITION', coverage };
    }

    // RWA-2B — only netWorth composes the real-asset component; the other
    // metrics never did, so a modeled real asset cannot touch their answers.
    const modeledDates = metric === 'netWorth'
      ? new Set(inRange.filter((p) => p.realAssetsModeled).map((p) => p.date)) : new Set<string>();
    const matchDate = isoDay(found.match.date);

    return {
      metric, metricMeans: BALANCE_METRICS[metric], operation,
      ...(threshold !== undefined ? { threshold } : {}),
      result: {
        date: matchDate,
        value: found.match.value,
        ...(found.previous
          ? { previousObservation: { date: isoDay(found.previous.date), value: found.previous.value } }
          : {}),
        // RWA-2B — the matched day's net worth rests partly on a modeled real-asset value.
        ...(modeledDates.has(matchDate) ? { realAssetsModeled: true } : {}),
      },
      // ⚠️ OBSERVED, NOT INTERPOLATED, AND THE ANSWER SHOULD SAY SO WHEN IT
      // MATTERS. Debt was $17.12 on the 19th and $0 on the 22nd; nothing was
      // measured in between, so the 22nd is the first day it was OBSERVED at
      // zero, not provably the day it became zero.
      //
      // RWA-2B — ONE exception, stated only when it applies: a day's net worth
      // may include a manual asset's MODELED value (a straight line between two
      // of the user's dated estimates). The snapshot for that day is still a
      // dated row that was searched, not an interpolation between rows — but
      // its real-asset part is not observed, and the answer must not call it so.
      basis: 'Observed daily snapshots only — nothing between two observations is modelled. '
        + 'Describe the answer as the first/last OBSERVED date where that distinction matters.'
        + (modeledDates.size > 0
          ? ` Exception: on ${modeledDates.size} searched day(s) the real-asset part of net worth is MODELED `
            + 'between the user\'s dated estimates for a manual asset (the matched day is flagged '
            + 'realAssetsModeled when it is one of them); describe such a net worth as modeled or estimated, never observed.'
          : ''),
      coverage: {
        ...coverage,
        ...(modeledDates.size > 0 ? { observationsWithModeledRealAssets: modeledDates.size } : {}),
      },
    };
  },
};

/**
 * The measured movement of each component between two observations.
 *
 * ⚠️ ONE SUBTRACTION AUTHORITY, CALLED FIVE TIMES. `observedChange` owns what a
 * change between two observations IS — including refusing when the two are the
 * same day, and reporting which rows it compared. This maps components onto it
 * and adds nothing: no re-signing, no net-worth-effect interpretation, no
 * labels. A metric that is null at either end is OMITTED rather than treated as
 * zero, because "not established" and "did not move" are different answers.
 *
 * ⚠️ `debt` IS THE DEBT'S OWN DIRECTION. Debt falling from 20,000 to 10,000 is
 * `abs: -10000`. That it IMPROVED net worth by 10,000 is a true sentence and is
 * the reader's to write — a field called `debtContribution: -10000` would be the
 * ambiguity this deliberately refuses to ship.
 */
interface ChangeableSnapshotPoint {
  date: string;
  netWorth: number | null; liquid: number | null; checking: number | null;
  investments: number | null; digitalAssets: number | null; debt: number | null;
}
type ChangeMetric = Exclude<keyof ChangeableSnapshotPoint, 'date'>;

function changeBlock(first: ChangeableSnapshotPoint, last: ChangeableSnapshotPoint) {
  const metrics: ChangeMetric[] =
    ['netWorth', 'liquid', 'checking', 'investments', 'digitalAssets', 'debt'];
  const at = (p: ChangeableSnapshotPoint, k: ChangeMetric) =>
    (typeof p[k] === 'number' ? { date: new Date(`${p.date}T00:00:00.000Z`), value: p[k] } : null);
  const out: Record<string, unknown> = {};
  for (const m of metrics) {
    const c = observedChange(at(first, m), at(last, m));
    if (c) out[m] = { from: c.fromValue, to: c.toValue, abs: round2(c.abs), pct: c.pct };
  }
  if (Object.keys(out).length === 0) return null;
  return {
    between: { from: first.date, to: last.date },
    ...out,
    meaning: 'Each figure is the closing observation minus the opening one for that metric, '
      + 'in the metric\'s own direction — `debt` negative means debt fell. These are MEASURED '
      + 'movements, not causes: an investments rise is not necessarily a market gain, a cash '
      + 'rise is not necessarily income, and what drove either is a transaction question.',
  };
}
