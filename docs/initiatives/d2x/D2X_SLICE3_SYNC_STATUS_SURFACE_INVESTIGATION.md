# D2.x — Slice 3: Sync Status Surface — Investigation + Checklist

**Status:** Investigation complete. Implementation NOT started — awaiting approval of the checklist in §11.
**Goal:** Smallest status surface so a first-run user understands their financial profile is still being built after the fast connect, with no schema, no queue, no SyncJob — inferring everything from existing `PlaidItem` state.
**Builds on:** Slice 1 (fast-path split) + Slice 2 (background history via `after()`), both shipped.

---

## 1. Current state (evidence)

### 1.1 `PlaidItem` fields available (`prisma/schema.prisma`)
`status` (`ACTIVE | NEEDS_REAUTH | ERROR | REVOKED`), `cursor` (`String?`), `lastSyncedAt` (`DateTime?`), `errorCode` (`String?`), `institutionName`, `institutionId`, `id`, `createdAt`, `updatedAt`, `lastManualRefreshAt`, `investmentsConsent`. No progress/percentage field exists.

### 1.2 The key signal — `cursor IS NULL` means "first-run history still importing"
`syncTransactionsForItem` (`lib/plaid/syncTransactions.ts`) persists `next_cursor` (and `lastSyncedAt`, `status=ACTIVE`, `errorCode=null`) **only after the full `has_more` loop completes**. Because Slice 1 defers the inline sync, a newly connected item reaches the fast response with **`cursor = null` and `lastSyncedAt = null`**. It stays that way until Slice 2's background sync finishes and writes the cursor.

Therefore, with zero schema:
- **importing** ⇔ `status = ACTIVE` and `cursor = null`
- **ready** ⇔ `status = ACTIVE` and `cursor ≠ null`
- **needs_reauth** ⇔ `status = NEEDS_REAUTH`
- **error** ⇔ `status = ERROR`
- **revoked** ⇔ `status = REVOKED` (excluded from the surface)

This cleanly isolates genuine first-run items: any item ever synced (initial, cron, manual, or relink-in-update-mode, which preserves the cursor) has a non-null cursor and never shows as "importing". A returning user connecting a *new* institution correctly shows only the new item importing.

### 1.3 Progress estimation (Q2)
**Only binary "Importing / Ready" is honestly available.** Plaid's `/transactions/sync` does not report a total up front, and the engine persists no intermediate progress (cursor is written once, at the end) — and we may not change the engine. A rough *live* count ("N transactions so far") is technically possible by counting `Transaction` rows for the item's accounts mid-import, but it requires a join and is jittery; deferred as an optional later enhancement, **not** in this slice.

### 1.4 Existing surfaces we reuse / avoid disturbing
- `GET /api/brief` (`app/api/brief/route.ts`) already routes everything through `buildContext()` and must stay pure — the banner will **not** be added to its payload.
- Per-account **reconnect** UX already exists: `getAccounts` derives `needsReauth`/`plaidItemId` from `plaidItem.status` (`lib/data/accounts.ts`), and `AccountCard` renders `ReconnectAccountButton` when `NEEDS_REAUTH`. Slice 3 defers `needs_reauth` handling to this existing surface rather than reinventing it.
- No existing endpoint exposes item-level sync state to the client; a small read endpoint is the gap.

---

## 2. Recommended architecture

A tiny, **provider-agnostic read endpoint** plus a **self-polling client banner**, both additive:

1. `GET /api/sync/status` — reads the caller's `PlaidItem` rows, derives a normalized per-connection `state`, returns `{ building, connections[] }`. Provider-agnostic envelope (each connection carries `provider`), populated with `PLAID` only today; the same endpoint is the read half of a future Sync Center (Q6).
2. `SyncStatusBanner` — a small client component that fetches the endpoint, shows **"Building your financial profile…"** while `building` is true, polls until it clears, then unmounts its message. Mounted on the Daily Brief and Accounts pages.

No coupling to the connect moment (no `PlaidContext` change): the banner reads server truth on page load, so it works equally on reload and "return later". The brief route, `getAccounts`, the engine, and the cron are all untouched.

Why not extend `/api/brief` or `getAccounts`: both are server-rendered once per load; sync status needs to *poll*. Keeping it a separate endpoint + client component avoids re-running context assembly / account queries on every poll and keeps those hot paths pure.

---

## 3. Endpoint design (Q3)

