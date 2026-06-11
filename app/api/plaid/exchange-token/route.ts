/**
 * POST /api/plaid/exchange-token
 *
 * Called after the user completes the Plaid Link flow.
 * Receives the public_token from the frontend, exchanges it for a permanent
 * access_token, encrypts it, and imports all accounts + investment holdings
 * into the user's personal workspace.
 *
 * Body: { public_token: string, institution_id: string, institution_name: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { plaidClient } from "@/lib/plaid/client";
import { encrypt } from "@/lib/plaid/encryption";
import { db } from "@/lib/db";
import { AccountType, PlaidItemStatus } from "@prisma/client";
import { getWorkspaceContext } from "@/lib/workspace";

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

// ── Balance convention ────────────────────────────────────────────────────────
function normalizeBalance(balance: number | null, _type: AccountType): number {
  return balance ?? 0;
}

export async function POST(req: NextRequest) {
  try {
    const { public_token, institution_id, institution_name } = await req.json();

    if (!public_token || !institution_id || !institution_name) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // 1. Exchange public_token for access_token
    const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchangeRes.data;

    // 2. Encrypt the access_token before it ever touches the DB
    const encryptedToken = encrypt(access_token);

    // 3. Resolve workspace context (demo user → personal workspace)
    const { userId, workspaceId } = await getWorkspaceContext();

    // 4. Upsert PlaidItem — PlaidItem stays on User (credential, not workspace asset)
    const plaidItem = await db.plaidItem.upsert({
      where:  { plaidItemId: item_id },
      update: { encryptedToken, status: PlaidItemStatus.ACTIVE, errorCode: null },
      create: {
        userId,
        plaidItemId:     item_id,
        institutionId:   institution_id,
        institutionName: institution_name,
        encryptedToken,
        status:          PlaidItemStatus.ACTIVE,
      },
    });

    // 5. Fetch accounts from Plaid
    const accountsRes = await plaidClient.accountsGet({ access_token });
    const plaidAccounts = accountsRes.data.accounts;

    // 6. Upsert each account — now workspace-owned, ownerId = connecting user
    let imported = 0;
    for (const acct of plaidAccounts) {
      const type             = mapAccountType(acct.type, acct.subtype);
      const balance          = normalizeBalance(acct.balances.current, type);
      const availableBalance = acct.balances.available ?? undefined;
      const creditLimit      = acct.balances.limit ?? undefined;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db.account.upsert as any)({
        where:  { plaidAccountId: acct.account_id },
        update: {
          balance,
          availableBalance,
          ...(creditLimit !== undefined && { creditLimit }),
          lastUpdated: new Date(),
          syncStatus:  "synced",
        },
        create: {
          workspaceId,           // account belongs to the workspace
          ownerId:      userId,  // connected by this user
          plaidItemDbId:   plaidItem.id,
          plaidAccountId:  acct.account_id,
          name:            acct.name,
          type,
          institution:     institution_name,
          balance,
          availableBalance,
          creditLimit,
          currency:        acct.balances.iso_currency_code ?? "USD",
          syncStatus:      "synced",
        },
      });
      imported++;
    }

    // 7. Investment holdings
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

          const dbAcct = await db.account.findUnique({
            where:  { plaidAccountId: plaidAcct.account_id },
            select: { id: true },
          });
          if (!dbAcct) continue;

          await db.holding.deleteMany({ where: { accountId: dbAcct.id } });

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
                accountId: dbAcct.id,
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

    // 8. Audit log — includes workspaceId context
    await db.auditLog.create({
      data: {
        userId,
        workspaceId,
        action:   "ACCOUNT_ADD",
        metadata: { institution: institution_name, accountCount: imported, holdingsImported },
      },
    });

    return NextResponse.json({ success: true, imported, holdingsImported });
  } catch (err: unknown) {
    console.error("[plaid] exchange-token error:", err);
    return NextResponse.json(
      { error: "Failed to connect account" },
      { status: 500 }
    );
  }
}
