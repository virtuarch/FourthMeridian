/**
 * lib/ai/brief/recent-activity.ts
 *
 * THE LARGEST MOVEMENTS OF THE LAST SEVEN DAYS — five rows, presentation-safe.
 *
 * ⚠️ A RANKING NEEDS THE WHOLE WINDOW, SO THE WHOLE WINDOW IS READ. The read is
 * `readWindowToExhaustion`, the chat tools' own paging authority, over the
 * canonical transaction seam — population, visibility (KD-15) and soft-delete are
 * that seam's, never re-decided here. Seven days is a small population; the
 * repository's 5,000-row ceiling still applies, and hitting it is reported as
 * `complete: false` rather than absorbed.
 *
 * ⚠️ WHAT A ROW MAY CARRY IS DECIDED HERE, AND IT IS LITTLE. Date, signed amount,
 * flow type, category, a merchant name with long digit runs removed, and two
 * flags. No transaction id, no account id, no description (raw descriptors carry
 * reference and account numbers), no institution, no provider metadata. The id is
 * read only to make the sort a total order and is never emitted.
 *
 * ⚠️ AN ACCOUNT'S CLASS, NEVER ITS IDENTITY. A row may say what KIND of account it
 * posted on — LIQUID, LIABILITY or ASSET, the tiers of lib/account-classifier
 * `accountTier` — because that is the only deterministic evidence that a movement
 * belongs to a balance's change. Measured: a hotel charge and a week's rise in
 * card debt were narrated together ("a recent jump alongside higher travel
 * spending"); it happened to be true, and nothing in the package could have shown
 * it. A purchase on a LIABILITY account IS part of what is owed; the same
 * purchase on a LIQUID account is not. The class is resolved by a caller-supplied
 * lookup over the accounts the viewer may already see; the account id is read for
 * that lookup and never emitted. No merchant, category or flow is special-cased.
 *
 * ⚠️ LEGS ARE NOT MERGED. A card payment posts on the account it left and the card
 * it reached, and both may rank. Collapsing them needs the corpus-scoped transfer
 * authority; this slice flags each leg (`betweenOwnAccounts`) from the privacy-
 * gated counterparty the seam already resolved, and the prompt says never to count
 * both.
 */

import type { Transaction } from '@/types';
import { accountTier } from '@/lib/account-classifier';
import type { BriefAccountClass, BriefActivityRow, BriefRecentActivity } from './types';

/** Account id → `FinancialAccount.type`, for accounts the viewer may see; undefined when unknown. */
export type AccountTypeLookup = (accountId: string) => string | undefined;

/** The class a row posted on, through THE tier authority. Unknown stays unknown. */
export function accountClassOf(type: string | undefined): BriefAccountClass | undefined {
  const tier = accountTier(type);
  return tier === 'liquid' ? 'LIQUID' : tier === 'liability' ? 'LIABILITY' : tier === 'asset' ? 'ASSET' : undefined;
}

export const RECENT_ACTIVITY_DAYS = 7;
export const RECENT_ACTIVITY_ROWS = 5;
const MERCHANT_MAX_CHARS = 40;

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The seven UTC days ending on `asOf`, inclusive. */
export function recentActivityWindow(asOf: string): { from: string; to: string } {
  const to = asOf;
  const from = new Date(Date.parse(`${asOf}T00:00:00.000Z`) - (RECENT_ACTIVITY_DAYS - 1) * DAY_MS)
    .toISOString().slice(0, 10);
  return { from, to };
}

/**
 * A merchant name fit to leave the server, or undefined.
 *
 * Runs of four or more digits are removed: a display name is normally clean, but
 * the raw descriptor it falls back to can carry card, account or reference numbers.
 */
export function safeMerchant(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\d{4,}/g, '').replace(/[#*]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > MERCHANT_MAX_CHARS ? `${cleaned.slice(0, MERCHANT_MAX_CHARS - 1)}…` : cleaned;
}

/** The day a row belongs to — the economic date when the read resolved one. */
const dayOf = (r: Transaction) => (r.economicDate ?? r.date).slice(0, 10);

/** Pure: rows in, the ranked presentation-safe window out. */
export function projectRecentActivity(
  rows: readonly Transaction[], window: { from: string; to: string }, complete: boolean,
  accountTypeOf?: AccountTypeLookup,
): BriefRecentActivity {
  const inWindow = rows.filter((r) => {
    const d = dayOf(r);
    return d >= window.from && d <= window.to && Number.isFinite(r.amount);
  });
  const ranked = [...inWindow].sort((a, b) =>
    Math.abs(b.amount) - Math.abs(a.amount)
    || dayOf(b).localeCompare(dayOf(a))
    || a.id.localeCompare(b.id));

  const top: BriefActivityRow[] = ranked.slice(0, RECENT_ACTIVITY_ROWS).map((r) => {
    const merchant = safeMerchant(r.merchantDisplayName ?? r.merchant);
    const account = accountTypeOf ? accountClassOf(accountTypeOf(r.accountId)) : undefined;
    return {
      date: dayOf(r),
      amount: round2(r.amount),
      flow: r.flowType ?? 'UNCLASSIFIED',
      ...(merchant ? { merchant } : {}),
      category: String(r.category),
      ...(r.pending ? { pending: true as const } : {}),
      ...(r.counterpartyAccountId ? { betweenOwnAccounts: true as const } : {}),
      ...(account ? { account } : {}),
    };
  });

  return {
    from: window.from, to: window.to, days: RECENT_ACTIVITY_DAYS,
    complete, transactionsInWindow: inWindow.length, top,
  };
}

/** The read, injectable — the same idiom `readWindowToExhaustion` itself uses. */
export type RecentWindowReader = (
  spaceId: string, query: { sort: 'newest'; dateFrom: string; dateTo: string },
) => Promise<{ rows: Transaction[]; complete: boolean }>;

const defaultReader: RecentWindowReader = async (spaceId, query) => {
  const { readWindowToExhaustion } = await import('@/lib/ai/conversation/tools');
  return readWindowToExhaustion(spaceId, query);
};

/** Read and rank the seven days ending on `asOf`. `asOf` is the ceiling. */
export async function loadRecentActivity(
  spaceId: string, asOf: string, read: RecentWindowReader = defaultReader,
  accountTypeOf?: AccountTypeLookup,
): Promise<BriefRecentActivity> {
  const window = recentActivityWindow(asOf);
  const { rows, complete } = await read(spaceId, {
    sort: 'newest', dateFrom: window.from, dateTo: window.to,
  });
  return projectRecentActivity(rows, window, complete, accountTypeOf);
}
