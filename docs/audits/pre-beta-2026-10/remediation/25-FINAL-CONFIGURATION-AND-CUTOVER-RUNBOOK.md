# 25 — Final Production configuration, protections and cutover runbook

**Date:** 2026-10-23.
**Supersedes:** doc 23 §6 (runbook) and §7 (owner inputs) where they differ.
**Production:** `main` = `9ea5881`, unchanged. No migrations, role changes, env changes, financial edits or deploys were made.
**Candidate:** `v2.6` = `ae9b380`. Draft PR #10 (`release/v2.6-promotion`, head `29b7af9`) has a **tree identical to `v2.6`**.

## 1. What was done

| # | Action | State | Evidence |
|---|---|---|---|
| 1 | Production RLS role credentials | **Generated, staged, verified locally. NOT applied** | §2 |
| 2 | Role URLs + `FM_RLS_STRICT` env | **Staged script, guarded. NOT applied** (Production env unchanged, 30 rows) | §2 |
| 3 | Financial repair (50 credits) | **Validated on the Production clone. NOT applied** | §3 |
| 4 | PITR | Priced and assessed. **Still disabled, no charge** | §4 |
| 5 | GitHub branch protection | **Live and enforcement-proven** on `main` and `v2.6` | §5 |
| 6 | OpenAI spend controls | Assessed. **No change made** (decision needed) | §6 |
| 7 | PR #10 | CI green except the by-design `Deployment health` UNVERIFIED. MERGEABLE. Still draft | §1 |

## 2. Database role credentials (C4/C5 staged)

**Private directory:** `~/fm-rehearsal-private/prod-cutover/` (dir 700, files 600, FileVault on). Not in Git.

