> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 7G — Production Hardening / Closeout Audit

**Audit only. No code, schema, migration, route, or UI file has been touched
to produce this document.** Branch: `feature/phase-2-architecture`. Baseline:
`v2.3.0`. Working tree confirmed clean at audit time; `npx tsc --noEmit` and
`npm run lint` both pass with zero errors (lint: 4 pre-existing warnings,
unrelated to this work).

Scope: end-to-end audit of the provider/connection subsystem now that
D2-7A through D2-7F are claimed complete. Answers the 8 questions posed for
this closeout, with direct evidence (file/line, commit hash, or doc
citation) for every claim.

Audited directly (code): `prisma/schema.prisma` (`PlaidItem`, `Connection`,
`AccountConnection`, `ConnectionStatus`, `PlaidItemStatus`, `ImportBatch`),
`lib/plaid/errors.ts`, `lib/plaid/retry.ts`, `lib/plaid/refreshCooldown.ts`,
`lib/plaid/refresh.ts`, `lib/plaid/syncTransactions.ts`, `lib/plaid/disconnect.ts`,
`jobs/sync-banks.ts`, `jobs/scheduler.ts`, `app/api/jobs/sync-banks/route.ts`,
`vercel.json`, `app/api/plaid/link-token/route.ts`,
`app/api/plaid/create-link-token/route.ts`, `app/api/plaid/refresh/route.ts`,
`app/api/plaid/sync/route.ts`, `context/PlaidContext.tsx`,
`components/dashboard/AccountCard.tsx`, `components/dashboard/ReconnectAccountButton.tsx`,
`lib/data/accounts.ts`, `app/admin/providers/page.tsx`,
`components/admin/AdminNav.tsx`, `lib/accounts/provider-identity.ts`,
`lib/imports/provider-capabilities.ts`, `lib/audit-actions.ts`, `.gitignore`,
plus a repo-wide grep pass for `Connection`/`startScheduler`/`AuditAction`
usage and `git log`/`git status`. Audited directly (docs): `D2_ROADMAP.md`,
`D2_STEP7A` through `D2_STEP7F` checklists, `D2_STEP6_CLOSURE_DECISION.md`,
`D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md`,
`D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md`,
`docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` §§9, 13, 14, 16, 17.

---

## Executive summary

D2-7A through D2-7F are implemented in the live codebase essentially as
their checklists specified — verified directly against current file
contents, not just trusted from the checklists' own self-reported status.
Two small deviations exist (relocated files, not missing work — see Q1) and
one real, if low-severity, coverage gap exists (no audit-log trail for
health-state transitions — see Q6). No blocker was found that requires
implementation. The roadmap document itself, however, is stale in two
places, and one of those staleness issues is a direct recurrence of a
labeling problem the project has already hit and fixed once before (the
"3G" collision). Full answers below.

---

## 1. Does the implemented architecture match the roadmap?

**Mostly yes, with two relocations and one scope nuance, none of which are
blockers.**

Every file-level change specified in the 7A–7F checklists was verified
directly against current code:

- **7A** (connection health) — `classifyPlaidErrorForHealth` exists exactly
  as specified in `lib/plaid/errors.ts:136-153`; all four catch sites
  (`refresh.ts:384-392`, `app/api/plaid/refresh/route.ts:73-82`,
  `app/api/plaid/sync/route.ts:98-106`, `jobs/sync-banks.ts:60-69`) call it
  and write `PlaidItem.status`/`errorCode`; the success path
  (`syncTransactions.ts:278-281`) resets to `ACTIVE`/`null`. Matches spec.
- **7B** (manual refresh cooldown) — `PlaidItem.lastManualRefreshAt` exists
  (`schema.prisma:505`, migration `20260630121903_d2_step7b_plaiditem_last_manual_refresh_at`
  applied), `lib/plaid/refreshCooldown.ts` exists with the specified
  1-hour constant and helpers, wired into both manual routes, and
  confirmed absent from `jobs/sync-banks.ts` (scheduled sync correctly
  ignores it, by construction). Matches spec.
- **7C** (scheduler/cron) — `app/api/jobs/sync-banks/route.ts` exists with
  `CRON_SECRET` Bearer auth, `vercel.json` has the daily cron entry,
  `syncBanks()` returns `{succeeded, failed, total}`. No `instrumentation.ts`
  exists anywhere in the repo; `startScheduler()` is confirmed still never
  called. This matches the checklist's own **Revision** section, which
  explicitly abandoned the original `instrumentation.ts` plan in favor of
  Vercel Cron — so the "still-dormant scheduler" state is intentional, not
  drift. Matches the *as-shipped* spec.
