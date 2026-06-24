/**
 * lib/accounts/provider-identity.ts
 *
 * D2 Step 2A — dual-write helper for ProviderAccountIdentity.
 * Design reference: docs/D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md (§B).
 *
 * Scope, deliberately narrow:
 *   - Called only from app/api/plaid/exchange-token/route.ts, only with
 *     provider=PLAID. The investigation report's write-site inventory (§A)
 *     confirmed every FinancialAccount.plaidAccountId create/reassignment
 *     happens in exactly that one file. lib/accounts/reconcile.ts never
 *     writes plaidAccountId on either side of a merge, so it needs no
 *     changes and is not a caller of this helper.
 *   - WALLET is not wired to this helper — deferred pending the collision
 *     decision in docs/D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md
 *     (owner-scoped wallet dedup vs. this table's global unique constraint).
 *     The helper is written generically over ProviderType so it can be
 *     reused for WALLET later without a signature change, but nothing calls
 *     it with provider=WALLET today.
 *   - connectionId is always null — Connection has zero writers anywhere in
 *     this codebase yet (confirmed via repo-wide grep); wiring
 *     PlaidItem -> Connection is a separate, later decision.
 *   - Best-effort / non-fatal: every call is wrapped in try/catch internally
 *     and never throws into its caller. Mirrors dualWriteSpaceAccountLink
 *     (lib/accounts/space-account-link.ts) — a mirror-table write must never
 *     block the primary Plaid import/relink flow it's attached to.
 *   - Never deletes a ProviderAccountIdentity row. Mirrors reconcile.ts's
 *     explicit "NEVER hard-deletes a FinancialAccount row" philosophy — an
 *     identity row left pointing at an archived/superseded account is
 *     tolerated as informational, exactly like the orphaned-identity case
 *     scripts/verify-provider-account-identity-backfill.ts's Check 5 already
 *     treats as non-failing.
 *   - Idempotent: a no-op when the existing row's externalAccountId already
 *     matches. Safe to call on every plaidAccountId write, including ones
 *     that don't change the value (the exact-match branch) — it self-heals
 *     any row that was never backfilled rather than requiring the caller to
 *     determine whether the value actually changed.
 */

import { db } from "@/lib/db";
import { ProviderType } from "@prisma/client";

/**
 * Ensures exactly one ProviderAccountIdentity row exists for
 * (financialAccountId, provider) with the given externalAccountId —
 * creating it if missing, repointing it if the existing row's
 * externalAccountId has drifted (e.g. Plaid reissued account_id on
 * reconnect), or doing nothing if it's already correct.
 *
 * Never throws. Logs and swallows any failure so a mirror-table write can
 * never block the primary FinancialAccount write it's attached to.
 */
export async function dualWriteProviderAccountIdentity(
  financialAccountId: string,
  provider: ProviderType,
  externalAccountId: string
): Promise<void> {
  try {
    const existing = await db.providerAccountIdentity.findFirst({
      where: { financialAccountId, provider },
    });

    if (!existing) {
      await db.providerAccountIdentity.create({
        data: { financialAccountId, connectionId: null, provider, externalAccountId },
      });
      return;
    }

    if (existing.externalAccountId !== externalAccountId) {
      // Repoint — the account's external identifier changed (e.g. Plaid
      // reissued account_id for this row on reconnect; see reconcile.ts's
      // fingerprint-fallback header comment for the observed historical
      // case). Update in place rather than delete-then-create: avoids a
      // window where the (provider, externalAccountId) row briefly doesn't
      // exist, and avoids any ordering question with the onDelete: Cascade
      // FK back to FinancialAccount.
      await db.providerAccountIdentity.update({
        where: { id: existing.id },
        data:  { externalAccountId },
      });
    }
    // else: already correct — idempotent no-op.
  } catch (e) {
    // Defensive only — see module header. A unique-constraint collision here
    // would mean some OTHER FinancialAccount already holds this
    // externalAccountId, which should not happen for PLAID (the value comes
    // directly from Plaid's own account_id; the caller's prior
    // findUnique({ plaidAccountId }) / resolveAccountByFingerprint lookup
    // already guarantees only one row is the owner of that real-world
    // account). Caught rather than allowed to fail the Plaid import/relink
    // flow it's attached to.
    console.warn(
      `[dualWriteProviderAccountIdentity] failed for account ${financialAccountId} provider ${provider} (non-fatal):`,
      e
    );
  }
}
