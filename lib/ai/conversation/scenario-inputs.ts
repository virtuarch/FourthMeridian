/**
 * lib/ai/conversation/scenario-inputs.ts   (I1 — Slice 1, readiness condition 1)
 *
 * THE SCENARIO ARGUMENT SCHEMA, AS ONE LITERAL TWO MODULES READ.
 *
 * ── Why this moved out of `tools.ts` ────────────────────────────────────────
 * `active-scenario.ts` carried a hand-written copy of this object's key list:
 *
 *     const ASSUMPTION_KEYS = ['annualReturnPct', 'returns', 'contributions',
 *       'outflows', 'assumedMonthlySpending', 'liabilityAssumptions'] as const;
 *
 * It decides whether a `scenario_crossing` call states a HYPOTHESIS or merely
 * reads the current trend — and a crossing that states nothing hypothetical is
 * IGNORED, deliberately, so a baseline question cannot replace the scenario a
 * conversation has just built.
 *
 * ⚠️ SO AN ARGUMENT MISSING FROM THAT LIST FAILS IN THE WORST DIRECTION. It is
 * not dropped from continuity — the arguments are preserved verbatim. It makes a
 * crossing that carries ONLY that argument look like a baseline reading, so the
 * PREVIOUS scenario survives a question that changed the world, and the model is
 * handed a stale result wearing a fresh label. An I1 `incomeChanges` left off the
 * list would do exactly that.
 *
 * ⚠️ AND IT COULD NOT BE DERIVED WHERE IT STOOD, because `SCENARIO_INPUTS` was
 * module-local to a 182 KB file full of database reads. Extracting it here — pure,
 * import-free, no clock, no I/O — is what lets the continuity policy be READ OFF
 * the schema the model was shown instead of typed out a second time.
 *
 * ⚠️ NOT THE TOOLS' OWN `parameters`, WHICH WOULD BE WRONG AND NOT MERELY WIDER.
 * `scenario_crossing.parameters` also declares `metric`, `direction`, `threshold`
 * and `searchThrough` — which EVERY crossing carries — so deriving from it would
 * make `carriesAssumptions` true always, destroy the IGNORE branch, and reinstate
 * the measured defect ("a baseline crossing REPLACED the sweep scenario the
 * conversation had just built"). The shared inputs are the right object; the
 * per-tool question fields are not assumptions about the world.
 */

const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

