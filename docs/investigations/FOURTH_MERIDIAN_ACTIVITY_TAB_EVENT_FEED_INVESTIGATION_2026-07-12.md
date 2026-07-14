# Fourth Meridian — Activity Tab Event Feed: Investigation

**Date:** 2026-07-12
**Scope:** Ground the "Activity as canonical event timeline" vision against the real codebase — what exists, what's cheap to surface, what needs genuinely new instrumentation. Investigation only; no implementation plan yet.
**Prompted by:** a product thought-experiment proposing Activity become an event feed (Financial / Connection / Intelligence / Space / System categories, filterable, eventually merging into the A11 Timeline).

---

## 1. Executive assessment

**The long-term architecture in the vision already exists as the stated design intent of this codebase — it's just under-populated.** `lib/timeline-types.ts` defines a `TimelineEvent` contract with this exact doc comment: *"The widget never cares where an event came from — AuditLog, SpaceGoal, account sync, or any other source. It only renders a normalized event list,"* and names its intended consumers as `GET /api/spaces/[id]/activity` (producer), `TimelineWidget` (consumer), and **"Future: Daily Briefing engine"** and **"Future: Notifications"** (consumers). That is, almost verbatim, the vision's "Platform Event → Human-readable Activity → Notifications → Timeline → AI Conversation" pipeline — already committed to as the contract, not a future rewrite. This substantially de-risks the initiative: there is no new canonical event grammar to invent, only new *producers* to write against the one that's already there.

**What's actually missing is sourcing, not architecture.** Today exactly one producer feeds `TimelineEvent`: a normalizer over `AuditLog` rows (`app/api/spaces/[id]/activity/route.ts`). That route's own header comment explicitly filters out `PLAID_SYNC`, `WALLET_SYNC`, `ACCOUNT_ADD`, `ACCOUNT_REMOVE` as **"platform noise."** The vision asks for exactly those to become the centerpiece. So this isn't an additive feature — it's un-suppressing and reframing a filter that was written under a different design assumption, plus adding new producers for categories AuditLog was never meant to carry.

**Categories split into three genuinely different kinds of work, not one uniform build:**
1. **Cheap — reframe what's already logged.** Space lifecycle, members, account sharing, goals: already flow through `AuditLog` → `TimelineEvent` today.
2. **Medium — new producers over existing tables, no new writes.** Connection sync, historical imports, sync failures: the raw data already exists in `ImportBatch` and `SyncIssue`, just never normalized into `TimelineEvent`. This is where most of the vision's "Connection" and "System" categories land.
3. **New instrumentation required.** The "Intelligence" category (wealth regenerated, reconstruction completed, coverage improved) has **no event source today** — verified: `JobRun` (the only candidate) is a global cron ledger with zero Space-scoping anywhere it's written. This category can't be surfaced without adding new writes at the point A4/A8/A9 actually run.

---

## 2. Current state (verified)

