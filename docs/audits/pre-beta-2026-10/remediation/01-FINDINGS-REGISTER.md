# 01 — Findings Register (authoritative)

One row per finding from the static audit (`../02`–`11`, coordinator severities from `../12-BETA-RELEASE-PLAN.md`) reconciled with the runtime verification (`../runtime/09`). Status vocabulary: **OPEN** · **IN PROGRESS** · **RESOLVED** (code + test on the integration branch) · **PARTIAL** · **DEFERRED** (reasoned, not dropped) · **OWNER** (needs owner credentials/decision/live operation) · **REFUTED** · **NOT APPLICABLE**. Runtime class: CONFIRMED / SUPPORTED / PARTIAL / REFUTED / UNVERIFIED / — (not runtime-testable).

Columns: ID · Sev · Runtime · Component · Root cause (short) · Agent · Planned remediation · Required tests · Depends on · Status · Evidence (commit) · Residual risk · Gate.

Counts at baseline: P0 0 · P1 34 · P2 77 · P3 73 (static); runtime reclassified UI-001 P2→P3 and refuted the TEST-003 exposure (gate gap remains).

## P1 (34)

| ID | Sev | Runtime | Component | Root cause | Agent | Planned remediation | Required tests | Depends | Status | Evidence | Residual | Gate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SEC-001 | P1 | CONFIRMED | `lib/auth.ts` jwt `update`, `proxy.ts`, admin + dashboard layouts | client-updatable `requireTotpSetup` trusted by page gate; layouts never re-check DB flag | A | drop the client-update branch; layouts redirect when `session.requireTotpSetup`; proxy keeps DB-derived flag | pending session cannot render `/admin`; jwt ignores client `requireTotpSetup` | — | OPEN | | | G1 |
| SEC-006 | P2→GO | SUPPORTED | admin 2fa-reset route | `adminTotpCode` never verified; SYSTEM_ADMIN targets allowed | A | verify actor TOTP; refuse SYSTEM_ADMIN targets | route test | SEC-001 | OPEN | | | G1 |
| SEC-002 | P1 | UNVERIFIED (exploit) | `next@16.2.7`, `next-auth@4.24.14` | advisories; no audit gate | F | upgrade `next` ≥16.3.8, `next-auth` fixed 4.24.x, transitive highs; `npm audit --omit=dev --audit-level=high` in CI; Dependabot | ci green after bump; audit step in contract | — | OPEN | | | G2 |
| TEST-005 | P1 | — | `ci.yml` | no dependency gate | F | audit step + Dependabot config | `ci-local.test.ts` contract | SEC-002 | OPEN | | | G2 |
| SEC-008 | P1 (config) | CONFIRMED | `lib/platform-settings.ts` registration default | ship default `open`; CAPTCHA no-op without keys | A | code default → `invite_only`; alert/health note when the setting row is absent; runbook line | register without invite ⇒ 403 under default | — | OPEN | | Turnstile keys = OWNER | G0 |
| ARCH-003 / CQ-004 | P1 | CONFIRMED | `lib/rate-limit.ts`, `lib/api.ts`, `lib/auth.ts` | three IP extractors, two header orders | A | one `getClientIp` (platform header first), used by limiter, audit, auth | spoofed XFF + cf header test | — | OPEN | | prod edge topology OWNER | G11 |
| SEC-018 | P1 (decision) | — | repository visibility | public repo with ops docs | OWNER | decision recorded in `11` | — | — | OWNER | | | G2/G3 |
| TEST-001 | P1 | — | GitHub rulesets | none | F (docs) + OWNER | ruleset JSON + branch strategy doc; owner applies | — | — | OWNER (docs by F) | | | G2 |
| OBS-001 | P1 | CONFIRMED | `overview-core.ts` posture | no age check | E | age-gate the chip; `/api/health` exposes `lastEvaluatedAt` | posture unit test | — | OPEN | | external monitor = OWNER | G3 |
| OBS-002 | P1 | CONFIRMED | `lib/alerts/evaluate.ts` | `dead` filtered out | E | include `dead` (critical) | unit test dead ⇒ critical | — | OPEN | | | G3 |
| OBS-003 | P1 | CONFIRMED | `lib/alerts/run.ts`, `lib/email/send.ts` | `captured` = delivered | E | `captured` ⇒ not delivered outside development; surface `deliveryStatus` | unit test | — | OPEN | | Preview RESEND key = OWNER | G3 |
| OPS-002 / OBS-001 | P1 | CONFIRMED | health + alerting | alerting inside the cron it watches | E + OWNER | `lastEvaluatedAt`/overdue in `/api/health` (authenticated detail or non-sensitive); monitor config doc | route test | OBS-002/003 | OPEN | | monitor registration = OWNER | G3 |
| SEC-AI-003 | P1 | CONFIRMED | `lib/ai/provider.ts` | SDK defaults 10 min / 2 retries; app retry ×6 | D | `timeout` + `maxRetries: 0`; per-hop `AbortSignal` from a turn budget | client options pinned; 429 turn ⇒ bounded calls; timeout/cancel tests | — | OPEN | | | G5 |
| IDEMP-009 / OBS-005 | P1 (plan) | CONFIRMED (swallow) | `lib/ai/invocation.ts`, `provider.ts` | fire-and-forget ledger | D | await the insert before responding; failures to `captureLedgerWriteFailure`; consecutive-failure counter | failing client ⇒ surfaced; row present before response | — | OPEN | | | G5 |
| SEC-AI-001 (partial) | P1 (owner) | — | OpenAI project limit | not in repo | OWNER | record per-env project spend limit | — | — | OWNER | | | G5 |
| SEC-AI-005 | P1 | — | `tools.ts:829-831` | raw descriptors to OpenAI | D | shared scrub helper (from Brief) applied to every tool row | descriptor with 16-digit run scrubbed | — | OPEN | | | G6 |
| PRIV-010 | P1 | — | `content/marketing/legal-ai.md` | understates payload | A (copy) + COUNSEL | enumerate what is sent after SEC-AI-005 | copy pinned | SEC-AI-005 | OPEN | | counsel = OWNER | G6 |
| PRIV-011 | P1 | — | `components/ai/AiDisclosure.tsx` | no third-party sentence | A | point-of-use sentence | render test | — | OPEN | | | G6 |
| PRIV-012 | P1 | — | `RequestAccessForm.tsx`, access-request route | no notice/consent/retention | A (notice+consent) + C (retention job) | privacy notice + consent checkbox; retention job for denied/stale requests; purge on account deletion | form render; job test | — | OPEN | | | G6 |
| PRIV-001 | P1 | — | `purge.ts` | SHARED sole-member Spaces survive | C | delete sole-member SHARED Spaces on purge | table-census deletion test | IDEMP-002 | OPEN | | | G7 |
| PRIV-002 | P1 | — | forgot/reset routes, growth requests routes | raw e-mail in audit metadata | A | `auditEmailHash` on all five paths; purge scrubs residual | tests per path | — | OPEN | | | G7 |
| IDEMP-002 | P1 | CONFIRMED | `purge.ts`, `process-deletions` | non-transactional, single due check, double-runnable | C | claim-first `updateMany` on a new `purgeStartedAt`; re-check before destructive tail; tail in one transaction; idempotent side effects | concurrent two-worker test; cancel race; retry | — | OPEN | | | G7 |
| FIN-001 | P1 | CONFIRMED | `stream-activity.ts`, `streams.ts`, `income-completeness.ts` | silent stream non-blocking LAPSED; observedThrough from income rows | B | RECENTLY_SILENT blocking ⇒ INCOMPLETE_ESTIMATE with bound; LAPSED vs UNKNOWN split; observedThrough from sync clock | 11 paychecks + 5-day overdue ⇒ INCOMPLETE; late/skipped/changed/resumed | — | OPEN | | | G8 |
| FIN-002 | P1 | CONFIRMED | `merchant-corrections.ts`, `flow-classifier.ts`, `flow-authority.ts` | PFC outranks user correction; no USER authority | B | suppress PFC for USER_* category sources (or USER flow authority) | PFC-bearing fixture ⇒ flowType follows correction; totals move | — | OPEN | | | G8 |
| IDEMP-001 | P1 | CONFIRMED | import route, `ImportBatch` | no idempotency key; no maxDuration; PROCESSING un-rollbackable | C | `ImportBatch.fileSha256` + partial unique per account claimed before parsing; `maxDuration`; stale PROCESSING rollback; row/byte caps (SEC-007) | concurrent double submit ⇒ one batch; retry; partial failure | schema | OPEN | | | G9 |
| UI-003 | P1 | — | member/role/archive/revoke widgets | no confirmation | I (wave 2) | `ConfirmDialog` on the four actions | render tests | — | OPEN | | | G10 |
| UI-006 | P1 | — | `use-space-data.ts`, workspaces | failed reads ⇒ empty states | I (wave 2) | surface failure + retry; no `[]` coercion | unit tests | — | OPEN | | | G10 |
| UI-002 | P1 (during beta) | — | CS/Growth widgets | fabricated audit reason | I (wave 2) | reason required | render test | — | OPEN | | | — |
| TEST-004 | P1 | CONFIRMED | auth routes | no handler tests | J (wave 2) | handler-seam tests for register/verify/login/reset/TOTP/sessions | the tests | A | OPEN | | | G12 |
| TEST-003 | P1→P2 (hole REFUTED) | REFUTED (exposure) | `rls-acceptance.ts` | no grant⊆policy census | F | census case in `rls-acceptance.ts` | suite case | — | OPEN | | | G12 |
| TEST-002 | P1 (minimum) | CONFIRMED | routes | 187 routes / 6 tests | F (census) + J | CI census that every `route.ts` carries a recognised guard; seam tests for Space mutations | census test | — | OPEN | | | G12 |
| TEST-006 | P1 (during beta) | — | deploy | no migrate/drift/smoke | F (docs + workflow stub) | post-deploy smoke workflow (deployment_status) + drift check doc | contract test | — | OPEN | | wiring on Vercel = OWNER | — |
| OBS-004 | P1 (during beta) | — | `lib/alerts/rules.ts` | no sync-incident rule | E | `sync-incident-critical` rule; per-Item dedupe | rule test | — | OPEN | | | — |
| OPS-001 | P1 before ~50 Items | — | `jobs/sync-banks.ts` | no budget/continuation | C | time budget + deferral + order by `lastSuccessfulSyncAt`; stale-run finaliser (OPS-006) | unit test with fake clock | — | OPEN | | | — |
| OPS-013 / OPS-015 / DB-007 | P1 | UNVERIFIED | Production | cutover not executed | OWNER | runbook/checklist in `11` | — | — | OWNER | | | G0 |
| SEC-AI-011 | P1 (process) | — | STATUS.md | behind HEAD | Orchestrator | re-baseline at the end | — | all | OPEN | | | G13 |

