> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 7D — Retry / Backoff Checklist

**Investigation/checklist only. No code, schema, or migration changes were
made to produce this document.** Branch: `feature/phase-2-architecture`.
Baseline: `v2.3.0`.

Goal: bounded retry/backoff around transient Plaid/infrastructure failures
only, without retrying terminal errors. D2-7A (connection health), D2-7B
(manual refresh cooldown), and D2-7C (cron route) are complete; this is the
next slice — item #6 ("Retry / backoff") in
`D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md`, which already concluded it
depends on #2 (7A's classification) and rated it size M.

Audited in full: `lib/plaid/errors.ts`, `lib/plaid/refresh.ts`,
`lib/plaid/syncTransactions.ts`, `jobs/sync-banks.ts`,
`app/api/plaid/refresh/route.ts`, `app/api/plaid/sync/route.ts`. Also
checked, because they materially bound the recommendation: `lib/plaid/client.ts`
(no client-level retry/interceptor exists), `app/api/jobs/sync-banks/route.ts`
(D2-7C's cron entrypoint — `maxDuration = 60`, its own header comment
explicitly states "No retry/backoff here"), `lib/plaid/refreshCooldown.ts`
(D2-7B — confirmed structurally independent, see §6), `vercel.json` (Hobby
daily cron, `sin1` region), and the `PlaidItem` model/`PlaidItemStatus` enum
in `prisma/schema.prisma` (confirmed no retry-count or attempt field exists
today, and none is proposed here).

---

## 1. Which existing Plaid errors should be considered retryable?

Reuse `lib/plaid/errors.ts`'s existing `TRANSIENT_CODES` set as the baseline
— it already exists precisely because these four codes are transient/
provider-outage, not credential failures:

- `ITEM_LOCKED`
- `INSTITUTION_DOWN`
- `INSTITUTION_NOT_RESPONDING`
- `PRODUCT_NOT_READY`

