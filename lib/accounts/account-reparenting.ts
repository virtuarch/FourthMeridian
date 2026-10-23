/**
 * lib/accounts/account-reparenting.ts  (RLS-ACC-FK)
 *
 * RE-POINTING A FINANCIAL CHILD ROW AT A DIFFERENT ACCOUNT IS AN AUTHORIZATION
 * DECISION, AND IT IS THIS MODULE'S DECISION.
 *
 * ── THE MEASURED DEFECT ──────────────────────────────────────────────────────
 * Under a real `fm_app` role in a throwaway container, an ACTIVE member of a
 * shared Space re-pointed SIX of another owner's transactions onto her own
 * account with one `UPDATE`. Nothing refused it, and nothing could have:
 *
 *   Transaction.fm_app_upd  USING      (fm_account_visible("financialAccountId"))
 *                           WITH CHECK (fm_account_visible("financialAccountId"))
 *
 * The victim's account is ACTIVE-linked into the shared Space, so
 * `fm_account_visible()` is TRUE on the row as it stands AND true on the row as
 * it would be — the `USING` arm and the `WITH CHECK` arm both pass, and the move
 * is a legal write. The link is BALANCE_ONLY; FULL and BALANCE_ONLY moved six
 * rows each, because `fm_account_visible()` ignores `visibilityLevel` entirely.
 * The inverse direction is equally open (fifteen of the attacker's own rows
 * pushed ONTO the victim's account).
 *
 * ── AND IT CANNOT BE FIXED IN POLICY ─────────────────────────────────────────
 * The project's boundary is fixed and recorded:
 *
 *     RLS = TENANCY ISOLATION.  APPLICATION = PRODUCT VISIBILITY / PERMISSIONS.
 *     (docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md §38 Q1)
 *
 * Both accounts are legitimately inside the actor's tenancy — that is what a
 * shared Space MEANS. Teaching `fm_account_visible()` about `visibilityLevel`
 * would move product permissions into the database, where `lib/account-privacy.ts`
 * can no longer be the authority on them and where every future tier is a
 * migration. So the refusal is the application's job, and this module is where
 * it is made once instead of eleven times.
 *
 * It is closed today at 5 of 11 capable sites only by COINCIDENCE: a `@unique`
 * column that happens to coincide with ownership, Plaid's per-Item id
 * allocation, or the simple absence of a second writer. None of those is a
 * guarantee, and one of them (`provider-identity.ts`'s swallowed collision) is
 * the exact event that makes the worst site resolve a different destination.
 *
 * ── WHY THIS IS THE GATE ON THE OWNER-ARM POLICY CHANGE ──────────────────────
 * The proposed owner arm turns the ONE variant RLS currently refuses —
 * destination archived, links revoked — into "6 of 6 moved, and the victim's own
 * access drops to 0". A policy change that converts a refused cross-owner attack
 * into a permitted one must not land before the refusal exists somewhere. It
 * exists here.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE INVARIANT
 *
 * For ANY operation that changes an account FK on an existing financial child
 * row:
 *
 *  1. The SOURCE ROW must be resolved within the caller's permitted mutation
 *     scope.
 *  2. The DESTINATION ACCOUNT must be within the caller's permitted mutation
 *     scope.
 *  3. Shared-Space tenancy visibility ALONE is insufficient to establish
 *     mutation authority over another owner's financial detail.
 *  4. FULL or BALANCE_ONLY visibility must not imply ownership or mutation
 *     authority unless an explicit product operation grants it.
 *  5. Browser/request-controlled `userId`/`accountId` values cannot establish
 *     ownership.
 *  6. Provider-derived and database-derived identifiers must still resolve
 *     through the caller's scope before mutation.
 *  7. Bulk operations must prove their ENTIRE intended population, not silently
 *     mutate the visible subset.
 *  8. A zero or partial write under RLS must not be read as successful
 *     authorization.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── HOW THE SHAPE ENFORCES CLAUSES 3, 4 AND 5 STRUCTURALLY ───────────────────
 * THERE IS NO `userId`, `ownerUserId`, `actorUserId` OR `visibilityLevel`
 * PARAMETER ANYWHERE IN THIS MODULE, and `account-reparenting.test.ts` asserts
 * that by scanning the source. That is the `lib/accounts/links-everywhere.ts`
 * idiom taken one step further: links-everywhere has no `userId` SELECTOR so no
 * caller can ask it about somebody else; this module has no owner argument AT
 * ALL, so no caller can TELL it who the owner is. Clause 5 is then not a rule
 * anyone has to remember — a request-controlled value has nowhere to enter.
 *
 * Authority is derived from DATABASE STATE and nothing else:
 *
 *     A re-parenting is authorized iff the source account and the destination
 *     account resolve through the WRITER'S OWN CLIENT and carry the SAME,
 *     NON-NULL `ownerUserId`.
 *
 * Tenancy visibility is not consulted, so clause 3 holds by construction: a
 * shared Space makes two accounts mutually VISIBLE and never makes them
 * co-owned. `visibilityLevel` is not read, so clause 4 holds the same way, and
 * cases 75 and 77 assert the BALANCE_ONLY and FULL answers are IDENTICAL — if
 * they ever diverge, this module has learned a tier it has no business knowing.
 *
 * ── THE PROBE MUST ISSUE THROUGH THE WRITER'S OWN CLIENT (clauses 1, 2, 6) ───
 * `client` is a REQUIRED first parameter with no default. A defaulted client is
 * an ambient authority, and here it would be an actively misleading one: a probe
 * on a WIDER authority than the write answers about rows the writer cannot see,
 * which is `lib/db/conditional-write.ts`'s rule and the reason that module's
 * visibility thunk is specified to use the same client. Under a tenant client an
 * account the caller cannot reach does not resolve, and an unresolvable account
 * is a REFUSAL — never an absence, never a default, never a continue.
 *
 * ⚠️ THE HONEST LIMIT, STATED HERE SO NOBODY HAS TO INFER IT. `reconcile.ts`
 * still executes on the migration principal (its client conversion is a later,
 * gated slice), so for THAT caller clauses 1/2/6 are enforced over a
 * deployment-wide view: the ownership comparison is fully mechanical (ownership
 * is a database fact, and BYPASSRLS cannot make two owners into one), but
 * "within the caller's permitted mutation scope" degenerates to "exists". The
 * cross-owner refusal is therefore real on every authority; the SCOPE half of
 * clauses 1/2 becomes mechanical for a given caller only once that caller
 * executes through a scoped client. Passing `tx`/`client` through rather than
 * importing `db` here is what makes that an edit to the CALLER and not to this
 * module.
 *
 * ── WHY A MISSING ROW AND A NULL OWNER BOTH REFUSE ───────────────────────────
 * A missing row refuses because "I could not see it" and "it is not there" are
 * indistinguishable, and NEITHER is permission (the `conditional-write.ts`
 * conflation, re-used deliberately).
 *
 * A NULL `ownerUserId` refuses because the schema permits a SPACE-owned account
 * (`ownerUserId` null, `ownerSpaceId` set) that NO account in production is, and
 * because `reconcile.ts`'s fingerprint sweep drops its `ownerUserId` predicate
 * entirely when the fingerprint's owner is null — a GLOBAL, cross-owner
 * candidate sweep. Refusing a null owner closes that hole in one place rather
 * than in every caller, and it refuses LOUDLY: if SPACE-owned accounts ever
 * become real, the first merge involving one raises here and the new authority
 * model gets designed on purpose instead of inherited by accident.
 */