- **Producer:** `app/api/spaces/[id]/activity/route.ts` — reads the latest 30 `AuditLog` rows scoped to the Space, normalizes ~20 action types into `TimelineEvent` (icon/tone/title/subtitle per case, `:100–220`+), returns to `TimelineWidget`.
- **Consumer:** `TimelineWidget`, mounted as the ACTIVITY rail tab (`SpaceDashboard.tsx` — `ACTIVITY` is in `TAB_ORDER`, `:287`, and a real first-class tab, not a modal, per the comment at `:2401–2402`, `:3329`).
- **Explicitly filtered as noise today** (route header, `:19–26`): `SPACE_SWITCH`, auth/security events, `GOAL_UPDATED` (too granular), `PLAID_SYNC`/`WALLET_SYNC`/`ACCOUNT_ADD`/`ACCOUNT_REMOVE` ("platform noise"), `MANUAL_ASSET_UPDATE` (too frequent).
- **`IMPORT_BATCH_CREATED`/`IMPORT_BATCH_COMPLETED` don't exist as audit actions at all** — `lib/audit-actions.ts` (`:118–122`) explicitly notes they were "deliberately deferred," with only `IMPORT_BATCH_ROLLED_BACK` and `IMPORT_BATCH_UPDATED_ON_MATCH` implemented. So "historical import completed" isn't even a suppressed event today — it was never written as one. (It doesn't need to be, though — see §3.)
- **The full `AuditAction` enum** (`lib/audit-actions.ts`) is large (~45 actions: auth, account lifecycle, password/2FA, goals, space lifecycle, accounts, members, sync/platform, imports, AI context). Most of the vision's "Space" category is already fully covered.

---

## 3. Category-by-category buildability

| Vision category | Real source | Work required |
|---|---|---|
| **Space** (account add/remove, renamed, goals) | `AuditLog` — already logging `ACCOUNT_ADD`/`ACCOUNT_REMOVE`/`SPACE_UPDATE`/`GOAL_*`, just partially filtered | **Cheap.** Un-suppress the noise list, add normalizer cases for the newly-included actions. No new writes. |
| **Connection** (synced, reconnected, sync failed) | `AuditLog.PLAID_SYNC`/`PLAID_REFRESH` (already written, `app/api/plaid/sync/route.ts:123`) + `SyncIssue` (real model: `provider`, `plaidItemId`, `kind` incl. `MISSING_ACCOUNT`/`UPSERT_ERROR`/`REMOVED_TOMBSTONE`, `resolved`, scoped via `financialAccountId`) | **Medium.** Un-suppress `PLAID_SYNC` for "connected"/"reauthenticated"; add a new producer reading `SyncIssue` (resolvable to a Space via its account's Space link, same pattern used everywhere else) for "sync failed." No new writes, but a new query/normalizer path. |
| **Connection — historical import completed** | `ImportBatch` (real model, rich fields: `rowCount`, `importedCount`, `skippedCount`, `matchedCount`, `failedCount`, `kind` ∈ {TRANSACTIONS, INVESTMENT_HISTORY}, `source`, `completedAt`, resolvable to Space via `financialAccountId`) | **Medium.** New producer reading `ImportBatch` directly — no AuditLog entry needed or expected; the batch row itself has everything the vision's example copy needs ("324 investment events added, 1 duplicate skipped" maps directly to `importedCount`/`skippedCount`). |
| **System** (rollback, price backfill, repair) | `IMPORT_BATCH_ROLLED_BACK` (real, already logged) for rollback; price backfill runs through `JobRun` (global, see below) | **Cheap for rollback** (un-suppress + normalize, already a real AuditLog action). **Blocked for price backfill / "data repaired"** on the same JobRun gap as Intelligence — see below. |
| **Intelligence** (wealth regenerated, reconstruction completed, coverage improved, valuation improved) | **No source exists.** `JobRun` is the only candidate table shaped for this (`jobName`, `status`, `summary: Json`, `errorSummary`) but it is a **global, non-Space-scoped** cron ledger — grep-verified zero references tying a `JobRun` row to a `spaceId` anywhere `lib/snapshots/`, `lib/investments/`, or `scripts/` write one. A9 regeneration, A4 reconstruction, and A8 backfill do not consistently write to it today either (matches the repository audit's own finding on writer observability). | **New instrumentation.** This category cannot be surfaced by reading existing data — it requires a new, lightweight, Space-scoped event write at the point A4/A8/A9 actually run (or a Space-resolvable `spaceId`/`accountIds` field added to `JobRun.summary` and a join through affected accounts). This is real backend work, not a UI/query change — see §4. |
| **Financial** (large income/expense, debt payments as *events*, transactions imported as a count) | Raw `Transaction` rows exist, but nothing today derives "this was a notable transaction" as a discrete logged event — it would be computed at feed-build time from a threshold, not read from a log | **Different kind of work: synthesis, not surfacing.** No new schema needed, but this is a derived-signal layer (define "large," decide whether every sync silently re-evaluates recent transactions for feed-worthiness) rather than a straightforward new producer. Also the one category the vision itself already flagged as a risk of turning Activity into "another transaction page" — worth being conservative here regardless of feasibility. |

---

## 4. What "new instrumentation" for Intelligence actually means

Not a big lift, but a real one, and worth being honest that it's backend work landing in a different set of files than everything else in this document:

- The cleanest shape: a small, additive event write (not necessarily a new AuditLog action — could be its own lightweight table scoped to `spaceId`, since these are system-generated, not user-actor events, and `AuditLog`'s `userId`-centric shape doesn't fit a "the system recomputed your wealth history" event well) at the three points that already exist and already know their blast radius:
  - A9's `regenerateWealthHistoryForAccounts` (already computes `computeAffectedWindow` — the repository audit noted this is "exported and called by nobody," i.e., not even wired to run automatically yet, which is a prerequisite this category depends on regardless of Activity).
  - A4's bounded repair (`repairReconstructionForAccount`) — already invoked from event ingest, import commit/rollback; knows which accounts it touched.
  - A8's price backfill (`scripts/backfill-security-prices.ts` / the daily job) — knows which instruments/accounts gained new coverage.
- Each of these already has (or, for A9, will have once activated) a bounded `{spaceId or accountIds, window, counts}` shape at the exact call site — the missing piece is just persisting a one-line summary of that shape somewhere Activity can read, not computing anything new.
- **Sequencing dependency, not a blocker:** A9's trigger wiring is still unwired per the repository audit (flag absent, no caller). Intelligence events for wealth regeneration specifically can't be real until that activation work happens anyway — so this category is naturally gated behind the audit's own "Activation & Reconciliation" recommendation, not behind anything in Activity's design.

---

## 5. Filter UI precedent already exists

`lib/audit-actions.ts` already defines `AUDIT_ACTION_GROUPS` — a grouped, labeled structure used for the admin filter dropdown. The vision's member-facing filter chips (All / Financial / Connections / Imports / System / Intelligence) can reuse this exact grouping pattern client-side; it doesn't need a new UI primitive, just a new grouping definition scoped to member-facing categories (the admin groups are broader — auth, sessions, AI context — and shouldn't leak into a member's Activity filter).

---

## 6. Recommended shape of the work (not a slice plan — a sequencing recommendation)

Matches the vision's own instinct not to overbuild, now grounded in what's actually cheap vs. not:

1. **Phase 1 — reframe, no new backend.** Un-suppress `PLAID_SYNC`/`ACCOUNT_ADD`/`ACCOUNT_REMOVE`, add normalizer cases, add new producers reading `ImportBatch` and `SyncIssue` directly (both already have everything needed), add the member-facing filter grouping. This alone delivers the "Financial / Connection / Space / System" categories close to the vision's example copy, entirely from data that already exists.
2. **Phase 2 — Intelligence, after A9 activation.** Gate this on the repository audit's own recommended activation-and-reconciliation pass; add the lightweight Space-scoped event write at the three call sites named in §4 once regeneration is actually running.
3. **Defer — Financial derived signals (large transactions, debt payoff detection).** Genuinely different kind of work (synthesis vs. surfacing); also the one area the vision itself flagged as a risk of scope creep into "another transaction page." Revisit only once Phase 1 is live and it's clear members actually want it.
4. **A11 Timeline merge** — correctly framed in the vision as later, not now. Nothing in Phase 1/2 forecloses it: since every event is already normalized into the source-agnostic `TimelineEvent` contract, a future Timeline surface consumes the same producers rather than replacing them.

---

## 7. Open questions for a product decision before an implementation plan is written

1. Does "Intelligence" ship at all before A9 activation, or does Phase 1 ship alone first as a complete, useful slice? (Recommended default: yes, ship Phase 1 alone — it's real value with zero backend risk.)
2. Should sync-failure events (`SyncIssue`) surface as Activity items, or only as the existing account-health affordances (Connections card, reauth banners)? Surfacing failures in a feed users read casually needs a tone/copy decision distinct from "here's what happened" — worth a deliberate call, not a default.
3. Where does the new Space-scoped Intelligence event live — a new lightweight table, or an extension of `AuditLog` with a nullable `userId`? Affects whether existing AuditLog admin tooling picks it up "for free" or needs its own view.
