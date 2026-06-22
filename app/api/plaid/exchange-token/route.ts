/**
 * POST /api/plaid/exchange-token
 *
 * Called after the user completes the Plaid Link flow.
 * Receives the public_token from the frontend, exchanges it for a permanent
 * access_token, encrypts it, and imports all accounts + investment holdings
 * into the user's personal space.
 *
 * Data model:
 *   PlaidItem  — credential, belongs to User (not space)
 *   FinancialAccount  — canonical account row, ownerType=USER
 *   AccountConnection — links FinancialAccount ↔ PlaidItem ↔ User
 *   WorkspaceAccountShare — makes the account visible in the active space
 *
 * Relinking the same institution matches on plaidAccountId (FinancialAccount)
 * and restores deletedAt → null on both FinancialAccount and AccountConnection
 * if the account had previously been removed (see app/api/accounts/[id]/route.ts
 * DELETE) — reconnecting an account brings it back instead of leaving a
 * reactivated WorkspaceAccountShare pointing at a still-hidden account.
 *
 * Plaid does not guarantee plaidAccountId is stable forever — it can reissue
 * a new account_id for the same real-world account on reconnect. When no
 * exact plaidAccountId match is found, we fall back to a conservative
 * fingerprint match (institutionId + mask + type + officialName/plaidName)
 * against archived accounts before creating a new row — see
 * lib/accounts/reconcile.ts.
 *
 * Body: { public_token: string, institution_id: string, institution_name: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { plaidClient } from "@/lib/plaid/client";
import { encrypt } from "@/lib/plaid/encryption";
import { parsePlaidError } from "@/lib/plaid/errors";
import { db } from "@/lib/db";
import { AccountType, PlaidItemStatus, AccountOwnerType, ShareStatus, VisibilityLevel } from "@prisma/client";
import { getSpaceContext } from "@/lib/space";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { AuditAction } from "@/lib/audit-actions";
import { resolveAccountByFingerprint } from "@/lib/accounts/reconcile";

// ── Map Plaid account type/subtype → our AccountType enum ────────────────────
function mapAccountType(type: string, subtype: string | null | undefined): AccountType {
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

export async function POST(req: NextRequest) {
  try {
    const { public_token, institution_id, institution_name } = await req.json();

    if (!public_token || !institution_id || !institution_name) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // 1. Resolve space context early so we can check for duplicates
    const { userId, spaceId } = await getSpaceContext();

    // 2. Duplicate institution check — warn but still allow re-link (upsert handles it)
    const existingItem = await db.plaidItem.findFirst({
      where: { userId, institutionId: institution_id, status: PlaidItemStatus.ACTIVE },
    });
    if (existingItem) {
      console.log(
        `[plaid] re-linking existing institution "${institution_name}" (${institution_id}) for user ${userId} — will refresh token`
      );
    }

    // 3. Exchange public_token for access_token
    console.log(`[plaid] exchanging public token for institution "${institution_name}" (${institution_id})`);
    const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchangeRes.data;
    console.log(`[plaid] public token exchanged — item_id: ${item_id}`);

    // 4. Encrypt the access_token before it ever touches the DB
    const encryptedToken = encrypt(access_token);

    // 5. Upsert PlaidItem — credential belongs to User, not space
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

    // 6. Fetch accounts from Plaid
    const accountsRes = await plaidClient.accountsGet({ access_token });
    const plaidAccounts = accountsRes.data.accounts;
    console.log(`[plaid] institution "${institution_name}" connected — ${plaidAccounts.length} account(s) found`);

    // 7. Upsert each account as FinancialAccount + AccountConnection + WorkspaceAccountShare
    let imported = 0;
    const importedIds: string[] = [];

    for (const acct of plaidAccounts) {
      const type             = mapAccountType(acct.type, acct.subtype);
      const balance          = acct.balances.current ?? 0;
      const availableBalance = acct.balances.available ?? undefined;
      const creditLimit      = acct.balances.limit ?? undefined;

      // ── Resolve FinancialAccount ──────────────────────────────────────────────
      // 1. Exact match on plaidAccountId (the common case).
      // 2. If no exact match, Plaid may have reissued a new account_id for an
      //    account we already have archived (observed directly — same
      //    institutionId/mask/officialName/type, different plaidAccountId).
      //    Fall back to a fingerprint match against soft-deleted accounts; if
      //    exactly one candidate fits, reuse that row and update its
      //    plaidAccountId rather than creating a second visible account. See
      //    lib/accounts/reconcile.ts for the matching rules.
      // 3. Only create a new row if neither lookup finds anything.
      let fa = await db.financialAccount.findUnique({ where: { plaidAccountId: acct.account_id } });

      if (fa) {
        fa = await db.financialAccount.update({
          where: { id: fa.id },
          data: {
            balance,
            availableBalance,
            ...(creditLimit !== undefined && { creditLimit }),
            lastUpdated: new Date(),
            syncStatus:  "synced",
            // Relinking the same plaidAccountId after the account was removed
            // (FinancialAccount.deletedAt set — see app/api/accounts/[id]/route.ts
            // DELETE) should restore it, not leave it hidden. Always safe to
            // set null here even if the account wasn't deleted.
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
        const resolution = await resolveAccountByFingerprint(fingerprint);

        console.log("[plaid] fingerprint lookup", {
          institutionId:      institution_id,
          mask:                acct.mask ?? null,
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
              // D11 — human-accountable creator, independent of ownerUserId/
              // ownerSpaceId visibility. Equal to ownerUserId for USER-owned
              // accounts today, but recorded separately since ownership can
              // later move to a space without changing who connected it.
              createdByUserId: userId,
              plaidAccountId:  acct.account_id,
              name:            acct.name,
              // Frozen at import — never written to again on resync (see
              // update blocks above, which intentionally omit these two
              // fields and `displayName`). This preserves the "never
              // overwrite Plaid metadata" rule and lets the user rename the
              // account afterward without that rename being clobbered by a
              // later sync.
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

      // ── Upsert AccountConnection ─────────────────────────────────────────────
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
            syncStatus:         "synced",
            isCanonical:        true,
          },
        });
      } else {
        await db.accountConnection.update({
          where: { id: existingConn.id },
          // Same reasoning as the FinancialAccount update above — restore a
          // soft-deleted connection on relink rather than leaving it orphaned.
          data:  { syncStatus: "synced", lastSyncedAt: new Date(), deletedAt: null },
        });
      }

      // ── Upsert WorkspaceAccountShare ─────────────────────────────────────────
      await db.workspaceAccountShare.upsert({
        // WorkspaceAccountShare keeps its own pre-Phase-1 field/key names.
        where:  { workspaceId_financialAccountId: { workspaceId: spaceId, financialAccountId: fa.id } },
        update: { status: ShareStatus.ACTIVE, revokedAt: null, revokedByUserId: null },
        create: {
          workspaceId: spaceId,
          financialAccountId: fa.id,
          addedByUserId:      userId,
          visibilityLevel:    VisibilityLevel.FULL,
          status:             ShareStatus.ACTIVE,
        },
      });

      importedIds.push(fa.id);
      imported++;
    }

    // 8. Investment holdings — written against FinancialAccount directly
    //    (D11: Holding now has a financialAccountId FK; the old cross-ref
    //    through the legacy Account table is gone).
    const investmentPlaidAccounts = plaidAccounts.filter(
      (a) => mapAccountType(a.type, a.subtype) === AccountType.investment
    );

    let holdingsImported = 0;

    if (investmentPlaidAccounts.length > 0) {
      try {
        const holdingsRes = await plaidClient.investmentsHoldingsGet({ access_token });
        const { holdings, securities } = holdingsRes.data;
        const secById = Object.fromEntries(securities.map((s) => [s.security_id, s]));

        for (const plaidAcct of investmentPlaidAccounts) {
          const acctHoldings = holdings.filter((h) => h.account_id === plaidAcct.account_id);
          if (!acctHoldings.length) continue;

          // Look up the FinancialAccount row created/updated in step 7, by
          // plaidAccountId — same account, just no longer cross-referenced
          // through the legacy Account table.
          const fa = await db.financialAccount.findUnique({
            where:  { plaidAccountId: plaidAcct.account_id },
            select: { id: true },
          });
          if (!fa) continue;

          await db.holding.deleteMany({ where: { financialAccountId: fa.id } });

          for (const h of acctHoldings) {
            const sec = secById[h.security_id];
            if (!sec) continue;
            if (sec.type === "cash" || !sec.ticker_symbol) continue;

            const currentPrice = h.institution_price ?? 0;
            const prevClose    = sec.close_price ?? currentPrice;
            const change24h    = prevClose > 0
              ? parseFloat((((currentPrice - prevClose) / prevClose) * 100).toFixed(2))
              : 0;

            await db.holding.create({
              data: {
                financialAccountId: fa.id,
                symbol:    sec.ticker_symbol,
                name:      sec.name ?? sec.ticker_symbol,
                quantity:  h.quantity,
                price:     currentPrice,
                value:     h.institution_value ?? h.quantity * currentPrice,
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

    // 9. Initial transaction sync — best-effort, non-fatal. Runs immediately
    //    after accounts are imported so the dashboard has transaction history
    //    on first load instead of waiting for some future sync trigger.
    //    Same function the manual "Sync Now" endpoint (app/api/plaid/sync)
    //    and the sync-banks job call — see lib/plaid/syncTransactions.ts.
    let txSync: { added: number; modified: number; removed: number } | null = null;
    try {
      txSync = await syncTransactionsForItem(plaidItem.id);
      console.log(
        `[plaid] initial transaction sync — ${txSync.added} added, ${txSync.modified} modified, ${txSync.removed} removed`
      );
    } catch (syncErr) {
      console.warn("[plaid] initial transaction sync failed (non-fatal):", syncErr);
    }

    // 9b. SpaceSnapshot regeneration — best-effort, non-fatal. Without
    //     this, a brand-new space has zero SpaceSnapshot rows right
    //     after Link, and the chart components' "first day" placeholder only
    //     renders at exactly one row — so charts stayed blank until the user
    //     manually clicked Refresh once. Reuses the same helper the manual
    //     Refresh pipeline calls (lib/plaid/refresh.ts) so no regen logic is
    //     duplicated. Scoped to every space the imported accounts are
    //     actively shared into (importedIds), not just the current space.
    let spacesSnapshotted: string[] = [];
    try {
      spacesSnapshotted = await regenerateSnapshotsForAccounts(importedIds);
    } catch (snapshotErr) {
      console.warn("[plaid] initial snapshot regeneration failed (non-fatal):", snapshotErr);
    }

    // 10. Audit log
    await db.auditLog.create({
      data: {
        userId,
        spaceId,
        action:   AuditAction.ACCOUNT_ADD,
        metadata: {
          institution:      institution_name,
          accountCount:     imported,
          holdingsImported,
          transactionsAdded: txSync?.added ?? 0,
          spacesSnapshotted: spacesSnapshotted.length,
        },
      },
    });

    console.log(
      `[plaid] import complete — ${imported} account(s), ${holdingsImported} holding(s) for institution "${institution_name}"`
    );
    return NextResponse.json({
      success: true,
      imported,
      holdingsImported,
      transactionsSynced: txSync?.added ?? 0,
    });
  } catch (err: unknown) {
    const { message, status, code } = parsePlaidError(err, "Failed to connect account");
    console.error(`[plaid] exchange-token error (code: ${code ?? "unknown"}):`, message);
    return NextResponse.json({ error: message }, { status });
  }
}
