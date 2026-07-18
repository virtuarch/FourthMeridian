/**
 * lib/data/accounts-asof.ts
 *
 * A5-S2 — as-of account resolver (DB binding). The historical counterpart to
 * getAccountsWithVisibility: it returns the SAME visibility-redacted account
 * rows, but with each balance resolved to a requested `asOf` date and stamped
 * with { method, tier } from the A5-S1 vocabulary, so an as-of-aware lens
 * (P2 Liquidity / P3 Debt) can build an honest Completeness envelope.
 *
 * Split, matching the lens/core and backfill/backfill-core conventions:
 *   - the PURE resolution math lives in ./accounts-asof.core.ts (fixture-tested,
 *     DB-free), reusing lib/snapshots/backfill-core.ts's walk-backs unmodified;
 *   - this module only gathers inputs from the DB and merges the result onto the
 *     visibility rows. It touches lib/data/accounts.ts and backfill-core.ts as
 *     READ-ONLY imports — neither is modified (S2 ownership boundary).
 *
 * Visibility posture is inherited: the redacted Account shape comes straight
 * from getAccountsWithVisibility (KD-19). The classification/floor query below
 * reads FinancialAccount metadata SERVER-SIDE only to decide *how* to resolve a
 * balance (walk vs flat) and *from when* — it never widens what the row exposes;
 * the output carries balance + method + tier, never subtype/limit/createdAt.
 */

import { db } from "@/lib/db";
import { ShareStatus, type VisibilityLevel } from "@prisma/client";
import { Account } from "@/types";
import {
  getAccountsWithVisibility,
} from "@/lib/data/accounts";
import {
  isReconstructableCard,
  truncDateUTC,
  maxDate,
  isoDate,
  fromISO,
} from "@/lib/snapshots/backfill-core";
import {
  resolveAccountsAsOf,
  type AsOfAccountInput,
  type AsOfMethod,
} from "./accounts-asof.core";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

/**
 * One visible account with its balance resolved to `asOf`. Same shape as
 * AccountWithVisibility plus the per-row trust stamp; `account.balance` is the
 * as-of value (every other field is byte-identical to getAccountsWithVisibility).
 */
export interface AccountAsOf {
  account:         Account;
  visibilityLevel: VisibilityLevel;
  /** How this balance was arrived at (mechanism behind the tier). */
  method:          AsOfMethod;
  /** A5-S1 trust tier for this row: derived | estimated | incomplete | observed. */
  tier:            CompletenessTier;
}

function todayUTC(now: () => Date): Date {
  const d = truncDateUTC(now());
  return d;
}

/**
 * All accounts visible to the space, each resolved to `asOf` (YYYY-MM-DD).
 * Mirrors getAccountsWithVisibility's argument contract (`spaceId`/`userId` are
 * the same optional internal/test seam; production callers pass at most
 * `{ spaceId }` and resolve the viewer from request scope).
 *
 * `now` is an injectable clock so callers can stay deterministic; it defaults
 * to the real clock. Resolution semantics live entirely in the pure core — this
 * function adds no rule of its own (downstream streams that need a new rule must
 * extend the core, not patch around it here).
 */
export async function getAccountsAsOf(args: {
  spaceId: string;
  userId?: string;
  asOf:    string;
  now?:    () => Date;
}): Promise<AccountAsOf[]> {
  const { spaceId, userId, asOf } = args;
  const now = args.now ?? (() => new Date());

  // 1. The visibility-redacted rows every existing caller sees (current balance).
  const visRows = await getAccountsWithVisibility({ spaceId, userId });

  // 2. Classification + floor metadata, read directly from the ACTIVE, non-deleted
  //    links (the SAME set getAccountsWithVisibility queries — ids agree). This
  //    is the server-side "how/from-when" input, never exposed on the output row.
  const linkRows = await db.spaceAccountLink.findMany({
    where:  { spaceId, status: ShareStatus.ACTIVE, financialAccount: { deletedAt: null } },
    select: {
      createdAt: true,
      financialAccount: {
        select: {
          id: true, type: true, balance: true, createdAt: true,
          debtSubtype: true, creditLimit: true,
        },
      },
    },
  });

  const today   = todayUTC(now);
  const asOfDay = fromISO(asOf);

  const accounts: AsOfAccountInput[] = linkRows.map((l) => ({
    id:          l.financialAccount.id,
    type:        l.financialAccount.type as string,
    balance:     l.financialAccount.balance,
    debtSubtype: l.financialAccount.debtSubtype,
    creditLimit: l.financialAccount.creditLimit,
    // Earliest defensible date — an account cannot be resolved before it existed
    // or was linked (matches backfill.ts's floor derivation exactly).
    floorISO:    isoDate(maxDate(truncDateUTC(l.financialAccount.createdAt), truncDateUTC(l.createdAt))),
  }));

  // 3. Transaction deltas for the accounts the core will walk (cash + card),
  //    over the SAME window backfill uses — (asOf, today] on the @db.Date column
  //    — so the as-of walk and the snapshot backfill agree by construction.
  const cashIds = accounts
    .filter((a) => a.type === "checking" || a.type === "savings")
    .map((a) => a.id);
  const cardIds = accounts
    .filter(isReconstructableCard)
    .map((a) => a.id);

  // SAME-BASIS INVARIANT (HIST) — BOTH walks are POSTED-ONLY. The core anchors on
  // FinancialAccount.balance (the posted truth the whole system uses); a pending row
  // is not settled into that anchor, so reversing it would mix bases and inject a
  // phantom. buildDeltas is unconditionally posted-only — there is no pending-
  // inclusive variant to pass, by construction (the regression wall).
  const [cashDeltas, cardDeltas] = await Promise.all([
    buildDeltas(cashIds, asOfDay, today),
    buildDeltas(cardIds, asOfDay, today),
  ]);

  // 4. Pure resolution, then merge onto the visibility rows by id.
  const resolved = resolveAccountsAsOf(accounts, cashDeltas, cardDeltas, today, asOfDay);

  return visRows.map(({ account, visibilityLevel }) => {
    const r = resolved.get(account.id);
    // Every visRow has a matching link row (same query set); the fallback keeps
    // the function total if an account raced in/out between the two reads —
    // hold flat at the current balance, marked estimated (never fabricated).
    if (!r) {
      return { account, visibilityLevel: visibilityLevel as VisibilityLevel, method: "held-flat" as const, tier: "estimated" as const };
    }
    return {
      account:         { ...account, balance: r.balance },
      visibilityLevel: visibilityLevel as VisibilityLevel,
      method:          r.method,
      tier:            r.tier,
    };
  });
}

/**
 * accountId → (isoDate → Σ signed POSTED amount that day) over (asOf, today].
 * Empty map for an empty id list (no query). POSTED-ONLY unconditionally: the
 * as-of walk reverses the posted FinancialAccount.balance anchor, so its deltas
 * must be posted too (same-basis invariant, shared with backfill / regenerate-
 * history). There is deliberately NO pending-inclusive option — that would
 * reintroduce the reconstructed-history phantom this walk once carried for cash.
 */
async function buildDeltas(
  ids:   string[],
  asOf:  Date,
  today: Date,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (ids.length === 0) return out;

  const grouped = await db.transaction.groupBy({
    by: ["financialAccountId", "date"],
    where: {
      financialAccountId: { in: ids },
      deletedAt: null,
      pending:   false, // posted-only — anchor basis === delta basis
      date: { gt: asOf, lte: today },
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
