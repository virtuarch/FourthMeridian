/**
 * lib/accounts/persist-account-spine.ts
 *
 * PROV-4 — the canonical per-account connection-spine writer.
 *
 * Both real spine producers — the Plaid exchange path (per account, in a loop)
 * and the Wallet add route (per new/reactivated wallet) — wrote the SAME thing
 * by hand: inside one `$transaction`, ensure this account's `AccountConnection`
 * is present + active, then `dualWriteSpaceAccountLink` it into the space as
 * FULL / ACTIVE. Both files even named it the same ("KD-4 Phase 3 — … commit
 * atomically"). That is proven duplication across TWO real producers, so the
 * abstraction is earned (CCPAY-2G doctrine: extract from the second instance).
 *
 * ── Scope, deliberately (do not over-reach) ─────────────────────────────────
 * This owns the genuinely-shared middle of the spine: AccountConnection +
 * SpaceAccountLink, atomically, per account. It does NOT own the parts that
 * DIVERGE between Plaid and Wallet — folding those would be designing a neutral
 * shape from producers that don't actually share it:
 *   • FinancialAccount RESOLUTION is provider-specific — Plaid resolves via
 *     provider-identity → legacy → fingerprint (resolveAccountByFingerprint);
 *     Wallet resolves by walletAddress. Each caller resolves/creates its own FA
 *     and passes the id in.
 *   • The ProviderAccountIdentity mirror is provider-specific — Plaid uses
 *     dualWriteProviderAccountIdentity(externalAccountId); Wallet uses
 *     alignWalletProviderSpine (which also owns the WALLET Connection). Callers
 *     keep those calls around this writer.
 *   • Connection is written per-Plaid-item (once, before the account loop) or by
 *     alignWalletProviderSpine — not per account. It is referenced here only as
 *     the optional `connectionId` FK on the AccountConnection row.
 * There is intentionally NO "update-only" spine mode: refresh updates
 * FinancialAccount BALANCES and writes no connection spine, so it is not a
 * second producer of this write. A mode with zero producers would be the
 * speculative abstraction PROV explicitly defers. See the provider-orchestration
 * notes in docs/plans/prov-provider-orchestration-refactor.md.
 */

import { db } from "@/lib/db";
import { ShareStatus, VisibilityLevel } from "@prisma/client";
import { dualWriteSpaceAccountLink, type DbClient } from "@/lib/accounts/space-account-link";

/** Provider-specific AccountConnection facts for this account. */
export interface AccountSpineConnection {
  /** The acting user; AccountConnection.connectedByUserId. */
  connectedByUserId: string;
  /** Plaid item link, when the source is Plaid; omitted for Wallet. */
  plaidItemDbId?: string | null;
  /** Connection FK, when already known; Wallet sets this later via alignWalletProviderSpine. */
  connectionId?: string | null;
  /** Initial/refreshed sync status — "synced" (Plaid exchange) | "pending" (Wallet). */
  syncStatus: string;
}

export interface PersistAccountSpineParams {
  /** The already-resolved/created FinancialAccount id (caller owns resolution). */
  financialAccountId: string;
  /** The active space this account is being linked into. */
  spaceId: string;
  /** Acting user — SpaceAccountLink.addedByUserId. */
  addedByUserId: string;
  /** For SpaceAccountLink kind computation; typically fa.createdByUserId ?? fa.ownerUserId. */
  creatorUserId?: string | null;
  /** The AccountConnection facts. */
  connection: AccountSpineConnection;
  /**
   * Optional outer transaction. When the caller already wraps a larger
   * per-account write in `db.$transaction` (Wallet add commits FinancialAccount
   * + spine together), it passes `tx` here so conn + SAL run in THAT transaction
   * and this writer does NOT open a nested one. Omit it (Plaid exchange, whose FA
   * is resolved before the loop) and this writer opens its own `db.$transaction`
   * so conn + SAL still commit atomically. Either way the conn+SAL boundary is
   * preserved exactly as each caller had it.
   */
  client?: DbClient;
}

