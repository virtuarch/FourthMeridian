/**
 * lib/reasoning/answer/schema.ts
 *
 * V26-REASONING Slice 1 — the JSON Schema the provider enforces.
 *
 * ⚠️ `strict: true`, WHICH MEANS EVERY PROPERTY IS REQUIRED AND
 * `additionalProperties` IS FALSE — AND THAT IS ALL IT MEANS. This header used to
 * claim it made `claims: []` beside a prose full of numbers "unrepresentable at
 * the provider". It does not: `strict` forbids MISSING and EXTRA properties, and
 * says nothing about an empty array. The claim was wrong, an audit caught it,
 * and the real defence is the verifier's anti-vacuity rule plus the `withheld`
 * field below.
 */

export const ANSWER_SCHEMA = {
  name: 'financial_answer',
  schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        description:
          'One entry for EVERY amount, month count and percentage written in '
          + '`prose` — without exception, including figures you are quoting back '
          + 'to the user and figures mentioned in passing. Write the prose first, '
          + 'then read it back and add one entry per figure you find. An answer '
          + 'whose prose contains a figure that is not listed here is discarded '
          + 'in full. DATES ARE NOT FIGURES: do not list "August 28", "2026-12-31" '
          + 'or a day count here — only money, month counts and percentages.',
        items: {
          type: 'object',
          properties: {
            fid: {
              type: 'string',
              description: 'The id from the FIGURES table, exactly as printed.',
            },
            statedAs: {
              type: 'string',
              description:
                'The figure exactly as it appears in your prose, character for '
                + 'character, including the currency symbol, any minus sign, and '
                + 'any per-period suffix. "$5,000/month" and "$5,000" are '
                + 'different statements, and so are "-$4,000.00" and "$4,000.00".',
            },
            frame: {
              type: 'string',
              enum: ['FACT', 'ASSUMPTION'],
              description:
                'The authority your sentence gives this figure. FACT: you are '
                + 'asserting it as true of their money — "Your net worth is X". '
                + 'ASSUMPTION: you are supposing it, or quoting their own '
                + 'supposition back — "Assuming X…", "If we use your X…", "you\'d '
                + 'have Y". A figure listed under THE USER\'S OWN NUMBERS is '
                + 'their supposition, not a measurement, and may ONLY be '
                + 'ASSUMPTION — saying "you have X" of a number they asked you to '
                + 'assume presents their guess back to them as a finding.',
            },
          },
          required: ['fid', 'statedAs', 'frame'],
          additionalProperties: false,
        },
      },
      prose: {
        type: 'string',
        description: 'The answer, in your own words.',
      },
      withheld: {
        type: ['string', 'null'],
        description:
          'ONLY when `claims` is empty: the WITHHELD subject you are speaking to, '
          + 'copied exactly from the WITHHELD block. Null whenever you state at '
          + 'least one figure. You may answer with no figures — a limitation, a '
          + 'refusal, something genuinely qualitative — but you may not reach a '
          + 'financial conclusion out of nothing, so if you state no figure you '
          + 'must name which withholding you are speaking to.',
      },
    },
    required: ['claims', 'prose', 'withheld'],
    additionalProperties: false,
  },
} as const satisfies { name: string; schema: Record<string, unknown> };
