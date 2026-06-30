# D2 Step 7A — Connection Health Implementation Checklist

**Investigation/checklist only. No code, schema, or migration changes were
made to produce this document.** Branch: `feature/phase-2-architecture`.
Baseline: `v2.3.0`.

Goal: make provider sync failures persist useful health state instead of
only logging, using the smallest change that fits the existing
`PlaidItemStatus`/`errorCode` shape — no scheduler wiring, no reconnect UI,
no retry/backoff. This is the implementation follow-up to item #2
("Connection health") in `D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md`,
which already concluded this item is ranked 1st (tied with scheduler wiring)
and rated S–M size.

Audited in full: `lib/plaid/errors.ts`, `lib/plaid/refresh.ts`,
`lib/plaid/syncTransactions.ts`, `app/api/plaid/sync/route.ts`,
`app/api/plaid/refresh/route.ts`, `jobs/sync-banks.ts`, the
`PlaidItem`/`Connection`/`AccountConnection` sections of
`prisma/schema.prisma`. Also checked, because they materially change the
recommendation: `lib/plaid/disconnect.ts`, `app/api/plaid/exchange-token/route.ts`
(the only place that ever writes `PlaidItemStatus`/`errorCode` today),
`app/api/brief/route.ts` (an existing, currently-dead consumer of
`FinancialAccount.syncStatus === "error"`), and a repo-wide grep for every
write/read of `syncStatus`, `PlaidItemStatus`, and `ConnectionStatus`.

---

## 1. Existing error classification behavior

`lib/plaid/errors.ts`'s `parsePlaidError()` is the only error-classification
code in the audited files, and it is purpose-built for a different job than
the one this step needs:

- It extracts Plaid's `error_code` from an Axios-shaped error and maps a
  known subset (11 codes) to a safe, user-facing message, falling back to
  `display_message`, then a generic fallback string.
- Its `status` field is an **HTTP response status for the client**, not a
  health classification — it deliberately *downgrades* a real `401` to a
  generic `500` "Contact support" so server misconfiguration is never
  leaked, which would be the wrong value to persist as connection health.
- It has no concept of "does this mean the credential is dead," "is this
  retryable," or any persisted state at all — it returns a value for one
  HTTP response and is never called outside the three Plaid API routes
  (`exchange-token`, `link-token`, `create-link-token`) it currently guards.

**Conclusion:** `parsePlaidError()` should not be repurposed for health
classification — its `status` semantics conflict with that use. A small,
separate helper is needed (see §8) that reuses its `isAxiosError`/code
extraction shape but returns a `PlaidItemStatus` instead of an HTTP status.

Confirmed via grep: today, the *only* code anywhere that writes
`PlaidItemStatus` or `errorCode` is `exchange-token/route.ts` lines 95–106,
on successful link/relink (`status: ACTIVE, errorCode: null`). No failure
path anywhere writes either field — matches D2 Step 7 item #2's finding
exactly.

---

## 2. Exact failure catch blocks that should write health state

| # | Location | Current behavior | Change |
|---|---|---|---|
| 1 | `lib/plaid/refresh.ts` — `refreshAllActiveItemsForUser()`'s per-item `catch` (~L359–373) | `console.error` + push a result row with `error: e.message` | Classify `e`, write `PlaidItem.status`/`errorCode` for `item.id` |
| 2 | `app/api/plaid/refresh/route.ts` — single-item path `catch` (~L59–62) | `console.error` + `500` response | Same — this path calls `refreshPlaidItem()` directly, bypassing #1's catch entirely |
| 3 | `app/api/plaid/sync/route.ts` — per-item `catch` (~L58–61) | `console.error` + push `ok: false` | Same — calls `syncTransactionsForItem()` directly |
| 4 | `jobs/sync-banks.ts` — per-item `catch` (~L50–53) | `console.error`, increments a `failed` counter | Same — calls `syncTransactionsForItem()` directly |

**Explicitly out of scope — do not touch:**

- `lib/plaid/refresh.ts`'s holdings `catch` (~L228–233). Documented as
  best-effort/non-fatal — an institution with no investment accounts, or a
  transient `investmentsHoldingsGet` hiccup, is not evidence the
  *credential* is broken. Writing health state here would produce false
  positives.
- `lib/plaid/syncTransactions.ts`'s per-transaction `catch` (~L257–259). This
  is a single-row skip inside a loop, not an item-level failure. One bad
  transaction must never mark the whole `PlaidItem` unhealthy.

These four call sites are the same four the Step 7 investigation already
named — confirmed unchanged after a closer read.

---

## 3. Which Plaid errors should map to `NEEDS_REAUTH`

Only codes that mean the credential itself is dead and Plaid Link
re-authentication is the actual fix:

