/**
 * lib/accounts/recover-plaid-account.ts
 *
 * THE ACCOUNT AN IMPORT NEVER CREATED, CREATED LATER — SO ONE MISSING ROW
 * STOPS PINNING AN ITEM'S CURSOR FOREVER.
 *
 * ══ THE LIVENESS FAILURE THIS EXISTS FOR ════════════════════════════════════
 *
 * `lib/plaid/exchangeToken.ts`'s per-account loop is 3N+5 independently
 * committing units with no surrounding try/catch, so a failure at account i
 * leaves accounts 1..i-1 fully persisted and i..N absent. Nothing records which
 * accounts are missing, and NO recovery path may create one —
 * `refreshBalancesForItem` says so in terms ("Never creates/restores/relinks an
 * account") and drops unresolved provider accounts at the `if (!fa) continue`.
 *
 * Then the first transaction page containing a row for a missing account does
 * this, in `syncTransactions.ts`:
 *
 *     resolveFinancialAccountId(txn.account_id) → null
 *       → recordSyncIssue{MISSING_ACCOUNT, cursorBlocking: true}
 *       → pageFailures.push(...)
 *       → CURSOR SAFETY GATE throws PlaidSyncIncompleteError
 *       → the cursor is NOT advanced
 *
 * The gate is correct — a page that was not fully persisted must replay. But
 * nothing can ever make that page persist, so `resume-stale-imports` re-fetches
 * and re-bills the identical Plaid page every five minutes, indefinitely, and
 * the item's ENTIRE transaction history stays blocked behind it. With only five
 * slots per run, oldest-first, five stuck items also starve every newer import.
 *
 * ══ WHY THE TRIGGER IS THE SyncIssue AND NOT A NEW PIECE OF STATE ═══════════
 *
 * The condition is already durably recorded, by the code that detects it, with
 * the `plaidAccountId` named — and `@@index([plaidItemId, kind])` makes asking
 * cheap. So healthy items pay one indexed count and nothing else; only an item
 * that has ALREADY reported a cursor-blocking missing account pays a provider
 * call. The existing auto-resolution closes those issues once a page proves
 * recovery (`resolveCursorBlockingIssues`), so the trigger clears itself.
 *
 * ⚠️ AND THE CALL SITE IS BEFORE THE TRANSACTIONS STAGE, NOT AFTER THE BALANCE
 * ONE. The obvious reading — hang recovery off `refreshBalancesForItem`, which
 * already fetches the authoritative account list — CANNOT WORK, and the control
 * flow says why: `runDeferredHistorySync` runs `syncTransactionsForItem` FIRST,
 * so on a blocked item the throw skips the balance stage entirely. Recovery has
 * to happen before the thing it unblocks.
 *
 * ══ WHAT THIS REFUSES TO DO, AND WHY EACH REFUSAL IS LOAD-BEARING ═══════════
 *
 * `accountsGet` IS THE ONLY ADMISSIBLE IDENTITY SOURCE. An account is created
 * only from the provider's own authoritative list for this item, carrying the
 * name, type, subtype, mask and balances the exchange would have used. A
 * transaction's `account_id` is NEVER enough: it names an account without
 * describing one, and inventing the rest is fabrication.
 *
 * SOFT-DELETED MEANS THE USER REMOVED IT — NEVER RESTORE. The resolver returns
 * soft-deleted rows, which is what makes "missing" decidable: `null` means no
 * row has ever existed, and only that licenses a create. Restoring an account
 * somebody deliberately disconnected would be strictly worse than the defect.
 *
 * AN INACTIVE OWNER GETS NOTHING, AND THE GUARD IS HERE RATHER THAN IN THE
 * CALLER. `lib/account-deletion/purge.ts` hard-deletes a user's
 * FinancialAccounts at step 5 and only reaches `user.delete` — which cascades
 * PlaidItem — at step 8, so between them an ACTIVE item exists whose accounts
 * are gone. `resume-stale-imports` is safe (`user: { deactivatedAt: null }`,
 * and `app/api/user/delete/route.ts` sets `deactivatedAt` with the request) —
 * BUT the webhook path reaches `runDeferredHistorySync` with no such gate.
 * Recreating accounts there would resurrect data for a user mid-deletion. So
 * the check lives in the step that does the creating, where no caller can
 * forget it, and it runs BEFORE the provider call so a deactivating user's item
 * accrues no Plaid spend either.
 *
 * THE SPACE COMES FROM EVIDENCE OR NOT AT ALL. A recovered account has to be
 * linked somewhere, and there is no request to ask. It joins the Space its
 * SIBLINGS on the same PlaidItem are linked into — the same institution, the
 * same connect action, a Space the owner demonstrably chose. If the item has no
 * sibling link at all (a total import failure, nothing to infer from) this
 * REFUSES and records it, rather than picking the owner's PERSONAL Space and
 * calling that a decision the owner made.
 *
 * ⚠️ IT IS ALSO NOT A FIX FOR AN ACCOUNT PLAID NO LONGER RETURNS. If a
 * transaction references an account absent from `accountsGet` too, there is
 * nothing to create and this changes nothing — the item stays blocked and
 * recorded. That residual case is reported, not papered over; see the slice's
 * commit message.
 *
 * ══ AUTHORITY ══════════════════════════════════════════════════════════════
 * Every database statement runs in ONE tenant phase bound to the ITEM'S OWNER,
 * which is whose account this is. No `systemDb`, no migration principal, and no
 * `@/lib/db` import — this module cannot reach a privileged client. The
 * provider call is made BEFORE the phase opens, so no network round trip is ever
 * held inside a transaction.
 */

