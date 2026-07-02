> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 6 — First Real Provider Investigation

**Investigation only. No code, schema, or migration changes were made to
produce this document, and no other document was modified.** Branch:
`feature/phase-2-architecture`. Baseline: `v2.3.0`.

Goal: given D2-5 is complete (import provider capabilities + the Plaid
adapter boundary), determine the smallest "first real provider" proof D2-6
should claim — wallet watch-only, CSV/import, both, or neither (i.e.,
documentation closure only).

Inputs read in full: `app/api/accounts/wallet/route.ts`,
`lib/accounts/provider-identity.ts`, `lib/accounts/reconcile.ts`
(`findActiveAccountByIdentity`), `lib/providers/plaid/adapter.ts`,
`lib/imports/provider-capabilities.ts`, `jobs/scheduler.ts`,
`jobs/sync-crypto.ts`, `jobs/sync-banks.ts`, the `ProviderType`/
`AccountConnection`/`FinancialAccount`/legacy-`Account` sections of
`prisma/schema.prisma`, plus the governing docs (`PHASE_2_ARCHITECTURE_
FREEZE.md` §13/§19, `PHASE_2_DECISION_MATRIX.md` D2/D13,
`D2_PROVIDER_CONNECTION_ARCHITECTURE.md` §7, `D2_ROADMAP.md`,
`D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md`).

---

## 1. Wallet watch-only — what already exists

`app/api/accounts/wallet/route.ts` (297 lines) is, in substance, already a
**watch-only single-address provider**: the request body is `name` /
`walletAddress` / `walletChain` only — no private key, signature, or xpub is
ever collected or stored. Its three branches (active-match reshare L58-132,
archived-match reactivate L139-205, fresh create L208-296) all converge on
the same writes: a `FinancialAccount` row (`walletAddress`, `walletChain`,
`nativeBalance: 0`, `syncStatus: "pending"`), an `AccountConnection` (no
`PlaidItem`), a `WorkspaceAccountShare` mirrored onto `SpaceAccountLink`, and
— already wired since D2 Step 2 — `dualWriteProviderAccountIdentity(id,
ProviderType.WALLET, walletAddress)` at L103, L186, and L269. `ProviderType.
WALLET` already exists in `prisma/schema.prisma` (L75-83); no enum change
needed.

So the provider-identity half of "provider proof" — a named `ProviderType`,
a real write path, a real `ProviderAccountIdentity` row per account — is
already shipped and already exercised in production-shaped code today, not
hypothetical.

## 2. Wallet watch-only — what's missing, and why it's a documentation gap, not a code gap

What does **not** exist, confirmed directly:

- **No sync job.** `jobs/sync-crypto.ts` is a literal one-line stub
  (`export {}`). Unlike `jobs/sync-banks.ts` (which is implemented, just not
  wired to an `instrumentation.ts` entrypoint — a separate pre-existing
  gap), `sync-crypto` is not implemented *or* registered: `jobs/scheduler.ts`
  only imports and schedules `purgeTrash` and `syncBanks`. There is nothing
  to wrap.
- **No balance ever moves.** Repo-wide search confirms `nativeBalance` is
  written exactly once per account, always `0`, only in `wallet/route.ts`
  L220 — every other reference is `types/index.ts`'s type definition or
  `prisma/seed.ts`/`lib/mock-data.ts` demo fixtures. No PATCH route, cron, or
  script ever updates it. `syncStatus` is set to `"pending"` at create/
  reactivate time and never advances — there is no code path that writes
  `"synced"` for a WALLET account anywhere in the repo.
