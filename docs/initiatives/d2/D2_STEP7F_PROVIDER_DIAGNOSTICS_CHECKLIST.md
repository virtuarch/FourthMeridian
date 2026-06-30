# D2 Step 7F — Provider Diagnostics Checklist

**Investigation/checklist only. No code, schema, or migration changes were
made to produce this document.** Branch: `feature/phase-2-architecture`.
Baseline: `v2.3.0`.

Goal: define the smallest read-only diagnostics surface for provider
health. This is item #7 ("Provider diagnostics") from
`D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md`, sized S, ordered 5th,
dependent on #2 (7A — connection health). D2-7A/7B/7C/7D/7E are all
complete (`19456ff`, `1879dab`, `444cb6c`, `ad4415d`, `8e67be2`), so the
dependency is satisfied: `PlaidItem.status`/`errorCode` are now actually
written on failure, not just schema that exists unused.

Audited: `app/admin/layout.tsx`, `app/admin/page.tsx`,
`app/admin/users/page.tsx`, `app/admin/spaces/page.tsx`,
`app/admin/audit/page.tsx`, `components/admin/AdminNav.tsx`,
`app/api/admin/overview/route.ts`, `app/api/admin/users/route.ts`,
`app/api/admin/spaces/route.ts`, `app/api/admin/audit/route.ts`,
`app/api/jobs/sync-banks/route.ts`, `jobs/sync-banks.ts`,
`lib/plaid/errors.ts`, `lib/plaid/refresh.ts`, `lib/session.ts`
(`requireSystemAdmin`/`requireFreshSystemAdmin`), and the `PlaidItem`,
`AccountConnection`, `Connection`, `FinancialAccount`, and `User` models in
`prisma/schema.prisma`. Repo-wide grep confirmed zero `PlaidItem`/
`Connection`-status references anywhere under `app/admin/**` today (same
finding 7E's audit made independently).

---

## 1. Should this be an admin page, an admin API route, or both?

**Page is required; route should be deferred.** The four existing
non-Overview admin pages (`users`, `spaces`, `audit`) are all `"use
client"` and fetch from a paired API route, because they need client-side
search/filter/pagination. The Overview page (`app/admin/page.tsx`) is the
one exception: a plain server component that queries the DB directly, no
`"use client"`, no paired route in actual use. Checked: `/api/admin/overview`
has zero non-doc, non-self references anywhere in the app — its route file
exists but nothing calls it. It's an orphaned twin of the page, not a
load-bearing pattern.

Provider diagnostics fits the Overview shape, not the searchable-table
shape: a small, slow-changing list (one row per `PlaidItem`) with no
filter requirement in the prompt's own spec. Smallest slice is a single
server component at `app/admin/providers/page.tsx`, querying
`db.plaidItem.findMany()` directly, styled like Overview's existing tables
(reuse its pill-badge convention). An API route is not required for the
page to work and should be deferred — add it later only if a real second
consumer shows up (an ops/alerting script, a CLI health check), per the
same "don't build speculative surface" reasoning 7E applied to its own
scope cuts.

## 2. What fields should be shown?

Per `PlaidItem` (`prisma/schema.prisma` L489-513), all already populated by
7A-7D's write paths:

- `institutionName` — human-readable, primary row label.
- `status` (`ACTIVE` / `NEEDS_REAUTH` / `ERROR` / `REVOKED`) — the actual
  signal this view exists for.
- `errorCode` — last Plaid `error_code` (e.g. `ITEM_LOGIN_REQUIRED`); a
  category string, not a secret (see Q6).
- `lastSyncedAt` — last successful scheduled/manual sync.
- `lastManualRefreshAt` — last user-triggered "Refresh" click (D2-7B field;
  distinct signal from `lastSyncedAt`, worth its own column since a stale
  `lastSyncedAt` next to a recent `lastManualRefreshAt` tells a different
  story than both being stale).
- `createdAt` — connection age.
- `externalItemId` — Plaid's own `item_id`. Not secret (it's an opaque
  identifier, not a credential); worth including because it's exactly what
  Plaid support/dashboard lookups key on.
- Linked account count and owner — see Q4/Q5.

Leave out: `cursor` (opaque sync-internal value, no human-diagnostic
meaning) and `id` (internal cuid, no diagnostic value over
`externalItemId`).

## 3. What auth/admin guard already exists?

Two layers, both directly reusable, no new pattern needed:

- **Page-level:** `app/admin/layout.tsx` already wraps every `/admin/*`
  route — `getServerSession(authOptions)`, redirect to `/dashboard` if
  `!session || session.user.role !== "SYSTEM_ADMIN"`. Every existing admin
  page (`page.tsx`, `users`, `spaces`, `audit`, `security`) repeats the
  identical check itself even though the layout already guards it — that
  redundant-but-consistent convention should carry forward unchanged for
  the new page rather than being "optimized away."
- **Route-level (if/when the deferred API route is built):**
  `lib/session.ts`'s `requireSystemAdmin()` — tuple return
  `[user, null] | [null, NextResponse]`, exactly the pattern
  `app/api/admin/overview/route.ts` already uses (`const [, err] = await
  requireSystemAdmin(); if (err) return err;`).

## 4. Should it include user email?

**Yes.** Every existing admin surface (`overview`, `users`, `audit`)
already exposes user email/username/name to `SYSTEM_ADMIN` sessions — same
trust boundary, no new exposure category. Without it, an admin seeing a
`NEEDS_REAUTH` row has no way to know whose connection it is or who to
follow up with. Resolve via `PlaidItem.user` → `{ email, username, name }`,
the same shape `overview`'s `users` array already returns.

