> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 7C — Scheduler Wiring Checklist

**Investigation/checklist only. No code, schema, or migration changes were
made to produce this document.** Branch: `feature/phase-2-architecture`.
Baseline: `v2.3.0`.

Goal: wire `startScheduler()` so scheduled sync actually runs, with the
smallest safe change. D2-7A (connection health) and D2-7B (manual refresh
cooldown) are complete; this is the next slice.

Audited in full: `jobs/scheduler.ts`, `jobs/sync-banks.ts`,
`lib/plaid/syncTransactions.ts`, `lib/db.ts`, `app/api/plaid/refresh/route.ts`,
`app/api/plaid/sync/route.ts`, `next.config.ts`, `package.json`, `vercel.json`,
`docs/operations/DEPLOYMENT.md`, `docs/architecture/PHASE_2_DECISION_MATRIX.md`
(D5), `docs/initiatives/d2/D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md`
(item 5), plus a repo-wide check confirming no `instrumentation.ts`,
`middleware.ts`, or edge-runtime route exists anywhere today.

**Scope note:** D5 in the Decision Matrix already names this exact gap
("Job scheduler: entrypoint + missing jobs") and recommends fixing it as
independent infrastructure, not gated to any Phase 2 branch. This checklist
is that independent fix, scoped as narrowly as the known issue allows.

---

## Revision — approved direction (supersedes the original recommendation below)

The `instrumentation.ts` → `startScheduler()` path analyzed below was **not
approved**. Approved and implemented instead: a protected Vercel Cron route
that calls the existing `syncBanks()` directly, with no in-process timer at
all. This sidesteps the entire reliability problem in Risk #1–#3 below rather
than accepting it — `instrumentation.ts` is not added, `startScheduler()` is
not invoked, and `jobs/scheduler.ts`'s `setInterval`-based scheduling stays
exactly as dormant as it was before this slice.

**What shipped:**
- `app/api/jobs/sync-banks/route.ts` — `GET`, protected by
  `Authorization: Bearer ${CRON_SECRET}` (Vercel sends this automatically on
  cron-triggered requests), calls `syncBanks()`, returns its result as JSON.
- `vercel.json` — daily cron entry (`0 6 * * *`) targeting that route. Daily
  because Vercel's Hobby plan rejects any cron expression more frequent than
  once/day (confirmed in Q5/Q8 research below) — this resolves the
  previously-deferred Q5 by way of a platform constraint, not a product
  choice.
- `jobs/sync-banks.ts` — `syncBanks()` now returns `{ succeeded, failed,
  total }` instead of `void`, so the route has something to report. No
  change to the fetch/loop/error-handling logic itself.
- `jobs/scheduler.ts` — one-line type change so the still-dormant
  `scheduleInterval(syncBanks, ...)` call stays type-compatible with
  `syncBanks`'s new return type. `startScheduler()` remains uncalled.
- `.env.example` — documented `CRON_SECRET` placeholder.

Local dev and Preview stay manual-only (`/api/plaid/sync`, `/api/plaid/refresh`)
— Vercel Cron only fires against Production deployments.

The Q&A and risk analysis below is kept as the investigation record that led
to this decision (in particular, it's what surfaced the Hobby-plan daily cap
and the serverless persistent-process problem) — read it as "why we didn't
take the instrumentation.ts path," not as the implemented design.

---

## Answers to the 8 scoping questions

### 1. Correct Next.js entrypoint?

A root-level `instrumentation.ts` (sibling to `next.config.ts`), exporting an
async `register()` function. Confirmed: no `instrumentation.ts` exists at any
path, no custom server (`server.js`), no `middleware.ts`. Next.js is on
`16.2.7` (`package.json`), where `instrumentation.ts` is stable — no
`experimental.instrumentationHook` flag needed in `next.config.ts`. There is
no other "app started" lifecycle hook in this framework; `instrumentation.ts`
is the only candidate.

### 2. Is `instrumentation.ts` the right place in this app?

Yes, with a caveat that matters more than the question implies. It's the
only Next.js-native entrypoint available, and it's exactly what
`jobs/scheduler.ts`'s own header comment, the D2 Step 7 production-hardening
investigation, and Decision Matrix D5 already point to.

