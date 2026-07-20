# V25-CLOSE-1 — Ledger Reconciliation + Artifact Containment

**Status:** IMPLEMENTED.
**Date:** 2026-07-20.
**Scope:** documentation + repository hygiene only. No production code behaviour, no financial semantics, no UI, no TimelineLens behaviour changed.
**Baseline:** HEAD `1ba90d8`, branch `feature/v2.5-spaces-completion`, 633 commits past tag `v2.4.5`, **97 commits past the last documentation reconciliation** (`6f50971`, 2026-07-17).

> **Purpose.** The repository should be able to explain itself accurately. Before this slice it could not: three items the ledger listed as open were closed in code, and four multi-slice initiatives had shipped with no roadmap entry at all.

---

## 1. The drift, characterised

The error ran in a consistent direction, and the direction matters more than the count:

> **The docs were over-pessimistic about code and over-optimistic about ops.**

They under-reported shipped engineering (consent capture, KD-21, KD-22, CONN-2/3/4A, the job substrate) while the genuinely unfinished work — Sentry, uptime monitoring, the restore drill, the `invite_only` flip, the LLM disclosure copy — was all configuration and prose. A reader optimising from this ledger would have written code that already existed and deferred the operational acts that actually gate beta.

**Why it went unnoticed.** `.github/workflows/status-drift-guard.yml` exists precisely to catch this. It did not fire once across the 97 commits, for two structural reasons: it triggers on `pull_request` only (this work landed as direct commits to a long-lived feature branch), and it always `exit 0` (advisory by design). The guard was correctly built for a workflow this project is not using. *No change made here — flagged for V25-CLOSE-2.*

---

## 2. Resolved stale blockers

Each verified in code, not inferred from commit messages.

### 2.1 Registration consent capture — **CLOSED**

`STATUS.md:19`, `production-readiness.md:20`, and `releases/v2.5.md:27` all claimed `User.acceptedTermsAt` was absent. It has existed since `630a84e` (PO-5A):

| Layer | Evidence |
|---|---|
| Schema | `prisma/schema.prisma:367-368` — `acceptedTermsAt DateTime?`, `acceptedTermsVersion String?` |
| Migration | `prisma/migrations/20260719191719_po5a_terms_consent/` |
| Server enforcement | `app/api/auth/register/route.ts:76` — rejects unless `acceptedTerms === true`; persists at `:205-206` with `TERMS_VERSION` |
| UI | `app/(auth)/register/page.tsx:404` checkbox; `:420` disables submit until agreed |

### 2.2 KD-21 (visibility gaps) — **CLOSED, all four sub-items**

Milestoned `v2.5 (Phase 1)` at High severity, this was **the only KD issue labelled v2.5 and was therefore falsely presenting as a v2.5 closure blocker.** A prior audit (`status-drift-audit-2026-07-17.md:11-13`) had already ordered part of this correction three days before STATUS was last edited; it was never applied.

| Sub-item | Resolution |
|---|---|
| A10 investments valuation | `ebda4b2` — extracted a new scope authority `lib/investments/account-scope.ts`, consumed at `valuation.ts:284` and `investments-time-machine.ts:120`. *(Greps against `valuation.ts` alone read as unfixed because it delegates rather than inlining the predicate — this is why the sub-item survived earlier reviews.)* |
| Goals | `6921337` — `resolveFullVisibleAccountIds` + `filterVisibleContributions` at `app/api/spaces/[id]/goals/route.ts:62,65`; pinned by `goals-visibility.test.ts` |
| Banking import authorization | `lib/imports/authorize.ts:109` — single shared `grantsTransactionDetail` guard; pinned by `authorize-visibility.test.ts` |
| Activity-feed account-name ruling | Implemented as `lib/activity/scrub-account-name.ts` + `account-name-privacy.ts`, both test-pinned |

### 2.3 KD-22 (AI trend-net omits refunds) — **CLOSED**

`46772f4`. `lib/ai/intelligence/annotations/metrics.ts:177` returns `incomeTotal + refundTotal - expenseTotal - debtPaymentTotal`, with a parity test against the canonical assembler in `lib/ai/intelligence/spending-trends-net.test.ts`.

