# 26 — Production cutover execution (Release 1) and domain-split status (Release 2)

**Date:** 2026-10-23, 03:37 → 07:52 UTC.

**Release 1 status:** **BLOCKED at the owner login/TOTP gate.** Every automated gate (C0–C6 and automated C7) passed. Production is live on v2.6 behind a deny-all firewall, so no user can reach it yet.

**Release 2 status:** **BLOCKED.** It depends on Release 1 passing, and on an owner-only NameBright DNS record for `app.fourthmeridian.com`.

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
