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
 *   walletChain:   string   // one of PRODUCT_CHAIN_VALUES (lib/crypto/product-chains.ts)
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { getSpaceContext } from "@/lib/space";
import { AccountType, AccountOwnerType, ShareStatus, VisibilityLevel, DuplicateDetectionSource } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { AuditAction } from "@/lib/audit-actions";
import { mergeArchivedDuplicateIntoCanonical } from "@/lib/accounts/reconcile";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { regenerateWealthHistoryForAccounts } from "@/lib/snapshots/regenerate-history";
import { resolveHistoricalWorkWindow } from "@/lib/snapshots/historical-work-window";

/**
 * Part-2 — after a wallet's balance is synced, regenerate its Space's wealth
 * HISTORY (not just today's flat row) so the per-day crypto valuation actually
 * runs for a real wallet. Best-effort/non-fatal and gated internally on
 * WEALTH_REGENERATION_ENABLED. Distinct from regenerateSnapshotsForAccounts
 * (today's live row), which stays as-is.
 *
 * W-M1d — CALLED ONLY FOR A HISTORY_SUPPORTED CHAIN (today: BTC). Regeneration
 * derives a historical quantity, and a chain with no movement ledger has nothing
 * to derive one from: running it would refuse every day, and a refusal nobody
 * can act on is an invitation to "fix" it by painting today's quantity backwards.
 * The gate is `chainSupportsHistory`, so promoting a chain is one registry edit
 * rather than a hunt through four call sites.
 *
 * W6f — it used to be `feedsLegacyWealthHistory`, which asked where a chain's
 * historical quantity was STORED. That answered the capability question only by
 * coincidence, and W6c broke the coincidence: Bitcoin's history moved onto the
 * spine, the predicate went empty for every chain, and all four of these call
 * sites silently stopped regenerating anything.
 *
 * V26-ORCH-1 — this used a FIXED 30-DAY window, so a newly connected wallet
 * built one month of history and stopped, even where the price provider could
 * serve a full year and the quantity was licensed across all of it. Every deeper
 * rebuild had to be run by hand. It now asks the canonical planner, which
 * intersects evidence, provider prices and the writable ceiling.
 *
 * Deliberately still best-effort and AWAITED-but-non-fatal: connection success
 * must not depend on a long historical rebuild, and the regenerator already
 * defers/skip-frozens internally.
 */
async function regenWalletWealthHistory(financialAccountId: string): Promise<void> {
  try {
    // A first connection has no measurable "what changed" — there is no prior
    // state to diff against — so no `changedSince` is supplied and the planner
    // correctly takes the whole supportable interval.
    const plan = await resolveHistoricalWorkWindow({ financialAccountIds: [financialAccountId] });
    console.log(
      `[POST /api/accounts/wallet] historical window ${plan.fromDate}..${plan.toDate} ` +
      `(${plan.mode}) — ${plan.reasons.join("; ")}`,
    );
    await regenerateWealthHistoryForAccounts([financialAccountId], { fromDate: plan.fromDate, toDate: plan.toDate });
  } catch (e) {
    console.warn(`[POST /api/accounts/wallet] wealth-history regen failed for ${financialAccountId} (non-fatal):`, e);
  }
}
/**
 * W-M1d — sync a freshly connected/restored wallet through its chain's adapter.
 *
 * BEST-EFFORT AND NON-FATAL, exactly as the BTC call it replaces: connecting a
 * wallet must succeed even when the chain cannot be read right now. Every
 * adapter already promises never to throw and to leave the account visible and
 * "pending" on failure, and the dispatcher catches a contract violation on top.
 *
 * An UNSUPPORTED chain is a NORMAL outcome here, not an error: the wallet is
 * recorded, visible, and honestly unsynced. It is logged rather than surfaced
 * because the user asked to record custody and that is what happened.
 */
async function syncWalletBestEffort(
  financialAccountId: string,
  chain: string,
): Promise<{ ok: boolean; errorCode?: string; reason?: string }> {
  const outcome = await syncWalletByChain(financialAccountId, chain);
  if (!outcome.ok) {
    console.warn(
      `[POST /api/accounts/wallet] ${outcome.chain} sync did not complete for ` +
      `${financialAccountId} (non-fatal, ${outcome.support}) — ${outcome.stage ?? "?"}: ${outcome.reason ?? ""}`,
    );
  }
  return { ok: outcome.ok, errorCode: outcome.errorCode, reason: outcome.reason };
}

