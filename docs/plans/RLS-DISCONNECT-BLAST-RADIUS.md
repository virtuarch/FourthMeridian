# DISCONNECT IS A DEPLOYMENT-WIDE OPERATION WEARING A TENANT'S CLOTHES

Status: **DECIDED — the open `disconnect.ts` question is resolved. Input to Slice C S7.**
Decided: 2026-10-02.
Scope: read-only analysis. No code changed by this document.

---

## The question as it was posed

> Under `fm_app`, a joint account disconnected by one owner would stay live in the
> co-owner's Space, silently (`updateMany` returns a smaller count, not an error).
> Route it to `fm_system`, or accept it?

That framing invites a product debate about what *should* happen to a co-owner.
The debate is unnecessary, because the product has already answered.

## What already happens

`lib/accounts/disconnect.ts:74` today, on the migration principal:

```ts
const links = await tx.spaceAccountLink.findMany({
  where: { financialAccountId: { in: ids }, status: ACTIVE },
  select: { spaceId: true },
});
await tx.spaceAccountLink.updateMany({
  where: { financialAccountId: { in: ids }, status: ACTIVE },
  data:  { status: REVOKED, revokedAt: now, revokedByUserId: actorUserId },
});
```

`db` sees **every** link, in every Space, so:
- every co-owner's link is revoked, and
- `affectedSpaceIds` includes every co-owner's Space, so **their snapshot is
  regenerated** (`:84-89`) and their net worth stops counting the account.

So the shipped semantics are already **"disconnect revokes everywhere."** This is
not an accident of the client; it is the only coherent meaning. The account has
been soft-deleted (`:62`) and its connections closed (`:66`). A co-owner's
`ACTIVE` link to a soft-deleted account is not a feature — it is a dangling
reference whose Space would narrate a balance for an account that no longer syncs.

## What `fm_app` would silently change

`SpaceAccountLink`'s policy scopes to `spaceId IN (SELECT fm_visible_space_ids())`.
The actor is not a member of the co-owner's Space, so that link is **invisible**:

| | on `db` today | on `fm_app` |
|---|---|---|
| co-owner's link | → `REVOKED` | **stays `ACTIVE`**, pointing at a soft-deleted account |
| co-owner's snapshot | regenerated | **never regenerated** — their net worth keeps the balance |
| the actor's own Space | correct | correct |
| error raised | — | **none.** `updateMany` returns a smaller count and nobody reads it |

This is the Part 1 defect from `RLS-SILENT-REFUSAL-CAS.md` in its *partial* form,
which is nastier than the zero form: a count of 1-of-2 looks exactly like success.

## The decision

**Route the link revocation and the affected-Space capture to `fm_system`, behind
a narrow, explicitly-named "revoke everywhere" capability. Do not weaken any
policy, and do not change product semantics.**

The reasoning is the same as the Plaid split-authority slice reached
independently: **authority must follow the operation's true blast radius.**
Disconnect is deployment-wide by its own definition, so `fm_app` cannot express
it — not because the policy is too strict, but because the operation genuinely
reaches rows the actor cannot see, and always has.

Changing product semantics as a side effect of an infrastructure migration is
precisely the silent drift this programme exists to prevent. "Accept it" would do
that, invisibly, in the direction of data corruption.

## The shape, so `fm_system` does not become an escape hatch

Three constraints, all mechanically checkable:

1. **Authorization stays in the tenant phase, before the capability is reached.**
   Both callers already authorize (`disconnect.ts:16-17` — the account route via
   an `ACTIVE` link it added, the connection route via connection ownership).
   That check moves into `withTenantDb`, which makes it a database guarantee
   rather than a correctly-written `WHERE`. The capability is only ever called
   with ids a tenant phase already proved.
2. **The capability takes already-authorized ids and returns counts, never rows.**
   The `lib/users/availability.ts` idiom the authority audit already sanctions:
   the widest authority reached through the narrowest opening. It takes no
   `spaceId` and no `userId` selector, so there is no argument through which a
   caller could ask it about somebody else.
3. **It is listed in `scripts/audit-db-authority.ts` as a FILE, not a directory** —
   `lib/accounts/` must not become a `systemDb` neighbourhood.

## And the partial count stops being silent

The revoke must report what it revoked. A co-owner's link failing to revoke is
exactly the event that must not pass quietly, so the capability returns the
revoked count and the caller asserts it against the links it observed. That is
the Part 1 helper applied to a partial rather than a zero.

## Not a finding: the Plaid orphan gate

I checked `disconnectPlaidItemIfOrphaned` (`lib/plaid/disconnect.ts:27`) on
suspicion that a narrowed view would make `remaining === 0` fire the destructive
`itemRemove` for an item a co-owner still uses. **It does not.** `PlaidItem`'s
policy is `"userId" = current_fm_user_id()`, so an item belongs to the single user
who connected it, and that user owns the accounts hanging off it — their
`AccountConnection` rows are all visible to them. The count is accurate under
`fm_app`. Recorded here so the next reader does not have to re-derive it.
