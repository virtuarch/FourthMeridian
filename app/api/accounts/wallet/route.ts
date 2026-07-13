/**
 * POST /api/accounts/wallet
 *
 * Manually adds a self-custodied crypto wallet to the user's space.
 * Balance starts at 0 — the sync job will populate it on next run.
 *
 * Creates:
 *   FinancialAccount   — canonical account row (ownerType=USER, no plaidAccountId)
 *   AccountConnection  — manual/wallet connection (no plaidItemDbId)
 *   SpaceAccountLink      — makes the account visible in the active space
 *   ProviderAccountIdentity (mirror) — best-effort dual-write, provider=WALLET.
 *     D2 Step 2. See lib/accounts/provider-identity.ts. Owner-scoped lookups
 *     below are unchanged: a wallet address is a public external fact, but
 *     each FinancialAccount's row here stays private to its own owner — no
 *     cross-owner sharing, reuse, or collision handling (D2 Step 1D).
 *
 * Body: {
 *   name:          string   // display name, e.g. "Ledger BTC"
 *   walletAddress: string   // public wallet address
 *   walletChain:   string   // "BTC" | "ETH" | "SOL" | "MATIC" | etc.
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { AccountType, AccountOwnerType, ShareStatus, VisibilityLevel, DuplicateDetectionSource } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { AuditAction } from "@/lib/audit-actions";
import { mergeArchivedDuplicateIntoCanonical } from "@/lib/accounts/reconcile";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { regenerateWealthHistoryForAccounts, recentWealthWindow } from "@/lib/snapshots/regenerate-history";

/**
 * Part-2 — after a BTC wallet's balance is synced, regenerate its Space's 30-day
 * wealth HISTORY (not just today's flat row) so the new CoinGecko-driven per-day
 * crypto valuation (a05ffbd) actually runs for a real wallet. Best-effort/non-
 * fatal and gated internally on WEALTH_REGENERATION_ENABLED. Distinct from
 * regenerateSnapshotsForAccounts (today's live row), which stays as-is.
 */
async function regenWalletWealthHistory(financialAccountId: string): Promise<void> {
  try {
    await regenerateWealthHistoryForAccounts([financialAccountId], recentWealthWindow());
  } catch (e) {
    console.warn(`[POST /api/accounts/wallet] wealth-history regen failed for ${financialAccountId} (non-fatal):`, e);
  }
}
import { dualWriteSpaceAccountLink } from "@/lib/accounts/space-account-link";
import { alignWalletProviderSpine } from "@/lib/accounts/wallet-connection";
import { syncBtcWallet, BTC_CHAIN } from "@/lib/crypto/btc-sync";
import { isExtendedKey, normalizeExtendedKeyInput } from "@/lib/crypto/btc-address-derivation";

const SUPPORTED_CHAINS = ["BTC", "ETH", "SOL", "MATIC", "AVAX", "DOT", "ADA", "XRP", "OTHER"];