| File | Purpose |
|---|---|
| `roles.secret.json` | **Owner recovery copy.** For `fm_app`, `fm_auth`, `fm_system`: a 256-bit password (`crypto.randomBytes(32)`), its SCRAM-SHA-256 verifier, and the pooler URL `postgresql://<role>.qirf…@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true` |
| `c4-set-role-passwords.sql` | `ALTER ROLE … PASSWORD '<SCRAM verifier>'` ×3 in one transaction. **The plaintext never reaches the database or any log.** Run as `postgres` **after** the 47 migrations (they create the roles) |
| `c4-verify-roles.mjs` | Connects through each pooler URL (password only in the child's `PGPASSWORD`). In a READ ONLY transaction asserts `current_user`, `rolbypassrls=false`, `statement_timeout` 15s/5s/60s. Writes the `c4-passed` marker |
| `c5-add-vercel-env.mjs` | `vercel env add <NAME> production --sensitive --yes`, value on **stdin** (never argv). Adds the 3 URLs + `FM_RLS_STRICT=true`, then lists them. **Refuses** without `--i-am-at-c5` **and** the `c4-passed` marker (both refusals tested, exit 2) |

**Verified now:**
- Each password authenticates against its verifier on a local PG 17, and a wrong password is refused.
- v2.6's strict-mode validator (`lib/db/strict-mode.ts`) accepts the three URLs with both the pooler and the direct `DATABASE_URL` shapes. Both negative controls fail as expected (wrong ref; dotted user on a direct host).

**Not changed:** the `postgres` password and the current `DATABASE_URL`. Rotation is out of scope.

**Order guarantee:** v2.6 refuses to boot in Production without the roles and the strict env, so a premature deploy would cause a 500 outage, not a data change. Env vars added at C5 do not affect the running (immutable) `9ea5881` deployment, and the old code ignores them.

## 3. Financial correction (C3b) — validated, not applied

On the restored Production clone, `repair-liability-income-credits --include-deleted --apply` reclassified **50** rows.

**10 live, $2,451.33:**

| Destination | Rows | Amount |
|---|---|---|
| Travel/REFUND | 7 | $2,000.77 |
| Other/UNKNOWN | 2 | $432.18 |
| Dining/REFUND | 1 | $18.38 |

**40 tombstoned rows, $2,612.55:** 39 → Travel/REFUND, 1 → Other/UNKNOWN.

| Check | Result |
|---|---|
| Balance fingerprints (FinancialAccount balances, SpaceSnapshot, Holding, Transaction id/amount/date/account/deleted) | **Identical before and after** |
| Income totals | **Unchanged.** The income view already excluded these as ISSUER_CREDIT |
| Spending | Refunds now net against category spend: Travel/Dining **−$2,019.15** (correct refund economics) |
| PII | The evidence holds only masked `md5(id)` prefixes, months, amounts and categories |

**Cutover gate:** `c3b-check-candidates.sql` (read-only) must return exactly the 50 rows in `c3b-expected-candidates.txt`. **Any difference ⇒ STOP** (do not apply; the owner decides).

## 4. PITR

| Fact | Value (Supabase dashboard + docs, 2026-10-23) |
|---|---|
| Price | 7 days **$100/mo**, 14 days $200/mo, 28 days $400/mo, excluding tax, **prorated hourly**. No charge at enablement |
| Prerequisite | Compute **Small or larger**. Production is **Micro** ⇒ a resize (database restart, ~1–2 min downtime) to enable, and again to downgrade |
| Side effect | **Daily backups stop** while PITR is on |
| RPO / restore | ~2 min RPO. Restore is **in place with downtime**: every write after the chosen point is lost |
| Current | **Disabled.** 8 daily physical backups retained |

**Recommendation: do NOT enable PITR for this cutover.** Reasons:
- The database phase is **write-free and ~3 minutes**.
- A fresh, restore-verified `pg_dump` (C1) gives RPO = 0 for that window.
- PITR would add two restarts and stop daily backups.

**If the owner wants it anyway:**
- Enable 7-day PITR with the Small resize **≥ 1 hour before** C1. The restart happens **before** the window.
- Keep it for about a week, then disable it and downgrade.
- Approximate cost: ~$23 PITR + the Micro→Small compute delta for the period, plus tax.
- **Needs explicit cost approval; not done.**

**Regardless of PITR:**
- C1 fresh dump + SHA-256 + local restore check.
- A write-free window (§7.1).
- Rollback decision points (§7.3).
- The data-loss statement: **restoring C1 after users resume discards every write made after C1.** After R2 (§7.3), roll forward, don't restore.

## 5. GitHub branch protection — live

| Ruleset | Target | Rules |
|---|---|---|
| `25690160` | `v2.6` | Block deletion; block non-fast-forward (force push); require a PR (0 approvals: sole operator, no deadlock); required checks `test`, `Architecture audits`, `Public site (zero-authority boundary)`, `status-drift-guard` (GitHub Actions app 15368) |
| `25690163` | `main` | The same, with required checks `test` + `status-drift-guard` (strict, up to date). Those are the only checks `main`'s current workflows produce |

**Bypass:**
- Repository admin only, mode **`pull_request`**: an admin can merge a PR in an emergency, but **cannot direct-push, force-push or delete**.
- This is the controlled hotfix path.

**Enforcement proven** with a probe ruleset on a throwaway branch: direct push, force push and delete were each **rejected (GH013), even for the admin**. The probe was removed. GitHub reports both rulesets as the branch's effective rules.

Visibility unchanged (public).

**Post-promotion step:** add `Architecture audits` and `Public site (zero-authority boundary)` to `main`'s required checks once `main` carries v2.6's workflows (C9).

## 6. OpenAI spend controls

**Observed (read-only, platform.openai.com):**

| Item | State |
|---|---|
| Organization spend limit | **$100/mo, shown as "Limit not enforced"** (notification-only). Alerts at $80 and $100 |
| Prepaid auto-reload | Reloads to $15 when the balance hits $5, **monthly auto-reload limit $75** (org-wide, shared by every project) |
| Project `fourth-meridian-prod` (`proj_ENcU…`) | **No spend limit set.** Month-to-date $0 |
| Project keys | `fm-prod-backend` and `fourth-meridian-prod-server`: **never used** |
| Other projects, month to date | Default $13.69; preview $0.28; dev $0.38 |
| Legacy key | `FourthMeridianKey` (2026-07-01), last used 2026-10-16 |

**Conclusions:**

1. **A project or org budget is not a guaranteed cap.**
   - The org limit is explicitly not enforced.
   - Project limits are soft, monthly, and checked after usage, so overage is possible.
   - **The only external hard stop is the prepaid balance plus the $75/mo auto-reload ceiling**, and it is shared with Dev and Preview.
2. **The real enforcement is in v2.6 (absent from the old app):**
   - a per-customer daily allowance ($5 BETA policy, $20 code ceiling, enforced by reservation);
   - a fleet alert at $10/24h and a per-user alert at $3/24h;
   - the kill switch `ai_paid_requests_paused`, which refuses all paid AI.
   - Worst case at the default allowance: 2 users × $5 × 31 ≈ **$310/mo**. So the app alone does not hold a $25 month.
3. **$25/month is realistic** for current usage: two users; Preview month-to-date $0.28 across the whole A7 programme; the Brief costs about $0.003.
4. **Prod-key alignment is unverified.** The Production Vercel values are Sensitive and unreadable. The Production project has no usage, so the current Production app (main) is **not** using the prod project's keys. v2.6 pins `OPENAI_PROJECT_ID` and guards on `OPENAI_EXPECTED_ENVIRONMENT=production`; a key from another project with that pin is rejected by OpenAI.

**Recommendation (needs owner approval; none of it affects the running app):**

| # | Setting | Value |
|---|---|---|
| O1 | Project `fourth-meridian-prod` spend limit, with alerts | **$25/mo**, alerts **$10** and **$20** (notification and soft stop only) |
| O2 | v2.6 platform setting `ai_daily_allowance_usd` (Platform Ops → AI Policies, after cutover) | **$1/day** per customer ⇒ worst case 2 × $1 × 31 = $62. Raise it as usage proves out |
| O3 | Fleet alert `ai_spend_alert_fleet_usd_24h` | **$2** (≈ $25 / 31 × 2.5) |
| O4 | Keep the auto-reload ceiling | $75/mo, the shared external backstop |
| O5 | C7 check | After one Conversations turn, `fm-prod-backend` "Last used" updates and project usage is > $0. **If not: kill switch ON, fix the key, re-check** |

## 7. Cutover runbook (final)

**Operator:** one person, one terminal, nothing else running.

**Prerequisites:**
- Owner approvals for §8.
- Both users signed out.
- PR #10 re-checked green on the same head.

### 7.1 Window

- **Avoid these UTC times:**
  - 00:00, 06:00–07:30, 12:00 and 18:00 (the `dispatch` cron: syncs, prices, FX, housekeeping);
  - ±10 min around each.
- **Good:** 02:00–05:30 or 08:00–11:30 UTC.
- **Remaining writes during the window:** `resume-stale-imports` JobRun telemetry every 5 min (harmless, and lost on a C1 restore).
- `maintenance_mode` blocks refresh execution and connection establishment, including webhook-triggered syncs. It does **not** block user edits, so users must be signed out.

### 7.2 Sequence

| Step | Action | Pass condition | On failure |
|---|---|---|---|
| **C0** | Set `maintenance_mode` on (Platform Ops / PlatformSetting). Confirm both users are out | Setting read back = on | — |
| **C1** | Fresh `pg_dump` (session pooler, read-only) + SHA-256; restore into local PG 17.6; compare row counts + migration fingerprint | Restore matches live; 88 migrations, md5 `9ea5829f…` | Abort; maintenance off |
| **C2** | Preflight (`c2-preflight.sql`, read-only): duplicate checks for each unique index the 47 migrations add | All 0 | Abort; maintenance off |
| **C3** | `npm run db:migrate:safe` from `v2.6` against Production (`postgres`) | 135 applied, 0 unfinished; 4 `fm_*` roles exist | P3018 ⇒ fix the data, `migrate resolve --rolled-back`, re-run (drilled). The old app tolerates every intermediate state |
| **C3b** | `c3b-check-candidates.sql` = `c3b-expected-candidates.txt` → `repair-liability-income-credits --include-deleted --apply` → `backfill-flow-authority --apply` → `backfill-economic-date --apply` → `backfill-event-identity --apply` → `repair-event-pin-drift --apply` → re-run the checks | 50 rows exactly; 0 remaining in pin drift / projection drift / economic date / flow authority; balance fingerprint unchanged | Candidate diff ⇒ STOP before applying. Script failure ⇒ stop; old app still serving; owner decides restore vs fix |
| **C4** | `psql -f c4-set-role-passwords.sql` (as `postgres`) → `node c4-verify-roles.mjs` | 3/3 connect, no BYPASSRLS, timeouts 15/5/60 s; marker written | Re-run the SQL; never weaken grants |
| **C5** | `node c5-add-vercel-env.mjs --i-am-at-c5` | 4 Sensitive Production vars listed | Remove the vars; the old deployment is unaffected |
| **C6** | Mark PR #10 ready → merge (normal checks, no bypass) → the Production deploy builds | Deploy READY | Build fail ⇒ the old deployment keeps serving |
| **C7** | Verify: `/api/health` ok (strict, scheduler); owner login + TOTP; dashboard; transaction counts (old 4,538 vs new 4,513 = −25 crypto rows, Σ $0.22, by design); RLS fails closed; OpenAI O5; 0 server errors in `vercel logs` | All pass | **R1** (§7.3) |
| **C8** | `maintenance_mode` off; the owner smoke-tests a refresh; 30-min log watch | Refresh succeeds; no 5xx | R1 or R2 |
| **C9** | Add `Architecture audits` + `Public site` to `main`'s required checks; apply O1–O3; delete private evidence after 7 days | — | — |

**Duration:** database phase ≈ 3 min measured locally (allow 2–3× over the pooler). End to end ≈ 45–60 min including the deploy and verification.

### 7.3 Rollback decision points

| Point | Situation | Action | Data loss |
|---|---|---|---|
| **Before C6** | Any failure in C1–C5 | Stop. The old app keeps serving: the migrated schema is backward-compatible (verified on the clone). Optional: restore C1 | None (window is write-free) |
| **R1: after C6, maintenance still on** | C7 fails | Vercel "Promote" the previous deployment `9ea5881` (instant). The schema stays migrated, which the old app tolerates. Strict env vars are harmless to it | None |
| **R2: after C8 (users writing)** | A defect found | **Roll forward** (hotfix PR via the admin `pull_request` bypass), or R1 code rollback. **Do not restore C1:** it discards every write made after C1 (refreshes, edits, AI usage) | Restore = loses every post-C1 write |
| **Data corruption** | Proven corrupt financial data | Owner decision. Restore C1 into a **new** Supabase project, compare, then repoint or repair selectively | As stated above |

## 8. Owner decisions still required

1. **Cutover window:** date and UTC slot (§7.1), and both users signed out.
2. **PITR:** recommended **no** (§4). If yes, approve ~$23 + the Small compute delta and the extra restarts.
3. **OpenAI O1–O3** (§6): the $25 project limit with $10/$20 alerts; the $1/day allowance; the $2 fleet alert.
4. **OpenAI key alignment:** confirm that Vercel Production `OPENAI_API_KEY` / `OPENAI_PROJECT_ID` are the `fourth-meridian-prod` project's key/id, and `OPENAI_EXPECTED_ENVIRONMENT=production`. O5 verifies it at C7.
5. **GO to execute C0–C9.** It covers the already-approved C3b correction, C4 roles and C5 env, plus the PR #10 merge and v2.6 deploy, which remain unapproved.

## 9. GO / NO-GO

| Gate | Status |
|---|---|
| Code (PR #10 = `v2.6` `ae9b380`, CI green) | ✅ |
| A7 functional (58/0/0) | ✅ |
| Production clone rehearsal (migrate + data + audits + RLS 37/37 + old/new app + failure drill) | ✅ |
| Role credentials + env staged and verified, with guards | ✅ |
| Financial correction validated, with a stop gate | ✅ |
| Backup / restore capability (86 s dump, 1–2 s restore, SHA-256) | ✅ |
| Branch protection enforced | ✅ |
| OpenAI spend controls | ⚠️ app controls ready; external limit + key alignment pending owner (§8.3–8.4) |
| PITR | ➖ not required (recommendation) |

**Verdict: GO for a controlled cutover, conditional on the §8 owner decisions.** No technical blocker remains.
