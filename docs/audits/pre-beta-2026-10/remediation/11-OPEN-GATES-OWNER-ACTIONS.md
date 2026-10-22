# 11 — Open Gates and Owner Actions

Everything below needs owner credentials, a remote setting, a live environment, or an owner decision. No item here was performed by this program, and no gate below is claimed closed by local code or documentation alone. (Draft at wave 1; completed at Phase 6.)

## A. Decisions

| # | Decision | Finding | Default this program assumed |
|---|---|---|---|
| D1 | Repository visibility: make private, or scrub operational docs from the public tree | SEC-018 | none (docs unchanged) |
| D2 | Apply the branch rulesets on `main` and `v2.6` (JSON + `gh api` command in `docs/operations/branching-and-protection.md`, Agent F) | TEST-001 | — |
| D3 | Manual CSV/XLSX import for the beta cohort: allowed (IDEMP-001 fix lands) or disabled | IDEMP-001 | allowed after the fix |
| D4 | Security Operations Space: keep read-only, or move session-revoke/2FA-reset into it | UI-020 | keep |
| D5 | Open registration on any environment: write `registration_mode=open` explicitly — the code default is now `invite_only` | SEC-008 | invite_only |
| D6 | Docker: 22 anonymous volumes on the laptop (`docker volume ls`) were NOT touched; identify by Postgres catalog before any removal | CQ-016 | untouched |
| D7 | Counsel review of the AI legal page, point-of-use OpenAI sentence and waitlist privacy notice | PRIV-010/011/012 | drafted by Agent A |

## B. Live-environment gates (cannot be closed from a laptop)

| # | Gate | Finding | Verification the owner records |
|---|---|---|---|
| G0 | Production cutover of the beta candidate (gates 1-11 + issues 1-6 of `production-cutover-plan.md`, plus `production-cutover-checklist.md`) | OPS-015, OPS-013 | `/api/health` on the apex reports the candidate SHA; `db-authority` strict + 3 roles |
| G0a | Every registered job run once on Preview via the fallback routes with `CRON_SECRET` | OPS-013 | one `JobRun` row per job |
| G0b | PG17.6/Supabase clone: run the six RLS acceptance suites (`npm run rls:accept*`) + `audit:ci` | DB-003 | counts recorded |
| G0c | PITR confirmed; timed restore rehearsal into a scratch DB with RPO/RTO; `fm_backup` password set | DB-007 | record in `docs/operations/` |
| G0d | `registration_mode` row = `invite_only`; Turnstile keys; `PLATFORM_ALERTS_EMAIL`; `RESEND_API_KEY` present on Preview and Production | SEC-008, OBS-003 | env inventory |
| G3 | External monitor on `/api/health` asserting the scheduler block (Agent E's `external-monitoring.md`); one forced `evaluate-alerts` delivering `sent` to the monitored mailbox | OPS-002, OBS-001 | monitor record + mailbox evidence |
| G5a | OpenAI project spend limit per environment recorded | SEC-AI-001 | `openai-environment-separation.md` |
| G13 | STATUS.md re-baselined to the integration SHA with the CI run id (after the owner pushes and reads the run) | SEC-AI-011 | STATUS §3 row |

## C. Not performed by rule

Push, merge to `main`/`v2.6`, deploy, migrations on Preview/Production, environment variables, Plaid/identity configuration, Docker volume removal, beta invitations.
