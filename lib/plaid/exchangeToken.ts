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
  PlaidInvestmentsConsent,
  PlaidItemStatus,
  AccountOwnerType,
  ShareStatus,
  VisibilityLevel,
  ProviderType,
  ConnectionStatus,
} from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { retireItemSyncFailure } from "@/lib/plaid/sync-notifications";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { AuditAction } from "@/lib/audit-actions";
import { resolveAccountByFingerprint } from "@/lib/accounts/reconcile";
import { dualWriteSpaceAccountLink } from "@/lib/accounts/space-account-link";
import { dualWriteProviderAccountIdentity } from "@/lib/accounts/provider-identity";
import { deriveInvestmentsConsent } from "@/lib/plaid/investmentsConsent";
import { getPlaidErrorCode, plaidErrorSummary } from "@/lib/plaid/errors";
import { capturePositionObservations, investmentObservationsEnabled } from "@/lib/investments/position-capture";

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
  const deferHistorySync = params.deferHistorySync ?? false;

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

    // ── KD-4 Phase 3 — AccountConnection upsert + SAL link commit atomically.
    //    The FinancialAccount resolve/create/update above stays OUTSIDE this
    //    transaction: resolveAccountByFingerprint() self-manages its own
    //    interactive transaction (Phase 2) and must never be nested, and each
    //    fa write there is a single atomic statement. The ProviderAccountIdentity
    //    mirror write (above) is idempotent/non-fatal and also stays outside.
    //    Fields are captured into locals so the closure doesn't rely on
    //    control-flow narrowing of the `let fa`.
    const faId = fa.id;
    const faCreatorUserId = fa.createdByUserId ?? fa.ownerUserId;
    await db.$transaction(async (tx) => {
      const existingConn = await tx.accountConnection.findFirst({
        where: {
          financialAccountId: faId,
          connectedByUserId:  userId,
          plaidItemDbId:      plaidItem.id,
        },
      });

      if (!existingConn) {
        await tx.accountConnection.create({
          data: {
            financialAccountId: faId,
            connectedByUserId:  userId,
            plaidItemDbId:      plaidItem.id,
            connectionId:       connectionId,
            syncStatus:         "synced",
            isCanonical:        true,
          },
        });
      } else {
        await tx.accountConnection.update({
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
        financialAccountId: faId,
        creatorUserId:      faCreatorUserId,
        client:             tx,
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

    importedIds.push(fa.id);
    imported++;
  }

  // 8. Investment holdings — consent-gated (lib/plaid/investmentsConsent.ts).
  // Link tokens request transactions only (see app/api/plaid/link-token/
  // route.ts), so DTM Items arrive here without Investments consent: derive
  // the state from the accountsGet payload already fetched above, seed
  // PlaidItem.investmentsConsent (read by refresh + the future "Enable
  // Investment Holdings" UI), and skip the guaranteed
  // ADDITIONAL_CONSENT_REQUIRED call instead of making it.
  const investmentAccounts = plaidAccounts.filter(
    (a) => mapAccountType(a.type, a.subtype) === AccountType.investment,
  );
  let holdingsImported = 0;

  let investmentsConsent: PlaidInvestmentsConsent | null = null;
  if (investmentAccounts.length > 0) {
    investmentsConsent = deriveInvestmentsConsent(accountsRes.data.item);
    if (investmentsConsent !== null) {
      await db.plaidItem.update({
        where: { id: plaidItem.id },
        data:  { investmentsConsent },
      });
      if (investmentsConsent !== PlaidInvestmentsConsent.ENABLED) {
        console.log(
          `[plaid] institution "${institution_name}" — Investments consent ${investmentsConsent}; skipping holdings import`,
        );
      }
    }
  }
  const holdingsCallable =
    investmentsConsent === null || investmentsConsent === PlaidInvestmentsConsent.ENABLED;

  if (investmentAccounts.length > 0 && holdingsCallable) {
    try {
      const holdingsRes = await plaidClient.investmentsHoldingsGet({ access_token });
      const { holdings, securities } = holdingsRes.data;
      const secById = Object.fromEntries(securities.map((s) => [s.security_id, s]));

      for (const plaidAcct of investmentAccounts) {
        const acctHoldings = holdings.filter((h) => h.account_id === plaidAcct.account_id);
        if (!acctHoldings.length) continue;

        // currency in both selects: MC1 Phase 0 Slice 2 — account-level
        // fallback for the per-holding currency stamp below.
        const holdingPlaidIdentity = await db.providerAccountIdentity.findFirst({
          where:  { provider: ProviderType.PLAID, externalAccountId: plaidAcct.account_id },
          select: { financialAccount: { select: { id: true, currency: true } } },
        });

        let fa = holdingPlaidIdentity?.financialAccount ?? null;
        if (!fa) {
          fa = await db.financialAccount.findUnique({
            where:  { plaidAccountId: plaidAcct.account_id },
            select: { id: true, currency: true },
          });
          if (fa) {
            console.warn(
              `[plaid][D2-3F] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${plaidAcct.account_id}. Coverage gap; investigate before removing fallback.`,
            );
          }
        }
        if (!fa) continue;

        // A1 — dark-write append-only observation capture from the RAW payload
        // (incl. cash / no-ticker securities the Holding writer skips below), so
        // an initial connection's day-one positions are observed. Runs BEFORE
        // the Holding write, gated behind the kill switch, best-effort/non-fatal:
        // a capture failure must never fail account import.
        if (investmentObservationsEnabled()) {
          try {
            await capturePositionObservations({
              financialAccountId: fa.id,
              plaidHoldings:      acctHoldings,
              securitiesById:     secById,
              date:               new Date(),
              // Derived brokerage-cash reconciliation from the SAME import
              // payload (contemporaneous balance + holdings).
              accountBalance:     plaidAcct.balances.current ?? null,
              accountCurrency:    plaidAcct.balances.iso_currency_code ?? null,
              balanceAsOf:        plaidAcct.balances.last_updated_datetime ? new Date(plaidAcct.balances.last_updated_datetime) : null,
              payloadComplete:    holdingsRes.data.is_investments_fallback_item !== true,
            });
          } catch (obsErr) {
            console.warn(
              `[plaid] position observation capture failed for account ${fa.id} (non-fatal): ${obsErr instanceof Error ? obsErr.message : obsErr}`,
            );
          }
        }

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
              // MC1 Phase 0 Slice 2 — valuation currency of price/value:
              // Plaid holding code, else its security's code, else the
              // account currency. Null only if all three are absent.
              currency: h.iso_currency_code ?? sec.iso_currency_code ?? fa.currency ?? null,
            },
          });
          holdingsImported++;
        }
      }

      // Unknown (pre-DTM) probe succeeded — remember it.
      if (investmentsConsent === null) {
        await db.plaidItem.update({
          where: { id: plaidItem.id },
          data:  { investmentsConsent: PlaidInvestmentsConsent.ENABLED },
        });
      }
    } catch (holdingsErr) {
      if (getPlaidErrorCode(holdingsErr) === "ADDITIONAL_CONSENT_REQUIRED") {
        // Expected for Items linked without Investments consent — remember it
        // so refresh never re-attempts until consent is granted.
        await db.plaidItem.update({
          where: { id: plaidItem.id },
          data:  { investmentsConsent: PlaidInvestmentsConsent.CONSENT_REQUIRED },
        });
        console.log(
          `[plaid] institution "${institution_name}" lacks Investments consent — holdings skipped until granted via Link update mode`,
        );
      } else {
        console.warn(`[plaid] investmentsHoldingsGet failed (non-fatal): ${plaidErrorSummary(holdingsErr)}`);
      }
    }
  }

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
