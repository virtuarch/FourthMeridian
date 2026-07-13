/**
 * app/(shell)/dashboard/connections/page.tsx
 *
 * D2.x Slice 3 — first increment of the permanent Connections hub.
 *
 * The single place users land after connecting a provider. Server-renders the
 * current connections (from PlaidItem, via the provider-agnostic
 * lib/sync/status derivation) plus discovered accounts (existing getAccounts,
 * grouped by institution), then hands off to the ConnectionsList client poller
 * which drives first-run "building" cards → "ready".
 *
 * This route is additive: /dashboard/accounts is untouched. Provider picker,
 * Sync Center actions, and folding the Accounts list in here are later slices.
 */

import { getSpaceContext } from "@/lib/space";
import { getAccounts } from "@/lib/data/accounts";
import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
import { buildSyncStatus, finalizeSyncStatus } from "@/lib/sync/status";
import { loadWalletSyncConnections } from "@/lib/sync/wallet-connections";
import { ConnectionsList } from "@/components/connections/ConnectionsList";
import { ConnectionsActions } from "@/components/connections/ConnectionsActions";
import type { AccountLite } from "@/components/connections/ConnectionCard";

export const preferredRegion = "sin1";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const { userId, spaceId } = await getSpaceContext();

  // Connections (own PlaidItems) → provider-agnostic status seed.
  const items = await db.plaidItem.findMany({
    where:  { userId, status: { not: PlaidItemStatus.REVOKED } },
    select: {
      id:                 true,
      institutionName:    true,
      status:             true,
      syncIncompleteAt:   true, // derivation only — never sent to client
      lastSyncedAt:       true,
      errorCode:          true,
      investmentsConsent: true, // → client-safe `investments` capability only
    },
    orderBy: { createdAt: "asc" },
  });
  const plaidStatus = buildSyncStatus(items);

  // Wallet connections (provider=WALLET) ride the same SyncConnection contract.
  // Merge them so self-custodied wallets appear as cards alongside Plaid, and a
  // wallet-only user never sees the empty state.
  const wallet = await loadWalletSyncConnections(userId);
  const initialStatus = finalizeSyncStatus([...plaidStatus.connections, ...wallet.connections]);

  // Discovered accounts grouped by institution name (own Space). NAMES ONLY —
  // Connections is a provider-management surface, not the Accounts page, so no
  // balances/currency are carried into this view model at all.
  const accounts = await getAccounts({ spaceId });
  const accountsByInstitution: Record<string, AccountLite[]> = {};
  for (const a of accounts) {
    if (!a.institution) continue; // redacted/BALANCE_ONLY — not one of the user's own connections
    (accountsByInstitution[a.institution] ??= []).push({
      id:   a.id,
      name: a.name,
      type: a.type,
    });
  }

  const hasConnections = initialStatus.connections.length > 0;

  return (
    <div className="space-y-4 pb-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Connections</h1>
          <p className="text-sm text-[var(--text-muted)]">Manage the institutions and providers connected to Fourth Meridian.</p>
        </div>
        {hasConnections && <ConnectionsActions />}
      </div>

      {hasConnections ? (
        <ConnectionsList
          initialStatus={initialStatus}
          accountsByInstitution={accountsByInstitution}
          accountsByConnectionId={wallet.accountsByConnectionId}
        />
      ) : (
        <div className="mx-auto max-w-md pt-4">
          <ConnectionsActions centered />
        </div>
      )}
    </div>
  );
}
