# 12 — Beta Release Plan

Fourth Meridian pre-beta audit · HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` · 2026-10-21. This is the remediation backlog derived from reports `02`-`11`, with release gates. Severities are the coordinator's final ones (they supersede workstream drafts where they differ). Effort: S ≤ 1 day · M 1-3 days · L > 3 days. Owners: ENG (engineering), OWNER (configuration, decisions, operations), COUNSEL (external legal review).

## 1. Release gates

| Gate | Definition | Verification criterion |
|---|---|---|
| **G0 Production cutover** | The v2.6 candidate is serving Production under the cutover plan's §6 gates 1-11 and §8 issues 1-6 | `GET /api/health` on the apex reports the candidate SHA; `db-authority` reports strict mode, 3 roles bound, RLS 56/56; a `JobRun` row exists for every registered job on Preview before promotion; restore rehearsal record with RPO/RTO in `docs/operations/`; `registration_mode` row = `invite_only`; Turnstile keys and `PLATFORM_ALERTS_EMAIL` present |
| **G1 P1 code fixes** | Every P1 marked "GO condition" below is merged on `v2.6` with its named test | exact-SHA GitHub CI green on all three jobs (read the run) |
| **G2 Governance** | Rulesets on `main`/`v2.6`; dependency audit in CI; repository visibility decided | `gh api …/rulesets` non-empty with the three required checks; `ci.yml` contains the audit step; owner's written decision on SEC-018 |
| **G3 Watchdog** | External monitor polling `/api/health` with `lastEvaluatedAt`; `dead` alerted; `captured` ≠ delivered | monitor dashboard screenshot or record; a forced `evaluate-alerts` Run Now on Production delivering `sent` to the monitored mailbox |
| **G4 Disclosure** | AI legal page matches the payload; point-of-use OpenAI sentence; waitlist privacy notice | counsel sign-off on the three texts; copy present in `AiDisclosure.tsx` and `RequestAccessForm.tsx` |
| **G5 Status authority** | STATUS.md records HEAD, the gates above, and this audit | STATUS §3 row for the beta SHA with CI run id |

GO = all five gates green. Expansion beyond five users = §3 "Before expanding" items closed.

## 2. P0 — critical / must fix before beta

None confirmed.

## 3. P1 — high

### 3.1 GO conditions (must close before inviting users)

| ID | Finding | Owner | Effort | Depends on | Verification |
|---|---|---|---|---|---|
| OPS-015 | Production runs v2.5 (`87e4df7`), no RLS roles, shared session secret; cutover NO-GO | OWNER | L (3-5 d ops) | DB-007, OPS-013, SEC-008 | G0 criteria |
| OPS-013 | No scheduled job has ever run in a deployed v2.6 environment | OWNER | S | — | one `JobRun` per registered job on Preview via the fallback routes with `CRON_SECRET` |
| DB-007 | Backups plaintext local; PITR unverified; `fm_backup` passwordless; no restore ever rehearsed | OWNER | M | — | PITR confirmed and recorded; restore into a scratch DB timed; `fm_backup` password set and used; local dumps encrypted or deleted |
| SEC-008 | `registration_mode` defaults to `open`; CAPTCHA no-op on Production | OWNER | S | — | setting row seeded `invite_only` in the cutover runbook; Turnstile keys present |
| SEC-001 | Forced-TOTP gate bypass on server-rendered pages incl. `/admin` | ENG | S | — | test: a pending session cannot render `app/admin/page.tsx`; `jwt()` ignores client-supplied `requireTotpSetup` |
| SEC-006 | Admin 2FA reset of another SYSTEM_ADMIN without step-up (compounds SEC-001) | ENG | S | SEC-001 | route verifies the actor's TOTP; SYSTEM_ADMIN targets refused |
| SEC-002 / TEST-005 | `next@16.2.7`, `next-auth@4.24.14` advisories; no `npm audit` in CI | ENG | S-M | — | `npm audit --omit=dev --audit-level=high` clean in CI; Dependabot config present; `npm run ci` green after the bump |
| TEST-001 | No branch protection or rulesets on `main`/`v2.6` | OWNER | S | — | `gh api …/rulesets` shows required checks, no force-push, no deletion |
| SEC-018 | Repository public incl. Production project ref, deployment ids and runbooks | OWNER | S (decision) | — | written decision; either private or operational docs removed from the public tree |
| OBS-002 | `dead` job state never alerted | ENG | S | — | unit test on `evaluateSchedulerSilent` with a `dead` row ⇒ critical |
| OBS-003 | `captured` e-mail counts as delivered | ENG | S | — | `captured` ⇒ `skipped` outside development; Alerts widget shows `deliveryStatus` |
| OPS-002 / OBS-001 | Alerting cannot detect its own death; no external heartbeat | ENG + OWNER | S | OBS-002/003 | `/api/health` exposes `lastEvaluatedAt`; external monitor alerts on silence > cadence + grace; posture chip age-gated |
| SEC-AI-003 | OpenAI client on SDK defaults (10-min timeout, 2 hidden retries) | ENG | S | — | `new OpenAI({timeout, maxRetries: 0})` pinned by a test; per-hop `AbortSignal` from the route budget |
| IDEMP-009 / OBS-005 | `AiInvocation` ledger write fire-and-forget | ENG | S | — | the insert is awaited before the response; write failures reach `captureLedgerWriteFailure` |
| SEC-AI-001 (partial) | No fleet-wide spend gate; OpenAI project limit owner-stated only | OWNER | S | — | project spend limit per environment recorded in `openai-environment-separation.md` |
| SEC-AI-005 | Raw descriptors/merchants to OpenAI unscrubbed on the conversation path | ENG | S | — | `safeMerchant`-class scrub applied to every tool row; test with a descriptor carrying a 16-digit run |
| PRIV-010 | AI legal page understates the payload | COUNSEL + ENG | S | SEC-AI-005 | text enumerates what is sent |
| PRIV-011 | No point-of-use OpenAI disclosure | ENG | S | — | sentence in `AiDisclosure.tsx` |
| PRIV-012 | Waitlist has no privacy notice/consent, no retention, no purge | ENG | S (notice) / M (retention) | — | notice and consent on the form; retention job; purge on deletion |
| PRIV-001 | Sole-member shared Spaces survive permanent deletion | ENG | S | — | table-census deletion test (TEST-009) |
| PRIV-002 | Raw e-mails persist in `AuditLog.metadata` after purge | ENG | S | — | `auditEmailHash` on the five paths; purge scrubs residual metadata |
| IDEMP-002 | Purge non-transactional, single due-check, double-runnable | ENG | M | — | claim-first `updateMany` asserting count 1; re-check before the destructive tail; DB tail in one transaction |
| FIN-001 | One late paycheck drops all projected payroll under a complete label | ENG | M | — | regression: 11 flat paychecks, newest slot 5 days overdue ⇒ `INCOMPLETE_ESTIMATE` with bound; LAPSED/UNKNOWN split |
| FIN-002 | User correction cannot change `flowType` on PFC-bearing rows | ENG | M | — | PFC-bearing fixture test: correction to Transfer changes income/spending totals |
| IDEMP-001 | CSV import duplicates on double submit; stuck `PROCESSING` batches | ENG or OWNER | M / decision | — | `ImportBatch` idempotency key; `maxDuration`; stale-batch rollback; or import disabled for the cohort |
| UI-003 | Unconfirmed member removal / role change / archive / account revoke | ENG | S | — | `ConfirmDialog` on the four actions |
| UI-006 | Customer Space renders outages as empty states | ENG | S-M | — | failed reads surface a message with retry; no `[]` coercion |
| ARCH-003 / CQ-004 | Rate limiting keys on a different client IP than audit/auth | ENG | S | — | one `getClientIp`; `limitByIp` uses it; test |
| TEST-004 | Authentication flows have no handler-level tests | ENG | M | — | handler-seam tests or a scripted Preview smoke of register → verify → login (+TOTP) → logout → reset |
| TEST-003 | No gate that every fm_app-granted table has an RLS policy; per-file ratchet | ENG | S | — | `rls-acceptance.ts` case: grants ⊆ tables with rowsecurity and ≥ 1 policy; call-site counts in the ratchet |
| TEST-002 (minimum) | Route handlers untested | ENG | M | — | CI census that every `route.ts` contains a recognised guard; seam tests for Space-mutation routes |
| SEC-AI-011 | STATUS.md behind HEAD; records a "Preview-verified" allowance that exercised the fallback | OWNER | S | — | STATUS re-baselined to `cde8fa0` with the CI run id |

### 3.2 P1 to close during the five-user beta, before expanding

| ID | Finding | Owner | Effort | Verification |
|---|---|---|---|---|
| OBS-004 | No rule reads sync incidents / refresh executions; `provider-unhealthy` dedupes on the rule id | ENG | S | `sync-incident-critical` rule; per-Item dedupe; test |
| TEST-006 | Deploy does not migrate; no drift check at deploy; no post-deploy smoke | ENG | M | `deployment_status` workflow curling `/api/health` and comparing `commit`; read-only drift check |
| UI-002 | Customer Success fabricates an audit reason | ENG | S | reason required; click refused without one |
| OPS-001 | `sync-banks` unbounded; killed slot not retried for 24 h (P1 before ~50 Items) | ENG | M | budget + `deferred` + continuation; stale-run finaliser; order by `lastSuccessfulSyncAt` |

## 4. P2 — medium (schedule during or shortly after beta)

| ID | Finding | Owner | Effort | Notes |
|---|---|---|---|---|
| SEC-003 / DB-003 / ARCH-002 | Migration-principal `db` on ~149 files / 60 routes; make `db` throw in strict mode outside an allowlist | ENG | L | continue the ratchet; prioritise the 18 customer routes |
| SEC-004 | CSV formula injection in export | ENG | S | `escapeFormulae: true` + test |
| SEC-005 | User directory enumeration via `/api/users/search` | ENG | S | exact `@username`, per-user limit |
| SEC-007 / OPS-007 | No byte/row ceiling on import; zip-bomb exposure | ENG | S | size + row caps |
| SEC-010 | No idle/absolute session lifetime | ENG | S | cut-offs in `factsFromRow` |
| SEC-AI-002 / SEC-AI-008 | Reservation overshoot; guidance call unreserved | ENG | M | reserve from transcript bytes × hops; reserve the guidance call |
| SEC-AI-001 | No fleet-wide spend gate | ENG | M | fleet reservation counter + daily ceiling |
| SEC-AI-006 | Text-only memory fields injectable | ENG | M | user-turn evidence for `statedAs`/subject; typed data leaves |
| PRIV-003 / DB-001 / OBS-007 | No retention for nine operational ledgers; `purge-trash` stub; `UserSession` never deleted | ENG | M | one retention job per ledger with a documented schedule |
| PRIV-004 | Revoked Plaid tokens retained; no key rotation | ENG | M | null token after `itemRemove`; dual-key re-encrypt script |
| PRIV-005 / DB-010 | Operator identity reads unaudited; audit log not append-only | ENG | M | audit READ of customer detail; separate product events; forbid UPDATE/DELETE on security actions |
| PRIV-013 / PRIV-015 | Sub-processors and cookies undisclosed; API keys in URLs; Sentry breadcrumbs unscrubbed | ENG + COUNSEL | S-M | — |
| FIN-003 | Negative INCOME rows add to income | ENG | S | sign-aware fold |
| FIN-004 | Cash Flow page pending/local-clock vs AI settled/UTC | ENG | M | one rule or explicit split |
| FIN-005 | Liquid now vs liquid history (restricted cash) | ENG | S | align history with `totalLiquid` |
| FIN-006 | Holdings never refreshed by webhook/cron | ENG | M | consent-gated holdings stage |
| FIN-007 | Health webhooks inert | ENG | S | map codes to transitions |
| FIN-008 / FIN-009 / FIN-010 / FIN-011 | Brief silent on unconverted; ambiguous fingerprint adoption; dropped reparent payloads; null-balance stamping | ENG | S each | — |
| IDEMP-003 / OPS-005 / OPS-006 | Dispatch check-then-insert; no job lock; stale runs never finalised | ENG | M | advisory lock or partial unique running row; reaper |
| IDEMP-004 | Scheduled crypto sweep takes no wallet lock | ENG | S | claim in the sweep |
| IDEMP-005 | Unfenced Plaid lock release; non-CAS cursor; two lock-free callers | ENG | M | fencing token; CAS cursor |
| IDEMP-006 / OBS-014 | Webhook replay not deduplicated; no fleet webhook reader | ENG | S-M | body-hash unique; "last webhook received" row + rule |
| IDEMP-007 | `resume-stale-imports` retries forever | ENG | S | backoff |
| IDEMP-008 | Duplicate-institution TOCTOU; half-imported Item on P2002 | ENG | M | partial unique; per-account catch |
| IDEMP-010 | OWNER self-leave incl. Personal Space | ENG | S | last-owner and PERSONAL guards |
| IDEMP-012 | Snapshot regen read-then-upsert; failures swallowed | ENG | M | version stamp; surface failures |
| DB-002 / DB-011 | Purge retains soft references; shared-Space permanent delete orphans accounts | ENG | M | soft-ref scrub step; orphan handling in the route |
| DB-005 / DB-006 | Fleet-wide tenant concurrency ~12; no statement timeout | ENG + OWNER | M | measure on a clone; `statement_timeout` per role as a migration; pool sizing |
| DB-008 | Migration discipline (names, raw-SQL drift, name-only drift check) | ENG | M | timestamp names; CI `migrate diff` with allowlist |
| OPS-004 | Plaid/CoinGecko/Tiingo transports without timeout; no circuit breaker | ENG | S | client timeouts; trip flag |
| OPS-010 / OPS-011 | Time isolation in the bank sweep; no queue | ENG | M-L | per-Item deadline; fan-out beyond ~100 Items |
| ARCH-001 / CQ-007 | Four membership authorities, one off-RLS | ENG | M | `resolveSpaceContext` over `requireSpaceAction` |
| ARCH-004 / OPS-003 | `withApiHandler` hides 500s from Sentry | ENG | S | `captureException` in the catch |
| ARCH-005 | 50-file import cycle | ENG | M | registry facts split; type-only template import |
| ARCH-006 / CQ-005 | Two operator consoles; duplicate reads | ENG | M | freeze `/admin` to break-glass |
| ARCH-007 / CQ-009 | Four refresh doors; unconsumed routes | ENG | S | delete `/api/plaid/sync` and the three unconsumed GETs |
| CQ-001 / CQ-006 / CQ-011 / CQ-017 | Unused deps; four audit idioms; 4,768-line tools file; unverified engine parity | ENG | S / M / M / L | uninstall; lint ban; split by section; numeric parity test |
| TEST-007 / TEST-008 / TEST-009 / TEST-010 | Runner/job timeouts; no rollback path; missing behavioural tests; no UI/e2e tests | ENG | S / M / M / M | `timeout-minutes`; expand/contract discipline; replay + overlap tests; Playwright smoke |
| UI-001 / UI-004 / UI-005 / UI-007 / UI-008 / UI-009 / UI-010 / UI-012 / UI-013 / UI-020 | Operator access gating in widgets; permanent Space delete not fresh-gated; no rate limits on Space mutations; no error/loading boundaries; unaudited customer mutations; frozen widget ages; cost-controls panel hidden on policies failure; a11y gaps; beta audit rows with email; Security Ops has no action | ENG (UI-020 OWNER decision) | S-M each | — |
| OBS-006 / OBS-008 / OBS-009 / OBS-012 / OBS-015 | Pause/harness pollute provider alert; delivery failure self-referential; authz failures not collected; scheduler tick unobservable; alert storm on a write-dead ledger | ENG | S-M each | — |

## 5. P3 — low (cleanup)

ARCH-008/009/010/011/012 · CQ-002/003/008/009/010/012/014/015/016/018 · SEC-009/011/012/013/014/015/016/017 · SEC-AI-004/007/009/011 · PRIV-006/007/008/009/014/016 · FIN-012/013/014/015/016/017 · IDEMP-011/013/014/015/016/017/018 · DB-004/009/012/013/014 · OPS-008/009/012/014 · TEST-011/012/013/014 · UI-011/014/015/016/017/018/019/021/022 · OBS-010/011/013. Details and remediations are in the subject reports. Suggested first sweep (one week): tsconfig/ESLint excludes for `tmp/`; delete orphans and unused packages; `timingSafeEqual` for `CRON_SECRET`; indexes DB-009; hide Markets and Credit; copy fixes UI-011; `.env.example` completeness.

## 6. Dependencies (critical path)

```
DB-007 (restore drill) ─┐
OPS-013 (jobs on Preview) ├─► G0 cutover ─► beta
SEC-008 (reg mode seed)  ─┘        ▲
SEC-001 ─► SEC-006                 │
SEC-002 ─► TEST-005 (CI gate) ─────┤
TEST-001 + SEC-018 (governance) ───┤
OBS-002 + OBS-003 ─► OPS-002/OBS-001 (monitor) ─┤
SEC-AI-003 + IDEMP-009 ────────────┤
SEC-AI-005 ─► PRIV-010 (counsel) ──┤
PRIV-001 + PRIV-002 + IDEMP-002 ───┤
FIN-001 + FIN-002 ─────────────────┤
IDEMP-001 (or disable import) ─────┤
UI-003 + UI-006 + ARCH-003 ────────┤
TEST-003/004/002 (gates) ──────────┘
```

## 7. Effort summary

| Bucket | Items | Engineering days | Owner/ops days |
|---|---|---|---|
| GO conditions (§3.1) | 32 | ~15-20 | ~3-5 (+ counsel) |
| During-beta P1 (§3.2) | 4 | ~4 | — |
| P2 | ~77 | ~40-60 | ~2 |
| P3 | ~73 | ~15 | — |

## 8. Suggested owners by area
Security and governance (SEC, TEST-001/005, SEC-018): owner + engineering. Financial engine (FIN, IDEMP-001): engineering with the forecast domain knowledge. Data lifecycle and privacy (PRIV, DB-002, IDEMP-002): engineering + counsel for wording. Operations (OPS, DB-007, OBS): owner for configuration and monitors, engineering for the one-line rule fixes. Product surfaces (UI): engineering, with the owner deciding UI-020 and the Markets/Credit visibility.
