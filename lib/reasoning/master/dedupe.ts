/**
 * lib/reasoning/master/dedupe.ts
 *
 * V26-REASONING Slice 6 — THE ANSWER TO OVERLAPPING SPACES IS DEDUPLICATION,
 * NOT PROHIBITION.
 *
 * ── What master does today ──────────────────────────────────────────────────
 * `master-surfaces.ts:87` — `const forecastable = spaceIds.length === 1;`. With
 * two or more eligible Spaces a forecast question gets ~1,600 characters of
 * "You MUST NOT construct the projection yourself", and master is the entry
 * point most turns use. The reasoning behind it is sound as far as it goes:
 *
 *     "With two or more there is no deduplicated balance to project from."
 *
 * ⚠️ BUT THE PRODUCT ALREADY DEDUPLICATES, THREE LINES OF CODE AWAY.
 * `route.ts` computes `distinctAccountCount` as a set over every Space's
 * `accountIds`, and the Brief route does the same — "an account shared into two
 * Spaces counts once". What was missing was not the technique but the will to
 * apply it to BALANCES, and the refusal filled the gap.
 *
 * ── What this refuses, and why each refusal is real ─────────────────────────
 * Deduplication is only sound when the rows can be identified and their values
 * added. Four conditions make that false, and each one is a defect this
 * repository has already recorded once:
 *
 *   NO PER-ACCOUNT ROWS      a total is not a set; two totals cannot be unioned
 *   A NULL reportingBalance  V25-FINAL-1 — conversion UNAVAILABLE, never zero
 *   redactedCount > 0        a hidden account is not an absent one
 *   totalsUnconverted        the payload says its own totals are partial
 *
 * ⚠️ IT NEVER FALLS BACK TO ADDING THE TOTALS. That is the one thing a caller
 * might reach for when this refuses, and it is exactly the cross-Space sum over
 * overlapping accounts the whole product forbids.
 */

import { classifyAccounts } from '@/lib/account-classifier';
import { FinanceDomains, type AccountsSectionData, type AccountSummaryItem, type SpaceContext_AI } from '@/lib/ai/types';
import type { Refusal } from '../refusal';

export type MasterAccounts =
  | { ok: true; accounts: AccountsSectionData; distinctCount: number; sharedCount: number }
  | { ok: false; reason: Refusal };

