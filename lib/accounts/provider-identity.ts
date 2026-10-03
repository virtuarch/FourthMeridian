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
 *   - Best-effort about PROVIDER FACTS — never about IDENTITY. A transport
 *     hiccup is the caller's problem to shrug at; a contested identity is not.
 *     See "PROVIDER-IDENTITY" below for the collision semantics, which replaced
 *     the original unconditional swallow.
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
 * So the two are now DISTINGUISHED. An authority refusal RAISES
 * `ProviderIdentityAuthorityRefusedError`. (S4 left the collision swallowed;
 * PROVIDER-IDENTITY, below, is the slice that stopped doing that.)
 *
 * ⚠️ THIS WAS A DELIBERATE PRE-FLIP BLOCKER, AND ITS NAMED EDIT HAS LANDED.
 * S4 recorded that `lib/plaid/exchangeToken.ts` called this helper BEFORE
 * `persistAccountSpine`, i.e. before the account had any link, which makes the
 * refusal reachable on a freshly imported Plaid account. RLS-HARNESS-1 made the
 * one move S4 asked for: the call now runs AFTER `persistAccountSpine`, and the
 * ORDER IS LOAD-BEARING — see that call site's own comment, which states it and
 * the measurement behind it.
 *
 * ── PROVIDER-IDENTITY — A COLLISION IS A CLASSIFICATION, NOT AN EXCEPTION ────
 * RLS-ACC-S4 split the authority refusal out of the catch and left the rest of
 * it exactly as it found it: `console.warn(…)` and return as though the write
 * had succeeded. That remainder was swallowing TWO different things.
 *
 *   1. A uniqueness collision, which the old comment called "defensive only …
 *      should not happen for PLAID". That is a PREDICTION about provider
 *      behaviour, not an invariant this process can enforce, and the prediction
 *      is load-bearing for something else entirely: `syncTransactions.ts`
 *      resolves a transaction's destination account through
 *      `providerAccountIdentity.findFirst({ provider, externalAccountId })` —
 *      a lookup that names a ROW WITHOUT NAMING AN ACCOUNT. If the identity row
 *      is missing the resolve silently falls back to the legacy
 *      `FinancialAccount.plaidAccountId`; if it is MIS-POINTED the resolve
 *      returns a DIFFERENT destination account and a provider's transaction
 *      lands on a stranger's ledger. That is the symptom acceptance case 79 and
 *      the `FK_UNCHANGED_PROVEN` sites refuse — and `syncTransactions.ts`'s own
 *      comment names THIS FILE as the cause. The refusal downstream is defence
 *      in depth and STAYS; this is the boundary where the cause belongs.
 *
 *   2. EVERYTHING ELSE. Any unrelated failure — a serialization error, a
 *      connection drop mid-statement, a schema drift, a bug in this file —
 *      produced one `console.warn` and a successful-looking return. The catch
 *      is now narrow: an authority refusal raises, a uniqueness collision is
 *      CLASSIFIED, and anything else is rethrown unchanged. There is exactly
 *      one non-fatal path left and it is named: a collision proven to be our
 *      OWN mapping, i.e. a replay.
 *
 * THE SEMANTICS:
 *
 *   identity already maps to the SAME FinancialAccount → idempotent success
 *   identity maps to a DIFFERENT FinancialAccount     → ProviderIdentityConflictError
 *   the classification cannot be made (INDETERMINATE) → ProviderIdentityConflictError
 *   an authority refused the write                     → ProviderIdentityAuthorityRefusedError
 *   anything else                                      → rethrown verbatim
 *
 * ⚠️ A `P2002` DOES NOT, BY ITSELF, SAY WHICH CASE IT IS. The error carries a
 * key, not a verdict. So the collision is followed by an authoritative REREAD
 * and the verdict comes from what the reread sees:
 *
 *     attempted write → uniqueness conflict → reread ProviderAccountIdentity by
 *     the conflicting provider key → SAME_ACCOUNT | DIFFERENT_ACCOUNT | INDETERMINATE
 *
 * ── THE AUTHORITY USED FOR THE REREAD, AND WHY IT NEEDS NO ESCALATION ───────
 * The reread goes through THE SAME CLIENT THE WRITE USED — today the module-
 * global `db`. Not `systemDb`, not any privileged lookup, and deliberately so:
 * a classifier that escalates to answer a question the writer could not answer
 * is the confused-deputy path RLS-D1 and the reconciliation work removed, and
 * it would make this function able to LEARN about a tenant it may not read.
 *
 * It reads `ProviderAccountIdentity` by its conflicting key only — never
 * `FinancialAccount`, never a global owner lookup — and compares exactly one
 * field, `financialAccountId`, against the one it was given. Nothing about
 * another account travels out: not its id, not its external identifier, not a
 * count of its rows beyond "how many are not ours".
 *
 * ⚠️ AND IF THE REREAD FINDS NOTHING, THAT IS NOT "NO CONFLICT". It is
 * INDETERMINATE and it FAILS CLOSED. This is the case that matters AFTER this
 * function is converted to a tenant client (a separate slice — it takes no
 * client parameter yet). Under `fm_app`, `ProviderAccountIdentity` is an
 * account-subtree table gated on `fm_account_visible("financialAccountId")`, so
 * a conflicting row belonging to ANOTHER tenant is simply invisible: the write
 * collides against a row the reader cannot see and the reread comes back empty.
 * Classified as "nothing found, therefore no conflict", that is a silent
 * corruption with an RLS policy as its alibi. Classified as INDETERMINATE it is
 * a refusal, which is correct today (where the empty reread can only mean the
 * row vanished between statements) and correct after conversion (where it means
 * the row is real and hidden). Either way the caller is told, and nothing about
 * the other tenant is disclosed — which is the whole point of refusing rather
 * than looking harder.
 *
 * ── 🚨 A FINDING THIS REPAIR DOES NOT CLOSE, AND MUST NOT BE READ AS CLOSING ─
 * The old comment's phrasing — "a unique-constraint collision here would mean
 * some OTHER FinancialAccount already holds this externalAccountId" — DESCRIBES
 * A CONSTRAINT THAT NO LONGER EXISTS. `@@unique([provider, externalAccountId])`
 * was dropped by migration 20260627180853 (D2 Step 1D, multi-account identity)
 * and replaced with `@@unique([provider, externalAccountId, financialAccountId])`.
 * On any migrated database a second FinancialAccount claiming the same provider
 * identity therefore raises NOTHING AT ALL — there is no collision to classify.
 * The schema comment is explicit that "single-identity providers keep their
 * invariant at the APPLICATION level: dualWriteProviderAccountIdentity()", i.e.
 * it delegates the invariant to this function, and this function never
 * implemented it.
 *
 * So the classifier below answers the conflicting-key question for BOTH unique
 * shapes, and on a collision it reports DIFFERENT_ACCOUNT whenever a foreign row
 * is visible under a provider whose identity is exclusive. What it cannot do is
 * manufacture a collision the database no longer raises. Closing that hole needs
 * a pre-write exclusivity read for exclusive providers plus an account-scoped
 * `resolveFinancialAccountId`, which changes the happy path and the Plaid
 * import's failure modes — a separate, measured slice. It is recorded here
 * rather than bolted on.
 *
 * ── 🚨 AND A SECOND LIMIT, MEASURED ON A REAL ROLE (acceptance case 84) ─────
 * The fail-closed rule covers the collision whose key is held BY SOMEONE ELSE:
 * under a tenant client that row is invisible, the reread is empty, and the
 * verdict is INDETERMINATE. It does NOT cover the collision whose key is held
 * BY US TOO. There the reread legitimately finds our own row and returns
 * SAME_ACCOUNT, while the same reread on a privileged principal would have seen
 * a foreign holder and returned DIFFERENT_ACCOUNT. Measured: 2 rows /
 * DIFFERENT_ACCOUNT privileged; 1 row / SAME_ACCOUNT blinded.
 *
 * That gap is NOT closeable here. Seeing a holder RLS hides requires exactly
 * the escalated read this classifier refuses to perform, and an escalation
 * added to "be safe" is the confused deputy arriving by the front door. What
 * actually protects PLAID is a constraint RLS does not filter —
 * `FinancialAccount.plaidAccountId @unique`. Case 84 pins both halves so the
 * day either verdict moves, it moves visibly.
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
 * What the reread concluded about a uniqueness collision.
 *
 * `SAME_ACCOUNT` is the ONLY verdict that is not an error: the mapping the
 * caller asked for already exists, on the account the caller named. That is a
 * replay, and a replay is a success.
 */
