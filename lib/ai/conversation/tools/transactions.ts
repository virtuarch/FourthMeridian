/**
 * lib/ai/conversation/tools/transactions.ts
 *
 * Transaction search: `get_transactions` (the SEC-AI-005 descriptor scrub site).
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { FinanceDomains, type AccountsSectionData } from '@/lib/ai/types';
import {
  queryTransactions, countTransactions, transactionCorpusSpan, transactionCoverage,
} from '@/lib/data/transaction-query';
import type { TransactionQuery } from '@/lib/data/transaction-query-core';
import { TRANSACTION_FETCH_LIMIT } from '@/lib/ai/assemblers/transactions';
import { scrubDescriptor } from '@/lib/ai/privacy/scrub';
import { FlowType } from '@prisma/client';
import { resolvedCategory } from '@/lib/transactions/transfer-debt-payment-correction';
import type { ToolDefinition } from './types';
import { obj, str, num } from './shared/schema';
import { clampToCeiling } from './shared/values';
import { readWindowToExhaustion } from './shared/read-window';
import { assemble } from './shared/reads';

// ── 3. Transactions ──────────────────────────────────────────────────────────

/**
 * The user's vocabulary for "what kind of money movement", mapped onto the
 * canonical `FlowType` population.
 *
 * ⚠️ THE MODEL PICKS; THIS ONLY HONOURS. No keyword matching happens anywhere —
 * the parameter is an enum on the schema and the model chooses it from the
 * question. Ranking "largest" over every flow is what made "my biggest purchase
 * last month" answer with a payroll deposit.
 */
/**
 * How many matching rows a search will finish rather than sample.
 *
 * ⚠️ NOT A PAGE SIZE AND NOT A DEFAULT — a cost boundary on completeness. Under
 * it, "did this happen in this window?" is answerable; over it the result stays a
 * page and says so, because rendering hundreds of rows to answer one question is
 * its own defect. 100 sits above the populations an ordinary filtered question
 * produces (the 58b352f blocker matched 80) and far below the read ceiling.
 */
const COMPLETABLE_SEARCH_ROWS = 100;

const FLOW_SETS: Record<string, FlowType[] | null> = {
  spending:      [FlowType.SPENDING, FlowType.FEE, FlowType.INTEREST],
  income:        [FlowType.INCOME],
  // v2.7-P1 — membership is the PERSISTED flowType, and the transfer authority
  // now writes its verdict there (lib/transactions/transfer-debt-payment-
  // correction.ts: after every Plaid sync, and historically via
  // scripts/repair-transfer-debt-payment.ts), so a depository leg Plaid filed as
  // LOAN_PAYMENTS that went to the owner's savings is TRANSFER here, not a card
  // payment. A read-time re-filter was rejected: the count and the list share one
  // WHERE by construction (transaction-query-core.ts), and a resolved nature is
  // cross-row state no WHERE can express.
  transfers:     [FlowType.TRANSFER],
  card_payments: [FlowType.DEBT_PAYMENT],
  refunds:       [FlowType.REFUND],
  all:           null,
};