/**
 * Ensure the AccountConnection + SpaceAccountLink for one account, atomically.
 *
 * The AccountConnection is keyed on (financialAccountId, connectedByUserId,
 * plaidItemDbId): if a row exists it is UPDATED and revived (deletedAt: null,
 * lastSyncedAt bumped, connectionId filled only when newly known); otherwise it
 * is CREATED. A brand-new account finds nothing and creates (Wallet add); a
 * re-link finds and revives (Plaid exchange re-run, Wallet reactivate). The
 * SpaceAccountLink is written FULL / ACTIVE through the shared dual-writer.
 *
 * Runs in its own `db.$transaction` so the AccountConnection and the
 * SpaceAccountLink commit together — the per-account atomicity boundary both
 * callers already relied on. FinancialAccount resolution/creation, the
 * ProviderAccountIdentity mirror, and any Connection write stay OUTSIDE this
 * boundary (as they already were), owned by the provider-specific caller.
 *
 * ── RLS-ACC-S4 — THE ORDER IS INVERTED, AND IT IS NOT A PREFERENCE ───────────
 * This writer did `AccountConnection` first and `SpaceAccountLink` second. Under
 * `fm_app` that order cannot work, and it fails in TWO distinct ways rather than
 * one. MEASURED against a real provisioned fm_app role on a throwaway Postgres:
 *
 *   1. THE WRITE IS REFUSED. `AccountConnection.fm_app_ins` is
 *      `WITH CHECK (fm_account_visible("financialAccountId"))`, true only while
 *      an ACTIVE link exists in a visible Space. On an account with no link:
 *        PostgresError 42501, "new row violates row-level security policy for
 *        table \"AccountConnection\"" — and an INSERT refusal RAISES, so the
 *        whole transaction rolls back. `FinancialAccount` is fine: its policy has
 *        an `ownerUserId` arm for exactly this "visible to its creator before any
 *        link exists" case (measured: the owner CAN read their link-less
 *        account). Its subtree has no such arm.
 *
 *   2. THE EXISTENCE PROBE IS BLINDED, WHICH IS THE WORSE HALF AND IS NEW.
 *      The `findFirst` that decides CREATE vs UPDATE is as policy-filtered as the
 *      write. With the link REVOKED — the re-link case this writer exists to
 *      serve — it was measured returning NULL for a row that is genuinely there.
 *      The writer would then take the CREATE branch, and `AccountConnection` has
 *      NO unique constraint on (financialAccountId, connectedByUserId,
 *      plaidItemDbId) — only indexes — so the duplicate LANDS. Measured: a second
 *      identical row created, count 1 → 2, nothing raised. A refused write is
 *      loud; a blinded read is a silent duplicate.
 *
 * Both are closed by one move: `dualWriteSpaceAccountLink` goes FIRST, at the top
 * of the transaction, so the link that confers visibility exists before anything
 * reads or writes the subtree. Within the same transaction the just-inserted
 * link is visible to `fm_account_visible`, measured end to end:
 * FA.create → SAL.create → AC.create → PAI.create all succeed.
 *
 * ⚠️ DO NOT "TIDY" THIS BACK. Reading the connection first is the natural way to
 * write this function and it is why it was written that way. The ordering is
 * pinned by source scan in lib/accounts/account-spine-s4.authority.test.ts,
 * because local development has no role URLs and reversing it would fail nothing
 * at runtime here. This is the third instance of the phenomenon RLS-C-S7
 * (b42e8e0) recorded twice for disconnect/restore, and RLS-ACC-S3 found a fourth
 * and fifth in the manual-asset routes.
 *
 * The SpaceAccountLink write is idempotent (`dualWriteSpaceAccountLink` upserts
 * and reasserts ACTIVE), so moving it earlier changes no outcome — only which
 * statement observes which state. `computeLinkKind` counts links to decide HOME
 * vs SHARED and is unaffected: it was already reading the link table, not the
 * connection table.
 */
export async function persistAccountSpine(params: PersistAccountSpineParams): Promise<void> {
  const { financialAccountId, spaceId, addedByUserId, creatorUserId, connection } = params;
  const plaidItemDbId = connection.plaidItemDbId ?? null;

  // Run in the caller's transaction when given one (Wallet: FA + spine atomic);
  // otherwise open our own so conn + SAL still commit together (Plaid exchange).
  const run = async (tx: DbClient) => {
    // ── THE LINK COMES FIRST. See the header: both the connection READ and the
    //    connection WRITE are gated on `fm_account_visible`, so neither can
    //    happen correctly before the link that confers it exists.
    //
    // D3 Stage B3 — SpaceAccountLink is the sole write target.
    await dualWriteSpaceAccountLink(tx, {
      spaceId,
      financialAccountId,
      creatorUserId,
      create: {
        addedByUserId,
        visibilityLevel: VisibilityLevel.FULL,
        status:          ShareStatus.ACTIVE,
      },
      update: {
        status:          ShareStatus.ACTIVE,
        revokedAt:       null,
        revokedByUserId: null,
      },
    });

    // Now the subtree is reachable, so this probe tells the truth about whether
    // a connection row exists — which is what decides CREATE vs UPDATE, and
    // therefore whether a duplicate lands on a table with no unique constraint.
    const existing = await tx.accountConnection.findFirst({
      where: {
        financialAccountId,
        connectedByUserId: connection.connectedByUserId,
        plaidItemDbId,
      },
    });

    if (!existing) {
      await tx.accountConnection.create({
        data: {
          financialAccountId,
          connectedByUserId: connection.connectedByUserId,
          plaidItemDbId,
          connectionId:      connection.connectionId ?? null,
          syncStatus:        connection.syncStatus,
          isCanonical:       true,
        },
      });
    } else {
      await tx.accountConnection.update({
        where: { id: existing.id },
        data: {
          syncStatus:   connection.syncStatus,
          lastSyncedAt: new Date(),
          deletedAt:    null,
          // Fill connectionId only when newly known — never clobber an existing FK.
          ...(connection.connectionId && !existing.connectionId ? { connectionId: connection.connectionId } : {}),
        },
      });
    }
  };

  if (params.client) await run(params.client);
  else await db.$transaction(run);
}
