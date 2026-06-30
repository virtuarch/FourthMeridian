# D2 Step 7E — Reconnect Flow Checklist

**Investigation/checklist only. No code, schema, or migration changes were
made to produce this document.** Branch: `feature/phase-2-architecture`.
Baseline: `v2.3.0`.

Goal: let a user recover a `PlaidItem` stuck in `NEEDS_REAUTH`, with the
smallest possible change. D2-7A (connection health), D2-7B (manual refresh
cooldown), D2-7C (cron route), and D2-7D (retry/backoff) are complete. This
is item #3 ("Reconnect flows") from
`D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md`, previously flagged there as
size M, ordered 4th, dependent on #2 (7A).

Audited in full: `app/api/plaid/link-token/route.ts`,
`app/api/plaid/exchange-token/route.ts`, `app/api/plaid/create-link-token/route.ts`
(confirmed dead/`@deprecated`), `app/api/plaid/refresh/route.ts`,
`context/PlaidContext.tsx`, `components/dashboard/ConnectAccountButton.tsx`,
`components/plaid/PlaidLinkButton.tsx`, `components/dashboard/RefreshButton.tsx`,
`components/dashboard/AccountCard.tsx`, `app/api/accounts/route.ts`,
`lib/plaid/disconnect.ts`, `lib/plaid/encryption.ts`, the `PlaidItem` model and
`PlaidItemStatus` enum in `prisma/schema.prisma`. Also checked, because they
bound the recommendation: `lib/plaid/errors.ts` (`NEEDS_REAUTH_CODES`,
`classifyPlaidErrorForHealth`), the D2-7A/7B/7C/7D checklists themselves, and
`docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` §9.1/§13 (which already
names "Plaid Link must run in Update Mode" as a named, deferred dependency of
the credential dedup fix). Repo-wide grep confirmed zero non-comment
"reconnect" references in `components/` and zero `PlaidItem`-status
references anywhere under `app/admin/**`.

---

## 1. Does the link-token route already support Plaid update mode?

**No.** `app/api/plaid/link-token/route.ts` is a parameterless `GET` — no
query string, no body — and its `linkTokenCreate()` call never includes an
`access_token` field:

```ts
const response = await plaidClient.linkTokenCreate({
  user:          { client_user_id: user.id },
  client_name:   "Fourth Meridian",
  products,
  country_codes,
  language:      "en",
  ...(redirectUri && { redirect_uri: redirectUri }),
});
```

Every Link session today is a brand-new-Item flow, identical whether the user
is connecting their first bank or trying to fix a broken one.

## 2. If not, what is the smallest change needed?

Three small, additive pieces, no removals:

- **`app/api/plaid/link-token/route.ts`** — accept an optional
  `plaidItemId` (query param, since this is a `GET`). If present: look up
  that `PlaidItem` scoped to `userId` (ownership check, same pattern
  `refresh/route.ts` already uses), decrypt its `encryptedToken` via the
  existing `decrypt()` export from `lib/plaid/encryption.ts` (same call
  `disconnect.ts` already makes), and pass it as `access_token` in
  `linkTokenCreate()`. Per Plaid's API contract, `access_token` and
  `products` are mutually exclusive in update mode — `products` must be
  omitted when `access_token` is present. If absent: behave exactly as
  today (byte-for-byte unchanged code path).
- **`context/PlaidContext.tsx`** — `openLink` needs an optional parameter
  (e.g. `openLink(onDone?, plaidItemId?)`) threaded into the
  `fetch("/api/plaid/link-token")` call as a query string. No change to
  `onSuccess`'s POST to `/api/plaid/exchange-token` — see Q3, that side
  already does the right thing once `item_id` is stable.
- **No change to `exchange-token/route.ts`.** Its existing
  `upsert({ where: { externalItemId: item_id }, update: {...} })` already
  resets `status: ACTIVE, errorCode: null` on the matching row (lines
  95-97 region) — it just needs Plaid to return the *same* `item_id`,
  which update mode guarantees and default mode does not.