### 2.4 Blockers that survive (unchanged, re-verified)

LLM/provider disclosure + retention posture in `/legal/ai` · Sentry · uptime monitor on `/api/health` · backup-restore drill · `invite_only` production flip · Turnstile live keys · Plaid production decision · Resend/domain verification. **Promoted from "beta-acceptable" to blocker:** a published support address — `support@fourthmeridian.com` exists only as a sender identity (`lib/email/senders.ts`) with zero occurrences in user-facing surfaces, so a beta user has no defect-report path.

---

## 3. Completed initiatives added to the ledger

Recorded with commit references; **no completion dates were invented** — every claim traces to a commit.

| Initiative | Commits |
|---|---|
| Transaction Explorer TX-1→TX-4 | `8d3823a` · `b241cc2` · `be836db` · `3b509a5` · `537b817` · `4cf86a0` · `b1c9550` · `cd28478` · `5761892` · `6061966` |
| Connection lifecycle CONN-1→CONN-4A | `26c0a54` · `7f521de` · `d1d3d97` · `3412fb8` · `25ef845` · `da679b0` · `9c9b4c0` |
| TimelineLens v4 (sole time selector) | `05c7c80` · `763dd90` · `8665d64` |
| Platform Ops / beta gate | `5184c8b` (PO-4A) · `f1a0901` (PO-5) · `630a84e` (PO-5A) |
| Admin TOTP enrollment lifecycle | `22810da` |
| Marketing boundary hardening | `04c416d` |

`connection-lifecycle-roadmap.md` was the worst single case: CONN-2 and CONN-3 were still marked 🔜 despite both having landed, and CONN-4A was absent from the sequence entirely while CONN-2 item 10 still described the disconnect lifecycle as "documented, likely deferred" — the exact decision CONN-4A resolved.

---

## 4. Remaining-work classification (Part 2)

Now recorded in `docs/plans/ROADMAP.md` as a four-class table. Nothing remains in an unlabelled "future" bucket.

- **A — must complete before v2.5 closure:** Atlas palette-ratchet fence expansion. *This is the only surviving class-A item*; V25-CLOSE-1 closed the rest.
- **B — v2.5 polish:** FX rate-miss disclosure · audit + fresh-access on the three `admin/plaid` operator routes · visibility-resolver parity guard · Debt/Liquidity empty states · template picker descriptions · dead-code sweep (~694 LOC).
- **C — v2.6:** conversation state / `conversationId` · `AiAdvice` write path (KD-14) · `context-priority` activation · `comingSoon` lenses · provider expansion · PO-4B.
- **D — later scaling:** TX-5 (gated on KD-15) · PROV-6 ingestion payload · `SectionCard.tsx:160-163` section-key data migration.

---

## 5. Prototype containment decision (Part 3)

### Findings, verified

| Question | Answer |
|---|---|
| Tracked? | **Yes — one file.** `app/prototype/timeline-component-v4/page.tsx`, committed in `413fb55` |
| Ships as a public route? | **Yes.** Under the App Router with no `pageExtensions` filter, no rewrite, no env guard, no `notFound()`. `proxy.ts:116` matches only `/dashboard/:path*` and `/admin/:path*`, so `/prototype/*` is **unauthenticated** |
| Imports production authorities? | **Yes.** `@/components/atlas/TimelineLens`, six named exports from `@/components/space/shell/perspective-time-adapter`, `@/lib/perspectives/time-range` |
| Touches financial/session/DB data? | **No.** Zero `db` / `prisma` / `session` / `auth` / `fetch` imports across the whole tree; the harness runs on hardcoded dates |

**So the expected finding holds: there is no financial data exposure.** The harm is architectural drift and a public surface that shouldn't exist — not a leak. Recording that distinction matters, because it is what makes containment the right response rather than an incident.

The real costs were: (a) production renames in `perspective-time-adapter.ts` or `components/atlas/` could break the build via prototype files, and (b) `components/space/shell/timeline-lens-exclusivity.test.ts:79` skips any directory named `prototype` — so the "TimelineLens is the sole time selector" invariant was enforced everywhere *except* the four places duplicate TimelineLens implementations actually live.

### Decision: untrack, do not delete

