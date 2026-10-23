# 26 — Production cutover execution (Release 1) and domain-split status (Release 2)

**Date:** 2026-10-23, 03:37 → 15:10 UTC.

> **RELEASE 1: PASS (15:10 UTC).**
> - The platform seed was applied and verified (§9).
> - The AI spending controls are verified on Production (§4 / §11).
>
> Release 2 may resume once its §10 prerequisites are met.

> **Update 14:55 UTC — supersedes the status lines below and §1.**
>
> **Production is OPEN on v2.6** (`87e5ac8`, `dpl_6NL1QND6…`):
> - the firewall has no custom rules;
> - crons are on (14:14:41);
> - `maintenance_mode` is unset.
>
> C7 owner smoke test: PASS, verified server-side (§8). C8 monitoring and integrity: PASS (§8).
>
> **Release 1:** the cutover gates pass. **Not closed** until two items are done:
> - the platform seed is applied (§9);
> - the AI spending controls are verified on Production (§4).
>
> **Release 2:** PAUSED by the owner pending §9. Its prerequisites are in §10.

**Release 1 status (as of 07:52, historical):** BLOCKED at the owner login/TOTP gate. Every automated gate (C0–C6 and automated C7) passed. At that point Production was live on v2.6 behind a deny-all firewall, so no user could reach it.

**Release 2 status (as of 07:52, historical):** BLOCKED. It depended on Release 1 passing, and on an owner-only NameBright DNS record for `app.fourthmeridian.com`. That record now exists (§10).

Durable step log (private, 600): `~/fm-rehearsal-private/prod-cutover/release.log`.

## 1. Current Production state (recoverable maintenance)