The caveat: this app deploys to **Vercel** (`vercel.json`, `.vercel/` project
link, `docs/operations/DEPLOYMENT.md`'s "Vercel + Supabase" architecture —
Docker is Postgres-only, for local dev). Vercel runs Next.js as ephemeral
serverless functions, not an always-on process. `register()`'s `setInterval`
timers only keep ticking for as long as that particular function instance
stays warm — there's no guarantee of that, and no guarantee only one
instance exists. This is a documented platform characteristic, not specific
to this codebase ([Next.js instrumentation docs](https://nextjs.org/docs/app/guides/instrumentation);
[Vercel/Next.js discussion on background jobs](https://github.com/vercel/next.js/discussions/33989)).

This project has already reasoned about the same constraint once: D2-7B's
checklist rejected an in-process cooldown cache specifically because "the
app deploys serverless... an in-process map wouldn't be shared across
function instances." A `setInterval` timer is the same kind of in-process
state, just ticking instead of caching. `instrumentation.ts` is still the
correct entrypoint — there's no better one — but "correct entrypoint" isn't
the same as "guaranteed cadence in production." See Risks.

### 3. Avoiding duplicate intervals?

Two different problems, only one of which this slice can fix:

- **Dev / Fast Refresh (fixable here).** `next dev` can re-invoke
  `register()` across recompiles. Guard with the same pattern `lib/db.ts`
  already uses for the Prisma singleton: a `globalThis` flag checked and set
  inside `startScheduler()` itself, so a second call in the same process is a
  no-op.
- **Cross-instance duplication on Vercel (not fixable at this size).** If two
  serverless instances are warm at once, each independently runs its own
  `register()` → `startScheduler()` → its own timer. An in-process guard
  can't see across instances. The only complete fixes are bigger than this
  slice (Vercel Cron hitting a single route with no in-process timer at all,
  or a DB-level claim/lock). Mitigation in the meantime: `syncTransactionsForItem`
  is already documented as idempotent and safe to overlap (upserts on
  `plaidTransactionId`), so a duplicate concurrent run is wasteful, not
  destructive.

### 4. Cadence: keep as-is, or add a config constant?

Keep `jobs/scheduler.ts` exactly as written — `4 * HOUR` for `syncBanks`,
`scheduleDaily(purgeTrash, 1, 0)` for trash purge. Introducing an env/config
constant is itself a small feature (parsing, validation, fallback) that
doesn't belong in a "smallest implementation" wiring slice, and the prompt
already rules out adaptive scheduling.

### 5. Daily prod / 6h dev-preview cadence — now or defer?

Defer. Two reasons: it's a cadence/config change (see Q4 — out of scope
here), and it implicitly assumes the Vercel Cron approach, which this slice
isn't adopting. For the record, since it bears on a future decision:
**Vercel's Hobby plan caps cron jobs at once per day per project** — a
sub-daily expression fails deployment outright. A 6h or 4h cadence via
Vercel Cron would require a Pro-plan upgrade. That's a separate, explicit
decision for whoever owns the Vercel billing relationship, not something to
fold into this wiring slice.

### 6. Exact files to change?

- **New:** `instrumentation.ts` (repo root). Minimal `register()` calling
  `startScheduler()`, guarded to `process.env.NEXT_RUNTIME === "nodejs"`.
  (No edge runtime exists anywhere in this app today, so this guard is
  defensive boilerplate, not a fix for an active problem — cheap to include,
  matches Next.js's own documented convention.)
- **Edit:** `jobs/scheduler.ts` — add the `globalThis` re-entry guard inside
  `startScheduler()` (a few lines; no change to job list, cadence, or logic).
  Update the header comment (lines 6–13), which currently asserts
  "`startScheduler()` is not yet invoked anywhere" — that becomes false once
  this ships.
- **Optional, same commit, cosmetic only:** the matching stale notes in
  `jobs/sync-banks.ts` (~line 13) and `lib/plaid/syncTransactions.ts` (~line
  15) say the same thing and would otherwise be left actively misleading.
- **No** schema, route, or UI changes anywhere.

### 7. Local validation?

- `npm run dev` → confirm exactly one `[scheduler] Started — ...` log line on
  boot.
- Edit an unrelated file a few times to trigger Fast Refresh → confirm the
  log does **not** print again (proves the re-entry guard works).
- `npx tsc --noEmit`, `npm run lint`.
- `npm run build` (= `prisma generate && next build`) → confirms
  `instrumentation.ts` doesn't break the production build.
- `npx prisma generate` → expect no diff (no schema touched).
- Optional, uncommitted: temporarily shorten the interval to 1–2 minutes
  locally to watch `[sync-banks]` actually fire, then revert before
  committing.

### 8. Vercel/Preview validation?

- Push to a Preview deployment; open Vercel's Runtime Logs (or
  `vercel logs <url> --follow`) and send a few requests to keep an instance
  warm.
- Confirm `[scheduler] Started` and, later, `[sync-banks]` log lines appear.
- Watch specifically for the two failure modes this carries by design (see
  Risks): the same `Started` line firing more than once close together
  (independent instances, not preventable here), and `[sync-banks]` going
  silent for a long idle stretch (instance froze/scaled to zero, timer died
  with it).
- Confirm the Vercel build log shows `prisma generate && next build`
  succeeding with `instrumentation.ts` present. No `vercel.json` change or
  project-setting change is required for `instrumentation.ts` itself.

---

## Recommendation

Wire `instrumentation.ts` → `startScheduler()` now, with the dev re-entry
guard, exactly matching the existing design intent (`jobs/scheduler.ts`'s own
comment), the prior production-hardening investigation, and Decision Matrix
D5. This is strictly an improvement over today: scheduled sync currently
never runs, anywhere, in any environment. After this change, the worst case
on Vercel is "runs best-effort, only while an instance is warm" — which
still dominates "never runs at all." Treat production reliability as a
flagged, accepted risk for this slice, not a blocker for shipping the
wiring — and treat "should we move to Vercel Cron instead" as a separate,
later, explicitly-approved decision, not part of 7C.

## Minimal implementation checklist (for the approved slice, not yet authorized)

1. Add `instrumentation.ts` at repo root: nodejs-runtime-guarded `register()`
   calling `startScheduler()`.
2. Add a `globalThis`-based re-entry guard inside `startScheduler()` in
   `jobs/scheduler.ts` (same pattern as `lib/db.ts`'s Prisma singleton).
3. Correct the stale "never invoked" comment in `jobs/scheduler.ts`
   (and optionally the two matching notes in `jobs/sync-banks.ts` /
   `lib/plaid/syncTransactions.ts`).
4. No schema, migration, route, or UI changes.

## Risks

1. **Vercel serverless functions are not a persistent process.** This is the
   primary risk. `register()` runs once per function instance; Vercel can
   freeze or recycle idle instances and scale to zero with no traffic.
   "Every 4 hours" becomes "approximately, whenever some instance happens to
   be warm" — not a guarantee.
2. **Cross-instance duplication isn't preventable at this size.** Concurrent
   warm instances each run their own timer. Mitigated only by
   `syncTransactionsForItem`'s existing idempotency, not eliminated.
3. **Redeploys reset the timer's clock.** `scheduleInterval` for `syncBanks`
   runs "every 4h from process boot," not wall-clock-anchored — unlike
   `purgeTrash`'s UTC-anchored daily schedule, which self-corrects after a
   restart. Frequent deploys on an active branch mean actual cadence will
   drift in production.
4. **Edge-runtime double registration — low risk, defensively guarded.** No
   edge runtime exists anywhere in this app today (no `middleware.ts`, no
   `export const runtime = "edge"`), so this isn't an active problem, but the
   `NEXT_RUNTIME` guard costs nothing and matches Next.js's own documented
   pattern.
5. **Stale doc comments become misleading if left unfixed** — three files
   currently assert this was never wired up; that stops being true the
   moment this ships.

## Validation plan

Local: `npm run dev` boot-log check, Fast Refresh duplicate-log check,
`npx tsc --noEmit`, `npm run lint`, `npm run build`, `npx prisma generate`
(expect no diff).

Preview/Vercel: deploy, tail Runtime Logs while sending traffic, confirm
`[scheduler] Started` and `[sync-banks]` lines appear, watch for duplicate
near-simultaneous `Started` lines and for long silent gaps, confirm the
build log is clean.

---

## Stop point — superseded

Originally: "no files touched, waiting for approval." Superseded by the
Revision section above — the Vercel Cron route direction was approved and
implemented. See that section for the final file list. Remaining
follow-ups, not part of this slice: deciding whether daily cadence is
sufficient long-term or whether a Pro-plan upgrade for sub-daily Cron is
worth it, and whether to ever revisit `instrumentation.ts` for anything
unrelated to bank sync (e.g. one-time env validation at boot, which doesn't
have the persistent-timer problem).

Sources consulted for present-day platform facts (Vercel Cron limits,
serverless function lifecycle):
- [Vercel Cron Jobs — Usage & Pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Vercel — Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Next.js — Instrumentation guide](https://nextjs.org/docs/app/guides/instrumentation)
- [vercel/next.js discussion #33989 — Running background jobs](https://github.com/vercel/next.js/discussions/33989)