import type { AccountsGetResponse } from "plaid";

import type { Prisma } from "@prisma/client";
import { AccountOwnerType, ProviderType, ShareStatus, SyncIssueKind } from "@prisma/client";
import { withTenantDb } from "@/lib/db/tenant-context";
import { mapAccountType } from "@/lib/plaid/account-type";
import { persistAccountSpine } from "@/lib/accounts/persist-account-spine";
import { dualWriteProviderAccountIdentity } from "@/lib/accounts/provider-identity";
import { resolvePlaidAccountByExternalId } from "@/lib/accounts/reconcile";

type ProviderAccount = AccountsGetResponse["accounts"][number];

/** Why a provider account was NOT created. Every value is a deliberate refusal. */
export type RecoveryRefusal =
  /** The identity resolves — nothing was missing after all. */
  | "ALREADY_PRESENT"
  /** A row exists but is soft-deleted: the owner removed it. Never restored here. */
  | "PREVIOUSLY_REMOVED"
  /** No sibling link on this item, so no Space can be derived from evidence. */
  | "NO_SPACE_EVIDENCE";

export type PlaidAccountRecovery =
  | { status: "CREATED"; plaidAccountId: string; financialAccountId: string; spaceId: string }
  | { status: "REFUSED"; plaidAccountId: string; reason: RecoveryRefusal };

export type RecoveryOutcome = {
  /** False when the trigger did not fire, or the owner is inactive. */
  attempted: boolean;
  /** Why nothing was attempted. Absent when `attempted`. */
  skipped?: "NO_BLOCKING_ISSUE" | "OWNER_INACTIVE" | "ITEM_NOT_FOUND";
  results: PlaidAccountRecovery[];
};

