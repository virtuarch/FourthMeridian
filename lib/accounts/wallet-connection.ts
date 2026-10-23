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
 *
 * ── RLS-ACC-S4 — THE AUTHORITY, AND WHERE THIS SLICE STOPS ───────────────────
 * Six functions here had `client?: DbClient` resolved with `?? db`. No caller
 * anywhere passes one, so all six resolved to the migration principal in
 * production. Two of them are now REQUIRED and LEADING; four are not, and the
 * reason is a boundary rather than a judgement:
 *
 *   CLOSED — `ensureWalletConnection` and `linkAccountConnectionToWalletConnection`
 *     had NO importer outside this module (proved by five independent methods;
 *     see the reachability note below). They are module-private now, and their
 *     client is required and leading, with the compiler enumerating the one
 *     caller: `alignWalletProviderSpine`.
 *
 *   OPEN, AND NAMED — `recordWalletSyncRefusal`, `recordWalletFacetSuccess`,
 *     `markWalletAccountConnectionSynced` and `alignWalletProviderSpine` keep
 *     `client?`. Making those required is a COMPILE ERROR in five files this
 *     slice does not own, one of which is explicitly fenced:
 *
 *       app/api/accounts/wallet/route.ts   :190 :272 :346   FENCED (calls the
 *                                                           blocked merge subgraph)
 *       lib/crypto/btc-sync.ts             :1064 :1066 :1067 :1069 :1072
 *       lib/crypto/sol-sync.ts             :281
 *       lib/crypto/evm-native.ts           :302
 *       lib/crypto/wallet-sync-dispatch.ts :596 :668 :770 :821
 *
 *     That is not a mechanical edit to request either. Four of those five are
 *     PROVIDER-SYNC paths that interleave explorer and price HTTP with their
 *     writes, and `withTenantDb` is a SECURITY BOUNDARY, not a request-lifetime
 *     container — it must not span a network round trip. Their eventual authority
 *     is a genuine design decision (a per-phase tenant client passed down, or
 *     `fm_system` for the scheduled refresh, which would make `lib/crypto/` a
 *     systemDb neighbourhood and needs the `links-everywhere.ts` treatment). So
 *     it is a slice of its own, and the ask is recorded here rather than guessed.
 *
 *     What DID change for those four: the `?? db` is resolved ONCE per function,
 *     on its own line, under a marker. A defaulted authority that LOOKS converted
 *     is strictly worse than an obvious one (RLS-AI-S6), and four obvious ones
 *     that say what they are beat six hidden ones. The module keeps its `db`
 *     import and therefore its place on the ratchet, honestly.
 *
 * ── THREE DEAD EXPORTS, AND THE COUNT WAS ONE SHORT ──────────────────────────
 * Checked five ways, because a bare grep has been wrong twice in this programme:
 * static importers of this module path, `require`, dynamic `import()`, barrel
 * re-export, and a bare symbol grep across every .ts/.tsx/.js/.json/.md in the
 * repo. Exactly five files import from here, between them exactly six symbols —
 * `alignWalletProviderSpine`, `touchWalletConnectionStatus`,
 * `clearWalletConnectionError`, `markWalletAccountConnectionSynced`,
 * `recordWalletSyncRefusal`, `recordWalletFacetSuccess`. Dead as exports:
 *
 *   · `DbClient` — every external `DbClient` import in the repo comes from
 *     `@/lib/accounts/space-account-link`, never from here. A duplicate type.
 *     DELETED; this module imports the shared one, which also drops the
 *     `typeof db` that made the type depend on the client value.
 *   · the `walletConnectionCredential` / `walletExternalConnectionId` re-export —
 *     both consumers (`lib/accounts/wallet-connection.test.ts`,
 *     `lib/crypto/wallet-card-truth.test.ts`) import them from
 *     `@/lib/accounts/wallet-connection-format` directly. DELETED.
 *   · `ensureWalletConnection` AND `linkAccountConnectionToWalletConnection` —
 *     TWO functions, not one. Neither has an importer; both are called only from
 *     `alignWalletProviderSpine` in this file. UN-EXPORTED, not deleted: they are
 *     live at runtime and deleting them would be wrong.
 */