- **7D** (retry/backoff) — `lib/plaid/retry.ts` exists, exporting
  `withPlaidRetry` with `MAX_PLAID_RETRY_ATTEMPTS = 2` /
  `PLAID_RETRY_DELAY_MS = 1000`; `errors.ts` exports
  `isRetryablePlaidError` covering HTTP 429 and raw network errors in
  addition to `TRANSIENT_CODES`; all three specified call sites
  (`refresh.ts`'s `accountsGet`/`investmentsHoldingsGet`,
  `syncTransactions.ts`'s `transactionsSync`) are wrapped. Matches spec.
- **7E** (reconnect flow) — `link-token/route.ts` accepts `plaidItemId`,
  performs an ownership-scoped lookup, decrypts, and passes `access_token`
  in update mode (`app/api/plaid/link-token/route.ts:30-71`);
  `PlaidContext.tsx`'s `openLink` forwards it. **Deviation:** the
  `needsReauth`/`plaidItemId` exposure was specified for
  `app/api/accounts/route.ts`, but that file was left untouched — the field
  was added instead to `lib/data/accounts.ts`'s `getAccounts()` (the
  server-side loader the dashboard actually uses), joined through
  `AccountConnection` → `PlaidItem`, scoped per-connection-owner exactly as
  the checklist's Risk #5 required. The reconnect badge itself was
  extracted into its own `components/dashboard/ReconnectAccountButton.tsx`
  rather than inlined in `AccountCard.tsx`. Functionally equivalent to the
  spec's intent; the checklist's specific file list was inaccurate, not the
  implementation.
- **7F** (provider diagnostics) — `app/admin/providers/page.tsx` exists,
  server component, no paired API route (per the checklist's own
  recommendation to defer one), selects exactly the Q2 field list via
  `db.plaidItem.findMany()`, counts through `connections` (not legacy
  `accounts`), never selects `encryptedToken`/`cursor`. `AdminNav.tsx` has
  the "Providers" entry. Matches spec, including resolving the checklist's
  open Risk #2 (REVOKED rows are shown, consistent with every other admin
  page's "show full history" convention — confirmed via direct read of the
  shipped page, no `where` filter excludes any status).

All 6 commits cited by the checklists exist verbatim in `git log`
(`19456ff`, `1879dab`, `444cb6c`, `ad4415d`, `8e67be2`, plus `6c28d32` for
7F, not itself cited by an earlier doc since it's the last slice). Working
tree is clean; nothing is half-applied or uncommitted.

**One scope nuance worth surfacing, not a mismatch:** the Architecture
Freeze's §16 branch sequencing (`feature/provider-adapter-layer`) describes
a larger eventual scope for this same decision (D2/D13) than anything
implemented so far — four shape-specific `Connection` detail tables
(`AggregatorConnectionDetail`, `ExchangeConnectionDetail`,
`BrokerageConnectionDetail`, `ImportConnectionDetail`), a `DiscoveredAccount`
model, and a formal `ProviderAdapter` interface (§13). None of those exist
in `prisma/schema.prisma` today — only the precursor `Connection` (still
unpopulated by any application code, confirmed by repo-wide grep returning
zero `db.connection.`/`prisma.connection.` hits outside docs) and
`ProviderAccountIdentity` models exist. **D2 Steps 1–7 as implemented are
real, working progress toward that eventual Architecture-Freeze-level
target, not the full target itself.** This matters for Q8.

## 2. Are there stale roadmap items that should be marked complete?

**Yes — two, both in `D2_ROADMAP.md`, both confirmed against live evidence:**

**Step 5** (`D2_ROADMAP.md:76`) reads "⏳ Planned. Not started." This is
contradicted by the roadmap's own Step 6 section two sections later
(`D2_ROADMAP.md:89`), which cites a shipped Step 5 deliverable
(`lib/imports/provider-capabilities.ts`, commit `18f0922`) as "already
validated." Direct read of that file confirms it: its own header says
"D2 Step 5, slice #1" and it is real, in-use code (imported by
`app/api/accounts/[id]/import/route.ts` and its preview counterpart). So
Step 5 is not "not started" — it has a completed first slice. It's also not
"done" — that same file's header explicitly says "Not a sync adapter,"
and Step 5's full scope (sync provider adapter, wallet adapter abstraction,
shared normalized transaction format) is genuinely unbuilt. The accurate
status is **🔶 in progress — slice #1 (import capability lookup) shipped;
sync/wallet adapter generalization not started** — not the binary
⏳/✅ the legend supports today.

