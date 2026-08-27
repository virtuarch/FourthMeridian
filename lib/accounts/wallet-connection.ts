/**
 * lib/accounts/wallet-connection.ts
 *
 * Wallet Provider v1.5 — provider-spine alignment.
 *
 * Moves self-custodied wallet accounts onto the same provider spine Plaid uses:
 *
 *     Connection(provider=WALLET)
 *       → ProviderAccountIdentity(connectionId)
 *       → AccountConnection(connectionId)
 *       → FinancialAccount → existing balance sync
 *
 * Before v1.5 a wallet had a FinancialAccount + a ProviderAccountIdentity but
 * NO Connection row (see FOURTH_MERIDIAN_WALLET_PROVIDER_ARCHITECTURE_INVESTIGATION_2026-07-09.md
 * §1). This module creates/links that missing Connection. It reuses the existing
 * Connection model as-is (whose `credential` field is documented for
 * "xpub/descriptor for WALLET watch-only — NEVER a private key") — no schema
 * change, and no rewrite of the balance sync.
 *
 * Scope guard (v1.5): single public address per wallet. The Connection's
 * `credential` is the address itself (a degenerate single-address descriptor);
 * xpub/descriptor discovery is v4. No Holdings, no transactions, no other chains.
 *
 * Everything here is best-effort / non-fatal — spine bookkeeping must never
 * break wallet add/re-add/reactivate or a balance sync. Mirrors the
 * dualWriteProviderAccountIdentity / dualWriteSpaceAccountLink philosophy.
 */

import { db } from "@/lib/db";
import { ConnectionStatus, ProviderType, type Prisma } from "@prisma/client";
import { dualWriteProviderAccountIdentity } from "@/lib/accounts/provider-identity";
import { walletConnectionCredential, walletExternalConnectionId } from "@/lib/accounts/wallet-connection-format";
import { setWalletConnectionHealth } from "@/lib/connections/health-transitions";

export type DbClient = Prisma.TransactionClient | typeof db;

// Re-exported for call-site convenience; defined in the DB-free format module
// so they stay unit-testable under the bare-tsx runner.
export { walletConnectionCredential, walletExternalConnectionId };

/**
 * Find-or-create the WALLET Connection backing a single-address wallet, deduped
 * by (userId, provider=WALLET, credential=address). Idempotent — re-adding the
 * same address reuses the existing Connection (no duplicate). There is no DB
 * unique constraint on this triple (no schema change in v1.5), so a rare
 * concurrent double-add could create two rows — acceptable and matches the
 * findFirst-then-create pattern the wallet route already uses for accounts.
 */
export async function ensureWalletConnection(params: {
  userId: string;
  address: string;
  chain: string;
  client?: DbClient;
}): Promise<{ id: string }> {
  const client = params.client ?? db;
  const credential = walletConnectionCredential(params.address, params.chain);

  const existing = await client.connection.findFirst({
    where: { userId: params.userId, provider: ProviderType.WALLET, credential },
    select: { id: true },
  });
  if (existing) return existing;

  return client.connection.create({
    data: {
      userId:               params.userId,
      provider:             ProviderType.WALLET,
      credential,
      externalConnectionId: walletExternalConnectionId(params.chain, params.address),
      status:               ConnectionStatus.ACTIVE,
    },
    select: { id: true },
  });
}

/**
 * Point the account's not-yet-linked AccountConnection row(s) at the wallet
 * Connection. Only touches rows whose connectionId is still null, so it's
 * idempotent and never repoints a row that already belongs to a Connection.
 */
