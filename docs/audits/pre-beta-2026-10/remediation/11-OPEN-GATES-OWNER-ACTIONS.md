# 11 — Open Gates and Owner Actions

Everything here needs owner credentials, a remote setting, a live environment, counsel, or an owner decision. **None of it was performed by this program**, and no gate below is claimed closed because local code or documentation exists. Order is the recommended execution order.

## A. Review and land the candidate (owner approval required)

1. Review `remediation/beta-1` (local). Integration HEAD and gates: `04` §3, `MORNING-HANDOFF.md`.
2. Push it and **read the GitHub run on the exact SHA** (three jobs; the `test` job now includes `Dependency audit (production, high+)`). Local `npm run ci` passed every job at `01098bd`; GitHub has never seen this SHA.
3. ✅ **Preview migrations DONE (A5, 2026-10-22 19:29 UTC, doc 18).**
   - The nine (`20261022000000` … `20261022001000`) were applied with `npm run db:migrate:safe` after a restore-verified dump.
   - Preview now has 135 applied; data unchanged.
   - DB-006 applied directly (no NOTICE).
   - `preview-app` (`cde8fa0`) is healthy on the migrated schema.
4. ✅ **PR #1 merged into `v2.6` (A6, 2026-10-22, `0773008`; follow-up fixes PRs #2–#4 → `7d1cee7`; doc 19).** Preview deployed and validated (A7: 49 PASS / 2 FAIL / 7 BLOCKED). Remaining from the original list:
   - re-seed platform sections if any new section was added (`scripts/seed-platform-spaces.ts`);
   - write `registration_mode` explicitly if open registration is wanted on Preview (code default is now `invite_only`).

## B. Decisions

