# 19 — A1d, A6, Preview deployment, D12/D14 and A7 browser validation

**Date:** 2026-10-22 19:40 → 2026-10-23 (UTC).

**Authorised:**
- A1d (push the A5 docs) and A6 (merge PR #1 into `v2.6`);
- the Preview validation campaign (A7), with fixes in Preview scope;
- D12/D14 assessment.

**Not authorised and not done:**
- anything in Production;
- a merge into `main`;
- GitHub-secret or Vercel-env changes;
- paid resources.

## 1. Git and CI

| Step | SHA | Evidence |
|---|---|---|
| A1d push | `7d38bf5` | `1ca3085..7d38bf5`. The commit holds docs only (4 files, secret-scanned). |
| **Unexpected red on A1d** | `7d38bf5` | Both `test` jobs failed in 28 s at the `npm audit --omit=dev --audit-level=high` gate. **Advisories published 2026-10-22** cover the installed versions:<ul><li>`next` 16.3.8: GHSA-2464-fhr4-w9xw (unauthenticated RCE, image optimisation with SVG), GHSA-673q-mjm6-r5xr (RCE, `use cache`), GHSA-p3m5-59mp-jv5r (DoS). Patched in 16.4.1.</li><li>`@sentry/nextjs` 10.67.0: GHSA-mchm-gjx6-7h55 (middleware bypass via the tunnel route; not configured here).</li></ul> |
| Fix | `32114c9`, `a72a83d` | `next`/`eslint-config-next` 16.4.2. `@sentry/nextjs` and `@sentry/core` pinned to exactly 10.76.2 (the capture boundary requires the exact pair). The audit gate is clean except the known moderate `uuid`/`exceljs` (D10). |
| Flake found in the local gate | `a72a83d` | `pre-login` case 5 (11th request → 429) fails when the loop straddles a minute boundary: `lib/rate-limit.ts` windows are minute-aligned. The test now holds `Date.now` mid-window. Product behaviour is unchanged. |
| Local gate | `a72a83d` | `FM_CI_PG_IMAGE=postgres:17.6 npm run ci`: **PASSED** (unit 830/830, 28 audits, all RLS suites). |
| PR #1 checks | `a72a83d` | `test` ×2, `Architecture audits` ×2, `Public site` ×2, `status-drift-guard` and Vercel: pass. `Deployment health`: **fail = UNVERIFIED** (`HTTP 401 → UNVERIFIED`, Vercel protection; not relabelled). The PR build was verified **HEALTHY** with the bypass, including the `scheduler` block. |
| **A6 merge** | **`0773008`** | `gh pr merge 1 --merge --match-head-commit a72a83d` at 20:10:23 UTC. `main` untouched (`87e4df7`). |

**A6 gates checked immediately before the merge:**
- Preview at 135 applied / 0 bad.
- The PR build is HEALTHY.
- The Production deployment is unchanged (`dpl_JcZ52…`, `87e4df7`, 2026-07-27).
- `v2.6` has **no branch protection or rulesets**, so no bypass was involved. The absence is a governance gap (D2), not a pass.

**Follow-up merges into `v2.6` (each a PR with CI; see §5):**

| PR | Merge | Content |
|---|---|---|
| #2 | `d191968` | Deployment-health defects (§2) |
| #3 | `1a38f6b` | Shared-Space creation under strict RLS (§5, BUG-1) |
| #4 | `7d1cee7` | Invite rescind is confirmed and audited (§5, BUG-3) |

## 2. Preview deployment (Phase 3)

| Check | Result |
|---|---|
| `v2.6` deployment READY | `dpl_B9yvYcda…` (`0773008`), later `dpl_8CfSmeHS…` (`1a38f6b`). The `preview-app` alias follows `v2.6`. |
| `/api/health` | 200 `{"status":"ok","db":"ok","scheduler":{lastDispatchAt 2026-10-07…, overdueJobs:1, alertEvaluatorOverdue:true}}`. **No `commit`** (OPS-014). The scheduler is overdue **because crons are Production-only**; Preview has never run one (G0a open). |
| Trusted deployment health, first real run | `0773008`: **false green found.** The run probed only the site, because the app's GitHub deployment appeared minutes later and the wait ended at "something seen, nothing pending". |
| Smoke on GitHub's `vercel-probe` deployment | **Wrong target found.** The `environment: vercel-probe` job creates a GitHub deployment whose URL is the Actions run, and `post-deploy-smoke` probed `github.com/…/api/health` → UNHEALTHY 404. |
| Fix (PR #2, `d191968`) | The app target is now required. The smoke job runs only for `vercel[bot]` deployments. Tests: trusted 8 → 12, smoke 32 → 33. |
| After the fix | `d191968` and `1a38f6b`: the trusted run waited for the app, and `Preview – fintracker1` was **HEALTHY**. Only the secret-free UNVERIFIED smoke remains red, by design. |
| Login, MFA and role boundaries | A7 §4 (rows A, B, I). |
| Logs | Vercel runtime logs read after each probe. One error class found: BUG-1 (`POST /api/spaces` 500, 42501), fixed. No other unexpected errors. |
| Production | Unchanged: latest Production deployment `dpl_JcZ52…` (`87e4df7`); `fourthmeridian.com` 200. No Production DB connection was made. |

## 3. D12 and D14 (Phase 4)

**D12: full isolation is not achievable with existing free resources without owner action.** It needs a second database:
- Option A: the owner creates it, because it requires a password entry and the Marketplace-managed org may inject env vars into linked projects.
- Option B or C: paid.

The interim from doc 17 §4 stands: branch builds run under strict RLS role URLs. **Nothing was repointed.** Decision D12 remains with the owner.

**D14: verified without reading any secret value.**

| Provider | Method | Result |
|---|---|---|
| Plaid | `GET /api/plaid/link-token` as the owner (creates a Link token; touches no Item) | Token prefix **`link-sandbox`** → Preview's Plaid credentials are **Sandbox**. No existing Item was refreshed. |
| OpenAI | `/api/platform/platform-ops/env-status` (value-free report) | Service-account key (project-scoped), pinned to **`proj_AfGY4a8iUSURSWLBNPgJCbDr`**, guard `match · preview`. That id is the owner-recorded **`fourth-meridian-preview`** project (`openai-environment-separation.md` §8), not Production. 17/17 env keys pass. |
| AI spending controls | Read model + H5 | Kill switch works: paused ⇒ refusal with no provider call. Restored to the original `false`. The per-project OpenAI spend limit ($5 alert / $15 hard planned) is **not readable** from here (owner, G5a). |
| Resend | env report | `RESEND_API_KEY` is set on Preview, so delivery is real. Its key identity vs Production is unreadable (Sensitive). E-mail rows used only Resend's test sink `delivered+…@resend.dev` and `@example.test` accounts. **No real customer was e-mailed.** |

## 4. A7 results

**Method.**
- **HTTP harness** (`~/fm-rehearsal-private/a7/`, outside the repository):
  - NextAuth credential sign-in against `preview-app` with the automation-bypass header;
  - four seeded test accounts (`a7-20261022-{t1,t2,t3,adm}`, `@example.test`, mirroring the invited-registration transaction), credentials in a 600 file;
  - TOTP computed from the enrolment secret the app returned.
- **Browser** (Claude-in-Chrome) on the owner's existing Preview session: UI, error states, keyboard, mobile. No credentials were typed into the browser.
- **AI:** 11 model calls in total (4 chat turns + 1 Brief, with tool hops and guidance), all on the Preview OpenAI project.

| # | Expected | Observed | Verdict |
|---|---|---|---|
| A1 | Wrong password generic; correct signs in | `pre-login` identical for a wrong password and an unknown user; session USER; `/dashboard` 200 | PASS |
| A1-TOTP | Enrolled: TOTP required; wrong or missing code refused | `totpRequired:true`; no code / `000000` refused; correct code → `/admin` 200 | PASS |
| A2 | Sign-out clears the session | session `{}`; `/dashboard` 307 → `/login` | PASS |
| A3 | Reset request does not enumerate | Identical 200 body for an existing and an unknown address | PASS |
| A4 | Reset link single-use | Token only in the e-mail | **BLOCKED** |
| A5 | Revoking a session signs that device out | API 401 immediately; pages render for ≤ 30 s (by design, `SESSION_CACHE_TTL_MS`), then 307 `/login` with no data; self-revoke needs `confirmSelf`; double revoke 400 | PASS (note N1) |
| A6 | Export includes AI memory and Briefs | zip: `data.json` has `aiMemory`, `dailyBriefs` (+ csvs) | PASS |
| B1 / I1 | Un-enrolled admin forced to setup; **forged `update()` cannot lift it** (SEC-001) | `/admin` and `/dashboard` → `/admin/security?setup2fa=true`; API 403; after `update({requireTotpSetup:false})` the hint stays `true` and access stays refused | PASS |
| B2 | Enrol TOTP | QR + secret; verify 200; 10 recovery codes | PASS |
| B3 | Recovery code single-use | First sign-in succeeds; reuse refused | PASS |
| B4 | Disable TOTP requires the current code | **Password alone disables 2FA** (200). The route documents "code OR password" | **FAIL** (BUG-4, P2, owner decision) |
| C1 | No public registration (`invite_only` default) | policy `invite_only`; no invite 403; forged invite 403 | PASS |
| C2 | Operator invite issued and delivered | 200 `emailStatus:"sent"`; repeat safe; USER 403. Redemption: token only in the e-mail | PASS (issuance) / **BLOCKED** (redeem) |
| C3 | Verify link single-use | Token only in the e-mail | **BLOCKED** |
| C4 | Case-insensitive username | UPPER-case username → same user | PASS |
| C5 | Consent required | Without consent 400; with consent 200; UI has notice + checkbox | PASS |
| D1 | Create + switch Space | **First run: 500** (BUG-1). After PR #3: create 201, switch 200, non-member 403 | PASS after fix |
| D2 | Invite/accept/roles/remove | Pre-membership 403; duplicate invite 409; VIEWER read-only (PATCH/invite 403); owner re-roles; self-promote 403; cannot remove owner; removal → 403 immediately | PASS |
| D3 | Archive / restore | 200 / 200; data intact | PASS |
| D4 | Section edit; > 120 chars refused | 400 "at most 120"; rename and disable persisted; non-member 403 | PASS (N2) |
| D5 | Failed read ⇒ error state with Retry | Injected 500 → "Couldn't load cash flow activity … not a sign your data is gone" + Retry; Retry recovers | PASS |
| D6 | `/dashboard/credit` 404 | 404 | PASS |
| E1 / E2 / E4 | Plaid Sandbox connect, refresh, disconnect | Requires typing Sandbox credentials into Plaid Link in the browser, which this session does not do. Sandbox status proven by D14 | **BLOCKED** (owner, ~5 min) |
| E3 | Manual asset + public wallet | Manual 201 (vehicle); BTC public address 201, initial sync ok | PASS |
| F1 | Late paycheck ⇒ "incomplete estimate" | Cash Flow renders and reconciles (In $500.00 − Out $117.46 = +$382.54; categories sum to $195.96). **Preview has no payroll data**, so the FIN-001 path is unobservable | **BLOCKED** (data) |
| F2 | Category correction moves totals | Override Other → Groceries persisted in the Space feed; invalid 400; other user 404 | PASS |
| F3 | Debt payoff; unknown APR principal-only | 6 liabilities sum to $163,705.89; every one "interest unknown — never 0%"; payoff "payments only" | PASS (read path; APR write not exercised on owner data) |
| F4 | Period picker | "Last 90 days" → `preset=PAST_QUARTER`, labels follow; 0 console errors | PASS |
| G1–G4 | CSV import, duplicate, rollback, bad files | 6 rows; concurrent duplicate **409/409**, sequential 409 with batch id, still 6 rows; rollback 0 rows, re-import 201; other-user rollback 404; malformed 400 with message; 400k-row 413; other user 404; no PROCESSING batch left | PASS |
| H1 | OpenAI disclosure | "Processed by OpenAI · About" + not-advice | PASS |
| H2 | Spend answer consistent with Cash Flow | AI "September Dining $516.33" = Cash Flow September Dining $516.33 (honest groceries/dining caveat) | PASS |
| H3 | Tool-backed payoff | Feb 2054 at $500/month (= $163,706 / $500 ≈ 327 months); states payments-only lower bound | PASS |
| H4 | Brief renders, no retry storm | One `POST /api/brief/generate` 200; cached Brief reused (0 new model calls); stale-source banner | PASS |
| H5 | Kill switch | ON (admin, reason TESTING) → "AI features are paused … Nothing was changed", no `AiInvocation` row; OFF → answers again (−$77,164 = Overview) | PASS |
| H6 | One provider round-trip per hop | Ledger: per hop one RETURNED row, `tool_calls` → `stop`, 0 errors, 0 retries | PASS |
| I-RBAC | USER blocked from admin/platform; no self-grant | `/admin` → `/dashboard`; admin API 403; platform 403; self-grant 403 | PASS |
| I2 | Admin search; audit hashes e-mails | Search 4/4 test users; addresses appear only as the joined actor `user.email`, never in metadata | PASS |
| I3 | Grant / revoke via admin; tenant cannot self-grant (SEC-014) | READ grant → read 200, write 403; revoke → 403; self-grant 403 | PASS |
| I4 | Double-approve does not double-approve | Concurrent approve 200/200, repeat 200: approve is also "resend" (rotates the token, re-sends). IDEMP-011 (REDEEMED guard) holds. A double click sends two e-mails and kills the first link | **FAIL** vs matrix (BUG-5, P3) |
| I5 | Alert posture shows age / stale | `lastEvaluatedAt 2026-10-07`, rules listed, stale surfaced | PASS |
| I6 | Policies: non-operator cannot write | Operator GET 200; USER PATCH 403 | PASS |
| I7 | Merchant-ops fixed message | Malformed 400 "verdict must be MERGED or DISMISSED"; USER 403 | PASS |
| J1 | Markets "Coming soon" | "Markets — Coming soon"; 0 console errors | PASS |
| K1 / K4 | Site pages, robots, sitemap, OG | All 200, `noindex`, `Disallow: /`, sitemap and OG present, 0 broken home links | PASS |
| K2 | `/legal/ai` lists OpenAI processing | Present (counsel review pending: legal gate) | PASS |
| K3 / K5 | Request access; mobile | Site hands off to the app form (zero-authority); form has notice + consent; 500 px: no horizontal scroll, menu collapses | PASS |
| P-DEL | Account deletion | Wrong password 401; deletion scheduled (7 days), session ended, sign-in refused with `pending_deletion` | PASS |
| UX-MOB | App at 500 px | No horizontal scroll; bottom nav + switchers | PASS |
| UX-KBD | Dialog keyboard / focus | `aria-modal`, focus moves in, Escape closes, focus returns to the (keyboard-operable) chart | PASS |
| UI-003 | Destructive actions confirmed | Member remove / role: confirmed. **Rescind invite was one click, hard delete, no audit** (BUG-3). **Retest on `7d1cee7`:** modal "Rescind <invitee>'s invite?" with the consequence; Escape cancels, invite kept, focus returns to the trigger | PASS after fix (N3) |

**Counts (final, after fixes and retests):** **49 PASS · 2 FAIL · 7 BLOCKED** at 2026-10-22. **Updated 2026-10-23 (doc 23): 58 PASS · 0 FAIL · 0 BLOCKED**. B4 fixed in PR #8 and I4 in PR #9, both verified live; A4, C2-redeem, C3 and F1 executed; E1/E2/E4 owner-verified.
- FAIL: B4 (P2, owner decision), I4 (P3).
- BLOCKED: A4, C2-redeem, C3, E1, E2, E4, F1.

**Notes.**
- **N1:** revocation is immediate for APIs and sensitive actions, but **up to 30 s for server-rendered pages** on another instance (per-instance cache, by design).
- **N2:** every live template now plans **0 sections**, so new Spaces have none. D4 was run on a seeded test section.
- **N3:** `ConfirmDialog` does not move initial focus into the dialog (the drawer does). P3 a11y.

## 5. Bugs found and fixed

| ID | Severity | Defect | Fix | Evidence |
|---|---|---|---|---|
| BUG-0 | P0 (security, supply chain) | `next` 16.3.8 and `@sentry/nextjs` under critical advisories published 2026-10-22 | `32114c9` + `a72a83d` (next 16.4.2, Sentry 10.76.2) | CI audit gate green |
| BUG-1 | **P1** | **Every `POST /api/spaces` → 500 under strict RLS** (42501). Prisma `space.create` = INSERT … RETURNING; RETURNING is judged by the SELECT policy; the Space is invisible until its OWNER membership exists. Pre-existing since RLS slice B; no test covered it. Reproduced on Preview as `fm_app` in rolled-back transactions | PR #3 `1a38f6b`: `lib/spaces/create-shared-space.ts` (`createMany` without RETURNING → membership → read back) | `rls:accept:foreground` 67 → **71/71** (negative control reproduces the bug); D1 PASS live |
| BUG-2 | P2 (release tooling) | Trusted health false green (app never probed); smoke probed GitHub's own `vercel-probe` deployment | PR #2 `d191968` | Trusted run HEALTHY on the app at `d191968` and `1a38f6b` |
| BUG-3 | P2 | Rescind invite: one click, hard delete, unaudited | PR #4 `7d1cee7`: `ConfirmDialog` in both surfaces; `MEMBER_INVITE_CANCELLED` in the same transaction | UI-003 test +8; unit 830/830; browser retest PASS |
| BUG-4 | P2 | TOTP disable accepts the password alone | **Not changed**: auth-policy decision (D16) | B4 |
| BUG-5 | P3 | Double-clicked approve sends two invites; the first link dies | Deferred | I4 |
| T-1 | test | `pre-login` per-IP case flaky at a minute boundary | `a72a83d` | local gate |

## 6. Data and side effects on shared Preview (all test-scoped)

- **Created:**
  - 4 test users (`a7-20261022-*`, `@example.test`), each with a personal Space and agent;
  - 1 shared Space "A7 Shared Space" plus one seeded section;
  - manual accounts "A7 Import Target" and "A7 Car", and BTC wallet "A7 Genesis (public)";
  - one completed import (6 rows; 1 corrected to Groceries) and its rolled-back and failed batches;
  - Beta requests / invites to `delivered+a7c2@resend.dev` and `delivered+a7c5@resend.dev` (approved);
  - one READ grant (revoked).
- **t2:** scheduled for deletion on 2026-10-29. The purge cron does not run on Preview.
- **adm:** the SYSTEM_ADMIN test account was **deactivated** after A7 (14 sessions revoked). Reversible.
- **Owner data:**
  - one pending invite in "Debt Mitigation" was hard-deleted by the BUG-3 one-click, and **was restored byte-identical from the verified pre-A5 dump** (`cmqqls0ra…`, PENDING ADMIN);
  - one Daily Brief was generated by loading `/dashboard/brief` before D14 had verified the OpenAI project (1 call, about 3.4k tokens, `fourth-meridian-preview`);
  - 4 chat turns were made in the owner's Space.
- **Settings:** `ai_paid_requests_paused` was toggled `false → true → false` (audited, reason TESTING). No other setting changed.
- **Diagnostic probes:** rolled-back transactions only (`a7probe-*`); 0 rows persisted (verified).