export type ProviderIdentityConflictVerdict =
  | "SAME_ACCOUNT"
  | "DIFFERENT_ACCOUNT"
  | "INDETERMINATE";

/**
 * Providers whose identity may LEGITIMATELY be held by more than one
 * FinancialAccount at the same time.
 *
 * Exactly one qualifies, and it is a design decision with a document: D2 Step
 * 1D (migration 20260627180853) widened the unique key precisely so that two
 * owners' private interpretations of the SAME PUBLIC WALLET ADDRESS can
 * coexist. A foreign WALLET row is therefore not evidence of anything.
 *
 * ⚠️ THE SET IS AN ALLOWLIST, NOT A DENYLIST, SO AN UNRECOGNISED PROVIDER FAILS
 * CLOSED. PLAID's exclusivity is independently real — `FinancialAccount
 * .plaidAccountId` carries its own `@unique` — and no other provider has a
 * documented sharing design, so "shared" has to be claimed, never assumed.
 */
const PROVIDER_IDENTITY_MAY_BE_SHARED_ACROSS_ACCOUNTS: ReadonlySet<ProviderType> = new Set([
  ProviderType.WALLET,
]);

/**
 * The error is a UNIQUENESS collision — the modelled condition — as opposed to
 * an authority refusal (checked first and separately) or anything else.
 *
 * `P2002` is the typed form. The untyped form is admitted too: a collision on a
 * DEFERRED constraint, or one raised inside a raw statement, reaches us as a
 * `PrismaClientUnknownRequestError` carrying Postgres's own 23505 wording and
 * no Prisma code at all — the same shape that let an authority refusal through
 * this catch for months. Recognising only the typed code would repeat that
 * mistake with a different SQLSTATE.
 */
