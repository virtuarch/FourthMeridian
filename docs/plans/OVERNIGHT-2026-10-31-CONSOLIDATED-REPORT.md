# Overnight execution report: 2026-10-31

**Sessions.** Claude 1 is Session 1, the coordinator. Claude 2 is Session 2.

**Scope.** This report covers the overnight directive of 2026-10-31.
- Every merge went to **develop (Preview)**.
- **`main` / Production was never deployed or merged.**
- The only Production changes were the two approved items in §5.

Claude 2's full section is in [OVERNIGHT-2026-10-31-SESSION2-HANDOFF.md](OVERNIGHT-2026-10-31-SESSION2-HANDOFF.md). The live checklist is `/Users/chrstn/dev/OVERNIGHT-2026-10-31-CHECKLIST.md`.

---

## 1. Status by workstream

| Workstream | Status | Notes |
|---|---|---|
| **§1 Communications Center backend (Claude 1)** | **PASS** for A-1, A-2, B1 and B2. B2 activation is **intentionally locked** | Catalog, delivery ledger, the six approved policy decisions, editable content with AI polish, and the automation engine are all merged and migrated on Preview. The automation activation switch is OFF in code until the hardening PR (§7) lands. |
| Communications Center Phase C (Resend delivery webhook) | **NOT STARTED** | Next in the queue. Until then, "delivered" is shown as "accepted by provider"; it is never claimed as delivered. |
| New notifications (welcome, bank re-login, wallet failure, Platform access) | **PASS** | #181. Digest is built and **OFF**. Preview sends to the owner's address only. |
| **§2 Beta security and Cost Freeze (Claude 2)** | **PASS** | All §2 rows pass; see Claude 2's handoff §1. |
| CS Communications Center UI (Claude 2) | **PASS** | #171, #179, #182, #186. Content editor verified on Preview at desktop and 390 px. |
| **§3 Production REVOKE CREATE A+B** | **PASS** | Executed and verified; no rollback needed (§5). |
| §3b Production `fm_diag_ro` investigation | **PASS**, role retired | Approved separately by the owner in Claude 2's session; this directive did not cover it (§5). |
| **§4 Preview migrations (5)** | **PASS** | All applied through `db:migrate:safe` with backups verified row by row (§3). |
| §4b Preview credential finding | **CONFIRMED** + containment **BLOCKED (owner action)** | §6. |
| Crypto history: ETH stuck | **PASS** (fixed and verified live) | #172 (root cause), #178 (fast path). Live: ETH history COMPLETE in 2 passes using 67 Alchemy calls. |
| Crypto history: P1 understated rows read as complete | **PASS** (correctness) / **FAIL** (throughput from laptop) | #173, #183, #185. Live: 0 days read `supported` while missing a holder; rebuilt days are exact to the cent. Rebuild speed from the laptop is about 1 week per pass; it has not been measured on Vercel. |

## 2. PRs merged to develop

**Claude 1**

| PR | Merge | What |
|---|---|---|
| #157 | `116b9b0` | Branded email design system + beta approval email |
| #158 | `e440aa3` | One invitation issuance path; configurable validity (Growth setting, audited extend) |
| #163 | `bbfb2e0` | Bulk beta approval (preview, confirm, idempotent, audited) |
| #164 | `b0cad71` | All transactional emails moved to the branded design + catalog; no notice when a user removes a bank themselves (owner decision) |
| #165 | `8e5cd18` | Comms architecture audit + API contract v1 |
| #166 | `dbd443a` | Non-production recipient allowlist (capture by default) + one email per Space invite |
| #168 | `a8c6cd3` | Comms A-1: unified catalog (58 entries) + read APIs |
| #170 | `969ee0b` | Comms A-2a: delivery ledger, send recording, `GET /delivery`, 90-day retention |
| #172 | `86a0e98` | ETH: inline sync resumes from the checkpoint under a deadline; reaper for stuck RefreshExecution rows; honest status |
| #173 | `91db5c9` | P1: revalue existing snapshot rows when a holder gains history or prices |
| #177 | `64fa2e3` | Comms A-2b: security alerts can't be muted + identifiers hashed; connection email independent of in-app; 5 emails/hour storm limit |
| #178 | `ff6176e` | ETH fast path: indexed transfers + reconciliation. Flag `ETH_HISTORY_FAST_PATH` defaults ON. |
| #180 | `690f521` | Comms contract v1.1 delta |
| #181 | `34ff238` | New notifications; digest OFF |
| #183 | `eec9b3f` | Pending-revaluation stamp (status only, reversible), round-robin, estimator fix |
| #184 | `685bb9e` | Comms B1: template versions (publish/rollback need CONTROL), render, AI-assisted authoring |
| #185 | `bbc91df` | Revaluation perf: plan once per pass, batched planning, cross-holder credit |
| #187 | `d1b9e65` | Comms B2: automations engine. Activation gate is **OFF in code**. |

