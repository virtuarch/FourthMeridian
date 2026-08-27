/**
 * lib/ai/temporal-scope.ts
 *
 * CF-2 — WHAT WAS ASKED FOR, WHAT WAS SELECTED, AND WHETHER THOSE ARE THE SAME.
 *
 * Pure: no DB, no framework, no domain knowledge beyond dates. Four authorities
 * that CF-0 found collapsed into one `window` object, kept apart here because
 * they answer four different questions and can each be right while another is
 * wrong.
 *
 *   REQUESTED   the temporal claim the user's words make. "in 2024" denotes a
 *               calendar year whether or not anything can serve it.
 *   SELECTED    the interval the deterministic router and the assembler's
 *               defensive clamp actually chose to query.
 *   COVERAGE    what the retrieved evidence can support inside that interval —
 *               narrower than SELECTED whenever the fetch cap bit.
 *   SATISFIED   whether SELECTED discharges REQUESTED. Derived, never stored.
 *
 * ── The failures this closes ────────────────────────────────────────────────
 * Measured on the live corpus at HEAD 127333c, all on real production prompts:
 *
 *   "How much did I spend in 2024?"
 *     requested 2024-01-01..2024-12-31, selected 2024-06-18..2024-12-31. The
 *     800-day lookback clamp moved the floor five and a half months and said
 *     nothing. Worse, the routing block asserted "Requested transaction period:
 *     2024 (2024-01-01 to 2024-12-31). The transaction summary in the context
 *     below was assembled for EXACTLY THIS PERIOD" — a false sentence, sitting
 *     above a context block that said Jun 2024 – Dec 2024. Two contradictory
 *     claims in one prompt, the confident one wrong.
 *
 *   "What did I spend before June 2024?"
 *     `\b(20\d{2})\b` matched "2024" and selected the whole of 2024, clamped to
 *     June–December: very nearly the COMPLEMENT of the question. The model was
 *     handed figures for a period disjoint from the one asked about, framed as
 *     responsive.
 *
 *   "How much have I ever spent?" / "recently" / "currently"
 *     No window recognised, so the assembler's rolling 90 days. For "recently"
 *     that is a perfectly good product interpretation; for "ever" it is a
 *     silent substitution. The prompt could not tell them apart because it
 *     recorded neither.
 *
 * ── Why SATISFIED is derived ────────────────────────────────────────────────
 * Same reason CF-1 derives completeness from counts: a stored boolean beside
 * the two intervals is a third fact that can disagree with them, silently. Here
 * it would be worse than in CF-1 — the two intervals are what a reader checks
 * the claim against, so a stale flag contradicts visible evidence.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 * It changes no retrieval policy. An all-time request still receives the
 * rolling 90-day window; this module makes the shortfall sayable, not smaller.
 * Widening retrieval is a separate question with its own cost, and answering a
 * framing defect by loading more data is how a prompt-size problem is born.
 */

/**
 * The temporal claim the user's words make.
 *
 * Distinct from the interval it resolves to, because several of these do not
 * resolve to one at all. ALL_TIME denotes "every transaction that exists",
 * which no bounded query can discharge; RECENT denotes a vague nearness that a
 * product may legitimately DEFINE. Both previously arrived as `undefined` and
 * became the same 90-day window, which is why neither could be answered
 * honestly.
 */
