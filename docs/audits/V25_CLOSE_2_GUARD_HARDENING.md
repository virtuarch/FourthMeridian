# V25-CLOSE-2 — Guard Hardening

**Status:** IMPLEMENTED.
**Date:** 2026-07-20.
**Scope:** guards and invariants only. No UI redesign, no financial-semantics change, no new product functionality, no v2.6 work.
**Baseline:** branch `feature/v2.5-spaces-completion`, on top of V25-CLOSE-1 (`f48b6a6`) and V25-CLOSE-1A (`c22b540`).

> **Purpose.** v2.5 built the architecture. This slice makes the repository *refuse to lose it*. Every guard here is an assertion over code that already exists — no new abstraction was introduced, and nothing was refactored to satisfy a test.

---

## 1. Palette ratchet fence expansion

### Weakness

Two independent holes, and the second made the first invisible.

**Coverage.** `SCAN_DIRS` was `components/{dashboard,space,atlas}`. Everything else rendered by the product — `components/{ui,charts,security,notifications,admin,connections,brief,platform,settings,transactions}` and every route under `app/` — was unfenced.

**Patterns.** The regex list matched `text-{colour}` for a full colour list, but `bg-` and `border-` **only for gray**. So `bg-blue-500` and `border-emerald-400` were never violations anywhere.

The two compounded into a false clean bill of health: the baseline read `{}`, which reads as *"the burn-down finished."* It had not. `components/dashboard/TotpSection.tsx` (23), `components/dashboard/AdviceBanner.tsx` (14), `components/space/sections/goals/GoalsCard.tsx` (11) all carried raw palette inside the *already-scanned* directories. **The fence looked clean because it was not looking.**

### Implemented guard

`lib/atlas/palette-ratchet.test.ts`:

- `SCAN_ROOTS = ["components", "app"]` — the whole rendered surface.
- `bg-` and `border-` now carry the same colour list as `text-`.
- Baseline regenerated: **41 files, 937 violations**, up from an empty object.

That number growing is the guard becoming honest, not a regression. Baseline mode fails only on *growth* or a *new* violating file, so every one of those 937 is now frozen at its current count.

### Inclusions and exclusions

| Included | Why |
|---|---|
| `components/**` | Product UI, Atlas consumers, and `components/charts` — the three things the ratchet exists to protect |
| `app/**` | Route-level JSX is product UI; `app/admin` (551) and `app/merchant-ops` (12) held the largest concentrations in the repo |

| Excluded | Why |
|---|---|
| `components/atlas/vendor/**` | Vendored third-party (`VENDORED.md`), kept pristine and not subject to our design rules. `eslint.config.mjs` excludes it for the same reason |
| `app/prototype/**` | Untracked design harnesses (V25-CLOSE-1). Scanning them would put machine-local files into a shared baseline, so the guard would fail for anyone who does not have them |
| `lib/**` | Holds no JSX, and design-token modules there (`lib/charts/chart-palette.ts`) legitimately carry raw colour values |

`ALLOWLIST_FILES` remains **empty by design** — baseline mode already tolerates existing violations per file, so a blanket allowlist would only hide growth.

**Deliberately not expanded:** raw hex / `rgb()`. Chart token modules legitimately define colour values, so matching hex needs its own burn-down and exemption story. Half-enforcing it here would have meant a large allowlist, which is the failure mode this slice is correcting. Recorded as follow-up.

### Invariant protected

> No file under `components/` or `app/` may increase its raw-palette count, and no new file may introduce raw palette at all.

### Mutation results

| # | Mutation | Expected | Result |
|---|---|---|---|
| M1 | `bg-blue-500` added to a clean file in a newly-covered dir (`components/connections/BuildIntelligencePanel.tsx`) | FAIL | ✅ `new violating file (1)` |
| M2 | one extra `text-emerald-400` in an already-baselined file (`app/admin/page.tsx`) | FAIL | ✅ `51 → 52 (increased)` |
| M3 | raw palette added inside the excluded vendor tree | PASS | ✅ still `OK` — exclusion honoured |

---

## 2. Prototype route guard

### Weakness

V25-CLOSE-1 *contained* the prototypes; nothing *kept* them contained. Every mechanism was a convention a future commit could undo silently — and the failure it prevents has already happened once: `app/prototype/timeline-component-v4/page.tsx` shipped as a public, unauthenticated route (App Router build + outside the `proxy.ts:116` matcher) for an entire release cycle.

### Implemented guard

`lib/prototype-containment.test.ts` — five assertions, one per containment mechanism, so none can rot unnoticed:

