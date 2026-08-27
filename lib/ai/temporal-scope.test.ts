/**
 * lib/ai/temporal-scope.test.ts   (CF-2)
 *
 * WHAT WAS ASKED FOR, WHAT WAS SELECTED, AND WHETHER THOSE ARE THE SAME.
 *
 *     npx tsx lib/ai/temporal-scope.test.ts
 *
 * The contract in isolation: the four authorities, the derived verdicts, and
 * the one rule that keeps a zero honest. The RENDERED half — that all of this
 * survives into the prompt the model reads, alongside CF-1's bounded-list
 * disclosure — is pinned separately in prompts/temporal-framing.test.ts.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 * That REQUESTED and SELECTED cannot be collapsed. CF-0 measured what happens
 * when they are: "in 2024" had its floor moved five and a half months by a
 * defensive clamp, and every layer downstream went on calling the result the
 * requested year, because nothing carried the request far enough to disagree.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isRequestSatisfied, isCoverageComplete, classifyEvidence, describeTemporalScope,
  withInterpretation, unsuppliedScope,
  TemporalRequests, SelectionReasons, CoverageBounds, EvidenceStates,
  type TemporalScope, type TemporalRequest,
} from './temporal-scope';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

function scope(o: {
  intent: TemporalRequest; label?: string;
  reqStart?: string | null; reqEnd?: string | null;
  selStart?: string; selEnd?: string; days?: number;
  reason?: typeof SelectionReasons[keyof typeof SelectionReasons];
  interpretation?: string | null;
  coverage?: TemporalScope['coverage'];
}): TemporalScope {
  return {
    requested: {
      intent: o.intent, label: o.label ?? 'x',
      startDate: o.reqStart ?? null, endDate: o.reqEnd ?? null,
    },
    selected: {
      startDate: o.selStart ?? '2026-05-29', endDate: o.selEnd ?? '2026-08-27',
      days: o.days ?? 90, reason: o.reason ?? SelectionReasons.DEFAULT_WINDOW,
      interpretation: o.interpretation ?? null,
    },
    coverage: o.coverage === undefined
      ? { fromDate: o.selStart ?? '2026-05-29', toDate: o.selEnd ?? '2026-08-27',
          transactionCount: 455, boundedBy: null }
      : o.coverage,
  };
}

// ══ THE FOUR AUTHORITIES STAY APART ═══════════════════════════════════════════
{
  const s = scope({
    intent: TemporalRequests.CALENDAR_YEAR, label: '2024',
    reqStart: '2024-01-01', reqEnd: '2024-12-31',
    selStart: '2024-06-18', selEnd: '2024-12-31', days: 197,
    reason: SelectionReasons.LOOKBACK_CLAMP,
  });
  check('the requested interval is not overwritten by the selected one',
    s.requested.startDate === '2024-01-01' && s.selected.startDate === '2024-06-18',
    'this is the measured CF-0 case: the clamp moved the floor and nothing said so');
  check('a clamped selection does NOT satisfy the request', !isRequestSatisfied(s));
  check('…and the reason is recoverable, not merely the fact',
    s.selected.reason === SelectionReasons.LOOKBACK_CLAMP);
}

// ══ SATISFACTION IS DERIVED, AND MEANS COVERAGE OF THE REQUEST ════════════════
{
  check('an exactly-matching selection satisfies',
    isRequestSatisfied(scope({
      intent: TemporalRequests.CALENDAR_MONTH,
      reqStart: '2026-07-01', reqEnd: '2026-07-31',
      selStart: '2026-07-01', selEnd: '2026-07-31', days: 31,
      reason: SelectionReasons.AS_REQUESTED,
    })));
  check('a WIDER selection also satisfies — the request is contained',
    isRequestSatisfied(scope({
      intent: TemporalRequests.EXPLICIT_RANGE,
      reqStart: '2026-03-01', reqEnd: '2026-05-31',
      selStart: '2026-01-01', selEnd: '2026-08-27', days: 239,
      reason: SelectionReasons.AS_REQUESTED,
    })));
  check('a selection short at the END does not satisfy',
    !isRequestSatisfied(scope({
      intent: TemporalRequests.CALENDAR_YEAR,
      reqStart: '2026-01-01', reqEnd: '2026-12-31',
      selStart: '2026-01-01', selEnd: '2026-08-27', days: 239,
    })));
  check('no stored satisfied flag exists to contradict the intervals',
    !/requestSatisfied\s*[:?]/.test(
      readFileSync(join(process.cwd(), 'lib/ai/temporal-scope.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
    'CF-1 doctrine: a third fact beside two intervals can disagree with them silently');
}

// ══ ALL_TIME CAN NEVER BE SATISFIED BY A BOUNDED WINDOW ══════════════════════
{
  for (const days of [90, 365, 800, 100_000]) {
    check(`a ${days}-day window does not discharge an all-time request`,
      !isRequestSatisfied(scope({ intent: TemporalRequests.ALL_TIME, days })),
      'widening retrieval cannot fix this; only saying so can');
  }
}

// ══ A DECLARED INTERPRETATION IS SATISFACTION, NOT A SHORTFALL ═══════════════
//
// The distinction the whole slice turns on. "recently" → 90 days is a complete
// answer; "ever" → 90 days is a substitution. Both were `undefined` before.
{
  for (const intent of [TemporalRequests.RECENT, TemporalRequests.CURRENT] as const) {
    const s = withInterpretation(scope({ intent, label: 'recently' }));
    check(`${intent} IS satisfied by the product's own reading`, isRequestSatisfied(s),
      'treating a declared interpretation as a shortfall makes the model hedge everything');
    check(`${intent} carries the reading as text`,
      s.selected.interpretation === 'the trailing 90 days');
    const rendered = describeTemporalScope(s).join('\n');
    check(`${intent} renders as a DELIBERATE interpretation, not a limitation`,
      /DELIBERATE product interpretation/.test(rendered) && !/DOES NOT COVER/.test(rendered));
  }

  const ever = scope({ intent: TemporalRequests.ALL_TIME, label: 'all time' });
  check('ALL_TIME over the SAME window renders as a shortfall',
    /DOES NOT COVER/.test(describeTemporalScope(ever).join('\n')),
    'same 90 days, different request — the two must not render alike');
  check('…and gains no interpretation to soften it',
    withInterpretation(ever).selected.interpretation === null);
}

// ══ UNSPECIFIED IS NOT A SHORTFALL ═══════════════════════════════════════════
{
  const s = scope({ intent: TemporalRequests.UNSPECIFIED, label: 'no period named' });
  check('no temporal claim ⇒ nothing to fail', isRequestSatisfied(s));
  check('…and no warning is emitted on an ordinary prompt',
    !/DOES NOT COVER|⚠/.test(describeTemporalScope(s).join('\n')),
    'warning on every prompt is how a real warning gets ignored');
}

// ══ COVERAGE IS INDEPENDENT OF SATISFACTION (CF-1 COMPOSITION, LOWER HALF) ═══
{
  // A perfectly satisfied window whose evidence was cut by the fetch cap.
  const s = scope({
    intent: TemporalRequests.CALENDAR_YEAR,
    reqStart: '2026-01-01', reqEnd: '2026-12-31',
    selStart: '2026-01-01', selEnd: '2026-12-31', days: 365,
    reason: SelectionReasons.AS_REQUESTED,
    coverage: { fromDate: '2026-03-14', toDate: '2026-12-31', transactionCount: 5000,
                boundedBy: CoverageBounds.FETCH_CAP },
  });
  check('a satisfied request can still have incomplete coverage',
    isRequestSatisfied(s) && !isCoverageComplete(s),
    'one disclosure must not be able to erase the other');
  const rendered = describeTemporalScope(s).join('\n');
  check('…and the prompt states the coverage limit even though the period matched',
    /evidence covers only 2026-03-14/.test(rendered));

  // And the converse: unsatisfied request, complete coverage of what was loaded.
  const t = scope({
    intent: TemporalRequests.ALL_TIME,
    coverage: { fromDate: '2026-05-29', toDate: '2026-08-27', transactionCount: 455, boundedBy: null },
  });
  check('an unsatisfied request can have complete coverage of what WAS loaded',
    !isRequestSatisfied(t) && isCoverageComplete(t));
}

// ══ §7 — A ZERO IS NOT A FACT UNLESS THE INTERVAL IS COMPLETE ════════════════
{
  const complete = scope({
    intent: TemporalRequests.CALENDAR_MONTH,
    reqStart: '2026-07-01', reqEnd: '2026-07-31',
    selStart: '2026-07-01', selEnd: '2026-07-31', days: 31,
    reason: SelectionReasons.AS_REQUESTED,
    coverage: { fromDate: '2026-07-01', toDate: '2026-07-31', transactionCount: 0, boundedBy: null },
  });
  check('complete interval + zero rows ⇒ COMPLETE_AND_EMPTY',
    classifyEvidence(complete) === EvidenceStates.COMPLETE_AND_EMPTY);
  check('…the ONLY state that licenses a no-activity claim',
    /may say there was no recorded activity/.test(describeTemporalScope(complete).join('\n')));

  const bounded = scope({
    intent: TemporalRequests.CALENDAR_MONTH,
    reqStart: '2026-07-01', reqEnd: '2026-07-31',
    selStart: '2026-07-01', selEnd: '2026-07-31', days: 31,
    reason: SelectionReasons.AS_REQUESTED,
    coverage: { fromDate: '2026-07-20', toDate: '2026-07-31', transactionCount: 0,
                boundedBy: CoverageBounds.FETCH_CAP },
  });
  check('bounded interval + zero rows ⇒ BOUNDED_AND_EMPTY',
    classifyEvidence(bounded) === EvidenceStates.BOUNDED_AND_EMPTY);
  check('…and is explicitly forbidden from becoming $0',
    /absence of evidence, not evidence of absence/.test(describeTemporalScope(bounded).join('\n'))
      && /do NOT report \$0/.test(describeTemporalScope(bounded).join('\n')));

  const notSupplied = unsuppliedScope({
    intent: TemporalRequests.CALENDAR_YEAR, label: '2023',
    startDate: '2023-01-01', endDate: '2023-12-31',
  });
  check('a requested period that was never queried ⇒ NOT_SUPPLIED',
    classifyEvidence(notSupplied) === EvidenceStates.NOT_SUPPLIED,
    'measured: "spend in 2023" clamps to a floor after its own ceiling, zero rows, domain dropped');
  check('…and is NOT reported as satisfied', !isRequestSatisfied(notSupplied));
  const ns = describeTemporalScope(notSupplied).join('\n');
  check('…and forbids answering from another period',
    /Do NOT answer the question from any other period/.test(ns) && /do NOT report a total or a \$0/.test(ns));
  check('…and does not describe figures that are not there',
    !/figure below describes ONLY/.test(ns),
    'nothing was loaded; there are no figures for a caveat to scope');

  const unavailable = unsuppliedScope({
    intent: TemporalRequests.UNSPECIFIED, label: 'no period named',
    startDate: null, endDate: null,
  });
  check('no request and no evidence ⇒ UNAVAILABLE',
    classifyEvidence(unavailable) === EvidenceStates.UNAVAILABLE);
  check('…and states that no figures may be given at all',
    /Do not state spending, income or category figures at all/.test(
      describeTemporalScope(unavailable).join('\n')));

  check('rows present ⇒ PRESENT',
    classifyEvidence(scope({ intent: TemporalRequests.UNSPECIFIED })) === EvidenceStates.PRESENT);
}

// ══ THE SHORTFALL NAMES WHAT MAY NOT BE CONCLUDED ════════════════════════════
{
  const s = scope({
    intent: TemporalRequests.CALENDAR_YEAR, label: '2024',
    reqStart: '2024-01-01', reqEnd: '2024-12-31',
    selStart: '2024-06-18', selEnd: '2024-12-31', days: 197,
    reason: SelectionReasons.LOOKBACK_CLAMP,
    coverage: { fromDate: '2024-06-18', toDate: '2024-12-31', transactionCount: 763, boundedBy: null },
  });
  const r = describeTemporalScope(s).join('\n');
  check('both intervals appear, so the reader can check the claim',
    r.includes('2024-01-01 to 2024-12-31') && r.includes('2024-06-18 to 2024-12-31'));
  check('the clamp names its floor rather than an unrelated span',
    /does not load transactions from before 2024-06-18/.test(r),
    'quoting the clamped window LENGTH read "197-day maximum" for an 800-day bound');
  check('the model is told not to label a figure with the requested period',
    /do NOT label a figure with the requested period/.test(r));
  check('…nor to extrapolate one period from the other',
    /do NOT extrapolate/.test(r));
  check('…and is told older transactions may exist',
    /Older transactions may well exist/.test(r),
    'a shortfall must not read as "you have no older data"');
}

console.log(`\ntemporal-scope: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
