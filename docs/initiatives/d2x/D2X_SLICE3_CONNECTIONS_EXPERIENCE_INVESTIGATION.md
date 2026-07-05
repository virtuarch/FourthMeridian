# D2.x — Slice 3 (revised): Connections Experience — Investigation

**Status:** Investigation only. No implementation. Supersedes the *UI direction* of `D2X_SLICE3_SYNC_STATUS_SURFACE_INVESTIGATION.md` (transient banner) while **keeping its `/api/sync/status` endpoint and state machine unchanged**.
**Direction change:** Slice 3 is no longer a transient banner. It is the first increment of the **permanent Connections experience** — the single place where users connect and manage financial providers, watch first-run sync progress, reconnect, and (later) pick new providers / run a Sync Center.

---

## 0. What changed vs the prior investigation

Retained, unchanged:
- **`GET /api/sync/status`** provider-agnostic contract `{ building, connections[] }` and the `cursor IS NULL ⇒ importing` derivation (§1.2/§3/§4 of the prior doc). This is *more* justified now: it becomes the data spine of a permanent page, not throwaway banner data.
- The per-connection state machine: `importing → ready`, plus `needs_reauth`/`error` routed to existing surfaces.

Replaced:
- The transient `SyncStatusBanner` on Brief + Accounts → a **permanent `/dashboard/connections` page** that renders first-run progress as its *importing state* and settles into provider management as its *ready state*. Same component, different data state — so there is **no separate onboarding screen to throw away**.

---

## 1. The core idea — onboarding and management are one page at two data states

The requested first-run view…

```
✓ Institution connected
  Building your financial profile…
  ✓ Accounts discovered
  ✓ Balances imported
  … Transaction history        (importing)
  … Timeline / Daily Brief / AI (unlocks when history completes)
[discovered accounts]      [Connect another institution]
```

…is simply the **`importing` rendering of a connection card**. When `building` flips false, the same card drops the checklist and shows the settled connection (institution, accounts, last synced, reconnect if needed). The page is permanent; the checklist is a *state*, not a screen. This is what avoids temporary onboarding UI.

**Which checklist rows are real now vs. forward-looking (honesty guard):**
- Observable from existing data today: *Institution connected* (PlaidItem exists), *Accounts discovered* (linked `FinancialAccount`s via `getAccounts`), *Balances imported* (fast path guarantees balances before this page loads), *Transaction history* (`importing` while `cursor=null`, ✓ when `cursor≠null`).
- Forward-looking reveal markers, gated on the **same `building` flag**: *Timeline / Daily Brief / AI*. Rendered as "ready next," never as fake-complete. As those surfaces ship on their own tracks (Daily Brief → v2.6b, richer AI → AI-x per the charter), they light up through the same contract with **no backend change here**. This matches the charter's progressive-reveal exit criteria.

---

## 2. Answers to the five questions

### Q1 — Can Slice 3 implement this while still reusing `/api/sync/status`? **Yes, unchanged.**
The endpoint is already provider-agnostic and returns exactly what a permanent page needs (`building` + per-connection `state`). The page **server-renders** the connection list (from `PlaidItem` + the existing `getAccounts` for discovered accounts, grouped by institution) and **client-polls** `/api/sync/status` for live progress. No endpoint reshape is required for this slice. (Optional later enrichment — a per-connection `accountsDiscovered` count or `provider` variety — is additive and does not break the contract.)