1. **TRACKING** — no file under `app/prototype/` or `prototype/` is tracked by git. *This is the one that actually stops a deploy*: Vercel builds from git, so untracked means unshipped. The other four are depth.
2. **GITIGNORE** — both trees stay ignored, so tracking cannot happen by accident.
3. **TYPECHECK** — `tsconfig.json` excludes both, so a broken experiment cannot fail `tsc --noEmit` for the real app.
4. **LINT** — `eslint.config.mjs` ignores both, so prototype noise cannot drown the CI lint signal (the exact masking that hid five real errors until V25-CLOSE-1A).
5. **TEST DISCOVERY** — `scripts/run-tests.ts` prunes `prototype`, so a prototype's private test copy cannot pose as a production invariant.

**Smallest correct enforcement.** A runtime `notFound()` guard was considered and rejected: it would add production code to solve a problem that is fully solved at the tracking boundary, and it would not stop the *other* four regressions. Asserting the boundary costs no runtime and covers all five.

This guards the prototypes' **boundary, not their existence** — deleting an experiment is never required to make it pass, and local experimentation is untouched.

### Invariant protected

> Prototype code can never become a production route, influence a production gate, or pose as a production invariant.

### Mutation results

Each mechanism was broken independently; each failed via its own assertion and no other.

| # | Mutation | Result |
|---|---|---|
| M1 | `git add -f app/prototype/timeline-component-v4/page.tsx` | ✅ FAIL (1. TRACKING) |
| M2 | removed `app/prototype/` from `.gitignore` | ✅ FAIL (2. GITIGNORE) |
| M3 | removed `app/prototype` from `tsconfig` exclude | ✅ FAIL (3. TYPECHECK) |
| M4 | removed the eslint ignore | ✅ FAIL (4. LINT) |
| M5 | emptied `NON_PRODUCTION_DIRS` in `run-tests.ts` | ✅ FAIL (5. TEST DISCOVERY) |

---

## 3. Visibility resolver parity guard

### Weakness

This is the boundary where a bug is *a family member reading another person's private account*, so it was investigated before anything was written.

The **predicate** (`TRANSACTION_DETAIL_VISIBILITY`) is already canonical and correctly reused — investigation confirmed **100% compliance**: every `visibilityLevel: { in: … }` in `lib/` and `app/` references the shared constant, with zero inline level arrays. That part of the architecture is sound.

What was unenforced is the **query**. Three resolvers hand-roll the traversal three different ways, each unit-tested only against itself:

| Resolver | spaceId | status ACTIVE | shared predicate | soft-delete |
|---|---|---|---|---|
| `lib/data/transaction-query.ts` → `resolveVisibleAccountIds` | ✓ | ✓ | ✓ | ✓ |
| `lib/accounts/space-account-link.ts` → `resolveFullVisibleAccountIds` | ✓ | ✓ | ✓ | ✓ |
| `lib/investments/account-scope.ts` → `resolveSpaceInvestmentAccountIds` | ✓ | ✓ | ✓ | ✓ |

They agree today. The realistic regression is not someone deleting the predicate — it is a fourth reader, or an edit to a third, quietly dropping `status: ACTIVE` or the soft-delete filter and returning a slightly larger set than its siblings.

A second, subtler divergence vector was found: several surfaces gate detail with an **in-memory** `=== VisibilityLevel.FULL` comparison rather than `grantsTransactionDetail()` — `lib/ai/assemblers/accounts.ts` (4 sites), `lib/activity/account-name-privacy.ts`, `lib/activity/scrub-account-name.ts`. These are correct **only while the tier is exactly `[FULL]`**. Widening the predicate would leave them silently disagreeing with every database query.

### Implemented guard

`lib/visibility-resolver-parity.test.ts` — seven assertions:

- **Parity (×3)** — each Space-scoped resolver applies all four constraints, asserted against its extracted function body.
- **Single expression of the tier** — a Prisma `visibilityLevel` gate must reference the shared constant; an inline level array is a second definition and fails.
- **Predicate pinned** — `TRANSACTION_DETAIL_VISIBILITY` must be exactly `[VisibilityLevel.FULL]`. If it changes, the failure message *names the in-memory comparison sites that must convert in the same change*. This turns an invisible drift into a blocking, self-documenting one.
- **Enrolment** — any file referencing the predicate in code must be a known authority. Fails **closed**: a new detail-gated read is a change to the privacy boundary, so it gets reviewed rather than merged quietly.
- **Account-centric exception** — `resolveSingleAccountScope` is deliberately excluded from parity (below), but pinned so it can never become looser than its siblings on the constraints that do apply.

**No new abstraction was introduced.** Per the brief, these are assertions over the existing architecture, not a wrapper the resolvers must now route through.

### Two findings worth recording

**(a) `resolveSingleAccountScope` ignores `spaceIdHint`.** Its `detailEligible` branch queries `spaceAccountLink.findFirst` with **no `spaceId`** and **no soft-delete filter**. An account that is FULL in Space A therefore resolves while reading in Space B.