export const TemporalRequests = {
  /** A named calendar month — "last month", "this month". */
  CALENDAR_MONTH: 'CALENDAR_MONTH',
  /** A named calendar year — "in 2024", "last year", "previous year". */
  CALENDAR_YEAR:  'CALENDAR_YEAR',
  /**
   * A calendar quarter — "last quarter", "this quarter", "quarter to date".
   *
   * CF-3 — the one genuinely new kind. Every other phrase this slice adds is
   * representable by an existing request: "last year" is a CALENDAR_YEAR,
   * "past year" is LAST_N_MONTHS with n=12. A quarter had no representation at
   * all, and collapsing it into "3 months" would erase the distinction the
   * user is making — a calendar quarter has fixed boundaries, a trailing three
   * months does not, and on 27 August those two intervals share no day.
   */
  CALENDAR_QUARTER: 'CALENDAR_QUARTER',
  /** Year to date. */
  YTD:            'YTD',
  /** "last N months". */
  LAST_N_MONTHS:  'LAST_N_MONTHS',
  /** An explicit two-ended range — "between March and May". */
  EXPLICIT_RANGE: 'EXPLICIT_RANGE',
  /** Open-left: everything before a date. */
  BEFORE_DATE:    'BEFORE_DATE',
  /** Open-right: everything from a date onward. */
  AFTER_DATE:     'AFTER_DATE',
  /** "ever", "all time", "in total", "since I started". */
  ALL_TIME:       'ALL_TIME',
  /** "recently", "lately" — vague nearness the product interprets. */
  RECENT:         'RECENT',
  /** "currently", "right now" — the present, as a period. */
  CURRENT:        'CURRENT',
  /**
   * CF-3 — TEMPORAL LANGUAGE WAS PRESENT AND COULD NOT BE RESOLVED.
   *
   * The state that makes this contract safe against its own vocabulary. CF-2
   * had two readings of "the parser produced nothing": no period was named, or
   * a period was named in words no rule covers. It treated both as UNSPECIFIED,
   * which means "nothing was asked" — and therefore "nothing can be unmet". On
   * eight of eleven measured phrases ("last year", "last quarter", "past
   * quarter", "this quarter", "quarter to date"…) the prompt then read:
   *
   *     The user asked about no particular period.
   *     The loaded period FULLY COVERS what was asked. Answer directly, with
   *     no scope caveat.
   *
   * A confident instruction to answer ninety days as last year. Worse than the
   * silence CF-2 replaced, because it is an assertion.
   *
   * UNRESOLVED is never satisfiable. A window may still be selected so the
   * answer is useful, but the prompt must say the requested period could not be
   * pinned down, and the model must not present the default as the answer.
   *
   * This exists so the contract does not depend on having enumerated every
   * human temporal phrase forever. New phrasings degrade to honest uncertainty
   * rather than to confident error.
   */
  UNRESOLVED:     'UNRESOLVED',
  /** No temporal claim at all. The default window is not a substitution here. */
  UNSPECIFIED:    'UNSPECIFIED',
} as const;

export type TemporalRequest = typeof TemporalRequests[keyof typeof TemporalRequests];

/** Why the selected interval is what it is. */
export const SelectionReasons = {
  /** The request named it and it was served unchanged. */
  AS_REQUESTED:    'AS_REQUESTED',
  /** A declared product interpretation of vague wording ("recently" = 90d). */
  INTERPRETED:     'INTERPRETED',
  /** The defensive maximum-lookback clamp moved the floor. */
  LOOKBACK_CLAMP:  'LOOKBACK_CLAMP',
  /** No temporal request; the standing default window. */
  DEFAULT_WINDOW:  'DEFAULT_WINDOW',
  /** A request the router cannot express as a bounded query. */
  UNSERVABLE:      'UNSERVABLE',
} as const;

export type SelectionReason = typeof SelectionReasons[keyof typeof SelectionReasons];

/** What bounded the evidence inside the selected interval, if anything. */
export const CoverageBounds = {
  /** The row fetch cap bit; the oldest part of the interval is missing. */
  FETCH_CAP: 'FETCH_CAP',
} as const;

export type CoverageBound = typeof CoverageBounds[keyof typeof CoverageBounds];

/** The temporal claim, as the user's words make it. */
export interface RequestedScope {
  intent: TemporalRequest;
  /** The user's phrase, for quoting back — "in 2024", "before June 2024". */
  label:  string;
  /**
   * What the words denote, when they denote a bounded interval.
   *
   * Null bounds are meaningful, not missing: BEFORE_DATE has no floor and
   * ALL_TIME has neither. That is precisely what makes them unservable, and
   * flattening them to a default interval is the substitution CF-0 caught.
   */
  startDate: string | null;
  endDate:   string | null;
}

/** The interval actually queried. */
export interface SelectedScope {
  startDate: string;
  endDate:   string;
  days:      number;
  reason:    SelectionReason;
  /**
   * The product's stated reading of vague wording — "trailing 90 days".
   *
   * Present only for INTERPRETED. It is what turns a substitution into a
   * declaration: the model may then say "over the last 90 days" and be right,
   * rather than saying "recently" and hoping.
   */
  interpretation: string | null;
}

/** What the retrieved evidence supports inside the selected interval. */
export interface EvidenceCoverage {
  /** Earliest date the evidence covers. Narrower than `selected` under a cap. */
  fromDate: string;
  toDate:   string;
  transactionCount: number;
  /** What cut the coverage short, or null when it spans the whole interval. */
  boundedBy: CoverageBound | null;
}

/**
 * The four authorities, together.
 *
 * `coverage` is null when no transaction evidence was assembled at all — which
 * is NOT the same as zero transactions, and §7 of this slice exists because
 * those two were indistinguishable.
 */
