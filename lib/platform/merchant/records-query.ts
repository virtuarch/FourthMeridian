/**
 * lib/platform/merchant/records-query.ts  (PB-9 — THE record-set definitions)
 *
 * The Prisma `where` / SQL fragment for every Merchant Identity KPI, defined
 * ONCE and read by both the overview KPI count and the drill-down list total
 * (records.ts). Built from the classifier's own constants (records-core.ts), so
 * the TS classifier and the wheres encode one rule table. See records-core.ts
 * for the denominator finding and the NULL-safety rule.
 */

import { Prisma } from "@prisma/client";
import { NO_COUNTERPARTY_FLOWS, TRANSFER_CATEGORY, TRANSFER_FLOWS } from "./records-core";
import type { IdentityClass, MerchantRecordsQuery, MerchantWindowDays } from "./records-types";

const isWallet: Prisma.TransactionWhereInput = { financialAccount: { walletAddress: { not: null } } };
const notWallet: Prisma.TransactionWhereInput = { financialAccount: { walletAddress: null } };
const isTransfer: Prisma.TransactionWhereInput = { OR: [{ flowType: { in: [...TRANSFER_FLOWS] } }, { category: TRANSFER_CATEGORY }] };
/** Not a transfer — the NULL flow arm is explicit (NOT IN on NULL is NULL, not TRUE). */
const notTransfer: Prisma.TransactionWhereInput = {
  AND: [{ OR: [{ flowType: null }, { flowType: { notIn: [...TRANSFER_FLOWS] } }] }, { category: { not: TRANSFER_CATEGORY } }],
};
const isNoCounterparty: Prisma.TransactionWhereInput = { flowType: { in: [...NO_COUNTERPARTY_FLOWS] } };
const notNoCounterparty: Prisma.TransactionWhereInput = { OR: [{ flowType: null }, { flowType: { notIn: [...NO_COUNTERPARTY_FLOWS] } }] };

/** The where for one identity class — a partition of every transaction row. */
export function identityClassWhere(cls: IdentityClass): Prisma.TransactionWhereInput {
  switch (cls) {
    case "WALLET": return isWallet;
    case "TRANSFER": return { AND: [notWallet, isTransfer] };
    case "NO_COUNTERPARTY": return { AND: [notWallet, notTransfer, isNoCounterparty] };
    case "ELIGIBLE": return { AND: [notWallet, notTransfer, notNoCounterparty] };
  }
}

/** Live = not soft-deleted (rolled-back imports, superseded pendings) — like every product reader. */
export const LIVE_TRANSACTION_WHERE: Prisma.TransactionWhereInput = { deletedAt: null };

/** "Without a merchant": live rows with no resolved merchant, optionally one class. */
export function unlinkedWhere(cls: IdentityClass | null): Prisma.TransactionWhereInput {
  const base: Prisma.TransactionWhereInput = { deletedAt: null, merchantId: null };
  return cls ? { AND: [base, identityClassWhere(cls)] } : base;
}

/** Live rows of one class, linked or not (the eligible denominator). */
export function liveClassWhere(cls: IdentityClass, linked?: boolean): Prisma.TransactionWhereInput {
  const parts: Prisma.TransactionWhereInput[] = [LIVE_TRANSACTION_WHERE, identityClassWhere(cls)];
  if (linked) parts.push({ merchantId: { not: null } });
  return { AND: parts };
}

/**
 * Search on the "Without a merchant" table. It matches the descriptor ONLY of
 * rows where identity is expected — the rows whose (sanitized) descriptor the
 * table shows. Legitimate exclusions never expose a descriptor, so they are not
 * searchable (a search would otherwise be an oracle for, say, a transfer
 * counterparty's name). Digits are stripped from the term for the same reason.
 */
export function unlinkedSearchWhere(q: string): Prisma.TransactionWhereInput {
  return { AND: [identityClassWhere("ELIGIBLE"), { merchant: { contains: q, mode: "insensitive" } }] };
}

export function unlinkedListWhere(query: Pick<MerchantRecordsQuery, "filter" | "q">): Prisma.TransactionWhereInput {
  const w = unlinkedWhere(query.filter);
  return query.q ? { AND: [w, unlinkedSearchWhere(query.q)] } : w;
}

// ── Merge decisions ───────────────────────────────────────────────────────────

/** The KPI's window start — the overview's first UTC day key. */
export function windowSince(now: Date, windowDays: MerchantWindowDays): Date {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(today - (windowDays - 1) * 86_400_000);
}

export function decisionWhere(verdict: "MERGED" | "DISMISSED", since: Date): Prisma.MerchantMergeDecisionWhereInput {
  return { verdict, createdAt: { gte: since } };
}

export function decisionListWhere(verdict: "MERGED" | "DISMISSED", since: Date, q: string | null): Prisma.MerchantMergeDecisionWhereInput {
  const w = decisionWhere(verdict, since);
  return q
    ? { AND: [w, { OR: [{ survivorKey: { contains: q, mode: "insensitive" } }, { absorbedKey: { contains: q, mode: "insensitive" } }] }] }
    : w;
}

// ── Merchant directory (SQL: sorting by LIVE transaction count needs a join) ─

/** The directory's filter — the KPI passes null (every merchant). */
export function merchantDirectoryFilterSql(q: string | null): Prisma.Sql {
  if (!q) return Prisma.sql`TRUE`;
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return Prisma.sql`(m."displayName" ILIKE ${like} OR m."canonicalKey" ILIKE ${like} OR m."id" = ${q})`;
}

export const MERCHANT_DIRECTORY_ORDER: Readonly<Record<string, Prisma.Sql>> = {
  transactions_desc: Prisma.sql`tx_count DESC, m."displayName" ASC, m."id" ASC`,
  name_asc: Prisma.sql`m."displayName" ASC, m."id" ASC`,
  name_desc: Prisma.sql`m."displayName" DESC, m."id" ASC`,
  aliases_desc: Prisma.sql`alias_count DESC, m."displayName" ASC, m."id" ASC`,
  last_seen_desc: Prisma.sql`last_seen DESC NULLS LAST, m."displayName" ASC, m."id" ASC`,
  created_desc: Prisma.sql`m."createdAt" DESC, m."id" ASC`,
};