## P2 (77)

| ID | Sev | Runtime | Component | Agent | Planned remediation | Status | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|
| SEC-003 / DB-003 / ARCH-002 | P2 | — | migration-principal `db` residue | G (assessment) | document; no mass conversion this program (risk) | DEFERRED | | ratchet remains |
| SEC-004 | P2 | CONFIRMED | `lib/export/csv.ts` | A | `escapeFormulae: true` | OPEN | | |
| SEC-005 | P2 | CONFIRMED | `users/search` | A | ≥3 chars or exact `@username`; per-user limit | OPEN | | |
| SEC-007 / OPS-007 | P2 | — | import route, `lib/imports/excel.ts` | C | byte cap, row cap, decompressed-size cap | OPEN | | with IDEMP-001 |
| SEC-010 | P2 | SUPPORTED | `session-proof.ts` | A | idle (30 d since lastActiveAt→ configurable) + absolute (90 d) cut-offs in `factsFromRow` | OPEN | | no schema change (createdAt/lastActiveAt exist) |
| SEC-AI-002 / SEC-AI-008 | P2 | — | reservation sizing; guidance call | D | reserve the guidance call; size reserve by transcript bytes × hops (if simple) | OPEN | | |
| SEC-AI-001 | P2 | — | fleet gate | D | fleet daily ceiling judged in the reservation transaction (if feasible without new table) | DEFERRED unless cheap | | |
| SEC-AI-006 | P2 | — | memory tools | D | user-turn evidence for `statedAs`/subject | DEFERRED | | post-beta |
| PRIV-003 / DB-001 / OBS-007 | P2 | — | retention | C | retention job(s) for the nine ledgers + `purge-trash` implemented or deleted + schedule doc | OPEN | | |
| PRIV-004 | P2 | — | Plaid token retention | C | null token after confirmed `itemRemove` | OPEN | | rotation script DEFERRED |
| PRIV-005 / DB-010 | P2 | — | audit append-only | — | document | DEFERRED | | needs migration + design |
| PRIV-013 / PRIV-015 | P2 | — | sub-processors; Sentry breadcrumbs | A | `beforeBreadcrumb` scrub; sub-processor list copy | OPEN | | counsel for copy |
| FIN-003 | P2 | CONFIRMED | `cash-flow.ts` | B | sign-aware income | OPEN | | |
| FIN-004 | P2 | SUPPORTED | Cash Flow page vs AI | B | document split; UTC boundaries if cheap | PARTIAL target | | |
| FIN-005 | P2 | CONFIRMED | `backfill-core.ts`, `cash-history.ts` | B | history basis from `totalLiquid` | OPEN | | |
| FIN-006 | P2 | — | holdings refresh | — | DEFERRED (consent-gated pipeline stage; design) | DEFERRED | | |
| FIN-007 | P2 | — | webhook health codes | C | map `ITEM/ERROR`, `PENDING_EXPIRATION`, `USER_PERMISSION_REVOKED` to health transitions | OPEN | | |
| FIN-008 | P2 | — | Brief unconverted | — | DEFERRED (non-USD only) | DEFERRED | | |
| FIN-009 | P2 | — | fingerprint ambiguity | B | refuse adoption on >1 match; record issue | OPEN | | |
| FIN-010 | P2 | — | dropped reparent payloads | — | DEFERRED | DEFERRED | | |
| FIN-011 | P2 | UNVERIFIED | null balance stamping | B | keep freshness stamp only when `current` present | OPEN | | |
| IDEMP-003 / OPS-005 / OPS-006 | P2 | CONFIRMED | `lib/jobs/run.ts`, dispatch | C | advisory xact lock per job name in `runJob`; abort on start-write failure; stale-run finaliser | OPEN | | |
| IDEMP-004 | P2 | — | crypto sweep | C | wallet lock in sweep; manual route lock in try/finally | OPEN | | |
| IDEMP-005 | P2 | — | Plaid lock fencing | C | fence release on `syncLockedAt = claimedAt` | OPEN | | CAS cursor DEFERRED |
| IDEMP-006 / OBS-014 | P2 | PARTIAL | webhook dedupe | C | body-hash short-TTL dedupe (schema column) | OPEN | | |
| IDEMP-007 | P2 | — | resume-stale-imports | C | backoff by age | OPEN | | |
| IDEMP-008 | P2 | — | duplicate-institution TOCTOU | C | per-account catch; partial unique DEFERRED | PARTIAL target | | |
| IDEMP-010 | P2 | — | OWNER self-leave | C | last-owner + PERSONAL guards | OPEN | | |
| IDEMP-012 | P2 | — | snapshot regen | — | DEFERRED | DEFERRED | | |
| DB-002 / DB-011 | P2 | — | purge soft refs; shared-Space orphans | C | soft-ref scrub step; orphan handling | OPEN | | with PRIV-001 |
| DB-005 / DB-006 | P2 | — | pool; statement timeout | C | `statement_timeout` per role migration | OPEN | | pool sizing = OWNER |
| DB-008 | P2 | — | migration discipline | F | timestamp-name check in CI | OPEN | | |
| OPS-004 | P2 | — | Plaid/CoinGecko/Tiingo timeouts | E | client timeouts | OPEN | | |
| OPS-010 / OPS-011 | P2 | — | bank sweep time isolation; queue | C (per-Item deadline) | with OPS-001 | PARTIAL target | | queue DEFERRED |
| ARCH-001 / CQ-007 | P2 | — | membership authorities | G | assess; consolidate inline checks where safe | PARTIAL target | | |
| ARCH-004 / OPS-003 | P2 | — | `withApiHandler` Sentry | A | `captureException` in catch | OPEN | | |
| ARCH-005 | P2 | — | 50-file cycle | — | DEFERRED | DEFERRED | | |
| ARCH-006 / CQ-005 | P2 | — | two consoles | — | DEFERRED (owner product decision) | DEFERRED | | |
| ARCH-007 / CQ-009 | P2 | — | refresh doors; unconsumed routes | G | delete `/api/plaid/sync` and unconsumed GETs after consumer verification | OPEN | | |
| CQ-001 | P2 | — | unused deps | F (after G verifies) | uninstall | OPEN | | |
| CQ-006 | P2 | — | audit idioms | G | lint rule + migrate obvious callers | PARTIAL target | | |
| CQ-011 | P2 | — | `tools.ts` 4,768 lines | H (wave 2) | modularise | OPEN | | |
| CQ-017 | P2 | — | engine parity | — | DEFERRED | DEFERRED | | |
| TEST-007 | P2 | — | runner timeouts | F | `timeout-minutes` + per-file timeout | OPEN | | |
| TEST-008 | P2 | — | rollback path | F (docs) | expand/contract rule doc | OPEN | | |
| TEST-009 | P2 | — | behavioural tests | C | deletion census, overlap, replay tests | OPEN | | |
| TEST-010 | P2 | — | UI/e2e | — | DEFERRED | DEFERRED | | |
| UI-001 | P3 (reclassified) | REFUTED (security) | widgets | I | hide/disable for READ | OPEN | | |
| UI-004 | P2 | — | permanent Space delete | A | `requireFreshUser` | OPEN | | |
| UI-005 | P2 | — | Space mutation limits | A | `limitByUser` on invite/correct | OPEN | | |
| UI-007 | P2 | — | error/loading boundaries | I | segment `error.tsx`/`loading.tsx` | OPEN | | |
| UI-008 | P2 | — | unaudited mutations | — | DEFERRED (scope) | DEFERRED | | |
| UI-009 | P2 | — | frozen ages | I | absolute `checkedAt` | OPEN | | |
| UI-010 | P2 | — | cost-controls panel hidden on policies failure | E or I | own fetch state | OPEN | | |
| UI-012 | P2 | — | a11y | I | partial | PARTIAL target | | |
| UI-013 | P2 | — | growth audit email | A | with PRIV-002 | OPEN | | |
| UI-020 | P2 | — | Security Ops no action | OWNER | decision | OWNER | | |
| OBS-006 | P2 | — | provider alert pollution | E | exclude `AI_PAUSED`/non-prod | OPEN | | |
| OBS-008 | P2 | — | delivery failure | E | Sentry on `error` | OPEN | | |
| OBS-009 | P2 | — | authz failures | E | rate-limited audit row | OPEN | | |
| OBS-012 | P2 | — | scheduler tick | E | `dispatcher-wake` heartbeat row | OPEN | | |
| OBS-015 | P2 | — | alert storm on dead ledger | E | circuit-break when start row failed | OPEN | | |

## P3 (73)

Grouped; each gets a disposition in `05-CODE-CLEANUP.md` or the subject report. Candidates taken this program: SEC-009 (timingSafeEqual, A) · SEC-013 (A) · SEC-014 (C, migration) · SEC-016 (F, untrack) · SEC-AI-004 (D) · FIN-013 partial (B: one `round2`/epsilon module if cheap) · FIN-015 (B comment) · IDEMP-011/013 (C) · DB-004 RateLimit policy (C) · DB-009 indexes (C) · OPS-012 (E doc) · OPS-014 (E) · TEST-012/013 (F) · TEST-014 (F doc) · UI-011 copy (E) · UI-014 Markets coming-soon (G) · UI-015 Credit retire (G) · UI-018 guard (I) · UI-021 (E) · UI-022 take (A) · OBS-010/011 (E) · ARCH-012 stale prose (G) · CQ-002 orphans (G) · CQ-008 (G) · CQ-010 renames DEFERRED · CQ-003 DEFERRED · PRIV-006/007/008/009/014/016 DEFERRED except PRIV-014 comments (G).

## New findings discovered during remediation

| ID | Sev | Component | Description | Agent | Status |
|---|---|---|---|---|---|
| (none yet) | | | | | |