**Step 7** (`D2_ROADMAP.md:100`) reads "⏳ Planned. Not started," followed
by a bullet list (PLAID fallback removal, verification-script
generalization, cross-provider consistency checks, data-integrity audits,
docs/runbooks, a second read-path audit, legacy-cleanup planning) — **none
of which 7A–7F touched.** This status line is technically still accurate
*for that specific bullet list* — but it sits under the same "Step 7"
heading that 7A–7F's checklists also call themselves ("D2 Step 7A," "Step
7C," etc.), each citing real commits. A reader of `D2_ROADMAP.md` alone
would have no way to know 7A–7F exist, are complete, and shipped 6 commits
of real connection-health/cooldown/retry/reconnect/diagnostics work. This is
not the same gap as Step 5 — it's not that the line is wrong, it's that the
roadmap's Step 7 section and the "D2 Step 7A–7F" initiative are **two
different bodies of work sharing one step number**, and the roadmap has no
cross-reference connecting them.

This is a direct structural recurrence of a problem the project has already
named and fixed once: `D2_ROADMAP.md:56` itself documents that an earlier
"Step 3G" label collided with a separate audit's reuse of the same label,
and resolved it by renaming and re-homing the work. **The same fix pattern
applies here:** Step 7's original stabilization bullets and the "Step
7A–7F production hardening" initiative need to be disambiguated in the
roadmap — e.g., rename the bullet list to "Step 7 — Stabilization (legacy
fallback removal, data integrity, docs)" and add a new, explicitly
cross-referenced "Step 7A–7G — Production Hardening (connection health,
cooldown, retry, reconnect, scheduler, diagnostics) — ✅ complete,
commits `19456ff`…`6c28d32`" entry, the same way Step 3's note now
explains the 3G rename. This is a documentation-only fix; see
**Recommendations** below for the exact proposed edit, not yet applied.

Both of D2_STEP6_CLOSURE_DECISION.md's previously-recommended roadmap edits
(Step 2 WALLET row → ✅, Step 3 WALLET wording, Step 6 candidate split, and
the optional `provider-identity.ts` header fix) were confirmed already
applied in the live roadmap and live code — no outstanding work there.

## 3. Are there stale comments/docs that should be corrected?

**One roadmap fix (Step 7, above) plus the related Step 5 status line.
Everything else checked is current.** Specifically checked and found
*not* stale, contrary to what might be assumed from the 7C checklist's own
text: `jobs/scheduler.ts`, `jobs/sync-banks.ts`, and
`lib/plaid/syncTransactions.ts`'s header comments all still correctly state
that `startScheduler()` is never invoked and explain *why* (Vercel Cron
calls `syncBanks()` directly instead) — these were already updated
correctly when 7C shipped and do not need further correction.
`lib/accounts/provider-identity.ts`'s header no longer contains the stale
"nothing calls it with provider=WALLET today" line flagged by an earlier
audit — confirmed already fixed.

## 4. Is every provider lifecycle accounted for?

**Mostly — one gap worth flagging, not a blocker.** `PlaidItemStatus` has
four values: `ACTIVE`, `NEEDS_REAUTH`, `ERROR`, `REVOKED`
(`schema.prisma:54-59`). Recovery paths:

