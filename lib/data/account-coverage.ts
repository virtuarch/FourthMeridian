/**
 * lib/data/account-coverage.ts
 *
 * THE evidence gather behind `resolveAccountCoverage`. One function, consumed by
 * BOTH as-of bindings (`getAccountsAsOf` → Debt + Liquidity lenses, and
 * `getAccountBalancesOverWindow` → the account historical series and the Net
 * Worth drill-down), so "from when is this account defensible" is answered in
 * exactly one place.
 *
 * ── Every query is scoped to ONE account ─────────────────────────────────────
 * Grouped by `financialAccountId`, never by item or institution. That is not a
 * stylistic preference: `InvestmentEventCoverage` proves why it matters — two
 * accounts on one Plaid item carry the SAME `earliestReturnedDate` and the same
 * `fetchedCount`, because the row records the ITEM's response envelope. Reading
 * it as per-account evidence would license one brokerage account with its
 * sibling's history. It is deliberately not read here.
 *
 * ── What never licenses coverage ─────────────────────────────────────────────
 *   · pending rows      — unsettled; the walk reverses a POSTED anchor
 *   · deleted rows      — retracted evidence is not evidence
 *   · another account's rows
 *   · ingestion timestamps (createdAt on the row) — only the DATED field counts,
 *     which is why a transaction imported today can still prove 2024 existence
 *
 * READ-ONLY. Performs no valuation and reads no balances.
 */

import { db } from "@/lib/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { isoDate, truncDateUTC } from "@/lib/snapshots/backfill-core";
import {
  coverageClassFor, resolveAccountCoverage,
  type AccountHistoricalCoverage, type CoverageClass,
} from "./account-coverage.core";

type Client = PrismaClient | Prisma.TransactionClient;

/** One account as the gather needs it — identity and class only, never a balance. */
export interface CoverageAccountRef {
  id:   string;
  type: string;
  /** `isReconstructableCard(account)` — decided by the caller's canonical helper. */
  reconstructableCard: boolean;
  /** max(account.createdAt, link.createdAt), YYYY-MM-DD. */
  connectionFloorISO: string;
  /** Native balance, for the wallet ledger check. Null for non-wallets. */
  nativeBalance?: number | null;
}

/**
 * Resolve coverage for every supplied account: accountId → coverage.
 *
 * Batched — one query per evidence kind across all accounts, not one per
 * account. A Space with 11 accounts costs 4 queries, not 44.
 */
export async function getAccountCoverage(
  accounts: readonly CoverageAccountRef[],
  options?: { client?: Client },
): Promise<Map<string, AccountHistoricalCoverage>> {
  const client = options?.client ?? db;
  const out = new Map<string, AccountHistoricalCoverage>();
  if (accounts.length === 0) return out;

  const classOf = new Map<string, CoverageClass>(
    accounts.map((a) => [a.id, coverageClassFor(a.type, a.reconstructableCard)]),
  );
  const ids = accounts.map((a) => a.id);
  const walletIds = accounts.filter((a) => classOf.get(a.id) === "WALLET_LEDGER").map((a) => a.id);
  const positionIds = accounts.filter((a) => classOf.get(a.id) === "POSITION_SPINE").map((a) => a.id);

  const [txRows, obsRows, reconRows, eventRows, walletMovements] = await Promise.all([
    // POSTED, non-deleted, THIS account. `date` is the transaction's own dated
    // field — a row imported long after connection still proves earlier existence.
    client.transaction.groupBy({
      by: ["financialAccountId"],
      where: { financialAccountId: { in: ids }, deletedAt: null, pending: false },
      _min: { date: true },
    }),
    positionIds.length + walletIds.length > 0
      ? client.positionObservation.groupBy({
          by: ["financialAccountId"],
          where: { financialAccountId: { in: [...positionIds, ...walletIds] } },
          _min: { date: true },
        })
      : Promise.resolve([]),
    positionIds.length > 0
      ? client.positionReconstruction.groupBy({
          by: ["financialAccountId"],
          where: { financialAccountId: { in: positionIds } },
          _min: { earliestDefensibleDate: true },
        })
      : Promise.resolve([]),
    positionIds.length > 0
      ? client.investmentEvent.groupBy({
          by: ["financialAccountId"],
          where: { financialAccountId: { in: positionIds } },
          _min: { date: true },
        })
      : Promise.resolve([]),
    // Wallet ledger completeness needs the movement SUM, not a date.
    walletIds.length > 0
      ? client.transaction.groupBy({
          by: ["financialAccountId"],
          where: { financialAccountId: { in: walletIds }, deletedAt: null, pending: false },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
  ]);

  const iso = (d: Date | null | undefined) => (d ? isoDate(truncDateUTC(d)) : null);
  const byId = <T extends { financialAccountId: string | null }>(rows: T[]) =>
    new Map(rows.filter((r) => r.financialAccountId).map((r) => [r.financialAccountId as string, r]));

  const tx = byId(txRows);
  const obs = byId(obsRows as { financialAccountId: string | null; _min: { date: Date | null } }[]);
  const recon = byId(reconRows as { financialAccountId: string | null; _min: { earliestDefensibleDate: Date | null } }[]);
  const events = byId(eventRows as { financialAccountId: string | null; _min: { date: Date | null } }[]);
  const moves = byId(walletMovements as { financialAccountId: string | null; _sum: { amount: number | null } }[]);

  for (const a of accounts) {
    const coverageClass = classOf.get(a.id)!;
    let walletLedgerComplete: boolean | undefined;
    if (coverageClass === "WALLET_LEDGER") {
      const observed = a.nativeBalance ?? null;
      const total = moves.get(a.id)?._sum.amount ?? 0;
      // The same reconciliation `reconcileWalletLedger` performs, at the same
      // epsilon — asked here only as a yes/no licence for the replay floor.
      walletLedgerComplete = observed != null && Math.abs(observed - total) <= 1e-8;
    }

    out.set(a.id, resolveAccountCoverage({
      accountId: a.id,
      coverageClass,
      connectionFloorISO: a.connectionFloorISO,
      earliestPostedTxISO: iso(tx.get(a.id)?._min.date),
      earliestPositionObservationISO: iso(obs.get(a.id)?._min.date),
      earliestReconstructionAnchorISO: iso(recon.get(a.id)?._min.earliestDefensibleDate),
      earliestInvestmentEventISO: iso(events.get(a.id)?._min.date),
      walletLedgerComplete,
    }));
  }

  return out;
}

export type { AccountHistoricalCoverage };
