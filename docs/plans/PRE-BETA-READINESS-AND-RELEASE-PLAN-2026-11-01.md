# Fourth Meridian: final pre-beta readiness and Production release plan (2026-11-01)

> **Owner:** Session 1 · **Status:** ACTIVE · **Updated:** 2026-11-03 · **PRs:** #206–#219, #223

**Authors.** Session 1 (coordinator) and Session 2. Each session independently cross-reviewed the other's conclusions, and the disagreements are reconciled in §8.

**Scope.** This document answers two owner directives of 2026-11-01:
1. the final pre-beta readiness audit;
2. the request to plan Production promotion.

**Status.** Read-only throughout. Nothing was merged, deployed or migrated in Production. No Production data, settings or secrets were changed, no invitations were sent, and Turnstile was not activated.

**Evidence sources.**
- Session 1 sections: Appendices A–C.
- Session 2 sections: [PRE-BETA-READINESS-SESSION2-2026-11-01.md](PRE-BETA-READINESS-SESSION2-2026-11-01.md), with read-only Production SQL Q1–Q4 in its §9.

---

## 0. Executive summary

**Verdict: CONDITIONAL GO.** The recommendation is an **invitation-only cohort of 10 users the owner picks personally**, opened after release batch **B4/5** reaches Production, then **scaling to 25** once the Cost Freeze, the kill-switch fix and the support link are live. **Opening the public request-access intake is NO-GO** until the fail-closed Turnstile work ships and is validated.

**What Production runs today.**
- Production is `main` **4dda8dc**: v2.7 from 10-27 plus the 10-30 marketing site.
- It is **418 commits and 9 migrations behind develop**. None of the 10-28 to 11-01 work runs in Production. That includes Connections 2.0, crypto history and valuation honesty, the new invitation path, branded email, the Comms Center, Cost Freeze and the risk review.
- Production is healthy: `/api/health` ok, db ok, crons dispatching. Every env var it requires is present.

**Bot signups.**
- 13 of the 20 pending Production beta requests came from **one automated actor**.
- As of the last live read (10-31), **none were approved, invited or redeemed**.
- **Turnstile is not configured anywhere and fails open on every ref**, including open PR #160 when its secret is missing.
- **No account can be created by a bot**, because registration is invite-only and there is no OAuth sign-up. The exposure is waitlist spam, plus the risk that an operator approves a bot.

**P0 blockers (both are conditions, not code defects).**
1. **The Production `registration_mode` must not be `open`.** Code defaults to invite-only, but the live row has not been read. The owner runs Q2.
2. **No wallet users holding ERC-20 or SPL tokens until B3 is in Production.** Production's `main` leaves tokens out of wallet values silently, which breaks the owner's 10-30 valuation ruling. The alternative is native BTC/ETH/SOL only, with a "tokens not included" disclosure.

**Release plan.**
- 7 batches, each a tested develop SHA cut point with no cherry-picks: B1, B2, B3, B4/5 (combined), B6, B7, B8. Fixes for the beta (P1) land on develop now and ride a final **B9**.
- **Batch 1** (`296516c`) is independently reviewed and ready for owner approval (§4).

**What the owner needs to do (§9).**
- Run the 4 read-only SQL queries.
- Rule on about 10 decisions.
- Approve each batch.

---

## 1. Readiness by area

Each area is assessed twice: **Code** = develop at 0f59435; **Production** = main at 4dda8dc as configured.