**Claude 2:** #159, #161, #162, #167, #169, #171, #174, #175, #176, #179, #182 and #186. SHAs and details are in their handoff §2.

**Review process.** Every Claude 1 code PR had an independent adversarial review, with mutation testing, before merge. Blocks were fixed and re-reviewed; there were 0 merges over an open P0 or P1. Develop CI and Trusted deployment health were green after each merge. Where a per-merge CI run was cancelled by the next push, the next green develop run covers it.

## 3. Preview migrations (serial and coordinated, each with a verified backup)

| # | Migration | Owner | Result |
|---|---|---|---|
| 1 | `20261031120000_beta_request_risk_review` | C2 | PASS |
| 2 | `20261031130000_policy_group_lifecycle` | C2 | PASS (1st backup check raced app traffic; retry clean) |
| 3 | `20261031200000_comms_delivery_ledger` | C1 | PASS: backup verified on 60 tables; RLS enable+force |
| 4 | `20261031210000_comms_template_versions` | C1 | PASS (1st backup check raced a single RateLimit row; retry clean). Versions are immutable. |
| 5 | `20261031220000_comms_automations` | C1 | PASS (same race; retry clean, 62 tables verified) |

For every migration: `migrate status` reported up to date; new tables have RLS enable+force; grants are limited to `fm_system`/`fm_backup`; the backup check was never bypassed. Migrations were applied from a worktree with its own install. A shared `node_modules` Prisma client regenerated by other worktrees caused one mid-run failure; the remedy is in §7.

## 4. Security and billing evidence

- **Email.** Preview delivers only to `EMAIL_NONPROD_ALLOWLIST`, which holds the owner's address; everything else is captured. A guard sits at the single send chokepoint and is tested so the provider can't be reached by any other path. Link and ad-copy filters were hardened against 28 bypass forms.
- **Comms Center.**
  - The six approved decisions are implemented: CONTROL to activate, security alerts can't be muted with identifiers hashed, 90-day retention, no open or click tracking, 5 emails/hour (security exempt), and webhook delivery planned for Phase C.
  - Publish and activate need fresh CONTROL plus a reason, audited in the same transaction.
  - The owner-approval gate requires a System Admin approval bound to the exact version.