export interface TemporalScope {
  requested: RequestedScope;
  selected:  SelectedScope;
  coverage:  EvidenceCoverage | null;
}

/**
 * Does the selected interval discharge the request?
 *
 * Derived from the two intervals every time it is asked. A request with no
 * bounded denotation (ALL_TIME, BEFORE_DATE with no reachable floor) can never
 * be satisfied by a bounded window, and says so by construction.
 *
 * RECENT and CURRENT ARE satisfiable: the product defines them, so an interval
 * matching that definition discharges them completely. Treating a declared
 * interpretation as a shortfall would teach the model to hedge every ordinary
 * question, which is how a truthful system becomes a useless one.
 */
export function isRequestSatisfied(scope: TemporalScope): boolean {
  const { requested, selected } = scope;

  // Nothing was assembled at all. Whatever interval was nominally selected, it
  // discharged nothing — measured case: "How much did I spend in 2023?" clamps
  // to a floor after its own ceiling, returns no rows, and the domain is
  // dropped. Reporting that as satisfied would license the model to answer.
  if (scope.coverage === null && requested.intent !== TemporalRequests.UNSPECIFIED) {
    return false;
  }

  switch (requested.intent) {
    case TemporalRequests.UNSPECIFIED:
      // No claim was made, so none can be unmet.
      return true;
    case TemporalRequests.RECENT:
    case TemporalRequests.CURRENT:
      // Satisfied by the product's own declared reading, not by matching dates.
      return selected.reason === SelectionReasons.INTERPRETED
          || selected.reason === SelectionReasons.DEFAULT_WINDOW;
    case TemporalRequests.ALL_TIME:
      // No bounded window is all of history. Never satisfied, by definition.
      return false;
    case TemporalRequests.UNRESOLVED:
      // CF-3 — a period was asked for and we could not work out which one.
      // Nothing can be shown to discharge a request whose bounds are unknown,
      // so this is unsatisfied by construction rather than by comparison.
      return false;
    default:
      // A denoted interval is satisfied only when the selection covers it whole.
      if (requested.startDate === null || requested.endDate === null) return false;
      return selected.startDate <= requested.startDate
          && selected.endDate   >= requested.endDate;
  }
}

/**
 * The evidence covers the whole selected interval.
 *
 * Deliberately NOT about the request — a fetch cap can bite inside a perfectly
 * satisfied window, and conflating the two would let one disclosure erase the
 * other. Same independence CF-1 required between a satisfied window and a
 * bounded merchant list.
 */
export function isCoverageComplete(scope: TemporalScope): boolean {
  const { selected, coverage } = scope;
  if (coverage === null) return false;
  return coverage.boundedBy === null && coverage.fromDate <= selected.startDate;
}

/**
 * ── §7 — WHAT A ZERO MAY MEAN ───────────────────────────────────────────────
 *
 * "No rows came back" and "you had no transactions" are different sentences,
 * and only one of them is ever safe to say. The assembler currently returns
 * null for an empty result, which destroys the distinction: an inverted window
 * (the 2023 case, where the clamp floor lands after the requested ceiling) and
 * a genuinely quiet month arrive identically.
 */
export const EvidenceStates = {
  /** Complete interval, rows present. Ordinary. */
  PRESENT:            'PRESENT',
  /** Complete interval, zero rows. The ONLY state licensing "no activity". */
  COMPLETE_AND_EMPTY: 'COMPLETE_AND_EMPTY',
  /** Bounded interval, zero rows returned. Silence proves nothing. */
  BOUNDED_AND_EMPTY:  'BOUNDED_AND_EMPTY',
  /** The requested interval was never queried. */
  NOT_SUPPLIED:       'NOT_SUPPLIED',
  /** No transaction evidence was assembled at all. */
  UNAVAILABLE:        'UNAVAILABLE',
} as const;

export type EvidenceState = typeof EvidenceStates[keyof typeof EvidenceStates];

/**
 * Classify what the evidence permits to be said.
 *
 * The one rule worth stating out loud: a zero licenses a no-activity claim ONLY
 * from COMPLETE_AND_EMPTY. Every other empty state is an absence of evidence,
 * and absence of evidence rendered as "$0" is a fabricated fact.
 */
