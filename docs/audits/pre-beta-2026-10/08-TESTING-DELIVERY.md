# 08 — Testing and Delivery

Pre-beta audit of Fourth Meridian · `v2.6` · HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` · 2026-10-21 · read-only (no test suite, CI, Prisma, Next or Docker command was run; `gh` used for read calls only). Finding IDs `TEST-nnn`.

## 1. Verdict

The suite is large (743 files, ~158k lines, 743/743 green in CI run 38847934169 on this exact SHA) and the CI `architecture` job is genuinely strong: 25 invariant audits plus six acceptance suites (306 adversarial checks) against real `fm_app`/`fm_system` roles on a migrated Postgres. But the suite is structurally shallow where it matters most: 411 of 743 files read repository source as text, 187 API routes have 6 route tests of which exactly one invokes a real handler, authentication flows have no handler-level tests, and nothing asserts that every table has an RLS policy. Delivery governance is the weakest area in the whole audit: the repository is public, neither `main` nor `v2.6` has branch protection or rulesets, deploy runs no migrations and no smoke test, and there is no uptime monitor. Weighted testing-and-delivery score: **4.6 / 10**.

## 2. Test inventory and runner

Runner `scripts/run-tests.ts` (read in full): no framework; every `*.test.ts` under `lib/`, `app/`, `components/`, `jobs/`, `scripts/` is spawned as its own `tsx` child (`:142`); pass = exit 0; bounded pool (CPUs−1); five forecast suites run serially because they write mutant modules; **no per-file timeout and no watchdog**; `.test.tsx` would never be discovered (none exist). The CI unit job has no `DATABASE_URL`, so the unit tier is structurally DB-free. 45 files use `node:test`; the rest a hand-rolled `check()` counter. 0 `.skip`/`.only`.

| Dir | Files | Pure source-pin (no project import) | Mixed (pin + behaviour) | Behaviour only |
|---|---|---|---|---|
| lib/ | 628 | 55 | 282 | 291 |
| components/ | 91 | 20 | 46 | 25 |
| app/ | 13 | 7 | 5 | 1 |
| jobs/ | 3 | 0 | 3 | 0 |
| scripts/ | 8 | 1 | 4 | 3 |
| **total** | **743** | **79 (10.6%)** | **345 (46.4%)** | **319 (42.9%)** |

Kind distribution (±10%, classifier `scratchpad/ws5/classify*.mjs` plus manual reads):

| Kind | Count | Note |
|---|---|---|
| Pure unit (imports module, no source read) | 319 | |
| Source-scan pin (reads source text, asserts regex/strings) | 411 | 79 pure, 332 mixed |
| DTO/golden snapshot | 13 | e.g. `lib/account-classifier.golden.test.ts` |
| DB-backed in the unit tier | **0** | by construction |
| Route test invoking a real handler | **1** (`app/api/health/route.test.ts:17`) + 1 handler-seam (`app/api/ai/memory`) + 1 route-export test | |
| Route "test" = local mirror + source scan | 4 of 6 `route.test.ts` | `ai/chat`, `accounts/[id]/transactions`, `spaces/[id]/activity`, `users/search` |
| Component test (React) | 36 via `react-dom/server` `renderToStaticMarkup`; **0** DOM/RTL/jsdom | |
| Accessibility | ~42 assert `aria-*`/role strings in static markup; no axe, no keyboard/focus | |
| Concurrency on a real seam | ~15 meaningful (`lib/session-cache.test.ts`, `lib/platform/ai/allowance-reservation.test.ts`, `lib/ai/brief/lifecycle.test.ts:195`) | |
| Negative-path / failure injection | widespread; strong: `lib/plaid/cursor-safety.test.ts`, `lib/plaid/refresh-ledger-failure-matrix.test.ts` (963 lines), `lib/jobs/run.test.ts` | |
| Recovery/retry | `jobs/plaid-removal-retry.test.ts`, `lib/jobs/notification-retry.test.ts`, `lib/ai/brief/lifecycle.test.ts` | |
| Mutation testing | 5 forecast suites write 16+ real mutants and assert detection (`lib/forecast/engine.test.ts:639-700`) | rare and valuable |
| End-to-end (Playwright/Cypress) | **none**; no test library in `package.json` at all | |

Out-of-CI harnesses (verified absent from `ci.yml`/`ci-contract.ts`): 22 `scripts/ai-baseline/*.check.ts` (OpenAI + DB), `scripts/test-visibility-two-user-space.ts`, `scripts/reset-chase-history-test.ts`, `scripts/test-incident-preview-path.ts`.

## 3. Test quality (36 files read)

| File | What it actually proves | Verdict |
|---|---|---|
| `lib/session-cache.test.ts` | `resolveRevocation` never throws; N concurrent misses coalesce into one live check; bounded stale window | strong |
| `lib/auth/admin-session-projection.test.ts` | real `toAdminSessionView` + `NextResponse` bytes never contain the token | strong |
| `app/api/health/route.test.ts` | real `GET`: unreachable DB ⇒ 503; 31-call burst ⇒ 429 with frozen clock | strong (the only true handler test) |
| `app/api/ai/memory/route.test.ts` | `listMemory/retire/erase` via injected deps: 400/403, ownership scope, audit rows, rate-limit branch | strong (the pattern every route should follow) |
| `lib/plaid/webhook-receiver.test.ts` | revoked/needs-reauth/inactive-owner never start the pipeline; one evidence row per verified webhook | strong; replay of the same webhook id not asserted |
| `lib/plaid/cursor-safety.test.ts` | real `syncTransactionsForItem` over fake Prisma + scripted Plaid: cursor advances only when every row persisted | strong |
| `lib/plaid/removed-tombstone-reprojection.test.ts` | `removed[]` tombstones re-project events to WITHDRAWN; states the CI seed can never exercise this | strong |
| `lib/transactions/cash-flow-fold-authority.test.ts` | Summary == History Σ == Calendar Σ through the real fold | strong (would catch a transfer double count) |
| `lib/transactions/transfer-authority.test.ts` | admission, maturation, provider-link matching (121 checks) | strong |
| `lib/forecast/engine.test.ts` | cash-path pins + 16 real source mutants | strong |
| `lib/money/convert.test.ts` | conversion engine, coverage verdict, `convertAndSum` (76) | strong |
| `lib/platform/ai/cost-controls.test.ts` | 7 controls resolve; kill switch unreadable ⇒ DENY; one setting + one audit row per change | strong |
| `lib/jobs/run.test.ts` | ledger wrapper: rows, failure passthrough, ledger-never-breaks-job (66) | strong |
| `scripts/ci-local.test.ts` | `ci.yml` steps == contract; Node major pinned; no secrets in the site job | strong for its purpose |
| `lib/platform/ai/allowance-reservation.test.ts` | 5 concurrent admissions over a fake serialising tx | adequate; the fake once hid a real P2010 (closed by CI `rls:accept:allowance` 15/15) |
| `lib/jobs/dispatch.test.ts` | overlap guard (live `running` row never re-dispatched; stale one is) | adequate; two simultaneous dispatcher ticks are not raced |
| `lib/spaces/authorize.test.ts` | `can()` matrix (101) + scan that 3 routes call `requireSpaceAction` | adequate; states it cannot import the adapter |
| `app/api/ai/chat/route.test.ts` | 92 regex assertions on wiring | adequate, labelled a scan |
| `app/api/spaces/[id]/rls-t2-route-authority.test.ts` | per-route `db.` statement multisets with asserted denominators | strong for a scan |
| `app/api/spaces/[id]/activity/route.test.ts` | a local copy of `.sort().slice(0,60)` + scan | weak / misleading (named `route.test.ts`; handler never invoked) |
| `app/api/spaces/[id]/personal-single-user.test.ts` | a mirror of the PERSONAL predicate + scan | weak |
| `lib/snapshots/regenerate.test.ts` | the ~$9k evidence-gate regression cannot return, by text | weak |
| `lib/fx/archive-write-shape.test.ts` | `createMany` is one statement, by text | weak |
| `lib/account-deletion/preflight.test.ts` | sole-OWNER block predicate (9) | weak; deletion completeness untested |
| `components/transactions/TransactionDetailDrawer.test.ts`, `components/space/widgets/members/members.test.ts` | wiring / "client mirrors server rules", by text | weak |

Pattern assessment: source-scan pins are used well when they carry a denominator and a self-proving needle (rls-t2, session-token-exposure, docker-teardown) and poorly when they stand in for a behavioural test that could not be written because routes import `server-only` + Prisma at module load. The codebase already demonstrates the fix (`handlers.ts` + injected `deps`). Scans are brittle to refactors and blind to logic errors that keep the same tokens.

## 4. RLS and database acceptance (CI `architecture` job)

All six suites run after `prisma migrate deploy` + `prisma db seed` on `postgres:16`; counts verified from CI job 116802558049's log.

| Suite | Count | Proves | Does not prove |
|---|---|---|---|
| `rls:accept` (`scripts/rls-acceptance.ts`) | 34/34 | fm_app has no BYPASSRLS and owns nothing; enabled ⇒ FORCED; two-tenant read isolation with no tenant predicate; no existence oracle; INSERT/UPDATE repoint denied by WITH CHECK; cross-tenant UPDATE/DELETE affect 0 rows; SET LOCAL cleared on COMMIT/ROLLBACK/recycled session; missing identity ⇒ 0 rows; fm_backup dump complete | **no "every public table has RLS" assertion**; a handful of tables covered, not all; no GRANT census |
| `rls:accept:app` (2,670 lines) | 98/98 | distinct client per role; fm_auth cannot read tenant rows; fm_system reaches tenants by policy not BYPASSRLS; link semantics; membership escalation refused; removed member cannot self-reactivate; platform Space unclaimable | HTTP routes not exercised ("a `[service]` pass is not evidence that a route adopted it") |
| `rls:accept:ai` | 72/72 | inaccessible Space ⇒ INDETERMINATE with paired positive control; no tool argument selects another identity | model/prompt behaviour |
| `rls:accept:plaid` | 20/20 | six operational tables written by fm_system only; RLS enabled+forced on them | only those six tables |
| `rls:accept:foreground` (952 lines) | 67/67 | Bob cannot read/write Alice through the functions the converted routes call; refused writes RAISE; 17 converted routes import no `db`; 40 concurrent session touches write one row; idle-in-tx 15 s enforced; least-privilege EXECUTE matrix | route-level membership checks remain source-scanned |
| `rls:accept:allowance` | 15/15 | P2010 reproduced on real fm_system; 8 simultaneous turns on a 3-connection pool admit exactly 4; advisory lock per customer; fail-closed when lock/counter refused | — |

New-table risk, precisely: migrations grant nothing to `fm_app` by default (`20261002000100_rls_roles_and_policies/migration.sql:177,609-610` sets default privileges only for `fm_backup` SELECT), so a new table with no GRANT fails closed and loudly. A new table **granted to fm_app without a policy** (the natural copy-paste of an earlier migration) is readable cross-tenant and no CI step notices unless an acceptance case happens to touch it; `lib/platform/db-authority.ts:264` and `rls-acceptance.ts:207-209` flag only enabled≠forced.

## 5. Coverage gap register (business-critical paths)

| Critical path | State | Evidence |
|---|---|---|
| Login (`authorize()`, NextAuth route, `pre-login`) | partial | foreground cases 63-66 prove authorize + audit on fm_auth at the DB; rate-limit presence scanned by text; no handler test |
| Forgot / reset password | absent (handler) | `app/api/auth/{forgot-password,reset-password}` untested beyond `limitByIp` presence |
| TOTP setup/verify/disable/recovery codes | partial | policy predicate tested; the 5 `app/api/user/totp/*` routes untested |
| Email verification / email change | absent | `verify-email{,/resend}`, `user/email/confirm` untested |
| Session revocation | partial | `session-cache` strong; foreground case 48; `app/api/user/sessions/*` untested |
| Object-level authorisation per route | partial, scan-only | all 187 routes carry a gate (manual census); no CI test performs the census; 176/187 route dirs have no test; every `spaces/[id]/{invite,invites,members,permanent,restore,sections,transactions,snapshots,wealth/amend}`, all `user/*`, `admin/*`, `platform/*` have none |
| Plaid sync end-to-end (cursor restart, `removed[]`) | unit strong, e2e absent | `cursor-safety`, `removed-tombstone-reprojection`; Sandbox lane manual (2026-10-06) |
| Import rollback | partial | `app/api/imports/[id]/rollback` untested; batch-left-PROCESSING semantics only |
| Webhook replay / idempotency | partial | one evidence row per webhook proven; no test delivers the same webhook twice; `PlaidWebhookEvent` uniqueness not asserted |
| AI allowance concurrency | exists (strong) | `ai-allowance-acceptance.ts` 15/15 |
| Job double-execution | partial | in-process overlap guard; no DB-level race of two dispatcher invocations; `resume-stale-imports` every 5 min has no lock test |
| Account deletion completeness | absent | no test enumerates tables and asserts every user-keyed row is purged; `app/api/user/delete` untested |
| Snapshot regeneration | partial | source pins + pure cores; `check-snapshot-integrity` on seed |
| FX conversion; money rounding | exists | `convert.test.ts` (76), `fx/service.test.ts` (32), `money-presentation.test.ts`, `format.test.ts` |
| Export | partial | serialisers + round-trip; `app/api/user/export` untested |
| Daily Brief claim | in-memory only in CI | Postgres conditional-UPDATE atomicity proven only by an out-of-CI harness |
| Financial invariants on data | exists, seed-only | 25 REQUIRED audits over a ~360-transaction seed that has never seen a tombstone |
| Every table has RLS | absent | §4 |
| Dependency vulnerabilities | absent | no `npm audit` in `ci.yml`; coordinator measured 14 (2 critical) |

## 6. CI/CD and release controls

**`ci.yml`:** triggers `push` on all branches, `pull_request`, `workflow_dispatch`; jobs `test` (npm ci → prisma generate → test:unit → typecheck → lint), `architecture` (postgres:16 service, migrate deploy, seed, `audit:ci`, six acceptance suites), `site`. Latest run on HEAD: all green (test 4m10s, architecture 2m56s, site 36s). Node from `.nvmrc` (24), pinned to `engines` by test. No repository secrets consumed; `ENCRYPTION_KEY` is a documented throwaway constant. **Absent:** `permissions:` block, `timeout-minutes` (default 360 min), `concurrency`, artifact upload, coverage measurement, dependency audit, Dependabot config; actions pinned to mutable tags; runner image unpinned (`ubuntu-latest` migrating).

**`status-drift-guard.yml`:** advisory only (`exit 0` always); cannot block.

**Branch protection (verified by the coordinator with `gh`, authenticated):** `repos/virtuarch/FourthMeridian/branches/{main,v2.6}/protection` → 404 "Branch not protected"; `/rulesets` → `[]`; repository visibility **PUBLIC** (README §License: "published publicly for reference and portfolio purposes"). A red run has landed on `main` before (run 30118341969, 2026-07-24). `main` is 872 commits behind `v2.6`; 38 migrations have been added since `main`. The cutover plan's promotion step is a bare `git push origin <sha>:main`.

**Build reproducibility:** lockfile present and test-mirrored; `npm ci`; `.nvmrc`/`engines`/Vercel on 24; local machine on Node 26 is refused by `npm run ci` but not by `npm test` or `tsc`. `tsconfig.json:35` does not exclude `tmp/` (coordinator: 23 tsc / 578 lint errors from gitignored scratch files). `npm run ci` (`scripts/ci-local.ts`) is well designed (clean depth-1 copy, stripped DB URLs, throwaway Postgres on a random loopback port, `FM_DB_GUARD=clone-only`) but has a known, undocumented wedge defect (child in state S, 0% CPU, root cause unknown) and no per-file timeout.

**Deployment controls:** Vercel Git integration; `vercel.json` crons `*/15` and `*/5` (contradicting `production-readiness-checklist.md:26`, which says exactly one cron). `build` runs no migration (`scripts/check-schema-drift.ts:13-24` documents a 10-hour code/schema skew incident on 2026-07-26 whose ledgers swallowed their own write failures). Drift check is an operator CLI, not a deploy hook. `lib/env.ts` + `instrumentation.ts` refuse to boot without `PROD_REQUIRED_KEYS`; `lib/db/strict-mode.ts` requires `FM_RLS_STRICT=true` on `VERCEL_ENV=production`. Ignored Build Step for the app project: UNVERIFIED (documented only for `site/`).

**Preview validation:** entirely manual (STATUS rows record human browser checks; cutover plan §6 gates are human). No script performs a Preview smoke; crons never run on Preview (0 `JobRun` rows there, ever).

**Production release gates:** `docs/operations/release-checklist.md` has ~60 items, every one "Needs work"; `production-cutover-plan.md:358` says NO-GO pending §6 gates 1-11 and §8 issues 1-6; `production-readiness.md:70-84` lists 9 open config/ops gates (uptime monitor, backup/restore drill, Turnstile keys, `registration_mode`).

**Rollback:** 0 down migrations across 126; policy is fix-forward; re-promoting the old deployment reopens the forgeable-session defect (old shared `NEXTAUTH_SECRET`). Backward compatibility of migrations is asserted by review, never by running the old app on the new schema.

**Migration safety:** `db:migrate:safe` = `db-guard` (target identity) → `db:backup` → `migrate deploy`; non-interactive `migrate dev` blocked after the 2026-09-15 reset incident. Raw `npx prisma migrate` bypasses all of it. CI proves migrations apply from empty only.

**Docker cleanup:** `docker rm -f -v` on exit/SIGINT/SIGTERM (fix ecf84a4 in HEAD, pinned by `scripts/docker-teardown.test.ts`); no orphan sweep on start; `kill -9` of the parent orphans the container.

## 7. Would current CI detect a serious regression?

**Financial integrity.** Yes in the engine/fold/classifier/FX layers: a transfer double count fails `cash-flow-fold-authority` and the transfer audits; a dropped pending→posted dedup fails `cursor-safety` and `audit-pending-posted-desync` (if the seed exercises the transition; the tombstone case is unit-only); FX rounding fails `convert.test.ts`; a mis-signed forecast balance fails the mutant suite. **Silent:** a mis-sign or wrong population in a route DTO or Server Component after the fold (176 route dirs untested; component tests render fixtures), and any regression only visible on real provider data (Plaid pagination, `removed[]` on a live Item).

**Tenant isolation.** Yes at the DB boundary when the route reads through a tenant client (0 rows for the other tenant; the wrong HTTP status still goes unseen); yes for a new file importing `db`, a function regaining `client = db`, a table enabled-but-not-forced, a policy dropping the ACTIVE predicate, membership escalation by INSERT. **Silent:** a route that drops its membership check and reads through the migration principal in one of the 163 already-baselined files (the ratchet compares the file set, `scripts/audit-db-authority.ts:359`); a new table granted to fm_app with no policy; a tenant read switched to `systemDb` in any of ~150 unpinned routes.

**Deployment verification.** None automated. `/api/health` returns `{status, db, commit, time}` (30/min/IP) and reads via the owner client; it reports neither migration status nor RLS binding (those are on the operator-only `db-authority` route). No synthetic monitoring; Sentry is errors-only.

## 8. Findings

| ID | Finding | Sev | Status | Evidence | Beta blocker |
|---|---|---|---|---|---|
| **TEST-001** | No branch protection or rulesets on `main`/`v2.6`; repository public; Production auto-deploys from `main`; red runs have landed on `main` before | P1 | absence verified | `gh api …/protection` → 404; `/rulesets` → `[]`; `gh repo view` → PUBLIC; run 30118341969 | **Yes** (GO condition) |
| **TEST-002** | Route handlers effectively untested; the house "route test" proves mirrors and text | P1 | PARTIALLY IMPLEMENTED | 187 routes / 6 tests / 1 real handler; `spaces/[id]/activity/route.test.ts:27-33`; `lib/spaces/authorize.test.ts:13-18` | Yes for auth and Space-mutation routes |
| **TEST-003** | No gate asserts every table granted to fm_app has an RLS policy; owner-client ratchet is per-file | P1 | PARTIALLY IMPLEMENTED | `rls-acceptance.ts:207-209`; `lib/platform/db-authority.ts:264`; `audit-db-authority.ts:359`; migration `…:177,609-610` | Yes (cheap, high leverage) |
| **TEST-004** | Authentication flows have no handler-level tests | P1 | PARTIALLY IMPLEMENTED | 0 sibling tests for `auth/*`, `user/totp/*`, `user/sessions/*`; `release-checklist.md:167-170` makes the flow a manual item | Yes |
| **TEST-005** | No dependency-vulnerability gate while 2 critical / 9 high are present | P1 | NOT IMPLEMENTED | `ci.yml` grep; coordinator `npm audit` (= SEC-002) | Yes |
| **TEST-006** | Deploy does not migrate; no deploy-time drift check; no post-deploy smoke; no uptime monitor | P1 | PARTIALLY IMPLEMENTED (tooling unwired) | `package.json build`; `check-schema-drift.ts:13-24`; `production-readiness.md:82` | Yes (uptime + drift) |
| **TEST-007** | `npm run ci` can wedge indefinitely; no per-file or job timeout | P2 | UNVERIFIED root cause | `run-tests.ts:142-152`; `ci.yml` (no `timeout-minutes`); memory record only | No |
| **TEST-008** | No rollback path once a migration is applied; compatibility asserted by review | P2 | PLANNED (fix-forward) | 0 down migrations; cutover plan §9 | No (owner-accepted) |
| **TEST-009** | Deletion completeness, import rollback, webhook replay and job double-execution have no behavioural tests | P2 | PARTIALLY IMPLEMENTED | §5 | deletion completeness Yes (= PRIV findings); others No |
| **TEST-010** | No UI interaction, accessibility or e2e tests; component tests are static-markup pins | P2 | NOT IMPLEMENTED | 36 `renderToStaticMarkup`; 0 DOM; no test libraries | No |
| **TEST-011** | Source-scan pins are 55% of the suite and brittle in both directions | P3 | by design | 411/743 | No |
| **TEST-012** | CI hygiene: no `permissions`, `concurrency`, artifacts; mutable action tags; unpinned runner image | P3 | NOT IMPLEMENTED | `ci.yml` | No |
| **TEST-013** | Local reproducibility: `tsconfig` does not exclude `tmp/`; Node 26 locally vs 24 contract | P3 | PARTIALLY IMPLEMENTED | `tsconfig.json:35`; coordinator run | No |
| **TEST-014** | Stale/contradictory operations docs (cron count, migration counts 31/33/38, hang defect absent) | P3 | docs drift | `vercel.json` vs `production-readiness-checklist.md:26`; cutover plan §2 | No |

## 9. Scores

| Area | Score | Weight | Evidence | Strengths | Weaknesses | Confidence | Beta impact | Improvement |
|---|---|---|---|---|---|---|---|---|
| Unit tests | 7 | 3 | §2-3 | breadth, failure-injection, mutation testing | 55% text pins, mirror tests, no coverage measurement | high | medium | coverage tool; seam policy |
| Integration (service↔DB) | 7 | 3 | §4 | 306 adversarial checks on real roles | DB-only; seed cannot express tombstones | high | medium | add replay + deletion cases |
| API / route tests | 2 | 3 | TEST-002 | `ai/memory` seam pattern exists | 1 real handler test of 187 | high | **high** | seam + census |
| Database acceptance | 7 | 2 | §4 | migrate from empty, 25 audits, registry reconciliation | never against populated data | high | medium | clone rehearsal |
| RLS tests | 7 | 3 | §4 | strong isolation proofs, strict-mode refusal | no table-coverage census; per-file ratchet | high | medium-high | TEST-003 |
| Authentication tests | 3 | 3 | TEST-004 | session cache/degradation strong | no handler tests for login/reset/TOTP/verify | high | **high** | TEST-004 |
| Authorisation tests | 4 | 3 | §5 | `can()` matrix; DB boundary proven | object-level per route unproven at HTTP | high | high | route census + seams |
| Concurrency tests | 5 | 2 | §2 | allowance 8-way on a real pool; session 40-way | jobs/webhooks not raced | high | medium | DB-level overlap tests |
| Financial calculation tests | 8 | 3 | §7 | exact arithmetic, mutation-tested | DTO/render layer unguarded | high | low-medium | route DTO tests |
| AI policy tests | 7 | 2 | §4 | kill-switch fail-closed; concurrency on real DB | prompt behaviour out of CI | high | low | keep |
| UI interaction tests | 1 | 1 | TEST-010 | — | none | high | medium | Playwright smoke |
| Accessibility tests | 2 | 1 | §2 | aria names pinned | no axe/keyboard | high | low | axe on markup |
| End-to-end | 1 | 2 | §2 | — | none | high | medium | Preview smoke |
| Regression coverage | 7 | 2 | §3 | incident-born guards everywhere | many are text-level | high | low | — |
| Negative-path | 7 | 2 | §2 | fakes throw deliberately | HTTP error paths | high | low | — |
| Failure injection | 6 | 1 | §2 | good seams where present | 163 owner-client files have none | high | low | — |
| Recovery tests | 5 | 1 | §2 | retry/resume jobs | no restore drill | medium | medium | restore drill |
| Deployment verification | 1 | 3 | §7 | health exposes commit | nothing automated; no monitor | high | **high** | TEST-006 |
| GitHub Actions | 6 | 2 | §6 | one contract mirrored locally; registry gate | no timeouts/permissions/audit/artifacts | high | medium | TEST-005/012 |
| Branch protection | 1 | 3 | §6 | — | none; public repo | high | **high** | rulesets |
| Build reproducibility | 6 | 1 | §6 | lockfile, nvmrc, clean-copy runner | tmp/ pollution, Node 26, hang | high | low | TEST-013/007 |
| Deployment controls | 5 | 2 | §6 | fail-closed env gates | no migrate-on-deploy; shared secrets | high | medium | TEST-006 |
| Environment separation | 6 | 2 | §6 | code-level production refusals | shared `NEXTAUTH_SECRET`/`ENCRYPTION_KEY` records | medium | medium | cutover §4 |
| Preview validation | 3 | 2 | §6 | repeatable by hand | manual; crons never run on Preview | high | medium | scripted smoke |
| Production release gates | 4 | 2 | §6 | thorough list, honest NO-GO | mostly human; nothing enforces completion | high | medium | automate the automatable rows |
| Rollback readiness | 3 | 2 | §6 | additive migrations reviewed | no down migrations; session-defect trap | high | medium | expand/contract + rehearsal |
| Migration safety | 6 | 2 | §6 | guard, backup-before-migrate, drift CLI | manual apply ⇒ skew; raw bypass | high | medium | TEST-006 |
| Secrets in CI | 9 | 1 | §6 | none consumed; throwaway key pinned | — | high | low | — |
| Artifact integrity | N/A | — | no provenance/signing; Vercel builds from the SHA; stated | — | — | high | low | — |
| Docker resource cleanup | 7 | 1 | §6 | `-v` fix in HEAD, pinned | no orphan sweep | high | low | startup sweep |

Weighted mean: **4.6 / 10**. Confidence high; evidence coverage: runner, CI workflows, contract, all six acceptance suites' headers and the HEAD CI log, 36 test files read, `gh` branch-protection and visibility calls.