This is a single isolated, additive change to one route plus one context
method signature. It does not touch `create-link-token/route.ts` (confirmed
dead code, out of scope) and does not touch the `Connection` model.

## 3. Does exchange-token already reset status/errorCode on relink?

**Yes, conditionally — and that condition is exactly what's missing today.**
The upsert keys on `externalItemId` (Plaid's `item_id`):

```ts
const plaidItem = await db.plaidItem.upsert({
  where:  { externalItemId: item_id },
  update: { encryptedToken, status: PlaidItemStatus.ACTIVE, errorCode: null },
  create: { userId, externalItemId: item_id, institutionId, institutionName,
            encryptedToken, status: PlaidItemStatus.ACTIVE },
});
```

If the same `item_id` comes back, this correctly heals the row. Without
update mode, a from-scratch relink returns a **new** `item_id`, so this
upsert hits the `create` branch instead — leaving the original
`NEEDS_REAUTH` row orphaned forever and creating a second `PlaidItem` for
the same institution. This is the exact "no code path back to ACTIVE" risk
7A's own checklist flagged (§7), now confirmed at the second code site too:
`refresh/route.ts`'s `findFirst`/`findMany` both filter
`status: PlaidItemStatus.ACTIVE`, so a `NEEDS_REAUTH` item is already
invisible to manual refresh as well — relink (done correctly, via update
mode) is the *only* way back.

## 4. Where should the user-facing NEEDS_REAUTH surface appear first?

**The Accounts/Banking page, on the affected account(s), not a new page.**
Confirmed today: `app/api/accounts/route.ts` returns only `FinancialAccount`
fields (`id, name, type, institution, balance, currency, lastUpdated, mask`)
— no `PlaidItem` join, no status, anywhere a client can see it.
`components/dashboard/AccountCard.tsx` renders institution/name/balance/
"Updated {date}" with no badge slot. Zero UI or API surface exposes
`PlaidItem.status` anywhere in the app today. The accounts list is the
correct first surface because it's where a user already looks when a
balance looks stale — the same moment `errorCode`/`NEEDS_REAUTH` exists to
explain. A dedicated Connections/Settings page or admin diagnostics view is
explicitly out of scope per the prompt's constraints.

## 5. Should this be UI now, API only, or both?

**Both, but asymmetric in size: a small API addition, a minimal UI
affordance.** API-only would leave `NEEDS_REAUTH` exactly as undiscoverable
as it is today — the 7A checklist already flagged that the only existing
detection mechanism is a user noticing stale balances themselves. UI-only is
impossible without first exposing the status somewhere. Smallest combined
slice:

- **API:** `app/api/accounts/route.ts` needs to expose enough to render a
  badge — the simplest addition is joining through the existing
  `AccountConnection` → `PlaidItem` relation to add a `needsReauth: boolean`
  (or `plaidStatus`) field per account, plus the `plaidItemId` so the
  reconnect button knows what to pass to update-mode link-token. This is a
  read-only addition to an existing query, not a new endpoint.
- **UI:** one badge/button on `AccountCard.tsx` (or wherever per-account
  actions render), shown only when `needsReauth` is true, calling the same
  `openLink()` from `PlaidContext.tsx` with the item's id. No new page, no
  redesign — an additive affordance on an existing component.

## 6. Which route/component currently owns manual refresh/connect actions?

Fully mapped, no other candidates exist:

- **Refresh:** `components/dashboard/RefreshButton.tsx` and
  `Sidebar.tsx`'s `SidebarRefreshButton()` — both global, account-agnostic,
  POST to `/api/plaid/refresh` with no body (refreshes every `ACTIVE` item
  for the user). Neither can reach a `NEEDS_REAUTH` item today (see Q3).
- **Connect:** `components/dashboard/ConnectAccountButton.tsx` and
  `components/plaid/PlaidLinkButton.tsx` — both call `openLink()` from
  `context/PlaidContext.tsx` with no item-specific context. `PlaidContext.tsx`
  is the single chokepoint for all Plaid Link sessions app-wide; it's the
  one place a `plaidItemId` parameter needs to be threaded through (Q2).

## 7. What exact files would change?

- **`app/api/plaid/link-token/route.ts`** — accept optional `plaidItemId`
  query param; on present, look up + decrypt + pass as `access_token`;
  omit `products` in that branch. Default path unchanged.
- **`context/PlaidContext.tsx`** — `openLink` gains an optional
  `plaidItemId` parameter, forwarded as a query string to the link-token
  fetch. No change to `onSuccess`/exchange-token call.
- **`app/api/accounts/route.ts`** — extend the existing query to also
  return `needsReauth`/`plaidItemId` per account via the
  `AccountConnection` → `PlaidItem` relation already in the schema. Read-only
  addition, no new endpoint, no write path touched.
- **`components/dashboard/AccountCard.tsx`** (or the nearest per-account
  action slot) — conditionally render a "Reconnect" badge/button calling
  `openLink(onDone, plaidItemId)` when `needsReauth` is true.
- **No change** to `prisma/schema.prisma` (see Q below — all needed fields
  already exist), `exchange-token/route.ts`, `refresh/route.ts`,
  `lib/plaid/refresh.ts`, `lib/plaid/syncTransactions.ts`,
  `lib/plaid/retry.ts`, `lib/plaid/refreshCooldown.ts`, `jobs/*`,
  `vercel.json`, `create-link-token/route.ts`, `Connection`, or
  `AccountConnection`'s write paths.

## 8. What should stay deferred to diagnostics/admin views?

- Any aggregate/cross-user view of `NEEDS_REAUTH`/`ERROR` items (admin
  dashboard, ops alerting) — `app/admin/**` has zero `PlaidItem` references
  today and none are added here.
- Surfacing `errorCode` detail, retry history, or last-attempt timestamps to
  the end user — the badge only needs a boolean, not a diagnostics payload.
- A dedicated Connections/Settings management page listing all institutions
  — useful eventually, explicitly named out of scope ("no broad UI
  redesign," "no diagnostics dashboard").
- Cleaning up the orphaned second-`PlaidItem` rows that *already* exist from
  past from-scratch relinks (pre-dating this fix) — that's a one-time data
  cleanup/backfill question, separate from shipping the forward-looking fix,
  and is exactly the kind of "concrete blocker surfaced by implementation"
  the project rules say to flag rather than quietly fold in.
- Any change to which queries filter on `status: ACTIVE` (e.g.
  `refresh/route.ts`) — that filter is a deliberate existing lockout
  mechanism for the *old* (no-update-mode) world; whether it should change
  once reconnect works is a separate, explicit decision, not implied by this
  slice.

## 9. Schema check

**No schema change required.** `PlaidItem` already has every field this
flow needs: `status`, `errorCode`, `encryptedToken` (decryptable via the
existing `decrypt()` export), `externalItemId`. `PlaidItemStatus` already
has `NEEDS_REAUTH` as a value. The proposed `accounts/route.ts` addition is
a read via the existing `AccountConnection` → `PlaidItem` relation, not a new
column or table.

---

## Recommendation

Ship update-mode support as the foundation (Q2's three files), then the
minimal read-only API exposure, then the single-badge UI affordance — in
that order, as one slice, not three separate branches, since the UI piece is
inert without the API piece and the API piece is pointless without update
mode actually fixing the underlying `item_id` stability problem. This is the
smallest change that converts `NEEDS_REAUTH` from a structurally
unrecoverable state (per 7A's flagged risk, now confirmed at two code sites)
into one with exactly one, narrow, working recovery path — without touching
retry/backoff, the scheduler, diagnostics, or any unrelated UI.

## Minimal implementation slices (not yet approved)

1. **`app/api/plaid/link-token/route.ts`** — optional `plaidItemId` query
   param → ownership-checked lookup → `decrypt()` → `access_token` in
   `linkTokenCreate()`, omitting `products` on that branch. Default path
   byte-for-byte unchanged.
2. **`context/PlaidContext.tsx`** — `openLink(onDone?, plaidItemId?)`,
   forwarded as a query string. No change to the exchange-token POST.
3. **`app/api/accounts/route.ts`** — add `needsReauth`/`plaidItemId` to the
   existing per-account response via the existing `AccountConnection` →
   `PlaidItem` relation. Read-only.
4. **`components/dashboard/AccountCard.tsx`** — conditional reconnect
   badge/button, wired to `openLink(onDone, plaidItemId)`.
5. **No changes** to `exchange-token/route.ts`, `refresh/route.ts`,
   `prisma/schema.prisma`, retry/backoff, scheduler/cron, `Connection`, or
   any other UI.

## Risks

1. **Pre-existing orphaned `PlaidItem` rows.** Any institution that was
   already relinked from scratch (pre-dating update mode) has a stuck
   `NEEDS_REAUTH` row plus a separate active row for the same institution.
   This fix prevents new orphans; it does not retroactively heal existing
   ones. Flag for a separate, explicit cleanup decision.
2. **Plaid update-mode API contract.** `access_token` and `products` are
   mutually exclusive in `linkTokenCreate()` — getting this wrong fails the
   call outright (loud, not silent), but it's a real implementation detail
   to get right, not just "add a field."
3. **Ownership check is required, not optional.** The `plaidItemId` lookup
   in `link-token/route.ts` must scope to the requesting `userId` (mirroring
   `refresh/route.ts`'s existing `findFirst({ where: { id, userId } })`
   pattern) — otherwise a user could request an update-mode token for
   another user's item id.
4. **`AccountConnection` → `PlaidItem` join shape.** `accounts/route.ts`
   today queries `FinancialAccount` directly; adding the join needs to
   handle accounts with zero or multiple connections without changing the
   route's existing response shape for unaffected fields. Worth a quick
   re-read of the exact `AccountConnection` schema fields before writing
   the query, to confirm there's no N+1 or multiplicity surprise.
5. **Badge visibility scope.** If a `FinancialAccount` is shared into a
   Space via `WorkspaceAccountShare`/`dualWriteSpaceAccountLink`, confirm
   the reconnect badge only renders for the account's owner (the person who
   can actually run Plaid Link for it), not every Space member who can see
   the balance.

## Validation plan

- `npx tsc --noEmit`, `npm run lint`. `npx prisma generate` per standing
  process (no schema touched, expect no diff); `npx prisma migrate dev` not
  needed.
- Targeted, sandbox item, no production data:
  - Force `ITEM_LOGIN_REQUIRED` via Plaid's `/sandbox/item/reset_login` on a
    test item → confirm `status` becomes `NEEDS_REAUTH` (existing 7A
    behavior) and the new badge appears on its account card.
  - Click the reconnect badge → confirm `link-token` is requested with that
    item's id, Plaid Link opens in update mode (Plaid's sandbox UI visibly
    differs in update mode — streamlined, no institution search) → complete
    relink → confirm `exchange-token` receives the **same** `item_id` as
    before, the existing row's `status` flips back to `ACTIVE`,
    `errorCode` clears, and no second `PlaidItem` row is created.
  - Confirm a normal "connect a new bank" flow (no `plaidItemId`) is
    completely unaffected — same UX, same request shape as today.
  - Confirm `/api/plaid/refresh` can now successfully refresh the
    just-healed item (proves the `status: ACTIVE` filter lockout is
    resolved for this item going forward).
  - Confirm the reconnect badge does **not** render for a Space member
    viewing a shared account they don't own (Risk #5).

## Stop point

This document stops here. No item above is approved by virtue of appearing
in this checklist. No code, schema, migration, route, or UI file has been
touched to produce it.
