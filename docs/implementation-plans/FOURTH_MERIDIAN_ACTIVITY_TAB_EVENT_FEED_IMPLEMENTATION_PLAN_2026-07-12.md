# Fourth Meridian — Activity Tab Event Feed: Phase 1 Implementation Plan

**Date:** 2026-07-12
**Branch of record:** `feature/v2.5-spaces-completion`
**Scope:** Phase 1 only, per `FOURTH_MERIDIAN_ACTIVITY_TAB_EVENT_FEED_INVESTIGATION_2026-07-12.md` §6 — reframe what's already logged, add two new read-only producers over existing tables, add member-facing filtering. **No new Prisma models, no new writes anywhere, no schema migration.** Intelligence (§3/§4 of the investigation) and Financial derived-signal events are explicitly out of scope — gated behind A9 activation and a separate product call, respectively.
**Non-negotiable invariant:** every event, from every source, is normalized into the existing `TimelineEvent` contract (`lib/timeline-types.ts`) — no new event shape, no parallel feed, no bypass of `TimelineWidget`. This plan adds producers, not a new pipeline.

---

## 1. Repository findings

### 1.1 Current producer/consumer (verified)

- **Producer:** `app/api/spaces/[id]/activity/route.ts` — queries `db.auditLog.findMany({ where: { spaceId, action: { in: ALLOWED_ACTIONS } }, orderBy: { createdAt: "desc" }, take: 100 })` (`:293–309`), normalizes via `normalizeLog()` (`switch (log.action)`, `:100–220`+), returns `{ events: TimelineEvent[] }` (`:335`). `AuditLog` already carries `spaceId` directly — no join needed for this source.
- **Consumer:** `TimelineWidget.tsx` — pure presenter, self-fetches `/api/spaces/${spaceId}/activity` when no `events` prop is given (`:191–218`), paginates client-side (`pageSize` default 10, `:225`), maps `event.icon` through a fixed `ICON_MAP` (`:37–55`, unmapped names silently fall back to a generic `Activity` glyph — safe default, but new event types should get real icons). **No filter UI exists today.**
- **Mount point:** `components/dashboard/SpaceDashboard.tsx:926` — `<TimelineWidget spaceId={spaceId} pageSize={10} />`, wired through the generic `SectionCard` stack as the `recent_activity` widget (ACTIVITY is a real rail tab, not a modal, per `:3327–3329`) — **not** a bespoke composition like Wealth/Cash Flow/Liquidity/Investments/Debt. This plan does not need a composition component; it's a data + presenter change.

### 1.2 The suppression mechanism (verified — this is a filter, not a gap)

`ALLOWED_ACTIONS` (`activity/route.ts:36–54`) is an allowlist consumed directly in the Prisma `where` clause — actions not in the set are excluded at the query level, not filtered after normalization. `PLAID_SYNC`, `PLAID_REFRESH`, `WALLET_SYNC`, `ACCOUNT_ADD`, `ACCOUNT_REMOVE` are real, already-written `AuditLog` actions (`lib/audit-actions.ts:104–109`; `PLAID_SYNC` confirmed written at `app/api/plaid/sync/route.ts:123`) that are simply absent from this set. Un-suppressing them is exactly: add to `ALLOWED_ACTIONS`, add a `case` to `normalizeLog()`. No new writes.

### 1.3 New sources — verified schema, verified Space-scoping pattern

- **`ImportBatch`** (`prisma/schema.prisma:2005+`): `financialAccountId`, `connectionId`, `source: ImportSource`, `kind: ImportBatchKind` (`TRANSACTIONS | INVESTMENT_HISTORY`, `:2000`), `status: ImportBatchStatus`, `rowCount`, `importedCount`, `skippedCount`, `matchedCount`, `failedCount`, `completedAt`. No `spaceId` field — resolved via the account, same as every other multi-account read in this codebase.
- **`SyncIssue`** (`:2315–2330`): `provider`, `plaidItemId`, `financialAccountId`, `kind: SyncIssueKind` (`MISSING_ACCOUNT | UPSERT_ERROR | REMOVED_TOMBSTONE`), `detail: Json`, `resolved`, `createdAt`. Also account-scoped, not space-scoped.
- **Verified Space-scoping precedent** (`lib/data/transactions.ts:99,121`): `financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: [...] } } } }`. This exact `spaceAccountLinks.some({spaceId, status: ACTIVE})` shape is the established, tested pattern for "give me records on accounts linked to this Space" — reused verbatim for both new producers, not reinvented.

### 1.4 House pattern for new pure logic (verified elsewhere, applied here)