export function classifyEvidence(scope: TemporalScope): EvidenceState {
  const { coverage } = scope;
  if (coverage === null) {
    return isRequestSatisfied(scope)
      ? EvidenceStates.UNAVAILABLE
      : EvidenceStates.NOT_SUPPLIED;
  }
  if (coverage.transactionCount > 0) return EvidenceStates.PRESENT;
  return isCoverageComplete(scope)
    ? EvidenceStates.COMPLETE_AND_EMPTY
    : EvidenceStates.BOUNDED_AND_EMPTY;
}

/**
 * Fill in the product's declared reading of vague wording.
 *
 * The assembler knows the interval; it does not own the SENTENCE said about it,
 * and putting the phrasing there would scatter product wording through a query
 * layer. So the interval arrives with `interpretation: null` and acquires one
 * here, from the only two requests that need it.
 *
 * Note what this is NOT: an apology. A declared interpretation is a complete
 * answer to "what have I spent recently", and marking it as a shortfall would
 * make the model hedge the most ordinary question a user can ask.
 */
export function withInterpretation(scope: TemporalScope): TemporalScope {
  const { requested, selected } = scope;
  const needs = requested.intent === TemporalRequests.RECENT
             || requested.intent === TemporalRequests.CURRENT;
  if (!needs || selected.interpretation !== null) return scope;
  return {
    ...scope,
    selected: { ...selected, interpretation: `the trailing ${selected.days} days` },
  };
}

/**
 * The scope for a context where NO transaction evidence was assembled.
 *
 * The assembler returns null on an empty result, which erases the difference
 * between "you had no transactions" and "nothing was loaded". Measured case:
 * "How much did I spend in 2023?" clamps the floor to 2024-06-18, producing a
 * window whose start is AFTER its end — zero rows, domain dropped, and a prompt
 * containing no transaction section at all for a perfectly well-formed
 * question. The model was left to answer from nothing.
 *
 * `coverage: null` is the carrier of that distinction, and `classifyEvidence`
 * turns it into NOT_SUPPLIED or UNAVAILABLE depending on whether a period was
 * even asked for.
 */