- `ITEM_LOGIN_REQUIRED`
- `INVALID_ACCESS_TOKEN`

Both already have user-facing messages in `errors.ts` that say exactly
this ("reconnect your account"). This matches `PlaidItemStatus`'s own enum
comment ("user must re-authenticate via Plaid Link").

---

## 4. Which errors should map to `ERROR`

Recommend keeping this bucket deliberately narrow — see §7 for why. Only
codes that are genuinely unrecoverable without a code/config fix, or a
truly unrecognized code:

- `INSTITUTION_NO_LONGER_SUPPORTED`
- `INVALID_ENVIRONMENT`
- `SANDBOX_ONLY` (misconfiguration in prod)
- Any Plaid `error_code` not explicitly handled elsewhere

**Recommend explicitly NOT mapping to `ERROR`** (leave `PlaidItem.status`
unchanged, log only): `ITEM_LOCKED`, `INSTITUTION_DOWN`,
`INSTITUTION_NOT_RESPONDING`, `PRODUCT_NOT_READY`, HTTP `429`, and any
non-Axios exception (decrypt failure, missing env var, DB error). Reasoning
in §7 — these are transient or infra-wide, not evidence this specific item's
credential is broken.

---

## 5. Which success paths should reset status to `ACTIVE` and clear `errorCode`

One chokepoint covers nearly every success path: `syncTransactionsForItem()`'s
existing final write (`lib/plaid/syncTransactions.ts` ~L274–277), which
already runs unconditionally after the sync loop completes without
throwing. Extending that single `db.plaidItem.update` to also set
`status: ACTIVE, errorCode: null` covers:

- `jobs/sync-banks.ts`'s job
- `app/api/plaid/sync/route.ts`'s manual sync
- `lib/plaid/refresh.ts`'s step 3 (transactions), which every
  `refreshPlaidItem()` call reaches unconditionally after steps 1–2 (step 2
  is non-fatal, so it never blocks reaching step 3)

No second reset site is needed elsewhere — `refreshPlaidItem()` itself
writes no `PlaidItem`-level fields outside calling into step 3.

---

## 6. Whether `AccountConnection.syncStatus` should be updated in this slice

**Defer.** Confirmed by grep: `AccountConnection.syncStatus` (String,
`@default("pending")`) is never written anywhere in application code today
— not by exchange-token, not by refresh, not by sync — and never read
anywhere either. It is fully dead, defaulted-only. Wiring it up adds scope
(it would require resolving every `FinancialAccount`/`AccountConnection`
linked to a failing `PlaidItem`, a join none of the four catch sites
currently need) for zero existing consumer. Not part of this slice;
candidate for its own later step once a reader exists.

**Related finding worth flagging separately, not folding into this slice:**
`FinancialAccount.syncStatus` (a different field, also String,
`@default("pending")`) already has a live but currently-dead consumer —
`app/api/brief/route.ts` L208 fires a "Sync issue" Needs-Attention card
whenever `syncStatus === "error"`, and nothing ever writes that value today
(confirmed: only `"synced"`, `"manual"`, `"pending"` are ever written, across
`refresh.ts`, `exchange-token/route.ts`, the manual/wallet account routes).
Mirroring `PlaidItem`-level failures onto the linked `FinancialAccount.syncStatus`
would light up that existing UI for free, but it requires a join from
`PlaidItem` → `AccountConnection` → `FinancialAccount` at each of the four
catch sites, which is more surface than "smallest implementation" calls for
here. Recommend treating this as an explicit, separate yes/no decision for a
7A-2/7B follow-up, not blocking this checklist.

---

## 7. Whether any schema change is actually required

**No.** `PlaidItem.status` (`PlaidItemStatus`) and `PlaidItem.errorCode`
(`String?`) already exist and already cover every state this slice needs.
`Connection.status`/`errorCode` also already exist but are explicitly
out of scope — confirmed via schema comments that `Connection` is "not yet
read or written by any application code" anywhere; Plaid sync today runs
exclusively against `PlaidItem`. Touching `Connection` here would be
premature and outside "preserve existing architecture."

