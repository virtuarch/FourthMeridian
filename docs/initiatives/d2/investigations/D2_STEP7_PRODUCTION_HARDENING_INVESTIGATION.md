> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 7 — Production Hardening Investigation

**Investigation only. No code, schema, or migration changes were made to
produce this document, and no other document was modified.** Branch:
`feature/phase-2-architecture`. Baseline: `v2.3.0`.

Goal: assess production readiness of the provider/connection layer across
eight named areas — connection lifecycle, connection health, reconnect
flows, orphaned connection cleanup, sync reliability, retry/backoff,
provider diagnostics, production hardening — and produce an
existence/code-required/size/order checklist for each. **Nothing here is
approved for implementation; see "Stop point" at the end.**

Inputs read in full: `lib/plaid/refresh.ts`, `lib/plaid/syncTransactions.ts`,
`lib/plaid/disconnect.ts`, `lib/plaid/errors.ts`, `lib/plaid/client.ts`,
`lib/accounts/reconcile.ts`, `jobs/scheduler.ts`, `jobs/sync-banks.ts`,
`app/api/plaid/sync/route.ts`, `app/api/plaid/refresh/route.ts`,
`app/api/plaid/exchange-token/route.ts`, `app/api/plaid/link-token/route.ts`,
`scripts/cleanup-orphaned-plaid-items.ts`,
`scripts/verify-orphaned-plaid-items.ts`, the `PlaidItem`/`Connection`/
`AccountConnection` sections of `prisma/schema.prisma`, plus a repo-wide grep
for retry/backoff/health-check/diagnostic/reconnect/orphan patterns and a
file-system check for an `instrumentation.ts` entrypoint (none exists).