export function unsuppliedScope(requested: RequestedScope): TemporalScope {
  return {
    requested,
    selected: {
      startDate: requested.startDate ?? '(none)',
      endDate:   requested.endDate   ?? '(none)',
      days:      0,
      reason:    requested.intent === TemporalRequests.UNSPECIFIED
        ? SelectionReasons.DEFAULT_WINDOW
        : SelectionReasons.UNSERVABLE,
      interpretation: null,
    },
    coverage: null,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const REQUEST_PHRASE: Record<TemporalRequest, string> = {
  CALENDAR_MONTH: 'a specific calendar month',
  CALENDAR_YEAR:  'a specific calendar year',
  CALENDAR_QUARTER: 'a specific calendar quarter',
  YTD:            'the year to date',
  LAST_N_MONTHS:  'a trailing number of months',
  EXPLICIT_RANGE: 'an explicit date range',
  BEFORE_DATE:    'everything BEFORE a date',
  AFTER_DATE:     'everything FROM a date onward',
  ALL_TIME:       'their ENTIRE transaction history',
  RECENT:         'recent activity (no dates given)',
  CURRENT:        'current activity (no dates given)',
  UNRESOLVED:     'a period this system could not identify',
  UNSPECIFIED:    'no particular period',
};

/** The requested interval as text, including its open ends. */
function requestedInterval(r: RequestedScope): string {
  if (r.startDate && r.endDate) return `${r.startDate} to ${r.endDate}`;
  if (r.endDate)   return `everything up to ${r.endDate}`;
  if (r.startDate) return `${r.startDate} onward`;
  return 'no bounded interval';
}

/**
 * The temporal-scope block, as the model reads it.
 *
 * Written so the three facts cannot be conflated by a careless reader: the ask,
 * the selection, and the verdict each get their own line, and the verdict names
 * what may NOT be concluded rather than merely flagging a mismatch. A warning
 * the model has to interpret is a warning it can interpret away.
 */
export function describeTemporalScope(scope: TemporalScope): string[] {
  const lines: string[] = [];
  const { requested, selected, coverage } = scope;
  const satisfied = isRequestSatisfied(scope);
  const state = classifyEvidence(scope);

  lines.push('TRANSACTION SCOPE — what was asked for, and what was actually loaded:');
  lines.push(
    requested.intent === TemporalRequests.UNSPECIFIED
      ? `  The user asked about ${REQUEST_PHRASE[requested.intent]}.`
      // CF-3 — an unresolved request has no interval to state, and quoting the
      // label back would echo a placeholder. Say what happened instead.
      : requested.intent === TemporalRequests.UNRESOLVED
        ? '  The user\'s question refers to a period, and this system could not determine which one.'
        : `  The user asked about ${REQUEST_PHRASE[requested.intent]} ("${requested.label}" — ${requestedInterval(requested)}).`,
  );
  lines.push(
    coverage === null
      ? '  Transactions loaded: NONE. No transaction evidence was assembled for this conversation.'
      : `  Transactions loaded for: ${selected.startDate} to ${selected.endDate} (${selected.days} days).`,
  );

  if (selected.interpretation) {
    lines.push(
      `  "${requested.label}" has no dates of its own, so this system reads it as ` +
      `${selected.interpretation}. That is a DELIBERATE product interpretation, not a limitation — ` +
      'answer normally, and name the actual dates when the period matters.',
    );
  }

  if (satisfied) {
    if (!selected.interpretation) {
      lines.push('  The loaded period FULLY COVERS what was asked. Answer directly, with no scope caveat.');
    }
  } else if (requested.intent === TemporalRequests.UNRESOLVED) {
    // CF-3 — a DIFFERENT sentence from a shortfall. A shortfall compares two
    // known intervals; here the requested one is unknown, so there is nothing
    // to compare and nothing to quantify. Saying "does not cover" would imply
    // we know what it failed to cover.
    lines.push('  ⚠ The requested period could NOT be resolved to dates.');
    if (coverage !== null) {
      lines.push(
        `  The figures below cover ${selected.startDate} to ${selected.endDate}. That is this ` +
        "system's DEFAULT period — not the period the user asked about.",
      );
      lines.push(
        '  Your reply MUST do all three of these, in this order:',
      );
      lines.push(
        '    1. Say FIRST that you could not work out which dates the question refers to.',
      );
      lines.push(
        `    2. Then give the figures, naming ${selected.startDate} to ${selected.endDate} as the ` +
        'period they describe.',
      );
      lines.push(
        '    3. Ask which dates the user means.',
      );
      lines.push(
        '  Do NOT present these figures as the answer to the question as asked, and do NOT open ' +
        'with the numbers.',
      );
    }
  } else {
    lines.push(
      `  ⚠ The loaded period DOES NOT COVER what was asked` +
      (selected.reason === SelectionReasons.LOOKBACK_CLAMP
        ? ` — this system does not load transactions from before ${selected.startDate}.`
        : selected.reason === SelectionReasons.UNSERVABLE
          ? ' — this system cannot query that period at all.'
          : '.'),
    );
    if (coverage !== null) lines.push(
      '  Every spending, income, category, merchant and cash-flow figure below describes ONLY ' +
      `${selected.startDate} to ${selected.endDate}. Do NOT present any of them as the answer to ` +
      `"${requested.label}", do NOT label a figure with the requested period, and do NOT extrapolate ` +
      'one from the other. State plainly which period you can actually speak for, give that figure, ' +
      'and say the rest was not loaded into this conversation. Older transactions may well exist.',
    );
  }

  // Coverage is a SECOND, independent limitation. A satisfied window can still
  // be short of evidence, and both statements must survive together.
  if (coverage && coverage.boundedBy === CoverageBounds.FETCH_CAP) {
    lines.push(
      `  ⚠ Within that period, evidence covers only ${coverage.fromDate} to ${coverage.toDate} ` +
      '— the row limit was reached, so the oldest part is missing even though the period was loaded.',
    );
  }

  switch (state) {
    case EvidenceStates.COMPLETE_AND_EMPTY:
      lines.push(
        '  Zero transactions, over a period whose evidence IS complete. You may say there was no ' +
        'recorded activity in it.',
      );
      break;
    case EvidenceStates.BOUNDED_AND_EMPTY:
      lines.push(
        '  ⚠ Zero transactions returned, but this evidence is NOT complete for the period. ' +
        'That is an absence of evidence, not evidence of absence: do NOT say there was no ' +
        'activity, and do NOT report $0. Say the data was not available.',
      );
      break;
    case EvidenceStates.NOT_SUPPLIED:
      lines.push(
        '  ⚠ NO transaction evidence was loaded for the requested period. Do NOT answer the ' +
        'question from any other period, and do NOT report a total or a $0. Say plainly that ' +
        'transactions for that period were not loaded into this conversation.',
      );
      break;
    case EvidenceStates.UNAVAILABLE:
      lines.push(
        '  ⚠ No transaction evidence is available in this context. Do not state spending, income ' +
        'or category figures at all.',
      );
      break;
    default:
      break;
  }

  return lines;
}