**Risk surfaced by this audit, not a schema gap — a query-filter gap:**
every existing read of `PlaidItem` in the four call sites (and the manual
routes' `findFirst`/`findMany` lookups) filters on `status: PlaidItemStatus.ACTIVE`,
including the *single-item* lookups in `app/api/plaid/sync/route.ts` and
`app/api/plaid/refresh/route.ts` (i.e., even asking to retry one specific
`plaidItemId` already excludes it the moment it's not `ACTIVE`). Today this
filter never excludes anything in practice, because nothing has ever written
a non-`ACTIVE`, non-`REVOKED` status. Once this slice ships, any item that
ever moves to `ERROR` has **no existing code path back to `ACTIVE`** other
than a full Plaid Link relink (`exchange-token`) — every scheduled job,
bulk refresh, and even a manual single-item retry will silently skip it
forever. This is exactly why §4 recommends keeping the `ERROR` bucket
narrow and leaving transient codes with no status change at all: a
transient `INSTITUTION_DOWN` blip must not become a permanent lockout
given today's query filters, since retry/backoff and reconnect UI are both
explicitly out of scope for this step. No schema or query change is
proposed to fix this now — flagged as Open Question 1 below for an explicit
go/no-go before implementation.

---

## 8. Smallest implementation checklist

1. Add one small, new exported function to `lib/plaid/errors.ts` —
   e.g. `classifyPlaidErrorForHealth(err: unknown): { status: typeof PlaidItemStatus.NEEDS_REAUTH | typeof PlaidItemStatus.ERROR; errorCode?: string } | null`
   — returning `null` for anything that should leave status unchanged (§4's
   "explicitly NOT" list, and any non-Axios error). Reuses the existing
   `isAxiosError` shape/code extraction; does not modify `parsePlaidError()`.
2. In the 4 catch blocks named in §2: call the new classifier; if non-null,
   `db.plaidItem.update({ where: { id: <itemId> }, data: { status, errorCode: errorCode ?? null } })`.
   Each site already has `item.id`/`plaidItemDbId` in scope — no new lookup
   needed.
3. In `lib/plaid/syncTransactions.ts`'s existing final `db.plaidItem.update`
   (~L274–277): add `status: PlaidItemStatus.ACTIVE, errorCode: null` to the
   existing `data` object. Requires importing `PlaidItemStatus` into that
   file (not currently imported there).
4. No changes to `lib/plaid/refresh.ts`'s holdings catch, no changes to
   `syncTransactions.ts`'s per-transaction catch, no changes to
   `AccountConnection`, no changes to `Connection`, no changes to
   `prisma/schema.prisma`, no changes to any query's `where` filter.

That's the full diff surface: one new function, four call sites gaining a
single conditional write each, one existing write gaining two fields.

---

## 9. Validation plan

- `npx tsc --noEmit` — confirm the new function's types and the four call
  sites compile (no schema change, so `npx prisma generate` /
  `npx prisma migrate dev` are not expected to be needed, but run
  `npx prisma generate` anyway per standing process since the import surface
  touches generated `PlaidItemStatus`).
- `npm run lint`.
- Targeted, against a Plaid **sandbox** item (no production data involved):
  - Force `ITEM_LOGIN_REQUIRED` (Plaid sandbox `/sandbox/item/reset_login`)
    on a linked sandbox item, then trigger each of the 4 call sites in turn
    (manual sync, manual refresh, direct `syncBanks()` call, the
    `refreshAllActiveItemsForUser` path) and confirm `PlaidItem.status`
    becomes `NEEDS_REAUTH` and `errorCode` is set, in each case.
  - Confirm a normal, healthy sandbox item is unaffected (status stays
    `ACTIVE`, `errorCode` stays `null`) through a full successful sync.
  - Relink the forced item via Plaid Link and confirm `exchange-token`'s
    existing reset (`status: ACTIVE, errorCode: null`) still fires
    unchanged.
  - Force an unrecognized/`ERROR`-bucket code and confirm the item then
    drops out of `jobs/sync-banks.ts`'s and the manual routes' result sets
    on the *next* run (this is the §7 lockout risk — verifying it's real,
    not just theorized, before sign-off).
- No UI surface reads `PlaidItem.status` anywhere today (confirmed via
  repo-wide grep — the only non-`lib/plaid`/`app/api/plaid` hit was an
  unrelated `item.status` in `PerspectiveSwitcher.tsx`), so no UI
  regression test is needed for this slice.

---

## 10. Stop point

This document stops here. No item above is approved by virtue of appearing
in this checklist. Two things need an explicit answer before any file in
§8 is touched:

1. **The query-filter lockout (§7).** Accept that any `ERROR`-classified
   item becomes unreachable by every existing sync path until a full
   relink, given reconnect UI and retry/backoff are both explicitly
   deferred? (Recommended: yes, accept it, *because* §4 keeps the `ERROR`
   bucket narrow enough that it should rarely fire — but this is a product
   call, not just an engineering one.)
2. **`FinancialAccount.syncStatus` mirroring (§6).** Bundle the
   already-dead-but-wired Brief "Sync issue" card into this slice, or treat
   it as a separate, later decision? (Recommended: separate — keeps this
   slice's blast radius to one table/one row per failure.)

Recommended next step: confirm both, then approve §8 as the full scope of
Step 7A — nothing beyond those 8 lines of changed behavior.