Every prior initiative in this codebase (A4/A8/A9/A10, and every perspective redesign this week) splits pure fixture-tested logic from thin DB binding. `normalizeLog()` today is already a pure function (no DB access inside the switch) called from an impure route handler — this plan extends that shape rather than replacing it: two new pure normalizer functions, two new thin binding queries, merged in the route.

### 1.5 Concurrent-modification constraints

None of the four in-flight/landed perspective redesigns (Wealth, Cash Flow, Liquidity, Investments, Debt) touch `app/api/spaces/[id]/activity/route.ts`, `lib/timeline-types.ts`, `TimelineWidget.tsx`, or `lib/audit-actions.ts` — confirmed by re-reading each plan's "Explicitly untouched" list. **Zero file overlap with any other active work.** Still verify `git status` before starting, as standard practice, but this needs no worktree and no sequencing behind the perspective work.

---

## 2. Exact implementation design

### 2.1 `TimelineEvent` gets one new field

`lib/timeline-types.ts` — add:

```ts
export type ActivityCategory = "financial" | "connection" | "space" | "system";

export interface TimelineEvent {
  // ...existing fields unchanged...
  category: ActivityCategory;   // NEW — required on every producer, enables filtering
}
```

Every existing `normalizeLog()` case gets a `category` added (mechanical — mapped from the table in §2.2). This is the only change to the shared contract; it's additive to the interface but every current caller of `normalizeLog()` is inside this one file, so it's a same-commit, fully-typed migration — `tsc` will catch any missed case.

### 2.2 Category mapping for existing + newly-unsuppressed AuditLog actions

| Category | Actions |
|---|---|
| `space` | `SPACE_CREATED/CREATE`, `SPACE_UPDATE`, `MEMBER_*`, `SPACE_LEAVE`, `ACCOUNT_SHARED/SHARE`, `ACCOUNT_REVOKED/SHARE_REVOKE`, `GOAL_*` |
| `financial` | `MANUAL_ASSET_ADD/DELETE/RESTORE` |
| `connection` | `PLAID_SYNC`, `PLAID_REFRESH`, `WALLET_SYNC`, `ACCOUNT_ADD`, `ACCOUNT_REMOVE` (all newly unsuppressed) |
| `system` | `IMPORT_BATCH_ROLLED_BACK` (newly unsuppressed — real action, was never in `ALLOWED_ACTIONS`) |

### 2.3 New normalizer case: `IMPORT_BATCH_ROLLED_BACK`

Add to `ALLOWED_ACTIONS` and `normalizeLog()`: title "Import rolled back", subtitle from `meta` (batch already carries counts in its own metadata per the existing rollback write path — confirm exact meta shape at implementation time, do not assume a field name without checking the actual `db.auditLog.create` call for this action).

### 2.4 New normalizer cases: sync/connection

- `PLAID_SYNC` / `PLAID_REFRESH`: title "Account synced", subtitle from institution name if present in `meta`, else generic "Balances and transactions refreshed". Tone `neutral`.
- `WALLET_SYNC`: title "Wallet synced", same shape.
- `ACCOUNT_ADD`: title "Account connected", subtitle institution/account name from `meta`. Tone `positive`.
- `ACCOUNT_REMOVE`: title "Account disconnected", tone `warning`.