export type RecoverPlaidAccountsDeps = {
  /** Loads the item, its owner's active state, and the decrypted access token. */
  loadItem: (plaidItemDbId: string) => Promise<{
    userId: string;
    ownerDeactivated: boolean;
    accessToken: string;
    institutionName: string | null;
    institutionId: string | null;
  } | null>;
  /** Count of UNRESOLVED cursor-blocking MISSING_ACCOUNT issues for this item. */
  countBlockingIssues: (plaidItemDbId: string) => Promise<number>;
  /** The provider's authoritative account list for this item. */
  fetchProviderAccounts: (accessToken: string) => Promise<ProviderAccount[]>;
  /**
   * The tenant phase. Defaults to the real `withTenantDb`, so production is
   * byte-identical; injected only so the behavioural proof in
   * lib/plaid/missing-account-liveness.test.ts can drive THIS function rather
   * than a model of it. The same seam, and the same reason, as
   * `syncTransactionsForItem`'s `{ db, plaid }`.
   */
  runPhase?: <T>(userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  /** The identity mirror. Defaults to the real dual-write helper. */
  writeIdentity?: (financialAccountId: string, externalAccountId: string) => Promise<void>;
};

/**
 * Bring an item's local account population up to the provider's, but only for
 * accounts that have NEVER existed, and only when the item is actually blocked.
 */
export async function recoverMissingPlaidAccountsForItem(
  plaidItemDbId: string,
  deps: RecoverPlaidAccountsDeps,
): Promise<RecoveryOutcome> {
  const item = await deps.loadItem(plaidItemDbId);
  if (!item) return { attempted: false, skipped: "ITEM_NOT_FOUND", results: [] };

  // Before the provider call, deliberately: a deactivating owner's item must
  // accrue no Plaid spend, and must never have accounts recreated under it.
  if (item.ownerDeactivated) return { attempted: false, skipped: "OWNER_INACTIVE", results: [] };

  const blocking = await deps.countBlockingIssues(plaidItemDbId);
  if (blocking === 0) return { attempted: false, skipped: "NO_BLOCKING_ISSUE", results: [] };

  // OUTSIDE every transaction. The phase below opens after this resolves.
  const providerAccounts = await deps.fetchProviderAccounts(item.accessToken);

  const runPhase = deps.runPhase ?? (withTenantDb as RecoverPlaidAccountsDeps["runPhase"])!;
  const writeIdentity = deps.writeIdentity
    ?? ((faId: string, ext: string) => dualWriteProviderAccountIdentity(faId, ProviderType.PLAID, ext));

  const results = await runPhase(item.userId, async (tx) => {
    // The Space its siblings are in. Read once, inside the phase, so the
    // evidence and the writes share a snapshot. `distinct` is not used: the
    // first ACTIVE link is enough, and ordering by creation makes the choice
    // deterministic rather than dependent on physical row order.
    const siblingLink = await tx.spaceAccountLink.findFirst({
      where: {
        status:           ShareStatus.ACTIVE,
        financialAccount: { connections: { some: { plaidItemDbId, deletedAt: null } } },
      },
      orderBy: { createdAt: "asc" },
      select:  { spaceId: true, addedByUserId: true },
    });

    const out: PlaidAccountRecovery[] = [];
    for (const acct of providerAccounts) {
      // Returns soft-deleted rows too — that is what makes "never existed"
      // distinguishable from "the owner removed it".
      const existing = await resolvePlaidAccountByExternalId(tx, acct.account_id);
      if (existing && !existing.deletedAt) {
        out.push({ status: "REFUSED", plaidAccountId: acct.account_id, reason: "ALREADY_PRESENT" });
        continue;
      }
      if (existing) {
        out.push({ status: "REFUSED", plaidAccountId: acct.account_id, reason: "PREVIOUSLY_REMOVED" });
        continue;
      }
      if (!siblingLink) {
        out.push({ status: "REFUSED", plaidAccountId: acct.account_id, reason: "NO_SPACE_EVIDENCE" });
        continue;
      }

      // The field set is the exchange's (lib/plaid/exchangeToken.ts), including
      // `mapAccountType` rather than a second mapping, so a recovered account is
      // indistinguishable from one the import would have written.
      const created = await tx.financialAccount.create({
        data: {
          ownerType:        AccountOwnerType.USER,
          ownerUserId:      item.userId,
          createdByUserId:  item.userId,
          plaidAccountId:   acct.account_id,
          name:             acct.name,
          plaidName:        acct.name,
          officialName:     acct.official_name ?? undefined,
          type:             mapAccountType(acct.type, acct.subtype),
          institution:      item.institutionName ?? "",
          institutionId:    item.institutionId ?? undefined,
          mask:             acct.mask ?? undefined,
          balance:          acct.balances.current ?? 0,
          availableBalance: acct.balances.available ?? undefined,
          creditLimit:      acct.balances.limit ?? undefined,
          currency:         acct.balances.iso_currency_code ?? "USD",
          syncStatus:       "synced",
        },
        select: { id: true },
      });

      // Link first, then connection — persistAccountSpine's own ordering
      // requirement, since the connection write is gated on the visibility the
      // link confers. Threading `tx` keeps it inside this one phase.
      await persistAccountSpine({
        financialAccountId: created.id,
        spaceId:            siblingLink.spaceId,
        addedByUserId:      siblingLink.addedByUserId ?? item.userId,
        creatorUserId:      item.userId,
        connection:         { plaidItemDbId, connectedByUserId: item.userId, syncStatus: "synced" },
        client:             tx,
      });

      // The identity mirror. Idempotent, and now backed by the PLAID partial
      // unique index — if this externalAccountId is somehow already claimed by
      // another FinancialAccount the helper raises a classified conflict rather
      // than silently binding it twice.
      await writeIdentity(created.id, acct.account_id);

      out.push({
        status:             "CREATED",
        plaidAccountId:     acct.account_id,
        financialAccountId: created.id,
        spaceId:            siblingLink.spaceId,
      });
    }
    return out;
  });

  return { attempted: true, results };
}

/** The issue kind whose presence licenses a recovery attempt. */
export const RECOVERY_TRIGGER_KIND: SyncIssueKind = SyncIssueKind.MISSING_ACCOUNT;