import "server-only";

import type { WriteClient } from "@/lib/db/write-phase";

/* ────────────────────────────────────────────────────────────────────────────
 * THE SITE DESCRIPTOR
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * WHICH FK on WHICH table a statement is about to move.
 *
 * ⚠️ NO ROW CONTENTS, for exactly the reason `ConditionalWriteSite` gives: this
 * travels into logs. A table, a column, a verb and the primary keys involved are
 * enough to find the row and the policy. The `data` payload is not, and these
 * rows are a user's financial detail.
 */
export interface ReparentingSite {
  /** The table, as the policy names it (e.g. "Transaction"). */
  readonly table: string;
  /** The FK column being moved (e.g. "financialAccountId", "counterpartyAccountId"). */
  readonly fkField: string;
  /** The statement shape, for the operator reading the log. */
  readonly operation: "update" | "updateMany" | "upsert" | "create" | "raw";
}

const describe = (s: ReparentingSite) => `${s.table}.${s.fkField} (${s.operation})`;

/* ────────────────────────────────────────────────────────────────────────────
 * REFUSALS
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The re-parenting was not authorized.
 *
 * ⚠️ THIS MUST NOT BE CAUGHT AND DOWNGRADED. The whole family of defects this
 * module exists for consists of a refusal that was read as something calm:
 * contention, "identity row missing, continue", a smaller `updateMany` count. A
 * caller that swallows this has re-created the defect with a helper in front of
 * it. Catch it only where a throw would turn a best-effort write fatal, and LOG
 * it where you do.
 */
