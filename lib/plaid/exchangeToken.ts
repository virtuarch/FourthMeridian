/**
 * lib/plaid/exchangeToken.ts
 *
 * Shared core for exchanging a Plaid public_token for an access_token and
 * importing accounts, holdings, and transactions into a user's Space.
 *
 * Used by:
 *   app/api/plaid/exchange-token/route.ts
 *     — normal user flow; calls getSpaceContext() to get userId + spaceId,
 *       then delegates all import work here.
 *
 *   app/api/admin/plaid/exchange-expanded-history-token/route.ts
 *     — admin Expand History flow; derives userId from the old PlaidItem
 *       (not the admin session), resolves the target user's Personal Space
 *       via resolveSpaceContext(userId), then delegates here.
 *
 * WHY THIS SPLIT EXISTS:
 *   The original exchange-token route called getSpaceContext(), which reads
 *   the active NextAuth session to determine userId. In the admin Expand
 *   History flow, the session user is the admin, but accounts must be
 *   imported for the institution owner (a different user). Passing userId +
 *   spaceId explicitly lets the two callers supply the correct context
 *   without this function needing to know which session is active.
 *
 * This function never calls getSpaceContext() or getServerSession().
 * Context MUST be provided by the caller.
 */

import { plaidClient } from "@/lib/plaid/client";
import { encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { db } from "@/lib/db";
import {
  AccountType,
  PlaidItemStatus,
  AccountOwnerType,
  ProviderType,
  ConnectionStatus,
} from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { retireItemSyncFailure } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { AuditAction } from "@/lib/audit-actions";
import { resolveAccountByFingerprint, resolvePlaidAccountByExternalId } from "@/lib/accounts/reconcile";
// PROV-2 — the ONE owner of Plaid type/subtype → AccountType (was defined + exported here).
import { mapAccountType } from "@/lib/plaid/account-type";
// PROV-3 — the shared investments-ingest orchestration (was inline here).
import { syncInvestmentsForItem } from "@/lib/plaid/sync-investments";
// PROV-4 — the canonical per-account conn+SAL spine writer (was inline here).
import { persistAccountSpine } from "@/lib/accounts/persist-account-spine";
import { dualWriteProviderAccountIdentity } from "@/lib/accounts/provider-identity";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExchangeTokenParams {
  /** Target account owner's user ID — NOT the session user. */
  userId:           string;
  /** Target account owner's active Space ID. */
  spaceId:          string;
  /** Short-lived public_token returned by Plaid Link's onSuccess. */
  public_token:     string;
  /** Plaid institution identifier (e.g. "ins_3" for Chase). */
  institution_id:   string;
  /** Human-readable institution name for display + DB storage. */
  institution_name: string;
  /**
   * D2.x Slice 1 (fast-path split). When true, the full 730-day initial
   * transaction sync is NOT awaited inside this call: accounts/balances,
   * holdings, and today's snapshot are made durable and the function returns
   * immediately with `historyPending: true`, leaving history to complete
   * out-of-band (daily sync-banks cron today; an after()/waitUntil background
   * continuation once Slice 2 lands). Defaults to false, which preserves the
   * original inline-history behavior — required by the admin Expand History
   * flow (exchange-expanded-history-token), whose entire purpose is to pull
   * expanded history inline and which relies on the returned
   * transactionsSynced count and the cursor set by syncTransactionsForItem.
   */
  deferHistorySync?: boolean;
}

export interface ExchangeTokenResult {
  imported:           number;
  holdingsImported:   number;
  transactionsSynced: number;
  /** The new PlaidItem's internal DB id (used by admin retire flow). */
  plaidItemId:        string;
  /**
   * D2.x Slice 1. True when the initial transaction history import was
   * deferred (see ExchangeTokenParams.deferHistorySync) rather than run
   * inline — balances/holdings/snapshot are durable but full history is still
   * arriving out-of-band. Additive/optional; existing callers that ignore it
   * are unaffected.
   */
  historyPending?:    boolean;
}

/**
 * Thrown when a fresh Link session completes for an institution the user ALREADY
 * has an ACTIVE PlaidItem for (a genuine duplicate — a NEW Plaid item_id, not an
 * update-mode reconnect which preserves the item_id and heals the existing row).
 * The exchange-token route maps this to a 409 + the user-facing message; the
 * connect UI already surfaces `{ error }` from a non-2xx exchange response.
 */
export class DuplicateInstitutionError extends Error {
  constructor(public readonly institutionName: string) {
    super(`You already have ${institutionName} connected — refresh it instead of reconnecting.`);
    this.name = "DuplicateInstitutionError";
  }
}

// ── Core exchange + import ────────────────────────────────────────────────────

export async function performPlaidTokenExchange(
  params: ExchangeTokenParams,
): Promise<ExchangeTokenResult> {
  const { userId, spaceId, public_token, institution_id, institution_name } = params;
  const deferHistorySync = params.deferHistorySync ?? false;

  // 1. Exchange public_token → access_token (+ Plaid's item_id).
  console.log(`[plaid] exchanging public token for institution "${institution_name}" (${institution_id})`);
  const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token });
  const { access_token, item_id } = exchangeRes.data;
  console.log(`[plaid] public token exchanged — item_id: ${item_id}`);

  // 2. Duplicate-institution GATE (real, not log-only). An update-mode reconnect
  // reuses the existing access_token, so Plaid returns the SAME item_id and the
  // upsert below heals the existing row. A genuine duplicate is a FRESH Link
  // session for an already-connected institution: a NEW item_id. If an ACTIVE
  // PlaidItem already exists for (userId, institutionId) under a DIFFERENT
  // item_id, block instead of creating a second parallel connection. Best-effort
  // itemRemove the just-created item so it doesn't linger unused at Plaid.
  const duplicate = await db.plaidItem.findFirst({
    where:  { userId, institutionId: institution_id, status: PlaidItemStatus.ACTIVE, externalItemId: { not: item_id } },
    select: { id: true, institutionName: true },
  });
  if (duplicate) {
    console.warn(
      `[plaid] duplicate connect blocked — user ${userId} already has ACTIVE item ${duplicate.id} for institution "${institution_name}" (${institution_id}); removing the new item ${item_id} at Plaid`,
    );
    try {
      await plaidClient.itemRemove({ access_token });
    } catch (removeErr) {
      console.warn(`[plaid] best-effort itemRemove of duplicate item ${item_id} failed (non-fatal):`, removeErr);
    }
    throw new DuplicateInstitutionError(institution_name);
  }

  // 3. Encrypt access_token before it touches the DB
  const encryptedToken = encryptWithPurpose(access_token, EncryptionPurpose.PLAID_ACCESS_TOKEN);

  // 4. Upsert PlaidItem — credential belongs to User, not Space.
  // D2.x resume — when history is deferred, mark the item incomplete from birth
  // (syncIncompleteAt = now) so it reads as "importing" until the background
  // history sync confirms completion (which clears it). The inline flow (admin
  // Expand History, deferHistorySync=false) syncs history within this call, so
  // it leaves the marker null. Re-link re-imports history the same way.
  const syncIncompleteAt = deferHistorySync ? new Date() : null;
  const plaidItem = await db.plaidItem.upsert({
    where:  { externalItemId: item_id },
    // CH-2 — the health reset (status ACTIVE, errorCode null) is no longer done
    // inline here; setPlaidItemHealth below owns it so a relink that recovers a
    // broken item leaves a durable transition row. The upsert still writes the
    // non-health columns; a brand-new item is created ACTIVE (default), for
    // which the helper's no-op comparison writes no row.
    update: { encryptedToken, syncIncompleteAt },
    create: {
      userId,
      externalItemId:  item_id,
      institutionId:   institution_id,
      institutionName: institution_name,
      encryptedToken,
      status:          PlaidItemStatus.ACTIVE,
      syncIncompleteAt,
    },
  });

  // CH-2 — flip to healthy through the chokepoint. Records a transition row only
  // when this relink actually recovered a NEEDS_REAUTH/ERROR item (no row for a
  // brand-new item, which is already ACTIVE from the create above).
  // allowReactivation: a successful token exchange is the ONE event permitted to
  // bring an item out of REVOKED (relinking a connection the user removed). Every
  // other caller only classifies a sync outcome and must never resurrect one.
  await setPlaidItemHealth(
    plaidItem.id,
    { status: PlaidItemStatus.ACTIVE, errorCode: null },
    undefined,
    undefined,
    { allowReactivation: true },
  );

  // OPS-3 S5 Wave 3 — a relink through Link update mode resolves an open
  // SYNC_FAILED condition immediately (don't wait for the next sync): retire
  // the :open key + archive the stale "needs attention" row. No-op for brand
  // new items. Best-effort.
  await retireItemSyncFailure(plaidItem.id);

  // 5. D2 Slice A — Connection dual-write (PLAID).
  // Upsert a Connection row keyed on (userId, provider=PLAID,
  // externalConnectionId=institution_id). One Connection survives PlaidItem
  // rotation: re-links with a new item_id update the same Connection row.
  // Best-effort / non-fatal; plaidItemDbId on AccountConnection is the
  // source of truth for all existing Plaid flows.
  let connectionId: string | null = null;
  try {
    const encryptedCredential = encryptWithPurpose(
      access_token,
      EncryptionPurpose.CONNECTION_CREDENTIAL,
    );
    const existingConn = await db.connection.findFirst({
      where:  { userId, provider: ProviderType.PLAID, externalConnectionId: institution_id },
      select: { id: true },
    });
    if (existingConn) {
      await db.connection.update({
        where: { id: existingConn.id },
        data:  { credential: encryptedCredential, status: ConnectionStatus.ACTIVE, errorCode: null },
      });
      connectionId = existingConn.id;
    } else {
      const created = await db.connection.create({
        data: {
          userId,
          provider:             ProviderType.PLAID,
          externalConnectionId: institution_id,
          credential:           encryptedCredential,
          status:               ConnectionStatus.ACTIVE,
        },
        select: { id: true },
      });
      connectionId = created.id;
    }
  } catch (connErr) {
    console.warn("[plaid][D2-SliceA] Connection dual-write failed (non-fatal):", connErr);
  }

  // 6. Fetch accounts from Plaid
  const accountsRes   = await plaidClient.accountsGet({ access_token });
  const plaidAccounts = accountsRes.data.accounts;
  console.log(`[plaid] institution "${institution_name}" connected — ${plaidAccounts.length} account(s) found`);

  // 7. Upsert each account as FinancialAccount + AccountConnection + SpaceAccountLink
  let imported = 0;
  const importedIds: string[] = [];

  for (const acct of plaidAccounts) {
    const type             = mapAccountType(acct.type, acct.subtype);
    const balance          = acct.balances.current ?? 0;
    const availableBalance = acct.balances.available ?? undefined;
    const creditLimit      = acct.balances.limit ?? undefined;

    // ── Resolve FinancialAccount ──────────────────────────────────────────────
    // 1. PROV-2 — identity→legacy resolve via the canonical resolver (returns
    //    soft-deleted rows too, so the restore branch below can revive them).
    // 2. Fingerprint match against archived accounts.
    // 3. Create new row if neither lookup finds anything.
    let fa = await resolvePlaidAccountByExternalId(acct.account_id);

    if (fa) {
      fa = await db.financialAccount.update({
        where: { id: fa.id },
        data: {
          balance,
          availableBalance,
          ...(creditLimit !== undefined && { creditLimit }),
          lastUpdated: new Date(),
          syncStatus:  "synced",
          deletedAt:   null,
        },
      });
    } else {
      const fingerprint = {
        ownerUserId:   userId,
        institutionId: institution_id,
        institution:   institution_name,
        mask:          acct.mask ?? null,
        officialName:  acct.official_name ?? null,
        plaidName:     acct.name,
        name:          acct.name,
        type,
      };
      const resolution = await resolveAccountByFingerprint(fingerprint, undefined, spaceId);

      console.log("[plaid] fingerprint lookup", {
        institutionId:      institution_id,
        mask:               acct.mask ?? null,
        type,
        officialName:       acct.official_name ?? null,
        plaidName:          acct.name,
        activeCandidates:   resolution?.activeCandidateCount ?? 0,
        archivedCandidates: resolution?.archivedCandidateCount ?? 0,
        canonicalAccountId: resolution?.canonical.id ?? null,
        outcome:            resolution ? "reused" : "created",
      });

      if (resolution) {
        fa = await db.financialAccount.update({
          where: { id: resolution.canonical.id },
          data: {
            plaidAccountId:  acct.account_id,
            balance,
            availableBalance,
            ...(creditLimit !== undefined && { creditLimit }),
            lastUpdated: new Date(),
            syncStatus:  "synced",
            deletedAt:   null,
          },
        });
      } else {
        fa = await db.financialAccount.create({
          data: {
            ownerType:       AccountOwnerType.USER,
            ownerUserId:     userId,
            createdByUserId: userId,
            plaidAccountId:  acct.account_id,
            name:            acct.name,
            plaidName:       acct.name,
            officialName:    acct.official_name ?? undefined,
            type,
            institution:     institution_name,
            institutionId:   institution_id,
            mask:            acct.mask ?? undefined,
            balance,
            availableBalance,
            creditLimit,
            currency:        acct.balances.iso_currency_code ?? "USD",
            syncStatus:      "synced",
          },
        });
      }
    }

    // D2 Step 2A — dual-write ProviderAccountIdentity. Idempotent; covers
    // all three resolution branches above. Best-effort / non-fatal.
    await dualWriteProviderAccountIdentity(fa.id, ProviderType.PLAID, acct.account_id);

    // PROV-4 — AccountConnection + SpaceAccountLink, committed atomically per
    // account, through the canonical spine writer shared with the Wallet route.
    // The FinancialAccount resolve/create/update above stays OUTSIDE this
    // transaction (resolveAccountByFingerprint self-manages its own; each fa
    // write is a single atomic statement), and the ProviderAccountIdentity mirror
    // (above) is idempotent/non-fatal and also stays outside — the boundary is
    // unchanged from the hand-written version this replaces.
    await persistAccountSpine({
      financialAccountId: fa.id,
      spaceId,
      addedByUserId:      userId,
      creatorUserId:      fa.createdByUserId ?? fa.ownerUserId,
      connection: {
        connectedByUserId: userId,
        plaidItemDbId:     plaidItem.id,
        connectionId,
        syncStatus:        "synced",
      },
    });

    importedIds.push(fa.id);
    imported++;
  }

  // 8. Investment holdings — consent-gated. PROV-3: the whole ingest (consent
  // derive+persist, holdings call, per-account observation→holdings→events,
  // consent-error catch) is the shared syncInvestmentsForItem primitive, also
  // used by refresh. At initial link storedConsent is the just-upserted item's
  // value (null for a brand-new item → the primitive seeds it; a stored value on
  // a re-link → the primitive change-detects). Link tokens request transactions
  // only, so DTM items arrive without Investments consent and the primitive
  // skips the guaranteed ADDITIONAL_CONSENT_REQUIRED call.
  const investmentAccounts = plaidAccounts.filter(
    (a) => mapAccountType(a.type, a.subtype) === AccountType.investment,
  );
  const investmentsResult = await syncInvestmentsForItem({
    accessToken:        access_token,
    plaidItemId:        plaidItem.id,
    institutionName:    institution_name,
    investmentAccounts,
    item:               accountsRes.data.item,
    storedConsent:      plaidItem.investmentsConsent,
  });
  const holdingsImported = investmentsResult.holdingsSynced;

  // 9. Initial transaction sync.
  //
  // D2.x Slice 1 (fast-path split) — when deferHistorySync is set (the normal
  // first-run Link flow, app/api/plaid/exchange-token/route.ts), the full
  // 730-day history import is NOT awaited here: balances, holdings, and
  // today's snapshot (step 9b) are already durable, so the function returns
  // immediately and history completes out-of-band. Until Slice 2 attaches an
  // after()/waitUntil background continuation, the standing daily sync-banks
  // cron (vercel.json → /api/jobs/sync-banks) is the completion path — no
  // manual Refresh required, just a delay. syncTransactionsForItem is
  // untouched; this only chooses whether to await it here.
  //
  // When deferHistorySync is false (admin Expand History flow,
  // exchange-expanded-history-token) behavior is unchanged: history is pulled
  // inline — that is that flow's entire purpose, and it relies on the
  // transactionsSynced count and the cursor set by syncTransactionsForItem.
  let txSync: { added: number; modified: number; removed: number } | null = null;
  let historyPending = false;
  if (deferHistorySync) {
    historyPending = true;
    console.log(
      `[plaid] initial transaction sync DEFERRED for item ${plaidItem.id} ("${institution_name}") — fast-path return; history completes out-of-band (cron until Slice 2)`,
    );
  } else {
    try {
      txSync = await syncTransactionsForItem(plaidItem.id);
      console.log(
        `[plaid] initial transaction sync — ${txSync.added} added, ${txSync.modified} modified, ${txSync.removed} removed`,
      );
    } catch (syncErr) {
      console.warn("[plaid] initial transaction sync failed (non-fatal):", syncErr);
    }
  }

  // 9b. SpaceSnapshot regeneration — best-effort, non-fatal
  let spacesSnapshotted: string[] = [];
  try {
    spacesSnapshotted = await regenerateSnapshotsForAccounts(importedIds);
  } catch (snapshotErr) {
    console.warn("[plaid] initial snapshot regeneration failed (non-fatal):", snapshotErr);
  }

  // 10. Audit log
  try {
    await db.auditLog.create({
      data: {
        userId,
        spaceId,
        action:   AuditAction.ACCOUNT_ADD,
        metadata: {
          institution:       institution_name,
          accountCount:      imported,
          holdingsImported,
          transactionsAdded: txSync?.added ?? 0,
          spacesSnapshotted: spacesSnapshotted.length,
        },
      },
    });
  } catch (auditErr) {
    console.warn("[plaid] audit log write failed (non-fatal):", auditErr);
  }

  console.log(
    `[plaid] import complete — ${imported} account(s), ${holdingsImported} holding(s) for institution "${institution_name}"`,
  );

  return {
    imported,
    holdingsImported,
    transactionsSynced: txSync?.added ?? 0,
    plaidItemId:        plaidItem.id,
    historyPending,
  };
}

// Re-export so callers that previously imported parsePlaidError from this
// module for error handling don't need a separate import change.
export { parsePlaidError } from "@/lib/plaid/errors";
