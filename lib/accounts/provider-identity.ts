/**
 * lib/accounts/provider-identity.ts
 *
 * D2 Step 2A — dual-write helper for ProviderAccountIdentity.
 * Design reference: docs/initiatives/d2/investigations/D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md (§B).
 *
 * Scope, deliberately narrow:
 *   - Called only from app/api/plaid/exchange-token/route.ts, only with
 *     provider=PLAID. The investigation report's write-site inventory (§A)
 *     confirmed every FinancialAccount.plaidAccountId create/reassignment
 *     happens in exactly that one file. lib/accounts/reconcile.ts never
 *     writes plaidAccountId on either side of a merge, so it needs no
 *     changes and is not a caller of this helper.
 *   - WALLET is also wired to this helper — called from
 *     app/api/accounts/wallet/route.ts's active-match, archived-match, and
 *     fresh-create branches (provider=WALLET, externalAccountId=walletAddress).
 *     The owner-scoped wallet dedup vs. this table's global unique constraint
 *     question raised in docs/initiatives/d2/investigations/D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md
 *     applies to WALLET backfill and read cutover, not to dual-write — see
 *     docs/initiatives/d2/D2_ROADMAP.md's "Required notes" for the current
 *     status of each.
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
 *
 * ── RLS-ACC-S4 — THE CATCH-EVERYTHING WAS SWALLOWING AN AUTHORITY REFUSAL ────
 * The catch below exists for ONE condition, stated in its own comment: a
 * unique-constraint collision, which "should not happen for PLAID". Under
 * `fm_app` it was also swallowing something entirely different.
 *
 * `ProviderAccountIdentity` is an account-SUBTREE table (migration §15), so
 * `fm_app_ins` is `WITH CHECK (fm_account_visible("financialAccountId"))` — false
 * until an ACTIVE `SpaceAccountLink` exists in a Space this identity belongs to.
 * MEASURED on a real provisioned fm_app role against a throwaway Postgres:
 *
 *     tx.providerAccountIdentity.create({ ... })   on an account with no link
 *       → PostgresError code "42501",
 *         "new row violates row-level security policy for table
 *          \"ProviderAccountIdentity\""
 *       → surfaced as PrismaClientUnknownRequestError with `code` UNDEFINED
 *
 * ⚠️ THERE IS NO TYPED PRISMA CODE. `e.code === "P2002"` never matches it, so
 * every refusal fell straight through to `console.warn` and the function returned
 * normally — and the identity row was then permanently absent. Which manifests
 * LATER, somewhere else, as the `[D2-3G]` coverage-gap warning. That is the
 * fallback whose entire job is to surface this class of problem, so swallowing
 * the refusal defeats the only detector we have for it.
 *
 * So the two are now DISTINGUISHED. A collision is still swallowed, exactly as
 * before. An authority refusal RAISES `ProviderIdentityAuthorityRefusedError`.
 *
 * ⚠️ THIS IS A DELIBERATE PRE-FLIP BLOCKER, AND IT HAS A NAMED UNBLOCKING EDIT.
 * `lib/plaid/exchangeToken.ts:418` calls this helper BEFORE `persistAccountSpine`
 * (:427), i.e. before the account has any link, so on a freshly imported Plaid
 * account the refusal is reachable. Today it CANNOT fire — there are no role
 * URLs, every client falls back to one principal, and `db` carries BYPASSRLS —
 * so product behaviour is unchanged by this commit. It becomes reachable at the
 * same moment the silent identity loss does, which is exactly when an operator
 * should hear about it rather than read a coverage-gap warning three surfaces
 * away. The edit that clears it is one move: in `lib/plaid/exchangeToken.ts`,
 * call `dualWriteProviderAccountIdentity` AFTER `persistAccountSpine` rather than
 * before. That file is outside this slice, so the edit is requested, not made.
 *
 * If the owner prefers the refusal non-fatal instead, the whole change is the one
 * `throw` below; everything else here is diagnosis.
 */