import { dualWriteSpaceAccountLink } from "@/lib/accounts/space-account-link";
// PROV-4 — canonical per-account conn+SAL spine writer, shared with Plaid exchange.
import { persistAccountSpine } from "@/lib/accounts/persist-account-spine";
import { alignWalletProviderSpine } from "@/lib/accounts/wallet-connection";
import { BTC_CHAIN } from "@/lib/crypto/btc-sync";
import { isProductSupportedChain, PRODUCT_CHAIN_VALUES } from "@/lib/crypto/product-chains";
import { syncWalletByChain, chainSupportsHistory } from "@/lib/crypto/wallet-sync-dispatch";
import { isExtendedKey, normalizeExtendedKeyInput } from "@/lib/crypto/btc-address-derivation";

// W-M2c — validation reads the SAME product-surface authority the picker
// renders. It previously kept its own wider list, so the two could disagree in
// both directions: BNB was offered and refused, while ADA/XRP/DOT/OTHER were
// accepted by the API after being removed from the menu. Hiding an option is
// not a restriction if the endpoint behind it still accepts the value.

export async function POST(req: NextRequest) {
  const [, err] = await requireUser();
  if (err) return err;

  const { name, walletAddress, walletChain } = await req.json();

  if (!name?.trim())          return NextResponse.json({ error: "Wallet name is required." },    { status: 400 });
  if (!walletAddress?.trim()) return NextResponse.json({ error: "Wallet address is required." }, { status: 400 });
  if (!walletChain?.trim())   return NextResponse.json({ error: "Chain is required." },          { status: 400 });

  const chain = walletChain.toUpperCase();
  if (!isProductSupportedChain(chain)) {
    return NextResponse.json(
      { error: `Unsupported chain. Use: ${PRODUCT_CHAIN_VALUES.join(", ")}` }, { status: 400 });
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

  // ── RLS-PREP-C — THE RESOLUTION AND ITS WRITES ARE ONE TENANT PHASE ────────
  // Look up → (re-share | reactivate | create) used to be three lookups and two
  // owner transactions on the migration principal. They are one `withTenantDb`
  // transaction on `fm_app` now, so the row this request decides to reuse is
  // the row it then writes, and every statement is policy-subject:
  //
  //   FinancialAccount   INSERT/DELETE owner-only; SELECT/UPDATE owner or linked.
  //                      Every lookup here is `ownerUserId = userId`, which is
  //                      the policy's own owner arm — including the ARCHIVED row,
  //                      whose links are revoked and which only that arm reaches.
  //   AccountConnection  account subtree (owner arm, RLS-D1).
  //   SpaceAccountLink   `spaceId` must be a Space the caller is a member of. A
  //                      forged active-Space cookie cannot plant a link in
  //                      somebody else's Space: WITH CHECK refuses the INSERT and
  //                      the refusal RAISES.
  //
  // ⚠️ NOTHING IN THIS PHASE CAN REPORT A REFUSED WRITE AS SUCCESS. The account
  // writes are `create` and `update({ where: { id } })`, both of which raise
  // when the policy refuses them (42501 / P2025). The one `updateMany` — the
  // reactivated wallet's archived AccountConnection rows — is keyed by the
  // account whose visibility the `update` on the line above has just proved in
  // this same phase, under a policy keyed on that same account; a zero there
  // means "it had no archived connections", which is a real and ordinary answer.
  //
  // ⚠️ NO NETWORK IN HERE. Provider sync and history regeneration run AFTER the
  // phase commits, exactly as they ran after the old transactions.
  type Resolved =
    | { kind: "active"; accountId: string }
    | { kind: "reactivated"; accountId: string }
    | { kind: "created"; accountId: string; name: string };

  const resolved = await withTenantDb(userId, async (tx): Promise<Resolved> => {
    // ── Automatic duplicate reconciliation ──────────────────────────────────
    // Same provider-identity check as Plaid reconnect: never create a second
    // visible row for a wallet address that already has one, and never show
    // the user a conflict — just reuse/reactivate the existing account.
    const activeFa = await tx.financialAccount.findFirst({
      where: { ownerUserId: userId, walletAddress: walletValue, deletedAt: null },
      select: { id: true },
    });

    if (activeFa) {
      // Already exists and active — re-share into this space if needed and
      // return success silently. No 409, no "already connected" message.
      // D3 Stage B3 — SpaceAccountLink is the sole write target.
      await dualWriteSpaceAccountLink(tx, {
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
      return { kind: "active", accountId: activeFa.id };
    }

    // No active match — but a previously soft-deleted wallet with this address
    // would otherwise fall through to create() below and become a genuine
    // second row (walletAddress has no DB-level unique constraint). Reactivate
    // it instead of creating a duplicate.
    const archivedFa = await tx.financialAccount.findFirst({
      where: { ownerUserId: userId, walletAddress: walletValue, deletedAt: { not: null } },
      select: { id: true },
    });

    if (archivedFa) {
      // KD-4 Phase 3 — reactivate FinancialAccount + AccountConnection + SAL
      // atomically (now atomic with the lookup that chose the row, too).
      await tx.financialAccount.update({
        where: { id: archivedFa.id },
        data:  { deletedAt: null, syncStatus: "pending" },
      });
      await tx.accountConnection.updateMany({
        where: { financialAccountId: archivedFa.id, deletedAt: { not: null } },
        data:  { deletedAt: null },
      });
      // D3 Stage B3 — SpaceAccountLink is the sole write target.
      await dualWriteSpaceAccountLink(tx, {
        spaceId,
        financialAccountId: archivedFa.id,
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
      return { kind: "reactivated", accountId: archivedFa.id };
    }

    // ── KD-4 Phase 3 — new FinancialAccount + AccountConnection + SAL commit
    //    atomically.
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

    // PROV-4 — AccountConnection (manual, no PlaidItem) + SpaceAccountLink via
    // the canonical spine writer shared with the Plaid exchange path. Passed
    // `tx` so the whole FA + spine commit stays in ONE transaction, exactly as
    // before. The WALLET Connection + ProviderAccountIdentity are written
    // separately by alignWalletProviderSpine below (provider-specific).
    await persistAccountSpine({
      financialAccountId: created.id,
      spaceId,
      addedByUserId:      userId,
      creatorUserId:      created.createdByUserId ?? created.ownerUserId,
      connection: { connectedByUserId: userId, syncStatus: "pending" },
      client:             tx,
    });

    return { kind: "created", accountId: created.id, name: created.name };
  });

  // ── AFTER THE PHASE: three branches, exactly as before ─────────────────────
  // Everything below ran after the old transactions too, and in this order. It
  // is kept as three explicit branches rather than folded into one, because the
  // sequence in each (align → sync → snapshot → history → audit) is pinned
  // per branch by the wallet suites, and a fold would hide which branch a
  // future edit changed.
  //
  // ⚠️ `alignWalletProviderSpine` IS STILL ON ITS OWN, DEFAULTED AUTHORITY — AND
  // NAMED AS SUCH. The WALLET Connection row, the AccountConnection → Connection
  // link and the ProviderAccountIdentity mirror are NOT converted here. It cannot
  // simply be handed the phase's client:
  //   · it is best-effort and SWALLOWS its own failures, and a statement that
  //     fails inside a transaction aborts the transaction — the account this
  //     request just created would roll back with the bookkeeping;
  //   · its identity write, `dualWriteProviderAccountIdentity`, takes no client
  //     at all, and its collision classifier has measured tenant-blind
  //     semantics that are a decision, not an edit (lib/accounts/
  //     provider-identity.ts, acceptance case 84).
  // It runs after the phase has committed, exactly where it ran before, and it
  // is counted: scripts/audit-db-authority.ts records these call sites in the
  // implicit-owner-call ratchet, so they cannot become invisible by this file no
  // longer importing `db`.

  if (resolved.kind === "active") {
    const activeFa = { id: resolved.accountId };

    // D2 Step 2 — WALLET dual-write (best-effort, non-fatal; see
    // lib/accounts/provider-identity.ts). Wallet Provider v1.5 — ensure the real
    // Connection(WALLET) spine and link the AccountConnection +
    // ProviderAccountIdentity to it (also self-heals a wallet created before
    // v1.5). Idempotent, non-fatal.
    await alignWalletProviderSpine({ userId, financialAccountId: activeFa.id, address: walletValue, chain, descriptorOnly: isXpub });

    // walletAddress has no DB-level unique constraint, so an archived row
    // for this same address can exist alongside the active one (e.g. a
    // previous soft-delete that never got cleaned up). Before this fix,
    // that archived row was left permanently orphaned — nothing ever found
    // or merged it, since this branch returned immediately. Fold it into
    // the active row now, the same way the restore routes do.
    //
    // RLS-PREP-C — the fold runs on this route's own tenant role, as it does in
    // both restore routes since RLS-ACC-S6 (20261003000100 gave
    // DuplicateAccountCandidate the owner arm the fold needs; acceptance cases
    // 86-87). The lookup and the fold are one phase.
    await withTenantDb(userId, async (tx) => {
      const archivedDup = await tx.financialAccount.findFirst({
        where: { ownerUserId: userId, walletAddress: walletValue, deletedAt: { not: null } },
        select: { id: true },
      });
      if (!archivedDup) return;
      await mergeArchivedDuplicateIntoCanonical(
        archivedDup.id,
        activeFa.id,
        DuplicateDetectionSource.PROVIDER_IDENTITY_MATCH,
        spaceId,
        tx,
      );
    });

    // BTC wallet sync v1 — refresh the confirmed balance + USD value when an
    // existing BTC wallet is re-added (best-effort, non-fatal; matches the
    // create/reactivate branches). Without this, an already-existing wallet
    // has no automatic sync trigger at all — the reported "re-add does nothing"
    // bug. Runs BEFORE snapshot regen so the snapshot captures the fresh balance.
    const activeSync = await syncWalletBestEffort(activeFa.id, chain);

    // Regenerate SpaceSnapshot now that the share is active in this space —
    // same best-effort/non-fatal pattern as the reactivation branch below.
    try {
      await regenerateSnapshotsForAccounts([activeFa.id]);
    } catch (snapshotErr) {
      console.warn(`[POST /api/accounts/wallet] snapshot regen failed for account ${activeFa.id} (non-fatal):`, snapshotErr);
    }
    if (chainSupportsHistory(chain)) await regenWalletWealthHistory(activeFa.id);

    return NextResponse.json({ success: true, accountId: activeFa.id, initialSync: activeSync }, { status: 200 });
  }

  if (resolved.kind === "reactivated") {
    const archivedFa = { id: resolved.accountId };

    // D2 Step 2 — WALLET dual-write (best-effort, non-fatal). Reactivating
    // this user's own archived account — no cross-owner behavior involved.
    // Wallet Provider v1.5 — ensure/link the Connection(WALLET) spine.
    await alignWalletProviderSpine({ userId, financialAccountId: archivedFa.id, address: walletValue, chain, descriptorOnly: isXpub });

    // BTC wallet sync v1 — populate the confirmed balance + USD value on
    // reactivate (best-effort, non-fatal). syncBtcWallet never throws; on
    // explorer/price failure the account stays visible and "pending" and a
    // SyncIssue is recorded (see lib/crypto/btc-sync.ts). Runs BEFORE snapshot
    // regen so the snapshot captures the freshly-synced balance.
    const archivedSync = await syncWalletBestEffort(archivedFa.id, chain);

    // Regenerate SpaceSnapshot now that the share is active again — see
    // docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md. Best-effort/non-fatal.
    try {
      await regenerateSnapshotsForAccounts([archivedFa.id]);
    } catch (snapshotErr) {
      console.warn(`[POST /api/accounts/wallet] snapshot regen failed for account ${archivedFa.id} (non-fatal):`, snapshotErr);
    }
    if (chainSupportsHistory(chain)) await regenWalletWealthHistory(archivedFa.id);

    // An AuditLog INSERT is refused loudly or not at all (`fm_app_ins` is
    // WITH CHECK (true)); it is a phase of its own because it follows network work.
    await withTenantDb(userId, (tx) => tx.auditLog.create({
      data: {
        userId,
        spaceId,
        action:   AuditAction.ACCOUNT_RESTORE,
        metadata: { name: name.trim(), chain, address: walletValue },
      },
    }));
    return NextResponse.json({ success: true, accountId: archivedFa.id, initialSync: archivedSync }, { status: 200 });
  }

  const fa = { id: resolved.accountId, name: resolved.name };

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
  const initialSync = await syncWalletBestEffort(fa.id, chain);

  // Regenerate SpaceSnapshot now that this new wallet is shared in —
  // same best-effort/non-fatal pattern as every other account-create/
  // reactivate path (see docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md).
  try {
    await regenerateSnapshotsForAccounts([fa.id]);
  } catch (snapshotErr) {
    console.warn(`[POST /api/accounts/wallet] snapshot regen failed for account ${fa.id} (non-fatal):`, snapshotErr);
  }
  if (chainSupportsHistory(chain)) await regenWalletWealthHistory(fa.id);

  await withTenantDb(userId, (tx) => tx.auditLog.create({
    data: {
      userId,
      spaceId,
      action:   "WALLET_ADD",
      metadata: { name: fa.name, chain, address: walletValue },
    },
  }));

  // W-M2a — 201 IS CORRECT, AND IT NOW SAYS SO PRECISELY.
  //
  // Creating the wallet and synchronising it are two operations, and W-M1d made
  // the second deliberately non-fatal: a provider outage must not stop a user
  // recording that they hold a wallet. The status code answers the first
  // question — the connection WAS persisted — and `initialSync` answers the
  // second, so "created" can no longer be mistaken for "synced".
  //
  // The state a surface renders still comes from the Connection (via
  // /api/sync/status), not from this body; `initialSync` exists so the create
  // response itself is not silent about an outcome it already knows.
  return NextResponse.json({ success: true, accountId: fa.id, initialSync }, { status: 201 });
}
