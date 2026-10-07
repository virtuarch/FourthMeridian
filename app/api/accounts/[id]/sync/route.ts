/**
 * POST /api/accounts/[id]/sync
 *
 * Manual self-custody wallet balance re-sync. `id` is a FinancialAccount.id.
 * Owner-only: the account must belong to the caller.
 *
 * W-M1d — DISPATCHED BY CHAIN. This route used to name Bitcoin and reject
 * everything else ("Only BTC wallet sync is supported"), which made adding a
 * chain a route edit. It now asks the ONE registry
 * (lib/crypto/wallet-sync-dispatch.ts) which adapter serves the account's chain,
 * and what that chain can honestly claim. The route itself names no chain.
 *
 * Refreshes the wallet's balance through its adapter, then regenerates the space
 * snapshot on success so Overview / Wealth / Liquidity pick up the change. On
 * provider failure the account is left visible and "pending" and an honest
 * result is returned (502).
 *
 * WEALTH HISTORY is regenerated only for a HISTORY_SUPPORTED chain — today BTC
 * alone. A chain with no movement ledger has no historical quantity to derive,
 * and regenerating it would refuse every day.
 *
 * NET WORTH: BTC still contributes through the legacy `FinancialAccount.balance`
 * column. ETH and SOL do not — their adapters write no balance column, so their
 * value lives only on the dated position spine until the wallet net-worth
 * convergence lands. The outcome states which applies rather than leaving the
 * caller to infer it.
 *
 * CH-3 — per-user rate limit (6 / hour by policy, the platform ceiling). The risk
 * it mitigates is a shared-IP explorer ban (every wallet sync leaves Fourth
 * Meridian's single server IP), so it is a CEILING, not metered per-item cost.
 * P1 — the limit, and a new per-connection cooldown, come from the customer's
 * EFFECTIVE ENTITLEMENTS (lib/entitlements); the SYSTEM_ADMIN exemption is gone
 * (it exempted an account the role wall keeps out of the product). A wallet
 * sync also now claims Connection.syncLockedAt (lib/refresh/wallet-lock.ts) so
 * two syncs of one wallet cannot race, and asks platform admission first.
 *
 * ── RLS-ACC-S1 — THE GATE IS A TENANT PHASE; THE SYNC IS NOT ─────────────────
 * This handler has exactly ONE database read of its own — the owner-only
 * authorization gate — and everything after it is provider HTTP (the chain
 * adapter) plus best-effort snapshot and wealth-history regeneration. So the
 * gate, and only the gate, runs inside `withTenantDb`.
 *
 * That split is not tidiness. `withTenantDb` is a SECURITY BOUNDARY, not a
 * request-lifetime container: it holds an interactive transaction open for the
 * duration of the callback, and a wallet sync reaches a block explorer and a
 * price source. Wrapping the sync would pin a pooled connection across the
 * network for as long as the slowest explorer takes, which is how an isolation
 * feature turns into an availability incident.
 *
 * The gate predicate is `ownerUserId === user.id`, which is served by
 * `FinancialAccount.fm_app_sel`'s owner arm, so the check and the policy now
 * agree by construction. `syncWalletByChain` and the two regenerators keep the
 * authority they already had — named below rather than silently inherited.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";
import { limitByUser } from "@/lib/rate-limit";
import { syncWalletByChain, isSyncableChain, SYNCABLE_CHAINS } from "@/lib/crypto/wallet-sync-dispatch";
import { loadEffectiveEntitlements } from "@/lib/entitlements/resolve";
import { checkManualRefreshCooldown, cooldownMsFromMinutes } from "@/lib/plaid/refreshCooldown";
import { tenantRefreshDeps } from "@/lib/refresh/deps";
import { finalizeWalletSync } from "@/lib/refresh/wallet-post-sync";
import { admitOperationalWork } from "@/lib/platform/admission/facts";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;


  // The authorization gate, and the only read this route owns. One short tenant
  // phase — see the header on why the sync itself must stay outside it.
  const { account, entitlements } = await withTenantDb(user.id, async (tx) => ({
    account: await tx.financialAccount.findUnique({
      where: { id },
      select: {
        id: true, ownerUserId: true, walletChain: true, deletedAt: true,
        connections: {
          where: { deletedAt: null, connectionId: { not: null } },
          select: { connection: { select: { id: true, lastManualRefreshAt: true } } },
        },
      },
    }),
    entitlements: await loadEffectiveEntitlements(tx, user.id),
  }));

  // Owner-only, and no existence disclosure for accounts the user doesn't own.
  // Under fm_app this is now belt AND braces: the policy has already refused to
  // return another tenant's row, so `account` is null rather than a row that
  // fails the comparison. Both readings produce the same 404.
  if (!account || account.ownerUserId !== user.id || account.deletedAt) {
    return NextResponse.json({ error: "Wallet not found." }, { status: 404 });
  }
  // UNSUPPORTED CHAINS STAY EXPLICITLY UNSUPPORTED. Account creation accepts a
  // wider set of chain labels than this system can read, deliberately: recording
  // custody and being able to read the chain are different capabilities. A
  // wallet on an unreadable chain is refused HERE, by name, rather than being
  // handed to an adapter that does not exist — or worse, quietly reporting a
  // successful sync of nothing.
  if (!isSyncableChain(account.walletChain)) {
    return NextResponse.json({
      error: `Balance sync is not available for ${account.walletChain ?? "this"} wallets yet. ` +
             `Supported: ${SYNCABLE_CHAINS.join(", ")}.`,
    }, { status: 400 });
  }

  // ── P1 REFRESH ALL — the guards the Plaid path has had since D2 Step 7B ─────
  // Order: admission → the customer's ENTITLED cooldown (one contract for banks
  // and wallets) → the ENTITLED per-user hourly ceiling → the per-connection
  // claim. None of these is a role check: the founder overlay changes the
  // numbers, never the rule.
  const admission = await admitOperationalWork({ work: "REFRESH_EXECUTION" });
  if (admission.decision === "DENY") {
    return NextResponse.json(
      { error: "not-admitted", reason: admission.reason, message: admission.label, evaluatedAt: admission.evaluatedAt },
      { status: 503 },
    );
  }
  const connection = account.connections.map((c) => c.connection).find((c): c is NonNullable<typeof c> => c !== null) ?? null;
  const cooldownMs = cooldownMsFromMinutes(Number(entitlements.dimensions.manualBankRefreshCooldownMinutes.value));
  const cooldown = checkManualRefreshCooldown(connection?.lastManualRefreshAt ?? null, cooldownMs);
  if (cooldown.onCooldown) {
    return NextResponse.json({ error: "cooldown", retryAfterSeconds: cooldown.retryAfterSeconds }, { status: 429 });
  }
  const walletsPerHour = Number(entitlements.dimensions.manualWalletRefreshPerHour.value);
  const limited = await limitByUser(user.id, "wallet-resync", { limit: walletsPerHour, windowSec: 3600 });
  if (limited) return limited;
  // The claim, the clock and the release are the SAME tenant-phase guard
  // primitives the customer's Refresh All composes (lib/refresh/deps.ts), so a
  // single wallet and many are governed by one implementation. Each is its own
  // short phase inside the builder; the gate above stays this handler's one.
  const guards = tenantRefreshDeps(user.id);
  let claimed = false;
  if (connection) {
    const at = new Date();
    claimed = await guards.claimWallet(connection.id, at);
    if (!claimed) return NextResponse.json({ error: "in-flight" }, { status: 409 });
    await guards.markWalletAttempt(connection.id, at);
  }

  // V26-ORCH-1 — stamped BEFORE the sync so rows it writes fall at/after it,
  // which is what lets the planner MEASURE what changed instead of guessing.
  const syncStartedAt = new Date();
  // PLATFORM OPS OBSERVABILITY — the owner pressed Sync: a MANUAL execution in
  // the refresh ledger, so the run, its duration and its verdict are inspectable.
  //
  // RLS-ACC-S1 — AUTHORITY, UNRESOLVED AND NAMED RATHER THAN BURIED. This and
  // the two regenerators below still reach the database through the migration
  // principal, each for a reason of its own and none of them this route's to
  // settle: `syncWalletByChain` interleaves explorer and price HTTP with its
  // writes (so no single transaction can contain it); `snapshotAccountsForOutcome`
  // deliberately ranges over EVERY holder of a re-quoted asset, which is a
  // deployment-wide blast radius like `lib/accounts/links-everywhere.ts`'s; and
  // `regenerateSnapshotsForAccounts` already writes a CO-OWNER's snapshot by
  // design, which fm_app cannot reach at all (RLS-C-S7 classified it fm_system
  // for exactly that reason).
  const result = await syncWalletByChain(id, account.walletChain, { trigger: "MANUAL" });

  // P1 — the post-sync steps (today's snapshots, planned history) are the
  // shared finaliser the customer's Refresh All uses, so one wallet and many
  // finish the same way. Best-effort/non-fatal inside.
  try {
    await finalizeWalletSync({ accountId: id, chain: account.walletChain, outcome: result, syncStartedAt, logPrefix: `[POST /api/accounts/${id}/sync]` });
  } finally {
    if (claimed && connection) await guards.releaseWallet(connection.id);
  }

  // Account remains visible and "pending" on failure — report the outcome
  // honestly rather than pretending success.
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
