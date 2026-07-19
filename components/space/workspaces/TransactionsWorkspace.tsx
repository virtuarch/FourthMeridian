"use client";

/**
 * components/space/workspaces/TransactionsWorkspace.tsx  (SD-7)
 *
 * The Transactions destination, extracted from SpaceDashboard's inline `activeTab
 * === "TRANSACTIONS"` branch. Architecture-only: byte-identical render (the same
 * loading spinner + SpaceTransactionsPanel with the same props). The host owns the
 * SHARED transaction fetch (spaceTransactions also feeds the Overview doorway, Cash
 * Flow and Liquidity), so the rows/ctx/filter come in as props; the workspace owns
 * only the presentation. TX_SCOPE_NOTE is exported here (the Transactions surface is
 * its primary owner) and reused by the Overview doorway in the host.
 */

import { Loader2 } from "lucide-react";
import { SpaceTransactionsPanel } from "@/components/dashboard/widgets/SpaceTransactionsPanel";
import { TransactionCoverageNote } from "@/components/space/trust/TransactionCoverageNote";
import type { Transaction, Account as PersonalAccount } from "@/types";
import type { SpaceAccount } from "@/lib/space/dashboard-types";
import type { TransactionsCoverage } from "@/lib/transactions/coverage-note";
import type { SerializedConversionContext } from "@/lib/money/convert";

/** The scope caveat shown on the Transactions panel + the Overview doorway preview.
 *  Server-side KD-15 filtering means only fully-shared accounts' rows appear. */
export const TX_SCOPE_NOTE = "From fully shared accounts only";

export function TransactionsWorkspace({
  transactions,
  accounts,
  moneyCtx,
  initialAccountFilter,
  transactionsMeta,
}: {
  /** null ⇒ still loading (the host's lazy fetch hasn't resolved). */
  transactions: Transaction[] | null;
  accounts: SpaceAccount[];
  /** MC1 view-as: summary totals convert through this context; rows stay native. */
  moneyCtx?: SerializedConversionContext;
  /** Banking→Transactions retarget — deep-link account pre-filter. */
  initialAccountFilter: string | null;
  /** TX-2A — coverage state; drives an honest "most recent N" note when the read
   *  was capped. null/complete ⇒ no note (identical to before). */
  transactionsMeta?: TransactionsCoverage | null;
}) {
  if (transactions === null) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={18} className="animate-spin text-[var(--text-faint)]" />
      </div>
    );
  }
  return (
    <div className="space-y-3 min-w-0">
      {/* TX-2A — honest coverage line, only when the population was capped (TX-2).
          Renders nothing for a complete population, so no calculation or layout
          changes for the common case. */}
      <TransactionCoverageNote coverage={transactionsMeta} variant="browse" className="px-1" />
      <SpaceTransactionsPanel
        transactions={transactions}
        accounts={accounts.map((a) => ({ ...a, type: a.type as PersonalAccount["type"] })) as PersonalAccount[]}
        scopeNote={TX_SCOPE_NOTE}
        moneyCtx={moneyCtx}
        initialAccountFilter={initialAccountFilter}
      />
    </div>
  );
}