export class ReparentingRefusedError extends Error {
  readonly table: string;
  readonly fkField: string;
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly reason: ReparentingRefusalReason;

  constructor(
    site: ReparentingSite,
    sourceAccountId: string,
    destinationAccountId: string,
    reason: ReparentingRefusalReason,
    detail: string,
  ) {
    super(
      `${describe(site)}: REFUSING to re-point from account "${sourceAccountId}" to account "${destinationAccountId}" — ${detail} ` +
        `Tenancy visibility is not mutation authority over another owner's financial detail; a re-parenting requires both accounts to resolve, ` +
        `through this writer's own client, to the SAME non-null owner.`,
    );
    this.name = "ReparentingRefusedError";
    this.table = site.table;
    this.fkField = site.fkField;
    this.sourceAccountId = sourceAccountId;
    this.destinationAccountId = destinationAccountId;
    this.reason = reason;
  }
}

export type ReparentingRefusalReason =
  /** One or both accounts did not resolve through the writer's client. */
  | "UNRESOLVED_ACCOUNT"
  /** An account carries no `ownerUserId` (SPACE-owned, or orphaned by SetNull). */
  | "NULL_OWNER"
  /** Both resolved, both owned — by DIFFERENT users. The attack. */
  | "CROSS_OWNER";

/**
 * A write was about to move an account FK that the operation had no business
 * moving.
 *
 * Distinct from `ReparentingRefusedError` because the defect is distinct: there
 * the caller MEANT to re-parent and was not entitled to; here the caller did not
 * mean to re-parent at all and a provider-supplied or tenant-wide-unique
 * identifier resolved a row belonging to a DIFFERENT account. That is the shape
 * of `syncTransactions.ts`'s `plaidTransactionId` lookup and
 * `investment-event-ingest.ts`'s `[source, externalEventId]` lookup, and before
 * this existed neither one could even OBSERVE the move — their `select`s did not
 * read the FK, so no comparison was possible and the relocation was invisible.
 */
export class UnintendedReparentingError extends Error {
  readonly table: string;
  readonly fkField: string;
  readonly rowId: string;
  readonly observedAccountId: string | null;
  readonly intendedAccountId: string;

