"use client";

/**
 * components/space/workspaces/TransactionsWorkspace.tsx  (SD-7)
 *
 * The Transactions destination.
 *
 * TX-3.3 — this workspace no longer receives the host's SHARED transaction array.
 * The explorer queries the server itself (keyset-paged, server-filtered), so it needs
 * only the Space identity. The host's shared array still exists and still feeds the
 * ANALYTICAL consumers (Overview doorway, Cash Flow, Liquidity) until their own
 * projection migration — TX-3 does not redesign them.
 *
 * The TX-2A coverage note is gone from THIS surface for a good reason rather than an
 * oversight: it existed to admit that the browse list was a capped 5,000-row window.
 * The explorer is no longer capped — it pages the full population — so the caveat
 * would now be false here. It remains on the surfaces that still read the array.
 *
 * TX_SCOPE_NOTE is exported here (the Transactions surface is its primary owner) and
 * reused by the Overview doorway in the host.
 */

import { SpaceTransactionsPanel } from "@/components/dashboard/widgets/SpaceTransactionsPanel";
import type { Account as PersonalAccount } from "@/types";
import type { SpaceAccount } from "@/lib/space/dashboard-types";

/** The scope caveat shown on the Transactions panel + the Overview doorway preview.
 *  Server-side KD-15 filtering means only fully-shared accounts' rows appear. */
export const TX_SCOPE_NOTE = "From fully shared accounts only";

export function TransactionsWorkspace({
  spaceId,
  accounts,
  initialAccountFilter,
}: {
  /** The Space the explorer queries. */
  spaceId: string;
  accounts: SpaceAccount[];
  /** Banking→Transactions retarget — deep-link account pre-filter. */
  initialAccountFilter: string | null;
}) {
  return (
    <div className="space-y-3 min-w-0">
      <SpaceTransactionsPanel
        spaceId={spaceId}
        accounts={accounts.map((a) => ({ ...a, type: a.type as PersonalAccount["type"] })) as PersonalAccount[]}
        scopeNote={TX_SCOPE_NOTE}
        initialAccountFilter={initialAccountFilter}
      />
    </div>
  );
}