export function isUniqueCollision(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (code === "P2002") return true;
  if (typeof code === "string" && code !== "P2010") return false;
  const meta = (e as { meta?: unknown }).meta;
  const text = `${e.message} ${meta === undefined ? "" : JSON.stringify(meta)}`;
  return /\b23505\b/.test(text) || /duplicate key value violates unique constraint/i.test(text);
}

/**
 * Did the constraint that collided include `financialAccountId`?
 *
 * This is the difference between "I collided with MY OWN row" (the key is
 * account-scoped, so the colliding row is on this account by construction) and
 * "I collided with WHOEVER holds this identity" (the key is global, so the
 * colliding row may be anyone's).
 *
 * ⚠️ `meta.target` HAS THREE SHAPES AND ONE OF THEM IS TRUNCATED. MEASURED on
 * Prisma 5.22 against Postgres 16 (acceptance case 83, on a real collision):
 * the target is the FIELD-NAME ARRAY
 * `["provider","externalAccountId","financialAccountId"]`. That is the live
 * shape and it is the one that matters.
 *
 * The other two are handled because they are not hypothetical: Prisma reports a
 * bare string or the INDEX NAME on other connectors and other versions, and
 * Postgres truncates index names at 63 characters — this table's reads
 * `ProviderAccountIdentity_provider_externalAccountId_financia_key`, with the
 * column name cut MID-WORD. A needle of `financialAccountId` matches the
 * measured shape and MISSES that one, reading an own-row collision as a foreign
 * one. So the needle is the surviving stem, which matches all three.
 *
 * Absent or unreadable metadata returns false — i.e. "assume the key was
 * global", the answer that lets a foreign row count as a conflict. Fail closed.
 */
export function conflictKeyIsAccountScoped(e: unknown): boolean {
  const meta = (e as { meta?: { target?: unknown } } | null | undefined)?.meta;
  const target = meta?.target;
  if (target === undefined || target === null) return false;
  const text = Array.isArray(target) ? target.map(String).join(",") : String(target);
  return /financia/i.test(text);
}

/**
 * THE DECISION TABLE, AS A PURE FUNCTION OF WHAT THE REREAD SAW.
 *
 * Separated from the reread on purpose: the reread is an authority question and
 * is proved on a real role in scripts/rls-app-acceptance.ts; this is a logic
 * question and every branch of it can be forced directly. A classifier whose
 * branches cannot be forced in isolation is the original defect in a new
 * costume.
 *
 * @param rows            every ProviderAccountIdentity row VISIBLE to the
 *                        writer's own client under the conflicting provider key
 * @param accountScopedKey whether the collided constraint included the account
 */