```
GET /api/sync/status          (auth: requireUser)

200 →
{
  "building": boolean,                       // true iff any connection.state === "importing"
  "connections": [
    {
      "id":            string,               // PlaidItem.id (opaque connection id)
      "provider":      "PLAID",              // future: "WALLET" | "CSV" | ...
      "institution":   string,               // PlaidItem.institutionName
      "state":         "importing" | "ready" | "needs_reauth" | "error",
      "lastSyncedAt":  string | null,        // ISO
      "errorCode":     string | null
    }
  ]
}
```

- **Query:** `db.plaidItem.findMany({ where: { userId: user.id, status: { not: REVOKED } }, select: { id, institutionName, status, cursor, lastSyncedAt, errorCode } })`. No decryption, no financial tables, no cross-user data.
- **Derivation** (pure helper `deriveConnectionState(item)` in `lib/sync/status.ts` for testability): map per §1.2. `cursor` is used only to compute state and is **never** returned (it is an opaque Plaid token — keep it server-side).
- **Provider-agnostic:** the envelope and `provider` field let Sync Center later add wallet/CSV/other-provider connections and a companion `POST` (manual refresh / reconnect / import triggers) without reshaping this read contract.

---

## 4. UI state machine (per connection)

```
             ┌─────────────┐
 connect ───▶│  importing  │  status=ACTIVE & cursor=null   → banner: "Building…"
             └─────┬───────┘
   background/cron │ writes cursor
     sync completes▼
             ┌─────────────┐
             │    ready    │  status=ACTIVE & cursor≠null   → no banner
             └─────────────┘

  status=NEEDS_REAUTH → needs_reauth → existing Reconnect UI (AccountCard / brief Attention)
  status=ERROR        → error        → surfaced as attention (existing), banner not "building"
  status=REVOKED      → excluded from the surface entirely
```

Aggregate: `building = connections.some(c => c.state === "importing")`. Banner shows iff `building`. `needs_reauth`/`error` do **not** make `building` true — they route to the existing attention/reconnect surfaces, so first-run "building" copy never masks a broken item.

---

## 5. Daily Brief integration (Q4)
- **Where:** top of the Daily Brief page, as `SyncStatusBanner` (a client leaf), above the rendered sections. The `/api/brief` route/payload is **not** modified.
- **Copy:** "Building your financial profile — importing your transaction history. This updates automatically."
- **Auto-dismiss:** the banner polls `/api/sync/status`; when `building` flips to false it renders nothing (and the page may `router.refresh()` once to pull the now-richer brief). No manual dismiss, no persisted flag.

## 6. Accounts page (Q5)
- **Page-level banner:** reuse the same `SyncStatusBanner` at the top of `/dashboard/accounts` — smallest change, immediate value.
- **Institution/account-level chip:** *optional, deferred.* Showing a per-card "Importing…" chip would require `getAccounts` to also select `cursor`/`lastSyncedAt` and expose a derived flag (it currently selects only `plaidItem.status` for reauth). That's a real change to a hot query for marginal value in this slice — recommend deferring; the page banner covers the need.

## 7. Sync Center architecture (Q6)
`GET /api/sync/status` is deliberately the **read half** of a future provider-agnostic Sync Center. The normalized `{ provider, state }` shape extends to wallets, CSV imports, and future providers without a contract change. Later slices can add a companion **`POST /api/sync/...`** for triggers (manual refresh → reuses `refreshAllActiveItemsForUser`; reconnect → existing Link update mode; CSV → existing import route) — none of which this slice builds. Keeping the read contract stable now avoids a redesign then.

## 8. Polling strategy (Q7)
- **Interval:** 4s while `building` is true (fast enough to feel live, cheap enough for a trivial query).
- **Start:** on mount, immediately fetch once; if `building`, begin the interval.
- **Stop conditions:** `building === false`; **or** a safety cap (~45 polls ≈ 3 min) after which polling stops and the banner switches to a quiet "Still importing — this can take a few minutes. It'll finish on its own." (cron/background completes it). No infinite polling.
- **Cleanup:** single interval ref; `clearInterval` on unmount and on stop. Pause while `document.hidden` (visibilitychange) to avoid background-tab waste; resume on focus. No overlapping requests (guard with an in-flight flag).