**Naming flag, before the checklist:** `D2_ROADMAP.md`'s existing "Step 7 —
Stabilization" section already has its own bullet list — PLAID fallback
removal, verification-script generalization, provider consistency checks,
data integrity audits, documentation/runbooks, a second read-path audit,
legacy-cleanup planning. None of those bullets match the eight areas this
investigation was scoped against (connection health, reconnect, retry/
backoff, diagnostics, production hardening are not named there at all). This
checklist should not be read as already-approved Step 7 scope — it's a
materially different set of concerns from what the roadmap currently labels
Step 7. Recommend the roadmap maintainer decide explicitly, when this is
reviewed, whether this work (a) expands Step 7's definition, (b) becomes its
own numbered step, or (c) is tracked outside the D2 initiative entirely
(relevant for item 5 below, which predates D2 and isn't provider-specific).
Not resolved here.

---

## Checklist

| # | Area | Already exists? | Code required? | Size | Order |
|---|---|---|---|---|---|
| 1 | Provider connection lifecycle | Mostly yes | No — gap fully absorbed into #2 | — | — |
| 2 | Connection health | Schema only, zero write-path | Yes | S–M | **1st** |
| 3 | Reconnect flows | Partially (mechanical relink only) | Yes | M | 4th |
| 4 | Orphaned connection cleanup | Yes, fully | No | — | Closed |
| 5 | Sync reliability | Built but never started | Yes (wiring only) | XS | **1st (tied)** |
| 6 | Retry / backoff | No | Yes | M | 3rd |
| 7 | Provider diagnostics | No | Yes | S | 5th |
| 8 | Production hardening (cross-cutting) | Partial, ad hoc | Minimal | S | Last |

Detail follows.

### 1. Provider connection lifecycle

**Exists, mostly.** Create: `exchange-token/route.ts` upserts `PlaidItem` by
`externalItemId` (L95-106); `wallet/route.ts` handles create / reactivate /
reshare in three branches. Disconnect: `disconnectPlaidItemIfOrphaned()`
(`lib/plaid/disconnect.ts`) revokes at Plaid and marks `REVOKED`. Self-heal:
`hasActiveLinkedAccount()` / `selfHealOrphanedPlaidItem()`
(`lib/plaid/refresh.ts` L285-313) close out connections with zero active
accounts before ever calling Plaid.

**Gap:** no transition to a credential-failure state (`NEEDS_REAUTH`/
`ERROR`) anywhere — that's entirely captured by #2 below. Recommend not
opening a separate lifecycle work item; track the one real gap under #2 so
it isn't designed twice.

**Code required:** No, beyond #2. **Order:** N/A.

### 2. Connection health

**Exists at the schema level only.** `PlaidItemStatus` already has
`NEEDS_REAUTH` and `ERROR` variants; `PlaidItem.errorCode` and
`Connection.errorCode` both exist (`prisma/schema.prisma` L54-59, 65-69,
499, 530). Confirmed by repo-wide grep: the only statuses any application
code ever writes are `ACTIVE` (on link/relink) and `REVOKED` (on disconnect).
`NEEDS_REAUTH` is never written. `errorCode` is never written outside the
`null` reset on successful relink. Every failure path —
`refreshPlaidItem()`'s uncaught `accountsGet` call,
`refreshAllActiveItemsForUser()`'s per-item catch (L359-373),
`jobs/sync-banks.ts`'s per-item catch (L50-53), `/api/plaid/sync`'s catch
(L58-61), `/api/plaid/refresh`'s single-item catch (L59-62) — only
`console.error`/`console.warn`s and swallows. A bank that revokes access
today leaves its `PlaidItem` permanently `ACTIVE` with no record of why
syncing stopped producing anything.

**Code required: Yes.** Extend `lib/plaid/errors.ts` (which already maps
Plaid `error_code` → user message) to also classify
`NEEDS_REAUTH | ERROR | RETRYABLE`, then write that classification into
`PlaidItem.status`/`errorCode` (and mirror onto the relevant
`AccountConnection.syncStatus`) inside the catch blocks that already exist
in `refresh.ts`, `syncTransactions.ts`, `sync-banks.ts`, and the two manual
routes. This is filling in existing control flow, not new branching.

**Size:** S–M. **Order: 1st** — #3, #6, and #7 all need this data to exist
before they have anything to read or react to.

### 3. Reconnect flows

**Exists, partially, mechanically.** Re-running full Plaid Link and posting
to `exchange-token` upserts the existing `PlaidItem` by `externalItemId`,
refreshes the encrypted token, clears `errorCode`, resets `status: ACTIVE`
(confirmed, L95-97). What's missing: (a) Plaid Link **update mode** isn't
used — `link-token/route.ts`'s `linkTokenCreate()` call never passes an
`access_token`, so a reconnecting user redoes full institution search and
credentials instead of Plaid's streamlined re-auth flow; (b) there is no
detection or prompt anywhere — confirmed zero non-comment "reconnect"
references in `components/` — so a user has no way to discover that a
connection needs attention short of noticing stale balances themselves.

**Code required: Yes**, two pieces: (i) update-mode support in
`link-token/route.ts` (pass `access_token` when re-authing a known item) —
small, isolated; (ii) a minimal UI affordance (badge + button) reading the
health state #2 writes. Piece (ii) cannot be built before #2 exists.

**Size:** M. **Order:** 4th — depends on #2.

### 4. Orphaned connection cleanup

**Exists, fully — no work needed.** Proactive self-heal on every refresh
(`hasActiveLinkedAccount`/`selfHealOrphanedPlaidItem`), explicit cleanup on
every account-delete/merge path (`disconnectPlaidItemIfOrphaned`,
`reconcile.ts`'s `closeOutAccountConnections`), plus a one-time remediation
script (`scripts/cleanup-orphaned-plaid-items.ts`) and its own verify script
(`scripts/verify-orphaned-plaid-items.ts`). This is the one area D2-6 and the
prior bugfix work already closed out completely.

**Code required:** No. **Status:** Closed — carry forward as done, do not
re-open.

### 5. Sync reliability

**Built, but never started — the most severe finding in this checklist.**
`jobs/scheduler.ts`'s `startScheduler()` (which would run `syncBanks` every
4h and `purgeTrash` daily) has no caller anywhere in the repo. Confirmed: no
`instrumentation.ts` file exists at any path in the project. `jobs/sync-banks.ts`
itself is well-built — per-item try/catch so one bad institution can't block
the rest, idempotent (upserts on `Transaction.plaidTransactionId`) — it's
simply never invoked outside of being called directly. The manual triggers
(`/api/plaid/sync`, `/api/plaid/refresh`) work, but depend entirely on a user
remembering to click something; nothing runs on its own today.

**Code required: Yes, minimal** — add the Next.js `instrumentation.ts`
entrypoint calling `startScheduler()`. Almost pure wiring; the job logic
already exists and is already isolated/idempotent.

**Size:** XS — smallest item on this list, and arguably the single
highest-leverage fix here, since right now zero scheduled sync runs in any
deployed environment regardless of what else ships. **Note:** this gap
predates D2 and isn't provider-specific (every comment that names it calls
it "a separate, pre-existing gap") — flagged here because "sync reliability"
was explicitly in scope for this review, but worth deciding whether it ships
under the D2-7 label or as its own unrelated fix, per the naming flag above.
**Order: 1st (tied with #2)** — zero dependency on anything else, and zero
behavior risk, since it turns on a job that currently does nothing.

### 6. Retry / backoff

**Does not exist.** Confirmed by repo-wide grep: no retry/backoff/exponential
logic anywhere in `app/`, `lib/`, or `jobs/` — the only two hits are comments
in `syncTransactions.ts` describing why the *cursor* design tolerates a
caller retrying the whole sync from scratch, not an actual retry mechanism.
`lib/plaid/client.ts` has no client-level retry config either. A transient
failure (rate limit, `INSTITUTION_DOWN`/`NOT_RESPONDING`) gets exactly one
attempt, then waits for the next scheduled run — today, never (per #5); once
#5 ships, four hours.

**Code required: Yes.** A small bounded-retry wrapper for genuinely
transient Plaid errors only. Must reuse #2's error classification to avoid
retrying terminal errors (`ITEM_LOGIN_REQUIRED` will never succeed without
user action — retrying it just burns API calls and delays the
`NEEDS_REAUTH` signal #3 depends on).

**Size:** M. **Order:** 3rd — depends on #2's classification existing.

### 7. Provider diagnostics

**Does not exist.** `app/api/admin/overview/route.ts` exists but only does
unrelated `.count()` stats; nothing anywhere surfaces `PlaidItem` health,
`errorCode`, `lastSyncedAt`, or sync success/failure counts. Every signal
that exists today only ever reaches `console.*`.

**Code required: Yes.** A read-only endpoint/admin view listing each
`PlaidItem`'s status/errorCode/lastSyncedAt/institution. Pure read, no new
write paths — can follow the existing admin-route pattern.

**Size:** S. **Order:** 5th — depends on #2 (nothing to show otherwise); can
run in parallel with #3/#6 once #2 lands.

### 8. Production hardening (cross-cutting)

**Partial, ad hoc.** Best-effort/non-fatal error handling is already a
strong house convention (snapshot regen, dual-writes all swallow and log
rather than blocking primary writes), and `lib/plaid/errors.ts` already
scrubs secrets from client-facing messages. What's missing is the
operational layer: every failure today is an unaggregated `console.error`,
and the now-running scheduler (#5) needs a sanity check that it can't
double-fire or overlap badly across serverless cold starts.

**Code required:** Minimal, and mostly wrap-up — promote the
highest-value `console.error` calls touched by #2/#5/#6 to a single
structured log point if one doesn't already exist elsewhere in the codebase
(check before adding a new one), plus a short runbook note pointing at the
new diagnostics view (#7).

**Size:** S. **Order:** Last — by definition sweeps up after #1/#2/#5/#6/#7
land; doing it first would mean hardening code paths that don't exist yet.

---

## Recommended execution order

1. **Wire the scheduler entrypoint** (`instrumentation.ts`) — sync
   reliability, XS, zero dependency, zero behavior risk.
2. **Connection health write-path** (error classification +
   `PlaidItemStatus`/`errorCode`/`syncStatus` writes) — S–M, foundation for
   3/4/5 below.
3. **Retry/backoff** for transient errors only — M, depends on 2.
4. **Reconnect flow** (update-mode link token + minimal UI surface) — M,
   depends on 2.
5. **Provider diagnostics** (read-only health view) — S, depends on 2; can
   run alongside 3/4.
6. **Production hardening wrap-up** (structured logging, overlap-safety
   check, runbook note) — S, last.

**Already closed, no work needed:** orphaned connection cleanup.
**Absorbed into #2 above, not a separate item:** provider connection
lifecycle.

Each numbered item above is independently approvable, per the project's
standing "checklist → approval → implement only that decision" rule — this
list is not a recommendation to build all six in one branch.

## Risks

- **#1 and #5 overlap risk.** Wiring the scheduler (#1 in this order) makes
  the existing-but-broken failure handling *more* visible (more scheduled
  runs hitting the same swallowed-error paths) before #2 fixes it. This is
  intentional — #1 has zero behavior risk on its own and shouldn't wait on
  #2 — but expect more `console.error` volume in the gap between shipping
  #1 and shipping #2, not a regression.
- **Retry storms.** #6, if built before #2's classification exists, risks
  retrying terminal errors (`ITEM_LOGIN_REQUIRED`) indefinitely. Sequencing
  protects against this; building #6 out of order would not.
- **Roadmap-naming collision.** As flagged above, this checklist's scope
  doesn't match `D2_ROADMAP.md`'s existing "Step 7 — Stabilization" bullet
  list. Shipping any of the above under a "Step 7" label without resolving
  that mismatch first risks the same kind of roadmap-vs-code drift
  `D2_STEP6_CLOSURE_DECISION.md` just finished cataloguing for Steps 2/3/6.

## Stop point

This report stops here. No item in the checklist is approved by virtue of
appearing in this document. Recommended next step: confirm the roadmap
naming question above, then approve item 1 and/or item 2 — the two
zero-dependency, foundation-laying pieces — before any file named in this
report is touched.