const accountsOf = (c: SpaceContext_AI): AccountsSectionData | undefined =>
  c.domains?.[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined;

/**
 * One deduplicated accounts view over every Space the user can see, or a
 * refusal that names what stopped it.
 *
 * ⚠️ THE TOTALS COME FROM `classifyAccounts`, NOT FROM ARITHMETIC HERE. It is
 * the single authority for which type lands in which bucket — `isDigitalAssetAccountType`
 * lives inside it precisely so the crypto boundary has one owner — and a second
 * bucketing here would be a second opinion about what a "savings" account is.
 */
export function deduplicateMasterAccounts(
  contexts: readonly SpaceContext_AI[],
): MasterAccounts {
  if (contexts.length === 0) {
    return { ok: false, reason: { code: 'NO_EVIDENCE',
      detail: 'no Spaces were assembled, so there is nothing to compose' } };
  }

  const byId = new Map<string, AccountSummaryItem>();
  let placements = 0;
  let anyEstimated = false;

  for (const ctx of contexts) {
    const a = accountsOf(ctx);
    if (!a) {
      return { ok: false, reason: { code: 'NO_EVIDENCE',
        detail: `no account data was assembled for ${ctx.space?.name ?? 'one of your Spaces'}` } };
    }
    // ⚠️ A HIDDEN ACCOUNT IS NOT AN ABSENT ONE, and this is the same reasoning
    // `composeInvestments` already applies: a redacted row might be anything, so
    // a total computed without it is short by an unknown amount rather than
    // complete. Coarse on purpose — it errs toward silence.
    if ((a.redactedCount ?? 0) > 0) {
      return { ok: false, reason: { code: 'BLOCKED_BY_PERMISSION',
        detail: 'some accounts in these Spaces are not visible to you, so a combined '
          + 'total would be short by an amount nobody here can see' } };
    }
    if (a.totalsUnconverted === true) {
      return { ok: false, reason: { code: 'UNRELIABLE_EVIDENCE',
        detail: 'at least one balance could not be converted to your reporting currency, '
          + 'so a combined total would silently omit it' } };
    }
    if (!Array.isArray(a.accounts)) {
      return { ok: false, reason: { code: 'INSUFFICIENT_EVIDENCE',
        detail: 'the per-account rows needed to combine your Spaces without '
          + 'double-counting a shared account were not assembled' } };
    }
    if (a.totalsEstimated === true) anyEstimated = true;

    for (const row of a.accounts) {
      placements += 1;
      // ⚠️ `reportingBalance: null` IS "UNAVAILABLE", NEVER ZERO. V25-FINAL-1
      // made it nullable for exactly this reason — "so no consumer can read an
      // unavailable balance as worth 0" — and W-M3a is the memory of a
      // NOT-NULL-DEFAULT-0 column rendering a withheld account as $0.00.
      if (typeof row.reportingBalance !== 'number' || !Number.isFinite(row.reportingBalance)) {
        return { ok: false, reason: { code: 'UNRELIABLE_EVIDENCE',
          detail: 'one of your accounts has no value in your reporting currency, so a '
            + 'combined total would be missing it without saying so' } };
      }
      // ⚠️ PRIVACY-AGGREGATED ROWS CANNOT BE DEDUPLICATED. REVIEW-3 C-4 gives
      // them a SYNTHETIC id, so two different aggregates in two Spaces could
      // collide on it, or one aggregate could hide a row counted separately
      // elsewhere. Neither is detectable from here.
      if ('aggregate' in row && (row as { aggregate?: unknown }).aggregate) {
        return { ok: false, reason: { code: 'BLOCKED_BY_PERMISSION',
          detail: 'some accounts are shown to you in aggregate rather than '
            + 'individually, and an aggregate cannot be matched against the same '
            + 'account seen in another Space' } };
      }
      // The dedupe itself. An account shared into several Spaces is ONE account,
      // and the first placement is as good as any — they are the same row.
      if (!byId.has(row.id)) byId.set(row.id, row);
    }

    // ⚠️ THE ROWS MUST ACCOUNT FOR THE TOTALS, OR THEY ARE NOT THE POPULATION —
    // AND THIS CHECK EXISTS BECAUSE ITS ABSENCE PRODUCED A ZERO.
    //
    // Measured on the acceptance run: a Space whose payload declares
    // `totalDigitalAssets: 19,014.63` and `counts.digitalAssets: 4` carried NO
    // digital-asset rows in `accounts[]`, so recomputing from the rows returned
    // $0.00 — and the answer read "your digital assets are projected to be
    // $0.00, even if Bitcoin goes up 10%". That is the single most-repeated
    // defect in this repository's own record wearing a new costume: W6's
    // `nativeBalance ?? 0`, W-M3a's NOT-NULL-DEFAULT-0 column, "unknown is not
    // zero". An absent row is not an empty class.
    //
    // So each Space's own rows are checked against its own declared totals
    // before anything is unioned. Failing this is not a reason to fall back to
    // adding the totals — it is the reason there is no combined figure.
    const fromRows = classifyAccounts(a.accounts.map((r) => ({
      type: r.type, balance: (r.reportingBalance ?? 0),
    })));
    const declared: [number, number, string][] = [
      [fromRows.totalLiquid,        a.totalLiquid,        'liquid cash'],
      [fromRows.totalInvestments,   a.totalInvestments,   'investments'],
      [fromRows.totalDigitalAssets, a.totalDigitalAssets, 'digital assets'],
      [fromRows.totalRealAssets,    a.totalRealAssets,    'real assets'],
      [fromRows.totalLiabilities,   a.totalLiabilities,   'debt'],
    ];
    for (const [rows, total, what] of declared) {
      if (typeof total !== 'number' || !Number.isFinite(total)) continue;
      if (Math.abs(rows - total) > 0.01) {
        return { ok: false, reason: { code: 'INSUFFICIENT_EVIDENCE',
          detail: `the per-account rows for ${ctx.space?.name ?? 'one of your Spaces'} `
            + `do not add up to its stated ${what}, so they are not a complete list `
            + 'and combining them across Spaces would understate the total' } };
      }
    }
  }

  const rows = [...byId.values()];
  // ⚠️ CLASSIFIED IN REPORTING CURRENCY. `reportingBalance` is the ONLY field
  // valid for cross-account aggregation; native `balance`/`currency` are
  // account-detail facts and must never be summed across mixed currencies.
  // ⚠️ ONLY THE TWO FIELDS THE CLASSIFIER READS ARE PASSED. Spreading the whole
  // row also passes `syncStatus: string | null`, which `ClassifiableAccount`
  // types as `string | undefined` — and, more importantly, spreading a payload
  // into an authority's input is how a field it does not expect starts
  // influencing it. Type and balance are the whole contract.
  const c = classifyAccounts(rows.map((r) => ({
    type: r.type, balance: r.reportingBalance as number,
  })));

  const first = accountsOf(contexts[0]) as AccountsSectionData;
  return {
    ok: true,
    distinctCount: rows.length,
    sharedCount: placements - rows.length,
    accounts: {
      ...first,
      totalCount:         rows.length,
      redactedCount:      0,
      totalAssets:        c.totalAssets,
      totalLiabilities:   c.totalLiabilities,
      netWorth:           c.netWorth,
      totalLiquid:        c.totalLiquid,
      totalInvestments:   c.totalInvestments,
      totalDigitalAssets: c.totalDigitalAssets,
      totalRealAssets:    c.totalRealAssets,
      totalsEstimated:    anyEstimated,
      totalsUnconverted:  false,
      counts: {
        liquid:        c.liquid.length,
        investments:   c.investments.length,
        digitalAssets: c.digitalAssets.length,
        realAssets:    c.realAssets.length,
        liabilities:   c.liabilities.length,
      },
      accounts:   rows,
      accountIds: rows.map((r) => r.id),
    },
  };
}

/**
 * A context carrying the deduplicated accounts view, for the measure layer.
 *
 * ⚠️ THE ACCOUNTS DOMAIN ONLY. Every other domain stays the first Space's,
 * because nothing else here has been deduplicated and pretending otherwise would
 * put a per-Space transaction window behind a cross-Space total. The measure
 * layer reads accounts for balances and the assessment for rates, and only the
 * first of those is composed here.
 */
export function masterContext(
  contexts: readonly SpaceContext_AI[], accounts: AccountsSectionData,
): SpaceContext_AI {
  const base = contexts[0];
  return {
    ...base,
    domains: {
      ...base.domains,
      [FinanceDomains.ACCOUNTS]: {
        ...base.domains[FinanceDomains.ACCOUNTS],
        data: accounts,
      },
    },
  } as SpaceContext_AI;
}

/**
 * The master turn, answered over the deduplicated account set.
 *
 * ⚠️ THIS IS WHAT REPLACES `forecastable = spaceIds.length === 1`. The refusal
 * existed because there was "no deduplicated balance to project from"; there is
 * one now, so the question is answered rather than declined. When the
 * deduplication genuinely cannot be done, the refusal is still the right answer
 * and it now names WHICH of the four conditions stopped it, instead of naming
 * the number of Spaces.
 *
 * ⚠️ AND IT COMPOSES MEASURES RATHER THAN FORECASTS. Two Spaces produce two
 * `CashForecast`s over overlapping accounts, and there is no honest way to add
 * them — which is exactly what the original refusal was protecting against. What
 * CAN be composed once is the ACCOUNT SET, and Slice 3's measures evaluate over
 * that set. So master gets the same primitive the named-Space path gets, from
 * one deduplicated view, and nothing is summed twice.
 */
export function masterMeasureContext(
  contexts: readonly SpaceContext_AI[],
): { ok: true; ctx: SpaceContext_AI; distinctCount: number; sharedCount: number }
  | { ok: false; reason: Refusal } {
  const d = deduplicateMasterAccounts(contexts);
  if (!d.ok) return d;
  return {
    ok: true,
    ctx: masterContext(contexts, d.accounts),
    distinctCount: d.distinctCount,
    sharedCount: d.sharedCount,
  };
}