import { db } from "@/lib/db";
import { ConnectionStatus, ProviderType } from "@prisma/client";
import { dualWriteProviderAccountIdentity, isAuthorityRefusal, ProviderIdentityConflictError } from "@/lib/accounts/provider-identity";
import { walletConnectionCredential, walletExternalConnectionId } from "@/lib/accounts/wallet-connection-format";
import { setWalletConnectionHealth } from "@/lib/connections/health-transitions";
import type { DbClient } from "@/lib/accounts/space-account-link";

/**
 * Find-or-create the WALLET Connection backing a single-address wallet, deduped
 * by (userId, provider=WALLET, credential=address). Idempotent — re-adding the
 * same address reuses the existing Connection (no duplicate). There is no DB
 * unique constraint on this triple (no schema change in v1.5), so a rare
 * concurrent double-add could create two rows — acceptable and matches the
 * findFirst-then-create pattern the wallet route already uses for accounts.
 */
async function ensureWalletConnection(client: DbClient, params: {
  userId: string;
  address: string;
  chain: string;
}): Promise<{ id: string }> {
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
async function linkAccountConnectionToWalletConnection(client: DbClient, params: {
  financialAccountId: string;
  connectionId: string;
}): Promise<void> {
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
    // RLS-ACC-S4 — UNRESOLVED, AND SAYING SO. This `?? db` is the ONE place
    // this function's authority is chosen; see the module header for the five
    // call sites that must name theirs before the parameter can be required.
    const client: DbClient = params.client ?? db;
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
 * CRYPTO-FRESHNESS-1 — RECORD THAT A NAMED FACET ACTUALLY SUCCEEDED.
 *
 * `Connection.lastSyncedAt` means "a provider sync succeeded", and for a wallet
 * that is specifically "the BALANCE was read". The Connections card nonetheless
 * read it as "Transactions: Updated" and as "Financial profile: Built", so on
 * 2026-10-01 a BTC refresh whose transaction import had ABORTED at the 10 s
 * budget rendered "Transactions: Updated today". The import's FAILED outcome
 * travelled on the result object and reached the banner — which told the truth —
 * and was then discarded. No durable timestamp recorded it, so the card could
 * not tell a failed import from a successful one and claimed success by default.
 *
 * These clocks are written ONLY on the success of the facet named, so:
 *   · a failed import leaves `transactionsSyncedAt` where the last SUCCESSFUL
 *     one left it — a truthful older date, or null if there has never been one;
 *   · null means NEVER SUCCEEDED, and the UI renders that as silence rather than
 *     substituting a different clock.
 *
 * Only fields explicitly passed are written: a run that refreshed history but
 * failed its import must not advance the import's clock, and vice versa.
 *
 * Best-effort and non-throwing, like every other clock writer here: a sync must
 * not fail because recording its freshness failed.
 */
export async function recordWalletFacetSuccess(params: {
  financialAccountId: string;
  /** Set when the transaction-history acquisition COMPLETED. */
  transactionsSyncedAt?: Date;
  /** Set when the derived-history reconstruction COMPLETED. */
  historyRebuiltAt?: Date;
  client?: DbClient;
}): Promise<void> {
  const data: { transactionsSyncedAt?: Date; historyRebuiltAt?: Date } = {};
  if (params.transactionsSyncedAt) data.transactionsSyncedAt = params.transactionsSyncedAt;
  if (params.historyRebuiltAt)     data.historyRebuiltAt     = params.historyRebuiltAt;
  if (Object.keys(data).length === 0) return;
  try {
    // RLS-ACC-S4 — UNRESOLVED, AND SAYING SO. This `?? db` is the ONE place
    // this function's authority is chosen; see the module header for the five
    // call sites that must name theirs before the parameter can be required.
    const client: DbClient = params.client ?? db;
    const link = await client.accountConnection.findFirst({
      where:  { financialAccountId: params.financialAccountId, deletedAt: null, connectionId: { not: null } },
      select: { connectionId: true },
    });
    if (!link?.connectionId) return;
    await client.connection.update({ where: { id: link.connectionId }, data });
  } catch (e) {
    console.warn(`[wallet-connection] could not record facet freshness for ${params.financialAccountId} (non-fatal):`, e);
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
  // RLS-ACC-S4 — UNRESOLVED, AND SAYING SO. See the module header: btc-sync.ts
  // is this function's only caller and passes nothing.
  const client: DbClient = params.client ?? db;
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
    // RLS-ACC-S4 — UNRESOLVED, AND RESOLVED EXACTLY ONCE. The two callees below
    // take their client as a REQUIRED LEADING parameter, so this is the single
    // place in the wallet-spine path where the authority is chosen, instead of
    // three `?? db` defaults hidden one per function. See the module header for
    // the five call sites that block making this one required too.
    const client: DbClient = params.client ?? db;
    const connection = await ensureWalletConnection(client, {
      userId:  params.userId,
      address: params.address,
      chain:   params.chain,
    });
    await linkAccountConnectionToWalletConnection(client, {
      financialAccountId: params.financialAccountId,
      connectionId:       connection.id,
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
        client,
      });
    }
    return connection.id;
  } catch (e) {
    // RLS-ACC-S4 — THE CONTRACT IS HONOURED, THE DIAGNOSIS IS NOT BURIED.
    //
    // `dualWriteProviderAccountIdentity` now RAISES on an authority refusal
    // rather than swallowing it (see that module's header: a 42501 arrives with
    // no typed Prisma code, so the `P2002` catch never saw it and the identity
    // row went permanently missing). This catch would re-hide it.
    //
    // It is NOT re-thrown, and the asymmetry is deliberate. This function has an
    // EXPLICIT documented contract that five callers depend on — four of them
    // background provider-sync paths — that it returns null and never breaks the
    // caller's primary flow. Breaking that would change product behaviour as a
    // side effect of an authority migration, which is the drift RLS-C-S7 exists
    // to prevent. `dualWriteProviderAccountIdentity` makes no such promise about
    // its caller's flow, which is why the raise lives there: it escapes on the
    // PLAID exchange path, where the write order is actually wrong, and is
    // absorbed here, where (after RLS-ACC-S4's inversion of
    // `persistAccountSpine`) the link already exists and it should never fire.
    //
    // So the refusal gets its own severity and its own marker, because an
    // operator must be able to tell "the explorer was down" from "the database
    // refused us and a mirror row is now missing".
    if (isAuthorityRefusal(e)) {
      console.error(
        `[wallet-connection] AUTHORITY REFUSED a spine write for account ${params.financialAccountId} — ` +
        `an identity or connection row is now MISSING, and this is a write-ORDER defect, not a provider failure:`,
        e,
      );
      return null;
    }
    // ── PROVIDER-IDENTITY — THE SAME ASYMMETRY, FOR THE SAME STATED REASON ───
    //
    // The identity helper now also raises on a uniqueness collision it cannot
    // prove is this account's own. The documented contract above decides what
    // happens to it here: this function returns null and never breaks its five
    // callers' primary flows, so the conflict is absorbed exactly as the
    // authority refusal is — and, exactly as that one is, it gets its OWN
    // severity and marker instead of disappearing into the generic warn below.
    //
    // ⚠️ WHAT IT MEANS FOR A WALLET IS NOT WHAT IT MEANS FOR PLAID, and the
    // helper already encodes the difference: D2 Step 1D made a shared wallet
    // ADDRESS across two owners' accounts legitimate, so a foreign WALLET row
    // is not by itself a conflict. Reaching here therefore means either a
    // genuinely global collision or — the case that will matter once this path
    // runs on a tenant client — an INDETERMINATE reread, where the conflicting
    // row is real and hidden by RLS. Both leave the spine incomplete, which is
    // operator-visible and is why this is `error`, not `warn`.
    if (e instanceof ProviderIdentityConflictError) {
      console.error(
        `[wallet-connection] PROVIDER IDENTITY CONTESTED for account ${params.financialAccountId} ` +
        `(${e.verdict}, ${e.conflictingAccountCount} other holder(s)) — the Connection and AccountConnection stand, ` +
        `the identity row does NOT, and no alternate account was adopted. Spine alignment is INCOMPLETE:`,
        e,
      );
      return null;
    }
    console.warn(`[wallet-connection] spine alignment failed for account ${params.financialAccountId} (non-fatal):`, e);
    return null;
  }
}