- **`NEEDS_REAUTH` → `ACTIVE`**: fully built by 7E. Reconnect badge surfaces
  it (`lib/data/accounts.ts:80-83`, gated to the connection's own owner),
  update-mode Link heals the same `PlaidItem` row via
  `exchange-token/route.ts`'s existing `upsert` on `externalItemId`.
- **`REVOKED` → anything**: by design, terminal — set only when the user
  explicitly disconnects (`lib/plaid/disconnect.ts:45`, after Plaid's
  `itemRemove()` actually invalidates the token). No reconnect badge is
  shown for it (confirmed: `getAccounts()`'s `needsReauth` only matches
  `status === NEEDS_REAUTH`), which is correct — Plaid has already revoked
  that access token server-side, and the existing "connect a new bank"
  flow is the right way to relink that institution under a fresh item.
- **`ERROR` → anything: no path back, by any mechanism.** `ERROR` is set
  for `INSTITUTION_NO_LONGER_SUPPORTED`, `INVALID_ENVIRONMENT`,
  `SANDBOX_ONLY`, or any unrecognized Plaid error code
  (`lib/plaid/errors.ts:149-152`). Items with `status: ERROR` are excluded
  from every sync query (`refresh`/`sync` routes' bulk paths and the cron
  job all filter `where: { status: ACTIVE }`), are not shown a reconnect
  badge (only `NEEDS_REAUTH` triggers one), and are not retried. The only
  visibility into an `ERROR` item is the 7F admin diagnostics page — a real
  mitigation, but a manual one. For the two named/expected codes
  (`INSTITUTION_NO_LONGER_SUPPORTED`, the genuinely-unfixable case;
  `INVALID_ENVIRONMENT`/`SANDBOX_ONLY`, config errors no amount of
  reconnecting would fix anyway) this is arguably correct behavior, not a
  gap. For the **unrecognized-code bucket**, it means any future Plaid
  error code not yet classified here will silently and permanently strand
  an item with zero automatic recovery and zero end-user-visible signal —
  discoverable only by an admin who happens to check `/admin/providers`.
- **Minor, related hardening note:** `link-token/route.ts`'s reconnect
  lookup (`findFirst({ where: { id, userId } })`,
  `app/api/plaid/link-token/route.ts:34-37`) does not scope by `status` at
  all — it would attempt update-mode Link for a `REVOKED` or `ACTIVE` item
  too if a `plaidItemId` for one were ever passed in. The ownership check
  prevents any cross-user exposure, and the UI never constructs such a
  request today (only `NEEDS_REAUTH` items get a badge), so this is a
  defense-in-depth gap, not a reachable bug.

Severity: **Low.** Both items are real but bounded — neither corrupts data,
leaks information, or affects the cases that matter most (the
`NEEDS_REAUTH` path, by far the common case, is fully handled). Recommend
listing both as deferred backlog items (see below), not implementing a fix
now, consistent with "no opportunistic improvements."

## 5. Are there any architectural gaps that will block D4 Provider Catalog?

**Flagging a labeling correction first, then answering both readings.**
Per this project's own canon (`D2_ROADMAP.md:118` and the Phase 2 Decision
Matrix), **"Provider Catalog" is D6/D7, not D4** — D4 is the AI Context
Builder. This is the same kind of numbering mislabel the project has
corrected before; flagging it here rather than silently answering the
wrong question.

**Does anything block D6/D7 (ProviderCatalog)? No.** The Architecture
Freeze is explicit that `ProviderCatalog` "has no dependency on the
Connection layer landing first; this can ship and be populated
independently" (§16, branch 2). Today's `ProviderType` enum already exists
and already covers every needed key (`PLAID`, `WALLET`); a future
`ProviderCatalog` table can reference it directly. `D2_ROADMAP.md:118`
reaffirms this boundary explicitly and reaffirms the deferral to v2.7 — that
deferral is a **product/release-timing decision**, not a technical
blocker, and nothing in the 7A–7F work changed that calculus either way.

**Does anything block D4 (AI Context Builder)? No.** Per the Architecture
Freeze (§16, branch 6), `feature/ai-context-builder` has "no schema
dependency on branches 2–5; can run in parallel," since `AiAdvice`'s write
path doesn't exist yet to conflict with anything D2 touched.

**One nuance worth surfacing for the *next* phase of D2/D13 itself
(`feature/provider-adapter-layer`, §13), not for D6/D7 or D4:** the
Architecture Freeze names Plaid Link Update Mode as a named, explicit
dependency of the future `Connection`-level per-institution dedup fix
(`@@unique([userId, provider, providerInstitutionId])` — §9.1 line 204,
360). **7E just shipped Update Mode support** — but only at the
user-initiated reconnect-badge layer (`link-token/route.ts` plus
`PlaidContext.tsx`), not wired into `exchange-token/route.ts`'s *create*
path to auto-detect "this user already has a connection to this
institution" and force update mode there. That auto-detection is still
unbuilt. This is forward-looking context for whoever scopes the next D2/D13
slice, not a blocker to anything in front of us today — D6/D7 and D4 are
both confirmed independent of it.

