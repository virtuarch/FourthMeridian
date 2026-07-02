> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 7B — Manual Refresh Cooldown Checklist

**Investigation/checklist only. No code, schema, or migration changes were
made to produce this document.** Branch: `feature/phase-2-architecture`.
Baseline: `v2.3.0`.

Goal: stop manual-refresh/sync spam from burning Plaid API calls, with a
1-hour cooldown scoped to the unit of work (`PlaidItem`), without touching
the scheduler or any shared sync internals.

Audited in full: `app/api/plaid/refresh/route.ts`, `app/api/plaid/sync/route.ts`,
`lib/plaid/refresh.ts`, `lib/plaid/syncTransactions.ts`, `jobs/sync-banks.ts`,
`jobs/scheduler.ts`, the `PlaidItem` section of `prisma/schema.prisma`,
`lib/api.ts`, `lib/audit-actions.ts`, and a repo-wide grep for every caller of
`refreshAllActiveItemsForUser`/`refreshPlaidItem`/`syncTransactionsForItem`
(confirmed: only the two manual routes, `exchange-token/route.ts`'s initial
sync, and `jobs/sync-banks.ts` call into this pipeline anywhere).

**Scope note:** this slice isn't one of the eight areas named in
`D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md` (lifecycle, health,
reconnect, orphan cleanup, sync reliability, retry/backoff, diagnostics,
hardening) or resolved by D2-7A (connection health). It's a new, separately
scoped slice that happens to follow 7A numerically — flagging this so it
isn't mistaken for part of the original eight-area review.

---

## 1. Does `PlaidItem` already have a suitable field?

**No.** `PlaidItem.lastSyncedAt` exists but is not a "last manual trigger"
timestamp — it's written by one chokepoint, `syncTransactionsForItem()`'s
final `db.plaidItem.update` (`lib/plaid/syncTransactions.ts` ~L274-277), which
is reached by **all three** call paths: manual refresh
(`refreshPlaidItem()` → step 3), manual sync (`/api/plaid/sync` directly),
and the scheduled job (`jobs/sync-banks.ts` directly). Gating on
`lastSyncedAt` would mean a scheduled 4-hour sync silently arms a cooldown
the user never triggered — the opposite of "scheduled refresh should not be
blocked by manual refresh cooldown," and a real bug if the *check* side ever
reused this field even though the *block* is only meant for manual calls.
No other timestamp on `PlaidItem` exists.

## 2. Is a schema change justified?

**Yes — one nullable field.** Recommend `PlaidItem.lastManualRefreshAt
DateTime?`. It's the only option that satisfies "per `PlaidItem`, not user,
not `AccountConnection`" directly, it's additive (defaults to `null` on every
existing row, meaning "never on cooldown" — the safe default), and it needs
no backfill or data migration.

Two alternatives considered and rejected:

- **Derive from `AuditLog`** (`PLAID_REFRESH`/`PLAID_SYNC` actions already
  logged). Rejected: `AuditLog` is indexed on `userId`, `spaceId`, and
  `action+createdAt` — not `plaidItemId`. The per-item id isn't even in the
  metadata today (`metadata` stores aggregate counts, not which item). Using
  it would mean an unindexed JSON scan plus widening what's logged, and
  overloads audit semantics with rate-limiting.
- **In-memory/process cache.** Rejected: the app deploys serverless
  (`vercel.json`), so an in-process map wouldn't be shared across function
  instances and couldn't actually enforce a 1-hour window.

## 3. Should cooldown apply to `/api/plaid/refresh`, `/api/plaid/sync`, or both?

**Both, sharing one timestamp per `PlaidItem`.** Both routes are manual,
user-triggered, and both call live Plaid endpoints per item (refresh:
`accountsGet` + `investmentsHoldingsGet` + `transactions/sync`; sync:
`transactions/sync` only). Refresh's pipeline already *includes* sync's work
(step 3 calls `syncTransactionsForItem` directly) — gating only one route
would leave the other as an uncapped path to the same Plaid load. `/sync` has
no UI button wired yet (per its own docstring) but is already a reachable,
unauthenticated-by-route-not-by-session endpoint, so it's in scope now rather
than left as a bypass.

## 4. Where should the cooldown check live?

**In the two route handlers only**, via a new small shared helper —
recommend `lib/plaid/refreshCooldown.ts`, exporting a pure
`checkManualRefreshCooldown(lastManualRefreshAt: Date | null)` (no DB call —
operates on a field the route already fetched) and a
`markManualRefreshed(plaidItemId: string)` write helper.

Explicitly **not** inside `refreshPlaidItem()`, `syncTransactionsForItem()`,
or `jobs/sync-banks.ts`. Confirmed via the caller grep above that
`syncTransactionsForItem` is shared by all three trigger types — putting the
gate there would block the scheduled job by construction. Keeping the check
only in the two manual route files makes "scheduled sync ignores this
cooldown" true structurally, not by a conditional flag that could rot later.

## 5. Where should the timestamp be updated?

Same two route handlers, per item, **before or alongside the Plaid call —
on every attempt, not success-only** (flagged below for explicit sign-off).
Rationale: a failing item (e.g. mid-`ITEM_LOGIN_REQUIRED`) still costs a
Plaid call when retried; success-only marking would let a broken item be
manually retried every few seconds with zero cooldown protection, which is
exactly the spam case this slice exists to stop.