## 9. Failure UX (Q8)
- **needs_reauth:** not counted as "building"; defer to existing `ReconnectAccountButton` (AccountCard) and the brief's Needs-Attention section. The status endpoint still reports it so a future Sync Center can act on it.
- **temporary failure** (classifier returned null in Slice 2 → `status` stays `ACTIVE`, `cursor` null): shows as "importing"; the safety-cap copy (§8) covers the "taking longer" case; the cron completes it within its cycle. No special path.
- **partial completion:** undetectable at connection granularity (cursor is all-or-nothing); treated as "importing" until the cursor lands, then "ready". Acceptable and honest.

## 10. Files affected (Q9 / smallest slice)

| File | Change | Type |
|------|--------|------|
| `lib/sync/status.ts` | **New** — provider-agnostic types + pure `deriveConnectionState(item)` + `buildSyncStatus(items)`; unit-testable, no I/O. | New |
| `app/api/sync/status/route.ts` | **New** — `requireUser`, query `PlaidItem` (safe fields), map via helper, return `{ building, connections }`. | New |
| `components/dashboard/SyncStatusBanner.tsx` | **New** client component — self-polls per §8, renders "Building your financial profile…" while `building`. | New |
| `app/(brief)/dashboard/brief/page.tsx` | Mount `<SyncStatusBanner />` at top. | Edit (minimal) |
| `app/(shell)/dashboard/accounts/page.tsx` | Mount `<SyncStatusBanner />` at top. | Edit (minimal) |
| `/api/brief`, `getAccounts`, `PlaidContext`, engine, `refreshPlaidItem`, cron, schema | **No change.** | None |

---

## 11. Slice 3 implementation checklist — for approval

**Decision:** Add a provider-agnostic read-only sync-status endpoint (state inferred from existing `PlaidItem` fields, `cursor=null ⇒ importing`) and a self-polling `SyncStatusBanner` mounted on the Daily Brief and Accounts pages.

**Steps (no code until approved):**
1. `lib/sync/status.ts` — export `SyncConnectionState` union, `SyncConnection`/`SyncStatus` types, `deriveConnectionState(item)` (per §1.2/§4), and `buildSyncStatus(items) → { building, connections }`. Pure functions; no DB.
2. `app/api/sync/status/route.ts` — `GET`, `requireUser`; `db.plaidItem.findMany({ where: { userId, status: { not: REVOKED } }, select: { id, institutionName, status, cursor, lastSyncedAt, errorCode } })`; map through the helper; `NextResponse.json`. Never return `cursor`.
3. `components/dashboard/SyncStatusBanner.tsx` — `"use client"`; fetch on mount, poll every 4s while `building`, stop on `!building` or after the ~3-min cap, `clearInterval` on unmount, pause on `document.hidden`, guard overlapping requests. Render the "Building…" message while `building`; render nothing when ready. On transition building→false, optionally `router.refresh()` once.
4. Mount `<SyncStatusBanner />` at the top of `app/(brief)/dashboard/brief/page.tsx` and `app/(shell)/dashboard/accounts/page.tsx`.
5. Leave `/api/brief`, `getAccounts`, `PlaidContext`, `syncTransactionsForItem`, `refreshPlaidItem`, and cron unchanged.

**Explicitly out of scope (not this slice):** live transaction-count progress; per-account importing chip (getAccounts change); any `POST` trigger / Sync Center actions; needs_reauth/error redesign (reuse existing surfaces); `PlaidContext` wiring.

**Schema:** none. **Migrations:** none. **New response fields on existing endpoints:** none (only the new endpoint).

**Validation (Q — deliverable):**
- `npx prisma generate` (no schema delta; sandbox may 403 on engine fetch — environment-only).
- `npx tsc --noEmit` — 0 errors.
- `npm run lint` — no new errors in scoped files.
- Unit: `deriveConnectionState` returns importing/ready/needs_reauth/error for the five status/cursor combinations.
- Dev sandbox Link run: connect → within seconds `GET /api/sync/status` returns `building: true` with the new institution `state: "importing"`; banner shows on brief + accounts; after background/cron sync completes, endpoint returns `building: false`, banner auto-dismisses — **no manual Refresh**.
- Returning-user check: an already-synced item reports `state: "ready"` (cursor non-null) and does not trigger the banner.
- `git diff` limited to the scoped files.

**Rollback (Q — deliverable):**
- Pure additive code, no schema/migration → revert the commit to remove the endpoint, component, and two mount lines; nothing else references them.
- The two page edits are one-line mounts; removing them fully disables the surface. No data or engine impact; first-run sync itself is unchanged (Slices 1–2 keep working; cron still completes history).

**Stop — await approval before writing code.**
