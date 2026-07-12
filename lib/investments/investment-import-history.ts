/**
 * lib/investments/investment-import-history.ts
 *
 * A7-6 — list the investment ImportBatches belonging to a connection's accounts,
 * scoped by stable account ids (not institution name) and gated to the user. Safe
 * display fields only: a display filename, dates, source/profile, counts, status,
 * and a MASKED account label — never a raw account number or provider token.
 */

import { ImportBatchKind, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { getImportableAccountsForConnection } from "@/lib/investments/connection-import-accounts";
import { maskAccountLabel } from "@/lib/imports/investments/import-validation";

export interface ImportBatchSummary {
  id:          string;
  filename:    string | null;
  importedAt:  string;   // ISO — completedAt ?? createdAt
  source:      string;   // ImportSource (CSV | EXCEL | …)
  status:      string;   // ImportBatchStatus
  rolledBack:  boolean;
  account:     { id: string; label: string };  // label is masked ("account ending in 4421")
  counts:      { rowCount: number; importedCount: number; matchedCount: number; skippedCount: number; failedCount: number };
}

export async function getInvestmentImportHistoryForConnection(args: {
  connectionId: string;
  userId:       string;
  client?:      PrismaClient;
}): Promise<ImportBatchSummary[]> {
  const client = args.client ?? db;
  const accounts = await getImportableAccountsForConnection({ connectionId: args.connectionId, userId: args.userId, client });
  if (accounts.length === 0) return [];

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const batches = await client.importBatch.findMany({
    where:   { kind: ImportBatchKind.INVESTMENT_HISTORY, financialAccountId: { in: accounts.map((a) => a.id) } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, originalFilename: true, source: true, status: true, financialAccountId: true,
      completedAt: true, createdAt: true,
      rowCount: true, importedCount: true, matchedCount: true, skippedCount: true, failedCount: true,
    },
  });

  return batches.map((b) => {
    const acct = accountById.get(b.financialAccountId);
    return {
      id:         b.id,
      filename:   b.originalFilename,
      importedAt: (b.completedAt ?? b.createdAt).toISOString(),
      source:     b.source,
      status:     b.status,
      rolledBack: b.status === "ROLLED_BACK",
      account:    { id: b.financialAccountId, label: maskAccountLabel(acct?.mask ?? null, acct?.name) },
      counts:     { rowCount: b.rowCount, importedCount: b.importedCount, matchedCount: b.matchedCount, skippedCount: b.skippedCount, failedCount: b.failedCount },
    };
  });
}