export async function linkAccountConnectionToWalletConnection(params: {
  financialAccountId: string;
  connectionId: string;
  client?: DbClient;
}): Promise<void> {
  const client = params.client ?? db;
  // UI-C1 — RE-POINT A LINK THAT LANDED ON A DIFFERENT ROW FOR THE SAME WALLET.
  //
  // This only ever filled a NULL link, which is right while one wallet can have
  // only one Connection. A case-sensitive credential broke that: Ethereum's
  // create route stored the checksummed address and its sync adapter the
  // lower-cased one, so `ensureWalletConnection` produced a SECOND row and the
  // wallet's identity split across the two — the AccountConnection on one, the
  // ProviderAccountIdentity and every success stamp on the other. The card read
  // the linked row, saw `lastSyncedAt: null`, and reported a wallet that had in
  // fact synced perfectly as a terminal sync error.
  //
  // `canonicalWalletAddress` stops new splits. This heals the ones already
  // written: the caller has just resolved the canonical Connection for this
  // account, so a link pointing anywhere else is stale by construction and is
  // moved. Idempotent, and a no-op for every correctly linked wallet.
  await client.accountConnection.updateMany({
    where: {
      financialAccountId: params.financialAccountId,
      deletedAt:          null,
      // Plaid rows are never wallet-linked and must not be touched.
      plaidItemDbId:      null,
      OR: [{ connectionId: null }, { connectionId: { not: params.connectionId } }],
    },
    data:  { connectionId: params.connectionId },
  });
}

/**
 * Record a balance sync against the wallet Connection. On success: status
 * ACTIVE, lastSyncedAt now, errorCode cleared. On failure: record errorCode
 * only — a transient explorer/price failure is recoverable, so we do NOT flip
 * status to ERROR (that enum means "unrecoverable") and we do NOT touch
 * lastSyncedAt. Never throws.
 */
export async function touchWalletConnectionStatus(params: {
  connectionId: string;
  ok: boolean;
  errorCode?: string | null;
}): Promise<void> {
  // CH-2 — delegate to the transition chokepoint. It reproduces the exact write
  // body (success → ACTIVE/lastSyncedAt/errorCode null; failure → errorCode
  // only, status untouched) and additionally records a durable transition row
  // when the DERIVED wallet health (errorCode present vs absent) flips. Still
  // best-effort / non-throwing.
  await setWalletConnectionHealth(params.connectionId, { ok: params.ok, errorCode: params.errorCode });
}

/**
 * W-M2a — RECORD A SYNC REFUSAL ON THE CONNECTION, WHICH IS PROVIDER-SYNC TRUTH.
 *
 * `Connection.status / lastSyncedAt / errorCode` is the authority the Connections
 * surface derives its state from. Until now only BTC's xpub-discovery branch ever
 * wrote a failure there: every other refusal — a missing provider endpoint, a
 * malformed address, a transport failure — recorded a `SyncIssue` and left the
 * Connection saying nothing at all. A Connection that says nothing was then read
 * as "first sync still pending", so a terminal refusal rendered as active
 * discovery. The refusal existed; it was simply never told to the authority that
 * answers the question.
 *
 * ONLY WRITES WHEN NO CODE IS ALREADY RECORDED. An adapter that diagnosed its own
 * failure precisely (INVALID_XPUB, NO_USED_ADDRESSES, RATE_LIMITED) has said
 * something more useful than a generic stage code, and this must never overwrite
 * it. The generic code is a floor, not a replacement.
 *
 * Best-effort and non-throwing: a wallet's sync outcome must not fail because
 * recording it failed.
 */
export async function recordWalletSyncRefusal(params: {
  financialAccountId: string;
  errorCode: string;
  client?: DbClient;
}): Promise<void> {
  try {
    const client = params.client ?? db;
    const link = await client.accountConnection.findFirst({
      where:  { financialAccountId: params.financialAccountId, deletedAt: null, connectionId: { not: null } },
      select: { connectionId: true },
    });
    if (!link?.connectionId) return;
    const conn = await client.connection.findUnique({
      where:  { id: link.connectionId },
      select: { errorCode: true },
    });
    if (!conn || conn.errorCode !== null) return; // a more specific diagnosis stands
    await touchWalletConnectionStatus({ connectionId: link.connectionId, ok: false, errorCode: params.errorCode });
  } catch (e) {
    console.warn(`[wallet-connection] could not record sync refusal for ${params.financialAccountId} (non-fatal):`, e);
  }
}

