/**
 * lib/data/accounts-asof-window.ts
 *
 * v2.6-C — `getAccountsAsOf`, widened to a WINDOW.
 *
 * Separate from accounts-asof.ts for one reason: that module reaches
 * `getAccountsWithVisibility`, which transitively imports `server-only` and so
 * cannot be loaded by the DB-free unit runner. The historical-exploration layer
 * needs the resolution WITHOUT the visibility projection (see below), and a
 * layer that cannot be unit-tested is a layer whose invariants are checked by
 * hand. So the read lives here and the resolution stays in the allowlisted core.
 *
 * Everything financial is INHERITED, not restated:
 *   · `resolveAccountsOverWindow` — the one precedence ladder
 *   · the same created/linked floor derivation as the single-date path
 *   · POSTED-ONLY deltas — the anchor is the posted balance, and reversing an
 *     unsettled row against it mixes bases and injects a phantom (HIST)
 *
 * This is also why the historical layer must never import the walk-back
 * primitives itself: a second importer is a second reconstruction basis, which
 * the reconstruction-basis guard fails the build over.
 *
 * VISIBILITY IS DELIBERATELY NOT APPLIED. The caller composes buckets whose
 * totals were built from the full linked set; redacting a member mid-composition
 * would make the children silently fail to explain their parent, turning a
 * privacy rule into a phantom reconciliation failure. Callers that render
 * per-account rows to a specific user must apply visibility themselves.
 *
 * READ-ONLY.
 */

import { db } from "@/lib/db";
import { ShareStatus, type AccountType, type Prisma, type PrismaClient } from "@prisma/client";
import {
  isReconstructableCard, truncDateUTC, maxDate, isoDate, fromISO,
} from "@/lib/snapshots/backfill-core";
import {
  resolveAccountsOverWindow,
  type AsOfAccountInput,
  type ResolvedAsOfBalance,
} from "./accounts-asof.core";
import { getAccountCoverage, type AccountHistoricalCoverage } from "./account-coverage";

type Client = PrismaClient | Prisma.TransactionClient;

const todayUTC = (now: () => Date) => truncDateUTC(now());

/** One linked account plus the metadata a historical node renders. */
export type WindowAccount = AsOfAccountInput & {
  name:          string;
  institution:   string | null;
  nativeBalance: number | null;
  lastUpdated:   Date;
  /** The evidence-derived intervals and the reasons behind them. */
  coverage:      AccountHistoricalCoverage;
};

/**
 * Every linked account's balance for every day in [fromISO, toISO], through the
 * SAME resolver, floors and posted-only deltas as `getAccountsAsOf`.
 */
export async function getAccountBalancesOverWindow(args: {
  spaceId: string;
  fromISO: string;
  toISO:   string;
  /** Restrict to these account types. Omit for all. */
  types?:  AccountType[];
  client?: Client;
  now?:    () => Date;
}): Promise<{
  accounts: WindowAccount[];
  byDate:   Map<string, Map<string, ResolvedAsOfBalance>>;
}> {
  const client = args.client ?? db;
  const now = args.now ?? (() => new Date());

  const linkRows = await client.spaceAccountLink.findMany({
    where: {
      spaceId: args.spaceId, status: ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null, ...(args.types ? { type: { in: args.types } } : {}) },
    },
    select: {
      createdAt: true,
      financialAccount: {
        select: {
          id: true, name: true, type: true, balance: true, institution: true,
          createdAt: true, debtSubtype: true, creditLimit: true,
          nativeBalance: true, lastUpdated: true,
        },
      },
    },
  });

  const refs = linkRows.map((l) => ({
    id:   l.financialAccount.id,
    type: l.financialAccount.type as string,
    reconstructableCard: isReconstructableCard({
      type: l.financialAccount.type as string,
      debtSubtype: l.financialAccount.debtSubtype,
      creditLimit: l.financialAccount.creditLimit,
    }),
    connectionFloorISO: isoDate(maxDate(truncDateUTC(l.financialAccount.createdAt), truncDateUTC(l.createdAt))),
    nativeBalance: l.financialAccount.nativeBalance,
  }));
  // THE one coverage authority — the same call `getAccountsAsOf` makes.
  const coverageById = await getAccountCoverage(refs, { client });

  const accounts: WindowAccount[] = linkRows.map((l, idx) => {
    const coverage = coverageById.get(l.financialAccount.id)!;
    return {
      id:          l.financialAccount.id,
      name:        l.financialAccount.name,
      type:        l.financialAccount.type as string,
      institution: l.financialAccount.institution,
      balance:     l.financialAccount.balance,
      debtSubtype: l.financialAccount.debtSubtype,
      creditLimit: l.financialAccount.creditLimit,
      nativeBalance: l.financialAccount.nativeBalance,
      lastUpdated:   l.financialAccount.lastUpdated,
      // The REPLAY floor drives the resolver; EXISTENCE is carried separately so
      // a node can say "this existed from X" even where no value may appear.
      floorISO: coverage.displayFromISO ?? refs[idx].connectionFloorISO,
      coverage,
    };
  });

  const today = todayUTC(now);
  const from  = fromISO(args.fromISO);
  const to    = fromISO(args.toISO);

  const cashIds = accounts.filter((a) => a.type === "checking" || a.type === "savings").map((a) => a.id);
  const cardIds = accounts.filter(isReconstructableCard).map((a) => a.id);

  // The deltas span (from, today] — the walk's whole reverse pass, not just the
  // selected day — so every date in the window is walked from the same anchor.
  const [cashDeltas, cardDeltas] = await Promise.all([
    buildDeltas(client, cashIds, from, today),
    buildDeltas(client, cardIds, from, today),
  ]);

  return { accounts, byDate: resolveAccountsOverWindow(accounts, cashDeltas, cardDeltas, today, from, to) };
}

/**
 * accountId → (isoDate → Σ signed POSTED amount that day) over (from, today].
 *
 * POSTED-ONLY unconditionally, with no pending-inclusive option, exactly as the
 * single-date path: the walk reverses the posted `FinancialAccount.balance`
 * anchor, so its deltas must be posted too.
 */
async function buildDeltas(
  client: Client, ids: string[], from: Date, today: Date,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (ids.length === 0) return out;

  const grouped = await client.transaction.groupBy({
    by: ["financialAccountId", "date"],
    where: {
      financialAccountId: { in: ids },
      deletedAt: null,
      pending:   false, // posted-only — anchor basis === delta basis
      date: { gt: from, lte: today },
    },
    _sum: { amount: true },
  });

  for (const g of grouped) {
    if (!g.financialAccountId) continue;
    const m = out.get(g.financialAccountId) ?? new Map<string, number>();
    m.set(isoDate(g.date), g._sum.amount ?? 0);
    out.set(g.financialAccountId, m);
  }
  return out;
}