The tracked harness is **valuable and deliberately non-drifting** — its own header records that it imports the promoted primitive so that "the harness cannot drift from what ships." Deleting it would destroy a useful experiment; leaving it tracked ships a public route.

Chosen containment, in order of preference given the brief:

1. `git rm --cached app/prototype/timeline-component-v4/page.tsx` — removes it from the repo and therefore from every Vercel build. **The file remains on disk**; the experiment survives locally.
2. `.gitignore` now covers `app/prototype/` with the reasoning inline, so the route tree cannot be re-added by accident.
3. `.gitignore` now also covers root `prototype/` — it holds two standalone Next apps (own `package.json`/`next.config.ts`) and only their *build output* was previously ignored, so `git add -A` would have committed two nested applications into this repo.
4. `tsconfig.json` `exclude` now lists `prototype` and `app/prototype`. Previously `include: ["**/*.ts"]` with `exclude: ["node_modules"]` pulled both foreign apps into the production typecheck, so a broken experiment could fail `tsc --noEmit` for the real application.

**Deliberately not done here (V25-CLOSE-2):** closing the `prototype` hole at `timeline-lens-exclusivity.test.ts:79`, and adding a guard asserting prototype routes can never ship. Those are guards, and guards are the next slice.

---

## 6. Test discovery boundary (Part 4)

`scripts/run-tests.ts` walked `app/` unconditionally and collected `app/prototype/timeline-component-v3/components/TimelineLens/TimelineLens.test.ts` — **a prototype's private copy of the TimelineLens tests was executing in the production suite, indistinguishable from the real guard.** A green suite therefore implied an invariant production code never had to satisfy.

Fix: a `NON_PRODUCTION_DIRS` set (`{"prototype"}`) pruned during the walk, with the rationale recorded at the definition.

**Suite count moved 309 → 308, and that is the correct direction.** The removed test is the prototype's own; no production guard was weakened, skipped, or deleted. Prototype experiments remain runnable by hand — they simply no longer speak for production.

---

## 7. Artifact cleanup (Part 5)

`_to_delete/fm_src.tgz` — 15 MB, 1,976 entries, **including `./.env.local` and `./.env.preview`**: a full source snapshot with real secrets sitting in the working tree.

Verified before removal: gitignored (so never committed) · no code, build, or script reference · not a tarball anything imports. The only references anywhere were two prior audits (`architecture-audit-2026-07-16.md:39,364`, `documentation-cleanup-audit-2026-07-16.md:214`) that had **already ordered it deleted and were never actioned** — twice.

Removed, along with the now-empty `_to_delete/` directory. The `.gitignore` entry is retained so the path stays ignored if it ever reappears.

---

## 8. `.gitignore` environment ordering (Part 6)

**Before** — `.gitignore:85` carried a bare `.env*` under the comment `# Deprecated stub files (superseded by lib/plaid/ and lib/db.ts)`. The comment belonged to unrelated deleted files; the pattern was orphaned there and dates back to `639e9a5` (the v2.0 release). Sitting 40 lines below the canonical block, it silently re-ignored the exemption:

```
$ git check-ignore -v --no-index .env.example
.gitignore:85:.env*    .env.example
```

`.env.example` only *appeared* safe because it was already tracked — a fresh clone that deleted and restored it would have found git refusing to re-add it.

**After** — the stray pattern and its mislabeled comment are removed. The canonical block is unchanged in behaviour and now carries an explicit ordering warning, because the failure mode is invisible until someone tries to re-add the file.

**Verification, both directions:**

| Path | Expected | `git check-ignore -q` exit |
|---|---|---|
| `.env.example` | not ignored | `1` ✅ |
| `.env` | ignored | `0` ✅ |
| `.env.local` | ignored | `0` ✅ |
| `.env.preview` | ignored | `0` ✅ |

No secrets became tracked: the three real env files remain ignored, and `git status` shows no new env paths. *Note: `git check-ignore -v` exits 0 when it matches a **negation** rule too, so the `-v` form reports "matched" for a non-ignored file — the `-q` exit code above is the authoritative test.*

---

## 9. Verification