### Q2 — Should `/dashboard/accounts` become `/dashboard/connections`, with Accounts a section inside? **Yes — as the end-state, reached incrementally.**
Target: `/dashboard/connections` is the hub; "Accounts" becomes a section/view within it (grouped by institution/provider). But do it **additively, not by renaming a live route in slice one** (mirrors the project's "additive before subtractive" rule and the Workspace→Space rename discipline):
1. **Now (this slice):** add `/dashboard/connections` as a *new* route. Leave `/dashboard/accounts` fully working and untouched.
2. **Later slice:** fold the accounts list into Connections as its "Accounts" section; then redirect `/dashboard/accounts → /dashboard/connections#accounts` (or keep it as a deep link into the section). No destructive rename until the hub is proven.

### Q3 — Smallest implementation onto this architecture without throwaway UI?
Build **only** the permanent page skeleton whose top region is the live per-connection progress, reusing everything that exists:
- New `app/(shell)/dashboard/connections/page.tsx` (server): enumerate connections (`PlaidItem` rows) + discovered accounts (`getAccounts`, grouped by institution); render each as a `ConnectionCard`; include a **"Connect another institution"** action reusing the existing `ConnectAccountButton`.
- New client `ConnectionsProgress` (or per-card client leaf) that polls `/api/sync/status` and drives each card's `importing/ready` rendering (the checklist).
- Reuse `/api/sync/status` + `lib/sync/status.ts` derivation from the prior slice as-is.
- Route first-connect to this page (Q4).
- **Do not** build a banner, a separate onboarding screen, a provider picker, or a Sync Center POST yet. **Do not** touch `/dashboard/accounts`, `/api/brief`, `getAccounts`, the engine, or the cron.

That is the whole slice: one page + one client poller, on top of an endpoint already designed. Everything aspirational (provider picker, accounts fold-in, Sync Center actions) layers onto this same page later.

### Q4 — Routing after first connect vs subsequent connects?
**Single destination for all Plaid connects: `/dashboard/connections`.** This is the one behavioral change and it removes branching:
- **First connect** (user had zero connections): Plaid Link → push `/dashboard/connections`, which shows the building checklist for the new institution → user continues to Dashboard when ready (a "Go to Dashboard" CTA appears once `building` is false; navigation is user-driven, not a forced redirect).
- **Subsequent connect** (already has connections): Plaid Link → return to `/dashboard/connections`; the new institution appears as a new `importing` card among existing `ready` ones.

First-vs-subsequent affects **copy/emphasis only, not destination**. Implementation: change `PlaidContext.onSuccess` from a bare `router.refresh()` to `router.push('/dashboard/connections')` (keeping the existing `onDone` hook for callers that need extra behavior). One small, reversible change; it also replaces today's silent `router.refresh()` no-visible-feedback flow.

### Q5 — How does this scale to Coinbase / Schwab / wallets / CSV / future providers?
The page is built around the **provider-agnostic Connection concept**, not Plaid specifics, so scaling is additive:
- **Data:** the schema already has a provider-agnostic `Connection` model + `ProviderType` (written today by `exchangeToken`'s dual-write; D6/D7 ProviderCatalog + D2/D13 adapter layer are the roadmap). The page reads `PlaidItem` now; it can later enumerate `Connection` rows across providers without changing its shape. `/api/sync/status` already carries a `provider` field per connection.
- **"Connect another institution"** becomes a **provider picker** fed by ProviderCatalog (Plaid / Coinbase / Schwab / wallet address / CSV upload). Each provider plugs in as a new connection card with the same `importing/ready/needs_reauth/error` state machine.
- **Wallets** (existing wallet accounts) render as `provider: WALLET` connections; **CSV imports** render as source rows whose `importing→ready` maps to `ImportBatch` progress; **future providers** inherit the same envelope via their adapter.
- **Sync Center** = this page + a later companion **`POST /api/sync/...`** for triggers (manual refresh → `refreshAllActiveItemsForUser`; reconnect → existing Link update mode; re-import → existing import route). The read contract stays stable, so none of this is a redesign.

The single rule that makes it scale: build the page and endpoint around `{ provider, state }` connections, never around Plaid.

---

## 3. Endpoint (reused, from prior slice — restated for completeness)

`GET /api/sync/status` (auth: `requireUser`) → `{ building, connections[] }`; each connection `{ id, provider, institution, state, lastSyncedAt, errorCode }`; `state` derived from existing `PlaidItem` fields (`ACTIVE&cursor=null → importing`, `ACTIVE&cursor≠null → ready`, `NEEDS_REAUTH → needs_reauth`, `ERROR → error`, `REVOKED → excluded`). `cursor` is never returned. **No change required for this slice.**

## 4. Revised smallest slice — files affected

| File | Change | Type |
|------|--------|------|
| `lib/sync/status.ts` | **New** — provider-agnostic types + pure `deriveConnectionState` / `buildSyncStatus` (from prior slice). | New |
| `app/api/sync/status/route.ts` | **New** — read `PlaidItem` (safe fields), map via helper. | New |
| `app/(shell)/dashboard/connections/page.tsx` | **New** server page — connection list (PlaidItem + `getAccounts` grouped by institution), discovered accounts, "Connect another institution". | New |
| `components/connections/ConnectionCard.tsx` (+ small `ConnectionsProgress` client leaf) | **New** — renders `importing` checklist vs `ready` summary; polls `/api/sync/status`. | New |
| `context/PlaidContext.tsx` | **Edit** — `onSuccess` routes to `/dashboard/connections` (replaces bare `router.refresh()`); `onDone` preserved. | Edit (small) |
| Sidebar nav | **Edit (optional, small)** — add a "Connections" entry so the hub is reachable. | Edit (optional) |
| `/dashboard/accounts`, `/api/brief`, `getAccounts`, engine, `refreshPlaidItem`, cron, schema | **No change.** | None |

Deferred to later slices (explicitly not now): provider picker / ProviderCatalog wiring; folding the Accounts list into Connections + `/accounts` redirect; `Connection`-table read cutover; Sync Center `POST` triggers; live transaction-count progress; Timeline/Brief/AI actually lighting up (their own tracks).

## 5. Validation plan (for the eventual implementation)
- `npx prisma generate` (no schema delta; sandbox may 403 — environment-only).
- `npx tsc --noEmit` — 0 errors.
- `npm run lint` — no new errors in scoped files.
- Unit: `deriveConnectionState` across the five status/cursor combinations.
- Dev sandbox: first connect → lands on `/dashboard/connections`; new institution card shows `importing` checklist; discovered accounts listed; after background/cron completes, card settles to `ready` with no manual Refresh. Second connect → returns to Connections, new card `importing` alongside existing `ready` cards. `/dashboard/accounts` still renders unchanged.
- `git diff` limited to the scoped files.

## 6. Rollback plan
- Additive: new endpoint, helper, page, and components — revert the commit to remove them; nothing else depends on them.
- The only behavioral edit is `PlaidContext.onSuccess` routing; reverting that one line restores the prior `router.refresh()` flow. `/dashboard/accounts` and the whole first-run sync engine (Slices 1–2) are untouched, so rollback carries no data or sync risk.

## 7. Recommendation
Adopt the permanent-Connections direction for Slice 3, reusing `/api/sync/status` verbatim. Ship the **page + poller + single routing change** now; keep `/dashboard/accounts` intact; layer provider picker, accounts fold-in, and Sync Center actions as subsequent additive slices. This puts us on the permanent architecture immediately with no throwaway onboarding UI.

**Investigation only — no implementation. Awaiting direction/approval before a Slice 3 implementation checklist is finalized.**
