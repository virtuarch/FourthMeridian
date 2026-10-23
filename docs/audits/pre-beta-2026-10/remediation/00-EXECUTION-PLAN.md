# 00 — Execution Plan

Pre-beta remediation program · Fourth Meridian · started 2026-10-22 · baseline `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` (`v2.6`, verified clean at start except the untracked audit directory and one untracked plan document).

## 1. Mandate

Resolve the confirmed findings of the static audit (`../01`–`13`, `SCORECARD.md`) and the runtime verification (`../runtime/01`–`12`), remove the owner-authorised abandoned product surfaces (Credit, Growth product Space), remove verified dead code, modularise the AI tools module, and produce an evidence-backed beta release candidate on a **local** integration branch. Nothing is pushed, merged into `main`/`v2.6`, deployed, or run against Preview/Production.

## 2. Repository control

| Item | Value |
|---|---|
| Baseline | `cde8fa0` on `v2.6` (HEAD of the main checkout; untouched by this program) |
| Integration branch | `remediation/beta-1` (cut from `cde8fa0`), worktree `/Users/chrstn/dev/FourthMeridian-remediation/base` |
| Agent branches | `remediation/{a-security,b-financial,c-idempotency,d-ai-reliability,e-observability,f-release-eng,g-hygiene}` + wave-2 branches, each in its own worktree under `/Users/chrstn/dev/FourthMeridian-remediation/<letter>` |
| Pre-existing worktrees | 15 other worktrees (`aicost/*`, `beta/*`, `rwa*`, `uxp1/*`, `fix/*`, `ui/*`) left untouched |
| Node | 24 (`/opt/homebrew/opt/node@24/bin`), per `.nvmrc`/`engines`; the shell default is 26 and is not used for gates |
| Database for tests | throwaway `postgres:16` containers started by `scripts/ci-local.ts`; no live database is pointed at |
| GitHub state (read-only check 2026-10-22) | repository `public`; `rulesets` = `[]`; `main` not protected |

## 3. Phases

| Phase | Content | Status |
|---|---|---|
| 0 Discovery & control | state verified; audits read; register, ownership matrix, worktrees, baseline gate | DONE |
| 1 Critical functional remediation | SEC-001/006, FIN-001/002, IDEMP-001/002, SEC-AI-003, SEC-008/ARCH-003, OBS-001/002/003, IDEMP-009 | DONE |
| 2 Remaining P1 + release gates | privacy, dependency gate, RLS census gate, auth handler tests, STATUS re-baseline | wave 1 (F, A) + wave 2 |
| 3 Product retirement & cleanup | Credit, Growth product, Markets coming-soon, orphans, deps, duplicate authorities | wave 1 (G) + F (deps) |
| 4 AI modularisation | after D (AI reliability) and B (financial) are integrated | wave 2 (H) |
| 5 Regression & hardening | full `npm run ci` on the integration SHA, PG17 run if feasible | after each integration |
| 6 Release readiness | `10`, `11`, `12` | end |

## 4. Waves

**Wave 1 (parallel, disjoint file ownership — see `02-AGENT-OWNERSHIP.md`):** A security/privacy · B financial · C idempotency/data/jobs (sole schema owner) · D AI reliability (sole `lib/ai/**` owner this wave) · E observability/operations · F release engineering/testing (sole `package.json`, CI, `tsconfig` owner) · G product retirement and code hygiene.

**Integration 1:** orchestrator merges A–G `--no-ff` into `remediation/beta-1` in dependency order (F first so the dependency upgrade is the base everyone's tests run on; then A, C, B, D, E, G), resolves conflicts, runs the full gate.

**Wave 2 (after integration 1):** H AI modularisation (`lib/ai/conversation/tools.ts`) · I UI hardening (UI-003/006/007/010 + remaining UI P2) · J auth/route handler tests (TEST-002/004) and any wave-1 leftovers.

**Integration 2 + Phase 5/6.**

## 5. Rules every agent works under

1. One worktree, one branch, commit locally with finding IDs in the subject; never push, never merge, never touch another worktree or the main checkout.
2. Own only the files in the ownership matrix. A needed change outside the owned set is reported, not made.
3. Every fix ships with a test in the same commit. Tests must pass with `npm run test:unit` (Node 24) in the agent's worktree before the agent reports done; `npm run typecheck` and `npm run lint` must be clean.
4. No live database, no real provider key, no network call to a provider. Throwaway Postgres only.
5. Preserve the controls the runtime audit confirmed working: AI allowance reservation/release, fail-closed reservation, kill switch, cross-user AI isolation, RLS tenant isolation.
6. Report back with: commits (SHA + subject), findings closed/partial/deferred with evidence, tests added, anything out of scope that was found.

## 6. Baseline gate

`npm run ci` on `cde8fa0` in `base` — result recorded in `04-TEST-EVIDENCE.md` §1.

## 7. Outcome (2026-10-22)

All phases executed locally. Wave 1 (A–G) and wave 2 (H, I, J) merged into `remediation/beta-1`; final code HEAD `01098bd` passes the full local CI contract and the app production build. Concurrency was reduced mid-program to two agents / one heavy process on owner instruction (8 GB machine). Results: `10`, `12`, `MORNING-HANDOFF.md`; owner gates: `11`.
