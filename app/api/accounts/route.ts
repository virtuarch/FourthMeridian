/**
 * GET /api/accounts
 *
 * Returns the authenticated user's own FinancialAccounts (non-deleted).
 * Used by the space account-sharing UI to list accounts available to share.
 */

import { NextResponse }      from "next/server";
import { db }                from "@/lib/db";
import { requireUser } from "@/lib/session";
import { applyCanonicalWalletBalances } from "@/lib/crypto/wallet-current-value";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  const accounts = await db.financialAccount.findMany({
    where: {
      ownerUserId: user.id,
      deletedAt:   null,
    },
    select: {
      id:          true,
      name:        true,
      type:        true,
      institution: true,
      balance:     true,
      currency:    true,
      lastUpdated: true,
      mask:        true,
      // W6e — the wallet's asset, so a crypto balance shown here is the same
      // number every other surface shows.
      walletChain: true,
    },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  // W6e — a balance rendered in a picker is still a current financial claim, so
  // it comes from the same authority as the account card. No Space context here:
  // this read is user-owned accounts, and the canonical path falls back to the
  // account's own currency when no reporting context is supplied.
  const canonical = await applyCanonicalWalletBalances(accounts);

  return NextResponse.json(
    canonical.map(({ cryptoPosition, walletChain: _w, ...a }) => ({
      ...a, lastUpdated: a.lastUpdated.toISOString(),
      // 2026-09-21 — the price clock travels WITH the number it priced (it was
      // stripped with the rest of the position): a picker balance is a current
      // claim too, and "current" needs the quote instant or the close date.
      ...(cryptoPosition?.price ? { cryptoPrice: cryptoPosition.price } : {}),
    }))
  );
}