export async function POST(req: NextRequest) {
  const [, err] = await requireUser();
  if (err) return err;

  const { name, walletAddress, walletChain } = await req.json();

  if (!name?.trim())          return NextResponse.json({ error: "Wallet name is required." },    { status: 400 });
  if (!walletAddress?.trim()) return NextResponse.json({ error: "Wallet address is required." }, { status: 400 });
  if (!walletChain?.trim())   return NextResponse.json({ error: "Chain is required." },          { status: 400 });

  const chain = walletChain.toUpperCase();
  if (!SUPPORTED_CHAINS.includes(chain)) {
    return NextResponse.json({ error: `Unsupported chain. Use: ${SUPPORTED_CHAINS.join(", ")}` }, { status: 400 });
  }

  // Wallet Provider v4 — the address field also accepts a BTC xpub/ypub/zpub
  // (watch-only descriptor). When it does, the stored walletAddress is the
  // descriptor, the Connection credential is the descriptor, and per-address
  // ProviderAccountIdentity rows are created by xpub discovery during sync —
  // NOT here (hence descriptorOnly on the spine align below).
  //
  // The user never picks a derivation path: normalizeExtendedKeyInput accepts a
  // bare xpub/ypub/zpub OR a Ledger-style JSON export ({xpub, freshAddressPath}),
  // and re-encodes to the prefix implied by the path's purpose (84'→zpub) so the
  // pipeline derives the correct address type. Non-descriptor input passes through
  // unchanged. Watch-only: only PUBLIC descriptors, never seeds/keys.
  const walletValue = chain === BTC_CHAIN ? normalizeExtendedKeyInput(walletAddress.trim()) : walletAddress.trim();
  const isXpub = chain === BTC_CHAIN && isExtendedKey(walletValue);

  const { spaceId, userId } = await getSpaceContext();

  // ── Automatic duplicate reconciliation ────────────────────────────────────
  // Same provider-identity check as Plaid reconnect: never create a second
  // visible row for a wallet address that already has one, and never show
  // the user a conflict — just reuse/reactivate the existing account.
  const activeFa = await db.financialAccount.findFirst({
    where: { ownerUserId: userId, walletAddress: walletValue, deletedAt: null },
    select: { id: true },
  });

  if (activeFa) {
    // Already exists and active — re-share into this space if needed and
    // return success silently. No 409, no "already connected" message.
    // D3 Stage B3 — SpaceAccountLink is the sole write target.
    await dualWriteSpaceAccountLink({
      spaceId,
      financialAccountId: activeFa.id,
      create: {
        addedByUserId:   userId,
        visibilityLevel: VisibilityLevel.FULL,
        status:          ShareStatus.ACTIVE,
      },
      update: {
        status:          ShareStatus.ACTIVE,
        revokedAt:       null,
        revokedByUserId: null,
      },
    });

    // D2 Step 2 — WALLET dual-write (best-effort, non-fatal; see
    // lib/accounts/provider-identity.ts). Owner-scoped lookup above is
    // unchanged — this only mirrors activeFa's own identity, never another
    // owner's FinancialAccount, per the D2 Step 1D corrected model.
    // Wallet Provider v1.5 — ensure the real Connection(WALLET) spine and link
    // the AccountConnection + ProviderAccountIdentity to it (also self-heals a
    // wallet created before v1.5). Idempotent, non-fatal.
    await alignWalletProviderSpine({ userId, financialAccountId: activeFa.id, address: walletValue, chain, descriptorOnly: isXpub });

    // walletAddress has no DB-level unique constraint, so an archived row
    // for this same address can exist alongside the active one (e.g. a
    // previous soft-delete that never got cleaned up). Before this fix,
    // that archived row was left permanently orphaned — nothing ever found
    // or merged it, since this branch returned immediately. Fold it into
    // the active row now, the same way the restore routes do.
    const archivedDup = await db.financialAccount.findFirst({
      where: { ownerUserId: userId, walletAddress: walletValue, deletedAt: { not: null } },
      select: { id: true },
    });
    if (archivedDup) {
      await mergeArchivedDuplicateIntoCanonical(
        archivedDup.id,
        activeFa.id,
        DuplicateDetectionSource.PROVIDER_IDENTITY_MATCH,
        spaceId
      );
    }

    // BTC wallet sync v1 — refresh the confirmed balance + USD value when an
    // existing BTC wallet is re-added (best-effort, non-fatal; matches the
    // create/reactivate branches). Without this, an already-existing wallet
    // has no automatic sync trigger at all — the reported "re-add does nothing"
    // bug. Runs BEFORE snapshot regen so the snapshot captures the fresh balance.
    if (chain === BTC_CHAIN) {
      try { await syncBtcWallet(activeFa.id); }
      catch (syncErr) { console.warn(`[POST /api/accounts/wallet] BTC sync failed for ${activeFa.id} (non-fatal):`, syncErr); }
    }

    // Regenerate SpaceSnapshot now that the share is active in this space —
    // same best-effort/non-fatal pattern as the reactivation branch below.
    try {
      await regenerateSnapshotsForAccounts([activeFa.id]);
    } catch (snapshotErr) {
      console.warn(`[POST /api/accounts/wallet] snapshot regen failed for account ${activeFa.id} (non-fatal):`, snapshotErr);
    }
    if (chain === BTC_CHAIN) await regenWalletWealthHistory(activeFa.id);

    return NextResponse.json({ success: true, accountId: activeFa.id }, { status: 200 });
  }

  // No active match — but a previously soft-deleted wallet with this address
  // would otherwise fall through to create() below and become a genuine
  // second row (walletAddress has no DB-level unique constraint). Reactivate
  // it instead of creating a duplicate.
  const archivedFa = await db.financialAccount.findFirst({
    where: { ownerUserId: userId, walletAddress: walletValue, deletedAt: { not: null } },
    select: { id: true },
  });

  if (archivedFa) {
    // KD-4 Phase 3 — reactivate FinancialAccount + AccountConnection + SAL
    // atomically. The providerIdentity mirror, snapshot regen, and the audit
    // write below stay OUTSIDE the transaction.
    await db.$transaction(async (tx) => {
      await tx.financialAccount.update({
        where: { id: archivedFa.id },
        data:  { deletedAt: null, syncStatus: "pending" },
      });
      await tx.accountConnection.updateMany({
        where: { financialAccountId: archivedFa.id, deletedAt: { not: null } },
        data:  { deletedAt: null },
      });
      // D3 Stage B3 — SpaceAccountLink is the sole write target.
      await dualWriteSpaceAccountLink({
        spaceId,
        financialAccountId: archivedFa.id,
        client:          tx,
        create: {
          addedByUserId:   userId,
          visibilityLevel: VisibilityLevel.FULL,
          status:          ShareStatus.ACTIVE,
        },
        update: {
          status:          ShareStatus.ACTIVE,
          revokedAt:       null,
          revokedByUserId: null,
        },
      });
    });

    // D2 Step 2 — WALLET dual-write (best-effort, non-fatal). Reactivating
    // this user's own archived account — no cross-owner behavior involved.
    // Wallet Provider v1.5 — ensure/link the Connection(WALLET) spine.
    await alignWalletProviderSpine({ userId, financialAccountId: archivedFa.id, address: walletValue, chain, descriptorOnly: isXpub });

    // BTC wallet sync v1 — populate the confirmed balance + USD value on
    // reactivate (best-effort, non-fatal). syncBtcWallet never throws; on
    // explorer/price failure the account stays visible and "pending" and a
    // SyncIssue is recorded (see lib/crypto/btc-sync.ts). Runs BEFORE snapshot
    // regen so the snapshot captures the freshly-synced balance.
    if (chain === BTC_CHAIN) {
      try { await syncBtcWallet(archivedFa.id); }
      catch (syncErr) { console.warn(`[POST /api/accounts/wallet] BTC sync failed for ${archivedFa.id} (non-fatal):`, syncErr); }
    }

    // Regenerate SpaceSnapshot now that the share is active again — see
    // docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md. Best-effort/non-fatal.
    try {
      await regenerateSnapshotsForAccounts([archivedFa.id]);
    } catch (snapshotErr) {
      console.warn(`[POST /api/accounts/wallet] snapshot regen failed for account ${archivedFa.id} (non-fatal):`, snapshotErr);
    }
    if (chain === BTC_CHAIN) await regenWalletWealthHistory(archivedFa.id);

    await db.auditLog.create({
      data: {
        userId,
        spaceId,
        action:   AuditAction.ACCOUNT_RESTORE,
        metadata: { name: name.trim(), chain, address: walletValue },
      },
    });
    return NextResponse.json({ success: true, accountId: archivedFa.id }, { status: 200 });
  }

  // ── KD-4 Phase 3 — new FinancialAccount + AccountConnection + SAL commit
  //    atomically. The providerIdentity mirror, snapshot regen, and audit
  //    write below stay OUTSIDE the transaction.
  const fa = await db.$transaction(async (tx) => {
    const created = await tx.financialAccount.create({
      data: {
        ownerType:     AccountOwnerType.USER,
        ownerUserId:   userId,
        createdByUserId: userId, // D11 — human-accountable creator
        name:          name.trim(),
        type:          AccountType.crypto,
        institution:   "Self-custodied",
        balance:       0,
        currency:      "USD",
        walletAddress: walletValue,
        walletChain:   chain,
        nativeBalance: 0,
        syncStatus:    "pending",
      },
    });

    // AccountConnection (manual, no PlaidItem)
    await tx.accountConnection.create({
      data: {
        financialAccountId: created.id,
        connectedByUserId:  userId,
        syncStatus:         "pending",
        isCanonical:        true,
      },
    });

    // D3 Stage B3 — SpaceAccountLink is the sole write target
    await dualWriteSpaceAccountLink({
      spaceId,
      financialAccountId: created.id,
      creatorUserId:       created.createdByUserId ?? created.ownerUserId,
      client:              tx,
      create: {
        addedByUserId:   userId,
        visibilityLevel: VisibilityLevel.FULL,
        status:          ShareStatus.ACTIVE,
      },
      update: {
        status:          ShareStatus.ACTIVE,
        revokedAt:       null,
        revokedByUserId: null,
      },
    });

    return created;
  });

  // D2 Step 2 — WALLET dual-write (best-effort, non-fatal). New row, so
  // dualWriteProviderAccountIdentity's find-by-{financialAccountId,
  // provider} lookup finds nothing and creates — no collision handling
  // needed: another owner's FinancialAccount for the same address (if any)
  // is an entirely separate row under the D2 Step 1D corrected model.
  // Wallet Provider v1.5 — ensure/link the Connection(WALLET) spine for the
  // brand-new wallet (Connection → ProviderAccountIdentity → AccountConnection).
  await alignWalletProviderSpine({ userId, financialAccountId: fa.id, address: walletValue, chain, descriptorOnly: isXpub });
  // D3 Step 3 HOME Semantics Correction — no separate HOME backfill call
  // needed here. computeLinkKind() (inside dualWriteSpaceAccountLink above)
  // now assigns HOME to the Space a brand-new account's first link is
  // written at — i.e. spaceId, the actually-active Space — rather than
  // synthesizing an extra HOME link at the creator's personal Space. See
  // docs/initiatives/d3/D3_STEP3_HOME_SEMANTICS_CORRECTION.md §5B.

  // BTC wallet sync v1 — populate the confirmed balance + USD value on add
  // (best-effort, non-fatal). syncBtcWallet never throws; on explorer/price
  // failure the wallet stays visible and "pending" and a SyncIssue is recorded
  // (see lib/crypto/btc-sync.ts). Runs BEFORE snapshot regen so the snapshot
  // captures the freshly-synced balance.
  if (chain === BTC_CHAIN) {
    try { await syncBtcWallet(fa.id); }
    catch (syncErr) { console.warn(`[POST /api/accounts/wallet] BTC sync failed for ${fa.id} (non-fatal):`, syncErr); }
  }

  // Regenerate SpaceSnapshot now that this new wallet is shared in —
  // same best-effort/non-fatal pattern as every other account-create/
  // reactivate path (see docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md).
  try {
    await regenerateSnapshotsForAccounts([fa.id]);
  } catch (snapshotErr) {
    console.warn(`[POST /api/accounts/wallet] snapshot regen failed for account ${fa.id} (non-fatal):`, snapshotErr);
  }
  if (chain === BTC_CHAIN) await regenWalletWealthHistory(fa.id);

  await db.auditLog.create({
    data: {
      userId,
      spaceId,
      action:   "WALLET_ADD",
      metadata: { name: fa.name, chain, address: walletValue },
    },
  });

  return NextResponse.json({ success: true, accountId: fa.id }, { status: 201 });
}