- **AI authoring.** The model receives template text only, never customer data. Output is validated server-side. It honours the global Cost Freeze (`readGlobalCostFreeze`).
- **Cost Freeze (Claude 2).** Two independent traces covered all 22 Plaid call sites and every vendor host: zero paid calls when frozen or unknown, and blocked jobs report SKIPPED. Revaluation under freeze only stamps status in the DB and makes no paid calls (Claude 2's three conditions are verified).
- **Live paid-provider usage.** All revaluation passes made zero paid calls. The ETH completion used 67 Alchemy calls.

## 5. Production changes: verification and rollback status

- **REVOKE CREATE ON SCHEMA public (A+B):** executed about 05:50Z under owner approval. Verified: ACL `=U`; CREATE only for postgres and supabase_admin; health 200 with db ok; signed-in page OK. **No rollback needed.**
- **`fm_diag_ro`:** created, used read-only with masked output, and **dropped**. Verified 0 roles, 0 policies, 0 sessions; ACL unchanged. This was approved separately by the owner in Claude 2's session; the overnight directive did not cover it.
- Findings from that run: 20 PENDING beta requests, of which 13 form one probable single-actor cluster and about 7 look plausibly genuine. **No invitations were sent.**
- Nothing else touched Production: no deploys, no migrations, no data changes.

## 6. Preview credential finding (directive §4)

**Confirmed.** The exposed `postgres` owner-role password, in the canonical `tmp/rls-preview-cutover/preview.env`, still authenticates. Vercel Preview `DATABASE_URL`/`DIRECT_URL` were last changed 137 days ago, so the rotation that was done did not cover this role. There is exactly one copy on disk.

**Containment was attempted and refused.** Supabase rejects `ALTER ROLE postgres` with "Only superusers can alter privileged roles". Nothing changed. Doing it through the browser would put the new secret into the session transcript, the same exposure as the original leak, so I did not do that.

**Owner steps (about 2 minutes):**
1. In the Supabase dashboard, open project `lqagrryecvhbaqvczjgc` → Settings → Database → Reset database password.
2. Paste the new password **only** into `tmp/rls-preview-cutover/preview.env`, in both URLs.
3. Tell Claude 1. Claude 1 then updates Vercel Preview `DATABASE_URL`/`DIRECT_URL` from the file without printing it, redeploys Preview and terminates old `postgres` sessions, and Claude 2 verifies health and the signed-in pages.

The deployed Preview app uses this role through `DATABASE_URL`, so Preview is down for a few minutes between steps 1 and 3.

## 7. Blockers and follow-ups

**Genuine blockers:** only §6.

**Follow-ups (Claude 1), in progress or queued:**
1. **B2 hardening PR** (in progress). It covers Claude 2's review items A1–A9: idempotent provider send and recovery, in-pass frequency caps, eligibility checked at send, a maintenance/admission guard, overlap with existing EV-1 notices, TEST/LIVE separation, and purge/retention for automation rows, plus nits N1–N11. The activation switch stays OFF; flipping it needs a separate owner-approved PR.
2. **Phase C:** Resend webhook with svix signature verification, and delivered-vs-accepted reconciliation.
3. **B1 contract follow-ups from Claude 2:** export `CODE_DEFAULT_VERSION_ID`, block limits, and split `canRollback`.
4. **Revaluation throughput.** Profile the fixed cost per rebuild call (about 115 s from the laptop). Measure on Vercel. Investigate one `E25P03` idle-in-transaction timeout during planning. Strengthen two test fixtures (#185 nits).
5. **Live timing for ETH fast path:** not yet measured on Preview for a fresh wallet.
6. **Shared `node_modules`.** About 30 worktrees share one Prisma client. Rule agreed: regenerate only from a develop-current worktree and announce it first. Live harness and migration worktrees now have their own installs.
7. **Welcome email preview:** it was held by the storm limiter locally (fail-closed with no ledger DB), so it was never sent to the owner. The rendered file was kept.

## 8. Owner decisions needed

1. **Preview credential reset** (§6).
2. **Beta requests:** what to do with the 13-request single-actor cluster versus the ~7 plausible ones. No invitations have been sent.
3. **Separation of duties for automations:** today one System Admin can both approve and activate via break-glass.
4. **Post-deploy smoke:** add a Vercel Deployment Protection bypass secret so Preview smoke can actually reach the app.
5. **Production promotion:** all of tonight's work is on Preview only. A release needs separate approval. Migrations 1–5 must precede the code that depends on them.

**Defaults taken, reported for awareness** (say so to change any):
- O-17: lifecycle suppression of AWARENESS applies to email and automation sends only.
- O-18: owner approval comes from the System Admin role.
- AI authoring caps: $2 and 40 calls per operator per day.
- Wallet-failure email is opt-in; in-app is on by default.
- The welcome email is SERVICE class (not preference-suppressible; counts toward the storm limit).

## 9. Next priorities

1. Land the B2 hardening PR. Then decide, as the owner, on flipping activation and on the first automation to approve.
2. Phase C, the Resend delivery webhook.
3. Measure revaluation and the ETH fast path on deployed Preview.
4. The owner's credential reset (§6).
5. Plan the Production promotion: migrations first, then a release with explicit approval.