export function classifyProviderIdentityConflictRows(params: {
  rows: ReadonlyArray<{ financialAccountId: string }>;
  financialAccountId: string;
  provider: ProviderType;
  accountScopedKey: boolean;
}): { verdict: ProviderIdentityConflictVerdict; conflictingAccountCount: number } {
  const { rows, financialAccountId, provider, accountScopedKey } = params;

  const foreign = new Set(
    rows.map((r) => r.financialAccountId).filter((id) => id !== financialAccountId),
  );
  const ours = rows.some((r) => r.financialAccountId === financialAccountId);

  // The reread came back empty. Either the row vanished between statements, or
  // — after the tenant-client conversion — it is REAL AND HIDDEN BY RLS. Both
  // are "I cannot explain my own collision", and neither is "carry on".
  if (rows.length === 0) {
    return { verdict: "INDETERMINATE", conflictingAccountCount: 0 };
  }

  // A foreign holder is a conflict unless this provider has a DOCUMENTED
  // multi-account design AND the collision was with our own row anyway.
  const sharingIsLegitimate =
    accountScopedKey && PROVIDER_IDENTITY_MAY_BE_SHARED_ACROSS_ACCOUNTS.has(provider);
  if (foreign.size > 0 && !sharingIsLegitimate) {
    return { verdict: "DIFFERENT_ACCOUNT", conflictingAccountCount: foreign.size };
  }

  // Our own mapping is present: the write the caller wanted has already
  // happened. Replay.
  if (ours) return { verdict: "SAME_ACCOUNT", conflictingAccountCount: foreign.size };

  // Rows exist, none of them ours, and coexistence is legitimate — so the thing
  // we collided WITH is still unaccounted for. Refuse rather than guess.
  return { verdict: "INDETERMINATE", conflictingAccountCount: foreign.size };
}

/**
 * The mirror-table write collided, and the reread could not prove the existing
 * mapping is OUR OWN.
 *
 * ── WHAT THIS ERROR DELIBERATELY DOES NOT CARRY ─────────────────────────────
 * Not the `externalAccountId` — a provider identifier, and this message travels
 * into logs; `ProviderIdentityAuthorityRefusedError` already holds that line and
 * splitting it here would make the pair incoherent. Not the conflicting
 * account's id either: naming it would hand one tenant a fact about another
 * from a path that may not be allowed to read it, which is exactly the
 * escalation the reread refuses to perform. A COUNT is carried, because
 * "contested by one" and "contested by four" are different operational
 * situations and neither identifies anyone.
 *
 * An operator with a legitimate authority can recover the rest in one query
 * from `financialAccountId` + `provider`. An attacker cannot.
 */
export class ProviderIdentityConflictError extends Error {
  readonly financialAccountId: string;
  readonly provider: ProviderType;
  readonly verdict: "DIFFERENT_ACCOUNT" | "INDETERMINATE";
  readonly conflictingAccountCount: number;

  constructor(
    financialAccountId: string,
    provider: ProviderType,
    verdict: "DIFFERENT_ACCOUNT" | "INDETERMINATE",
    conflictingAccountCount: number,
    cause: unknown,
  ) {
    super(
      `ProviderAccountIdentity for account "${financialAccountId}" provider ${provider}: ` +
        (verdict === "DIFFERENT_ACCOUNT"
          ? `the provider identity this write claims is ALREADY HELD BY ${conflictingAccountCount} OTHER FinancialAccount(s). `
          : `the write collided and an authoritative reread through the writer's own client could NOT establish whose mapping it collided with. `) +
        `Refusing to continue, and refusing to adopt the conflicting account as an alternate destination. ` +
        `A contested identity is not a transport hiccup: the provider resolve in lib/plaid/syncTransactions.ts keys on ` +
        `(provider, externalAccountId) WITHOUT naming an account, so an identity that points somewhere this account does not live ` +
        `routes a provider's transactions onto another ledger. The FK guard downstream refuses that move; this is the boundary that ` +
        `should never have produced it. ` +
        (verdict === "INDETERMINATE"
          ? `An empty reread is NOT evidence of no conflict — under a tenant client a foreign row is invisible by policy — so this fails closed.`
          : `No account FK has been changed as a consequence of this collision.`),
      { cause },
    );
    this.name = "ProviderIdentityConflictError";
    this.financialAccountId = financialAccountId;
    this.provider = provider;
    this.verdict = verdict;
    this.conflictingAccountCount = conflictingAccountCount;
  }
}