| # | Area | Code (develop) | Production (main) | Owner | Detail |
|---|---|---|---|---|---|
| P1 | Bot signups / CAPTCHA | BLOCKED for public intake (Turnstile fails open; #160 open and incomplete) | **BLOCKED for public intake**; READY WITH ACCEPTED LIMITATION for a curated cohort | S2 | S2 §P1 |
| 1a | Registration policy and intake | READY WITH ACCEPTED LIMITATION | VERIFIED READY in code (invite-only default); **live row NOT YET VERIFIED** (Q2) | S2 | S2 §1 |
| 1b | Invitation lifecycle | READY WITH ACCEPTED LIMITATION (new path never run on Preview; BETA_NOT_ACCEPTING gate not wired) | **BLOCKED**: the legacy issuance code has defects E-1..E-4 (14-day mismatch, unconditional writes). **Hold all approvals until B4/5** | S1 | App. B §1b |
| 2 | Auth, authorization, 2FA, RLS | READY | READY WITH ACCEPTED LIMITATION if the owner is the sole operator. Limitations: no operator 2FA; System Admin bypass ignores DISABLE_SYSTEM_ADMIN until B2. Live grants NOT YET VERIFIED (Q3) | S2 | S2 §2, §(b) |
| 3 | Financial correctness and coverage honesty | READY WITH ACCEPTED LIMITATION | **NOT YET VERIFIED.** The cash fix and FIN-001/002 are live; crypto valuation honesty is missing (P0 condition 2); the 16-row Amex label repair has not been run | S1 | App. A §3 |
| 4 | Plaid, Alchemy, pricing, history sync | NOT YET VERIFIED (workers never run on Vercel; revaluation throughput FAIL from the laptop) | NOT YET VERIFIED. The ETH unbounded-walk bug is present on main; Production Plaid health was not observable | S1 | App. A §4 |
| 5 | Provider limits, budgets, Cost Freeze | READY | READY WITH ACCEPTED LIMITATION for 10–25 users: AI is capped and fails closed; **no global Cost Freeze until B4/5** | S2 | S2 §5 |
| 6 | Comms Center and transactional email | READY WITH ACCEPTED LIMITATION (Preview E2E and webhook proven; automation emails are capped duplicates) | READY WITH ACCEPTED LIMITATION (legacy plain-text emails); the Comms Center is absent until B6–B8 | S1 | App. B §6 |
| 7 | Customer Support / Success ops | READY | READY WITH ACCEPTED LIMITATION. **No in-app support link** (P1). Production purge NOT YET VERIFIED (Q4) | S2 | S2 §7 |
| 8 | Monitoring, backups, recovery, deletion | READY WITH ACCEPTED LIMITATION | **BLOCKED on backup and recovery evidence**: no recorded Production restore and PITR unknown. Monitoring is READY WITH ACCEPTED LIMITATION (no external heartbeat) | S1 | App. B §8 |
| 9 | Production config and deploy readiness | n/a | Today's Production: READY WITH ACCEPTED LIMITATION. Promotion: NOT YET VERIFIED (Production migration ledger unread; salts unset) | S1 | App. C |
| 10 | Privacy, legal, claims | READY WITH ACCEPTED LIMITATION | READY WITH ACCEPTED LIMITATION. **The AI and the app's public metadata say "wealth management platform"** (P1) | S2 | S2 §10 |
| a | Analytics | first-party event layer exists | same | S2 | S2 §(a), §6 below |

---

## 2. P0 / P1 / P2

### P0: prevents opening the beta. Both are conditions the owner controls.
1. **`registration_mode` is not `open`** in Production. Verify with Q2. If it is `open`, set it to `invite_only` before anything else, because CAPTCHA is absent.
2. **No token-holding wallet users before B3.** Otherwise disclose "native coins only; tokens not included".

### Release preconditions (they gate promotion, not the beta)
- **R1.** The owner runs Q3 and Q4. The ledger should read 135 applied, 0 failed, and match main's newest migration.
- **R2.** A verified Production backup exists before each migrating batch: the owner records the Supabase backup time and PITR status, and a `db:backup` dump is taken and verified. **The dump contains customer financial data.** Its location must be named (encrypted volume, outside any repo), along with who holds it, its sha256, and when it will be deleted (Session 2 condition C2).
- **R3.** Production approvals stay on hold through B1–B3 (C4).

### P1: acceptable for a small controlled beta, but must be fixed or accepted

| # | Item | Fix path |
|---|---|---|
| 1 | Turnstile not configured; it fails open even in #160 | develop PR: rebase #160, fail closed on a missing secret, check hostname and action, render the risk badge. Owner creates the keys and validates on Preview. **Required before any public intake** |
| 2 | Don't approve the 13-request cluster; main shows no risk cue | Owner hold or deny |
| 3 | No global Cost Freeze in Production | B4/5 |
| 4 | System Admin bypass ignores DISABLE_SYSTEM_ADMIN | B2 |
| 5 | No platform-operator 2FA | Accepted while the owner is the only operator |
| 6 | AI and public metadata say "wealth management platform" | develop copy PR after the owner approves the wording; rides B9 (or a hotfix, decision D7) |
| 7 | No in-app support link; Plaid errors say "Contact support." with no address | small develop PR; B9 |
| 8 | BETA_NOT_ACCEPTING gate not wired into issuance | develop PR; until then, the operator rule is "no invitations while the beta is paused" |
| 9 | Production backup/restore unrehearsed; PITR unknown | Owner: PITR decision plus one timed restore rehearsal |
| 10 | No external uptime/heartbeat monitor | Owner chooses a provider (for example, a free uptime ping on `/api/health`) |
| 11 | ETH unbounded inline walk on main | B6 (#172) |
| 12 | Revaluation throughput unmeasured on Vercel; 84% of a year unasserted on the QA Space | Measure after B3/B6. It is honest (shown as "unavailable"), but history is sparse |
| 13 | B3/B6 re-stamp existing valuations ($0 becomes "unavailable"); an app rollback doesn't undo this | Tell users with B3 |
| 14 | B7 turns on event-driven customer emails (welcome, wallet failure, Plaid re-login, platform access) with no environment kill switch | Owner approval at B7 |
| 15 | `WALLET_TOKEN_CAPTURE_ENABLED` defaults ON from B1 | Set `false` in Production for B1; revisit at B3 |
| 16 | Production salts unset (`SECURITY_IDENTIFIER_HASH_SALT`, `COMMS_RECIPIENT_HASH_SALT`) | Set before B6 |
| 17 | 16 Amex rows mislabeled as debt payment (totals are correct) | Owner approves the scripted repair (dry run `--expect=16`) |
| 18 | Live Production figures not reconciled after v2.7 | Owner spot-check of their own Space after B1 |

### P2: safely deferred
- Ordinary rate limits let traffic through when the store errors.
- 12 customer routes on the RLS-bypassing client (SEC-003 ratchet). SEC-005 user search.
- 150 s stale-session grace during a DB outage.
- Legal gaps: cookies, state rights, governing law, named providers.
- `LOGIN_FAILED` stores the raw identifier (fix with the analytics PR).
- support@ is both the sender and the inbox. DMARC `p=none` with no `rua`.
- Resend webhooks are account-wide, so Production events land on Preview as UNMATCHED. The Vercel bypass token is embedded in the Preview webhook URL.
- Preview `RESEND_API_KEY` is not branch-scoped.
- Plaintext Preview dumps on the laptop.
- No email-failure alert. Sentry ingestion unproven.
- `debtSubtype` NULL, so Credit/Loans are withheld. FIN-004/5/6/8/10.
- Token-exclusion writer. CoinGecko Demo window: history before 2025-10-28 is unpriced.
- The automations engine has no non-duplicate trigger yet.
- The `lastDispatchAt` gap (2.4 h). WAF managed rules off.

---

## 3. Production release batches

**Method.** Each batch is a first-parent develop merge SHA (cut points are valid from `296516c` onward). Each batch's tree is exactly what CI and Preview ran. **No cherry-picks**, which keeps main a subset of develop. Promotion is a `release/batch-N` branch at the SHA, then a PR to main with a merge commit.

| Batch | Cut SHA | Contents | Migrations (in order) | Production env before | Customer-visible effect | Held OFF by |
|---|---|---|---|---|---|---|
| **B1** | `296516c` | #83, #89–#121, #123–#127, #130 (#122 ships in B3): Connections 2.0, crypto-history workers, Platform overview, Growth rename | 1 growth_rename (platform Space name only), 2 connection_history_checkpoint | `WALLET_TOKEN_CAPTURE_ENABLED=false`; leave all `*_BACKFILL_ENABLED` unset | New Connections UI | Backfills (env unset); registration (`invite_only`) |
| **B2** | `3849ab6` | #131–#142: Platform Ops 2.0, **kill-switch fix**, policy editor | 3 policy_group_editor (seeds one built-in row) | Leave `POLICY_ASSIGNMENT_FAIL_CLOSED` and `OPERATOR_TOTP_ENFORCEMENT` unset | Operator-only | Fail-closed dormant (env unset) |
| **B3** | `9281ad5` | #122, #143–#156: single valuation model, ERC-20 history, Platform Spaces 2.0 | none | Leave `ERC20_HISTORY_ENABLED` unset | **Valuations re-stamped** (unpriced days become "unavailable"); tokens honest. **Lifts P0 condition 2** | Token history (env unset) |
| **B4/5** | `bc2e8ae` | #157–#169: branded email, **new invitation path**, bulk approve, recipient guard, **risk review, lifecycle, Cost Freeze** | 4 beta_request_risk_review, 5 policy_group_lifecycle | none | Branded emails; invite emails are correct | Invitations need an operator click; freeze inactive until set |
| **B6** | `ff6176e` | #159, #170–#178: delivery ledger, CS comms UI, **revaluation**, **ETH fix + fast path** | 6 comms_delivery_ledger | **`SECURITY_IDENTIFIER_HASH_SALT`, `COMMS_RECIPIENT_HASH_SALT`** | Further valuation corrections | — |
| **B7** | `ec54c25` | #179–#188: 4 new notifications, content editor, automations engine | 7 comms_template_versions, 8 comms_automations | none | **New event-driven customer emails** (owner approval) | Automations: Production-false constant; digest not built |
| **B8** | `0f59435` | #190–#200: Resend webhook, Preview-only activation | 9 comms_provider_events | `RESEND_WEBHOOK_SECRET` + Production Resend webhook (optional) | none | Activation requires `VERCEL_ENV==="preview"` |
| **B9** | develop tip after fixes | P1 fixes: AI copy, support link, Turnstile fail-closed (#160 rework), BETA_NOT_ACCEPTING gate (#201), analytics events | none expected | **HARD PRECONDITION:** both Turnstile keys set in Production and validated on Preview, plus `NEXT_PUBLIC_SITE_URL` or `TURNSTILE_ALLOWED_HOSTNAMES` covering `fourthmeridian.com` (and `www.` if served). Without the keys, fail-closed CAPTCHA returns **503 on `/api/auth/register`, so invited users cannot register**. Without the apex host, every intake is rejected | Copy and support link; intake hardening | — |

**Ordering rationale.**
- B2 and B4/5 put the two missing controls (the kill switch and the Cost Freeze) into Production early.
- **B4 and B5 are combined** because #163's bulk approve merged before #161's risk data (Session 2 objection 1).
- B6 needs the salts.
- B7 needs B5 (Cost Freeze) and B6 (salts).

**Standard sequence for each batch.** Full detail is in Appendix C.
1. Freeze the SHA and confirm CI and Trusted health are green.
2. Prove the merge tree equals the SHA's tree.
3. Run Q3 and confirm the ledger count.
4. Take and verify a backup (R2).
5. In a clean worktree at the SHA: `migrate status`, then `npm run db:migrate:safe` with the owner-supplied postgres-role DIRECT_URL, then `migrate status` again.
6. Set the env vars.
7. Promotion PR with a merge commit.
8. Vercel builds and aliases.
9. Smoke test: health; Trusted health; 0 5xx for 30 min; owner sign-in with TOTP. Never open `/dashboard/brief` on Production.
10. Confirm the OFF flags in job summaries.
11. Update STATUS and the release doc.

**Rollback (every batch).**
- App: Vercel instant rollback to the previous batch's Production deployment.
- DB: **forward-only**. Every pending migration is additive and old-client compatible, so the schema stays.
- Migration 1 has documented reverse SQL.
- **The runtime re-stamps in B3/B6 are not undone by an app rollback.** A backup restore is reserved for corruption.

**Incident response.**
1. Pause AI (the AI kill switch, Production today).
2. From B4/5, set the global Cost Freeze. Before B4/5, the only lever is plan entitlements or a rollback.
3. From B2, use `DISABLE_SYSTEM_ADMIN` for a suspected admin compromise.
4. Vercel rollback.
5. `maintenance_mode` platform setting.
6. Notify the cohort through support@.
7. Record it in the incident runbooks (`docs/operations/runbooks/`).

---

## 4. Batch 1 for owner approval

Session 2 independently reviewed it: **APPROVE FOR OWNER DECISION, with conditions C1–C4.**

**What it is**
- **SHA:** `296516c4505db5aad490f8be3126ae034f7f2aa8`, on develop's first-parent history. main 4dda8dc is an ancestor.
- **Gates on this SHA:** CI `test` + audits + drift guard success; Trusted health success.
- **Tree:** `git merge-tree --write-tree origin/main 296516c` gives `560cd2ec…`, identical to the SHA's tree. 204 files changed.
- **Contents:** Connections 2.0, crypto-history workers (all held off by unset env), the Platform overview, and the Growth rename.

**Conditions**
- **C1.** Set `WALLET_TOKEN_CAPTURE_ENABLED=false` in Production first. Otherwise there is paid token capture before the Cost Freeze, and token values before the single valuation model.
- **C2.** The Production dump is stored encrypted, outside any repo, with a named holder, its sha256 and a deletion date.
- **C3.** The owner runs Q3 and Q4 first. Expect 135 applied, 0 failed.
- **C4.** No beta approvals on main's legacy code during or after B1.

**Migration plan**
- `20261027230000_platform_growth_rename`: a single UPDATE of the GROWTH_REVENUE platform Space name, only while it still has the seeded name. No customer data. Main never looks the name up, so it is safe under rollback.
- `20261028120000_connection_history_checkpoint`: a nullable column.

Commands, run in a clean worktree at the SHA under the shared heavy lock, with credentials exported and never echoed:
```
npx prisma migrate status    # expect 2 pending, 0 failed
npm run db:migrate:safe      # target-identity guard → verified db:backup → prisma migrate deploy
npx prisma migrate status    # expect up to date (137)
```
Then a read-only check (`psql -1` + `SET TRANSACTION READ ONLY`): the GROWTH_REVENUE Space name is `Growth`, and `Connection.historyCheckpoint` exists.

**Promotion.** Branch `release/batch-1` at the SHA, then a PR to main with a merge commit.

**Verification checklist**
- The deployment is READY and aliased to app.fourthmeridian.com.
- `/api/health` ok and db ok; Trusted health on main green.
- Vercel logs show 0 5xx for 30 min.
- The owner signs in with TOTP. Connections lifecycle and detail tabs render. Platform shows "Growth".
- The next dispatch shows `sol-history-backfill` as a disabled no-op.
- The `sync-crypto` summary shows token capture skipped.
- No backfill provider traffic. Alchemy and CoinGecko counters are within budget.
- `/dashboard/brief` is not opened.
- The owner spot-checks their own net worth and cash against the bank (P1-18).

**Rollback.** Vercel rollback to `dpl_GvqxKYoYfxwxS2VGhf5ddmd8zx3t` (4dda8dc); fallback `dpl_DySEgBLcpbzzRPYZQm1xaDrVWKdq` (v2.7). Leave the DB in place. The Migration 1 reverse SQL is optional.

---

## 5. Beta strategy

**Cohort**
- **Wave 1: 10 users the owner selects personally**, invited after B4/5. Native BTC/ETH/SOL wallets are fine after B3.
- **Wave 2: scale to 25** after B4/5 is in (the Cost Freeze), B2 is in (the kill switch), and B9 is in (support link and AI copy).
  - Under the no-hotfix-lane model, **B9 can only ship after B6, B7 and B8**.
  - B7 needs its own approval for event-driven customer emails (D9).
  - **So refusing B7 also blocks wave 2**, unless the owner chooses the hotfix lane (D7) for the B9 fixes.
- **Never** invite from the public queue without manual review. **Hold or deny the 13-request cluster.**

**Conditions for wave 1**
- The owner is the sole platform operator.
- Q1 and Q2 show healthy results.
- The AI-copy fix is either in, or accepted by the owner for the first week.
- Users are told up front that this is a beta, and where support is (support@).

---

## 6. Analytics (proposal; details in S2 §(a))

**What exists.** A first-party, server-side product-event layer (`lib/analytics/product-events.ts` writing to AuditLog):
- 5 events; IP and user agent are nulled; metadata keys are allowlisted; one row per user, action and day; 13-month retention;
- a Growth dashboard: 7-stage funnel, active and engaged users, W1 retention, AI cost per engaged user;
- AiInvocation records tokens, latency and outcome, with **no prompt or completion text**;
- Sentry runs with PII scrubbing;
- **no third-party analytics.**

**Proposed taxonomy.** 16 events covering onboarding, connections, activation, engagement, AI usage, errors and retention. Ten are derived from existing rows. Four are new server-side writers:
- `connection_link_started`;
- `connection_link_exited` {stage, errorCode enum};
- `first_sync_succeeded`;
- `ai_turn_failed` {reason enum}.

Data rules:
- properties are ids, enums, counts and durations only;
- **never** financial values, credentials, emails, institution names or AI text;
- no new table, no migration, no third-party SDK.

**Cost and requirements.**
- **Effort:** about 3–4 days.
- **Disclosure:** add a "Product usage" bullet to the privacy policy.
- **Fix with it:** hash the `LOGIN_FAILED` identifier.
- **Timing:** launch on the existing layer; the 4 new events are a fast-follow (B9 or B10).

---

## 7. Remaining Personal Space, AI and onboarding work

These are owner priorities, kept within beta scope; the full list is in the session record.

- **Onboarding (beta-critical).**
  - The current onboarding, Connections 2.0, branded verification and welcome emails, and invitation issuance are **on develop only**, so they arrive with B1 and B4/5.
  - The full register → verify email → first connection path has **never been run end to end** on a deployed environment. Do one Preview run before wave 1. S, beta-critical.
- **AI.**
  - Replace "wealth management platform" (owner wording). S.
  - **Latency: no streaming;** about 2 s of guidance labelling per turn; up to ~15 s of model time per turn. M–L. Recommended as the first post-batch engineering item.
  - HSA follow-up answers still state tax-rule language (advice boundary). S, owner.
  - Brief transfer-wording version bump. S, owner.
- **Personal Space.**
  - Empty states are wired only on Investments, and a new user sees empty perspectives. M, recommended before wave 1.
  - Connections UI nits: a queued history reads as a failure, ⋯ menu focus, Remove copy. S.
  - Donut and category colour mismatch. S.
  - Deployed-Preview check below 500 px. S.
- **Financial presentation.**
  - The 16-row Amex label repair. S, owner.
  - Revaluation throughput on Vercel. M.
  - The adjusted balance doesn't yet reach the restricted (HSA) tier or today's as-of rows. S.
  - Token-exclusion writer. M, owner.
  - CoinGecko and Alchemy plan decisions. Owner.

---

## 8. Cross-review and reconciliation

| Topic | Session 1 | Session 2 | Reconciled |
|---|---|---|---|
| Production account deletion | NOT YET VERIFIED (no purge evidence) | VERIFIED READY (dispatcher runs) | **READY WITH ACCEPTED LIMITATION; Production purge NOT YET VERIFIED (Q4)** (S2 accepted) |
| P0 | Silent token omission on main = P0 candidate | No P0 (conditional on Q2) | **Two P0 conditions: Q2 not `open`, and no token-holding wallet users before B3** (both agreed) |
| Batch 1 | Ready for approval | APPROVE with C1–C4 | **C1–C4 adopted** |
| B4 before B5 | Separate batches | Hazard: bulk approve without risk data | **Combined into B4/5** |
| Fixes made from now ship after B8 | — | Structural gap; hotfix lane or wait | **Recommend:** fixes land on develop now and ride B9 (decision D7: hotfix lane only for the AI copy if the owner won't accept it for week 1) |
| BETA_NOT_ACCEPTING gate | Flagged as not wired | Confirmed not wired | P1-8: develop PR, with an operator rule until it ships |
| Cost Freeze timing | B5 | Acceptable; don't combine B1–B5 | B4/5; B2 and B4/5 scheduled back to back |
| Production dump handling | P2 (Preview dumps) | P1 for a Production dump | **Release precondition R2 / C2** |

---

## 9. Owner decisions and approvals needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Run read-only SQL Q1–Q4** in the Supabase SQL editor (S2 §9), or approve a time-boxed read-only role | Run them (5 min); this closes 6 NOT YET VERIFIED items |
| D2 | The 13-request cluster, and the 20 pending requests | Deny or hold the 13; hold all 20 until B4/5 |
| D3 | **Approve Batch 1** (with C1–C4) | Approve |
| D4 | Production backups: PITR on or off; one timed restore rehearsal; RPO/RTO | Enable PITR if the plan allows; rehearse once before B4/5 |
| D5 | External uptime monitor and inbox monitoring (support@, security@) | Free uptime ping on `/api/health`; confirm someone reads support@ |
| D6 | Wording to replace "wealth management platform" | "a personal finance workspace; the decisions stay yours" |
| D7 | Hotfix lane (small PRs off main) or wait for B9 | **No hotfix lane**; accept the AI copy for week 1 if B9 is under a week out. Note: without a hotfix lane, wave 2 also depends on approving B7 (D9) |
| D8 | Token capture in Production (B1 OFF; revisit at B3) | OFF until B3 |
| D9 | Approve the B7 customer emails | Approve at B7 after a Preview content review |
| D10 | Turnstile keys, plus approval of the fail-closed #160 follow-up | Create the keys now; validate on Preview with B9. **The keys are a hard precondition for B9** (registration returns 503 without them). After B9, **unsetting the keys closes registration, login step-up and intake rather than opening them**; the incident runbook must say so |
| D11 | Amex 16-row repair | Approve the dry run, then apply |
| D12 | Analytics taxonomy and privacy disclosure | Approve |
| D13 | Confirm the owner is the sole platform operator for the beta | Required for wave 1 |
| D14 | Provider plans (Alchemy, CoinGecko Demo vs paid) | Decide before B3 |

## 10. Timeline (indicative; each step gated on owner approval)

| Day | Step |
|---|---|
| 0 | Owner: D1, D2, D3, D13. In parallel, Session 1/2 open the B9 develop PRs (AI copy after D6, support link, Turnstile fail-closed, BETA_NOT_ACCEPTING gate, `LOGIN_FAILED` hashing) |
| 1 | **B1** promote and verify |
| 2 | **B2** |
| 3 | **B3** (tokens become honest; tell users about re-stamped history) |
| 4 | **B4/5** (new invitations, Cost Freeze, risk review). **Wave 1: 10 invitations**, after one Preview end-to-end onboarding run |
| 5–6 | **B6** (salts first), **B7** (after D9), **B8** |
| ~7 | **B9** (fixes, plus Turnstile after Preview validation). **Wave 2: scale to 25**. Then the first post-release item: AI latency/streaming |

---

## Appendices (Session 1 evidence)

- **A**: Areas 3–4 (financial correctness; sync reliability)
- **B**: Areas 1b, 6, 8 (invitations; Comms and email; monitoring, backups, deletion)
- **C**: Area 9 (Production config, the 9 migrations, batches, release sequence, rollback)

Session 2's evidence is in [PRE-BETA-READINESS-SESSION2-2026-11-01.md](PRE-BETA-READINESS-SESSION2-2026-11-01.md).

**Correction to the appendices.** Where they say automations are "locked pending a hardening PR", that is stale. Activation shipped as Preview-only in #199 (Production is always off), and the Preview E2E passed 2026-10-31.


---

# Appendix A

## Areas 3 and 4: Financial correctness and coverage honesty; Plaid, Alchemy, pricing and history sync

Read-only throughout: no code, data, settings or deployments were changed. I read `origin/main` 4dda8dc and `origin/develop` 0f59435 directly from git, ran read-only queries against the Preview DB, and did not touch Production. I ran no tests and created no worktree, so all test evidence below is from CI. Develop's latest CI, Trusted deployment health and STATUS drift guard all passed on 0f59435. "Post-deploy smoke" fails on both branches with a 401 from Vercel's deployment protection, so it is not a usable gate.

**Baseline.** `main` is effectively v2.7 (6a1ed44, released 10-27). The 10-30 diff from 6a1ed44 to 4dda8dc is marketing-site files only. Every Connections 2.0 and crypto-history PR is on develop only: #91–#101, #122, #143, #144, #172, #173, #178, #183 and #185. None of them is an ancestor of main.

### Classification

| Area | develop (code) | Production (`main`) |
|---|---|---|
| 3. Financial correctness and coverage honesty | **READY WITH ACCEPTED LIMITATION** | **NOT YET VERIFIED** (banking fixes are live; crypto valuation honesty is missing on main) |
| 4. Plaid, Alchemy, pricing, history sync | **NOT YET VERIFIED** (workers have never run on Vercel; revaluation throughput fails) | **NOT YET VERIFIED** (no Production observation possible; known ETH bug on main) |

### Area 3: sub-items

| Item | develop | main / Prod | Evidence |
|---|---|---|---|
| P0 cash (reported cash exceeded accessible cash) | Fixed | **Fixed in code on main** | Owner-approved contract implemented in 257703a, PR #56 f84feac (an ancestor of 6a1ed44). Also #63 a8e61e9 and #64 0a62f59 (cutover marker). Production `NEXT_PUBLIC_ADJUSTED_CASH_BASIS_CUTOVER=2026-10-27` was set before the build (memory note on the release). Ledger cash exceeded the institution balance by the in-flight transfer amount plus holds; the adjusted basis corrects it (exact figures in the owner's private record). Tests: `lib/balances/adjusted-balance.test.ts`, `adjusted-basis.test.ts`. The doc `P0-CASH-ADJUSTED-BALANCE-CONTRACT` still says "PROPOSAL ONLY", which is out of date. **No post-release reconciliation of the live Production figures is documented.** |
| Amex `LOAN_PAYMENTS` transfers stored as DEBT_PAYMENT | Forward fix in place | Forward fix on main; **16-row historical repair NOT applied** | 4febb33 (the sync writes TRANSFER_AUTHORITY) and 7d94dee (repair script). Tests: `transfer-authority-sync.test.ts` (17), `repair-transfer-debt-payment.test.ts` (114), `.resync.test.ts` (25). The repair candidate set is 16 rows (`P1-PRODUCTION-REPAIR-CANDIDATES`; amounts in the owner's private record). Money totals are unaffected; filters, the category chip and stored labels are wrong. Release notes list "16-row repair" as excluded. |
| FIN-001 (one late paycheck drops all payroll under a complete label) | Resolved | On main | 07d59a8, b04e4f1 (both ancestors of main). Test: `lib/ai/forecast/income-completeness.test.ts`, `fin001-wiring.test.ts`. |
| FIN-002 (user correction can't change flowType on rows carrying a Plaid category) | Resolved for new corrections | On main | f51ed98, 33cb67f. The register says "pre-fix rows: owner decision", so rows corrected before the fix still carry the old economics. |
| FIN-003/007/009/011 | Resolved | On main | 66ed6bf, 5e59c89 and 7cad17e, db5ee8d, ff2480f |
| FIN-004/005/006/008/010 | Deferred or partial | Same | FIN-005 is only partial (dad72a6): restricted cash in liquidity history still doesn't match the hero figure. |
| Owner valuation-coverage ruling (balance ≠ price ≠ valuation; never $0) | Implemented (#122 6adf014, `planDayPersistence`, #173/#183/#185) | **Not on main** | Main has only the older V26-CRYPTO-STATUS-1 model, and `planDayPersistence` / membership guard are absent. Main has **no ERC-20/SPL holdings code at all**: no `alchemy_getTokenBalances` or `getTokenAccountsByOwner` call. A grep found no disclosure that tokens are excluded, so on Production wallet values are native-coin only and tokens are left out silently. |
| Understated-but-"supported" snapshot rows (P1) | Correct; throughput FAIL | Not on main | Preview QA Space (cmvrmtwtr…): 367 rows from 2025-10-28 to 2026-10-30. **0 rows with crypto = $0 and no status**. 58 `supported` (08-31 to 10-27), **307 `unavailable`** (2025-10-28 to 2026-08-30, stamped pending revaluation, crypto values kept), and 10-29 refused. So **84% of the year is not asserted** and is waiting on revaluation. |
| Liquidity access (HSA/restricted) | Present | On main (130946c v2.7-P3) | — |
| debtSubtype NULL ⇒ Debt Credit/Loans withheld | Unchanged | Same | Preview: **23 of 23** debt accounts have NULL `debtSubtype`; 12 have a `providerSubtype` (credit card ×4, mortgage, student, auto, home equity). No writer found. Figures are withheld rather than shown wrong. |

### Area 4: sub-items

| Item | develop | main / Prod | Evidence |
|---|---|---|---|
| ETH stuck: inline sync walked history with no limit and was killed at 300 s | Fixed (#172 86a0e98: checkpoint resume under a deadline, plus a reaper) | **Bug present on main** | `origin/main:lib/crypto/eth-history-sync.ts:167` runs a full rebuild with `args.deps` and no deadline. Main has no reaper and no Cost Freeze (`readGlobalCostFreeze` absent). |
| ETH fast path (#178 ff6176e, `ETH_HISTORY_FAST_PATH` default ON) | One live pass | Not on main | Preview ETH checkpoint: completed 2026-10-31T06:53Z, proven from 2017-10-16, 67 requests; ETH `PositionCoverage` is COMPLETE from 2017-10-16. **Timing on a fresh wallet has not been measured.** |
| #126 ETH early origin | Merged | Not on main | Call savings are estimated, not measured (closeout §3.2). Receive-only and CREATE2 addresses fall back to the full walk, and the endpoint-only pruning gap stays open. |
| BTC history | COMPLETE on Preview (esplora, from 2013-10-02) | Not on main | A second BTC wallet (cmvk0ipiu…, DIRECT mode) has **no `completedAtISO`**: still incomplete. |
| SOL history | COMPLETE on Preview (from 2022-03-26) | Not on main | #93, #99, #101. SPL and ERC-20 history are **flag-OFF** with no live run (closeout R4 not done). |
| Revaluation throughput | **FAIL** | n/a | Preview `sol-history-backfill` on 10-31: 36 runs over about 8.5 h, 54 chunks rebuilt, **1 holder revalued**. Run times 294–1,020 s against a 240 s budget; these are laptop/script runs, which exceed Vercel's 300 s limit. Last run: owed 3, deferred 3, revalued 0, yet `outcome: COMPLETE` with no PARTIAL reason, which looks like a reporting gap. One E25P03 timeout is still uninvestigated. **Never run on Vercel.** |
| RefreshExecution reaper | Code merged | Not on main | Preview has **2 ETH rows stuck RUNNING** (started 10-30 10:43 and 10-31 05:37, OPERATOR) and one `sync-crypto` JobRun "running" since 10-31 05:36. The reaper only runs inside dispatcher wakes, and Preview has no crons, so it has **never been exercised on a deployment**. |
| CoinGecko pricing | Demo tier | Same tier on main | Preview price archive: coingecko daily RAW_CLOSE for 3 instruments (BTC/ETH/SOL), from **2025-10-28** (the 365-day Demo window); ERC-20 prices are intraday only, from 10-28. Charts therefore start at the price floor, as the ruling requires. Demo is 10k calls/month and its storage terms are unconfirmed (owner decision). |
| Alchemy | PAYG; caps in code | — | Preview, last 10 days: about 3.9k each of eth_getBalance, eth_getCode and eth_getTransactionCount (mostly the 10-28 walk). Daily cap 12,000. The Alchemy plan is unverified (owner). |
| Plaid sync | Cost Freeze gates every Plaid call site (Session 2) | On main: v2.7 sync and transfer-authority writer; no Cost Freeze | Preview has sandbox/legacy Items only: 2 ACTIVE, 1 NEEDS_REAUTH (Wells Fargo, ITEM_LOGIN_REQUIRED since 06-27). One PLAID_ITEM run FAILED on 10-30 with PROVIDER_AUTH 400, 8 succeeded. **Production Plaid health was not observable.** |
| Coinbase via Plaid | Blocked at Plaid | Blocked | INSTITUTION_NO_LONGER_SUPPORTED is a Plaid-side block. A ticket is filed; there is no app workaround. |

### Unproven (explicitly)
- Production cash, net-worth and accessible figures after the v2.7 release. Only fixture tests and a render check exist.
- Whether the Net Worth chart on Preview shows the 307 `unavailable` days as partial or unavailable rather than as a lower complete total. No browser check was done in this audit.
- Revaluation and the ETH fast path on a deployed Vercel function: throughput, the 300 s limit, the E25P03 timeout.
- ERC-20 and SPL history against real providers (R4), the Platform Ops Resume click (R5), and the R6 mobile layout with token surfaces visible.
- Production Plaid webhook and sync health, and how the owner's 16 Amex rows look in Production today.
- Whether a single-actor pre-creation row is correct: Preview Space cmvjzohz…, row dated 10-21, crypto = $0 and net worth = $0, status NULL, written 12 s after a 4.6M BTC wallet was linked on 10-22. It is likely "no members yet" and so legitimate, but that is not verified.

### P0 (blocks beta)
1. **The Production crypto valuation-honesty gap.** On main, ERC-20/SPL holdings are left out of wallet values and no disclosure was found, which the 10-30 ruling forbids. Main also lacks #122/#173. Two ways to resolve it:
   - promote develop, applying the ~9 pending migrations first, in order, starting with `20261028120000_connection_history_checkpoint`; or
   - limit beta wallets to native BTC/ETH/SOL with an explicit "tokens not included" disclosure.

### P1 (acceptable for a small controlled beta)
- Revaluation throughput: 307 of 367 days are unasserted on the QA Space. This is honest but leaves the history mostly empty, and it has not been measured on Vercel.
- The ETH unbounded inline walk on Production. Each Run Now restarts a walk of roughly 3.2k calls. Cost per attempt is low, but status is misleading and large wallets never finish.
- Stuck RUNNING rows. The reaper is not on main and not exercised on Preview.
- The 16-row Amex historical repair has not been run. Labels and filters are wrong; money totals are right.
- No reconciliation of the live Production figures after release.
- One BTC wallet on Preview is still incomplete.
- The revaluation job reports `outcome: COMPLETE` while revaluation is deferred.

### P2 (defer)
- debtSubtype is NULL everywhere; Credit/Loans figures are withheld.
- FIN-004/005/006/008/010.
- FIN-002 rows corrected before the fix.
- ETH CREATE2 endpoint-pruning gap; the #120 SPL limits (750-day cap and others).
- Token-exclusion classification has no writer, so spam airdrops show as "partial".
- The status doc's "PROPOSAL ONLY" header and STATUS.md are stale.

### Owner decisions
1. Promotion scope and timing for the develop crypto stack, or restricting beta to bank accounts plus native coins with a disclosure.
2. Approval to run the Production Amex repair (dry run with `--expect=16`, then apply), and what to do about FIN-002 rows corrected before the fix.
3. Confirm the Alchemy plan and caps; choose CoinGecko Demo terms versus a paid tier (the paid tier extends valuation before 2025-10-28).
4. Production worker activation order (SOL → BTC → ETH → tokens) with `WEALTH_REGENERATION_ENABLED`, which depends on measuring revaluation on Vercel first.
5. Which sources may write the token-exclusion classification.
6. Coinbase: wait for Plaid, or fall back to direct read-only Coinbase API keys.

Key files:
- a local path (not committed) (its header is out of date)
- a local path (not committed)
- `docs/plans/CONNECTIONS-CRYPTO-HISTORY-CLOSEOUT-2026-10-30.md` and `docs/plans/OVERNIGHT-2026-10-31-CONSOLIDATED-REPORT.md` (on develop)
- a local path (not committed)

The only file I created is the read-only query helper a local scratchpad (not committed).

---

# Appendix B

# Final pre-beta readiness: Areas 1b, 6 and 8 (Session 1 audit)

**Scope.** Read-only audit as of 2026-11-01 ~00:15Z. Refs: `origin/main` 4dda8dc (Production) and `origin/develop` 0f59435 (Preview), 418 commits apart. Develop's CI workflow is green on 0f59435. Its "Post-deploy smoke" fails only because Vercel protection answers 401 to the probe, which is by design.

**Headline.** Develop's code for all three areas is substantially complete. Production has none of it:
- Production still runs the legacy invitation code with the P1 defects documented in the 10-31 lifecycle audit.
- Production has no comms ledger, webhook or automations.
- Production has no recorded restore rehearsal and no confirmed point-in-time recovery (PITR).

Promoting develop needs 9 migrations, including 4 comms tables, plus 2–3 Production env vars that are not set today.

---

## 1b. Invitation lifecycle

| | Classification |
|---|---|
| **develop** | READY WITH ACCEPTED LIMITATION. The code is complete and tested, but the new issuance path has never run on Preview, and the beta-lifecycle gate is missing. |
| **Production (main)** | BLOCKED. The legacy issuance code has the P1 defects E-1 to E-4 below. |

| Sub-item | develop | main | Evidence |
|---|---|---|---|
| One issuance path (approve, reissue, direct, extend) | Yes: pure planner plus I/O layer, conditional `updateMany`, audit in the same transaction | **No**: 3 copied routes; resend and direct invite write unconditionally | #158 e440aa3; `lib/platform/growth/invitation-issue{.core,}.ts`, lines 185–271. Audit doc §3.8 (E-3, E-4) |
| Validity setting (default 7 days, 1–30, audited, new invites only) | Yes: `beta_invitation_validity_days`, plus an audited Extend that never shortens | **No**: hard-coded `INVITE_TTL_MS = 14d` in approve and resend; the email always says "14 days" even for direct invites of 1–30 days (E-1, E-2) | main `approve/route.ts:37`, `resend/route.ts:32`, `beta-invite.ts:22` |
| Bulk approval | Yes: preview, confirm, expected-status (`STATUS_CHANGED`), partial counts | Absent | #163 bbfb2e0; `bulk-approve.test.ts` |
| Redemption | Validated by token hash, expiry and APPROVED status; bound to the email; consumed with a zero-count check that aborts registration | Same on both | `registration-policy.ts:64-150`, `register/route.ts:346` |
| Expiry at redemption | Checked only at validation, not in the consuming write. This is an accepted residual: `fm_auth` can only SELECT `(id, status)` | Same | `registration-policy.ts:132-139` |
| Audit | `recordOperatorAction` inside the transaction; email outcome audited after the send | Audit written after the send, outside any transaction (E-17) | invitation-issue.ts:195, :289 |
| Beta-lifecycle gate (`BETA_NOT_ACCEPTING`) | **Not wired.** `getBetaLifecycleState()` exists, but nothing in growth or issuance calls it (grep finds only its definition and a docs reference) | Absent | `lib/entitlements/beta-lifecycle.ts:35`; contract agreed with Session 2 |
| Observed on Preview | **Not exercised since #158 merged.** Preview has 4 BetaAccessRequest rows (2 REDEEMED, 1 DENIED, 1 APPROVED expiring 11-05). The newest BETA audit row is from 10-28. There is no validity setting row (the default is in force). | — | Preview DB, read-only |

**Unproven**
- The new approve, direct, reissue, extend and bulk paths have only unit-test evidence. None has run on deployed Preview.
- The expiry text the invite email renders for a non-default validity.
- How the Growth UI shows the validity control.

**Issues to fix or accept**
- **P1 (Production):** if the owner approves any of the 20 pending Production requests now, they go through main's legacy code (14-day mismatch, unconditional direct upsert and resend). The consolidated report §5 says no invites have been sent. Hold approvals until promotion, or accept the risk explicitly.
- **P1 (develop):** issuance does not refuse when the beta is PAUSED, ENDED or UNKNOWN, as agreed. Wire the gate before promotion.
- **P2:** a token validated just before a concurrent reissue can still redeem by id. The email binding mitigates this.

---

## 6. Communications Center and transactional emails

| | Classification |
|---|---|
| **develop** | READY WITH ACCEPTED LIMITATION. Preview E2E and the webhook are proven. Automations are a capped duplicate of emails the code already sends. |
| **Production (main)** | READY WITH ACCEPTED LIMITATION for the *legacy* transactional emails (plain text, no ledger, no delivery tracking). The Comms Center is NOT YET VERIFIED / not present. |

| Sub-item | develop | main | Evidence |
|---|---|---|---|
| Catalog and templates | Branded design system, all templates migrated, 58-entry catalog; welcome, platform-access and Plaid-reauth emails are new; digest is built but OFF | 10 plain-text templates, no HTML | #157 #164 #168 #181; `docs/plans/EMAIL-CATALOG-2026-10-31.md` |
| Send chokepoint and non-production guard | `decideRecipient`: Production always delivers; everywhere else only exact ASCII allowlist matches; empty allowlist fails closed | No guard | #166; `lib/email/recipient-guard.ts:95-115`. Vercel: `EMAIL_NONPROD_ALLOWLIST` on Preview only |
| Delivery ledger | `CommsDelivery`: hashed recipient, no bodies, 90-day rollup | None (`NotificationDelivery` only) | #170. Preview: 14 rows, all from the 10-31 E-2E run |
| Storm limit (5/h) | Ledger count; security and ceremony emails exempt and fail open; limited sends fail **closed** on a slow (>1.5 s) or unreadable count | None | `delivery/storm.ts`. Preview row `SUPPRESSED/FREQUENCY_CAP` observed |
| Resend webhook (svix signature) | LIVE on Preview: 3 `delivered` events with outcome APPLIED, latest 23:20Z; open/click events dropped | **None**: `GET /api/webhooks/resend` returns 404 on Production; no secret set | #194 #196 #198. Vercel: `RESEND_WEBHOOK_SECRET` on Preview/develop only |
| Automations | Engine, dry run, owner approval, kill switch and breaker checked before every send. Production is always off (requires `VERCEL_ENV=preview` and the flag). Preview test automation is DISABLED. | Absent | #187 #190 #193 #199. Preview: `AutomationDefinition` row DISABLED, 3 runs |
| Sender domain | SPF on `send.` covers amazonses (Resend); DKIM at `resend._domainkey` is present; **DMARC is `p=none` with no `rua`** | Same domain and Resend account | Public DNS (`dig`) |
| Env for promotion | Code warns, but runs, without `COMMS_RECIPIENT_HASH_SALT` | **Salt not set on Production**; `BETA_REQUESTS_EMAIL` unset on both, so the operator intake email is silently skipped | Vercel env metadata; `lib/env.ts:448-457` |

**Unproven**
- Any Production email send through the new pipeline.
- Production bounce and complaint handling.
- The storm limiter under Production latency.
- That the `support@` and `security@` inboxes are monitored.
- Any Production email send at all since 10-27 (there is no Production ledger to check).

**Issues to fix or accept**
- **P1 (Production promotion):** before or with the promotion, set `COMMS_RECIPIENT_HASH_SALT` on Production, create a Production Resend webhook and secret, and apply the 4 comms migrations ahead of the code. Without the salt, limited sends with no userId fail closed and purge cannot clear rows matched only by address hash.
- **P2:** Resend webhooks are account-wide, and Preview and Production share one account and one domain. Production send events will therefore be POSTed to the Preview endpoint and stored as UNMATCHED there (only the message id is stored). There have been 0 UNMATCHED rows so far.
- **P2:** the Preview webhook URL embeds the project's Vercel automation-bypass token. That token now lives in Resend's configuration and grants bypass to every Preview deployment.
- **P2:** `RESEND_API_KEY` on Preview has no branch scope. A Preview build of a pre-#166 branch (dependabot branches, v2.6) has no recipient guard and can send real email.
- **P2:** the finding that every engine trigger already emails via code still stands, so automation emails are always capped duplicates and have no product value yet.
- **P2:** DMARC is `p=none` and has no reporting address.
- **P2:** `BETA_REQUESTS_EMAIL` is unset (Session 2 owns intake).

---

## 8. Monitoring, backups, recovery and account deletion

| | Classification |
|---|---|
| **develop** | READY WITH ACCEPTED LIMITATION. Deletion and retention code are complete and census-tested. Neither job has ever run on Preview. |
| **Production (main)** | **BLOCKED** on backup and recovery evidence. Monitoring: READY WITH ACCEPTED LIMITATION. Deletion: NOT YET VERIFIED. |

| Sub-item | Status | Evidence |
|---|---|---|
| Production health and scheduler | 200 OK, db ok, `overdueJobs 0`, evaluator not overdue. However, `lastDispatchAt` was 2.4 h old and `lastAlertEvaluationAt` 3.9 h old at 00:11Z; the backstop cron is fresh | GET `app.fourthmeridian.com/api/health` |
| Alert rules | 9 rules on main, 10 on develop (adds `policy-assignment-invalid`). **No email-delivery-failure rule.** Destination is `PLATFORM_ALERTS_EMAIL`, set on Production and Preview | `lib/alerts/rules.ts` |
| External dead-man monitor on `/api/health` | **No evidence it exists.** The runbook assumes one | `docs/operations/runbooks/alerting-dead-evaluator.md:4`; gate G3 still open |
| Sentry | `NEXT_PUBLIC_SENTRY_DSN` set on Production and Preview; Production boot requires it. **Event delivery never verified** | Vercel env; `instrumentation.ts` |
| Production backups | One logical cutover dump (`prod-20261023T034601Z`, sha 7c9a01b3…), restored locally (doc 26 C1). A daily physical backup was observed 10-27 16:16Z. **PITR status unknown for Production** (Preview: Pro plan, 7 daily backups, PITR DISABLED as of 10-22). **The restore-rehearsal table in §6 of `backup-restore-verification.md` reads "_none yet_"**, so no RPO/RTO is recorded | doc 26 §C1; memory (prod release); remediation doc 11 G0c |
| Preview backups | `db:migrate:safe` dumps verified per migration on 10-31 (consolidated report §3). 8+ plaintext dumps sit in a local path (not committed) and 31 in `backups/`, so the local-dump policy (DB-007 §7) is unenforced | filesystem |
| Purge correctness | Census test fails the build on any unclassified user column. Comms ledger and automation rows are anonymised (`purge.ts:494-531`). `BetaAccessRequest` and its events are deleted by email | `purge-census.test.ts`, `purge.test.ts` (+73 lines on develop) |
| Deletion and retention jobs | `process-deletions`; retention runs inside `purge-trash` via `runDataRetention` (90-day comms, AI and JobRun rows; 180-day beta events). **Never run on Preview** (crons are off). One Preview account has been scheduled for deletion since 10-29 and was never purged | Preview `User.deletionScheduledAt`; JobRun has no rows for these jobs |
| Production deletion | Main's purge lacks the comms steps, but it does not need them because main has no comms tables. **No evidence that a Production purge has ever run** | no Production DB access |

**Unproven**
- A Production restore, and PITR.
- Sentry ingesting events.
- An external monitor firing.
- A Production purge end to end, including the account-deleted email.
- A retention run deleting real rows on Production.
- Whether anyone reads `support@`.

**Issues to fix or accept**
- **P1:** Production backup and recovery gate G0c is open. Confirm or decide on PITR, then record one timed Production restore rehearsal (RPO/RTO) in §6.
- **P1:** no external uptime or heartbeat monitor is evidenced. Alerting runs inside the cron it is supposed to watch.
- **P2:** no alert for email-send failures.
- **P2:** plaintext Preview dumps on the laptop.
- **P2:** Sentry delivery has not been proven.
- **P2:** purge and retention have only test evidence. Run `process-deletions?only=` once on Preview to clear the stale 10-29 deletion.

---

## Owner decisions
1. Hold Production beta approvals until develop is promoted, or explicitly accept the legacy 14-day and direct-upsert behaviour (the 20 pending requests).
2. Production PITR: enable it, or accept daily physical backups plus logical dumps, and set the RPO/RTO target.
3. A separate Resend account or domain for Preview, or accept that Production events reach Preview as UNMATCHED rows.
4. Rotate the Vercel bypass token embedded in the Preview Resend webhook, or accept it.
5. External monitor provider, and confirmation that `support@` and `security@` are monitored.
6. Tighten DMARC: add `rua`, then move to quarantine.
7. Whether automations have any purpose given the duplication, or should stay dormant.
8. Promotion package: the 9 migrations first, a fresh backup, then `COMMS_RECIPIENT_HASH_SALT`, a Production `RESEND_WEBHOOK_SECRET` and webhook, and optionally `BETA_REQUESTS_EMAIL`.

---

# Appendix C

# Area 9: Production configuration and deployment readiness, with release batches

**Verdict: NOT YET VERIFIED.** No P0 found.

- **Production as it runs today (v2.7, main `4dda8dc`):** READY WITH ACCEPTED LIMITATION. It is healthy, and every env var the code requires is present. CAPTCHA is not configured, so the public request-access and register endpoints run without it (fail open).
- **Promoting develop (`0f59435`):** NOT YET VERIFIED. Production's applied-migration count has not been read. Later batches need env vars that aren't set yet. Several runtime behaviours that customers will see need owner rulings first.

Everything here was read-only: git, the `gh` API, Vercel API GETs (names only, no values), public Production GETs, and one Preview read-only query.

## Evidence

| # | Item | Finding | State |
|---|---|---|---|
| 1 | main↔develop gap | Merge-base = main `4dda8dc`. develop is 418 commits ahead, made of 109 first-parent PR merges (#83–#200). main has 0 commits develop lacks. | VERIFIED |
| 1b | Pending migrations | 9 migration dirs on develop only (main 135, develop 144). On Preview all 144 are applied, 0 unfinished (read-only `_prisma_migrations`). | VERIFIED (Preview) |
| 1c | Production migration ledger | Expected 135 applied, 0 failed. Not read: no Production DB access. | **NOT YET VERIFIED** |
| 2 | Required env vars (develop code) | `validateEnv` refuses to boot without DATABASE_URL, NEXTAUTH_SECRET, ENCRYPTION_KEY, plus Production-only NEXTAUTH_URL, NEXT_PUBLIC_APP_URL, RESEND_API_KEY, CRON_SECRET, NEXT_PUBLIC_SENTRY_DSN, PLATFORM_ALERTS_EMAIL. **All present in Production.** PLAID_ENV is present (the boot check demands `production` when Plaid creds exist). | VERIFIED (names only) |
| 2b | Set on Preview, missing in Production | COMMS_RECIPIENT_HASH_SALT (warns only) · SECURITY_IDENTIFIER_HASH_SALT (**env report = fail in Production**; no throw, uses a salt derived from NEXTAUTH_SECRET) · RESEND_WEBHOOK_SECRET (unset ⇒ webhook inert, fails closed) · POLICY_ASSIGNMENT_FAIL_CLOSED (unset ⇒ dormant) · OPERATOR_TOTP_ENFORCEMENT (unset ⇒ not enforced; owner ruled Preview-only) · COMMS_AUTOMATIONS_PREVIEW_ENABLED (has no effect in Production by design) · EMAIL_NONPROD_ALLOWLIST (n/a in Production) · SOL_BACKFILL_* tuning. Production-only: AI_FORECAST_GUARD_MODE, NEXT_PUBLIC_ADJUSTED_CASH_BASIS_CUTOVER. | VERIFIED |
| 2c | Turnstile / CAPTCHA | **No TURNSTILE_* names in Production or Preview.** `lib/captcha.ts` returns true when there's no secret (fail open). No `challenges.cloudflare.com` script on the apex, apex `/request-access`, app `/request-access`, `/register` or `/login`. Same as main, not a regression. | VERIFIED: absent |
| 2d | Flags that default ON | `WALLET_TOKEN_CAPTURE_ENABLED !== "false"` (arrives with B1): calls Alchemy and CoinGecko and writes token PositionObservation rows. `ETH_HISTORY_FAST_PATH` default ON (B6). Every `*_BACKFILL_ENABLED`, `SPL_HISTORY_ENABLED` and `ERC20_HISTORY_ENABLED` is absent in Production, so those stay OFF. | VERIFIED (code) |
| 3 | Crons | `vercel.json` is identical on main and develop: `*/15` `/api/jobs/dispatch` and `*/5` `/api/jobs/resume-stale-imports`. Production crons have been enabled since 2026-10-23 14:14Z, bound to the current deployment. New jobs run inside the dispatcher: `sol-history-backfill` (B1, hourly :30, a no-op without SOL_BACKFILL_ENABLED; it writes a JobRun) and `comms-automations` (B7, hourly :00, sends nothing: no ACTIVE rows, and the resolver is false in Production). | VERIFIED |
| 3b | Paid-provider effects after promotion | Alchemy/CoinGecko from token capture (B1, inside the shared daily budget). CoinGecko from price-gap fill and revaluation (B3/B6). OpenAI comms suggestions (B7, operator-triggered only). No new Plaid calls. | VERIFIED (code) |
| 4 | Protection and firewall | App: SSO `all_except_custom_domains`, no password, firewall enabled with **0 custom rules** (the deny-all rule from cutover is gone), OWASP/bot/AI managed rules inactive. Site: same SSO; firewall config returns 404. | VERIFIED |
| 4b | Production health | `GET /api/health` → `status ok, db ok, overdueJobs 0, alertEvaluatorOverdue false`. `lastDispatchAt 21:45Z` was 2h25m old at 00:10Z (the backstop ran at 00:05Z). Apex returns 200. | VERIFIED; gap unexplained (P2) |
| 5 | Rulesets | main `25690163`: PR required, 0 reviews, checks `test` + `status-drift-guard`, no deletion, no force-push, RepositoryRole bypass. develop `25836806`: 4 checks. | VERIFIED |
| 5b | develop tip CI | `0f59435`: CI success, Trusted deployment health success. "Post-deploy smoke" fails with HTTP 401 from Deployment Protection (a known artifact; Trusted health is authoritative). Every batch cut-point below has `test` + `status-drift-guard` + audits = success. | VERIFIED |
| 6 | Rollback targets | Current Production app is `dpl_GvqxKYoYfxwxS2VGhf5ddmd8zx3t` (`4dda8dc`, READY 10-30 02:27Z, aliased to app.). Earlier: `dpl_DySEgBLc…` (`6a1ed44`, v2.7), `dpl_GKUMFmtb…` (`43768b5`), `dpl_Dq2joJaa…` (`ee95fed`, v2.6.0). All are rollback candidates. Site: `dpl_13jACDEA…` (`4dda8dc`); its previous READY site deployment is `dpl_5JHyp77j…` (`87e5ac8`), so site promotions have mostly been ignored builds. | VERIFIED |

## The 9 pending migrations (all old-client compatible: v2.7 code on main ignores them)

| Order | Migration | Introduced in | Class |
|---|---|---|---|
| 1 | `20261027230000_platform_growth_rename` | #83 | **DATA-CHANGING**: `UPDATE "Space"` on the GROWTH_REVENUE platform Space only, and only while it still has the seeded name. No customer data. Reverse SQL is documented in the file. |
| 2 | `20261028120000_connection_history_checkpoint` | #108 | Additive: a nullable TEXT column. |
| 3 | `20261030120000_policy_group_editor` | #141 | Additive (2 tables, RLS, grants) plus a seed `INSERT` of the built-in `BETA_FULL_ACCESS_V1` row into the new table. Customer rows untouched. Ran on Preview without `db:migrate:safe` (memory note). |
| 4 | `20261031120000_beta_request_risk_review` | #161 | Additive: an enum and a table. |
| 5 | `20261031130000_policy_group_lifecycle` | #162 | Additive: 3 enums, 4 columns with defaults, 1 table. |
| 6 | `20261031200000_comms_delivery_ledger` | #170 | Additive: 2 tables. |
| 7 | `20261031210000_comms_template_versions` | #184 | Additive: 3 tables plus a nullable column on CommsDelivery. |
| 8 | `20261031220000_comms_automations` | #187 | Additive: 3 tables, plus `mode` (NOT NULL DEFAULT 'LIVE') and a nullable FK column on CommsDelivery. |
| 9 | `20261031230000_comms_provider_events` | #194 | Additive: 1 table plus a nullable column. |

- Nothing destructive. The grants depend on the `fm_app`, `fm_auth`, `fm_system` and `fm_backup` roles, which main's migration `20261002000100` creates.
- Ordering: apply the migrations before the code, in timestamp order. Because each step is additive, the old code tolerates the new schema.
- `platform:seed-spaces` is **not required**: the registry diff is the Growth label only, which migration 1 covers. Running it is idempotent if wanted.

## Unproven
- The Production `_prisma_migrations` count and failed rows.
- Production `registration_mode` (code default `invite_only`) and `maintenance_mode`.
- Production values of WEALTH_REGENERATION_ENABLED, DISABLE_SYSTEM_ADMIN and RATE_LIMIT_ENABLED (names only were read).
- How recent Supabase backups are, and whether PITR exists.
- Whether `pg_dump` via `db:backup` can finish over the ~490 ms pooler.
- Live Preview acceptance R1–R6 for Connections 2.0 (STATUS says not done).
- Owner visual acceptance of Platform Ops 2.0 and Spaces 2.0.
- The cause of the `lastDispatchAt` gap.

## Findings
- **P0:** none.
- **P1-1:** Turnstile is absent in Production and Preview, so CAPTCHA fails open on `/api/access-request` and `/api/auth/register`. Memory records a 13-request single-UA cluster in Production. Owner act: create the keys and set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`. The public key is build-inlined, so it needs a redeploy.
- **P1-2:** `WALLET_TOKEN_CAPTURE_ENABLED` defaults ON from B1. That means new paid calls, new token holdings in customer totals, and new Instrument rows. Owner decision; set it to `false` in Production before B1 to keep it off.
- **P1-3:** B3 (#122) and B6 (#173/#183) re-stamp and revalue derived snapshot rows at runtime. Customers will see valuations change: unpriced days become "unavailable" instead of $0. An app rollback does not undo this.
- **P1-4:** B7 (#181) turns on event-driven customer emails in Production: welcome, wallet sync failure, platform access granted/removed, and Plaid re-login. No environment kill switch exists; the only per-send stop is the global Cost Freeze. Needs explicit owner approval.
- **P1-5:** Set `SECURITY_IDENTIFIER_HASH_SALT` (and `COMMS_RECIPIENT_HASH_SALT`) in Production before B6, otherwise the Production env report shows fail.
- **P1-6:** The Production migration ledger has not been verified; this is a precondition for every batch.
- **P2:** the `lastDispatchAt` gap; WAF managed rules all off; the Post-deploy smoke 401 noise on every run; backups over a high-RTT pooler; Preview's editor migration skipped `db:migrate:safe`.

## Owner decisions
1. Turnstile keys.
2. Token capture: ON or OFF.
3. Accepting the B3/B6 valuation changes.
4. The B7 customer emails.
5. Whether to run the Production Beta policy reconciliation (#140); until then fail-closed stays unset.
6. Confirm `OPERATOR_TOTP_ENFORCEMENT` stays Preview-only.
7. Approval for each batch, each migration (migration 1 is a data migration), and the backup method.

## Standard release sequence (every batch)
Sources: `docs/operations/database-safety.md`, `release-checklist.md` and `branching-and-protection.md`, plus memory notes prod-release-2026-10-26, develop-branch-migration and prod-schema-create-revoked.

0. Freeze the develop cut SHA. Confirm `test`, `status-drift-guard`, audits and Trusted health are green on it. Prove the PR tree equals the SHA's tree with `git merge-tree --write-tree origin/main <SHA>`.
1. Back up: record the time of the Supabase daily or physical backup (dashboard, owner), then `db:backup` (pg_dump of DIRECT_URL) as part of step 2.
2. Migrate, before any code: in a clean worktree at the cut SHA, `npm ci`, then with owner-supplied **postgres-role** `DATABASE_URL` = `DIRECT_URL` (session pooler :5432, not :6543) run `npx prisma migrate status`, then `npm run db:migrate:safe`, then `migrate status` again. Only postgres can CREATE on public after the 10-31 revoke.
3. Seeds: none required. Run `platform:seed-spaces` only if `lib/platform/policy.ts` sections changed.
4. Env vars for the batch (table below), set in Production scope before the build.
5. Promotion PR: push branch `release/batch-N` at the SHA, open a PR to main, merge with a **merge commit** (never squash, so main stays a subset of develop).
6. Vercel builds main and auto-aliases app.
7. Smoke: health; the Trusted health workflow; owner sign-in and TOTP; Vercel logs show 0 5xx for 30 min. Never open `/dashboard/brief`.
8. Crons are already on. Confirm the new dispatcher jobs report SKIPPED or no-op where expected.
9. Update STATUS.md and the release doc on develop.

**Rollback.**
- App: Vercel instant rollback to the previous Production deployment ID.
- DB: forward-only. Leave the additive schema in place, because main code ignores it.
- Migration 1 only, if wanted: `UPDATE "Space" SET name='Growth & Revenue' WHERE "platformArea"='GROWTH_REVENUE' AND name='Growth'`.
- Never drop tables or columns after new code has written to them. Restoring from backup is only for a corruption event.

## A. Release batches

Cut points are develop first-parent merge SHAs. That works only from `296516c` (#130 back-merge of main) onward: every earlier develop SHA lacks main's `4dda8dc`, so promoting it would create a tree nobody tested. **Recommendation: SHA cut points, no cherry-pick branches.** Each cut point's tree is exactly what CI and Preview ran. A cherry-pick branch produces an untested combination and breaks the main ⊂ develop relation the next promotion relies on.

| Batch | Cut SHA | PRs | Migrations | Production env before it | Data impact | Must stay OFF, and what keeps it off |
|---|---|---|---|---|---|---|
| **B1** | `296516c4505db5aad490f8be3126ae034f7f2aa8` | #83, #89–#121, #123–#127, #130 (Connections 2.0, crypto-history workers, Platform overview, Growth rename) | 1, 2 | Decide `WALLET_TOKEN_CAPTURE_ENABLED`. Leave every `*_BACKFILL_ENABLED` and `SPL_HISTORY_ENABLED` unset. | Platform Space name; nullable column; token rows if capture is ON | Backfills: their flags are unset. Registration: the `invite_only` setting. |
| B2 | `3849ab61d51b5896f32ec1bcdcd5c583fef88070` | #131–#142 (Platform Ops 2.0, kill switch, fail-closed, policy editor, reconciliation tool) | 3 | Leave POLICY_ASSIGNMENT_FAIL_CLOSED and OPERATOR_TOTP_ENFORCEMENT unset | Seed row in a new table; reconciliation only by an operator act | Fail-closed is dormant while its env var is unset |
| B3 | `9281ad55e574d942c29631799ea6cbf50b03e8b7` | #122, #143–#156 (ERC-20 history and the single valuation model; Platform Spaces 2.0) | none | Leave ERC20_HISTORY_ENABLED unset | **Runtime re-stamp of derived snapshot rows (P1-3)** | ERC-20/SPL history: flags unset |
| B4 | `dbd443ad146328b4a23f08aa6696134783294cc6` | #157, #158, #163–#166 (branded email, invitation issuance, bulk approval, non-production recipient guard) | none | none | Email visuals only | Beta invitations: there is **no code gate in Production**; nothing goes out unless an operator clicks Approve or Bulk-approve |
| B5 | `bc2e8aeb79184ba8e9df9cd70a73c02f6a6058a7` | #161, #162, #167–#169 (beta risk review, lifecycle evaluator, Cost Freeze) | 4, 5 | none | New columns with defaults (`costFrozen` false, lifecycle ACTIVE) | Freeze stays inactive until an operator sets it |
| B6 | `ff6176efe5450bb24c071a4ba97d299a0709064b` | #159, #170–#178 (delivery ledger, Customer Success comms UI, crypto revaluation, ETH fast path) | 6 | **SECURITY_IDENTIFIER_HASH_SALT, COMMS_RECIPIENT_HASH_SALT** | **Revaluation of derived rows (P1-3)**; ETH fast path ON | — |
| B7 | `ec54c25718bd8ca03befb8681cd26af9280f2b15` | #179–#188 (4 new notifications, content editor, automations engine) | 7, 8 | none | Ledger rows | Automations: no ACTIVE rows and the activation constant is false. **Customer emails go live (P1-4).** Digest: BUILD_OFF, and its producer `lib/notifications/digest.ts` doesn't exist. |
| B8 | `0f594357e62fc8743b8c2f7849f66c9c1762c339` | #190–#200 (Resend webhook, delivery phase C, activation that works only on Preview) | 9 | RESEND_WEBHOOK_SECRET (optional; unset ⇒ inert) | Provider-event rows | `automationActivationEnabled` requires `VERCEL_ENV==="preview"`, so it is false in Production |

**Verification for every batch:**
- `migrate status` up to date, with the expected count (B1: 137 · B2: 138 · B3/B4: 138 · B5: 140 · B6: 141 · B7: 143 · B8: 144).
- Health ok; Trusted health green; 0 5xx; owner sign-in works.
- Platform Ops env report: no fail.
- Batch features visible; OFF flags confirmed via job summaries or the Ops page.
- ApiUsageCounter for ALCHEMY and COINGECKO within budget.

**Rollback for every batch:** Vercel rollback to the previous batch's Production deployment, schema left in place. The B3/B6 runtime revaluation is not reversed by an app rollback; it would be regenerated by the previous code's regeneration or a backup restore.

## B. Batch 1 for owner approval
- **SHA:** `296516c4505db5aad490f8be3126ae034f7f2aa8`. CI `test`, audits and drift guard all success; Trusted health success. Merge-tree with main gives tree `560cd2ec…`, identical to the SHA's tree. 204 files changed vs main.
- **Before anything:** decide token capture (set `WALLET_TOKEN_CAPTURE_ENABLED=false` in Production to keep it off). Confirm no `*_BACKFILL_ENABLED` or `SPL_HISTORY_ENABLED` is set in Production; the API listing confirms none are.
- **Backup verification:**
  1. The owner records the latest Supabase backup timestamp from the dashboard.
  2. `db:backup` writes `backups/postgres-<iso>.sql`. Check its size is > 0, and that `grep -c '^CREATE TABLE'` and `grep -c 'COPY public."Space"'` are non-zero.
  3. Record its SHA-256.
- **Migration** (in a clean worktree at that SHA, under the shared heavy-job lock, creds exported in the shell and never echoed):
  ```
  npx prisma migrate status    # expect: 2 pending (growth_rename, connection_history_checkpoint), 0 failed
  npm run db:migrate:safe      # db-guard target identity → db:backup → prisma migrate deploy
  npx prisma migrate status    # expect: up to date (137)
  ```
  Then a read-only check (`psql -1` + `SET TRANSACTION READ ONLY`): the GROWTH_REVENUE Space name is `Growth`, and the `Connection.historyCheckpoint` column exists.
- **Promote:** branch `release/batch-1` at the SHA, PR to main, merge commit.
- **Post-deploy checklist:**
  - The new deployment is READY and aliased to app.
  - `/api/health` returns ok with db ok.
  - Trusted health on main is green.
  - Vercel logs show 0 5xx for 30 min.
  - The owner signs in with TOTP, opens Connections (lifecycle and detail tabs render), and sees Platform labelled "Growth".
  - The next dispatch shows `sol-history-backfill` as a disabled no-op.
  - The `sync-crypto` summary shows token capture as skipped (if OFF) or within budget.
  - No backfill provider traffic.
  - `/dashboard/brief` is not opened.
- **Rollback:** Vercel rollback to `dpl_GvqxKYoYfxwxS2VGhf5ddmd8zx3t` (`4dda8dc`); fallback `dpl_DySEgBLcpbzzRPYZQm1xaDrVWKdq`. Leave the DB in place. Reverse migration 1 with the UPDATE in its file only if the owner wants; the `historyCheckpoint` column stays.

The Vercel helper and fetched HTML are in a local scratchpad (not committed) (no secrets).
---

## Addendum: B9 progress (2026-11-01)

| PR | Content | Independent review | State |
|---|---|---|---|
| #201 | BETA_NOT_ACCEPTING gate on all invitation issuance | S1: MERGE-WITH-NITS (15/15 mutations); nits fixed in 0bc4bc5 | **MERGED b0caf1d** |
| #202 | AI copy "a personal finance workspace; the decisions stay yours"; Help & support link; Plaid support address; LOGIN_FAILED stores a keyed hash | S2: MERGE | **MERGED 7e89410** |
| #160 | Turnstile fail-closed rework | S1: MERGE-WITH-NITS (42 mutations; 2 P2 test gaps to close: register action pin, dry-run rollup) | S2 adding tests, then merge |
| #203 | 4 server-side analytics events + privacy disclosure | S2: MERGE | **MERGED 94271a4** |
| #204 | Option (b): DENIED + SUSPICIOUS can't be approved or invited (owner-approved) | S1: MERGE-WITH-NITS; fixed in 70a527f | **MERGED ac275d7** |
| #207 | Hashed blocked-identifier mechanism (owner P2-1 ruling); **adds migration `20261101120000`, so B9 is a migrating batch** | S1: MERGE at cee8d55 (live PG16 concurrency: deadlocks fixed and verified; 30/30 mutations) | S2 merging |
| #205 | Snapshot-consistent db:backup verifier + empty-mid-block parser fix (no cron pause needed for B2+) | S1: MERGE at 98589c2 (live-tested) | **MERGED d6934ad** |

**B9 env hard preconditions (updated):** both Turnstile keys plus the allowed apex host; **`BETA_BLOCKLIST_HMAC_KEY_V1` + `BETA_BLOCKLIST_HMAC_KEY_VERSION`** (without them, Production refuses issuance and deny rolls back). Owner to confirm the 2-year block retention.

**Release-note items for B9 (from the #202 review):**
- **Mixed rows at deploy:** for about 15 minutes after deploy, failed-login bursts are split between raw-identifier rows and hashed rows, so the 5-failure alert could miss one burst once. The B6 salt change has the same one-off effect.
- **O-8 residual:** the anomaly alert row still keeps the raw identifier in `metadata.key`. This is the owner's earlier decision; `hashedAnomalyKey` is ready if it is reversed.
- **Historical rows:** LOGIN_FAILED rows written before #202 keep raw identifiers until retention expires. A redaction backfill would be a Production data change, so it is an owner decision.

---

## Addendum: B1 execution log (2026-11-01)

| Step | Result |
|---|---|
| prod.env | Present, permissions 600, gitignored. Target ref (ref omitted) = `fourth-meridian-production`. Both URLs use the session pooler on 5432 as the database owner role |
| Pre-checks | PG 17.6. All 4 app tables owned by postgres. All existing policies PERMISSIVE. Schema ACL recorded. No leftover role |
| Grant | Applied as approved, in one transaction, run via local psql with the owner-supplied credentials (same SQL as the approved file) |
| Q1 | 20 PENDING; 0 decided, invited or redeemed; 0 created since 10-31 08Z |
| Q2 | `registration_mode=invite_only` (**P0 condition 1 met**); `require_totp_system_admin=false` |
| Q3 | 71 public tables; RLS enabled and forced on 63. The 8 without RLS are reference tables plus `_prisma_migrations`. 250 policies; 0 anon/authenticated grants. fm_app, fm_auth and fm_system have no BYPASSRLS (fm_backup and postgres do, by design). 135 migrations applied; latest `20261022001000` = main's newest |
| Q4 | 0 overdue purges. process-deletions and purge-trash last succeeded 10-31 14:15Z |
| Revoke | Role 0, policies 0, orphan memberships 0; schema ACL identical to the pre-check |
| migrate status @296516c | Exactly 2 pending (growth_rename, connection_history_checkpoint); nothing failed |
| **Backup** | **FAILED the safeguard 3 of 3 times.** JobRun live rows were one ahead of the dump each time (27147, 27148, 27149): cron writes during the ~6-minute dump. The 3 plaintext dumps were securely deleted (`rm -P`). **B1 STOPPED per the owner's rule. Nothing migrated or deployed** |

### B1 execution, continued (owner Option A approved)

| Step | Result |
|---|---|
| Writer inventory | Vercel crons `/api/jobs/dispatch` (*/15) and `/api/jobs/resume-stale-imports` (*/5) are the only scheduled writers. Manual paths (Run now, Refresh All) need an operator click (owner is the sole operator). Plaid webhooks are event-driven and stay on. Security anomaly alerts are inline on login, so unaffected |
| Original config | crons enabled, enabledAt 1792764879692, disabledAt null, 2 definitions, deployment dpl_GvqxKYoY |
| Pause | Disabled 01:46Z via project Cron Jobs settings. API shows disabledAt set. 0 running. **The 01:50 slot produced no JobRun** (27151 rows; last 01:45:49) |
| Backup | **PASS:** strict row-for-row check across 54 non-empty tables, 18.0 MB |
| Encryption | AES-256-CBC, PBKDF2 600k iterations. Key generated randomly and stored only in the owner's login Keychain. File a local encrypted file (dir 700, file 600). Plaintext sha256 `c32a125d6b94881486e5e5c892ce81fe98db6544016bb6500eca38ff7a02cb6e`; ciphertext sha256 `67c7c8335a00aa3d40a1e4e784242aa0c78ef9f4ee25792419c9fe89acf04f11`. **Round-trip decrypt with the key read back from the Keychain matched.** Plaintext removed with `rm -P`. Retain until 2026-12-01 |
| Migrations | `db:migrate:safe`: db-guard, then its own strict backup (PASS, removed with `rm -P`), then deploy. Applied growth_rename and connection_history_checkpoint. `migrate status` up to date (137). Growth Space renamed; `Connection.historyCheckpoint` exists (nullable text) |
| Env | `WALLET_TOKEN_CAPTURE_ENABLED=false` set on Production. No `*_BACKFILL_ENABLED`, `SPL_HISTORY_ENABLED` or `ERC20_HISTORY_ENABLED` in Production |
| Promotion PR | #206 `release/batch-1` @ 296516c → main |
| **CI on #206** | **`test` FAILED at the "Dependency audit (production, high+)" step:** follow-redirects 1.16.1, GHSA-mrwp-f3q8-3g9p (high). The fix is develop #151 (lockfile only, 1.16.1 → 1.16.2), merged after the cut, so not in 296516c. **Production main ALSO ships 1.16.1 today.** No override; **B1 STOPPED before deploy** |
| Scheduler restore | Re-enabled 02:09Z. API shows enabledAt 1793498968903, disabledAt null, 2 definitions. **resume-stale-imports succeeded 02:10:51**. Health ok, overdueJobs 0. Pause window about 23 min |
| Production state now | Old code (4dda8dc) on the new schema (137). Additive, so safe: old code ignores the new column and the platform-name change |

**Option (1) independent review (Session 2): AGREE.** Simulated with no push.
- `cherry-pick -x 25bf587` onto 296516c is clean.
- Later promotions: B2 merges clean but differs by exactly the 3-line lockfile hunk (B2 lacks the fix). B3, B8 and the develop tip merge clean and **tree-identical**.

Conditions:
- **Provenance:** use `-x` so the commit cites 25bf587.
- **Amended tree rule for B1/B2 only:** the promotion tree equals the SHA tree, or the SHA tree plus exactly `package-lock.json | 6 +++---`.
- **Full CI must pass,** including a clean dependency audit. If any other high advisory appears, stop; no stacking of picks.
- **Record the deviation** in this doc and in STATUS.

Awaiting owner approval.

**B1 backup integrity re-check (after the #205 review found an old verifier bug).** `countDumpCopyRows` miscounts an empty COPY block in the middle of a dump, so it could pass a table that the dump wrongly emptied.

Independent re-check:
- The encrypted backup was decrypted **in memory only**, using the key from the Keychain.
- A correct line-by-line COPY parser found 109 blocks: 58 non-empty and 51 empty. The 35 empty non-public blocks are unused Supabase auth, storage, realtime and vault tables.
- **All 16 public tables that are empty in the dump also have 0 live rows in Production.** So no truncation could have been hidden by the bug.
- Non-empty blocks are counted correctly by the old verifier, and all 54 matched.

**Backup integrity confirmed.**

### B1 deployed (2026-11-01)

**Security-fix exception (owner-approved Option 1):** `release/batch-1` = 296516c + `git cherry-pick -x 25bf587` → **42f55e0** ("(cherry picked from commit 25bf587001e508273badb0ca36056d1f1b6b7e69)"). The diff vs 296516c is exactly `package-lock.json | 6 +++---` (follow-redirects 1.16.1 → 1.16.2, GHSA-mrwp-f3q8-3g9p). `git merge-tree origin/main 42f55e0` = `e2560f73…` = the head tree.

| Item | Result |
|---|---|
| CI on #206 @ 42f55e0 | test ×2 PASS, **including "Dependency audit (production, high+)" = success**; Architecture audits, Public site and status-drift-guard PASS. Per-PR Deployment health = Vercel protection 401 (non-required; log checked) |
| Merge | #206 merged to main as **cf93e90** (merge commit). main tree = reviewed tree `e2560f73436393bb77889aed413852d3a97a651e` |
| Production deployment | **dpl_CSnXauJZ4hareQ3aTVPnuPggDNYA**, READY, target production, aliased to app.fourthmeridian.com, sha cf93e90 |
| Crons | enabled, bound to dpl_CSnX, 2 definitions |
| Env | `WALLET_TOKEN_CAPTURE_ENABLED=false` (production). No backfill or token-history flags set |
| DB | migrations 137, up to date |
| Smoke | /api/health ok, db ok, overdueJobs 0; dispatch and alert evaluation 02:15Z; backstop every 5 min. /login 200, /request-access 200, apex 200, / → 307. No Turnstile on /login (no CAPTCHA change) |
| Post-deploy jobs (cf93e90) | sol-history-backfill (owner manual run) succeeded `{enabled:false, …all zeros}`, a disabled no-op. fetch-fx-rates (owner manual run) succeeded, inserted 24. resume-stale-imports succeeded |
| Rollback | Vercel rollback to `dpl_GvqxKYoYfxwxS2VGhf5ddmd8zx3t` (4dda8dc); schema stays (additive) |
| Independent verification | **Session 2 PASS**: Trusted health success; 0 5xx (1 h); Platform Ops 2.0 renders; Policies show Beta Default v1 unchanged (10/25 connections, $5/$20 AI, 3/10 exports); fail-closed and TOTP confirmed dormant; no System Admin lockout; 03:45 dispatch ran on dpl_7f5p. **Owner note:** assign Beta to the owner account before ever setting `POLICY_ASSIGNMENT_FAIL_CLOSED=enforce`. Cleanup: prod.env removed (rm -P), worktree and release branch removed |

**Remaining owner items for B1:** visual check of Connections, and that Platform shows "Growth". Platform Spaces 2.0 is B3, so it is not expected to change yet.

**B2 tree rule (Session 2 / owner):** B2's promotion tree = 3849ab6's tree plus exactly the 25bf587 lockfile hunk. From B3 on, tree equality is exact.

---

## Batch 2 package (prepared 2026-11-01; NOT approved, awaiting S2 review then owner)

**What it is**
- **Cut SHA:** `3849ab61d51b5896f32ec1bcdcd5c583fef88070`, plus `cherry-pick -x 25bf587`. Simulated as `79a5fb3`.
- **Tree rule (owner, Session 2):** the B2 tree equals 3849ab6's tree plus exactly `package-lock.json | 6 +++---`. VERIFIED by simulation: diff vs 3849ab6 is that hunk only. `git merge-tree origin/main(cf93e90) 79a5fb3` gives `8738a7c2…`, identical to the head tree.
- **Contents:** #131–#142.
  - Platform Ops 2.0.
  - **System Admin bypass obeys DISABLE_SYSTEM_ADMIN (#131)**, closing P1-4.
  - Fail-closed policy assignment (dormant while the env var is unset).
  - Policy-group editor; Beta policy reconciliation tool (an operator act only).
- **CI at 3849ab6:** test, audits, drift guard and Trusted health = success. The dependency audit is expected to pass with the pick; it must be re-run on the release PR.

**Migration:** `20261030120000_policy_group_editor`. Additive.
- Two tables, PolicyGroup and PolicyGroupVersion, with RLS enabled and forced, a fm_system policy, and fm_backup SELECT. anon, authenticated and service_role are revoked.
- It seeds the built-in `BETA_FULL_ACCESS_V1` row and version 1 (POLICY_ROLLOUT). No customer rows are touched.
- Preview applied it on 10-30, but **without db:migrate:safe** (memory). Preview ledger shows `finished`, 1 step, not rolled back.
- Production ledger 137 → 138.

**Seeds:** none. `lib/platform/policy.ts` and the registry are unchanged vs main.

**Env**
- New code reads `POLICY_ASSIGNMENT_FAIL_CLOSED` and `OPERATOR_TOTP_ENFORCEMENT`. Both are **unset in Production** (Preview/develop only), so both stay dormant: no fail-closed policy, no operator TOTP.
- The owner is the sole operator (owner ruling), so this is accepted.

**DISABLE_SYSTEM_ADMIN check**
- It exists in Production as a sensitive value (unreadable).
- On main, `=== "true"` already refuses System Admin login (`lib/auth.ts:257`). So B2's #131 fix can only affect a System Admin session issued **before** the switch was flipped, which is exactly its purpose.
- **No lockout risk from B2.**

**Customer-visible effects:** operator surfaces only (Platform Ops 2.0). Customers see no change. Customer policy resolution is unchanged while fail-closed is unset (Production has 0 CustomerPolicyAssignment rows).

**Backup procedure (CHANGE vs B1; owner approval needed)**
- B2's own `db:migrate:safe` at 3849ab6 still runs the **old** live-count verifier, which failed under cron writes in B1.
- **Proposed:**
  1. Owner re-supplies a local credentials file (not committed) (it was removed after B1).
  2. Take the backup with **develop's snapshot-consistent `db:backup`** (#205 + #209). Its first real run on Preview at 02:51Z **passed**: 67 tables matched in the dump's own snapshot, 284 s, no race.
  3. Encrypt with the B1 Keychain plan, in the owner's Keychain.
  4. In a clean B2 worktree, run `db-guard --mode=migrate-deploy`, then `prisma migrate deploy`, then `migrate status`. This is the same guard and deploy as `db:migrate:safe`; only the backup step uses the newer verifier.
- **No cron pause needed.**
- **Alternative:** repeat B1's cron pause and use B2's own `db:migrate:safe` unchanged.

**Verification checklist**
- `migrate status` 138; the PolicyGroup row `BETA_FULL_ACCESS_V1` exists; RLS forced on both tables.
- Health ok; Trusted health green on main; 0 5xx for 30 minutes.
- Platform Ops 2.0 renders for the owner. The kill-switch behaviour is unit-tested (`platform-sec-1.test.ts`); no live flip.
- The env report has no fail lines (the salts are B6).
- Crons enabled and bound to the new deployment.
- `WALLET_TOKEN_CAPTURE_ENABLED` still false.

**Rollback:** Vercel rollback to `dpl_CSnXauJZ4hareQ3aTVPnuPggDNYA` (B1, cf93e90). The schema stays (additive); B1 code ignores the PolicyGroup tables.

**B2 independent review (Session 2): APPROVE FOR OWNER DECISION, with C1–C4.**

What Session 2 verified:
- The seed JSON is pinned to `catalogue.ts BETA_FULL_ACCESS_V1` by `policy-group-migration.test.ts`, and **no Beta values change**, so customers' effective entitlements are byte-identical.
- 0 assignments is safe: unassigned users resolve to the seeded isDefault group, and the code catalogue remains the fallback.
- No seeds or config are needed (`policy.ts` is unchanged; the operations registry change is code-only).
- No lockout risk: the owner's everyday (non-admin) account.

Conditions on the split backup/migrate procedure:
- **C1:** the backup and the guard+deploy load the same env file; record each step's printed target identity and abort if they differ.
- **C2:** hard `&&` gate. Deploy only after the backup's "verified … in the dump's own snapshot" line AND the Keychain round-trip pass.
- **C3:** the backup runs minutes before deploy. `migrate status` is 137 with 1 pending before, and 138 up to date after.
- **C4:** the release PR's dependency audit must pass. A new high advisory means STOP.

Checklist additions:
- Platform Ops → Policies shows the Beta values unchanged, with isDefault=true on BETA_FULL_ACCESS_V1.
- The env report shows the two new flags as unset/dormant, not fail.

### B2 deployed (2026-11-01)

| Item | Result |
|---|---|
| Release commit | `79a5fb3` = 3849ab6 + `cherry-pick -x 25bf587`. Diff vs 3849ab6 is exactly `package-lock.json \| 6 +++---` (owner-approved B2 tree rule) |
| CI #210 | test ×2 PASS, including the dependency audit; audits and drift guard PASS |
| Preflight | prod.env 600 / gitignored / ref (ref omitted); 137 applied, 1 pending |
| Backup (snapshot-consistent, develop tool, **no cron pause**) | Verified across 54 non-empty tables in the dump's own snapshot `0000002D-0000AF8C-1`. AES-256, owner's Keychain. Plaintext sha256 `19920b96d05c53feead6b12e00442864e6fcc0098e8c585c1dd27f746bcebb49`; ciphertext `e68228e75b9d6b0f43f41ca09c49e9b62b84e2b9201bf0fbff6770761e98e85a`. File a local encrypted file. Round trip OK; plaintext removed with `rm -P`; retain to 2026-12-01 |
| C1 same target | backup = guard = the session pooler |
| Migration | `20261030120000_policy_group_editor` applied. 138, up to date |
| Seed check | PolicyGroup BETA_FULL_ACCESS_V1: isDefault, builtIn, v1. Values identical to the code catalogue. RLS enabled and forced on both tables. 0 CustomerPolicyAssignment rows |
| Merge | #210 → main **0ec380c**; main tree = reviewed `8738a7c2…` |
| Deployment | **dpl_7f5punfMsVdswbAxR6Si2pFW7Bzy** READY → app.fourthmeridian.com; crons bound |
| Main checks | CI success; Trusted deployment health success |
| Env | WALLET_TOKEN_CAPTURE_ENABLED=false; POLICY_ASSIGNMENT_FAIL_CLOSED and OPERATOR_TOTP_ENFORCEMENT unset; no backfill flags |
| Jobs on 0ec380c | resume-stale-imports succeeded at 03:35:50, 03:40:50 and 03:45:49 |
| Rollback | dpl_CSnXauJZ4hareQ3aTVPnuPggDNYA (B1, cf93e90); schema additive |
| Independent verification | **Session 2 PASS**: Trusted health success; 0 5xx (1 h); Platform Ops 2.0 renders; Policies show Beta Default v1 unchanged (10/25 connections, $5/$20 AI, 3/10 exports); fail-closed and TOTP confirmed dormant; no System Admin lockout; 03:45 dispatch ran on dpl_7f5p. **Owner note:** assign Beta to the owner account before ever setting `POLICY_ASSIGNMENT_FAIL_CLOSED=enforce`. Cleanup: prod.env removed (rm -P), worktree and release branch removed |

### B3 deployed (2026-11-01)

| Item | Result |
|---|---|
| Release | PR #211 @ `9281ad5` (contains 25bf587, so **exact tree equality and no exception**); merged as **b35a6eb**; main tree = `a4b020e5…` |
| CI | test ×2 PASS (dependency audit success in both); audits and drift guard PASS. On main: CI success, Trusted deployment health success |
| Migrations | none (138) |
| Deployment | **dpl_Ev92iBskTWS2NMSL1Q1crfPwRq3N** READY → app.fourthmeridian.com; crons bound; health ok |
| Independent verification | **Session 2 PASS.** 0 5xx (1 h). Platform Spaces 2.0 (CS, Growth, Merchant Ops, Security Ops) render with no missing-table errors. Connections renders. **Net Worth (owner, All):** history starts 2025-11-02, inside the CoinGecko window, so no pre-floor days. No $0 crypto days; Investments band renders; hollow points are the "rebuilt" tier |
| WEALTH_REGENERATION_ENABLED | UNKNOWN (sensitive). Behaviourally immaterial for the current cohort (no pre-floor days in the series) |
| Pending | sync-banks (~05:40Z) and sync-crypto (~08:10Z) on b35a6eb must succeed within budget; the latter also closes the B1 token-capture check (Session 2) |
| New pre-existing UX finding (not B3) | The Investments completeness chip reads "Valuation unavailable" (`lib/perspectives/envelope.ts:304`, tier "unknown" label) while its detail says all 13 holdings are valued. P2/P3 |
| Rollback | dpl_7f5punfMsVdswbAxR6Si2pFW7Bzy (B2, 0ec380c) |

**B4/5 package independent review (Session 2): APPROVE**, gated on fresh release-PR CI.
- **Ordering is a single point of failure.** Migration 5 must precede the code; otherwise `lifecycleSource ≠ DB` makes every billable decision POLICY_UNAVAILABLE, a fleet-wide freeze. So **migrate status = 140 must be verified before merging #212.**
- **Cost Freeze:** no row means MISSING, so OFF.
- **Branded emails:** fall back to `https://fourthmeridian.com`; assets and legal pages are live.
- **Invitations:** validity defaults to 7 days.
- **Bulk approve:** none until B9 (no badge).
- **Migrations:** additive only.

**Post-deploy additions:**
- Policies shows Beta lifecycle ACTIVE and Cost Freeze OFF.
- The next sync-banks and sync-crypto succeed with **no POLICY_UNAVAILABLE / COST_FREEZE / PLAN_RESTRICTION skips** (a skip means STOP).
- One AI or Brief path works without a "paused" refusal.

**Cluster recommendation (owner decision):** mark all 13 SUSPICIOUS (reason ABUSE) and deny all 13, so B9's backfill blocks all 13 mailboxes, not only hzupno. Reversible by a newer verdict.

**Cluster execution plan (owner-approved; runs after B4/5 is verified)**
- **All 13** get a SUSPICIOUS verdict (reason ABUSE) plus deny. B9's backfill and preserve-evidence both require DENIED + latest SUSPICIOUS.
- **hzupno** (the earliest) is additionally captured via B9 preserve-evidence, as the single evidence row.
- The other 7 are untouched. No emails.

**Retention deadlines (`jobs/data-retention.ts:72-75`)**
- The **13 DENIED** are purged by `decidedAt` + 180 d, so from about **2027-04-30**. B9, the blocklist backfill and hzupno's evidence capture must all happen before then.
- **Owner item:** the **7 PENDING** are purged by `createdAt` + 180 d, starting **2027-01-22** (the oldest, created 07-26). Decide them before then, or accept that they expire silently.

---

## Post-B9 engineering backlog (owner-queued 2026-11-01; NOT part of the B3–B9 scope)

| # | Item | Owner requirements | Production |
|---|---|---|---|
| PB-1 | **Platform Ops incident lifecycle reliability** | Phases 0–10 per the owner directive: inventory, RCA, state machine, evidence-based reconciliation, operator ack/resolve/reopen, "broken now" vs history UX, Preview cron parity, historical reconciliation dry run (owner approval required), implementation and tests on develop/Preview, S2 review. Phase 0 (read-only code mapping) started. Read-only Production access is via a temporary restricted role (owner-approved, SQL subject to S2 review), after B9 | Separate approval |
| PB-2 | **Connections page actions** | Replace the three upper-right actions with two compact ones: "+ Connect" (a dropdown, popover or mobile sheet listing Plaid/bank and crypto wallet options) and "+ Add Manual Asset" (existing flow). Preserve every provider workflow, onboarding, permissions and function. Desktop and mobile; no bulky toolbar | Separate approval |
| PB-3 | **Platform Spaces navigation** | Remove single-item "Overview" rails. Audit each Platform Space; give compact, consistent navigation only where several real pages exist. Preserve routing, authorization, deep links and desktop/mobile behaviour. No decorative or empty tabs. **Coordinate with PB-1's UX** so they don't conflict | Separate approval |

**Process for all three:** inspect Production UI and code plus Preview first; implement and test on develop/Preview; Session 2 independent review.

**Owner clarifications (2026-11-01, later):**

**Priority order after B9 is verified:** PB-1 incident reliability (Priority 1), PB-2 Connections actions (Priority 2), PB-3 Platform Spaces navigation (Priority 3). Develop and Preview are autonomous with S2 review. **Production needs separate authorization.**

**PB-1 correlation rules:**
- Correlate each incident with the exact operation, resource, provider and subsequent execution history.
- "Up to date" on a connection is NOT proof that every associated operation succeeded:
  - a balance refresh does not resolve an investment-data persistence failure;
  - a wallet balance sync does not resolve a historical-price or valuation failure;
  - a successful retry of the SAME operation is valid recovery evidence.
- Classify each incident as: still exists / verified resolved / recurred / insufficient recent evidence.
- Never close an incident because it is old. Preserve failure history while showing current status.
- **Initial cases:** Schwab "Investment data persistence failed" (since 07-30, 5×) and self-custodied wallet "Reading the market price" (since 08-19, 1×).
- Investigate why the current lifecycle fails to reconcile them.
- Read-only Production access only, via the approved temporary restricted role after S2 reviews the SQL. **No Production data modifications.**

**Bot requests, intended final state:**
- All 13 classified SUSPICIOUS and DENIED; none in the pending queue.
- Exactly ONE separate historical evidence example: the earliest (hzupno), captured via B9 preserve-evidence. It is historical evidence, not an active case.
- The other 12 are not evidence examples, but their identifiers stay protected by the B9 blocklist.
- The 7 others are untouched. No emails.
- Keep audit records and blocklist identifiers under the approved retention policy. No premature deletion of anything needed for backfill, legal retention or audit integrity.

**When the owner returns, report:**
- the furthest safely completed B4–B9 milestone;
- remaining blockers;
- the incident investigation's initial findings;
- PB-2 and PB-3 tracked.

### PB-1 Phase 0 findings (read-only code mapping, 2026-11-01; develop 4b904d4 vs main b35a6eb; incident code is identical on both)

- **One automatic resolver only:** `resolveByAutomaticRecovery` (`lib/platform/incidents/lifecycle.ts:485`), reached from `syncTransactionsForItem` completion.
  - It closes only episodes that are condition-nature, in the `transactions` domain, with `detail.cursorBlocking === true`.
  - `retireItemSyncFailure` and `retireOpenNotification` retire Notification rows only, never SyncIssue.
- **No resolver** for INVESTMENT_DATA_PERSISTENCE_FAILED, IMPORT_ROLLBACK_FAILED or WALLET_SYNC_FAILED. `sync-issue-semantics.ts:556-583` says "stays active until one exists". Wallet episodes have `plaidItemId` null, so the Plaid-scoped resolver can't reach them. **This explains both owner cases:** Schwab investment persistence (07-30) and the wallet price read (08-19).
- **Legacy rows** (pre-cursor-safety, or `incidentKey` null) never auto-resolve.
- **NEEDS_REAUTH and ERROR items never sync** (cron, webhook and resume only touch ACTIVE items), so their incidents never see success evidence unless the user reconnects.
- **Removed connections stay "active":** the orphan check (`projections.ts:99-117`) tests row existence, not `PlaidItem.status=REVOKED` or `FinancialAccount.deletedAt`. Disconnect retires neither SyncIssue nor the SYNC_FAILED notification.
- **No age window on "active":** the overview, Incidents and CS lists use `resolved:false`.
  - The `sync-incident-critical` alert re-pages every 20 hours on any active critical episode, however old.
  - CS customer detail uses raw `resolved:false` with no derived state, so it **disagrees with the overview**.
- **Unresolved SyncIssue rows are never deleted.** Their evidence expires first: RefreshExecution and ProviderCall at 60 days, webhook events at 30. Old open incidents end up pointing at deleted evidence.
- **No operator acknowledge, resolve or reopen exists.** `resolutionKind` has only `AUTOMATIC_RECOVERY`.
- **Possible NULLS-FIRST issue:** the 200-row active scan is ordered by `lastOccurredAt desc`, so null legacy rows may fill it first. Unverified.
- **Preview has no crons by design** (Vercel runs crons on Production only; docs agree). No job refuses non-Production.
  - Paid or notifying jobs without a cost guard: `plaid-removal-retry`, `evaluate-alerts`, `notification-retry`.
  - The recipient guard and Cost Freeze would protect a Preview schedule (develop only).
- **Restricted-grant column list drafted.**
  - Include: SyncIssue (minus raw `detail`), SyncIssueOccurrence, PlaidItem (minus `encryptedToken`, cursors, `externalItemId`), Connection (minus `credential` and the address), AccountConnection, FinancialAccount (id, type, deletedAt), RefreshExecution, RefreshEndpointResult, ProviderCall, PlaidWebhookEvent, JobRun, plus filtered AuditLog, Notification and User id/role views.
  - Exclude: emails, names, tokens, IPs, free text.

### B4/5 deployed and verified; cluster action executed (2026-11-01)

| Item | Result |
|---|---|
| Release | #212 @ bc2e8ae (exact tree), merged as **1866f4c**. Main CI and Trusted health success |
| Migrations | 4 and 5 applied, **140 verified BEFORE merge**. Beta lifecycle ACTIVE, costFrozen false, no `platform_cost_frozen` row |
| Backup | Snapshot-verified (56 tables), AES-256 owner's Keychain, plaintext sha256 `420b02dd55b20af7923d4b19e9659d1fe04f845c82ac3ad254036c222a5b301a`, ciphertext `d421038b3771ea268e9d8b1d4c74b45719b9d25814e336d559dc8d85d8615586`, a local encrypted file |
| Deployment | **dpl_2fiFDhEP86zUd4umPtGJiU7NbGiw**, crons bound |
| Independent verification | **Session 2 PASS.** 0 5xx and 0 freeze/paused log lines. The live gate read shows lifecycle ACTIVE, globalCostFrozen false, effectiveRestriction null, billablePolicyReadable true. The catalogue source is DB. The beta queue renders. **Pending:** the sync-banks (~05:40Z) and sync-crypto (~08:10Z) billable proofs |
| **Cluster action** (owner-approved, run by Session 1 in the owner's Production session) | Pre-check asserted **exactly 13** suffix matches out of 20 pending, all PENDING, every createdAt hour matching the masked evidence. Each got POST risk-review `{SUSPICIOUS, ABUSE}` (200), then POST deny (200), **13/13**, no stop. **DB verify:** 13 DENIED (all cluster), 0 DENIED outside it, 7 PENDING untouched, 13 SUSPICIOUS verdicts, 13 BETA_REQUEST_RISK_REVIEWED + 13 BETA_ACCESS_DENIED audit rows, 0 invite tokens. **No emails** (deny is silent). hzupno will be captured via preserve-evidence after B9; blocklist backfill runs after B9 (before 2027-04-30) |

**B6 review correction (S2):** #173 revaluation is **code shipped, inert while `SOL_BACKFILL_ENABLED` is unset** (sol-history-backfill returns DISABLED first). The earlier "runtime revaluation of derived rows" line applies only once the owner enables the worker.

**B6 post-deploy checklist additions:**
- the env report shows both salts as pass;
- sol-history-backfill reports DISABLED;
- no provider-traffic spike;
- no unexpected `RATE_LIMIT_UNVERIFIED`.
- Expected and not a regression: the #172 reaper may finalise stale RUNNING executions on the first wake.

**Cluster action, independent verification (Session 2): PASS.**
- Queue counts: pending 7, denied 13, approved 0, redeemed 0. Invitations 0.
- The 7 PENDING are exactly the plausibly-genuine set (5ys0fv, 972sb1, f22fnt, j7mf0z, jsuu70, tpknbw, yw52au).
- The operator-action feed alternates RISK_REVIEWED (ABUSE) → ACCESS_DENIED.
- No invitations or emails.
- All 13 are DENIED + SUSPICIOUS, ready for the B9 backfill and hzupno preserve-evidence.

**B3 record correction:** `WEALTH_REGENERATION_ENABLED` is **ON** in Production. Determined behaviourally: the 02:15Z sync-crypto logged `[wealth-regen] … crypto price backfill — planned 2`, and regeneration runs only when the flag is "true". B3's verified outcome stands: no visible change, because the owner's history starts 2025-11-02.

**B7 package independent review (Session 2): APPROVE** after B6 is verified.
- **(a) No mass-send on deploy:**
  - Welcome is sent only on register or first verify, dedup-once, no backfill.
  - Platform-access is sent only on new grant changes.
  - Wallet-failure needs a sustained run of failures for 24 h or more (wallets are syncing).
  - Plaid re-login is sent only on a new webhook transition (0 items need re-auth).
  - The digest is OFF.
- **(b)** Migration 8's constant DEFAULT is metadata-only.
- **(c)** comms-automations completes with ACTIVATION_DISABLED and sends nothing.
- **(d) MATERIAL: #183/#185 is LIVE in Production** because regeneration is ON. Each sync-crypto runs planRevaluation, then stampOwedHolders, then rebuild. Both owner crypto holders are "owed": the price floor is 2025-10-24 and the earliest snapshot is 2025-11-02.
  - **Expected:** after the first B7 sync-crypto, parts of the owner's crypto history may read unavailable or partial until chunked rebuilds catch up. Values are kept, never $0. This is the plan's P1-12/P1-13.
  - **Monitoring and STOP trigger:** check the first 2 post-B7 sync-crypto runs (`holderRevaluation` owed/revalued/chunksRebuilt/deferred, duration within budget, no PARTIAL or timeout) and the owner's Net Worth chart.
  - **If, after 2 passes, revalued = 0 and chunksRebuilt = 0 while rows are stamped, or a run times out, STOP and escalate** (owner options: accept slow convergence, or set `WEALTH_REGENERATION_ENABLED=false` temporarily).

### B6 deployed and verified (2026-11-01)

| Item | Result |
|---|---|
| Release | #213 @ ff6176e (exact tree), merged as **e01d20f**. Main CI and Trusted health success |
| Env | `SECURITY_IDENTIFIER_HASH_SALT` and `COMMS_RECIPIENT_HASH_SALT` installed in Production. Sensitive, CSPRNG 256-bit, never printed; names only recorded |
| Backup | Snapshot-verified (57 tables), owner's Keychain. Plaintext sha256 `4ab5ed018e4da2fd48d2761fb4e75e3166b1ce9758e415145069f8418e6489be`; ciphertext `39b2eb16d03c19c88634101ca1bdebbb52f482c6e176769c399b45a8a4048000`. File a local encrypted file |
| Migration | `comms_delivery_ledger` applied, **141**. RLS forced on CommsDelivery and CommsDeliveryDaily. fm_system D/I/S, fm_backup S |
| Deployment | **dpl_HFaXu7RKroLspcC5h1yzVZjUG3Jh**, crons bound |
| Independent verification | **Session 2 PASS (complete).** 0 5xx; 0 RATE_LIMIT_UNVERIFIED, freeze or provider-spike lines. **Env report pass 19 / warn 0 / fail 0, with both salts pass.** Platform Ops and Connections render. sol-history-backfill confirmed inert at the 06:30 run (stoppedBecause DISABLED, 0 provider lines) |
| Rollback | dpl_2fiFDhEP86zUd4umPtGJiU7NbGiw (B4/5) |

**B8 package independent review (Session 2): APPROVE** after B7 is verified.
- No behaviour change for live customer sends: the Idempotency-Key is sent only when the automation engine passes one; storm and create are unchanged.
- `?only=` has no effect on the cron.
- Migration 9's index on the tiny CommsDelivery table is fine.
- No misleading "measured" state.
- **Expected:** the env report moves to warn 1 (`RESEND_WEBHOOK_SECRET` unset, webhook deferred by the owner), by design.

**Post-deploy:**
- env report fail 0 / warn 1;
- `POST /api/webhooks/resend` returns 503;
- comms-automations COMPLETE with note ACTIVATION_DISABLED.

### B7 deployed (2026-11-01)

| Item | Result |
|---|---|
| Release | #214 @ ec54c25 (exact tree), merged as **3b35d09**. Main CI and Trusted health success |
| Backup | Snapshot-verified (57 tables), owner's Keychain. Plaintext sha256 `a434d451c1698a17b5b8ed361cba010295a74634af07ccceb5403bca900d4633`; ciphertext `b0cac0e31bd7ce3c9efff46410944544c1872b54181fe82c2a6513a8f5ddb2ca`. File a local encrypted file |
| Migrations | 7 and 8 applied, **143**. RLS forced on all 6 new tables. CommsDelivery.mode NOT NULL DEFAULT 'LIVE' |
| Deployment | **dpl_9PhMLSiKmGXMwmL7rnJbEjH12Sem**, crons bound |
| Independent verification | **Session 2 PASS (observable).** 0 5xx; **0 email-send log lines**. Dispatch considers 15 jobs (comms-automations registered). comms-automations succeeded as a no-op. CS → Communications renders (Automations read-only, none) |
| **Decisive check: FAILED, STOP (escalated to owner)** | The 08:15Z wake on dpl_9PhM, checked by Session 2. **Passed:** BTC and SOL synced 2/2. SOL token step SKIPPED (DISABLED), 0 provider calls. No POLICY_UNAVAILABLE, COST_FREEZE or PLAN_RESTRICTION skips. `[wealth-regen]` ran. Dispatch 3 jobs, 0 failed. Health ok. Net Worth renders (value unchanged). **Failed:** `revaluation owed 2, revalued 0, deferred 2 (skipped: wake time)` in a ~12 s wake. |
| Root cause (deterministic) | `jobs/sync-crypto.ts:277` anchored the deadline to the earliest JobRun of *any* job in the last 300 s. resume-stale-imports (its own */5 cron at :x0:49/:x5:49) always had a run ~280 s before each :x0:29/:x5:29 dispatch, so deadline = 08:10:49 + 260 s = 08:15:09, before the job began. Since #183/#185 the owed holders are stamped `unavailable` (values kept) before that check, so they are never rebuilt. Headline values are unaffected; historical crypto days stay flagged unavailable. sol-history-backfill has the same anchor but is inert (SOL_BACKFILL_ENABLED unset). Pass 2 (~14:15Z) cannot differ, so STOP was applied early. |
| Fix (owner approval needed) | **PR #217 → develop, not merged.** Both jobs anchor to `currentBudgetStartedAtMs()` (the dispatch wake instant runJob already carries), falling back to the run's start. New `jobs/wake-deadline-anchor.test.ts`; price-gap pin updated; tsc clean. **Session 2: APPROVE @ 6900b92**, conditional on CI test, Architecture audits and Public site going green. S2's sweep found no other any-job wake inference; the Deployment-health failure is the known site-Preview 401. S2's post-promotion check: first dispatched sync-crypto logs revalued > 0 or chunksRebuilt > 0, no "skipped: wake time", no PARTIAL, dispatch well under 300 s. Owner options: (a) approve #217 → develop → Preview → hotfix to main; (b) accept the flag until fixed; (c) set WEALTH_REGENERATION_ENABLED=false (Production env change, owner only). |
| Rollback | dpl_HFaXu7RKroLspcC5h1yzVZjUG3Jh (B6) |

### B7 hotfix deployed (2026-11-01 16:00Z) — owner directive "Unblock and complete B7–B9"

| Item | Result |
|---|---|
| Owner authorization | 2026-11-01 directive: #217 approved, subject to the final diff matching the reviewed fix, green CI and Session 2's verification |
| Fix | #217 → develop, merged as **1909909** (6900b92 fix + 241a466 behavioural test). Session 2 APPROVE at both commits. The test drives the real `revalueHoldersAfterPriceGaps`: the old anchor reproduces Production (owed 2, revalued 0, skippedForTime); the fix rebuilds both holders |
| Promotion | `hotfix/b7-wake-anchor` from exactly **3b35d09**, `cherry-pick -x` of both commits → **PR #218** → main **503bbdf** (`--match-head-commit 7ba3c1e`). `git diff 3b35d09 503bbdf` sha256 `658dcc08…` = the #217 diff (4 files, +119/−7). Session 2 independently confirmed the diff and approved the plan |
| CI | test ×2 (Typecheck + Dependency audit high+ success), Architecture audits ×2 (REQUIRED tier), Public site ×2, drift guard all green. Site-Preview smoke 401 is known noise |
| Migrations | None. Production ledger read directly (`_prisma_migrations`, READ ONLY): **144 rows, all finished, none rolled back**; latest `20261031230000_comms_provider_events` 06:30:25Z (B8). Note: Prisma 5.22 `migrate status` printed a bare "up to date" from the 143-migration tree, so the ledger count is the evidence |
| Backup | Not required (no schema change) |
| Deployment | **dpl_HyzPBNVcWbg9cXPZapkTNRd8nqDW**, READY @ 503bbdf. Crons bound (dispatch */15, resume-stale-imports */5). `/api/health` ok, db ok, overdueJobs 0. Main CI success; Trusted deployment health success. Main post-deploy smoke: HTTP 401 Deployment Protection on the raw vercel.app URL (app not reached; no bypass header) |
| Rollback | dpl_9PhMLSiKmGXMwmL7rnJbEjH12Sem (B7) |
| **Production verification — PASS (20:24Z)** | First dispatched sync-crypto after the deploy: JobRun …6uct5f, 20:15:29Z, deploymentSha 503bbdf, outcome **COMPLETE**, 2 attempted / 2 synced / 0 failed / 0 deferred, partialReasons []. **Revaluation owed 2, revalued 2, chunksRebuilt 119, skippedForTime false**, 0 failures. Job 17.8 s; dispatch ≈ 18 s (budget 300 s). The exact bug shape was present: resume-stale-imports …9iu3sv started 20:10:49Z, 280 s earlier, and no longer blocked. Close coverage COVERED for BTC + SOL; SOL tokens SKIPPED (DISABLED), 0 provider calls; no new provider spend. SpaceSnapshot (the only crypto Space, counts/ratios only): 32 rows since Oct 1, **0 zero-crypto, 0 zero-NW**; day-over-day NW ×1.0011, crypto ×1.0029. `/api/health` ok, overdueJobs 0. Verified independently by Session 1 (DB, READ ONLY) and Session 2 (logs + health) |
| Earlier gate (superseded) | The 14:15Z wake found both wallets "not due" by seconds and did no revaluation, so the decision moved to the 20:15Z run |
| Follow-up (P3, after B9) | Job cadence (6 h) and per-wallet freshness (6 h) coincide at the boundary, so wallets sync every ~12 h in practice. Fix: a small tolerance in the per-wallet due check |

**B9 preparation (in progress)**
- `BETA_BLOCKLIST_HMAC_KEY_V1` (CSPRNG, sensitive) and `BETA_BLOCKLIST_HMAC_KEY_VERSION=v1` installed in **Production** and **Preview (develop)**, a separate key per environment, never printed (16:0xZ).
- Privacy policy Effective **November 1, 2026** (owner-approved): **PR #219** → develop. Wording verified against the code; both copies identical; `TERMS_VERSION` → 2026-11-01.
- **B9 re-cut to `7be29f3`** (16:1xZ): 1c05fcd + #217 (merge 1909909) + #219 (merge 7be29f3); release/batch-9 fast-forwarded; PR #216. **Session 2: APPROVE as a package.** Delta = exactly the two reviewed patches (non-legal diff `658dcc08…` = the hotfix; legal files `5c85233a…` = 6fdad06). No new migration vs 1c05fcd (145 total; the only one beyond main is `20261101120000_beta_blocked_identifiers`). S2's dry merge simulation: main 503bbdf ⊕ release/batch-8 → tree 04fc23fe (= B8 cut + the 4 hotfix files only); ⊕ 7be29f3 → tree `934a26df` = 7be29f3^{tree} (exact). To be re-verified on the real merges.
- **Session 2 note on the privacy date:** if B9 reaches Production on or after Nov 2, the policy would describe product-event practices as effective before the code ships. Owner decision whether to move the date to the actual promotion date (one line).
- **Turnstile: EXTERNAL DEPENDENCY.** No keys in local secure files or Vercel (any scope). Cloudflare is not signed in on Chrome; no Cloudflare CLI or token exists. Signing in on the owner's behalf is not permitted. B9 cannot deploy to Production without the keys (fail-closed; not weakened).

**B9 package independent review (Session 2): APPROVE**, subject to the hard preconditions.
- **Cut bumped to `1c05fcd`** (develop tip; adds #209, a test-only change to `scripts/db-backup.test.ts`). Exact tree vs B8. PR #216 updated.
- **Turnstile hosts (revises R-c):** the widget renders **only on app.fourthmeridian.com**. The apex /request-access is a hand-off page with no widget. The app host is allowlisted via `NEXT_PUBLIC_APP_URL`, so `TURNSTILE_ALLOWED_HOSTNAMES` is not needed (or set it to `app.fourthmeridian.com` only).
  - **Do NOT set `NEXT_PUBLIC_SITE_URL`:** it is the domain-split routing switch.
  - Cloudflare widget domains: `app.fourthmeridian.com` and `preview-app.fourthmeridian.com`.
  - The site key is build-inlined, so it is set before the B9 build.
- **Customer-visible on deploy:**
  - the Turnstile widget on /request-access and /register;
  - the login step-up after 3 failures;
  - the AI copy;
  - Help & support and the Plaid support address;
  - **the public privacy policy gains the "Product usage" bullet** (the marketing site rebuilds when main moves). **Owner decision before B9: the Effective date.** Also confirm the site project's Ignored Build Step builds for it.
- **Preview validation before Production:**
  - set the keys on Preview/develop and redeploy;
  - request-access from preview-app returns 200 and stores the request;
  - **a POST with no token returns 400**;
  - register with an approved Preview test invite;
  - login step-up after 3 bad attempts, then the correct password + token succeeds.
- **Production post-deploy:**
  - the widget shows on app /request-access;
  - an anonymous POST to `/api/access-request` with no token returns **400**;
  - /login loads; the owner can sign in.
- **Post-B9:**
  - blocklist backfill: CONTROL + reason via the owner operator account, dry run expecting `wouldCreate: 13`, then execute;
  - **hzupno preserve-evidence needs the owner's own Production System Admin session** (`requireFreshSystemAdmin`). It is an owner action, due before ~2027-04-30. It is impossible while `DISABLE_SYSTEM_ADMIN=true`.

### B8 migration applied (2026-11-01 06:30Z); merge held for the 08:10Z B7 revaluation result

| Item | Result |
|---|---|
| CI #215 @ 0f59435 | test ×2 PASS (dependency audit success in both); audits, drift guard and Trusted health PASS |
| Backup | Snapshot-verified (57 tables), owner's Keychain. Plaintext sha256 `8c08417aa7c9ff7f4591375cfa26b677a175272475e3bad857c5c342ff075205`; ciphertext `fd39edab7c1a9eecda79991fe1da67b0a0cc80279950cdb8d891d4c6fb620180`. File a local encrypted file |
| Migration | `comms_provider_events` applied, **144**. RLS forced on CommsProviderEvent; `CommsDelivery.deliveredAt` nullable |
| Merge | ~~Held, B7 STOP~~ → resumed 20:24Z after the B7 PASS. **Revalidated against final main:** release/batch-8 = 0f59435 + `--no-ff` merge of 503bbdf → **95ff61b**. `0f59435..95ff61b` = only the 4 hotfix files, byte-identical (cmp) to `3b35d09..503bbdf`. `503bbdf..95ff61b` = B8's own 81 files (+4757/−287), the same as the reviewed cut. Local wake-deadline-anchor, price-gap and tsc all exit 0. Session 2 re-APPROVED 95ff61b (merge only `--match-head-commit 95ff61b`; migration not rerun; ledger already 144) |
| CI #215 @ 95ff61b | test ×2 (Typecheck + Dependency audit high+ success), Architecture audits REQUIRED ×2, Public site ×2, drift guard, both Vercel builds green. Preview Deployment-health = the known 401 (app not reached) |
| Preflight (20:3xZ, READ ONLY) | The tree's 144 migration names == the Production ledger's 144 finished, non-rolled-back names (diff empty). **Nothing applied or rerun; no backup needed** |
| Merged (20:35Z) | main **f759c82** (parents 503bbdf, 95ff61b); main^{tree} == 95ff61b^{tree} = `04fc23fe` (= S2's simulation) |
| Deployed | **dpl_9rDG2puRfercjhyspeAY4M7gMCvp** READY, production, aliased app.fourthmeridian.com. Crons bound. `/api/health` 20:37Z ok, db ok, overdueJobs 0. Main CI success 41347577026; Trusted health success 41347577122; post-deploy smoke 41347780731 = raw-URL 401 only. Rollback: dpl_HyzPBNVcWbg9cXPZapkTNRd8nqDW |
| **Production verification — PASS (Session 2, about 21:40Z)** | env-status 19 pass / **1 warn (RESEND_WEBHOOK_SECRET only)** / 0 fail; anonymous POST /api/webhooks/resend → **503**; comms-automations 21:15:29Z succeeded, ACTIVATION_DISABLED; dispatch 20:45/21:00 no-op, 21:15/21:30 1 job each, 0 failed; resume */5 and sol-history-backfill succeeding; 5xx = S2's deliberate probe only; health ok, overdueJobs 0. Resend webhook stays deferred (not a blocker). release/batch-8 deleted (fully merged) |
| Observation (not B8, post-B9) | 20:44Z /api/plaid/exchange-token after() history sync timed out at 300 s (invitee Wells Fargo). Response was already 200; resume-stale-imports completed it 20:55:49Z. Consider capping mid-pagination restarts inside the after() budget |
| B9 forecast | main f759c82 ⊕ 7be29f3 → `934a26df` = 7be29f3^{tree} (git merge-tree), unchanged |

### B9 Turnstile Preview validation (2026-11-01 21:10–21:35Z)

| Item | Result |
|---|---|
| Keys | Owner created separate Turnstile widgets for Production and Preview and installed `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` directly in Vercel. First scoped to Development by mistake, corrected to **Preview (develop)** at about 21:15Z; Production at 21:05Z. Presence verified by name and scope only; values never read. `NEXT_PUBLIC_SITE_URL` untouched |
| Vercel "Needs attention" | `WALLET_TOKEN_CAPTURE_ENABLED=false` (Production, plain type, set by Session 1 as a kill switch). Not secret; intended value. Optional: convert to Encrypted |
| Preview redeploy | develop **7be29f3** (= B9 cut) rebuilt → fintracker1-mt7lt5xn1 READY, aliased preview-app.fourthmeridian.com |
| Rendering | /request-access: Cloudflare api.js loaded, `window.turnstile` present, response field present, visible "Verify you are human" widget (interactive). Not clicked by Claude (CAPTCHA completion is off-limits) |
| Fail-closed (server) | access-request: missing, empty, forged, non-string and 2100-char tokens → **400** each. register (terms accepted): missing, forged → **400**. Rejecting a forged token proves enforced mode (secret live, siteverify consulted). No 503 |
| Login step-up | 3 credentials-callback failures for a nonexistent probe identifier → pre-login `captchaRequired` false, false, **true** (threshold 3). Owner session unaffected |
| Open | Valid-token success path: one owner submission on preview-app (Claude cannot solve the challenge). Reused and expired tokens: unit-test coverage only |
| Session 2 | Evidence sent for B9 review at about 21:35Z |

### B9 Preview completion (2026-11-01 21:53–22:45Z)

| Item | Result |
|---|---|
| Valid-token path | Owner's real submission on preview-app 21:53:21Z → 200 with "[captcha] Turnstile verification enforced" (S2, from logs). Owner's earlier 21:28 attempts got 429: the per-IP access-request limit (5 / 15 min) had been used up by Session 1's 5 failure probes from the same IP. Runbook note: probe from a different IP, or leave the window to expire |
| Gap found (S2) | Preview lacked B9's migration: "BetaBlockedIdentifier does not exist", blocklist read treated as UNAVAILABLE (intake fails open by design) |
| Preview migration | Guarded `db:migrate:safe` (worktree at 7be29f3). Backup `postgres-2026-11-01T21-55-49-471Z.sql`, verified across 67 tables, sha256 843d98a3…. Applied `20261101120000_beta_blocked_identifiers` → ledger **145**. RLS enabled + forced on BetaBlockedIdentifier and BetaAbuseEvidence (1 policy each); grants fm_system + fm_backup SELECT only. S2 ACCEPTED |
| Blocklist retest | (a) new submission 22:25Z → requests 5→6, no read failure. (b) owner Deny 22:25:39Z (no block, correct without a verdict) + SUSPICIOUS verdict 22:42:26Z via the real risk-review route (owner's console: no verdict UI exists) → BETA_IDENTIFIER_BLOCKED, ACTIVE block 1 (v1). (c) resubmission 22:44:46Z → BETA_INTAKE_BLOCKED_DROPPED +1, requests unchanged, identical confirmation. **PASS** |
| Privacy date | Owner (via S2): the effective date is the release date. #223 (4fc436a) → develop **9b78674**: "November 2, 2026" in both copies (identical) + TERMS_VERSION 2026-11-02. S2 APPROVED the re-cut. release/batch-9 = PR #216 head = 9b78674; expected main tree `f759b2e9…`. Deploy must land on 2026-11-02 UTC |
| UX gaps (→ PB-6) | No UI lists denied requests and none sets a risk verdict; "Deny" vs "Deny and block" needs to be explicit |

### B9 deployed (2026-11-02 00:01–00:20Z)

| Item | Result |
|---|---|
| Gates | Preview complete (Turnstile fail-closed + valid path; blocklist retest PASS); S2 APPROVED re-cut 9b78674 and the Prod SQL/runner (amended grant + RLS checks); clock ≥ 00:00Z Nov 2 (effective date) |
| Preflight 00:01:09Z | Tree 145 / ledger 144; tree−ledger = exactly `20261101120000_beta_blocked_identifiers`; ledger−tree = ∅. #216 CI on 9b78674 green (Typecheck, Dependency audit, REQUIRED audits); Deployment health = Preview 401 only |
| Backup | Verified across 60 non-empty tables in the dump's own snapshot `0000001E-0000D583-1`. Plaintext sha256 `8ffccf7cc7b124541eb114db4dabdcd02ba71cbb48e5596f56f371f4c547efcc` = decrypted (round trip OK, owner's Keychain); ciphertext `8389ea525c3cd58cdb68e9244e3ac93ae3b585f4c2df1a7c75cf7de56f1c1a74`; file a local encrypted file; plaintext removed with `rm -P`; retain to 2026-12-01 |
| Migration | Guard target = backup target. `20261101120000_beta_blocked_identifiers` applied → ledger **145**, 0 rolled back. RLS enabled + forced on both tables, 1 policy each (`fm_system_all`, {fm_system}, ALL). Grants fm_system + fm_backup SELECT + owner only; **no anon / authenticated / PUBLIC / service_role**. 0 / 0 rows |
| Merge | `--match-head-commit 9b78674` → main **dc76711** (parents f759c82, 9b78674); tree `f759b2e9…` = 9b78674^{tree} (exact) |
| Deploy | **dpl_GE3DzKwyfXLgiWDUe84H6bPav8nR** READY ~00:13Z Nov 2, app.fourthmeridian.com; crons bound; health ok, overdueJobs 0. Main CI success 41365983422; Trusted health success 41365983470; post-deploy smoke = raw-URL 401 only (app + site). Rollback dpl_9rDG2puR (B8; the schema change is additive, so code rollback is safe) |
| Session 1 smoke | Prod access-request missing / forged token → **400** (enforced, not 503). fourthmeridian.com/privacy shows "Effective November 2, 2026" |
| Pending | Session 2 Production verification; owner's real request on app.fourthmeridian.com/request-access (final valid-path check). Post-B9: PB-7 real-case RefreshExecution read (SQL S2-approved) |

### B9 closed + bot blocklist (2026-11-02 00:15–01:20Z)

| Item | Result |
|---|---|
| Session 2 verification | **PASS**: tree exact, alias → dpl_GE3Dz…, missing-token 400, widget renders (owner Chrome), env-status 20 pass / 2 warn / 0 fail, privacy Nov 2 + TERMS_VERSION 2026-11-02, login works, health ok, 0 5xx |
| Owner final check | Real request on app /request-access: POST 200 ×2 (01:06:55Z, 01:07:41Z) with "[captcha] Turnstile verification enforced": the Prod widget's hostname and action are accepted. **B9 fully closed** |
| New env warn | BETA_INTAKE_HASH_KEY_V1 (new with B9). Installed: a separate CSPRNG key per environment (Prod + Preview develop, sensitive, never printed) + VERSION=v1. Takes effect on the next deploy; the digest is computed at retention time (jobs/data-retention.ts:221–229), so nothing is lost before then |
| Bot blocklist precheck | denied_suspicious 13, unblocked 13, pending 7, active blocks 0, evidence 0; exactly 1 hzupno id |
| Backfill (owner's Prod console, fresh GROWTH_REVENUE CONTROL) | Dry run: wouldCreate 13 / candidates 13. Execute: **created 13**, failed 0, batch `e246c93f-8621-40be-adb5-adee677e9073` (13 distinct canonical mailboxes). No emails; 7 pending untouched |
| Post-check | denied_suspicious 13, **unblocked 0**, pending 7, **active blocks 13**, evidence 0 |
| hzupno evidence | First attempt from the owner's everyday account → 403 (the route requires SYSTEM_ADMIN by design). Owner re-ran it from the separate System Admin account: **200**, evidence `…6roeb`, captured 01:19:29Z, reason ABUSE, retainUntil **2029-11-01**. DISABLE_SYSTEM_ADMIN not touched |
| Final post-check | denied_suspicious 13, unblocked 0, pending 7, active blocks 13, **evidence 1**. Directive item 6 complete |

## B10 release package (prepared 2026-11-03; Production actions require owner approval)

*Prepared at Session 1's request from read-only git and GitHub data (develop `f0405e1`, main `dc76711`). Nothing was merged, deployed or migrated, and no Production or Preview system was touched. This package is a plan: **every step below needs the owner's explicit B10 approval.***

**Baseline.** Main is still B9 (`dc76711`). The B10a candidate, #268 (`release/batch-10a`, OPEN, not merged), contains develop through PB-7 (`5642bb5`) plus a cherry-pick of #231: #220, #221, #222, #224, #226, #227, #229, #230 and #231. Those PRs are covered by #268 and are not repeated below. If #268 ships first, they are on main and the rollback target moves from B9 to the B10a deployment (not yet recorded). Nothing merged to develop after the cut is on main.

### B10.1 Candidate PRs (merged to develop after the B10a cut, `5642bb5..f0405e1`)

**SAFE TO PROMOTE.** These have no migration and no schema change.

| PR | Title | Why it is safe |
|---|---|---|
| #233 | A Plaid webhook skipped during an in-flight sync is no longer erased | Lock/marker logic only; no schema change. #268 deferred it to a later candidate |
| #234 | Fence the engine's final marker write; document accepted clock skew | Follow-up to #233; same files, no schema change |
| #256 | Single-use TOTP codes at login (SEC-012) | Uses the existing `RateLimit` table and grants; no migration |
| #258 | `db:regrant`: restore GRANTs after a `--no-privileges` restore | Adds a script only. Running it against Production is gated separately by the owner |
| #262 | PB-9: Merchant Identity KPIs drill into their records | Read-only tables behind the existing MERCHANT_OPS permission |
| #265 | PB-9 follow-up: rate-limit Reconsider; records search stays letters-only | Adds a rate limit; no data change |
| #281 | AI & Costs: one authority for fleet spend status | Presentation-side tile wording |
| #283 | AI & Costs: budget KPI drills into its 24 h calls | New read-only, PLATFORM_OPS READ route |
| #282 | Ops: environment-aware job verdicts + provider-outcome@1 | Verdict rules only. On Production the job output is byte-identical (the scheduler reads as present) |
| #285 | Provider trust: connection scope (provider-connection@1) + Preview freshness | Verdict rules only |
| #286 | provider-connection@1: name unclassified codes; say when no share is computed | Basis wording and pins; no verdict change |
| #284 | PRIV-ref: the opaque customer reference is a keyed digest | No schema or env change (reuses an existing required server secret). The reference format changes, see B10.3. **Dependency:** #284 edits removed-connections files that #225 introduced, so promoting it without #225 needs a rebuilt cherry-pick |
| #238 | Test fixtures: real cash figures replaced with synthetic data | Test-only |
| #239 | UI-hardening output goes to `tmp/`, not `docs/plans` | Local tooling only |
| #291 | Deactivated or deletion-scheduled account proves no session (P1 security; merged after `f0405e1`) | No migration or schema change: the session proof also reads the user's existing `deactivatedAt` / `deletionScheduledAt`, so a lockout refuses even if the revoke failed. **Dependency check** (its diff applied to the B10a cut `5642bb5`): every runtime file applies cleanly; the only failure is a fixture hunk in `lib/auth/presence-scope.test.ts`, a test file added by PB-10 (#274). If PB-10 ships, nothing to do; if PB-10 is excluded, drop that test hunk |
| #300 | FM-AUDIT-025 parser + FM-AUDIT-053: CoinGecko daily-close shift; BTC multiaddr invalid-as-zero (merged after `f0405e1`) | No migration or schema change. **Dependency check:** its diff applies cleanly to the B10a cut, and no file it touches was changed by a gated PR. It fixes the parser only: closes already stored in the price archive stay shifted until the owner-gated archive repair (see B10.3) |
| #302 | FIN-C (FM-AUDIT-021 + 022): a stale bank balance writes today's snapshot as an estimate; an unvalued wallet stamps it incomplete (merged after #307) | No migration. **Dependency check:** its diff applies cleanly to the B10a cut. PB-8 (#232) touched `regenerate-history.ts` in between, but #302's hunk there uses `floorByAccount`, which already exists at the cut. It needs #301 (`unvaluedCount`), which is in SAFE. Past rows frozen as observed stay frozen (B10.5) |
| #301 | FM-AUDIT-022 (FIN-B): unpriced or never-observed wallets are excluded from totals and disclosed as a count (merged after `f0405e1`) | No migration or schema change. **Dependency check:** its diff applies cleanly to the B10a cut. The new symbols it uses (`unvaluedAccountCount`, `unvaluedWarning`, `resolveWalletBalance`) are added by #301 itself; the rest exist at the cut. PB-8 (#232/#266/#267) touched `WealthWorkspace.tsx` and `lib/ai/types.ts` in between, but #301's hunks there add only its own count and field |
| #295 | FM-AUDIT-023 exchange half: a null Plaid current balance keeps the prior balance and clock (merged after `f0405e1`) | No migration or schema change. **Dependency check:** its diff applies cleanly to the B10a cut, and the helpers its test imports are either already at the cut (`planBalanceWrite`) or added by #295 itself. PB-8 (#232) also touched `lib/plaid/refresh.ts`, but #295 does not depend on that change |

**GATED.** Each of these needs an owner precondition or decision before Production.

| PR | Title | Gate |
|---|---|---|
| #298 | DB-010: AuditLog append-only at the database for `fm_system` | **Migration** `20261103140000_db010_auditlog_append_only` (B10.2): owner approval required for Production. OPEN at the time of writing; S2 approved; Preview apply pending. Include it only once it is merged and applied on Preview |
| #255 | PB-1 Phase 1: incident data model, removed-connection closure, archive + purge | **PB-1 migration.** It needs `20261103120000_pb1_s2_incident_lifecycle_schema` applied first, because its writers fill new columns at observation time (B10.2) |
| #259 | test(RLS): PB-1 incident tables are operator-only | Test-only, but it tests #255's schema; it travels with #255 |
| #263 | test(PB-1 §13): Phase-2 parity harness scaffold | Test-only; it is the gate for the PB-1 reader cutovers |
| #264 | PB-1 Phase 2: incident-intelligence module (API + deterministic core) | **PB-1 reader cutovers.** Inert in this tree: no reader is cut over, and each cutover is its own future PR gated on the §13 parity harness. It reads #255's columns, so it travels with #255. No cutover PR had merged to develop as of `f0405e1`; see #288 below |
| #288 | PB-1 Phase 2 R1/R2: CS incidents panel + CS detail loader read module verdicts | **PB-1 reader cutover.** Not yet merged at `f0405e1`; it is expected to be merged by the time B10 is cut. It travels with the PB-1 group and is bound by the same migration-first rule. R3–R6b remain pending |
| #296 | PB-1 2B: incident investigation workspace, detail, timeline, history (merged after `f0405e1`) | **Travels with PB-1** (migration first). Dependency check (diff applied to the B10a cut `5642bb5`): fails. It extends the intelligence module that #264/#287/#288 created and imports `lib/platform/incidents/codes.ts` (added by #255). It also overlaps the safe drill-down PRs #262/#283 in `lib/space/space-url.ts`, which ship anyway. The new workspace views are lead-only (no new section key), so no platform-Space seed is needed |
| #287 | PB-1 Phase 2: unattributed is null, never "" | Follow-up to #264; travels with it |
| #232 | PB-8: liability coverage floor + held-flat probe | **PB-8 regeneration.** The PR modifies no stored row, but once deployed the *next automatic* regeneration (connect, refresh or the daily wealth regen, typically the 30-day window) rewrites the affected Spaces' recent history: liabilities held flat before their connection become unknown, and credit cards are walked. A full-window regeneration is a separate owner decision |
| #266 | PB-8b: change-since never compares across a partial-history floor | Builds on #232's floors; travels with PB-8 |
| #267 | PB-8c: server-side change claims (AI, launcher, Brief) respect the floor | Builds on #232/#266; travels with PB-8 |
| #272 | PB-8d: AI history points before the floor are withheld | Builds on #267; travels with PB-8 |
| #293 | AI history tools and change claims fail closed on unreadable coverage (merged after `f0405e1`) | **Travels with PB-8.** Dependency check (diff applied to the B10a cut `5642bb5`): fails. It modifies `lib/connections/balance-coverage.core.ts` / `balance-coverage.ts`, which #232 created, and every other runtime file it touches was last changed by #267/#272 |
| #299 | Data-health coverage fails closed: client heroes withhold on a failed read (merged after #293) | **Travels with PB-8 (and #293).** Dependency check fails: it modifies files that #232/#266 created (`balance-coverage.core.ts`, `BalanceCoverageNote.tsx`, `wealth-change-gate.ts`, `debt-trend-points.ts`) and builds on #293's `BALANCE_COVERAGE_UNAVAILABLE` |
| #305 | Coverage loading renders governed changes as pending, never shown then retracted (merged after #299) | **Travels with PB-8 (and #293/#299).** Dependency check fails: it modifies `balance-coverage.core.ts`, `BalanceCoverageNote.tsx`, `wealth-change-gate.ts` and `debt-trend-points.ts` (created by #232/#266), and the test file #299 added |
| #307 | FIN-B2 (FM-AUDIT-022): unvalued wallets excluded from backfill history, never exported as 0 (merged after #305) | **Travels with PB-8 (backfill hunks) and needs #301.** Dependency check (diff applied to the B10a cut `5642bb5`): every file applies except `lib/snapshots/backfill.ts`, whose hunks sit inside PB-8's (#232) changes (`providerSubtype`, the card and held-flat helpers). It also uses #301's `resolveWalletBalance`. The export half (`lib/export/*`, `components/space/manage/*`) applies cleanly, so it could ship without PB-8 only on a rebuilt release branch that S2 reviews. No migration. The `backfill:snapshots` script now loads the existing server-only preload; it is not run as part of the deploy (see B10.5) |
| #275 | PB-11: investments correctness (attribution FX, hero % gate, one allocation authority) | **Travels with PB-8 (code dependency).** Presentation-side itself, but `InvestmentsHero` imports `ESTIMATED_CHANGE_SUFFIX` from `lib/connections/balance-coverage.core`, a module created by #232 (PB-8) with the constant added by #266 (PB-8b). It promotes only with PB-8, or on a release branch that inlines the suffix (a rebuilt tree, S2-reviewed) |
| #277 | PB-11b: investments display conversion fails closed on a rate miss | **Travels with PB-8 (code dependency).** Stacked on #275's files, so it inherits #275's dependency on PB-8 |
| #274 | PB-10: presence and engagement | **PB-10 migration.** `20261103130000_pb10_session_presence` must be applied before the deploy (B10.2) |
| #276 | PB-10 follow-ups: carry refused interactions; Content-Length precheck | Builds on #274; no schema change of its own |
| #278 | PB-10 F3+F4: background reads don't extend the SEC-010 idle deadline | Builds on #274; no schema change of its own |
| #280 | PB-10: pending interaction age = the latest input | Builds on #276; no schema change of its own |
| #225 | PB-5: removed-connections list and operator Remove connection | #268 excluded it because **its live removal test is pending**. I couldn't confirm from git or GitHub that the test has since run. Needs S1 confirmation |

**Docs-only** (they ship with whichever tree is promoted and need no gate): #236, #237 (also adds the docs-structure test), #241, #242, #243, #244, #245, #246 (also ignores `docs/invoices/`), #247, #248, #249, #250, #251, #253, #257, #260, #261, #273, #279.

**Counts:** 14 safe, 16 gated, 19 docs-only (49 PRs), plus #288 (gated, PB-1) expected before the cut. Added 2026-11-03: #291, #295 and #301 (safe; merged); #293 and #299 (gated, travel with PB-8); #296 (gated, travels with PB-1); #300 and #302 (safe; #302 needs #301); #305 and #307 (gated, travel with PB-8) and #298 (gated; DB-010 migration).

**Recommended release tree (S2's advice).** The simplest reviewable tree is **develop at the B10 cut, with BOTH migrations applied first** (B10.2). That promotes everything above, except #225 if its live removal test has not run, and it requires the owner's PB-8 decision because PB-8 is in that tree. Any subset (excluding PB-8, PB-1, PB-10 or #225) means a release branch with reverts, and S2 reviews that exact tree before promotion. Develop is linear and the gated PRs are interleaved with the safe ones, so no subset is a clean cut.

### B10.2 Migration order

Two Prisma migrations are on develop and not on main (`git diff --name-only origin/main origin/develop -- prisma/migrations`), and a third (DB-010, #298) is expected. Prisma applies them in name order:

| # | Migration | PR | Must it precede the deploy? |
|---|---|---|---|
| 1 | `20261103120000_pb1_s2_incident_lifecycle_schema` | #255 | **Yes**, if #255 is in the tree. The new observation writer sets `subjectUserId` and `openedBy` on every new incident and writes `SyncIssueEvent`. Without the columns and tables, incident writes fail. They fail closed (swallowed and reported on the observer), but Production would stop recording incidents. The migration is additive: the new columns are nullable, except one with a constant default (no table rewrite); the CHECKs are vacuous on existing rows; there is no backfill; and the three new tables are fm_system-only with forced RLS. B9 code ignores all of it |
| 2 | `20261103130000_pb10_session_presence` | #274 | **Yes, and sign-in critical; never optional.** The Customer Success list and detail queries select `UserSession.lastPresenceAt` / `lastInteractionAt`, and the heartbeat writes them. The login path creates a `UserSession` without a `select`; Prisma's `create` returns every scalar column, so a session create against a database without these columns fails, and **sign-in would break** (Session 1 confirmed this reading). The migration adds two nullable columns with no default, no backfill and no grant change (catalog-only). B9 code ignores them |
| 3 | `20261103140000_db010_auditlog_append_only` | #298 | **Not required by the code, but in the same guarded run, after 1 and 2.** Grants and policies only (no table or column change): `fm_system` loses table-level UPDATE/DELETE on `AuditLog` and the single `FOR ALL` policy, and keeps SELECT and INSERT. Only the two retention jobs can still change rows: beta-intake network minimisation (a column-limited UPDATE of aged rows) and product-event retention (DELETE of rows past the retention window). `fm_backup`, `fm_app` and `fm_auth` are unchanged. **Gated:** owner approval for Production. **Rollback:** forward-only (database-safety §3a); see B10.4. An app rollback leaves it in place |

**Process:** apply all three (DB-010 once #298 is merged and Preview-applied) in one guarded run before the deploy, the same way as B1–B9: `npm run db:migrate:safe` (guard → backup → `prisma migrate deploy`), per [database-safety.md](../operations/database-safety.md). Preflight: tree − ledger = exactly these migrations; ledger − tree = ∅. **Owner approval is required.** **Preview:** the PB-1 and PB-10 migrations are applied and finished on Preview (Session 1, read-only `_prisma_migrations` check, 2026-11-03); DB-010's Preview apply is pending.

### B10.3 Owner-visible release notes

Each note was checked against its PR description and the develop code.

- **Idle tabs now sign out (SEC-010; PB-10 F3/F4, #278).** A tab left open but unused for 30 days now signs out. Before, background reads kept pushing the 30-day idle deadline back (the notification bell's unread count, the notice rail's re-read on focus, and the session refetch on focus). Those three reads still check the session but no longer extend it. Navigations and actions still count. The SEC-010 durations themselves are unchanged.
- **Customer references change format (#284).** Operator-facing references change from the old masked id tail to `user #xxxxxxxx`, a keyed digest that no longer contains any part of the account id. Old references in past alert emails, alert summaries and operator notes stop matching, and Customer Success search no longer accepts the old form. Alert dedupe keys change format too, so **an alert that is already firing may re-notify once** after the deploy. Rotating the server secret it is derived from rotates every reference.
- **Provider verdicts (provider-outcome@1, provider-connection@1; #282/#285/#286).**
  - Any failure within a sufficient sample reads **Degraded** (before, an isolated failure under the old threshold read healthy).
  - A small sample with no failures reads **"Not enough data"** (muted, no attention item), never Healthy. A small sample that has a failure still reads Degraded or Failing; it is never hidden.
  - Providers no longer read **Failing** because a customer must re-authenticate or has revoked access. Reconnects show as a neutral fact on the tile. Only a provider-side error share can fail a provider. A large reauth wave reads Degraded.
  - Every tile now shows the rule and the counts behind its word.
- **Preview only: jobs read "Not scheduled in this environment" (#282).** Crons don't run on Preview, so jobs there read neutral instead of Failed; a job whose newest run failed still reads failing. Production output is unchanged.
- **Customer Success presence labels (PB-10, #274/#276).** Customer Success now shows **Active now / Online, idle / Offline / Unknown**, a coarse last-active bucket (for example "within 5 min" or "active today"), last login, and signed-in sessions. It no longer reads the "session last used" clock. The new columns have no backfill, so every customer reads **Unknown** until their first heartbeat after the deploy. Growth "returning" and active-in-7-days now count meaningful engagement only, so those figures may drop.
- **Crypto price closes and Bitcoin xpub reads (#300).** Newly fetched crypto daily closes are filed on the right day (a CoinGecko point at 00:00 UTC is the previous day's close). Closes already in the price archive are unchanged, because the archive is insert-only; rewriting them is a separate owner-gated repair, followed by regenerating the affected crypto history. Until that repair runs, the archive holds old one-day-shifted closes for dates already fetched and correct closes for new dates: mixed but non-overlapping, since `skipDuplicates` means no date ever has two values. A malformed or incomplete Bitcoin xpub lookup now fails as invalid data instead of reading as 0 BTC.
- **Exports for unvalued wallets (#307, ships with PB-8).** `accounts.csv` gains a trailing `valuation_status` column (`not_yet_valued`) and leaves the balance cell empty for wallets not yet valued; `data.json` carries `balance: null` + `valuationStatus` for them. Anyone parsing the CSV by column position sees one extra trailing column.
- **Stale bank balances no longer read as observed (#302, FM-AUDIT-021).** While a bank connection is stuck, today's snapshot is written as an estimate, and it is corrected after reconnect instead of freezing the old balance. Today's snapshot is also stamped incomplete when a wallet is unvalued. History charts may show estimated days where they used to show observed ones.
- **Unvalued wallets (#301, FM-AUDIT-022).** A crypto wallet with no price or no observation yet is no longer counted (as $0 or a stale stored balance) in net worth, assets or the AI's totals. It is excluded, and surfaces say how many wallets are not yet valued, so totals can read as partial.
- **Other visible changes:** a deactivated or deletion-scheduled account is signed out of every session even if a revoke failed (#291); single-use TOTP codes at login (#256); Merchant Identity KPI drilldowns (#262); AI & Costs budget tiles agree and drill into their calls (#281/#283); investments show "unavailable" rather than mixed currencies on a rate miss (#275/#277; ships only with PB-8). If gated groups ship: the PB-8 partial-history wording ("Change unavailable: history is partial before …"), and, with #293/#299, changes and history points are withheld (with a note) when coverage cannot be read, rather than shown unqualified, and the removed-connections list (#225).

### B10.4 Rollback notes

**Code rollback** for every item is a Vercel rollback to the prior Production deployment (B9, main `dc76711`), or B10a's if #268 ships first. Leave the schema in place.

| Item | Rollback | Trivial? |
|---|---|---|
| PB-10 migration + #274/#276/#278/#280 | The columns are additive and nullable; B9 code ignores them, and no down-migration is needed. Background reads go back to extending the idle deadline, and Customer Success goes back to the old "last active" | Yes |
| PB-1 migration + #255/#259/#263/#264/#287/#288/#296 | The columns and tables stay and old code ignores them; no down-migration. Data the new code wrote stays: incidents closed because their subject was removed stay closed, and archive rows stay. I found no main-code path that reopens a resolved incident, so the new `lifecycleState` CHECKs shouldn't block old writers | Yes, low risk |
| #284 reference format | A rollback restores the old format. References issued meanwhile stop resolving, and dedupe keys change back, so a firing alert may re-notify once more | **Not trivial for operators** (references churn twice) |
| PB-8 (#232/#266/#267/#272, plus #293/#299/#305/#307) | The code rolls back, but **history rows rewritten by regenerations that ran under PB-8 are not reverted**. They change back only when the previous code's own regeneration next rewrites that window, or by a backup restore (the same class as the B3/B6 re-stamp) | **Not trivial** |
| #225 PB-5 (if promoted) | The list and button disappear. **Removals an operator made in the meantime are not undone**: the provider-side revocation is external and permanent | **Not trivial** for any removal made |
| #256 TOTP | The replay window reopens. Claim rows in `RateLimit` are harmless | Yes |
| #291 deactivated-session lockout | A rollback reopens the P1: a deactivated or deletion-scheduled account whose session revoke failed could keep using that session | Yes, but it reopens a P1 security gap |
| #295 exchange null balance | A rollback restores `?? 0` with a fresh clock at connect/reconnect; no data change | Yes |
| #300 price parser / xpub | A rollback restores the shifted filing for new fetches (rows written meanwhile stay correct, insert-only) and the read-as-zero on a malformed xpub response; no schema change | Yes |
| #302 stale-bank estimate | Today's row goes back to being written as observed over stale balances. Rows written as estimates meanwhile stay estimates (still regenerable); no schema change | Yes |
| #301 unvalued wallets | Unvalued wallets are summed again from the stored column; presentation and totals only, no data change | Yes |
| DB-010 migration (#298) | **App rollback:** leave DB-010 in place (B9 code is compatible — only the two retention jobs UPDATE/DELETE AuditLog, on main and develop). **Schema rollback only if needed:** the README SQL as an emergency step through guarded tooling, then a forward revert migration (`…_db010_revert`) carrying the same SQL so ledger and schema agree; never `migrate resolve --rolled-back` on an applied migration (Prisma allows it only on a FAILED migration; database-safety §3a, forward-only) | App rollback: yes. Schema rollback: not trivial (needs a revert migration) |
| #233/#234 | The skipped-webhook defect returns; no data change | Yes |
| Verdict and label changes (#282/#285/#286, #281/#283, #262/#265, presence labels); #275/#277 roll back with PB-8's code | Presentation-only; old wording returns. Attention items that depend on provider trust revert with it | Yes |
| #258, #238, #239, docs | No runtime effect | Yes |

**Unverified here:** whether #225's live removal test has run.

### B10.5 Owner-gated data decisions (not part of the deploy)

These rewrite stored rows. None runs as part of B10, and each needs its own owner approval per environment (Preview and Production separately), after a guarded backup.

| Decision | What it rewrites | Why it is separate |
|---|---|---|
| CoinGecko archive repair (FM-AUDIT-025) | Crypto daily closes already in the price archive (one day late), then the crypto history valued from them | #300 fixes only new fetches; the archive is insert-only, so stored rows need a scripted delete + re-acquire, then regeneration |
| Snapshot backfill re-run (`backfill:snapshots`, FM-AUDIT-022 / #307) | The backfilled snapshot window for Spaces with unvalued wallets | Regeneration-class: #307 changes what the backfill writes, but rows already written stay until it is re-run |
| Restricted-cash snapshot repair (FIN-E part 2) | Populates `SpaceSnapshot.restrictedCash` for past rows (the column ships with part 2, additive and nullable) | Rows written before the column exist without it; the repair fills them |
| Null-balance $0 rows (FIN-A2, #316 follow-up) | Finds existing accounts that stored $0 from a null balance at token exchange, and marks them unobserved | #316 fixes new exchanges only; existing $0 rows are indistinguishable from a real $0 without this review |
| Frozen stale-observed rows (FM-AUDIT-021) | Re-opens past snapshot rows frozen as observed over stale bank balances, so regeneration can correct them | #302 fixes new rows only; the frozen guard keeps old observed rows (PB-8-class repair) |
| PB-8 full-window regeneration | Stored history before each account's partial-history floor | Already noted under #232: deploying PB-8 rewrites only the next automatic window; a full window is a separate decision |

**Order (S2):**
1. Run data steps only **after** the B10 code deploy. The new code must be live, or a re-run writes the old semantics.
2. Run the **CoinGecko archive repair before the snapshot backfill re-run**, so the re-run values history against corrected closes.
3. Then the **restricted-cash snapshot repair** (FIN-E part 2).
4. The null-balance $0 review (FIN-A2) and the frozen stale-observed re-open (FM-AUDIT-021) also run before the PB-8 regeneration, so it rebuilds against corrected inputs.
5. Run the **PB-8 full-window regeneration last**, after all of the above.

## Beyond B10: carried from ROADMAP (2026-11-03)

*Carried from `docs/plans/ROADMAP.md` (deleted 2026-11-03; recover with `git log -- docs/plans/ROADMAP.md`). Verbatim, except that DF-6's per-transaction details (merchant names, amounts, dates from the owner's accounts) are redacted under the public-repo rule; the original is in the owner's private record. Session 1 carries these into the post-B10 STATUS "Beyond B10 / outstanding obligations".*

### v3.0 — Launch (L-1) — **not started**

Billing/subscription; onboarding funnel; counsel-reviewed legal/compliance posture; tested backups + incident response + alerting; support tooling; accessibility/perf polish. **Zero new product surface.** Production Plaid is already live, so that line of the July text is retired.

**Exit:** a stranger can pay, connect a bank, share a Space with a partner, and be supported and recovered.

**DF-6 — Historical Production Duplicate Cleanup — DEFERRED, unscheduled.** Retire the three historical duplicate lineages left in production by the 2026-07-22 reconnect re-pull that predates DF-4 (transaction details redacted). Extend the DF-5 repair pattern: dry-run by default, `--apply` to write, soft-delete only, abort on shape mismatch, idempotent, scoped to the three proven `(date, amount, raw descriptor)` lineages; retire the later row of each pair. No commit has referenced DF-6 since August. **Not to be executed during a release window**, and not before the cutover's own duplicate-identity preflight (which measured 0 duplicate PLAID identities on 2026-10-06 — a different check; the three lineages are economic duplicates, not identity duplicates).
