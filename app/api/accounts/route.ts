/**
 * GET /api/accounts
 *
 * Returns the authenticated user's own FinancialAccounts (non-deleted).
 * Used by the space account-sharing UI to list accounts available to share.
 *
 * ── RLS-ACC-S1 — SERVED BY THE OWNER ARM, NOT BY THE `where` CLAUSE ──────────
 * This read is `ownerUserId = <me>` and nothing else, so it is served exactly by
 * `FinancialAccount.fm_app_sel`'s FIRST arm (`"ownerUserId" = current_fm_user_id()`).
 * The application predicate and the policy predicate are now the SAME predicate
 * evaluated twice, which is the strongest shape a converted read can have: the
 * `where` is no longer load-bearing for isolation, it is load-bearing for
 * SELECTION. Delete it by accident and the policy still answers correctly.
 *
 * The identity comes from `requireUser()` — server-side session state — never
 * from a query string and never from the active-Space cookie. There is no Space
 * in this contract at all.
 *
 * ⚠️ THE CANONICAL VALUATION RUNS IN THE SAME PHASE, AND THAT MATTERS.
 * `applyCanonicalWalletBalances` reads `PositionObservation` /
 * `PositionReconstruction` (the account SUBTREE, whose policy is
 * `fm_account_visible("financialAccountId")` with NO `ownerUserId` arm) plus the
 * global reference tables `Instrument`/`PriceObservation` (granted to fm_app, no
 * RLS at all — see migration §5, classified here rather than inferred). So a
 * wallet this user OWNS but which has no ACTIVE `SpaceAccountLink` in any Space
 * they are a member of still appears in the list — the owner arm sees it — but
 * its canonical position does not, and the row falls back to the legacy
 * `balance` column. That is the gap RLS-C-S7 recorded in
 * app/api/connections/[id]/disconnect/route.ts's header: the pivot has an owner
 * arm, its subtree does not. It fails in the safe direction (a stale number, not
 * someone else's number) and closing it needs a policy change, so it is recorded
 * rather than papered over. Passing `tx` is nonetheless correct and deliberate:
 * valuing a picker balance on a WIDER authority than the list it decorates would
 * be the one combination that is actually unsafe.
 *
 * No provider HTTP and no snapshot work happens inside the phase — the whole
 * handler is two reads and a map, which is what lets it be one short transaction.
 */

import { NextResponse }      from "next/server";
import { requireUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";
import { applyCanonicalWalletBalances } from "@/lib/crypto/wallet-current-value";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  // ONE short tenant phase: the owner's accounts, then their canonical wallet
  // valuation, both under the caller's own identity.
  const canonical = await withTenantDb(user.id, async (tx) => {
    const accounts = await tx.financialAccount.findMany({
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
    return applyCanonicalWalletBalances(accounts, { client: tx });
  });

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