/** The scenario arguments every scenario tool accepts, so the model states them one way. */
export const SCENARIO_INPUTS = {
  granularity: { type: 'string', enum: ['monthly', 'quarterly', 'yearly'],
    description: 'How often the table has a row: monthly = every month-end, quarterly = every '
      + 'quarter-end, yearly = every 31 December; the horizon is always the last row. Use the '
      + 'cadence the user asked for ("quarterly table" = quarterly). Omit for the default: '
      + 'monthly within 18 months, quarterly to about 20 years, yearly beyond. A cadence that '
      + 'would exceed the row ceiling is returned one step coarser and the result says so '
      + 'under `horizon.requested` / `horizon.omitted`.' },
  annualReturnPct: num('One flat annual return for the whole horizon, e.g. 8. Default 0 — the '
    + 'no-growth baseline. Use the rate the user stated; when they invited one without naming '
    + 'it ("say, some return"), run an illustration and say in the answer which rate it was. '
    + 'Ignored when `returns` is given.'),
  returns: { type: 'array', description: 'Per-period returns, when the user gave different '
    + 'rates for different years. Periods must not overlap.',
    items: obj({ from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD, inclusive'),
      annualPct: num('e.g. 50 for "50% in 2028"') }, ['from', 'to', 'annualPct']) },
  contributions: { type: 'array',
    description: 'Money moved from cash into investments OR toward a liability (`target`). HOW MUCH — exactly one of four: '
      + '`amount` in dollars, `fractionOfLiquid` for a share of the cash BALANCE, '
      + '`surplusFraction` for a share of what each month ADDS, or `liquidFloor` + '
      + '`fractionOfExcess` for a share of the cash held ABOVE A FLOOR (the floor in dollars, or '
      + 'as `liquidFloorMonthsOfExpenses` for "keep six months of expenses"). WHEN: `amount` and '
      + '`fractionOfLiquid` need either `onDate` for a one-off or `from` + `cadence` for a '
      + 'schedule; `surplusFraction` and the floor pair are monthly by nature and need neither.',
    items: obj({
      amount:  num('A dollar amount. Positive moves cash into investments; negative takes '
        + 'it back out. Do NOT put a fraction here.'),
      fractionOfLiquid: num('A share of the projected cash BALANCE on each date: 0.5 for '
        + '"half my liquidity", 1 for "everything I have". The dollar amount differs at every '
        + 'date and only the projection knows it.'),
      surplusFraction: num('A share of what each month ADDS: 0.75 for "invest three quarters '
        + 'of the cash I am putting aside", 1 for "invest everything I save". This is the one '
        + 'for "invest some of the growing cash" — it never touches the balance the user '
        + 'already has, and a month that projects no gain contributes nothing. It runs at '
        + 'every month-end: give `from`/`to` only to start or stop it early, and never a '
        + '`cadence` or an `onDate`. The engine has no default share: when the user named one '
        + '("75%", "half") use it; when they said only "some" or "most", choose a share, run it, '
        + 'and say in the answer which share it was. It keeps NO cash floor: it moves its share '
        + 'every month whatever the balance is. When the user also wants cash kept (a buffer, $X '
        + 'liquid, N months of expenses), what is left to move is the cash ABOVE that floor — use '
        + '`liquidFloor` or `liquidFloorMonthsOfExpenses` + `fractionOfExcess` with the same '
        + '`target`, not this.'),
      liquidFloor: num('The cash balance to KEEP, in DOLLARS THE USER STATED: 50000 for "keep $50k '
        + 'liquid". When the user said it in months of expenses, use `liquidFloorMonthsOfExpenses` '
        + 'instead and do not convert it to dollars yourself. '
        + 'Goes with `fractionOfExcess`. This is the one for "once I have X in cash, invest '
        + 'what is above it", "keep a buffer of X and invest the rest", "everything above X": '
        + 'at each month-end the share of cash above the floor moves into investments and '
        + 'cash is left AT the floor; while cash is at or below the floor nothing moves. It '
        + 'starts on its own the first month-end the balance is above the floor — do not '
        + 'derive a start date and pass `from`; do not use `surplusFraction` for this.'),
      liquidFloorMonthsOfExpenses: num('The floor as MONTHS OF EXPENSES instead of dollars: 6 for '
        + '"keep six months of expenses in cash". Resolved in code by the same monthly spending this '
        + 'scenario runs at (`assumedMonthlySpending` when the user stated one, else the observed '
        + 'level) and echoed under `floorRule.derivedFrom` with the dollars it became. Use INSTEAD of '
        + '`liquidFloor`, never both, and never multiply spending by months yourself. Goes with '
        + '`fractionOfExcess` exactly as `liquidFloor` does.'),
      fractionOfExcess: num('The share of cash ABOVE `liquidFloor` to move each month-end: 1 '
        + 'for "everything above it", 0.5 for "half of what is above it". Goes with '
        + '`liquidFloor` or `liquidFloorMonthsOfExpenses`.'),
      target: { description: 'WHERE the money goes. `investments` (the default), '
          + '`highest_apr` (the liability with the highest known rate first — the avalanche; '
          + 'when it is cleared the same month\'s remainder continues to the next), or a '
          + 'liability account id from get_financial_snapshot. An ORDERED LIST waterfalls: '
          + '["highest_apr","investments"] pays debt while any remains and invests the rest '
          + '— "pay the cards first, then invest" in one scenario. A payment never exceeds the '
          + 'balance; what is left over stays in cash unless a later target takes it. This '
          + 'allocates cash the user already has — it is NOT a way to borrow.',
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      onDate:  str('YYYY-MM-DD for a single contribution.'),
      from:    str('YYYY-MM-DD first occurrence of a repeating contribution.'),
      to:      str('YYYY-MM-DD last occurrence. Omit to continue to the horizon.'),
      cadence: { type: 'string', enum: ['monthly', 'yearly'] },
      label:   str('Optional short NAME for a fixed `amount` ("Roth IRA"). Never applied, and never '
        + 'a rule: the result names every rule from its fields, so a condition written only here '
        + 'does not run.'),
    }) },
  outflows: { type: 'array',
    description: 'One-off cash leaving entirely — a car, a trip, a tax bill. Use a NEGATIVE '
      + 'amount for a one-off inflow such as a bonus.',
    items: obj({ onDate: str('YYYY-MM-DD'), amount: num('Positive = cash out.'),
      label: str('What it is.') }, ['onDate', 'amount']) },
  assumedMonthlySpending: num('If the user stated a monthly spending level, pass it here — '
    + 'it changes the cash spine exactly as it does in project_cash.'),
  // ── I1 — dated changes to FUTURE income ────────────────────────────────────
  //
  // ⚠️ THE ROUTING BOUNDARY IS IN THE DESCRIPTION, NOT ON A FIELD. Measured on
  // the one-off capability (54eb8e1): a boundary written on a PARAMETER is read
  // only after the tool has already been chosen, and the model kept choosing the
  // wrong tool 9/10. So the sentences that decide WHEN this applies lead here.
  incomeChanges: { type: 'array',
    description: 'A dated change to FUTURE income — a raise, a new salary, an income '
      + 'starting, an income ending. Use this whenever the user says income changes from a '
      + 'date: "starting January my income goes up 10%", "my salary goes to $180k in March", '
      + '"my contract ends in June", "I start consulting in February at $3,000 a month". The '
      + 'change is executed by the projection, which reports which pay dates it actually '
      + 'altered — do NOT compute a new income figure yourself, do NOT convert a yearly '
      + 'salary into a monthly one, and do NOT apply a percentage in prose. A one-off amount '
      + 'arriving on a date (a bonus, a settlement) is NOT this: use `outflows` with a '
      + 'negative amount. A change to SPENDING is not this either and cannot be modelled — '
      + 'say so rather than describing it as included.',
    items: obj({
      op: { type: 'string', enum: ['SCALE', 'SET_RATE', 'STOP', 'START'],
        description: 'SCALE for a percentage change ("up 10%"). SET_RATE when the user states '
          + 'what the income BECOMES ("goes to $180k", "I make $15k a month"). STOP when an '
          + 'income ends. START for an income that does not exist yet.' },
      source: str('WHICH income, as a `sourceKey` from get_pay_dates or get_income — never a '
        + 'name you composed. Omit it only when the user meant income as a whole ("my income '
        + 'goes up 10%"); an omitted source scales EVERY stream, and for SET_RATE or STOP it '
        + 'is refused when there is more than one income, because "I make $15k a month" could '
        + 'mean one of them or all of them. Never guess which transactions are the salary.'),
      from: str('YYYY-MM-DD, INCLUSIVE — the first pay date the change applies to. '
        + '"Starting January" is January 1 of the next January. For STOP this is the first '
        + 'date NOT paid, so "stops after June" is July 1.'),
      to: str('YYYY-MM-DD, inclusive. Omit to continue to the horizon.'),
      multiplier: num('SCALE only. 1.1 for "up 10%", 0.8 for "a 20% pay cut". Not a percentage. '
        + 'A SCALE needs nothing else: no `amount`, no `per`, no `cadence`.'),
      amount: num('SET_RATE and START only. What the income BECOMES, as the user stated it — '
        + 'do not annualise or monthly-ise it yourself; say which period it is in `per`.'),
      per: { type: 'string', enum: ['YEAR', 'MONTH', 'OCCURRENCE'],
        description: 'What `amount` is per. A salary of $180k = YEAR. Earning $15k a month = '
          + 'MONTH. Being paid $3,000 a paycheck = OCCURRENCE. The projection converts it '
          + 'against that '
          + 'stream\'s own pay schedule — a yearly figure on a fortnightly job is divided by '
          + '26, not by 12.' },
      basis: { type: 'string', enum: ['NET', 'GROSS'],
        description: 'NET is take-home; GROSS is before deductions. REQUIRED on SET_RATE and '
          + 'START, and never guessed: a gross figure is real money but is NOT cash the user '
          + 'can spend, so it does not raise the projected balance — if the user did not say, '
          + 'ask. Optional on SCALE, where it says what the raised income is; omit it and the '
          + 'income keeps whatever it already was, which is usually right.' },
      cadence: { type: 'string', enum: ['WEEKLY', 'BIWEEKLY', 'MONTHLY'],
        description: 'START only — how often the new income arrives. An existing income keeps '
          + 'its own observed schedule and must not be given one here.' },
      label: str('START only. A short NAME for the new income ("consulting"). Never a rule.'),
    }, ['op', 'from']) },
  liabilityAssumptions: { type: 'array',
    description: 'Terms the user STATED for an existing liability, for this scenario only: '
      + '"assume the card is at 18%", "my minimum is $300". Overrides that liability\'s known '
      + 'term; never changes the account. Use it when a liability shows apr or minimumPayment '
      + 'null and the user supplies one — never invent a rate yourself.',
    items: obj({ liabilityId: str('The liability account id from get_financial_snapshot.'),
      apr: num('Percent per year, 0–100. 0 is a real rate (no interest).'),
      minimumPayment: num('Per-cycle minimum in dollars, 0 or more.') }, ['liabilityId']) },
};

// ── The continuity policy, derived ───────────────────────────────────────────

/**
 * Arguments that are NOT a hypothesis about the world — the CLOSED exception list.
 *
 * ⚠️ AN ARGUMENT NOT NAMED HERE COUNTS AS AN ASSUMPTION, and the default runs that
 * way on purpose. Getting it wrong in this direction makes a crossing REPLACE the
 * scenario when it might merely have read a trend — the conversation loses a
 * hypothetical it could restate. Getting it wrong the other way leaves a STALE
 * result standing after the world changed, and hands it to the model as the
 * current answer. Only one of those two mistakes is recoverable by asking again.
 *
 * `granularity` is presentation: how often the table has a row. It changes no
 * figure in it. That is the whole of the exception list, and a test pins it.
 */
export const NOT_AN_ASSUMPTION: readonly string[] = ['granularity'];

/**
 * The scenario inputs that make a call a hypothetical rather than a reading of the
 * current trend — read off the SAME object the model was shown.
 */
export function scenarioAssumptionKeys(
  schema: Record<string, unknown> = SCENARIO_INPUTS,
  except: readonly string[] = NOT_AN_ASSUMPTION,
): string[] {
  return Object.keys(schema).filter((k) => !except.includes(k));
}