## 6. Are there any production risks remaining?

Five, all low-to-medium severity, none rising to "concrete blocker":

1. **No audit-log trail for health-state transitions, cooldown skips, or
   reconnect actions** (Medium-low). Confirmed via direct grep: 7A–7F added
   zero new `AuditAction` entries. The only audit rows fired by the
   refresh/sync routes are the pre-existing `PLAID_REFRESH`/`PLAID_SYNC`
   actions, unchanged since before Step 7. A status flip to `NEEDS_REAUTH`,
   a cooldown-skip, or a successful reconnect are each observable only as
   the *current* state on `/admin/providers` — there's no persisted
   history of *when* an item broke or *when* it was healed. Worth a future,
   small `AuditAction` addition; not urgent.
2. **`ERROR`-status items have no recovery path** (Low — see Q4).
3. **Vercel Hobby plan's once-daily cron ceiling** (Low, already known and
   documented by 7C itself) — scheduled sync cadence is daily, not the
   originally-envisioned 4-hourly; manual refresh/sync remain available
   with a 1-hour cooldown as the user-facing mitigation in between.
4. **Pre-existing orphaned `PlaidItem` rows from before Update Mode
   existed** (Low, explicitly named and deferred by 7E's own Risk #1) —
   institutions relinked from scratch before this fix shipped have a
   permanently stuck old row plus a separate active one. 7E prevents new
   orphans; it doesn't retroactively clean up old ones. A one-time data
   cleanup script is the natural follow-up, not in scope here.
5. **`link-token/route.ts`'s reconnect lookup doesn't scope by status**
   (Low — see Q4).

No risk found here requires immediate implementation under this audit's
"concrete blocker" bar. All five are reasonable backlog items.

## 7. Is there unnecessary complexity or dead code that should be removed now?

**One clear, safe removal candidate; one borderline case better left
alone.**

- **`app/api/plaid/create-link-token/route.ts` — confirmed dead.** Its own
  header already says `@deprecated — No longer called` and "safe to delete
  in a future cleanup once confirmed unused in production." Repo-wide grep
  confirms zero callers anywhere in `app/`, `lib/`, `components/`, or
  `context/` — the only references are this file's own header and doc
  mentions. Oddly, `.gitignore:79` already lists
  `app/api/plaid/create-link-token/`, which doesn't untrack an
  already-committed file but suggests someone already half-started
  retiring it. This is a clean, low-risk deletion candidate for a future
  cleanup commit — not done here, per "no opportunistic improvements."
- **`jobs/scheduler.ts`'s dormant `startScheduler()`/`setInterval` code** —
  considered and **not** recommended for removal. It's intentionally kept
  (7C's own Revision section: "stays exactly as dormant as it was before
  this slice"), and its header comment documents a real, still-possibly-
  relevant fallback path (a standalone Node/Docker deployment, as opposed
  to Vercel serverless) that the Cron-route fix doesn't cover. Removing it
  would be an architecture change, not a cleanup — out of scope for "no
  opportunistic improvements."
- Empty job/lib stubs (`lib/simplefin.ts`, `lib/ai-advice.ts`,
  `jobs/run-ai-advice.ts`, `jobs/take-snapshot.ts`, `jobs/sync-crypto.ts`)
  remain intentional placeholders for future, separately-approved work —
  not dead code.
- `Connection` and its relations remain schema-only and unused by any
  application code today — but this is explicit, intentional, additive
  scaffolding per Step 1A's own design, not accidental dead code.

## 8. Can D2 be formally closed?

**Two different scopes need two different answers — this is the most
important distinction in this audit.**

**The "D2 Step 7A–7G Production Hardening" initiative — yes, close it.**
Every checklist-specified change is implemented and verified against live
code (Q1), `tsc`/`lint` are clean, the working tree is clean, and all 6
commits exist. Nothing here is blocking.

**The full "D2 Roadmap" (Steps 1–7 as defined in `D2_ROADMAP.md`) —
no, not yet.** Three things remain genuinely open by the roadmap's own
admission, independent of anything this audit found:

- Step 5's full scope (generalized sync/wallet adapter interfaces, shared
  normalized transaction format) — only slice #1 has shipped.
- Step 6's open decision (selecting Coinbase, Schwab, or wallet xpub as the
  first real sync-side provider) — explicitly unselected, carried forward
  since the original investigation.