| Check | Result |
|---|---|
| `npm test` | **308/308 passed** (was 309 — the single removed test is the prototype's own; see §6) |
| `npx tsc --noEmit` | clean, exit 0 |
| `npm run lint` | **exit 1 — pre-existing failure, unchanged by this slice.** See §9.1 |
| Production behaviour | unchanged — no `app/`, `lib/`, or `components/` source touched |
| Financial semantics | unchanged — no classifier, DayFacts, valuation, or aggregation file touched |
| TimelineLens behaviour | unchanged — the Atlas primitive and its guards are untouched; only an untracked harness moved |
| Concurrent work | excluded — committed with explicit pathspecs; no `git add -A`. Untracked files belonging to other sessions (`AGENTS.md`, five `docs/design/TIMELINE*` docs, two audit docs, `prototype/`) were left alone |

### 9.1 Newly discovered: the CI lint gate is red — **resolved in V25-CLOSE-1A**

`.github/workflows/ci.yml` runs `npm run lint` as a **blocking** gate. It currently exits `1` on **five tracked files, none touched by this slice**:

| File | Rule |
|---|---|
| `components/dashboard/TotpNudgeBanner.tsx:48` | setState synchronously within an effect |
| `components/platform/widget-kit.tsx:41` | setState synchronously within an effect |
| `components/ui/TurnstileWidget.tsx:99` | cannot access refs during render |
| `components/marketing/TurnstileWidget.tsx:94` | cannot access refs during render |
| `components/marketing/RequestAccessForm.tsx:138` | `react/no-unescaped-entities` |

An earlier pass in this session mistakenly reported lint as clean on tracked source. That was wrong: the ~6,124 total problems *are* dominated by the untracked `prototype/` tree (which never reaches CI), and isolating the tracked subset was what surfaced these five. Correcting it here rather than shipping the false claim, since the entire point of this slice is that the repository describes itself accurately.

**Not fixed here, deliberately.** All five are React correctness rules in production component code; fixing them means changing production behaviour, which this slice explicitly forbids. Two of them (`setState` in effect, refs during render) are real render-correctness smells rather than cosmetic lint, so they want a considered fix, not a `--fix` sweep.

> **Resolved in V25-CLOSE-1A** — all five fixed, `npm run lint` now exits 0 with zero errors. Root causes and per-file classification are recorded in that slice; the structural finding worth carrying forward is that **local lint and CI lint did not mean the same thing**. CI lints only tracked files; locally the untracked `prototype/` tree contributed ~6,100 problems, so `npm run lint` had exited 1 for so long that a non-zero exit carried no information — which is how five real blocking errors in tracked components survived an entire release cycle. `eslint.config.mjs` now ignores both prototype trees, so the two signals agree.

---

## 10. Remaining v2.5 closure items

**Class A — genuinely blocking closure (one item remaining):**

1. **Atlas palette-ratchet fence expansion.** `lib/atlas/palette-ratchet.test.ts:28` still scans only `components/dashboard`, `components/space`, `components/atlas`, with an empty `ALLOWLIST_FILES`. Expand to the unscoped trees and record explicit exemptions. → **V25-CLOSE-2**
2. ~~**Green the CI lint gate**~~ — **done in V25-CLOSE-1A** (§9.1). Kept visible here because the *reason* it was invisible for a release cycle is a standing hazard, not a one-off: a gate that has been failing for unrelated reasons stops being a gate.

**Strongly recommended alongside it (guards, class A/B boundary):**

2. Close the `prototype` hole at `timeline-lens-exclusivity.test.ts:79` and add a guard that prototype routes cannot ship.
3. Add the cross-authority parity guard for the three Space visibility resolvers (`lib/data/transaction-query.ts:99`, `lib/accounts/space-account-link.ts:114`, `lib/investments/account-scope.ts:35`) — they share the predicate but hand-roll the traversal three ways, each tested only in isolation.
4. Make the STATUS drift guard effective for this project's actual workflow (§1).

**Not blocking v2.5 closure:** the beta gate (§2.4) is a *release* gate on a separate track, and every class-B/C/D item is recorded in the ROADMAP table (§4).

---

## Closure verdict

**v2.5 is complete as architecture.** With this slice landed, one scoped exit criterion remains, and it is a test-fence expansion rather than construction. The ledger now describes the codebase that exists.