import { ProviderType } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * A database AUTHORITY refused the statement — row-level security or a missing
 * grant — as opposed to any modelled application condition.
 *
 * ── WHY IT IS DETECTED THIS WAY AND NOT BY A CODE ───────────────────────────
 * A refused MODEL operation reaches us as `PrismaClientUnknownRequestError` with
 * NO `code` at all; the SQLSTATE and Postgres's own wording survive only inside
 * the message. (A refused RAW query is different: Prisma reports it as the TYPED
 * `P2010`, which is why P2010 is the one typed code admitted here — see
 * lib/plaid/refresh-ledger-failure-matrix.test.ts's note.) Every OTHER typed
 * `P2xxx` is a modelled condition — P2002 unique collision, P2003 foreign key,
 * P2025 not found — and none of them is a policy refusal, so a typed code is a
 * positive reason to say NO.
 *
 * Exported so the next module with a defensive catch does not re-derive it. It
 * belongs in `lib/db/conditional-write.ts` beside `IndeterminateWriteError` and
 * `PartialBulkWriteError`; that file is outside this slice, so the move is
 * requested rather than made.
 */
export function isAuthorityRefusal(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && code !== "P2010") return false;
  const meta = (e as { meta?: unknown }).meta;
  const text = `${e.message} ${meta === undefined ? "" : JSON.stringify(meta)}`;
  return (
    /\b42501\b/.test(text) ||
    /row-level security policy/i.test(text) ||
    /permission denied for table/i.test(text)
  );
}

/**
 * The mirror-table write was refused by an AUTHORITY, not lost to a collision.
 *
 * Carries the account and provider so an operator can find the account whose
 * identity row is missing, and the cause so the SQLSTATE is not thrown away.
 * Never the externalAccountId — that is a provider identifier and this travels
 * into logs.
 */
export class ProviderIdentityAuthorityRefusedError extends Error {
  readonly financialAccountId: string;
  readonly provider: ProviderType;

  constructor(financialAccountId: string, provider: ProviderType, cause: unknown) {
    super(
      `ProviderAccountIdentity for account "${financialAccountId}" provider ${provider}: the write was REFUSED BY A DATABASE AUTHORITY, not lost to a unique collision. ` +
        `Refusing to swallow it — this helper is best-effort about PROVIDER facts, never about whether it was allowed to run. ` +
        `A swallowed refusal leaves the identity row permanently absent and resurfaces as the [D2-3G] coverage gap, with nothing pointing back here. ` +
        `The usual cause is write ORDER: the account-subtree policies require an ACTIVE SpaceAccountLink in a visible Space, so the link must exist first.`,
      { cause },
    );
    this.name = "ProviderIdentityAuthorityRefusedError";
    this.financialAccountId = financialAccountId;
    this.provider = provider;
  }
}

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
  externalAccountId: string,
  // Wallet Provider v1.5 — optional Connection linkage. When provided, the
  // identity row is created pointing at / repointed to this Connection. When
  // omitted (every pre-v1.5 caller, e.g. Plaid exchange-token), behavior is
  // byte-identical to before: connectionId stays null on create and untouched
  // on update. Passing `undefined` never clears an existing connectionId.
  connectionId?: string | null
): Promise<void> {
  try {
    const existing = await db.providerAccountIdentity.findFirst({
      where: { financialAccountId, provider },
    });

    if (!existing) {
      await db.providerAccountIdentity.create({
        data: { financialAccountId, connectionId: connectionId ?? null, provider, externalAccountId },
      });
      return;
    }

    const needsExternal   = existing.externalAccountId !== externalAccountId;
    // Only repoint the Connection when a caller actually supplied one and it
    // differs — `undefined` is "don't care", not "set to null".
    const needsConnection = connectionId !== undefined && existing.connectionId !== connectionId;

    if (needsExternal || needsConnection) {
      // Repoint in place rather than delete-then-create: avoids a window where
      // the (provider, externalAccountId) row briefly doesn't exist, and avoids
      // any ordering question with the onDelete: Cascade FK back to
      // FinancialAccount. (externalAccountId drift originally seen when Plaid
      // reissued account_id on reconnect — see reconcile.ts.)
      await db.providerAccountIdentity.update({
        where: { id: existing.id },
        data:  {
          ...(needsExternal   ? { externalAccountId }         : {}),
          ...(needsConnection ? { connectionId: connectionId } : {}),
        },
      });
    }
    // else: already correct — idempotent no-op.
  } catch (e) {
    // ⚠️ AN AUTHORITY REFUSAL IS NOT THE CONDITION THIS CATCH WAS WRITTEN FOR.
    // It arrives with NO typed Prisma code, so it used to fall straight through
    // to the warn below and the function returned as if it had succeeded. See
    // the module header for the measurement and for the one edit that clears it.
    if (isAuthorityRefusal(e)) {
      throw new ProviderIdentityAuthorityRefusedError(financialAccountId, provider, e);
    }
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