export const getTransactions: ToolDefinition = {
  name: 'get_transactions',
  description:
    'Individual transactions, filtered and ranked. Set `flow` to say what KIND of movement ' +
    'you mean — "spending" for purchases, "income" for deposits, "transfers" for movements ' +
    'between the user\'s own accounts, "card_payments" for paying a card off. Use ' +
    'flow:"spending" with sort:"largest" for "my biggest purchase".',
  parameters: obj({
    from:     str('YYYY-MM-DD inclusive.'),
    to:       str('YYYY-MM-DD inclusive.'),
    asOf:     str('Information ceiling: nothing dated after this is returned.'),
    flow:     { type: 'string', enum: Object.keys(FLOW_SETS),
                description: 'Default "all". Choose the one the question means.' },
    category: str('One presentation category, e.g. Dining, Shopping, Travel, Other.'),
    text:     str('Case-insensitive substring over merchant and description.'),
    sort:     { type: 'string', enum: ['newest', 'oldest', 'largest'],
                description: 'Default newest. "largest" ranks by amount WITHIN the chosen flow.' },
    limit:    num('1–50. Default 15.'),
  }),
  async run(a, ctx) {
    const limit = Math.min(Math.max(Number(a.limit ?? 15), 1), 50);
    const wantLargest = String(a.sort ?? 'newest') === 'largest';
    const flowKey = String(a.flow ?? 'all');
    const flowTypes = FLOW_SETS[flowKey] ?? null;

    const ceiling = (a.asOf as string) || ctx.asOfISO;
    const dateTo = clampToCeiling((a.to as string) || ceiling, ceiling);
    const filters: Omit<TransactionQuery, 'cursor' | 'limit'> = {
      sort: 'oldest' === String(a.sort) ? 'oldest' : 'newest',
      ...(flowTypes ? { flowTypes } : {}),
      ...(a.from ? { dateFrom: String(a.from) } : {}),
      dateTo,
      ...(a.text ? { text:     String(a.text) } : {}),
      ...(a.category ? { categories: [String(a.category)] as never } : {}),
    };

    // ⚠️ TWO READ SHAPES, FOR TWO DIFFERENT QUESTIONS. "Show me the latest 15" is a
    // page and the seam already orders it. "Which was the largest" is a question
    // about the whole window, and answering it from a page is how a payroll deposit
    // became somebody's biggest purchase.
    // ⚠️ A PAGE IS NOT A POPULATION. The newest-`limit` read answers "show me
    // some"; a model asking "did this happen?" reads the same payload as "here is
    // everything that matched". Measured (58b352f): a correct nine-month window
    // matched 80 transfers, the page returned the newest 50 ending three days
    // short of the evidence, and the assistant reported that none existed.
    // `hasMore` was true in that payload and was not enough — it is a transport
    // fact ("another page exists"), not an evidence one ("you saw 50 of 80").
    //
    // ⚠️ COUNTED, NOT EXHAUSTED. One indexed aggregate over the same WHERE — no
    // extra rows materialized, no FX, no transfer assessment — so a browse stays
    // a browse. Exhaustion is still what `sort: 'largest'` does, because ranking
    // needs the ROWS; this needs only the SIZE, and stays truthful above the
    // ceiling where exhaustion cannot.
    const [firstRead, matchedInWindow] = await Promise.all([
      wantLargest
        ? readWindowToExhaustion(ctx.readClient, ctx.spaceId, filters)
        : (async () => {
            const page = await queryTransactions(ctx.readClient, { spaceId: ctx.spaceId, query: { ...filters, limit } });
            return { rows: page.rows, complete: !page.hasMore, pages: 1 };
          })(),
      wantLargest ? Promise.resolve(null) : countTransactions(ctx.readClient, { spaceId: ctx.spaceId, query: filters }),
    ]);

    // ⚠️ FINISH THE SEARCH WHEN FINISHING IT IS CHEAP. Reporting "you saw 50 of
    // 80" is truthful and was NOT enough: measured after the count landed, 3 of 5
    // trials read that payload and still wrote "I pulled all transfers". A
    // population this small is two pages of work, and the question "did this
    // happen?" cannot be answered by a sample at any price.
    //
    // ⚠️ THE CEILING IS WHAT MAKES THIS SAFE. Above it nothing changes: a 449-row
    // browse stays one page and says so. This only ever converts an almost-
    // complete search into a complete one, never a browse into a dump.
    const completable = !wantLargest && matchedInWindow !== null
      && matchedInWindow > limit && matchedInWindow <= COMPLETABLE_SEARCH_ROWS;
    const { rows: population, complete, pages } = completable
      ? await (async () => {
          const page = await queryTransactions(ctx.readClient, {
            spaceId: ctx.spaceId, query: { ...filters, limit: matchedInWindow } });
          return { rows: page.rows, complete: !page.hasMore, pages: 2 };
        })()
      : firstRead;

    const rows = wantLargest
      ? [...population].sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).slice(0, limit)
      : population;   // completable ⇒ this IS the whole matching set

    // ⚠️ NAMES FROM THE ASSEMBLER THAT ALREADY DECIDES WHO MAY SEE THEM. The row
    // DTOs carry account IDs — the counterparty's already privacy-gated by the
    // read authority — and an id is not something a reader can pair. This maps
    // the ids this page uses onto the names the accounts surface already
    // discloses, so an account the viewer cannot see simply has no name here and
    // the leg stays honestly anonymous.
    const acc = await assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx);
    const names = new Map((acc?.accounts ?? []).map((x) => [x.id, x.name]));
    const accountName = (id: string | null | undefined) => (id ? names.get(id) : undefined);

    // ⚠️ THE RESULT DECLARES THE BOUNDARY OF ITS OWN AUTHORITY. `window` is the
    // evidence actually searched; `coverage` is the evidence there was to search.
    // Without the second, an empty page cannot distinguish "nothing matched in
    // these 90 days" from "nothing matched, ever" — and the 2×2 experiment
    // (bb2f6ec) measured 11 of 18 negative answers making exactly that leap, off
    // windows that were all genuinely empty inside a corpus that was not.
    //
    // This ADDS a fact and changes no behaviour: no default window is introduced,
    // no window is widened, nothing is re-queried, and the rows are the same rows.
    // What to do about a partial window is the model's decision, not this
    // adapter's.
    const coverage = transactionCoverage({
      corpus: await transactionCorpusSpan(ctx.readClient, { spaceId: ctx.spaceId, asOf: ceiling }),
      searchedFrom: (a.from as string) ?? null,
      searchedTo: dateTo,
    });

    return {
      asOf: ceiling,
      window: { from: a.from ?? null, to: dateTo },
      // ⚠️ NOT DERIVED FROM THE WINDOW, THE ROWS, OR THE FILTERS. A `text` search
      // that matches nothing still reports the span it searched inside — shrinking
      // this to the matching rows would erase the very thing it exists to qualify.
      coverage,
      flow: flowKey,
      rows: rows.map((r) => ({
        // SEC-AI-005 — the merchant is SCRUBBED (lib/ai/privacy/scrub.ts: the Brief's
        // rule — digit runs of 4+, reference symbols) and the raw `description` is
        // NOT sent: a provider descriptor carries cheque, reference and partial card
        // numbers, and the `text` filter already searched it server-side.
        date: r.date, merchant: scrubDescriptor(r.merchantDisplayName ?? r.merchant),
        amount: r.amount,
        // v2.7-P1 — the category that goes with the transfer authority's verdict:
        // a provider `Payment` label on a row it resolved to a transfer (stored
        // DEBT_PAYMENT until its write reaches the row) reads `Transfer`.
        category: resolvedCategory(r.category, r.flowType ?? null, r.transferMaturity), pending: r.pending,
        // ⚠️ WHICH SIDE OF THE MOVEMENT THIS ROW IS. A card payment posts TWICE —
        // once on the checking account it left and once on the card it landed on —
        // and the two rows used to arrive as `-5,000 Payment to Chase card` and
        // `+5,000 Payment Thank You-Mobile` with nothing to say they are one
        // event. Naming the account each row sits on, and the owned account on
        // the other side, is what makes the pair legible. Both legs stay in the
        // ledger: the raw record is never collapsed, because a leg is real
        // evidence about the account it posted to.
        ...(accountName(r.accountId) ? { account: accountName(r.accountId) } : {}),
        ...(accountName(r.counterpartyAccountId) ? {
          counterpartyAccount: accountName(r.counterpartyAccountId),
          movementNote: 'Both sides of this movement are your own accounts. This row '
            + 'is ONE LEG of it — do not add it to the other leg.',
        } : {}),
        // The transfer authority's own verdict about where the money went.
        // Absent when it did not assess the row.
        ...(r.transferMaturity ? { movementKind: r.transferMaturity } : {}),
      })),
      shown: rows.length,
      // ⚠️ THE EVIDENCE CEILING FOR THE PAGE, BESIDE THE ONE FOR THE WINDOW.
      // `coverage` above says how much of the RECORD the window covered; this
      // says how much of the MATCHING SET the rows covered. They are different
      // ceilings and a result can fail either independently — the dogfood failure
      // had `windowCoversAvailableRecord: false` AND an incomplete page, and
      // neither on its own would have described it.
      //
      // This replaces `moreAvailable`, which it strictly subsumes: a boolean said
      // that something was missing, this says how much.
      ...(wantLargest ? {} : {
        matchedInWindow,
        searchIsComplete: complete,
        ...(complete ? {} : { searchCaveat:
          `Showed the ${rows.length} ${String(a.sort ?? 'newest')} of ${matchedInWindow} `
          + 'transactions matching this search in the window. The rest were not read: '
          + 'absence from these rows is NOT absence from the window. Narrow with `text`, '
          + '`category` or `flow`, or rank the whole set with sort:"largest".' }),
      }),
      ...(wantLargest ? {
        rankedOver: population.length,
        // ⚠️ SCOPED TO THE SEARCHED POPULATION, AND ONLY THAT. True means every row
        // matching these filters INSIDE `window` was read and ranked. It says
        // nothing about `coverage` — a complete ranking of a 90-day window of a
        // 26-month record is still a ranking of 90 days.
        rankingIsComplete: complete,
        pagesRead: pages,
        ...(complete ? {} : { rankingCaveat:
          `Ranked over ${population.length} rows — the ${TRANSACTION_FETCH_LIMIT}-row read `
          + 'ceiling was reached, so this is the largest of what was read, not necessarily '
          + 'of the whole window. Narrow the date range to rank it completely.' }),
      } : {}),
    };
  },
};
