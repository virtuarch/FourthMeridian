# 13 — Evidence Index

Fourth Meridian pre-beta audit · 2026-10-21. Every finding in reports `02`-`11` cites `file:line` references read at this exact commit; this index records the commit, the commands run, the scripts written, the tests examined, the environment limitations, and the claims that remain unverified.

## 1. Commit and repository state

| Item | Value |
|---|---|
| Repository | `/Users/chrstn/dev/FourthMeridian` → `https://github.com/virtuarch/FourthMeridian.git` (visibility **PUBLIC**, verified with `gh repo view`) |
| Branch | `v2.6` |
| HEAD | `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` ("Merge approved UI hardening and simplified AI Policies into v2.6") — equal to the last approved commit named in the brief; `origin/v2.6` at the same SHA |
| Working tree at start | clean except one pre-existing untracked file `docs/plans/UNIVERSAL-FINANCIAL-CONNECTOR-ARCHITECTURE-P0.md` (preserved, untouched) |
| Working tree at end | the same, plus the new untracked directory `docs/audits/pre-beta-2026-10/` (this audit). No tracked file was modified. Nothing was committed, pushed, merged or deployed. |
| Sibling worktrees | 16 listed by `git worktree list`; none touched |
| Ancestry checks | `git merge-base --is-ancestor 89a46ad HEAD` → true; `e67fa58` → true; `ecf84a4` → true; `3241f16` → true; `dc3755f` → true. (The coordinator's first `git branch --contains 89a46ad` was truncated by `head -3` and wrongly suggested the fix was absent; corrected and re-verified.) |
| `main` vs `v2.6` | `main` is 872 commits behind and 1 commit ahead (`87e4df7`, a content-identical cherry-pick); 38 `migration.sql` files added since `main` |
| Latest CI on HEAD | GitHub run 38847934169 (CI) and 38847934157 (STATUS drift guard), both `success`, created 2026-10-16T03:55Z; architecture job 116802558049 log: 25 REQUIRED audits, RLS suites 34/34, 98/98, 72/72, 20/20, 67/67, allowance 15/15; unit job: 743/743, eslint 19 warnings 0 errors |
| Branch protection | `gh api repos/virtuarch/FourthMeridian/branches/{main,v2.6}/protection` → 404 "Branch not protected"; `/rulesets` → `[]` |

## 2. Evidence IDs

Evidence is identified by the finding ID that carries it (e.g. `SEC-001`, `FIN-001`); each finding row in the subject reports lists its `file:line` evidence. Cross-report duplicates are recorded as equivalences: ARCH-003 ≡ CQ-004; ARCH-001 ≡ CQ-007; ARCH-004 ≡ OPS-003; SEC-003 ≡ DB-003 ≡ ARCH-002 (scope overlap); DB-001 ≡ OBS-007 ≡ PRIV-003 (overlap); IDEMP-009 ≡ OBS-005 (overlap); SEC-AI-003 ⊂ OPS-004; PRIV-001 ≡ DB-011 (overlap); PRIV-002 ⊂ UI-013; OPS-002 ≡ OBS-001 (overlap); OPS-013 ≡ OBS-012 (overlap).

## 3. Commands executed by the coordinator (all read-only)

```
git rev-parse HEAD; git status --short; git log --oneline -5; git branch --show-current; git worktree list
git branch --contains 89a46ad; git branch --contains ecf84a4; git merge-base --is-ancestor 89a46ad HEAD; git merge-base --is-ancestor e67fa58 HEAD
git log origin/v2.6 --oneline -1; git fetch --dry-run
find app/api -name route.ts | wc -l (187); find app -name page.tsx; find <dir> -name '*.test.ts' (lib 628, app 14 incl. one excluded prototype test, components 91, jobs 3, scripts 8)
grep -c '^model ' prisma/schema.prisma (70); ls prisma/migrations | wc -l (127 entries = 126 + lock)
cat vercel.json; sed -n 1,80p proxy.ts; sed -n 27,72p next.config.ts; cat .github/workflows/ci.yml (head); npx tsx scripts/run-audits.ts --list
node -e '<package versions from node_modules/*/package.json>' (next 16.2.7, next-auth 4.24.14, openai 6.45.0, prisma 5.22.0, plaid 42.2.0, react 19.2.4, react-markdown 8.0.7, @sentry/nextjs 10.67.0, resend 6.17.1, exceljs 4.4.0, papaparse 5.5.4)
PATH=node@24 npx prisma generate; npx tsc --noEmit (0 errors in tracked code; 23 in gitignored tmp/); npx eslint (0 errors in tracked code; 578 in gitignored tmp/)
npm audit --omit=dev (14: 2 critical, 9 high, 3 moderate); npm audit --json (20 incl. dev); cd site && npm audit --omit=dev (3)
grep for next/image (6 files), ImageResponse (0), "use server" (0), rewrites (0)
sed -n 540,590p lib/auth.ts; sed -n 160,200p proxy.ts; sed -n 18,40p app/admin/layout.tsx; sed -n 28,45p 'app/(shell)/dashboard/layout.tsx'  (SEC-001 verification)
sed -n 140,215p lib/platform/ai/allowance-reservation.ts  (fail-closed reservation verification)
gh repo view --json nameWithOwner,visibility,isPrivate,defaultBranchRef; gh api repos/{owner}/{repo}/branches/{main,v2.6}/protection; gh api repos/{owner}/{repo}/rulesets; gh run list --branch v2.6 --limit 3
ls LICENSE*; grep -n License README.md; grep -rnoE 'qirfzvvaeddukjiphims|dpl_[A-Za-z0-9]{20,}' docs | wc -l (14)
awk/sed/grep over STATUS.md, docs/audits/PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md §10, docs/operations/production-cutover-plan.md §1, §6-§10
mkdir -p docs/audits/pre-beta-2026-10 (the only write to the repository tree)
```

Not run, by rule: `npm test`, `npm run ci`, any `prisma` command other than `generate`, `next dev/build`, any script under `scripts/` or `jobs/` that takes a database URL, any provider or model call, any browser automation, any connection to Preview or Production.

## 4. Scripts written by workstreams (scratchpad only, read repository files only)

`/private/tmp/claude-501/-Users-chrstn-dev-FourthMeridian/4158b24c-90b6-4dca-a1dd-507d4c2645e9/scratchpad/`:
- `ws1/depgraph.js` (import graph: 2,214 files, 7,384 edges; Tarjan SCCs; fan-in/out; boundary violations; `process.env` reads), `ws1/loopq.js` (Prisma-in-loop heuristic), `ws1/unused-exports.js`, `ws1/routes.txt`, `ws1/srcfiles.txt`, `ws1/env-*.txt`
- `ws2/rls_cov.py` (RLS coverage from migration SQL), `ws2/inventory.sh`, `ws2/inventory2.sh`, `ws2/matrix.py` (route authorisation matrix)
- `ws3/` (sub-read notes), `ws4/scan_findmany.py` (136 `findMany` sites classified), `ws4/models.txt`, `ws4/rls.txt`
- `ws5/classify.mjs`, `ws5/classify2.mjs` (test-kind classifier), `ws5/arch-job.log` (saved CI architecture-job log, 3,565 lines)
- `ws6/` (sub-auditor notes)
- Workstream drafts: `ws1-architecture-redundancy.md`, `ws2-security.md`, `ws3-financial-idempotency.md`, `ws4-database-reliability.md`, `ws5-testing-cicd.md`, `ws6-spaces-observability.md`, `ws7-ai-security-privacy.md`; coordinator static-check output `static-checks.txt`.

## 5. Files and tests examined

Each subject report ends with an evidence log listing the files read in full or in cited ranges. In aggregate: `proxy.ts`, `next.config.ts`, `vercel.json`, `instrumentation*.ts`, `package.json`, `tsconfig.json`, `.gitignore`, `.github/workflows/*`; `lib/auth.ts`, `lib/session.ts`, `lib/auth/*`, `lib/security/*`, `lib/db.ts`, `lib/db/*`, `lib/platform/**` (authorize, policy, settings, ai, ops, alerts, refresh, security, growth, customer, scheduler, db-authority), `lib/spaces/*`, `lib/space.ts`, `lib/api.ts`, `lib/env.ts`, `lib/rate-limit.ts`, `lib/plaid/**`, `lib/crypto/**` (transports and syncs), `lib/prices/**`, `lib/fx/**`, `lib/money/**`, `lib/transactions/**` (classifier, cash-flow, canonical spending, transfer authority, corrections, event-write, fingerprint), `lib/forecast/**`, `lib/ai/**` (provider, invocation, allowance, conversation runtime, tools, memory, brief, assemblers), `lib/snapshots/**`, `lib/account-deletion/**`, `lib/export/**`, `lib/alerts/**`, `lib/jobs/**`, `jobs/*.ts`, `lib/monitoring/**`, `lib/connections/**`, `lib/freshness/**`, `lib/imports/**`, `lib/assets/**`; all 187 `app/api/**/route.ts` at guard level and 81 in full; `app/(shell)/**`, `app/admin/**`, `app/merchant-ops/**` pages and layouts; `components/ai/Markdown.tsx`, `components/platform/**` (all 55 widgets), `components/space/**`, `components/dashboard/**` (targeted); `prisma/schema.prisma`; the RLS migrations `20261002000100` through `20261015120000`; `scripts/run-tests.ts`, `scripts/ci-local.ts`, `scripts/lib/ci-contract.ts`, `scripts/audit-registry.ts`, `scripts/run-audits.ts`, `scripts/rls-*acceptance.ts`, `scripts/ai-allowance-acceptance.ts`, `scripts/audit-db-authority.ts`, `scripts/lib/db-authority-baseline.json`, `scripts/db-guard.ts`, `scripts/db-backup.ts`, `scripts/check-schema-drift.ts`; `content/marketing/{privacy,terms,legal-ai}.md`; `STATUS.md`; `docs/operations/*` (cutover plan, environment separation, security checklist, release checklist, readiness, incident response, background jobs, key rotation, database safety, legal factual basis); `docs/plans/AI-RELIABILITY-*`, `AI-COST-CONTROLS-REPORT-2026-10-15.md`, `UI-HARDENING-REPORT-2026-10-16.md`, `PLATFORM-SPACES-UX-REFINEMENT-P1-REPORT-2026-10-15.md`, `UI-PLATFORM-COVERAGE.md`, `UI-SURFACE-COVERAGE.md`; `docs/audits/PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md`.

Tests read (36 named in `08-TESTING-DELIVERY.md` §3) include `lib/session-cache.test.ts`, `lib/auth/admin-session-projection.test.ts`, `app/api/health/route.test.ts`, `app/api/ai/memory/route.test.ts`, `lib/plaid/webhook-receiver.test.ts`, `lib/plaid/cursor-safety.test.ts`, `lib/plaid/removed-tombstone-reprojection.test.ts`, `lib/transactions/cash-flow-fold-authority.test.ts`, `lib/transactions/transfer-authority.test.ts`, `lib/forecast/engine.test.ts`, `lib/money/convert.test.ts`, `lib/platform/ai/cost-controls.test.ts`, `lib/platform/ai/allowance-reservation.test.ts`, `lib/jobs/{run,dispatch}.test.ts`, `app/api/spaces/[id]/rls-t2-route-authority.test.ts`, `scripts/ci-local.test.ts`, `scripts/docker-teardown.test.ts`.

## 6. Environment limitations

| Limitation | Consequence |
|---|---|
| Local Postgres unreachable (Docker daemon not running; not started by rule) | no `pg_catalog` RLS verification, no row counts, no EXPLAIN plans, no installed-index confirmation; RLS coverage derived from migration SQL |
| No running application or browser | every rendered-output, accessibility, mobile and runtime-behaviour statement is UNVERIFIED |
| No Preview or Production access (by rule) | live env values, deployed SHA on Preview, `JobRun` state, Sentry delivery, Vercel plan tier, Supabase tier/PITR, external monitors: UNVERIFIED |
| No test suite, CI, scripts or provider calls executed | correctness claims rest on code reads plus the recorded GitHub CI run on HEAD |
| Node 26 locally vs the 24 contract | typecheck/lint were run under Node 24 via Homebrew `node@24`; `tmp/` pollution noted |
| Agent-derived evidence | seven read-only workstreams produced the drafts; the coordinator re-verified in code every finding promoted to P1 that it could reach (SEC-001, the allowance reservation, branch protection, repository visibility, dependency advisories) and reconciled contradictions (notably the brief's stale premise about `89a46ad`) |

## 7. Unverified claims (explicit)

1. The live RLS catalog state on any environment (policies installed, FORCE flags, role grants).
2. Query performance and index usage under real data; connection-pool behaviour at 100+ concurrent users (all PREDICTED).
3. Vercel cron overlap/retry semantics; whether Vercel drains `void` promises and `after()` work after the response; the Vercel plan tier that decides whether `maxDuration 300` is honoured.
4. Whether Cloudflare fronts Production (decides ARCH-003 exploitability); whether Vercel overwrites `x-forwarded-for`.
5. The Next.js build mode on Vercel (Turbopack vs webpack) for the GHSA-6gpp advisory; actual Next rendering on an RSC throw without a segment `error.tsx`.
6. Sentry alert rules, recipients and whether v2.6 events have ever been delivered.
7. Presence per environment of `RESEND_API_KEY`, `PLATFORM_ALERTS_EMAIL`, `TURNSTILE_*`, `NEXT_PUBLIC_SENTRY_DSN`; whether any external uptime monitor exists; whether `evaluate-alerts` has ever run on Preview or Production.
8. OpenAI account-level data retention, DPA and project spend limits.
9. Numeric parity of the three projection engines and of the live spending aggregations (CQ-017/018); magnitude of null-currency and pending-in-complete-month rows (FIN-004/014).
10. Whether stored SpaceMemory checkpoints carry a definition version for the spending window; whether `deriveSourceHealth` disambiguates a null provider balance (FIN-011).
11. The Production state of `DISABLE_SYSTEM_ADMIN` and of the admin account; whether any CONTROL grant exists on Preview/Production.
12. The root cause of the local `npm run ci` wedge (recorded only in agent memory).
13. The `RateLimit` upsert first-request race (DB-013) and the Plaid public-token single-use assumption (IDEMP matrix).
14. The 106 routes verified at guard level only (object-level checks read for 81).
15. The prior audit's items FM-AUDIT-003/004/005/016/021/022/025 (not re-probed).

## 8. Report inventory

| File | Lines | Subject |
|---|---|---|
| `01-EXECUTIVE-SUMMARY.md` | — | decision, scorecard, top 10, conditions, scope |
| `02-ARCHITECTURE.md` | — | Part 1 |
| `03-SECURITY.md` (+ Appendix A, 187-route matrix) | — | Part 2 incl. AI security |
| `04-FINANCIAL-INTEGRITY.md` | — | Part 3 |
| `05-IDEMPOTENCY-CONCURRENCY.md` (55-operation matrix) | — | Part 4 |
| `06-DATABASE-RELIABILITY.md` | — | Parts 5-6 |
| `07-CODE-QUALITY-REDUNDANCY.md` (redundancy register) | — | Part 7 |
| `08-TESTING-DELIVERY.md` | — | Part 8 |
| `09-SPACES-SCORECARD.md` (13 Spaces × 18 categories) | — | Part 9 |
| `10-OBSERVABILITY-SCORECARD.md` (27 items × 10 attributes) | — | Part 10 |
| `11-PRIVACY-COMPLIANCE.md` (11 compliance questions) | — | Part 11 |
| `12-BETA-RELEASE-PLAN.md` | — | Part 12 |
| `13-EVIDENCE-INDEX.md` | — | this file |
| `SCORECARD.md` | — | every grade on one page |
