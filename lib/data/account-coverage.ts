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
import { reconcileWalletLedger } from "@/lib/crypto/ledger-completeness.core";
import { nativeAssetForChain, ledgerEpsilonFor } from "@/lib/crypto/native-asset";

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
  /**
   * W-M0 — `FinancialAccount.walletChain`, which names the asset `nativeBalance`
   * counts and therefore which movement rows may reconcile against it. Absent ⇒
   * the asset is unknown, no movements qualify, and the ledger cannot be
   * licensed — the same honest refusal an unrecognised chain gets.
   *
   * PRE-EXISTING DIVERGENCE, unchanged here and recorded so it is not mistaken
   * for a consequence of W-M0: `accounts-asof.ts` supplies neither
   * `nativeBalance` nor this, so every crypto account reaching coverage by that
   * path already resolves `walletLedgerComplete = false`, while
   * `accounts-asof-window.ts` supplies the balance and can resolve true. Two
   * callers, two answers, for the same account. Fixing that means deciding
   * which is right, which is a replay-floor question, not this slice's.
   */
  walletChain?: string | null;
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
  // W-M0 — the native asset each wallet's balance and movements denominate.
  const walletAssetById = new Map(
    accounts
      .filter((a) => classOf.get(a.id) === "WALLET_LEDGER")
      .map((a) => [a.id, nativeAssetForChain(a.walletChain)] as const),
  );
  const walletSymbols = [
    ...new Set([...walletAssetById.values()].filter((x) => x !== null).map((x) => x!.symbol)),
  ].sort();
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
    //
    // W-M0 — SCOPED TO THE NATIVE ASSET. This summed EVERY non-deleted,
    // non-pending row on a crypto account regardless of denomination, then
    // compared the result to a native quantity. On the live corpus that means a
    // wallet holding 0.02 BTC was reconciled against a −1470 sum of
    // fiat-magnitude rows: arithmetic between two different units, which happens
    // to refuse for the right reason and would bless for the wrong one if the
    // numbers ever coincided. Grouping by currency lets each account be matched
    // to rows in ITS OWN asset below.
    walletSymbols.length > 0
      ? client.transaction.groupBy({
          by: ["financialAccountId", "currency"],
          where: {
            financialAccountId: { in: walletIds },
            currency:           { in: walletSymbols },
            deletedAt:          null,
            pending:            false,
          },
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
  // Keyed by account AND currency, so a row can only ever count toward the
  // account whose native asset it actually denominates.
  const movesByAccountCurrency = new Map<string, number>();
  for (const r of walletMovements as { financialAccountId: string | null; currency: string | null; _sum: { amount: number | null } }[]) {
    if (!r.financialAccountId || !r.currency) continue;
    movesByAccountCurrency.set(`${r.financialAccountId}|${r.currency}`, r._sum.amount ?? 0);
  }

  for (const a of accounts) {
    const coverageClass = classOf.get(a.id)!;
    let walletLedgerComplete: boolean | undefined;
    if (coverageClass === "WALLET_LEDGER") {
      // W-M0 — THE reconciliation, not a copy of it. This reimplemented the
      // comparison inline against a hardcoded `1e-8`, so the "same epsilon" its
      // comment promised was a promise nothing enforced: the moment the ledger
      // authority's tolerance became a property of the asset, this line would
      // have kept answering in satoshis for every chain. Calling the authority
      // makes the claim structural.
      //
      // Behaviourally identical for BTC: reconcileWalletLedger refuses exactly
      // where |observed − Σ| exceeds the tolerance, refuses a null/non-finite
      // balance, and treats a zero balance with no movements as reconciled —
      // which is what the inline expression already computed.
      const asset = walletAssetById.get(a.id) ?? null;
      const total = asset ? movesByAccountCurrency.get(`${a.id}|${asset.symbol}`) ?? 0 : 0;
      walletLedgerComplete = reconcileWalletLedger({
        observedBalance: a.nativeBalance ?? null,
        movements:       [total],
        epsilon:         ledgerEpsilonFor(asset),
      }).complete;
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
