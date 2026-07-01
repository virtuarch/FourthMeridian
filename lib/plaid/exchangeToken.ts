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
  ShareStatus,
  VisibilityLevel,
  ProviderType,
  ConnectionStatus,
} from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { AuditAction } from "@/lib/audit-actions";
import { resolveAccountByFingerprint } from "@/lib/accounts/reconcile";
import { dualWriteSpaceAccountLink } from "@/lib/accounts/space-account-link";
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
}

export interface ExchangeTokenResult {
  imported:           number;
  holdingsImported:   number;
  transactionsSynced: number;
  /** The new PlaidItem's internal DB id (used by admin retire flow). */
  plaidItemId:        string;
}

// ── Plaid type → AccountType ──────────────────────────────────────────────────

export function mapAccountType(type: string, subtype: string | null | undefined): AccountType {
  switch (type) {
    case "depository":
      return subtype === "savings" || subtype === "money market" || subtype === "cd"
        ? AccountType.savings
        : AccountType.checking;
    case "investment":
      return subtype === "crypto exchange"
        ? AccountType.crypto
        : AccountType.investment;
    case "credit":
    case "loan":
      return AccountType.debt;
    default:
      return AccountType.other;
  }
}

// ── Core exchange + import ────────────────────────────────────────────────────

export async function performPlaidTokenExchange(
  params: ExchangeTokenParams,
): Promise<ExchangeTokenResult> {
  const { userId, spaceId, public_token, institution_id, institution_name } = params;

  // 1. Duplicate institution check — log only; upsert handles collisions
  const existingItem = await db.plaidItem.findFirst({
    where: { userId, institutionId: institution_id, status: PlaidItemStatus.ACTIVE },
  });
  if (existingItem) {
    console.log(
      `[plaid] re-linking existing institution "${institution_name}" (${institution_id}) for user ${userId} — will refresh token`,
    );
  }

  // 2. Exchange public_token → access_token
  console.log(`[plaid] exchanging public token for institution "${institution_name}" (${institution_id})`);
  const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token });
  const { access_token, item_id } = exchangeRes.data;
  console.log(`[plaid] public token exchanged — item_id: ${item_id}`);

  // 3. Encrypt access_token before it touches the DB
  const encryptedToken = encryptWithPurpose(access_token, EncryptionPurpose.PLAID_ACCESS_TOKEN);

  // 4. Upsert PlaidItem — credential belongs to User, not Space
  const plaidItem = await db.plaidItem.upsert({
    where:  { externalItemId: item_id },
    update: { encryptedToken, status: PlaidItemStatus.ACTIVE, errorCode: null },
    create: {
      userId,
      externalItemId:  item_id,
      institutionId:   institution_id,
      institutionName: institution_name,
      encryptedToken,
      status:          PlaidItemStatus.ACTIVE,
    },
  });

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
    // 1. Exact match via ProviderAccountIdentity (D2 Step 3C) with legacy
    //    plaidAccountId fallback (D2 Step 3C coverage gap handling).
    // 2. Fingerprint match against archived accounts.
    // 3. Create new row if neither lookup finds anything.
    const plaidIdentity = await db.providerAccountIdentity.findFirst({
      where:   { provider: ProviderType.PLAID, externalAccountId: acct.account_id },
      include: { financialAccount: true },
    });

    let fa = plaidIdentity?.financialAccount ?? null;

    if (!fa) {
      fa = await db.financialAccount.findUnique({ where: { plaidAccountId: acct.account_id } });
      if (fa) {
        console.warn(
          `[plaid][D2-3C] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${acct.account_id}. Coverage gap; investigate before removing fallback.`,
        );
      }
    }

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

    // ── Upsert AccountConnection ──────────────────────────────────────────────
    const existingConn = await db.accountConnection.findFirst({
      where: {
        financialAccountId: fa.id,
        connectedByUserId:  userId,
        plaidItemDbId:      plaidItem.id,
      },
    });

    if (!existingConn) {
      await db.accountConnection.create({
        data: {
          financialAccountId: fa.id,
          connectedByUserId:  userId,
          plaidItemDbId:      plaidItem.id,
          connectionId:       connectionId,
          syncStatus:         "synced",
          isCanonical:        true,
        },
      });
    } else {
      await db.accountConnection.update({
        where: { id: existingConn.id },
        data: {
          syncStatus:   "synced",
          lastSyncedAt: new Date(),
          deletedAt:    null,
          ...(connectionId && !existingConn.connectionId && { connectionId }),
        },
      });
    }

    // D3 Stage B3 — SpaceAccountLink is the sole write target
    await dualWriteSpaceAccountLink({
      spaceId,
      financialAccountId: fa.id,
      creatorUserId:      fa.createdByUserId ?? fa.ownerUserId,
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

    importedIds.push(fa.id);
    imported++;
  }

  // 8. Investment holdings
  const investmentAccounts = plaidAccounts.filter(
    (a) => mapAccountType(a.type, a.subtype) === AccountType.investment,
  );
  let holdingsImported = 0;

  if (investmentAccounts.length > 0) {
    try {
      const holdingsRes = await plaidClient.investmentsHoldingsGet({ access_token });
      const { holdings, securities } = holdingsRes.data;
      const secById = Object.fromEntries(securities.map((s) => [s.security_id, s]));

      for (const plaidAcct of investmentAccounts) {
        const acctHoldings = holdings.filter((h) => h.account_id === plaidAcct.account_id);
        if (!acctHoldings.length) continue;

        const holdingPlaidIdentity = await db.providerAccountIdentity.findFirst({
          where:  { provider: ProviderType.PLAID, externalAccountId: plaidAcct.account_id },
          select: { financialAccount: { select: { id: true } } },
        });

        let fa = holdingPlaidIdentity?.financialAccount ?? null;
        if (!fa) {
          fa = await db.financialAccount.findUnique({
            where:  { plaidAccountId: plaidAcct.account_id },
            select: { id: true },
          });
          if (fa) {
            console.warn(
              `[plaid][D2-3F] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${plaidAcct.account_id}. Coverage gap; investigate before removing fallback.`,
            );
          }
        }
        if (!fa) continue;

        await db.holding.deleteMany({ where: { financialAccountId: fa.id } });

        for (const h of acctHoldings) {
          const sec = secById[h.security_id];
          if (!sec || sec.type === "cash" || !sec.ticker_symbol) continue;

          const currentPrice = h.institution_price ?? 0;
          const prevClose    = sec.close_price ?? currentPrice;
          const change24h    = prevClose > 0
            ? parseFloat((((currentPrice - prevClose) / prevClose) * 100).toFixed(2))
            : 0;

          await db.holding.create({
            data: {
              financialAccountId: fa.id,
              symbol:   sec.ticker_symbol,
              name:     sec.name ?? sec.ticker_symbol,
              quantity: h.quantity,
              price:    currentPrice,
              value:    h.institution_value ?? h.quantity * currentPrice,
              change24h,
            },
          });
          holdingsImported++;
        }
      }
    } catch (holdingsErr) {
      console.warn("[plaid] investmentsHoldingsGet failed (non-fatal):", holdingsErr);
    }
  }

  // 9. Initial transaction sync — best-effort, non-fatal
  let txSync: { added: number; modified: number; removed: number } | null = null;
  try {
    txSync = await syncTransactionsForItem(plaidItem.id);
    console.log(
      `[plaid] initial transaction sync — ${txSync.added} added, ${txSync.modified} modified, ${txSync.removed} removed`,
    );
  } catch (syncErr) {
    console.warn("[plaid] initial transaction sync failed (non-fatal):", syncErr);
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
  };
}

// Re-export so callers that previously imported parsePlaidError from this
// module for error handling don't need a separate import change.
export { parsePlaidError } from "@/lib/plaid/errors";