  constructor(
    site: ReparentingSite,
    rowId: string,
    observedAccountId: string | null,
    intendedAccountId: string,
  ) {
    super(
      `${describe(site)}: row "${rowId}" already belongs to account "${observedAccountId ?? "(null)"}" and this write would move it to "${intendedAccountId}". ` +
        `The identifier that resolved this row is tenant-wide unique, so it names a row WITHOUT naming an account — ` +
        `a re-delivered or reissued provider identifier resolving to a different account is a RELOCATION, not an update, and this operation does not perform relocations.`,
    );
    this.name = "UnintendedReparentingError";
    this.table = site.table;
    this.fkField = site.fkField;
    this.rowId = rowId;
    this.observedAccountId = observedAccountId;
    this.intendedAccountId = intendedAccountId;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLAUSE 6 — THE UNSCOPED SOURCE. THE CHEAP HALF, AND THE WORST SITES.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The row this write resolved must already live on the account this write is
 * for.
 *
 * Pure, synchronous, no client, no round trip — because at the two worst sites
 * the DESTINATION IS FINE and the SOURCE READ IS UNSCOPED. Both locate an
 * existing row by a TENANT-WIDE `@unique` key (`plaidTransactionId`;
 * `[source, externalEventId]`) and then write it with the current sync's
 * account. The key names a row without naming an account, so the row may belong
 * to anyone, and `provider-identity.ts` swallowing a
 * "another FinancialAccount already owns this provider identity" collision is
 * precisely the event that makes the destination differ.
 *
 * ⚠️ ADDING THE FK TO THOSE TWO `select`s IS MOST OF THE FIX. Until the read
 * returns the account, there is nothing to compare and the relocation cannot be
 * refused, logged, counted or even noticed. `observedAccountId` is typed
 * `string | null` rather than `string` SO THAT A FORGOTTEN SELECT IS A TYPE
 * ERROR AT THE CALL SITE rather than an `undefined` that compares unequal by
 * luck — and a null OBSERVED value refuses, because a row with no account is not
 * a row this comparison can clear.
 */
export function assertAccountFkUnchanged(
  site: ReparentingSite,
  rowId: string,
  observedAccountId: string | null,
  intendedAccountId: string,
): void {
  if (observedAccountId !== null && observedAccountId === intendedAccountId) return;
  throw new UnintendedReparentingError(site, rowId, observedAccountId, intendedAccountId);
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLAUSES 1, 2, 3, 4, 5 — THE AUTHORITY HALF
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a caller learned by asking. Returned rather than merely not-thrown so a
 * caller can log the owner it proved, and so a test can assert WHICH property
 * carried the decision.
 */
export interface ReparentingAuthority {
  /** The single owner both accounts resolved to. Never null — a null refuses. */
  readonly ownerUserId: string;
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
}

/**
 * Both accounts must resolve, through THIS CLIENT, to the same non-null owner.
 *
 * `client` is first and REQUIRED: the authority is the caller's, and a default
 * would make it ambient and silently wider than the write's.
 *
 * A same-account "move" (`sourceAccountId === destinationAccountId`) is still
 * resolved rather than short-circuited, deliberately: it is the one case where
 * returning early would be free, and it is also the case where a caller has
 * passed an unvalidated pair it believes to be equal. One indexed read is
 * cheaper than that assumption.
 *
 * Clause 4 note: `visibilityLevel` is not selected, not joined and not
 * mentioned. A FULL link and a BALANCE_ONLY link reach the identical verdict, by
 * construction rather than by care.
 */
export async function assertAccountReparentingAuthorized(
  client: WriteClient,
  site: ReparentingSite,
  sourceAccountId: string,
  destinationAccountId: string,
): Promise<ReparentingAuthority> {
  const refuse = (reason: ReparentingRefusalReason, detail: string): never => {
    throw new ReparentingRefusedError(site, sourceAccountId, destinationAccountId, reason, detail);
  };

  const wanted = sourceAccountId === destinationAccountId
    ? [sourceAccountId]
    : [sourceAccountId, destinationAccountId];

  // ⚠️ `select` is CLOSED and names `ownerUserId` only. `ownerSpaceId` is
  // deliberately NOT read: reading it would invite a future arm that treats a
  // Space-owned account as co-owned by its members, which is a new authority
  // model and not this slice's to invent (see the routed classification in the
  // RLS-ACC-FK report). A null owner refuses, loudly, and that is the whole
  // of this module's opinion about SPACE ownership.
  const rows = await client.financialAccount.findMany({
    where: { id: { in: wanted } },
    select: { id: true, ownerUserId: true },
  });

  const byId = new Map(rows.map((r) => [r.id, r.ownerUserId]));

  const unresolved = wanted.filter((id) => !byId.has(id));
  if (unresolved.length > 0) {
    // A missing row and a policy-hidden row are indistinguishable, and NEITHER
    // is permission. Conflated on purpose — the same conflation
    // `conditional-write.ts` documents.
    refuse(
      "UNRESOLVED_ACCOUNT",
      `${unresolved.length} of ${wanted.length} account(s) did not resolve through this client (${unresolved.join(", ")}); ` +
        `a row this authority cannot see is not a row it may mutate, and "hidden" is not distinguishable from "absent".`,
    );
  }

  const nullOwners = wanted.filter((id) => byId.get(id) == null);
  if (nullOwners.length > 0) {
    refuse(
      "NULL_OWNER",
      `${nullOwners.join(", ")} carr${nullOwners.length === 1 ? "ies" : "y"} no ownerUserId. ` +
        `A SPACE-owned or owner-orphaned account has no individual owner to compare, and this module refuses rather than inventing one.`,
    );
  }

  const sourceOwner = byId.get(sourceAccountId) as string;
  const destOwner = byId.get(destinationAccountId) as string;
  if (sourceOwner !== destOwner) {
    refuse(
      "CROSS_OWNER",
      `the source account is owned by "${sourceOwner}" and the destination by "${destOwner}".`,
    );
  }

  return { ownerUserId: sourceOwner, sourceAccountId, destinationAccountId };
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLAUSES 7 AND 8 — THE POPULATION
 *
 * There is NO new primitive here, on purpose. `assertEveryObservedRowWasWritten`
 * / `PartialBulkWriteError` (lib/db/conditional-write.ts) already say exactly
 * the right thing — "did I write every row I had already seen, through this same
 * authority?" — and that module's own header records that the primitive was
 * independently written twice within an hour and deliberately NOT shipped under
 * two names. A third copy with "reparenting" in its name would be the same
 * mistake with better motivation.
 *
 * What re-parenting adds is only WHERE it must be applied: every bulk FK move,
 * because a bulk re-point whose count fell short has left rows on an account the
 * rest of the operation has already treated as empty. `scripts/audit-account-
 * reparenting.ts` classifies each bulk site and the `reconcile.ts` suite asserts
 * the shortfall raises.
 * ──────────────────────────────────────────────────────────────────────────── */