- Step 7's *original* stabilization bullets (PLAID fallback removal,
  verification-script generalization, cross-provider consistency checks,
  data-integrity audits, docs/runbooks, a second read-path audit, legacy
  cleanup planning) — entirely untouched by 7A–7F, which was a different,
  later-added body of work that happened to also call itself "Step 7."

**The Architecture Freeze's full §13 "Provider Adapter Layer" target
(D2/D13) — further still from closeable.** Four shape-specific `Connection`
detail tables, a `DiscoveredAccount` model, and a formal `ProviderAdapter`
interface (§13) don't exist yet; `Connection` itself remains unpopulated by
any application code. D2 Steps 1–7 are real, verified progress toward that
target, not the target itself.

**Recommendation: close the Step 7A–7G slice formally now; keep the
broader D2 Roadmap open** with its existing Steps 5/6 open items
unchanged, plus the two roadmap-doc fixes below queued as the next small,
explicitly-approved documentation step (not done in this audit, per
"do not implement / stop after the audit"):

1. `D2_ROADMAP.md:76` — change Step 5's status from "⏳ Planned. Not
   started." to "🔶 In progress — slice #1 (`lib/imports/provider-capabilities.ts`,
   commit `18f0922`) shipped; sync/wallet adapter generalization not
   started."
2. `D2_ROADMAP.md:98-108` — add a new subsection distinguishing the
   original Step 7 stabilization bullets (still ⏳ not started) from a new,
   explicitly labeled "Step 7A–7G — Production Hardening" entry marked ✅
   complete, with the 6 commit hashes, mirroring the precedent already set
   for the "3G" label collision at line 56.

---

## Deferred items (not blockers — for a future roadmap version)

- `ERROR`-status `PlaidItem` recovery path (Q4/Q6).
- `AuditAction` coverage for connection health transitions, cooldown
  skips, and reconnects (Q6).
- One-time cleanup of pre-Update-Mode orphaned `PlaidItem` rows (Q6).
- Status-scoping hardening on `link-token/route.ts`'s reconnect lookup
  (Q4/Q6).
- Deletion of `app/api/plaid/create-link-token/route.ts` (Q7).
- Step 5's remaining scope (sync/wallet adapter generalization) and Step
  6's open sync-provider selection (Q2/Q8) — both already-known, not new.
- Step 7's original stabilization bullets (PLAID fallback removal etc.) —
  already-known, not new, but newly reconfirmed as fully untouched (Q8).
- Wiring Update Mode into `exchange-token/route.ts`'s create path for true
  Connection-level dedup, ahead of any future `feature/provider-adapter-layer`
  work on the four detail tables / `DiscoveredAccount` (Q5).

## Recommended next architecture milestone

No blocker exists, so per this audit's own decision rule this is a
recommendation, not a requirement. The Architecture Freeze's own branch
sequencing (§16) names two branches with **zero dependency** on anything
remaining in D2: `feature/provider-catalog` (D6/D7) and
`feature/ai-context-builder` (D4) — both could start immediately. Set
against that, `D2_ROADMAP.md`'s "Required notes" explicitly defers
Provider Catalog to v2.7 for product reasons, not technical ones — that
deferral should be explicitly reconfirmed (or lifted) by whoever owns that
call, rather than silently overridden here.

Given the momentum and partial completion already in hand, the lowest-risk
next step is to **finish what's already open inside D2** before starting a
new lettered decision: Step 6's provider-selection decision (Coinbase,
Schwab, or wallet xpub) is the one open question already blocking Step 5's
sync-adapter generalization from having a second real implementation to
validate against. That said, `feature/space-account-link-migration` (D3),
`feature/provider-catalog` (D6/D7), and `feature/ai-context-builder` (D4)
all remain valid, independent, ready-to-scope alternatives per the
Architecture Freeze's own graph — the choice among them is a product
sequencing call, not an architectural one, and is intentionally left to
whoever approves the next checklist.

## Stop point

This document stops here. Per the governing instructions, no blocker was
found that requires implementation, no code/schema/doc file has been
edited, and no opportunistic improvement has been made. The two
roadmap-doc edits proposed under Q8 are recommendations awaiting their own
explicit approval, exactly like every other change in this project's
history — not applied by this audit.