/**
 * Clear a stale error WITHOUT marking the connection fully synced. Used when an
 * xpub sync makes partial discovery PROGRESS: a prior run's errorCode must not
 * outlive it (that's what wrongly pinned the card on "Sync Error"), but the
 * wallet is still discovering — so we leave `lastSyncedAt` untouched, keeping the
 * card in the importing/"Discovering addresses…" state, not ready. Best-effort.
 */
export async function clearWalletConnectionError(connectionId: string): Promise<void> {
  // CH-2 — delegate to the chokepoint with markSynced:false, which reproduces
  // this body exactly (status ACTIVE, errorCode null, lastSyncedAt deliberately
  // untouched so the card stays in "Discovering addresses…") and records a
  // degraded→healthy transition row when a stale error is actually cleared.
  await setWalletConnectionHealth(connectionId, { ok: true, markSynced: false });
}

/**
 * Mirror a successful sync onto the wallet's AccountConnection row(s), for
 * compatibility with the shared AccountConnection sync fields. The AUTHORITATIVE
 * provider-sync record is `Connection.status/lastSyncedAt` (touched separately) —
 * this only keeps the mirror fields fresh. Scoped to manual/wallet connections
 * (`plaidItemDbId: null`) so a Plaid row is never touched. `@updatedAt` bumps
 * `updatedAt` automatically. Best-effort — the caller wraps it.
 */
export async function markWalletAccountConnectionSynced(params: {
  financialAccountId: string;
  client?: DbClient;
}): Promise<void> {
  const client = params.client ?? db;
  await client.accountConnection.updateMany({
    where: { financialAccountId: params.financialAccountId, plaidItemDbId: null, deletedAt: null },
    data:  { syncStatus: "synced", lastSyncedAt: new Date() },
  });
}

/**
 * Ensure the full provider spine for a wallet account: Connection exists, the
 * AccountConnection and ProviderAccountIdentity both point at it. Idempotent
 * and non-fatal — returns the Connection id, or null if alignment failed (which
 * must never break the caller's primary flow). Also serves as the lazy backfill
 * for wallets created before v1.5: any add/re-add/reactivate/sync self-heals.
 *
 * `markSynced` additionally stamps Connection.lastSyncedAt/status (used by the
 * balance sync's success path).
 */
export async function alignWalletProviderSpine(params: {
  userId: string;
  financialAccountId: string;
  address: string;
  chain: string;
  client?: DbClient;
  markSynced?: boolean;
  // Wallet Provider v4 — when `address` is an xpub/descriptor (not a real
  // address), skip the single-identity dual-write. The per-address identities
  // are created by xpub discovery (btc-sync), NOT here — otherwise this would
  // wrongly create a ProviderAccountIdentity whose externalAccountId is the xpub.
  descriptorOnly?: boolean;
}): Promise<string | null> {
  try {
    const connection = await ensureWalletConnection({
      userId:  params.userId,
      address: params.address,
      chain:   params.chain,
      client:  params.client,
    });
    await linkAccountConnectionToWalletConnection({
      financialAccountId: params.financialAccountId,
      connectionId:       connection.id,
      client:             params.client,
    });
    // Identity dual-write is itself best-effort; passing connectionId links the
    // existing (or new) ProviderAccountIdentity row to this Connection. Skipped
    // for descriptors (xpub) — discovery owns their per-address identities.
    if (!params.descriptorOnly) {
      await dualWriteProviderAccountIdentity(
        params.financialAccountId,
        ProviderType.WALLET,
        params.address.trim(),
        connection.id,
      );
    }
    if (params.markSynced) {
      // Connection = provider-sync truth.
      await touchWalletConnectionStatus({ connectionId: connection.id, ok: true });
      // AccountConnection mirror (compatibility) — kept fresh, not authoritative.
      await markWalletAccountConnectionSynced({
        financialAccountId: params.financialAccountId,
        client:             params.client,
      });
    }
    return connection.id;
  } catch (e) {
    console.warn(`[wallet-connection] spine alignment failed for account ${params.financialAccountId} (non-fatal):`, e);
    return null;
  }
}
