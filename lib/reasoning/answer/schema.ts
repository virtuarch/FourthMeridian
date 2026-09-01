/**
 * lib/reasoning/answer/schema.ts
 *
 * V26-REASONING Slice 1 — the JSON Schema the provider enforces.
 *
 * ⚠️ `strict: true`, WHICH MEANS EVERY PROPERTY IS REQUIRED AND
 * `additionalProperties` IS FALSE. That is not pedantry: a schema the model may
 * partially satisfy is a schema that produces `claims: []` beside a prose full
 * of numbers, which is exactly the state the verifier would then have to reject.
 * Making it unrepresentable at the provider is cheaper than catching it.
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
                + 'character, including the currency symbol and any per-period '
                + 'suffix. "$5,000/month" and "$5,000" are different statements.',
            },
          },
          required: ['fid', 'statedAs'],
          additionalProperties: false,
        },
      },
      prose: {
        type: 'string',
        description: 'The answer, in your own words.',
      },
    },
    required: ['claims', 'prose'],
    additionalProperties: false,
  },
} as const satisfies { name: string; schema: Record<string, unknown> };