| # | Decision | Finding | Default this program assumed |
|---|---|---|---|
| D1 | Repository visibility: make private, or move operational docs out of the public tree | SEC-018 | unchanged (public) |
| D2 | Apply branch rulesets on `main` and `v2.6` — JSON + `gh api` commands in `docs/operations/branching-and-protection.md` §4 (PRs on `v2.6`? admin bypass on `main`?) | TEST-001 | not applied |
| D3 | Production edge: Vercel-direct or Cloudflare? If Cloudflare fronts every request set `CLIENT_IP_TRUST_CLOUDFLARE=true` | ARCH-003 | unset (Vercel headers trusted) |
| D4 | Security Operations Space: keep read-only, or move session revoke / 2FA reset into it | UI-020 | read-only |
| D5 | Trash hard-purge window (trashed Spaces/accounts are restorable and are NOT purged on a timer) | PRIV-003 | no automatic purge |
| D6 | Reclassify transactions the user corrected BEFORE the FIN-002 fix (one-off run of the fixed `scripts/backfill-flowtype.ts`) | FIN-002 | not run |
| D7 | One period convention for Cash Flow vs AI (pending + local clock vs settled + UTC) | FIN-004 | documented only |
| D8 | Invitation e-mail: honour notification preferences (drop the route's branded send) or keep the branded mail (suppress the notification EMAIL channel) | NEW-010 / J-D4 | two e-mails per invite (known-defect pin) |
| D9 | Whether the waitlist operator e-mail keeps forwarding the applicant's free-text note | PRIV-012 | unchanged |
| D10 | Moderate advisories `exceljs`, `uuid` (post-beta) | SEC-002 residue | unchanged |
| D11 | Docker: 22 anonymous volumes on this laptop were NOT touched; identify by Postgres catalog before any removal | CQ-016 | untouched |
| D12 | Branch-deployment database isolation. **Interim applied 2026-10-22** (role URLs + `FM_RLS_STRICT` on generic Preview; `v2.6` and Production untouched, doc 17 §4). Full isolation needs a separate database (option A: a free project in the Vercel-Marketplace Free org, created by the owner; option B: a third project or a branch on Pro, about $10/month), plus a `v2.6`-scoped `DATABASE_URL`/`DIRECT_URL` pin first. | D12 | interim only |
| D13 | `preview-app` login wall: **by design** (Standard Protection exempts production custom domains only) | D13 | closed, no change |
| D14 | **Verified 2026-10-22 (doc 19 §3): Plaid Sandbox (link-sandbox token), OpenAI `fourth-meridian-preview` pin; Resend key scope still unread.** Original: Preview provider credentials: confirm `PLAID_ENV=sandbox` and whether Preview's `OPENAI_API_KEY` is a non-production project. Both are Sensitive, so this is an owner check. If production, turn the AI kill switch ON for the browser pass. Removing provider keys from generic Preview first needs them re-entered at `Preview@v2.6` scope (v2.6 inherits them today). | A7 | open |
| D15 | Preview registration: no `registration_mode` row; since PR #1 the code default is **`invite_only`** — verified live (A7 C1: no-invite and forged-invite registration both 403). Write an explicit row only if a different mode is wanted | SEC-008 | **closed** (invite_only by default) |
| D16 | TOTP disable accepts the account password alone (route: "code OR password"). Require the current TOTP code (or a recovery code) to disable 2FA? | A7 B4 / BUG-4 (P2) | unchanged |
| D17 | Production is live on `next` 16.2.7 (critical advisories 2026-10-22; exploitability unverified). Hotfix `main` now, or accept until the cutover | doc 20 §15 row 2 | **owner decision — urgent** |
| D18 | Keep or remove the A7 test data on Preview (4 users, "A7 Shared Space", test imports/wallet, Resend-test-sink invites) | doc 19 §6 | kept |
| D19 | A double-clicked waitlist approve sends two invites and invalidates the first link (approve = resend) | A7 I4 / BUG-5 (P3) | deferred |

## C. Counsel

Review three texts drafted by the program: the AI legal page enumeration of what is sent to OpenAI (`content/marketing/legal-ai.md`, mirrored byte-identically in `site/`; marked pending counsel), the point-of-use OpenAI sentence (`components/ai/AiDisclosure.tsx`), the waitlist privacy notice and consent (`components/marketing/RequestAccessForm.tsx`). Sub-processor list completeness (PRIV-013).

## D. Live-environment gates (cannot be closed from a laptop)

| # | Gate | Finding | Evidence to record |
|---|---|---|---|
| G0 | Production cutover of the candidate: every row of `docs/operations/production-cutover-checklist.md` plus `production-cutover-plan.md` gates 1–11 / issues 1–6 | OPS-015 | `/api/health` on the apex returns 200 with the `scheduler` block; `db-authority` strict + 3 roles |
| G0a | Every registered job run once on Preview through the fallback routes with `CRON_SECRET` | OPS-013 | one `JobRun` per job |
| G0b | PG17.6 / Supabase clone: run `npm run rls:accept*` (six suites) and `npm run audit:ci` — **the local proof is PG16 only** | DB-003 | counts recorded |
| G0c | Supabase PITR confirmed; timed restore rehearsal into a scratch DB with RPO/RTO; `fm_backup` password set. **Preview read 2026-10-22 (doc 17 §2): Pro plan, 7 daily physical backups, PITR DISABLED.** Decide PITR for Production before beta (paid add-on). A logical restore of Preview into PG 17.6 was rehearsed (doc 16 §2). | DB-007 | `docs/operations/backup-restore-verification.md` §6 row |
| G0d | `registration_mode=invite_only` row; Turnstile keys; `PLATFORM_ALERTS_EMAIL`; `RESEND_API_KEY` on Preview and Production | SEC-008, OBS-003 | env inventory |
| G3 | External monitor on Production `/api/health` with the assertions in `docs/operations/external-monitoring.md` §3; one forced `evaluate-alerts` delivering to the monitored mailbox (`runbooks/email-delivery-verification.md`); walk `runbooks/alerting-dead-evaluator.md` once on Preview; Sentry alert rules for `area:alert-delivery` / `area:operational-ledger` | OPS-002, OBS-001/003 | monitor + mailbox evidence |
| G5a | OpenAI project spend limit per environment recorded | SEC-AI-001 | `openai-environment-separation.md` |
| G6 | Run the historical audit e-mail scrub per environment (backup first): `npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/scrub-audit-emails.ts` (dry run), then `--apply` | PRIV-002 | dry-run count + applied count |
| G7 | `npm run db:drift` against the target before promotion | DB-008 | output |
| G8 | Browser pass on Preview: confirm dialogs (focus, Escape, stacking), failure surfaces under forced 401/403/500, error/loading boundaries, a READ-grant operator sees no write buttons, Markets shows Coming soon | UI-003/006/007/001, UI-014 | checklist |

## E. Not performed by rule

Push, merge to `main`/`v2.6`, deploy, migrations on Preview/Production, environment variables, Plaid/identity configuration, Docker volume removal, beta invitations.

_Exception, owner-approved:_ the Preview migrations (A5, 2026-10-22, doc 18). Production migrations remain not performed.