It is *not* simply a bug: the function answers a different question (*"may this account be read in detail at all?"*) for account-centric callers that may have no Space context — its existing tests deliberately pass `spaceIdHint = null`. Tracing the callers, it is **not currently reachable with an attacker-chosen account id**: the only HTTP route on this path (`app/api/spaces/[id]/investments/route.ts`) accepts no `financialAccountId` parameter, and internal callers pass ids they already authorised.

It is recorded here as a **follow-up**, not silently blessed: when a `spaceIdHint` *is* supplied, ignoring it is a latent divergence. Fixing it means deciding whether the "no space context" case should keep its current meaning — a semantics decision, out of scope for a guard slice.

**(b) The `grep` count for the predicate is misleading.** `grep -rl TRANSACTION_DETAIL_VISIBILITY` reports ~20 files; only **11** reference it in code. The other nine name it in prose while delegating to a resolver or to `grantsTransactionDetail()`. The guard strips comments before scanning, so the two numbers must not be conflated — enrolling a comment-only file would make the anti-vacuity floor unfalsifiable.

### Invariant protected

> Every Space-scoped detail resolver asks the same question, the detail tier has exactly one definition, and a new reader of the privacy boundary cannot appear without review.

### Mutation results

| # | Mutation | Expected assertion | Result |
|---|---|---|---|
| M1 | dropped `status: ACTIVE` from `resolveFullVisibleAccountIds` | parity | ✅ FAIL |
| M2 | dropped the soft-delete filter from `resolveSpaceInvestmentAccountIds` | parity | ✅ FAIL |
| M3 | replaced the shared predicate with `[VisibilityLevel.FULL]` inline | single expression | ✅ FAIL |
| M4 | widened the predicate with `BALANCE_ONLY` | predicate pinned | ✅ FAIL |
| M5 | added a new unregistered detail reader | enrolment | ✅ FAIL |

Each mutation failed via its own assertion and no other.

### A bug found in the guard itself

The first version of `functionBody()` took the first `{` after a declaration. That is wrong when a return type contains braces:

```ts
): Promise<{ accountIds: string[]; spaceId: string | null }> {
```

It sliced the **type literal** instead of the body. The three parity assertions passed anyway — purely because those resolvers return `Promise<Set<string>>` / `Promise<string[]>`, which have no braces. The slicer now walks past the parameter list and takes the first `{` at generic-depth zero, and asserts the extracted body contains statements — a self-check that would have caught the original mistake instead of letting it pass by luck.

Recorded because it is the general hazard of source-scan guards: **a guard that silently inspects the wrong text still reports green.**

---

## 4. Verification

| Check | Result |
|---|---|
| `npm test` | **314/314 passed** (311 + the three new guard files) |
| `npm run lint` | exit **0** |
| `npx tsc --noEmit` | exit **0** |
| No UX-CLOSE changes | ✅ `BreakdownWidget.tsx`, `wealth-adapters.tsx`, `WealthCompositionCard.tsx`, `WealthCompositionDetail.tsx`, `wealth-composition.test.ts` left untouched and unstaged |
| No TX changes | ✅ none touched |
| No Timeline changes | ✅ none touched; `docs/design/TIMELINE*` left unstaged |
| Commit discipline | ✅ explicit pathspecs only; no `git add -A` |

**Baseline contamination check.** The palette baseline was regenerated while another session's uncommitted wealth-widget work was in the tree. Verified explicitly that none of those files appear in the baseline (they carry zero palette violations), so the recorded counts cannot shift when that work lands.

---

## 5. Remaining v2.5 closure items

**Class A — blocking closure: none.** With the ratchet fence expanded, the last named v2.5 exit criterion is met. v2.5 is closeable as architecture.

**Class B — polish, not blocking** (unchanged from the closure review, plus two found here):

1. FX rate-miss disclosure — `lib/money/convert.ts:59` renders native amounts as the target currency behind only an `≈`.
2. Audit + fresh-access on the three `app/api/admin/plaid/*` operator routes.
3. Debt/Liquidity zero-data workspace states; Space template picker descriptions; dead-code sweep (~694 LOC).
4. **New —** `resolveSingleAccountScope` should honour `spaceIdHint` when supplied (§3a). Needs a semantics decision, not just a guard.
5. **New —** convert the in-memory `=== VisibilityLevel.FULL` comparisons to `grantsTransactionDetail()` (§3). Behaviour-identical today; the pinning assertion blocks the drift until then.
6. **New —** palette burn-down of the 937 baselined violations, concentrated in `app/admin` (551) and `components/admin` (223), both slated for retirement into Platform HQ.

**Class C (v2.6) and D (later scaling)** — unchanged; see `docs/plans/ROADMAP.md`.

---

## Closure verdict

**v2.5's architecture is now defended by tests, not by convention.** Three guards, seventeen assertions, thirteen mutations — each verified to fail for its own reason and only its own. The remaining v2.5 work is a release gate (beta config and ops), not an architectural one.
