/**
 * lib/ai/conversation/tools/shared/read-window.ts
 *
 * A bounded transaction window read to exhaustion through the canonical keyset
 * cursor (`get_transactions`, and the Daily Brief's recent-activity read).
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { queryTransactions } from '@/lib/data/transaction-query';
import { MAX_TRANSACTION_PAGE_SIZE, type TransactionQuery } from '@/lib/data/transaction-query-core';
import { TRANSACTION_FETCH_LIMIT } from '@/lib/ai/assemblers/transactions';
import type { Transaction } from '@/types';
/**
 * RLS-C-S3 — a TYPE-ONLY import. This file still holds no Prisma client (the
 * source scan in lib/ai/measures/measures.test.ts and its siblings depend on that),
 * and `import type` erases at compile, so the authority arrives on `ToolContext`
 * and nowhere else.
 */
import type { ReadClient } from '@/lib/db/tenant-context';

/**
 * Read a bounded window to EXHAUSTION through the canonical keyset cursor.
 *
 * ⚠️ RANKING NEEDS THE WHOLE POPULATION, NOT A PAGE. `sort: 'largest'` used to rank
 * the newest 100 matching rows and present the winner as "your biggest" — on a
 * 173-row month that silently answered from 58% of the data. Raising 100 to some
 * other number would only move the cliff to 201 or 501; the fix is to page until
 * the seam says `hasMore: false`, which is the mechanism the read authority
 * already provides.
 *
 * ⚠️ THE CEILING IS THE REPOSITORY'S OWN, AND IT FAILS LOUDLY. `TRANSACTION_FETCH_LIMIT`
 * is the same 5,000-row guard the transactions assembler applies to the same
 * population, so a ranking and the summary beside it can never disagree about what
 * "all of them" covered. Hitting it returns `complete: false`, which the caller
 * turns into a stated caveat — it is never absorbed.
 *
 * Terminates on three conditions: the seam reports no more, the ceiling is reached,
 * or a page fails to advance the cursor (a defensive stop, never expected).
 */
/**
 * The read, injectable.
 *
 * ⚠️ INJECTED ONLY SO TERMINATION CAN BE TESTED WITHOUT A DATABASE — the same
 * idiom `lib/ai/forecast/streams.ts` uses for its own bounded read. The three
 * ways this loop can end (exhausted, ceiling, non-advancing cursor) are exactly
 * the parts worth a test, and two of them cannot be reached with real data.
 */
export type TransactionPager = typeof queryTransactions;

export async function readWindowToExhaustion(
  /** RLS-C-S3 — the authority every page of the walk runs on. Required, leading. */
  client: ReadClient,
  spaceId: string, query: Omit<TransactionQuery, 'cursor' | 'limit'>,
  read: TransactionPager = queryTransactions,
): Promise<{ rows: Transaction[]; complete: boolean; pages: number }> {
  const rows: Transaction[] = [];
  let cursor: TransactionQuery['cursor'];
  let pages = 0;

  for (;;) {
    const page = await read(client, {
      spaceId, query: { ...query, limit: MAX_TRANSACTION_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    });
    pages++;
    rows.push(...page.rows);
    if (!page.hasMore || !page.nextCursor) return { rows, complete: true, pages };
    if (page.rows.length === 0) return { rows, complete: true, pages };
    if (rows.length >= TRANSACTION_FETCH_LIMIT) return { rows, complete: false, pages };
    const advanced = !cursor
      || cursor.lastId !== page.nextCursor.lastId
      || cursor.lastDate !== page.nextCursor.lastDate;
    if (!advanced) return { rows, complete: false, pages };
    cursor = page.nextCursor;
  }
}
