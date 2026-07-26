/**
 * lib/debt/effective-terms.ts
 *
 * V26-PRE (B3) — THE authority for effective debt terms (APR / minimum
 * payment).
 *
 * Two writable homes exist for the same fact:
 *   - `FinancialAccount.interestRate` / `.minimumPayment` (legacy flat columns,
 *     written by PATCH /api/accounts/[id])
 *   - `DebtProfile.apr` / `.minimumPayment` (richer source, written by
 *     PATCH /api/accounts/[id]/debt-profile)
 *
 * The precedence rule — DebtProfile wins when present, flat column otherwise —
 * previously lived duplicated in `lib/data/accounts.ts` and
 * `lib/ai/assemblers/accounts.ts`, and was MISSING from the Space account
 * loader (`lib/space/mount-composition.ts`), so Space debt widgets computed
 * interest and payoff timelines from a superseded APR the moment a user
 * corrected it in the debt profile. One fact, one resolution rule, one owner:
 * this module. Consumers must not re-derive `apr`/`minimumPayment` from the
 * raw columns — a source-scan guard (effective-terms.test.ts) pins that.
 *
 * `??` semantics are deliberate: an explicit 0 in the profile is a real value
 * and wins; only null/undefined falls through to the flat column.
 */

/** Minimal source shape — satisfied by any Prisma FinancialAccount row that
 *  selected the flat columns and (optionally) joined debtProfile. */
export interface DebtTermsSource {
  interestRate?:   number | null;
  minimumPayment?: number | null;
  debtProfile?: {
    apr?:            number | null;
    minimumPayment?: number | null;
  } | null;
}

export interface EffectiveDebtTerms {
  /** Effective APR (percent, e.g. 19.99). Null when neither source has one. */
  apr:            number | null;
  /** Effective minimum payment. Null when neither source has one. */
  minimumPayment: number | null;
}

/** Resolve the effective APR + minimum payment. DebtProfile > flat column. */
export function resolveEffectiveDebtTerms(src: DebtTermsSource): EffectiveDebtTerms {
  const profile = src.debtProfile ?? null;
  return {
    apr:            profile?.apr            ?? src.interestRate   ?? null,
    minimumPayment: profile?.minimumPayment ?? src.minimumPayment ?? null,
  };
}