**Explicitly not retryable (terminal — matches the prompt's rules exactly):**
`ITEM_LOGIN_REQUIRED`, `INVALID_ACCESS_TOKEN` (both `NEEDS_REAUTH` —
retrying a dead credential just burns calls and delays the reconnect
signal), `INVALID_ENVIRONMENT`, `SANDBOX_ONLY` (config errors — retrying
won't change a misconfigured deployment), `INSTITUTION_NO_LONGER_SUPPORTED`,
and any unrecognized `error_code`. `classifyPlaidErrorForHealth()` already
treats this whole bucket as `ERROR`/unrecoverable-until-investigated — being
conservative on "unknown" prevents a retry storm on a code this codebase
doesn't understand yet.

Two additions beyond the existing `TRANSIENT_CODES` set, flagged as **open
questions** (§ below) since they're new classification surface, not a reuse
of something already named in `errors.ts`:

- **HTTP `429`.** `classifyPlaidErrorForHealth()` already special-cases this
  (`if (status === 429) return null;` — log only, no status write). That's a
  health-bucket decision, not a retry decision — 429 is the textbook
  retryable case (rate limit), and today it gets exactly one attempt then
  silence until the next scheduled run.
- **Raw network-level errors** (timeout, `ECONNRESET`, DNS failure — i.e.
  errors with no `err.response` at all). `isAxiosError()` requires
  `"response" in err`, so a request that never got a response today doesn't
  match `TRANSIENT_CODES`, doesn't match `NEEDS_REAUTH_CODES` — it falls
  through to `classifyPlaidErrorForHealth`'s `!isAxiosError(err)` → `null`
  guard, i.e. logged and ignored. These are exactly the "infrastructure"
  failures the prompt's rules name, but recognizing them needs a different
  check than the existing code-based classification (e.g. "no `response`
  object present" rather than "specific `error_code`").

## 2. Where should retry logic live: wrapper helper, Plaid client, refresh.ts, syncTransactions.ts, or route/job layer?

**A small new wrapper helper**, not any of the other four options:

- **Not `lib/plaid/client.ts`** (e.g. an axios interceptor on the shared
  `plaidClient`). That client is also used by `link-token`/`exchange-token`/
  `create-link-token` — interactive, user-initiated flows outside this
  slice's scope. A global interceptor would silently add retry-with-delay
  latency to those routes too, which is a UX change to flows this checklist
  was never asked to touch ("Do not change reconnect UI").
- **Not the route/job layer** (`app/api/plaid/refresh/route.ts`,
  `app/api/plaid/sync/route.ts`, `jobs/sync-banks.ts`). Those only ever see
  the *aggregate* per-item failure today (`refreshPlaidItem()` or
  `syncTransactionsForItem()` throwing) — retrying at that level means
  re-running the entire item pipeline from the top on every transient blip,
  including steps that already succeeded (e.g. re-running `accountsGet` and
  re-writing balances because `investmentsHoldingsGet` hiccuped).
- **Not embedded directly in `refresh.ts`/`syncTransactions.ts`'s existing
  logic.** Matches the D2-7B precedent: cooldown logic was kept in its own
  file (`lib/plaid/refreshCooldown.ts`) rather than folded into
  `refresh.ts`, specifically so the mechanism stays reusable and the
  business-logic files stay focused. The same separation applies here.

**Recommended:** a new `lib/plaid/retry.ts`, exporting one generic
`withPlaidRetry<T>(fn: () => Promise<T>, label: string): Promise<T>` that:
(a) calls `fn()`, (b) on failure, checks retryability via a classifier, (c)
if retryable and attempts remain, waits the backoff delay and retries, (d)
otherwise re-throws the original error unchanged. The retryability
classifier itself (§1's logic) is recommended to live in `lib/plaid/errors.ts`
alongside `TRANSIENT_CODES`/`classifyPlaidErrorForHealth` — it's
error-domain knowledge that already lives there, not retry-mechanism logic.
This requires exporting the currently-private `isAxiosError()` (or an
equivalent check) from `errors.ts` so `retry.ts` can reuse it instead of
duplicating the type guard. (Flagged as an open question below — splitting
"what's retryable" from "how to retry" across two files is a structural
call worth confirming, not just a default.)

## 3. Should retry wrap accountsGet, transactionsSync, investmentsHoldingsGet, or only the top-level item sync?

**The individual Plaid SDK calls, not the top-level item sync function.**
Three call sites, wrapped at the point of the actual SDK call:

- `lib/plaid/refresh.ts`'s `plaidClient.accountsGet(...)` (step 1).
- `lib/plaid/refresh.ts`'s `plaidClient.investmentsHoldingsGet(...)` (step
  2) — already wrapped in its own non-fatal try/catch today. Retrying
  before that catch swallows the error is cheap and doesn't change its
  non-fatal nature; flagged below as a minor scope question since it's a
  slight expansion beyond "just the core sync."
- `lib/plaid/syncTransactions.ts`'s `plaidClient.transactionsSync(...)`
  call, *inside* the existing `while (hasMore)` loop — i.e. retry one
  page's call, not the whole paginated loop.

**Why not wrap `syncTransactionsForItem()`/`refreshPlaidItem()` as a single
unit instead:** both already have documented idempotent/resumable designs
(`syncTransactionsForItem`'s cursor commits only after the full loop
succeeds; per-transaction writes inside the loop are individually
idempotent via the `plaidTransactionId` upsert). Retrying at the SDK-call
level is strictly smaller-blast-radius than re-running an entire item from
scratch, and doesn't touch that existing cursor-commit design at all — it
just gives one flaky page-fetch a second try before the existing "let it
throw, caller/next scheduled run retries from last persisted cursor"
behavior kicks in.

## 4. What max attempts/backoff values are safe for D2?

Recommended: **2 total attempts (1 retry), fixed ~1s delay** — no
exponential growth at this attempt count; there's nothing to grow.

Driving constraint: D2-7C's cron route (`app/api/jobs/sync-banks/route.ts`)
sets `maxDuration = 60` (Vercel Hobby plan ceiling) and loops over **every**
active `PlaidItem` in one invocation. Backoff delay is additive *per
retried call, per item*, inside that shared 60s budget — "keep max attempts
low" isn't just a style preference here, it's load-bearing for the cron
route not timing out. Three attempts with any meaningful delay (e.g. 1s +
2s) starts to matter once the active-item count is non-trivial; two
attempts at ~1s keeps the worst-case added latency small and predictable.

Recommend a local constant in the new `retry.ts` (mirroring
`refreshCooldown.ts`'s `MANUAL_REFRESH_COOLDOWN_MS` pattern) —
`MAX_PLAID_RETRY_ATTEMPTS = 2`, `PLAID_RETRY_DELAY_MS = 1000` — not
env-configurable and not provider-configurable, per the "no provider
catalog/config yet" rule.

## 5. How should retry interact with D2-7A health classification?

**Retry runs first; classification is unchanged and only ever sees the
final outcome.** The wrapper retries only codes in §1's retryable set; for
everything else (`NEEDS_REAUTH_CODES`, config errors, unrecognized codes)
it throws on the first failure, exactly as today — 7A's classification
timing for terminal errors doesn't move at all.

For retryable codes that still fail after the final attempt, the wrapper
re-throws the original error unchanged, and the four catch blocks 7A
already instrumented (`refresh.ts`'s `refreshAllActiveItemsForUser`, the
refresh route, the sync route, `jobs/sync-banks.ts`) call
`classifyPlaidErrorForHealth()` exactly as they do today. Because
`TRANSIENT_CODES` already returns `null` from that function (log only, no
`PlaidItem.status` write — see `errors.ts`'s own comment on why: writing
`ERROR` for a transient blip would permanently lock the item out of every
`status: ACTIVE` query with no retry/backoff or reconnect UI to recover it
"yet"), a transient error that exhausts both retry attempts **still** logs
only and leaves `status` unchanged. Retry does not promote a transient
error to a worse health bucket just because it failed twice — it only
changes how many chances the call gets before that existing, unchanged
classification logic runs.

## 6. How should retry interact with manual cooldown?

**No interaction, by construction — zero changes to `refreshCooldown.ts` or
either route's cooldown check.** Cooldown (D2-7B) gates whether an attempt
happens at all, checked once in the route layer before
`refreshPlaidItem()`/`syncTransactionsForItem()` is ever called; retry
happens entirely *inside* that one allowed attempt, several layers further
down at the individual SDK-call level. `markManualRefreshed()`/
`markManyManualRefreshed()` are called once per route invocation today,
regardless of how many Plaid calls happen underneath — that doesn't change
just because one of those underlying calls might now retry once internally.
This mirrors D2-7B's own design intent: cooldown only knows about "one
manual attempt," never about what happens inside the sync pipeline it
gates.

## 7. Should failed final attempt update PlaidItem health state using existing 7A behavior?

**Yes, unchanged — see §5.** No new health states, no new schema field, no
new write path. The final error (whatever it is, after retries are
exhausted or skipped for a terminal code) flows into the exact same four
catch blocks and the exact same `classifyPlaidErrorForHealth()` call 7A
already shipped.

## 8. Should retry attempts be logged?

**Yes, minimally — `console.warn` per retry, no new logging
infrastructure.** Matches the existing house convention for non-fatal/
retryable conditions already in these files (e.g. `refresh.ts`'s
`[refreshPlaidItem] investmentsHoldingsGet failed ... (non-fatal)` warning,
the `[plaid][D2-3E]`/`[D2-3F]` coverage-gap warnings). Recommended shape:
one `console.warn` per retry attempt naming the wrapped call (`label`
param), attempt number, and `error_code` — enough to spot a pattern in
existing logs without adding a structured logging system or a persisted
attempt-count field. A new structured logging system and a real
diagnostics surface are already named as separate, later items (#7/#8) in
`D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md` — out of scope here. Final-
attempt failure still goes through the existing `console.error` +
classification path, unchanged.

## 9. Smallest implementation checklist (not yet approved)

1. **New file `lib/plaid/retry.ts`** — generic `withPlaidRetry<T>(fn, label)`
   wrapper. Local constants `MAX_PLAID_RETRY_ATTEMPTS = 2`,
   `PLAID_RETRY_DELAY_MS = 1000`. No schema, no env var, no provider config.
2. **`lib/plaid/errors.ts`** — export the existing `isAxiosError()` (or add
   one small `isRetryablePlaidError(err): boolean` function reusing it) so
   `retry.ts` doesn't duplicate the type guard. Add `429` and the
   no-`response`/network-error case to the retryable check, pending sign-off
   on the two open questions in §1.
3. **`lib/plaid/refresh.ts`** — wrap the `accountsGet` call (step 1) and the
   `investmentsHoldingsGet` call (step 2) in `withPlaidRetry(...)`. No other
   change to either step's surrounding logic.
4. **`lib/plaid/syncTransactions.ts`** — wrap the `transactionsSync` call
   inside the existing `while (hasMore)` loop in `withPlaidRetry(...)`. No
   change to the loop structure, cursor handling, or per-transaction
   upsert/fingerprint logic.
5. **No changes** to the four health-classification catch blocks (7A), to
   `lib/plaid/refreshCooldown.ts` or either manual route's cooldown check
   (7B), to `jobs/scheduler.ts`/`vercel.json`/the cron route's cadence (7C),
   to any UI, or to `prisma/schema.prisma`.

## 10. Validation plan

- `npx tsc --noEmit`, `npm run lint`. `npx prisma generate` per standing
  process (no schema touched, so expect no diff); `npx prisma migrate dev`
  not needed.
- Targeted, sandbox item, no production data:
  - Stub/mock the Plaid client call (Plaid sandbox has no built-in way to
    simulate `INSTITUTION_DOWN`/`ITEM_LOCKED`/`PRODUCT_NOT_READY` on demand
    the way `/sandbox/item/reset_login` simulates `ITEM_LOGIN_REQUIRED`) to
    return a transient code on attempt 1 and succeed on attempt 2 — confirm
    exactly 2 attempts occur (log count) and the call ultimately succeeds.
  - Stub a transient code on every attempt — confirm exactly
    `MAX_PLAID_RETRY_ATTEMPTS` attempts occur, then confirm the final
    failure reaches the existing 7A catch block unchanged (status stays as
    7A's `TRANSIENT_CODES` behavior dictates — unchanged, log only).
  - Force real `ITEM_LOGIN_REQUIRED` via
    `/sandbox/item/reset_login` and confirm exactly **one** attempt occurs
    (no retry) and `PlaidItem.status` becomes `NEEDS_REAUTH` exactly as
    today, with no added delay.
  - Confirm a normal, healthy sandbox item completes a full sync with zero
    retries and no behavior change.
  - Call `/api/plaid/refresh` (single item) twice within the 7B cooldown
    window regardless of any internal retry on the first call — confirm the
    second call still returns `429`/cooldown as before (proves no
    double-marking from retries).
- Estimate worst-case added latency for the D2-7C cron route:
  (active item count) × (`MAX_PLAID_RETRY_ATTEMPTS` − 1) ×
  `PLAID_RETRY_DELAY_MS`, summed across however many of the 3 wrapped calls
  a given run actually hits transient failures on. Confirm this stays
  comfortably under the route's `maxDuration = 60` for realistic item
  counts; flag explicitly if not.

---

## Open questions — need explicit sign-off before any file is touched

1. **Retryable set beyond `TRANSIENT_CODES`** (§1). Recommended: yes to
   both additions — HTTP `429` (today logged-only via
   `classifyPlaidErrorForHealth`'s special case, but it's the textbook
   retryable signal) and raw network-level errors with no `err.response`
   (today fall through `isAxiosError()` entirely and are never classified
   at all). Both require new checks beyond the existing code-based
   `TRANSIENT_CODES` lookup.
2. **Split of "what's retryable" (`errors.ts`) vs. "how to retry"
   (`retry.ts`)** (§2). Recommended: keep the split — reuses existing
   error-domain logic, keeps the wrapper itself generic/dumb. Alternative:
   put everything in one new file if a tighter diff to `errors.ts` is
   preferred.
3. **Exact attempts/backoff constants** (§4). Recommended: 2 total attempts,
   flat ~1s delay. Open to a different number, but flagging that the D2-7C
   cron route's 60s budget across all active items argues against anything
   larger without also revisiting that route's duration headroom.
4. **Wrap `investmentsHoldingsGet` too, or leave it single-attempt** (§3).
   It's already non-fatal/best-effort, so retrying it is low-risk, but it's
   a slight expansion beyond "the core sync" the prompt's framing centers
   on. Recommended: wrap it — cheap, consistent, doesn't change its
   non-fatal contract.

Recommended next step: confirm questions 1–4, then approve §9 as the full
scope of Step 7D.

## Stop point

This document stops here. No item above is approved by virtue of appearing
in this checklist. No code, schema, migration, route, or UI file has been
touched to produce it.