| Item | State |
|---|---|
| Deployment | `dpl_6NL1QND6ccmcNvDvtM7x5Mue2Kso`, `main` = `87e5ac8` (merge of PR #10; tree = `v2.6` `9064328`), READY, aliased to `fourthmeridian.com` |
| Edge | Vercel Firewall rule `rule_fm_cutover_maintenance_eB8A4z`: deny `/`, **no exceptions**. Probe bypass removed; its token destroyed |
| Crons | Project crons **disabled** (`disabledAt=1792726733119`, carried onto the new deployment) |
| `maintenance_mode` | `true` (PlatformSetting row inserted at C0; it was unset before). It blocks refresh, new connections and paid AI. **It does not block login** |
| Database | 135 migrations, 0 unfinished. Data converged and certified equal to the rehearsal clone (§3) |
| Roles / env | `fm_app` / `fm_auth` / `fm_system` SCRAM passwords set. 4 Sensitive Production env vars added (30 → 34; none changed) |
| Rollback | `dpl_HRdMnpT3J9fSVXh3vpaP5RDjhRL2` (`9ea5881`) READY. The old app was proven on the migrated schema (doc 24 §6) |

## 2. Gates

| Gate | Result | Evidence |
|---|---|---|
| C0 write isolation | PASS | Domain answers 403 (`x-vercel-mitigated: deny`). Crons disabled. Only `postgres` has DML grants. No pg_cron. Only fintracker1 holds DB credentials. Counters flat 03:39–03:45; no JobRun at the 03:40 tick |
| C1 fresh backup | PASS | `prod-20261023T034601Z.dump`, SHA-256 `7c9a01b3…cb56b7a`, 41 s. Restore = live (56 tables). Full rehearsal on this dump passed |
| C2 preflight | PASS | 88 applied, exactly 47 pending, preflight clean |
| C3 migrate | PASS (with deviation) | `db:migrate:safe`'s redundant plain dump dropped (SSL) after 348 s, before migrating. Ran the guard + `prisma migrate deploy` instead: 135 / 0 unfinished in 183 s. 63 FORCE-RLS tables, 246 policies, 0 invalid indexes |
| C3b data convergence | PASS (with deviation, §3) | 6/6 official dry-runs clean on Production |
| C4 roles | PASS | Each role logs in through the 6543 pooler with `bypassrls=false`, timeouts 15 s / 5 s / 1 min. Wrong password refused ×3. `fm_app` without `app.user_id` sees 0 transactions / accounts / users |
| C5 env | PASS | `DATABASE_URL_APP/AUTH/SYSTEM`, `FM_RLS_STRICT` added (Sensitive, Production). The 30 existing variables are untouched |
| C6 deploy | PASS | PR #10 merged by normal rules (required checks green). The red "Deployment health" is UNVERIFIED by design (Preview 401) |
| C7 automated | PASS | See below |
| C7 owner smoke | **PENDING (owner)** | Login + TOTP cannot be automated without credentials, by rule |

**C7 automated checks**, run through a temporary secret-header firewall bypass that was placed before the deny rule and has since been removed:
- `/api/health`: `status ok`, `db ok`. `validateEnv passed` (strict env). The scheduler is overdue only because crons are off.
- 0 errors in the logs. The only requests reaching the app were the probes.
- Unauthenticated `/api/spaces`, `/api/accounts` and `/api/brief` return 401, as does a garbage Bearer token. A cron call without its secret returns 401. `/dashboard` returns 307 to `/login?callbackUrl=%2Fdashboard`.
- HSTS and `X-Frame-Options: DENY` are present.
- DB counters, compared with the pre-migration quiescence: only the C3/C3b writes, plus JobRun +1 (the stale row → failed, by design), plus one RateLimit row from the probe IP.

## 3. C3b deviation: transplant of rehearsed results

**Why the scripts could not run directly:**
- **Step 1** (`repair-liability-income-credits`) ran directly on Production: 51 rows. That is the 50 rehearsed, plus 1 identical-class $5.04 row created at 01:41 by the old classifier.
- **Step 2** (`backfill-flow-authority`) lost its connection after 1,569 s (P1017) with 3,051/5,137 rows stamped. Its chunks are atomic, so the state was consistent.
- **The cause is the link.** Round trips from the operator Mac to the ap-southeast-1 pooler take ~490 ms, and the pooler drops transactions after ~300 s. Step 4's 200-event batches (~650 statements) cannot fit in its 120 s transaction timeout.

**Mechanism change:**
- The same scripts ran, unchanged, on a local restore of the C1 dump. Production was write-isolated, so the restore held identical data.
- A full column diff showed only `flowAuthority` (2,086), `economicDate` (5,137) and `transactionEventId` (5,112) differ, plus `updatedAt`. Those values, and the event and observation rows, were applied to Production in **one transaction**, with preconditions and post-assertions (16 s).
- The transplant was tested first on a copy in Production's partial state.

**Proof:**
- Production fingerprints equal the clone's:
  - events `3478a889…`;
  - observations `6c53bafa…`;
  - transactions `022adbec…`;
  - FINANCIAL `dcd95f0e52ee0e93` (4,540 live rows);
  - PROJECTION `96f0fbd5170b43ef` (4,636 events).
- Balance snapshots are unchanged: FinancialAccount, SpaceSnapshot, Holding and the transaction core.
- **All six official scripts report nothing to do on Production:**
  - liability-income: nothing;
  - flow-authority: nothing (fingerprint `477de699a796f235`);
  - economic-date: IDEMPOTENT;
  - pin-drift: none;
  - projection-drift: 0;
  - event-identity: fingerprint `884822be8be5b38e`, 4,636 events. Its "35 observations missing" note matches the rehearsed end state after pin-drift repair.

**Incidental:** the first projection-drift dry run exited 1 with no output (a link drop). A solo re-run was clean.

## 4. OpenAI safeguards

**Project limits:**
- `fourth-meridian-prod` has a **$25/month hard limit, enforced**.
- Alerts at $10, $20 and $25.
- Organization auto-reload is capped at $75.
- Keys and project IDs are unchanged.

**Not yet verified:**
- The Production key → prod project alignment. The prod keys still show "Last used: Never", and confirming it needs one AI request in the app, which `maintenance_mode` blocks.
- **Owner action, after C8:** run one AI request and confirm "Last used" changes on a `fourth-meridian-prod` key. If it does not, turn the AI kill switch ON.

**Pending (in-app, needs an owner session after C8):**
- `ai_daily_allowance_usd` = 1;
- `ai_spend_alert_fleet_usd_24h` = 2.

## 5. Owner procedure to finish Release 1

Run everything from the operator Mac. The kit is in `~/fm-rehearsal-private/prod-cutover/`.

1. **Owner smoke (C7):** `./maint.sh owner-on` adds a bypass for this network's current public IPv4 only. Everyone else still gets 403. Then, at `https://fourthmeridian.com`:
   - log in with password + TOTP;
   - confirm the dashboard loads and the busiest Space shows ~4,513 transactions. That is 4,538 minus 25 crypto rows (Σ $0.22) that banking views now exclude by design. Balances should match yesterday;
   - try a wrong TOTP once (must be refused);
   - log out.
2. **Pass → C8:**
   - `./maint.sh owner-off && ./maint.sh fw-off && ./maint.sh cron-on`;
   - set `maintenance_mode` to false: Admin → security settings, or delete the PlatformSetting row (it was unset before);
   - monitor for 30 min: `/api/health` scheduler fresh, a JobRun at the next 15-minute tick, no 5xx;
   - then do §4.
3. **Fail → rollback:**
   - `vercel promote dpl_HRdMnpT3J9fSVXh3vpaP5RDjhRL2` (instant; the old app runs on the migrated schema);
   - keep the firewall ON until the cause is understood;
   - a data restore from the C1 dump is needed only for data damage: RPO = 03:46 UTC, and nothing has been written since except the cutover itself.

## 6. Release 2 (domain split): blocked, read-only findings

**Current mappings:**

| Project | Domains |
|---|---|
| fintracker1 | `fourthmeridian.com`, plus `preview-app.` (v2.6) |
| fourth-meridian-site (`prj_gZPRzUnT…`, root `site`, production branch `main`) | `preview.` (v2.6) and `*.vercel.app` |

**DNS:**
- `fourthmeridian.com` A → `216.150.1.1` (Vercel).
- `www.` and `app.` resolve to NameBright's parking wildcard (`comingsoon.namebright.com`).

**Blocker:**
- The split needs a NameBright CNAME for `app.fourthmeridian.com`, which only the owner can create.
- It also needs Release 1 to have passed and been monitored.
- The two-origin flow was already rehearsed on Preview (`docs/operations/domain-split-preview.md`).
- The Production staging, rollback and owner actions are in `docs/plans/PUBLIC-APP-DOMAIN-SPLIT-ARCHITECTURE.md` §12, §13 and §16.5.
- No domain, DNS or redirect changes were made.

**Restore of the prior mapping:** unchanged. `fourthmeridian.com` → fintracker1.

## 7. Credentials and cleanup

- **No secret was printed to logs, Git or argv:**
  - role passwords travel via child env and stdin only;
  - the SQL carried SCRAM verifiers only.
- **One exception:** the temporary probe header value appeared once in session output. It granted only edge reachability (the app still requires auth), and it was revoked and destroyed at the end of C7.
- **`prod/pgpass` is kept** (600, FileVault) for C8, the `maintenance_mode` reset and any rollback. **Delete it with `rm -P` after C9.**
- The clone container has been removed with its volume (Docker volumes 24 → 23).

## 8. C7 owner smoke test and C8 reopening (verified server-side)

**C7 owner smoke test.**
- **The first report was refused.** It had no Production evidence: no session row and no requests in the logs.
- **The second run, via the IP-scoped exception:**
  - `LOGIN {mfa: totp, SUCCESS}` at 14:05:15, followed by SPACE_VIEWED, TRANSACTIONS_VIEWED and LOGOUT (the session was revoked);
  - all requests 2xx;
  - the refresh-all was refused by maintenance admission (`NOT_ADMITTED` ×8, no JobRun).
- **The wrong-TOTP check was not on the server the first time.** It needed a separate retest: `LOGIN_FAILED totp_invalid` at 14:12:40, `login-callback` 1 → 2, no session created.

**C8 sequence:**

| Step | Action | Verification |
|---|---|---|
| 1 | Removed the owner exception, then the deny rule | `/`, `/login`, `/api/health` → 200 |
| 2 | Deleted the `maintenance_mode` row | This restores the pre-cutover state (unset = off) |
| 3 | Re-enabled crons at 14:14:41 | `enabledAt` set, `disabledAt` cleared |

**Monitoring, 14:14 → 14:50:**
- `/api/health` returned ok / db ok on every sample.
- 18 JobRuns, all `succeeded`, all `deploymentSha 87e5ac8`.
- Overdue jobs 10 → 0, and the alert evaluator recovered.
- 0 5xx responses.
- The 14:30 dispatch ran with nothing due. `lastDispatchAt` is the last *executed* job by design.

**Integrity after reopening (invariants):**
- 5,146 transactions: 0 NULL `flowAuthority`, 0 NULL `economicDate`, 0 income credits on liability accounts.
- All 9 new rows are owned and dated, and the new Plaid rows carry event identity.
- The 28 crypto-ledger rows without event identity are out of scope by design (25 + 3 new).
- The frozen fingerprints changed only through the cron syncs and the owner's account add at 14:33.

**OpenAI key alignment: PASS.** A Brief generated during the smoke test (14:05:28, gpt-5.1) registered on `fm-prod-backend` in project `fourth-meridian-prod`: "Last used" went from Never to Oct 23. `fourth-meridian-prod-server` remains unused.

**Maintenance-mode AI gap (remediation item, not yet fixed).**
- **What happened:** that Brief call ran while `maintenance_mode=true`.
- **What `maintenance_mode` actually stops:** only `REFRESH_EXECUTION` and `CONNECTION_ESTABLISHMENT` (`lib/platform/admission/policy-core.ts`, `APPLIES_TO`).
- **Paid AI is stopped only by the kill switch**, `ai_paid_requests_paused` (`lib/platform/ai/paid-requests-admission.ts`).
- **Statement for the record:** `maintenance_mode` does not block paid AI.
- **Remediation, choose one:**
  - every maintenance runbook sets the kill switch ON and reverts it on reopen; or
  - admission makes `maintenance_mode` also deny paid AI.

  Either way, add a test that pins whichever is chosen.

## 9. Incident: platform Control and Merchant Ops had no effect (root cause found; fix tested, not applied)

**Symptoms:**
- The owner's normal account was raised Write → Control in `/admin/platform-access`, and the change persisted.
- The account still could not see AI policies or perform the expected Control operations.
- A Merchant Ops grant persisted, but Merchant Ops never appeared in the account's Spaces.

**The data is correct.**
- User `cmrwgylly…` (role USER) holds 5 ACTIVE `PlatformGrant` rows at CONTROL, written 14:35:01–08.
- The writes are audited: 4 × `PLATFORM_GRANT_LEVEL_CHANGED`, 1 × `PLATFORM_GRANT_CREATED`.
- Grants are read live on every request (`lib/platform/authorize.ts`). There is no session claim and no cache, so sign-out/sign-in is not the issue.

**Root cause: Production's platform seed is stale (configuration drift; not a code regression and not RLS).**
- **How the seed works:** platform Spaces and their dashboard sections are seeded rows (`scripts/seed-platform-spaces.ts` → `ensurePlatformSpaces` + `ensurePlatformSections`).
- **Production was seeded once, on 2026-07-25,** and never re-seeded after the registry grew. The v2.6 runbook (doc 25) has no seed step.

| | Production | Preview | Registry |
|---|---|---|---|
| Platform Spaces | 4 (no MERCHANT_OPS) | 5 | 5 |
| PLATFORM_OPS sections | 21 (no `ops_policies`, `ops_platform_health`, `ops_ai_invocations`, `ops_provider_cleanup`, …) | 29 | 29 |
| GROWTH_REVENUE / CUSTOMER_SUCCESS sections | 5 / 1 | 7 / 2 | 7 / 2 |

**How the drift produces each symptom:**
- **Merchant Ops is missing:** `GET /api/spaces` lists platform Spaces as `Space where platformArea IN (active grant areas)` (`app/api/spaces/route.ts`). No Space row means nothing to list. The admin matrix offers every enum area regardless of whether a Space exists, so the grant was accepted but points at nothing.
- **AI policies and Control actions are missing:** the Policies UI, including the AI cost controls panel, is the `ops_policies` section, and that row does not exist. That also explains why the earlier "saved" AI controls never reached Production: the panel was not rendered, and no PATCH appears in the logs. The panel itself only reports success on a 2xx.

**Space settings and memberships are a different axis, by design.**
- Space settings (`PATCH /api/spaces/[id]`) require SpaceMember ADMIN; member management requires OWNER (`requireSpaceRole`).
- Platform Spaces have no SpaceMember rows by design, and `lib/platform/policy.ts` keeps the axes separate. A tripwire test enforces this.
- So a platform grant (READ/WRITE/CONTROL) never confers Space settings or membership administration, on Preview or Production.
- The admin page defines CONTROL as changing declared operational policy. This is expected behaviour, not a defect.
- **UX follow-up:** the CONTROL description mentions only refresh cadence (it should also name AI cost controls), and the matrix should flag an area whose platform Space does not exist.

**Fix: run the idempotent seed on Production (no code change, no hotfix deploy).**
- **Command:** `with-prod-db.sh npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/seed-platform-spaces.ts`
- **What it writes:** create-only `Space` (upsert on `platformArea`, `update: {}`) and create-only `SpaceDashboardSection`, plus label convergence on drifted labels.
- **What it never touches:** grants, memberships, users, financial data, `enabled` or `order`.

**Tested** on a disposable local restore of the C1 dump migrated to 135 (container removed afterwards):
- it adds exactly MERCHANT_OPS plus the missing sections: 21 → 29, 5 → 7, 1 → 2, plus 1 for Merchant Ops (Preview's shape);
- grants, members, transactions and the non-platform section hash are unchanged;
- a second run writes nothing (no `updatedAt` churn).

**Expected result after the seed:**
- Merchant Operations appears for the account.
- Platform Ops shows Policies with AI cost controls editable at CONTROL.

**Runbook fix:** add `platform:seed-spaces` after `migrate deploy` in every environment cutover, and add a check that platform Spaces and sections equal the registry.

## 10. Release 2 findings (paused; nothing changed)

**DNS.**
- `app` CNAME → `ba57262d42ca4daa.vercel-dns-017.com`, resolving to 216.150.1.1 / 216.150.16.1 (Google and the NameBright authoritative server).
- The `*` wildcard still sends `www.` to NameBright parking.
- Not yet attached to any project.

**Marketing site.**
- `fourth-meridian-site` Production `dpl_5JHyp77…` is READY at `87e5ac8`.
- Production env: `NEXT_PUBLIC_SITE_ORIGIN=https://fourthmeridian.com`, `NEXT_PUBLIC_APP_ORIGIN=https://app.fourthmeridian.com`.

**Prerequisites before the apex moves** (`docs/operations/domain-split-preview.md` §6.2):
1. **Plaid allowlist (owner):** add `https://app.fourthmeridian.com/plaid-oauth-return` **before** `NEXT_PUBLIC_APP_URL` changes. Link-token `redirect_uri` and new-Item webhooks derive from it.
2. **Plaid webhooks:** **3 ACTIVE Production Items** carry `https://fourthmeridian.com/api/plaid/webhook`, which returns 404 once the apex is the static site. No `/item/webhook/update` tooling exists. A decision is needed: build the tool, or accept polling-only sync (cron cadence) for those Items.
3. **`NEXTAUTH_SECRET`:** Production record `140sAi8S` is shared with generic Preview, unchanged since 2026-06. It must be rotated immediately after the apex move (§6.2 step 10). Its value is unknown and it is shared with Preview, so rotating it earlier is advisable as well.
4. **Production env:** `NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` → `https://app.fourthmeridian.com`, `NEXT_PUBLIC_SITE_URL` → `https://fourthmeridian.com`.

**Rollback of the domain move:** re-add `fourthmeridian.com` to fintracker1. No DNS change is needed (same team).

## 11. Fix applied and Release 1 closed (C9)

**Platform seed on Production (owner-approved, 15:00 UTC).**
- **Created:** `MERCHANT_OPS` → Merchant Operations (exactly 1 row).
- **Sections:** PLATFORM_OPS 21 → 29 (`ops_policies` enabled), GROWTH_REVENUE 5 → 7, CUSTOMER_SUCCESS 1 → 2, MERCHANT_OPS 1.
- **Unchanged (hashes compared before and after):** PlatformGrant (5), SpaceMember (2), users (2), every non-platform section.
- A re-run wrote nothing. Health stayed ok with 0 5xx.

**AI spending controls,** set by the owner's normal account in Platform Ops → Policies (CONTROL grant):

| Control | Stored | Audit | Effective (app read model) |
|---|---|---|---|
| `ai_daily_allowance_usd` | `1` at 15:06:38 | `PLATFORM_POLICY_CHANGED` SUCCESS, DEFAULT → SETTING | $1/day, enforced |
| `ai_spend_alert_fleet_usd_24h` | `2` at 15:07:00 | `PLATFORM_POLICY_CHANGED` SUCCESS, DEFAULT → SETTING | $2 / 24 h, enabled |

- Both audit rows record actor `performedByAdminId` = the owner's normal account, `via PLATFORM_GRANT / PLATFORM_OPS`, with an IP.
- The kill switch is off.
- The project hard limit stays at $25/month.

**Final state:**
- **Production:** `main` `87e5ac8`, `dpl_6NL1QND6ccmcNvDvtM7x5Mue2Kso`, public, crons on, `maintenance_mode` unset.
- **Rollback deployment** `dpl_HRdMnpT3…` (`9ea5881`) is retained.
- **C1 dump** is kept privately for 7 days.
- **Owner database credential** (`pgpass`) has been destroyed with `rm -P`.

**Open remediation items:**
1. The maintenance-mode paid-AI gap (§8).
2. Runbook: seed after migrate, plus a registry-equality check (§9).
3. Admin CONTROL wording and the missing-Space flag (§9).
4. Release 2 prerequisites (§10).
