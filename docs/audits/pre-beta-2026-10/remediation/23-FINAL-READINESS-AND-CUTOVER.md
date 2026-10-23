# 23 — Final readiness: B4/I4, A7 closure, Production discovery, cutover runbook, GO/NO-GO

**Date:** 2026-10-23 (UTC).

**Production:** `main` `9ea5881` (`dpl_HRdMnpT3J9fSVXh3vpaP5RDjhRL2`), untouched by this work except read-only inspection.

**Candidate:** `v2.6` `c1d4597` (+ docs); promotion draft **PR #10** (`release/v2.6-promotion` → `main`, **not merged**).

## 0. D17 closure

**D17 is CLOSED.** Details: doc 21.

| Check | Result |
|---|---|
| Merge | `9ea5881` (PR #6) at 22:08:14 UTC |
| Production deployment | `dpl_HRdMnpT3…`, READY at 22:09:48 UTC |
| 30-minute monitor | **12/12 checks OK**: health ok and `db ok` (`commit 9ea5881`), `/` 200, `/login` 200, malformed Bearer → 307 |
| Production logs | 45 minutes, 50 entries: 0 errors, 0 × 5xx |
| Owner verification | login + TOTP + dashboard **PASS** on Production and Preview (owner-reported 2026-10-23) |
| Sentry | not inspectable from this session; no Sentry access. Recorded as unverified here |

## 1. Workstream 1: A7 failures fixed

| Finding | Fix | Tests | Preview evidence (`c1d4597`) | Result |
|---|---|---|---|---|
| **B4** (P2): 2FA could be disabled with the password alone | **PR #8**: a fresh TOTP code is required. The code's 30 s step is claimed in `RateLimit` (unique key+window) against replay. Lost device = recovery code **and** password, consumed atomically. UI tab "Lost device". Operator reset unchanged | `totp-routes` 52/52 (correct password alone → 400; replayed step → 400; recovery alone / + wrong password (not consumed) / unknown → 400; recovery+password → 200; anonymous 401; cross-user refused). Unit 830/830 | Live, all refused 400 with 2FA kept on: password alone, recovery code alone, recovery + wrong password, wrong code. Same code ×2 concurrent → 200 / 400. Recovery + password → 200 with `RECOVERY_CODE_USED` audited | **PASS** |
| **I4** (P3): a double-clicked approve sent two invites | **PR #9**: approve transitions only `PENDING`/`DENIED` → `APPROVED` (one conditional `updateMany`). Only the winner mints, e-mails and audits. Repeat / loser → 200 `alreadyApproved`, nothing sent | New route test 10/10. **It fails 4 checks on the old route** (2 e-mails, 2 audits). Unit 831/831 | Live: concurrent approve → `sent` + `alreadyApproved`; repeat → `alreadyApproved`; token unchanged; 1 audit row | **PASS** |

## 2. Workstream 2: A7 closure

| Row | Method | Result |
|---|---|---|
| A4 reset link single-use | Seeded a reset token on a test account (stored SHA-256, as the app stores it) → real route | **PASS**: first 200; reuse 400; new password works; old refused |
| C3 verify link | Seeded a verification token on a test account | **PASS**: `verified` → reuse `already_verified` (by design) → unknown 400 |
| C2 invite redemption | Rotated the approved invite's token (equivalent to `/resend`) → real register | **PASS**: wrong e-mail 403; register 201 (pre-verified, can sign in); request `REDEEMED`; hash cleared; a token on a redeemed invite → `canRegister:false` |
| F1 late paycheck | Synthetic fixture on test account t1: 11 biweekly $3,000 payroll rows, newest 2026-10-04, so the 10-18 slot is 5 days overdue (the FIN-001 audit fixture). One AI turn | **PASS**: the projection is labelled a lower bound; payroll "not fully included"; omitted bound ≈ **$15,000** (= the audit fixture). The original failure (payroll silently dropped to $0) was reproduced on pre-fix code in the runtime audit (`runtime/`, FIN-001) |
| E1/E2/E4 Plaid Sandbox connect / refresh / disconnect | Owner on Preview (2026-10-23) | **PASS (owner-verified)** |

**A7 final: 58 PASS · 0 FAIL · 0 BLOCKED** (E1, E2, E4 owner-verified 2026-10-23). Previously 49 / 2 / 7.

## 3. Workstream 3: Production backup posture (read-only discovery)

| Item | Value | Source |
|---|---|---|
| Project | `fourth-meridian-production` (`qirf…`), VirtuArch Pro, Micro | Supabase dashboard |
| PostgreSQL | 17.6 | SQL (read-only) |
| Size | 51 MB (`pg_database_size` 50,957,459 B); 2 users; 5,135 transactions; 27,563 JobRun rows | SQL |
| Backups | **8 daily PHYSICAL**, 15 → 22 Oct, newest 22 Oct 16:16:30 UTC, all COMPLETED | dashboard |
| PITR | **Disabled** (add-on offered) | dashboard |
| Restore options | In-place restore; **Restore to new project** (Preview itself was created this way from Production on 22 Jun) | dashboard |
| WAL archiving | on; 41,148 archived, **0 failed**; last a few seconds before the read | `pg_stat_archiver` |

**DONE (doc 24):** fresh read-only backup (86 s, SHA-256 `56f027df…`), restored to isolated PG 17.6 in 1.1 s. All 56 tables / 58,374 rows and the 480-entry catalog match live Production. RPO without PITR: the pre-cutover dump.

## 4. Workstream 4: migration delta and preflight

**Exact delta, not an estimate:**
- Production `_prisma_migrations` = **88** applied, 0 unfinished, 0 rolled back.
- The md5 of `name:checksum` over all 88 equals the repository's first 88 (`9ea5829f99dc879274eb8af4cf17c8e6`).
- **Pending = exactly 47**, `20260801_v26_investments_history_snapshot_completeness` → `20261022001000_db008_provider_capability_index_name`.

**Classification** (doc 22, all 47): H 1 · M 6 · L 40.
- **H** = `20261002000100_rls_roles_and_policies`. It creates the 4 roles and enables + FORCEs RLS on 56 tables with 220 policies in one transaction. Exclusive locks on 48 tables are held until commit (seconds at this size).
- **No migration drops, renames or retypes a column, or adds a NOT NULL column without a default.**
- **Migrate-then-deploy is safe; deploy-then-migrate is impossible.** The old app (`9ea5881`) keeps working after the migrations **because it connects as `postgres` (BYPASSRLS)**, confirmed in `pg_stat_activity`.

**Read-only preflight on Production** (2026-10-22 23:04 UTC, doc 22 SQL). Every expected-safe value holds:
- PG 17.6; `postgres` non-superuser with CREATEROLE + BYPASSRLS; owns every table and enum; no `fm_*` roles; 0 policies; `scram-sha-256`.
- Drift: no required table missing; no pending table, type, column or index already present; enum labels as required.
- `20261002000000`: 0 null-account transactions or holdings, 0 MerchantRule scope violations.
- `20261004000000`: 0 duplicate Plaid external ids (11 identities).
- JobRun: 1 stale `running` row (the migration rewrites it to failed); 0 in flight in the last 6 minutes.

**Rehearsal history:**
- All 47 applied successfully on shared Preview: 38 at the 2026-10-06 cutover, 9 in A5.
- **Preview was created from a Production backup on 2026-06-22**, so the migrations have run on Production-derived data (four months stale).

**DONE (doc 24):**
- 47 applied in 0.36 s (4.5–6 s via `db:migrate:safe`); longest lock 69 ms.
- Old app and v2.6 strict both verified on the migrated clone.
- Failure drill passed.
- **Two data-convergence defects found and fixed (PR #12)**: the event-identity backfill dropped `authorizedAt` (2,783 mis-pinned events); the flow-authority backfill had been deleted but never run on Production.
- After the rehearsed data sequence: `audit:ci` 27/28 (schema-drift clean as superuser), `rls:accept` 37/37.

## 5. Workstream 5: Production environment (metadata only, no values)

| Requirement (v2.6) | Production | Action |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `ENCRYPTION_KEY`, `RESEND_API_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_SENTRY_DSN`, `PLATFORM_ALERTS_EMAIL` | present | — |
| **`FM_RLS_STRICT=true`** + **`DATABASE_URL_APP` / `_AUTH` / `_SYSTEM`** | **absent** | **Owner**: v2.6 **refuses to boot** in Production without them (`lib/db/strict-mode.ts:211`, `VERCEL_ENV=production`). Values are the `fm_*` role URLs, which exist only after `20261002000100` plus owner-set passwords |
| `fm_app` / `fm_auth` / `fm_system` / `fm_backup` roles | absent (created by migration, without passwords) | **Owner** sets SCRAM passwords after the migration (procedure: `rls-preview-cutover.md`) |
| `PLAID_ENV` | Sensitive (unreadable) | **Proven `production`**: `9ea5881`'s boot guard throws if Plaid credentials are set with a non-production env, and Production boots |
| `OPENAI_API_KEY` / `OPENAI_PROJECT_ID` / `OPENAI_EXPECTED_ENVIRONMENT` | present (records of 2026-10-15) | Verified only after deploy via the env-status widget (pin + guard `production`). Spend limits: owner (G5a) |
| `NEXT_PUBLIC_SITE_URL`, Turnstile keys, `BETA_REQUESTS_EMAIL`, `SECURITY_ALERTS_EMAIL` | absent | Optional: the domain split is later; Turnstile is deferred while invite-only |
| Scheduler | `vercel.json`: `/api/jobs/dispatch` `*/15`, `/api/jobs/resume-stale-imports` `*/5`; Production already runs crons (27,563 JobRun rows) | Verify one dispatch writes a `JobRun` within 15 minutes after promote |
| D15 registration | `invite_only` by code default (verified on Preview) | none |
| D12 | interim only | owner (paid or owner-created DB); not a cutover blocker |
| Rulesets | none on `main` / `v2.6` | **Owner decision D2**: recommend before promotion |

## 6. Workstream 6: cutover runbook (migrate-then-deploy)

**Release candidate:**
- Draft **PR #10** `release/v2.6-promotion` → `main`.
- The tree is **identical to `v2.6`**.
- `main` merged in, with the D17 hotfix reconciled: the conflicts in `package.json`, `package-lock.json` and `link-token/route.ts` were resolved to `v2.6`'s equal-or-newer versions; the Plaid redirect fix is present in both.
- Audit: 0 high / 0 critical. `next build` OK (16.4.2, 150 pages).
- GitHub CI on PR #10: see `RESUME-CHECKPOINT`.

**Pre-cutover (T−1 day):**
1. Current-clone rehearsal (§7 access): restore the dump to PG 17.6 with the Supabase role model, then:
   - `npm run db:migrate:safe` (47), timed;
   - integrity diff (row hashes);
   - six `rls:accept*` suites;
   - a failure drill: kill mid-`20261002000100` → verify rollback → `prisma migrate resolve --rolled-back` → re-run.
2. Owner:
   - generate three role passwords, held locally;
   - prepare the four Vercel Production env values;
   - decide the rulesets;
   - record OpenAI Production spend limits.

**Cutover (quiet window, about 30 minutes; the lowest-traffic hour, since there are 2 users):**

| Step | Action | Verify | Abort / rollback point |
|---|---|---|---|
| C1 | Privileged logical dump of Production (`pg_dump -Fc`, with ACLs) into a 700 directory; SHA-256 | Restore check into PG 17.6: row counts and hashes equal | Abort on any mismatch. Nothing has changed |
| C2 | Re-run the doc 22 preflight SQL | All expected values | Abort |
| C3 | `npm run db:migrate:safe` against Production (47; seconds; brief locks during `…000100`) | 135 applied, 0 failed; the old app still answers (`/api/health` ok, `commit 9ea5881`) | Failure: the migration's transaction rolls back. `migrate resolve --rolled-back`, fix, re-run. **Never** `migrate reset` |
| C4 | Set the `fm_app` / `fm_auth` / `fm_system` passwords (SCRAM); log in read-only as each | `current_user`, `rolbypassrls=f` | Re-set the passwords |
| C5 | Add Production env: the three role URLs + `FM_RLS_STRICT=true` (Sensitive) | Rows present (names) | Remove the rows. The old code ignores them |
| C6 | Mark **PR #10** ready → merge (= Production deploy) | Build READY; alias moves | — |
| C7 | Post-deploy, 15 minutes | `/api/health` ok with the `scheduler` block; db-authority strict, 3 roles; owner login + TOTP; Spaces, Cash Flow, Debt render; Brief; env-status shows the OpenAI pin `production`; malformed Bearer 307 | **App regression → Vercel Instant Rollback to `dpl_HRdMnpT3…` (`9ea5881`)**. Old code works on the migrated schema. **No data loss** |
| C3b | **Data convergence, immediately after C3, before C4** (rehearsed order, ≈ 35 s locally; doc 24 §5), each dry-run then `--apply`, against Production via `DIRECT_URL`:
1. `repair-liability-income-credits --include-deleted`;
2. `backfill-flow-authority`;
3. `backfill-economic-date`;
4. `backfill-event-identity`;
5. `repair-event-pin-drift`. | Re-runs report 0 remaining; projection drift 0; `npm run audit:ci` data invariants pass | Each step is idempotent and re-runnable. The old app is unaffected (it does not read these columns) |
| C8 | `seed-platform-spaces`; re-run `backfill-economic-date` (idempotent) | Script output | Re-runnable |
| C9 | Monitor 60 minutes: one `JobRun` per 15 minutes; Plaid refresh of one Item; logs and Sentry | — | As C7 |

**Rollback and data-loss statement:**
- **App rollback** (C6–C9): instant and lossless. Production keeps the migrated schema, which the old app tolerates.
- **Schema rollback**: not needed and **not recommended**. The 47 migrations are expand-only. Reversing `…000100` (RLS/roles) or the JobRun rewrite by hand is possible but gains nothing.
- **Data rollback** (corruption only): restore the C1 dump. **This loses every write after C1**: the cutover window plus any time until the decision. Without PITR, **no-data-loss cannot be guaranteed** beyond that. Mitigations:
  - a short window with 2 users;
  - announce the window;
  - optionally enable PITR for the cutover week (paid; owner decision).

## 7. Owner actions (genuine blockers only)

1. ~~Production clone access~~: **done** (pgpass provided; deleted after use).
2. ~~Plaid Sandbox E1/E2/E4~~: **done** (owner-verified).
3. **Review and approve PR #12** (data-convergence fixes, required for the cutover). It merges into `v2.6` through normal CI. Then PR #10 is refreshed from `v2.6`.
4. **Cutover inputs (when you schedule it):**
   - three role passwords (`fm_app` / `fm_auth` / `fm_system`);
   - four Production env rows (`DATABASE_URL_APP` / `_AUTH` / `_SYSTEM`, `FM_RLS_STRICT=true`);
   - the rulesets decision (D2);
   - OpenAI Production spend limit (G5a);
   - optionally PITR for the cutover week;
   - acknowledgement that the cutover **reclassifies 50 historical credits** (refund economics; 10 live rows, Σ live $2,451.33 per doc 24) and stamps ownership on all rows.
5. **Cutover approval** (merging PR #10 deploys Production).

## 8. GO / NO-GO

- **Candidate code: GO** once PR #12 is merged and PR #10 is refreshed:
  - CI green; B4/I4 fixed; A7 58/0/0; audit clean; build OK;
  - the Production clone rehearsal passes end to end (doc 24).
- **Production cutover: CONDITIONAL GO.** Ready to schedule as soon as §7.3–§7.5 are done.
  - Evidence: a verified backup and a 1-second restore; 47 migrations in under a second; the full data convergence in about 35 s; every data invariant passing on Production's own rows; both app versions working on the migrated schema; and a rehearsed failure recovery.
  - Remaining risk: network latency to Supabase (allow 2–3× the local timings), and no PITR, so the RPO is the C1 dump.