**Verify `meta` shape for each against the actual write site before assuming field names** — same discipline every existing case already follows (e.g. `MEMBER_INVITED` reads `meta.invitedEmail`/`meta.role` because that's what the write site actually sets). Do not guess field names; grep the `db.auditLog.create({ ..., action: AuditAction.PLAID_SYNC, ... })` call site(s) first.

### 2.5 New pure normalizer: `lib/activity/normalize-import-batch.ts`

```ts
export function normalizeImportBatchEvent(batch: ImportBatchRow): TimelineEvent | null {
  // Only COMPLETED batches are events (PENDING/FAILED batches aren't "things that happened" yet)
  // title: batch.kind === "INVESTMENT_HISTORY" ? "Investment history imported" : "Transactions imported"
  // subtitle: `${batch.importedCount} imported` + conditionally `, ${batch.skippedCount} skipped`
  //           + conditionally `, ${batch.matchedCount} matched` (only when > 0, never a zero clause)
  // date: batch.completedAt (never createdAt — an in-progress batch has no completedAt and is filtered)
  // category: "connection" (imports are a connection-adjacent action, matching the investigation's mapping)
  // id: `importbatch:${batch.id}` — namespaced so it can never collide with an AuditLog id
}
```

Zero counts must never render as a clause ("0 skipped" is noise the vision itself warns against — the Cash Flow/Liquidity precedent of "N without an APR" style disclosure only when N > 0 applies here too).

### 2.6 New pure normalizer: `lib/activity/normalize-sync-issue.ts`

```ts
export function normalizeSyncIssueEvent(issue: SyncIssueRow): TimelineEvent | null {
  // Only UNRESOLVED issues are events (a resolved issue already happened and got fixed —
  // surfacing it after the fact as "problem!" the day after it was quietly resolved is
  // dishonest urgency; resolved issues are silently dropped from the feed, not shown as
  // "issue resolved" — that positive-spin framing isn't earned by this data either)
  // title/tone by kind: MISSING_ACCOUNT → "Account sync incomplete" / warning,
  //                      UPSERT_ERROR → "Sync error" / danger,
  //                      REMOVED_TOMBSTONE → skip entirely (internal bookkeeping, not member-meaningful)
  // subtitle: honest, non-alarming, points at the fix — "Reconnect to restore full sync" style,
  //           never exposes SyncIssue.detail verbatim (may contain provider-internal identifiers)
  // category: "connection"
  // id: `syncissue:${issue.id}`
}
```

**Open call folded into this plan per the investigation's §7-Q2 default:** sync issues DO surface, but only unresolved ones, with fix-oriented copy, and `REMOVED_TOMBSTONE` (internal bookkeeping) is dropped — this keeps the feed honest without turning it into an alarm log. If this framing feels wrong once real data is visible, it's a one-function change, not a schema change.

### 2.7 Route changes

`app/api/spaces/[id]/activity/route.ts`:
1. Add the two new bindings:
   ```ts
   const importBatches = await db.importBatch.findMany({
     where: { status: "COMPLETED", financialAccount: { spaceAccountLinks: { some: { spaceId, status: "ACTIVE" } } } },
     orderBy: { completedAt: "desc" }, take: 50,
   });
   const syncIssues = await db.syncIssue.findMany({
     where: { resolved: false, financialAccount: { spaceAccountLinks: { some: { spaceId, status: "ACTIVE" } } } },
     orderBy: { createdAt: "desc" }, take: 50,
   });
   ```
   (Confirm exact `spaceAccountLinks` relation name/status enum casing against the actual `SpaceAccountLink` model before writing — §1.3's citation is the pattern, not a copy-paste guarantee.)
2. Merge all three normalized arrays, sort by `date` descending, cap at a single limit (raise from the current ad-hoc 30/100 split to one consistent `take` — recommend 60, revisit if empty-feed complaints appear).
3. Response shape unchanged: `{ events: TimelineEvent[] }`.

### 2.8 Filter UI — `TimelineWidget.tsx`

- Add `ACTIVITY_FILTER_GROUPS: { id: ActivityCategory | "all"; label: string }[]` to `lib/timeline-types.ts` (member-facing — separate from the admin `AUDIT_ACTION_GROUPS` in `lib/audit-actions.ts`, which stays untouched; this is a distinct, smaller vocabulary).
- Inside `TimelineWidget`, add a `SegmentedControl` (reuse `components/atlas/SegmentedControl.tsx` — the same component Liquidity/Cash Flow/Investments already use, no new control) rendering `ACTIVITY_FILTER_GROUPS`, filtering `allEvents` by `category` before the existing pagination slice (`:222–225`). Filter state is local `useState`, resets page to 0 on change (same pattern as every other filtered list in this codebase).
- Empty state per filter: when a category filter yields zero events, don't fall back to the generic `EmptyState` — show "No {category} activity yet" so an empty *filtered* view doesn't read as "nothing ever happened in this Space."
- Add real icons to `ICON_MAP` for the new event types (sync icon, import icon, sync-issue warning icon — pick from the already-imported `lucide-react` set used elsewhere in this file's sibling components, don't introduce a new icon library).

---

## 3. Files

**Add:**
- `lib/activity/normalize-import-batch.ts` + `.test.ts`
- `lib/activity/normalize-sync-issue.ts` + `.test.ts`

**Modify:**
- `lib/timeline-types.ts` — `ActivityCategory` type, `category` field on `TimelineEvent`, `ACTIVITY_FILTER_GROUPS`.
- `app/api/spaces/[id]/activity/route.ts` — `ALLOWED_ACTIONS` additions, new normalizer cases (with `category`), two new bindings, merge/sort.
- `components/space/widgets/TimelineWidget.tsx` — filter control, per-category empty state, `ICON_MAP` additions.

**Explicitly untouched:** `lib/audit-actions.ts` (admin `AUDIT_ACTION_GROUPS` stays as-is — different audience, different vocabulary), `SpaceDashboard.tsx` (no host wiring needed — `TimelineWidget` already self-fetches and is already mounted), every perspective redesign file (Wealth/Cash Flow/Liquidity/Investments/Debt), `JobRun`, any Prisma schema/migration file.

---

## 4. Slice plan

- **S1 — Reframe existing AuditLog data.** `category` field + `ACTIVITY_FILTER_GROUPS` types; un-suppress + normalize `ACCOUNT_ADD/REMOVE`, `PLAID_SYNC/REFRESH`, `WALLET_SYNC`, `IMPORT_BATCH_ROLLED_BACK`; verify real `meta` shapes at each write site before writing copy. Zero new DB reads beyond the existing AuditLog query.
- **S2 — ImportBatch producer.** `normalize-import-batch.ts` (+test), the route binding, merge into the response.
- **S3 — SyncIssue producer.** `normalize-sync-issue.ts` (+test), the route binding, merged in.
- **S4 — Filter UI.** `SegmentedControl` in `TimelineWidget`, per-category empty state, new icons.
- **S5 — Tests + polish.** Full suite green, STATUS.md note.

Each slice is independently shippable — S1 alone is already a real improvement (existing widget, existing route, no new tables touched) and S2–S4 can land in any order after it.

---

## 5. Risks

- **Guessing `meta` field names instead of verifying them** — the single biggest risk of a "reframe" plan like this. Every new normalizer case must be checked against its actual write site, not assumed from the vision's example copy. Stop and report rather than shipping a case that silently reads `undefined` and renders blank subtitles.
- **`spaceAccountLinks` relation/enum casing** — §1.3's citation is a real precedent, but confirm the exact Prisma relation name and `ShareStatus` value against the current schema before writing the two new queries, don't copy the transactions.ts snippet verbatim without checking it still matches.
- **Volume:** un-suppressing `PLAID_SYNC` could be noisy if syncs run frequently per account — check real data volume in S1 before shipping; if every-sync-is-an-event floods the feed, consider only surfacing syncs that actually changed something (new transactions found) rather than every poll. This is a judgment call to make with real data, not a rule to pre-decide from a doc.
- **SyncIssue tone** — `detail: Json` must never be exposed verbatim (may carry provider-internal identifiers per §1.3); copy must stay in the honest-but-calm register already established for this codebase's error states elsewhere (Import safety core, Debt's "we never invent a rate" pattern).
- **Zero-count clauses** — mechanical to avoid (§2.5) but easy to forget; the test suite should assert it directly.

## 6. Overengineering check

Confirmed feasible as: two new pure normalizer functions + two new thin queries + one type field + one filter control reusing an existing component. Rejected: a new event-sourcing table, a new "activity service" abstraction, a generalized producer-registry (three producers doesn't earn one), touching `AUDIT_ACTION_GROUPS` (different audience). Intelligence and Financial categories are named out of scope per the investigation, not silently absorbed into this plan's "system" category as a consolation.

## 7. Testing expectations

`lib/activity/normalize-import-batch.test.ts`: COMPLETED-only filter, kind-based title branch, zero-count clauses omitted, `id` namespacing, `date` from `completedAt` not `createdAt`.
`lib/activity/normalize-sync-issue.test.ts`: unresolved-only filter, `REMOVED_TOMBSTONE` dropped, `detail` never appears in output, kind→tone mapping.
Extend (don't rewrite) any existing timeline-types/route coverage if it exists at implementation time — verified none exists today, so these are the first tests for this surface; add a source-scan or fixture test for the route's merge/sort behavior (three pre-sorted arrays in, one date-sorted array out) matching the house pattern used elsewhere in this codebase.

## 8. Validation gate

```bash
npx tsc --noEmit
npx eslint
npm test
git diff --name-only   # must match §3 exactly
npm run dev             # manual pass: trigger a real sync, a real import, confirm real
                         # events appear with correct copy (not guessed meta fields);
                         # filter chips isolate categories correctly; per-category empty
                         # state; pagination still works; no zero-count clauses anywhere
```

## 9. Stop conditions

1. Any `meta` field needed for copy doesn't actually exist at the write site — do not invent a fallback string that looks like real data; use the honest generic fallback pattern already used elsewhere (`str(meta.x) || "generic phrase"`).
2. `SyncIssue.detail` would need to be shown to make an event legible — cut the detail, don't expose it.
3. Real sync volume makes `PLAID_SYNC` events flood the feed — report back for a scoping decision (throttle vs. omit) rather than shipping noise.
4. Scope drifts toward Intelligence or Financial derived-signal events — both are explicitly deferred; adding either here is out of scope regardless of how easy it looks once inside this code.
5. `spaceAccountLinks` schema doesn't match §1.3's cited shape — stop and report the actual shape rather than adapting blindly.