## 6. What response shape should be returned on cooldown?

- **Single named item** (`body.plaidItemId` given, both routes): short-circuit
  before calling Plaid, return `429` with
  `{ error: "cooldown", retryAfterSeconds: N }` — same `{ error }` shape both
  routes already use for their `404`s, plus one numeric field.
- **"All active items" path** (no `plaidItemId`, both routes): never fail the
  whole request. Match the existing per-item partial-failure convention
  (`RefreshItemResult` / sync's `results` array) — items on cooldown get a
  result entry (e.g. `{ plaidItemId, institution, ok: false, skipped:
  "cooldown", retryAfterSeconds: N }`) and are excluded from the Plaid call
  entirely; the response stays `200` with mixed outcomes, consistent with
  "one item's failure does not block the others."

## 7. How to ensure scheduled sync ignores this cooldown

By construction per §4 — `lastManualRefreshAt` and the new helper are only
ever read/written inside `app/api/plaid/refresh/route.ts` and
`app/api/plaid/sync/route.ts` (and the new helper file itself).
`jobs/sync-banks.ts`, `jobs/scheduler.ts`, and `syncTransactionsForItem()`
gain zero new code. Validation: post-implementation grep for
`lastManualRefreshAt` / `refreshCooldown` should return zero hits outside
those three files; `jobs/sync-banks.ts`'s diff should be empty.

## 8. Smallest implementation checklist (not yet approved)

1. **Schema** — add `lastManualRefreshAt DateTime?` to `PlaidItem` in
   `prisma/schema.prisma`. Additive, nullable, no other field touched.
2. **Migration** — `npx prisma migrate dev --name plaid_item_last_manual_refresh_at`.
3. **New file** `lib/plaid/refreshCooldown.ts` — one constant
   (`MANUAL_REFRESH_COOLDOWN_MS = 60 * 60 * 1000`), one pure check function,
   one DB write helper (`markManualRefreshed`). No imports from
   `refresh.ts`/`syncTransactions.ts`.
4. **`app/api/plaid/refresh/route.ts`**:
   - Single-item path: add `lastManualRefreshAt` to the existing `findFirst`
     `select`; check cooldown before calling `refreshPlaidItem`; mark on
     every attempt.
   - All-items path: needs `refreshAllActiveItemsForUser` to skip on-cooldown
     items. This is the one place the diff isn't fully contained to the route
     file — see open question 3 below for the two ways to do this.
5. **`app/api/plaid/sync/route.ts`**: same shape — add the field to the
   existing `findMany` select, filter on-cooldown items out of the loop
   before calling `syncTransactionsForItem`, mark attempted items (can be a
   single `updateMany` over the eligible id list rather than N writes).
6. **No changes** to `lib/plaid/syncTransactions.ts`, `refreshPlaidItem()`
   itself, `jobs/sync-banks.ts`, `jobs/scheduler.ts`, `Connection`, or
   `AccountConnection`.

## 9. Validation plan

- `npx prisma generate`, `npx prisma migrate dev` (schema changed — both
  required this time, not just standing process).
- `npx tsc --noEmit`, `npm run lint`.
- Targeted, sandbox item, no production data:
  - Call `/api/plaid/refresh` (single item) twice back-to-back → second call
    returns `429` with `retryAfterSeconds` near 3600; backdate
    `lastManualRefreshAt` past 1 hour directly in the DB → third call
    succeeds.
  - Same sequence for `/api/plaid/sync`.
  - Bulk call (no `plaidItemId`) with two items, one recently
    manually-refreshed, one not → response shows one normal result and one
    `skipped: "cooldown"` result; confirm via log/sandbox call count that
    Plaid was called for only one item.
  - Call `syncBanks()` directly right after setting `lastManualRefreshAt` to
    "now" on an item → confirm it still calls Plaid and updates
    `lastSyncedAt` — proves the scheduled path is unaffected.
  - Post-implementation grep confirms `lastManualRefreshAt`/the new helper
    appear only in the two route files (+ the new lib file).

---

## Open questions — need explicit sign-off before any file is touched

1. **Mark-on-every-attempt vs. success-only** (§5). Recommended: every
   attempt, including failures.
2. **One shared cooldown timestamp for both routes vs. two separate fields**
   (§3). Recommended: one shared field — refresh's pipeline already includes
   sync's work, so separate timestamps would let one route bypass the other's
   cooldown.
3. **All-items cooldown filtering mechanism** (§8, item 4). Two options:
   - **3a (recommended).** Add one optional parameter to
     `refreshAllActiveItemsForUser(userId, { excludeItemIds? })`, defaulting
     to no exclusion. Confirmed via grep this function has exactly one caller
     today (this route), so the change is isolated; smaller diff, no
     duplicated loop/aggregation logic.
   - **3b.** Leave `lib/plaid/refresh.ts` completely untouched; have the route
     re-implement the active-items loop itself for the no-`plaidItemId` case.
     Zero changes outside the route file, at the cost of duplicating ~15
     lines of existing loop/aggregation logic.
4. **Should a cooldown-skip write an `AuditLog` row?** Recommended: no —
   nothing happened against Plaid or the user's data, so logging it as
   `PLAID_REFRESH`/`PLAID_SYNC` would misrepresent what occurred.

Recommended next step: confirm questions 1–4 (in particular 3, since it's the
only item that touches a shared lib function), then approve §8 as the full
scope of Step 7B.