/**
 * Ensures exactly one ProviderAccountIdentity row exists for
 * (financialAccountId, provider) with the given externalAccountId —
 * creating it if missing, repointing it if the existing row's
 * externalAccountId has drifted (e.g. Plaid reissued account_id on
 * reconnect), or doing nothing if it's already correct.
 *
 * ⚠️ IT THROWS. The original contract ("never throws; logs and swallows any
 * failure") is gone, and in three steps: RLS-ACC-S4 took the authority refusal
 * out of the swallow, and PROVIDER-IDENTITY took the identity conflict and the
 * unknown failure out of it too. What remains non-fatal is one named case — a
 * collision proven to be this account's own mapping, i.e. a replay. Callers
 * that must not fail their primary flow absorb the throw EXPLICITLY, at their
 * own boundary, with their own severity; see lib/plaid/exchangeToken.ts and
 * lib/accounts/wallet-connection.ts.
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
    // ── THE CATCH IS NOW THREE NAMED OUTCOMES AND A RETHROW ──────────────────
    //
    // ⚠️ ORDER IS LOAD-BEARING. An authority refusal is tested FIRST because it
    // arrives with NO typed Prisma code — it used to fall straight through to a
    // `console.warn` and the function returned as if it had succeeded (see the
    // module header for the measurement). It must never be relabelled as an
    // identity conflict: "the database would not let me" and "someone else
    // holds this identity" call for different people and different fixes.
    if (isAuthorityRefusal(e)) {
      throw new ProviderIdentityAuthorityRefusedError(financialAccountId, provider, e);
    }

    // A uniqueness collision is the modelled condition — and it is a QUESTION,
    // not a verdict. Answer it by rereading, then act on the answer.
    if (isUniqueCollision(e)) {
      const { verdict, conflictingAccountCount } = await classifyProviderIdentityConflict(
        e, financialAccountId, provider, externalAccountId,
      );

      // THE ONE REMAINING NON-FATAL PATH, AND IT IS NAMED: the mapping the
      // caller asked for already exists on the account the caller named. That
      // is a replay — the concurrent-creation loser, or the xpub case where a
      // sibling row on this same account already carries the target address —
      // and the postcondition the caller wanted holds. Return deterministically
      // and write nothing further: re-attempting would only collide again.
      if (verdict === "SAME_ACCOUNT") return;

      // ⚠️ NO ALTERNATE DESTINATION IS SELECTED AND NO FK IS TOUCHED. The
      // tempting repair — "adopt the account that already holds this identity"
      // — is the corruption, not the fix: it is how a provider's transactions
      // reach a ledger they do not belong to, which is what acceptance case 79
      // and the FK_UNCHANGED_PROVEN sites refuse one layer downstream. This
      // function's job is to stop producing the state they have to refuse.
      throw new ProviderIdentityConflictError(
        financialAccountId, provider, verdict, conflictingAccountCount, e,
      );
    }

    // ⚠️ EVERYTHING ELSE IS LOUD. The old catch-all `console.warn` return was
    // the second thing this catch was swallowing and the less visible one: a
    // serialization failure, a dropped connection mid-statement, schema drift,
    // or a bug in the lines above all produced one warn line and a
    // successful-looking return. An operational failure is the caller's to
    // handle, not this function's to hide.
    throw e;
  }
}

/**
 * THE REREAD. The impure half of the classification, kept to four lines so the
 * decision table above can be tested without one.
 *
 * ⚠️ `db` IS NOT A DEFAULT HERE, IT IS THE POINT. The reread must go through
 * the SAME client that attempted the write, because the question is "what can
 * the writer see" — a different authority answers a different question, and a
 * MORE privileged one answers a question the writer was not entitled to ask.
 * When this function is converted to take a tenant client (a separate slice),
 * this reread converts with it and nothing else here changes.
 */
async function classifyProviderIdentityConflict(
  e: unknown,
  financialAccountId: string,
  provider: ProviderType,
  externalAccountId: string,
): Promise<{ verdict: ProviderIdentityConflictVerdict; conflictingAccountCount: number }> {
  let rows: Array<{ financialAccountId: string }>;
  try {
    rows = await db.providerAccountIdentity.findMany({
      // The conflicting PROVIDER key, and only it. Never FinancialAccount,
      // never an owner lookup. `financialAccountId` is the one field selected,
      // and it is compared — never returned, never logged.
      where:  { provider, externalAccountId },
      select: { financialAccountId: true },
    });
  } catch (rereadError) {
    // The reread was itself refused by an authority: that is the authority
    // failure, loudly, and NOT an identity conflict wearing its coat.
    if (isAuthorityRefusal(rereadError)) {
      throw new ProviderIdentityAuthorityRefusedError(financialAccountId, provider, rereadError);
    }
    // Any other reread failure means the classification could not be made.
    // Fail closed, exactly as an empty reread does.
    return { verdict: "INDETERMINATE", conflictingAccountCount: 0 };
  }

  return classifyProviderIdentityConflictRows({
    rows,
    financialAccountId,
    provider,
    accountScopedKey: conflictKeyIsAccountScoped(e),
  });
}