## 5. Should it include linked account count?

**Yes, and it must count the right relation.** `PlaidItem` has two
relations to choose from: `accounts Account[]` (legacy relation, comment
marks it explicitly `// legacy relation`) and `connections
AccountConnection[]` (comment: `// new relation`). D11's own direction
(migrate `Holding` off legacy `Account` onto `FinancialAccount`) confirms
`Account` is the model being phased out — counting through it here would
both double-count against the modern path and quietly resurrect a
dependency on a table this branch's own architecture is moving away from.
Count via `connections` (`AccountConnection` rows where
`plaidItemDbId = item.id`), exposed as a single integer per row.

## 6. Should it expose secrets? Answer should be no.

**No, and the audit didn't find anything that would leak one by accident.**
Excluded by the field list in Q2: `encryptedToken` (AES-256-GCM ciphertext
— no diagnostic value, only risk, in showing it at all) and `cursor`
(not secret, just useless here). `errorCode` is safe — it's a closed-set
category string (`ITEM_LOGIN_REQUIRED`, `INVALID_ACCESS_TOKEN`, etc.) that
`lib/plaid/errors.ts` itself treats as safe for server-side
logging/classification, never the raw `error_message`/`display_message`
body, which is the only field Plaid's own error shape ever marks as
potentially sensitive. No other secret-bearing field (`User.passwordHash`,
`User.totpSecret`, `User.passwordResetToken`) is anywhere near the
`PlaidItem`/`AccountConnection` join this view needs.

## 7. Smallest implementation checklist (not yet approved)

1. **`app/admin/providers/page.tsx`** (new) — server component, no `"use
   client"`. Guard: identical `getServerSession`/redirect block copied from
   `app/admin/page.tsx`. Query: single `db.plaidItem.findMany()` with
   `select` limited to the Q2 field list, `user: { select: { email,
   username, name } }`, and `_count: { select: { connections: true } }`.
   Render as a static table reusing the existing pill-badge pattern
   (`ROLE_PILL`/`WS_TYPE_PILL` constants in `app/admin/page.tsx`) for the
   `status` column — red for `ERROR`/`NEEDS_REAUTH`, neutral for `ACTIVE`,
   gray for `REVOKED`.
2. **`components/admin/AdminNav.tsx`** — add one entry to the shared `NAV`
   array (`{ label: "Providers", href: "/admin/providers", icon: <pick an
   unused lucide icon, e.g. Plug> }`). One array edit covers both the
   desktop and mobile nav, since both branches already read from the same
   `NAV` constant.
3. **No other file changes.** No schema edit (every field already exists
   and is already written by 7A-7D), no new route (deferred per Q1), no
   change to `jobs/sync-banks.ts`, `lib/plaid/*`, or any non-admin UI.

## 8. Validation plan

- `npx prisma generate` (no schema touched — expect no diff; this is a
  process formality, not an expected change).
- `npx tsc --noEmit`, `npm run lint`.
- Manual, as a `SYSTEM_ADMIN` session: visit `/admin/providers`, confirm
  every existing `PlaidItem` row renders with the correct status pill;
  force one sandbox item into `NEEDS_REAUTH` (same `/sandbox/item/
  reset_login` approach 7E's own validation plan used) and confirm it
  appears and is visually distinct.
- Confirm a non-`SYSTEM_ADMIN` session hitting `/admin/providers` directly
  is redirected to `/dashboard` by the existing layout guard (no new
  behavior to test, but worth confirming the new route inherits it).
- Inspect the rendered page source / server response for the string
  `encryptedToken` and confirm it does not appear anywhere — this is the
  one regression that would matter if the `select` clause is later widened
  carelessly.
- Cross-check the linked-account count against a manual
  `AccountConnection` count query for two or three sample `PlaidItem`s, to
  confirm the `connections` (not `accounts`) relation is what's wired up.

---

## Risks

1. **`syncStatus` is not a reliable failure signal — don't be tempted to
   add it later as a shortcut.** Both `AccountConnection.syncStatus` and
   `FinancialAccount.syncStatus` exist, but a repo-wide grep confirms they
   are only ever written to `"synced"`, `"pending"`, or `"manual"` — never
   `"error"` — by any Plaid code path, including the 7A/7C/7D failure
   catches in `refresh.ts`/`sync-banks.ts`, which write only to
   `PlaidItem.status`/`errorCode`. A future contributor adding a
   `syncStatus` column to this view would silently under-report failures.
   `PlaidItem.status`/`errorCode` must stay the sole health source for this
   page.
2. **`REVOKED` items.** Showing them by default is consistent with how
   `users`/`spaces`/`audit` show full history rather than filtering, but
   it's a one-line `where` clause either way — flag for whoever approves
   this to confirm, rather than deciding silently.
3. **`Connection` (D2/D13 provider-agnostic model) is out of scope here.**
   It exists in schema but is confirmed still unpopulated/unread by any
   application code (per `D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md`
   and this audit's own grep) — nothing to show yet. This page should be
   built so it's extendable later, not so it tries to cover `Connection`
   now.
4. **No pagination.** Fine at today's scale (small `PlaidItem` count per
   the parent investigation's own characterization); worth a follow-up
   note, not a blocker, if/when account volume grows.

## Stop point

This document stops here. No item above is approved by virtue of appearing
in this checklist. No code, schema, migration, route, or UI file has been
touched to produce it.