- **Read path stays owner-scoped/direct, by design.** `findActiveAccount
  ByIdentity()`'s WALLET branch (`lib/accounts/reconcile.ts` L174-181, with
  an explicit comment at L137: "The WALLET branch is unchanged by this
  step.") queries `FinancialAccount` directly by `(ownerUserId,
  walletAddress)` — it never reads `ProviderAccountIdentity`, unlike the
  PLAID branch immediately above it. This is the same deferred read-cutover
  the roadmap names for WALLET (`D2_ROADMAP.md` Step 3 row, "blocked on the
  same WALLET identity semantics question as 1C-C") — confirmed still true,
  not something this investigation found newly broken.
- **No adapter-boundary file.** D2-5 added `lib/providers/plaid/adapter.ts`
  — an explicit, deliberate "pure re-export, zero logic" wrapper around
  `refreshPlaidItem`/`syncTransactionsForItem`, whose own header says it
  exists "so a second sync provider has an obvious pattern to follow." No
  `lib/providers/wallet/adapter.ts` exists.

**Why the last item should not be built right now:** the Plaid adapter had
something real to wrap — `refresh.ts`/`syncTransactions.ts` already existed
as substantial, independent modules before D2-5 named them. Wallet has no
equivalent module; its only logic lives inline inside the route handler.
Building `lib/providers/wallet/adapter.ts` today would mean either (a)
wrapping nothing — an object with a `provider: ProviderType.WALLET` field
and no second field worth naming, since there is no `refreshItem` or
`syncTransactions` equivalent to point to — or (b) extracting the route's
create/reshare/reactivate logic into a new module first, which is a real
refactor of working code with no second caller and no behavior change to
justify it. D2-5's own investigation already reasoned through this exact
trap for WALLET and explicitly declined to force it (`D2_STEP5_ADAPTER_
INTERFACE_INVESTIGATION.md` §6: "WALLET should not be force-fit into either
interface yet... leave it unmodeled in this slice rather than design
speculative shape for a sync mechanism that doesn't exist"). Nothing in this
investigation's read of the current code changes that conclusion — if
anything it reconfirms it, since `sync-crypto.ts` is still a bare stub.

**Conclusion: the wallet watch-only provider proof is a documentation/
roadmap-closure question, not a code question.** The thing that's actually
missing isn't a file in `lib/` — it's that `D2_ROADMAP.md`'s Step 6
candidate list (§"Step 6 — First real new provider") still lists "Wallet/
xpub" as one undifferentiated, not-yet-selected candidate, which conflates
two different things: the already-shipped single-address watch-only model
(real, working, identity-tagged) and the not-started xpub/multi-address/
signing model (`D2_PROVIDER_CONNECTION_ARCHITECTURE.md` §7, L56/L112/L114 —
"xpub or output descriptor... periodic balance/derivation refresh... new
adapter... `Connection.credential` holds the xpub, encrypted at rest").
Those need to be named as two separate things, only one of which is closeable
now.

A second, smaller staleness compounds this: `lib/accounts/provider-
identity.ts`'s own module header (L14-19) still reads "nothing calls it with
provider=WALLET today" — false since D2 Step 2's WALLET dual-write shipped,
and already flagged once before, unfixed, in `D2_STEP5_ADAPTER_INTERFACE_
INVESTIGATION.md` §5 ("Both are stale... Worth a one-line fix the next time
`D2_ROADMAP.md` is edited; not actioned in this report"). Same for
`D2_ROADMAP.md`'s own Step 2 table row (L38), which still shows WALLET
dual-write as "⛔ Not started." This is the second investigation in a row to
re-discover the same already-named gap rather than fix it — worth closing
this time rather than deferring a third time.

## 3. CSV/import provider proof — does D2-5 already satisfy it?

**Yes, fully, with no further code needed.** `lib/imports/provider-
capabilities.ts` (44 lines, shipped in D2-5 commit `18f0922`) is exactly a
capability-lookup keyed by provider — `Record<ImportSource,
ImportProviderCapabilities>` covering `CSV`, `EXCEL`, and `QUICKBOOKS` — and
it is wired into two real call sites (`app/api/accounts/[id]/import/
route.ts` and the read-only preview-route parity check), replacing a
hardcoded `source === ImportSource.QUICKBOOKS` check. This is not a
single-provider demo: the registry already holds three entries, and one of
them (`QUICKBOOKS: { supportsUpdateOnMatch: true }`) proves the lookup
actually branches real behavior differently per provider, not just compiles.

This already *is* the "validate the import adapter shape against a real
file-based provider" proof the roadmap's Step 6 candidate list names CSV
Import as existing to prove (`D2_ROADMAP.md` L88: "CSV Import (would
validate the Step 4/5 import adapter shape against a real file-based
provider)"). That validation already happened, one step early, as part of
D2-5 itself — D2-5 didn't just define the capability shape in the abstract,
it immediately proved it against three real sources because the QuickBooks
hardcoded check it was replacing already existed and needed exactly this
fix. There is no remaining import-side gap for D2-6 to close with code.

## 4. Recommended D2-6 scope

**D2-6 should be a documentation/roadmap-closure step, not a code slice.**
Both investigated candidates resolve the same way: the underlying capability
already exists and is already exercised by real code; what's missing in
both cases is that `D2_ROADMAP.md`'s Step 6 section hasn't been updated to
say so. Recommend closing **both** candidates in the same step (they're
small enough, and tightly enough related to the same stale roadmap section,
that splitting them into two separately-scheduled approvals would be
process overhead without a corresponding risk reduction) — but as two
clearly separable edits within it, consistent with the standing
"independently approvable" preference, in case only one is approved.

This is not "Step 6 is done, move to Step 7." It's "Step 6's first
candidate-selection question — wallet-watch-only vs. CSV vs. both vs.
neither — resolves to 'both already happened, accidentally, as side effects
of Steps 1D/2/5; stop carrying them as open Step 6 candidates and record
that explicitly.'" The genuinely unstarted part of Step 6 — picking and
building a **sync**-side second provider (Coinbase, Schwab, or wallet
xpub) — remains completely open and is explicitly out of this
investigation's scope (see §6).

## 5. Exact implementation slices, if approved

Both slices below are **documentation-only edits to `D2_ROADMAP.md`**, plus
one optional comment-only fix. No schema, no migration, no application
logic, no UI. Each is small enough to review as a single diff.

**Slice D2-6-A — Wallet watch-only closure.**
- `D2_ROADMAP.md`, Step 6 candidate list: split the single "Wallet/xpub"
  bullet into two — (1) "Wallet watch-only single address" marked closed/
  satisfied, pointing at `app/api/accounts/wallet/route.ts` and this report;
  (2) "Wallet xpub / multi-address / signed-message verification" kept as a
  genuinely open, unstarted, unscoped future candidate, unchanged in spirit
  from today's wording.
- `D2_ROADMAP.md`, Step 2 table (L38): fix the stale "WALLET dual-write —
  Not started — ⛔" row to ✅, citing `D2_STEP2_WALLET_DUAL_WRITE_
  IMPLEMENTATION_VALIDATION.md` — the fix already specified verbatim by
  `D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md` §5 and never applied.
- *Optional, separately reviewable:* `lib/accounts/provider-identity.ts`
  L14-19 — update the stale "nothing calls it with provider=WALLET today"
  comment to reflect that `wallet/route.ts` does. Comment-only; zero
  behavior change. Flagged as optional because it's a `.ts` file touch and
  the project's standing rule treats every code-directory file change as
  needing its own sign-off even when it's a comment — listing it separately
  so it can be declined without blocking the roadmap-doc fix above.

**Slice D2-6-B — CSV/import closure.**
- `D2_ROADMAP.md`, Step 6 candidate list: remove "CSV Import" as an
  unselected candidate; record it as already validated by D2-5 (`lib/
  imports/provider-capabilities.ts`, commit `18f0922`), citing this report's
  §3.

No new files. No change to `lib/providers/plaid/adapter.ts`, `lib/imports/
provider-capabilities.ts`, `app/api/accounts/wallet/route.ts`, or any schema
file.

## 6. What should defer to v2.7 (or later, unscoped)

- **Wallet xpub / output descriptor / multi-address derivation** — explicit
  non-goal of this investigation; real new work (`Connection.credential`
  wiring, encrypted-at-rest xpub storage, derivation logic) per
  `D2_PROVIDER_CONNECTION_ARCHITECTURE.md` §7.
- **Wallet balance sync of any kind** — manual refresh button, blockchain
  RPC polling, or a third-party balance API. Confirmed not trivially
  supported today (§2) — would require a real RPC/API client, error
  handling, rate limiting, and a `syncStatus` state machine that doesn't
  exist yet. Out of scope per the task's own constraint and not assumed
  resolved here.
- **Wallet signed-message ownership verification** — explicit non-goal.
- **Direct Coinbase/Schwab integration** — explicitly deferred, unchanged.
- **Selecting THE first real *sync*-side provider** (Coinbase vs. Schwab vs.
  wallet-xpub) — still an open decision per `PHASE_2_ARCHITECTURE_FREEZE.md`
  §19 and `D2_PROVIDER_CONNECTION_ARCHITECTURE.md`'s own unresolved "which
  provider is built first" question (L359). This investigation does not
  resolve it and recommends against forcing a pick now — no second sync
  implementation exists yet to validate a generalized interface against,
  the same anti-overbuilding reasoning Step 5 already applied.
- **A generic `ProviderAdapter` interface** (`discoverAccounts`/
  `syncActivity`/`normalizeProviderData`, per Architecture Freeze §13) for
  WALLET specifically — no second sync implementation exists to validate it
  against; building it now would be speculative, exactly what Step 5's own
  investigation already steered around.
- **`lib/providers/wallet/adapter.ts` boundary stub** — not recommended now
  (§2). Revisit only if/when real wallet sync work is scheduled, and bundle
  the extraction with that work rather than building an empty wrapper first.

## 7. Validation plan

Since the recommended scope is documentation-only:

- `npx prisma generate` — not expected to run; no schema change.
- `npx prisma migrate dev` — not expected to run; no schema change.
- `npx tsc --noEmit` — expected no-op for the roadmap-doc edits; if the
  optional `provider-identity.ts` comment fix (§5) is approved and applied,
  this confirms the file still compiles identically (a comment edit cannot
  change emitted types, but running it is cheap confirmation, consistent
  with how every other D2 step in this repo runs the full validation suite
  regardless of how small the diff is).
- `npm run lint` — same expectation, same rationale.
- No targeted route or UI testing — nothing executable changes. If the
  optional comment fix is included, the check is a `git diff` review
  confirming the change is comment-only (no logic, no whitespace-sensitive
  change to surrounding code).
- Doc-accuracy check: re-read the edited `D2_ROADMAP.md` Step 6 section
  against this report's §1-§3 and confirm every claim in the new wording
  still cites the actual file/line it's based on — the same standard every
  other roadmap edit in this initiative has been held to.

## 8. Risks

- **Closing too much.** Slice A closes the *watch-only single-address*
  candidate only. It must not be read, by itself or by a future skim of the
  roadmap, as closing "Wallet" as a Step 6 candidate outright — the xpub/
  signing/sync half stays explicitly open. The two-bullet split in §5 is
  meant to prevent exactly this misreading; if the eventual edit collapses
  back to one bullet, the ambiguity this report exists to remove would
  return.
- **Roadmap-staleness recurrence.** This is the second investigation in a
  row (`D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md` was the first) to
  re-find the same WALLET dual-write staleness and the same provider-
  identity.ts header staleness without fixing them. If Slice A is not
  approved, expect a third rediscovery at the next WALLET-adjacent
  investigation.
- **Mistaking "no code needed" for "no decision needed."** Recommending no
  code change is itself a recommendation that needs sign-off, not a
  default — per the standing checklist-then-approval working style, this
  report's closure language should not be applied to `D2_ROADMAP.md` until
  explicitly approved, exactly like a code slice would be.

## 9. Stop point

This report stops here. Nothing in §4/§5 is approved by virtue of appearing
in this document. Recommended next step: confirm whether to proceed with
Slice D2-6-A, Slice D2-6-B, both, or the optional `provider-identity.ts`
comment fix — each independently approvable — before any file named in §5
is touched.
