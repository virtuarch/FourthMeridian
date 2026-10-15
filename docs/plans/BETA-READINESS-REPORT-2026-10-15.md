# BETA IMPLEMENTATION — READINESS REPORT (2026-10-15)

**Program:** invite-only beta implementation (owner authorization 2026-10-15: every REQUIRED + RECOMMENDED item of the [decision matrix](BETA-OWNER-DECISION-MATRIX-2026-10-15.md); [analytics design](BETA-PRODUCT-ANALYTICS-DESIGN.md); RWA-2 per [the design](RWA-2-ASSET-VALUATION-HISTORY.md) with the owner's 2026-10-15 rules) · **Branch:** `v2.6` · **Coordinator:** the consolidated lead session (after the crash of the two previous coordinating sessions; [recovery inventory](BETA-CRASH-RECOVERY-INVENTORY-2026-10-15.md)) · **Contract:** [coordination](BETA-IMPLEMENTATION-COORDINATION.md) · **State of record:** [`/STATUS.md`](../../STATUS.md) §3, §6, §11, §13, §14.

**Production:** untouched. No deployment, migration, seed, configuration, credential or data change on Production. Everything below is Dev-built, locally gated, and Preview-deployed/verified only as §7–§8 state.

**Evidence labels:** VERIFIED = run or read by the coordinator (output in hand) · AGENT-REPORTED = stated in an agent hand-off and not independently re-run · NOT VERIFIED = not exercised.

---

## 1. Recovered work (crash of 2026-10-15)

Both coordinating sessions (beta implementation; real-world assets) and their background agents stopped mid-flight (machine crash + account usage limit). Nothing was lost that was committed; everything uncommitted was found intact in its worktree and finished by freshly briefed agents. The read-only inventory is the [recovery inventory](BETA-CRASH-RECOVERY-INVENTORY-2026-10-15.md). In short:

| Found | State at recovery | Disposition |
|---|---|---|
| W2a (Plaid C1/C2/C4/C7′), RWA-1 | merged on `v2.6` before the crash | kept |
| W1 (nav Phase A+B) | committed on `beta/w1`, verification interrupted | 8 pinned tests + tsc re-run green → merged `4ee624c` |
| RWA-2A | committed `444f296`; its full gate was lost with `/tmp` | gate re-run: one ratchet red (data-entry date input), exempted by name → merged `a5727b0` |
| W4 V3 + CS roll-up | committed; V1 half-written, uncommitted | agent finished V1 + built V2 → merged `2fb270e` |
| W2b | 26 files uncommitted, untested | agent verified, fixed six defects in the inherited work (dead unpriced branch in the chat route; no Brief message; `systemDb` under `lib/ai`; a `$` literal; status mismatch; a widget-URL pin), committed → merged `836f696` |
| W3 | first half uncommitted (events, writers, A7 cleanup) | agent fixed one inherited type error (`brief.day` → `briefDay`), built readers, route, CS roll-up, retention job → merged `75a69f0` |
| RWA-2B | not started | agent implemented under the owner's rules → merged `6d1a491` |
| Dev DB | Docker daemon down after the crash; container healthy on restart; no data loss observed | both beta migrations applied with backups |

## 2. Completed features (what the beta now does)

**UX P2 navigation (N1–N4).** Header context switch `[ Personal Spaces ] [ Platform Spaces ]` shown only on a server-counted active grant (fail-closed, display only); `/dashboard/platform` is the one directory of granted HQ Spaces; the HQ group left the personal launcher; on the Platform axis the sidebar leads with granted areas, one "Personal Spaces" exit, site nav retained. No cookie, no auto-open, no server authorization change.

**Plaid economics (C1, C2, C4, C7′).** `PlaidItem.plaidEnvironment` (nullable, no backfill; unknown priced as a floor, sandbox excluded); Investments priced only when consent is ENABLED; the duplicate gate refuses a fresh link to any non-revoked Item of the institution and names the re-link target; a daily job retries unconfirmed removals through the one removal path; a connection cap (`maxConnections`, BETA 10 / ceiling 25) on fresh links and new wallets with a customer-readable 403.

**AI economics + safeguards (C6, C7).** Fleet AI spend allocated by surface from `AiInvocation` (customer = chat + brief; harness/unattributed = overhead; unpriced counted by name, never $0; every figure an estimate, never a bill); `ai-spend-high` alert over trailing-24 h fleet and max-per-customer estimated USD against `ai_spend_alert_fleet_usd_24h` ($10) / `ai_spend_alert_user_usd_24h` ($3), both configurable through the validated setting path (invalid ⇒ default, reported), firing also on any unpriced invocation; per-customer daily allowance (`aiDailyUsdAllowance`, BETA $5 / ceiling 20, through `entitlementsForUser`) refused in the chat and Brief routes after pacing and before any model work (429, `AI_ALLOWANCE`; a limit below 1 refuses; unknown spend refuses first); the provider chokepoint refuses an unpriceable model before the call with a FAILED/`UNPRICED_MODEL` ledger row and both routes answer 503 in words; model-rate coverage test; read-only Cost safeguards group in Policies.

**Product analytics (A1–A8).** Five server-side product events on `AuditLog` (`SESSION_ACTIVE_DAY` inside the session-touch statement on the auth role; `SPACE_VIEWED`; `BRIEF_VIEWED` on a deliberate read, never a router prefetch; `TRANSACTIONS_VIEWED`; `MANUAL_ASSET_VALUE_UPDATED`), one `INSERT … WHERE NOT EXISTS` statement each, metadata = ids / kinds / UTC day; `WALLET_ADD` / `MANUAL_ASSET_ADD` normalised into the enum with address, name, balance and purchase price dropped; `REGISTER` / `EMAIL_VERIFIED` / `BETA_ACCESS_REQUESTED` store an email digest (A7); readers under `GET /api/platform/growth-revenue/product-analytics` (GROWTH_REVENUE READ): registrations; present vs engaged DAU/WAU/MAU beside sign-ins; returning; D1 / D7-window / D7-strict by weekly first-visit cohort with "not yet measurable"; feature adoption; onboarding funnel with abandonment; cost per engaged user (estimate; AI from chat+brief surfaces; Plaid Item-months, sandbox excluded); harness, cron, webhooks, operator actions never count; readers count distinct; 13-month retention job for product events only; Customer Success per-user roll-up (AI turns, est. USD, Items, last engaged, funnel stage).

**Platform Ops visibility (V1–V3).** Attention Required gains "User-impacting failures" (refresh FAILED/PARTIAL, AI FAILED/TIMEOUT/RATE_LIMITED/QUOTA counts, Brief failures, NEEDS_REAUTH) as a separate 24 h composition with opaque references only; Security Operations becomes one "Security posture" surface (Detections · Coverage · Notes) over the five shipped routes, with the anomaly key projected server-side to a kind + opaque digest (the raw login identifier / IP never leaves the process) and the login-failure pulse labelled as what it measures; Growth & Revenue gains the product-analytics surface over the frozen DTO.

**Real-world assets (RWA-1, RWA-2A, RWA-2B).** Real assets section (owner-only update/archive), add-asset entry points, estimate-horizon freshness (180/365 d; never the Space's anchor while a fed account is observed), `valuationSource: USER_ESTIMATE` to the AI and the Brief; append-only `AssetValuation` ledger + `ManualAssetProfile` acquisition facts; one pure valuation policy (recorded on anchor dates, linear modeled between, carried forward never extrapolated, nothing before acquisition / first anchor, purchase price an anchor only by opt-in, same-day latest `recordedAt` wins); dated POST/PATCH with the balance following the latest-dated anchor; `GET /api/accounts/manual/[id]/valuations` for the owner or FULL-link viewers only; per-asset history chart (recorded / modeled / carried); AI summary carries recorded valuations + a modeled-history descriptor; the history engine values a manual asset from its ledger (floor = first anchor; shared Spaces floored at the link date; modeled/carried days are estimated rows; frozen rows and membership guards untouched; automatic rebuilds behind `WEALTH_REGENERATION_ENABLED`); the Net Worth chart marks ledger-modeled days "Modeled between estimates"; a PERSONAL-Space owner who adds history or backdates a valuation is offered "Update past net worth?" — a dry-run preview (range, before→after) through the existing consent amendment route, applied only on explicit confirmation, never in a SHARED Space, no new write path; the AI's history tools carry `realAssetsModeled` as data and never call a modeled day observed.

## 3. Remaining issues and deliberate omissions

- **Allowance refusals write no audit row** (no fitting `AuditAction`; observable by response code + route log). Owner may add one post-beta.
- **Per-user spend alert names the largest customer per cycle** (opaque ref) plus a count of customers at/over; a second over-threshold customer has no key of its own.
- **Presence dedupe inference:** `SESSION_ACTIVE_DAY` is suppressed when another live session of the user was touched today; on the deploy day a session touched by the pre-beta code can suppress a user's first row (one-day artifact; readers union the sign-in day for presence).
- **`REGISTER` metadata still stores `username`** (the design's A7 named only the email).
- **Legacy manual assets keep floor = today** in history (byte-identical to before); the alternative (carry the legacy balance from `lastUpdated`) is one predicate away and would alter existing reconstructed rows.
- **`SnapshotAmendmentDay` records net worth only** (D-H5 needs a column — no migration made); the exploration sheet still labels modeled days "reconstructed"; asset↔loan linking is post-beta.
- **Frozen DTO proposals from W3 (not made):** `registrations.verified / acceptedTerms`; `RetentionCohort.measurable`.
- **Optional:** `sec_auth_posture` row label still reads "Authentication Posture" in seeded Spaces (policy label is seed-create-only).
- **Pre-existing, unchanged:** the `main` checkout's gitignored `tmp/` and `prototype/` trees make its own `tsc`/`next build` noisy; gates run on clean copies.

## 4. Branches and commits

`v2.6` local HEAD `0cabc50` = `origin/v2.6` `76853fe` + 48 commits (agent commits, `--no-ff` merges, coordinator fixes, STATUS records). Merge order as landed: RWA-1 `5f8821b` → W2a `a62f712` → W1 `4ee624c` → RWA-2A `a5727b0` → W4 `2fb270e` → W2b `836f696` → W3 `75a69f0` → RWA-2B `6d1a491`. Coordinator code commits: `6581950` (ratchet exemption, on the RWA branch), `959acba` (migration README), `ceb4eec` (base pins), `8551735` (Security posture wiring), `03ab658` (A2 event + Plaid-environment select), `ae7afa5` (foreground acceptance re-pin), `a6b1eed` (CONTROL-literal ratchet). Agent branches `beta/w1`, `beta/w2a`, `beta/w2b`, `beta/w3`, `beta/w4`, `rwa1/manual-assets`, `rwa2/asset-valuations`, `rwa2b/history` are fully merged; worktrees retained until the owner closes the program. Push: see §6.

## 5. Migration status

| Migration | Content | Repo | Dev | Preview | Production |
|---|---|---|---|---|---|
| `20261015100000_plaid_item_environment` | one nullable column, no backfill; rollback in README | ✔ | applied 2026-10-15 (`db:migrate:safe`, backup `backups/fintracker-2026-10-15T00-39-17-531Z.sql`) | applied 2026-10-15 (`db:migrate:safe`, backup `backups/postgres-2026-10-15T01-16-14-422Z.sql`) | **not applied — prohibited** |
| `20261015120000_rls_asset_valuations` | two additive tables, RLS account-subtree predicate, append-only grant; rollback in README | ✔ | applied 2026-10-15 (backup `backups/fintracker-2026-10-15T00-51-03-753Z.sql`) | applied 2026-10-15 (same run as above; grants verified: `fm_app` SELECT+INSERT on the ledger) | **not applied — prohibited** |

Both are old-client compatible and were applied on Preview ahead of the code push. Repository: 125 migrations. Seeds: `growth_product_analytics` present on Dev; Preview seed after the deploy (§7). No other seed, env or grant change.

## 6. Typecheck, lint, local CI, GitHub Actions

- Typecheck on the merged tree after every merge: 0 errors (VERIFIED; the only errors are in gitignored `tmp/` and `prototype/`).
- Lint: clean on every touched file (AGENT-REPORTED per workstream; coordinator files VERIFIED).
- Clean-copy `npm run ci` on `fec0bc9` (all but RWA-2B): architecture + site green; unit red on one ratchet and foreground acceptance 65/67 — both test-only, fixed (`a6b1eed`, `ae7afa5`), foreground standalone re-run 67/67 (VERIFIED).
- Clean-worktree production build (`next build`, own `npm ci`) at `fec0bc9`: compiled successfully (VERIFIED).
- **Final gate on `0cabc50`:** clean-copy `npm run ci` **PASSED** every job (VERIFIED): unit 729/729 files, typecheck, lint; architecture `npm ci` → `prisma migrate deploy` (both beta migrations on a throwaway `postgres:16`) → `db seed` → `audit:ci` 25 audits → RLS 34/34 · 98/98 · 72/72 · 20/20 · 67/67; site verify.
- **Final clean build on `0cabc50`:** `next build` from the detached worktree with its own `npm ci`: **compiled successfully** (VERIFIED).
- **Push:** `git push origin 0cabc50:v2.6` (`76853fe..0cabc50`, 48 commits). **GitHub Actions on `0cabc50`:** CI run **38665819614 `success`** — `test`, `Architecture audits`, `Public site (zero-authority boundary)` all success; STATUS drift guard run **38665819687 `success`** (VERIFIED from the runs).

## 7. Preview verification

**Deployment.** Vercel Preview `fintracker1-741d44d0l` built from the push, Ready, aliased to `preview-app.fourthmeridian.com` (Vercel Authentication in front). `/api/health` through the authenticated CLI: `{"status":"ok","db":"ok","commit":"0cabc50"}` (VERIFIED). Preview DB: both beta migrations applied before the push (§5); `scripts/seed-platform-spaces.ts` run once after the deploy — exactly one row added (`growth_product_analytics` on the Growth & Revenue Space; 103 → 104 section rows; five Spaces unchanged) (VERIFIED).

**Browser pass (owner's signed-in session; narrow 997 px window, then desktop 1568 px):**

| Area | What was exercised | Result |
|---|---|---|
| Platform navigation (N1–N4) | Header `[ Personal Spaces ] [ Platform Spaces ]` switch; `/dashboard/platform` directory lists the five granted areas with access level; HQ group absent from `/dashboard/spaces`; at desktop width the sidebar on the Platform axis leads with the five areas, one "← Personal Spaces" exit, site nav under a hairline; inside a personal Space no Platform nav | VERIFIED |
| Authorization | Context switch shown for the granted owner; directory entries open the Platform Spaces; personal Space untouched | VERIFIED for the granted path. A **denied** user (no grant, BALANCE_ONLY viewer, non-member) was not exercised in the browser — covered by the RLS acceptance suites in the gate (34/98/72/20/67) and the route gate pins |
| Platform Ops (V1) | Overview status board; **Attention Required → "User-impacting failures"** group (users affected 0 · 0 sources · 0 facts, four readers answered; five kinds listed) | VERIFIED |
| Security Ops (V2) | One "Security posture" surface: detections sentence (four inline detectors, no trip in the newest page), End-user auth feed, operator actions feed, sessions | VERIFIED |
| Policies / C7 | Read-only **Cost safeguards** group (two thresholds with provenance; allowance sentence "refused at the Conversations and Daily Brief routes"); Alert rules show **AI spend high · Enabled · never fired** (7 rules) | VERIFIED |
| Growth & Revenue (V3 / A1–A8) | Product analytics surface: registrations, **present · engaged · sign-ins** (daily 0 / 1 / 0; weekly 0 / 1 / 0; monthly 3 / 2 / 3), weekly cohorts with D1 / D7 window / D7 strict and "no denominator", onboarding funnel (5 registered → 5 verified …), feature adoption with frequency, **cost per engaged user $2.70 "estimate, not a bill"** with its derivation (AI $1.11 + Plaid $4.30 ÷ 2 engaged) | VERIFIED |
| Customer Success | Roll-up line per customer (`AI turns 30 d 4 · est. USD $0.13 · Items 1 · last engaged 3m ago · stage first ai turn`; dashes for absent) | VERIFIED |
| Analytics events + privacy (A2, A7) | After the pass, today's `AuditLog` on Preview: `SPACE_VIEWED` {actorType, day, result, spaceType}; `BRIEF_VIEWED` {actorType, briefDay, cached, result}; `MANUAL_ASSET_ADD` {accountId, currency}; `MANUAL_ASSET_VALUE_UPDATED` {accountId, actorType, result}; **no email, name, value, address or prompt**; 0 rows today whose metadata contains an email | VERIFIED |
| Presence (`SESSION_ACTIVE_DAY`) | **Not written today** for the owner: the session's last touch before the deploy was earlier today (an open tab polling under the pre-beta code), so the dedupe treated the day as already recorded — the deploy-day artifact named in §3; self-corrects from the next UTC day. The write itself is proven on the auth role by foreground acceptance 43/47 and the role's `WITH CHECK (true)` INSERT policy | VERIFIED mechanism; first live row expected 2026-10-16 |
| Real-world assets (RWA-1/2A) | Real assets section → Add asset (name, value, currency, **Value as of**, optional acquisition date / purchase price / opt-in) → asset created, today's snapshot regenerated (+$2 on Total assets); ledger row `2026-10-15 $2 USER_ESTIMATE` + profile (acquisition 2026-09-15, price 1); **Update value** backdated to 2026-09-20 → second ledger row, today's balance stayed $2 (latest-dated anchor); card shows "Your estimate · updated today", Value history chart with recorded dots and a dashed modeled segment; `GET …/valuations` 200 | VERIFIED. Caveat: the opt-in checkbox set through the automation tool did not reach React state (profile `purchasePriceIsStartingValue=false`); the backdated-update path produced the two anchors instead, so the opt-in path is covered by unit tests only |
| Historical net worth (RWA-2B) | After the backdated valuation the **"Update past net worth?"** dialog appeared with a real dry-run preview: "25 days between Sep 20, 2026 and Oct 14, 2026 · Net worth on Oct 14, 2026: −$77,164 → −$75,668", modeled-value explanation, **Keep history as recorded / Update past net worth**. Declined; `SnapshotAmendment` rows created: 0; Oct 13–15 snapshots unchanged (−77,164.15) | VERIFIED consent flow (preview-then-confirm, nothing written without consent). **Finding F1 below** |
| AI valuation explanation | One chat turn: "Your BETA-VERIFY test asset is currently valued at $2 … a user estimate, not an observed market price … valuationSource USER_ESTIMATE … $1 on 2026-09-20, $2 on 2026-10-15 … straight-line model between … modeled history, not actual market pricing … carried forward"; `POST /api/ai/chat` 200; `AiInvocation` rows `chat · RETURNED · gpt-5.1` with userId (priced model, allowance verdict allowed) | VERIFIED |
| Daily Brief | Brief regenerated and shown; freshness line "Manual updated today" (estimate horizon); `brief · RETURNED` ledger row | VERIFIED |
| Connections | Page renders with Connect institution / Add wallet / **Add asset**; the Plaid Item shows its freshness | VERIFIED render. **Connection cap (10) and the 403 were not exercised** (one Item on Preview) — covered by `connection-cap.test.ts` and the two route placement pins |
| AI spending limits | Allowance gate admitted a normal turn; **exhaustion ($5), the per-user/fleet alert firing and the unpriced-model 503 were not exercised live** — covered by allowance (35), model-rate-coverage (27), spend-by-surface (43) and alerts tests |
| Registration / onboarding | **Not exercised** (account creation on a non-local host is outside what this coordinator may do); the register/verify-email/access-request routes are covered by their unit tests and the audit-digest change is verified in code | NOT VERIFIED in browser — owner to run one invite end-to-end |
| Cleanup | Test asset archived through the UI (confirmation dialog); Total assets back to $86,541.74; its two append-only ledger rows remain on the soft-deleted account (by design) | VERIFIED |

**Finding F1 — amendment recomputes whole days.** The consent preview for a $1→$2 test asset reported a ~$1,496 change on Oct 14. The existing amendment engine (`snapshot-amendment.ts`, pre-beta) rebuilds every component of each day from today's data (the proposal's "you cannot subtract one account's slice"), so the preview includes re-valuation of investments, cash walk-back and FX, not only the asset. The flow is honest (the figures are shown and nothing is written without consent) and the behaviour pre-dates this program, but a beta user adding a small asset may be surprised by the magnitude. Recommendation: owner decision — either accept with a wording addition in the dialog ("past days are rebuilt from today's data for every account, not only this asset") or defer the offer until the amendment engine can amend one account's slice (needs the D-H5 column and engine work; post-beta). Not a blocker for an invite-only beta because consent is explicit and the default keeps history as recorded.

**Not verified on Preview:** the mobile bottom-bar presentation of Platform Spaces (N5, post-beta by decision); crons (Vercel crons never run on Preview — the two new daily jobs and `ai-spend-high` will first run on Production); wallet rows (no wallet on Preview); a second concurrent device for the presence dedupe.

## 8. Security and privacy findings

- **Fixed in this program:** raw email in `REGISTER` / `EMAIL_VERIFIED` / `BETA_ACCESS_REQUESTED` audit metadata → digest; wallet address, asset name, balance, purchase price in audit metadata → dropped; the Security Ops anomalies route returned the detector's raw key (login identifier or full IP) under a comment calling it coarse → projected to kind + opaque digest server-side; `lib/ai` held a `systemDb` import in the inherited W2b work → moved under `lib/platform`.
- **Authorization preserved:** every new platform route starts with `requirePlatformAccess(area, "READ")`; the context switch is display-only (`[area]/page.tsx` and `/api/spaces` remain the authorities); valuation history is served to the owner or FULL-link viewers only (BALANCE_ONLY → 404); the amendment route stays OWNER-only, PERSONAL-only, consent-gated; the connection cap and allowance fail closed.
- **RLS:** both new tables ENABLE + FORCE with the account-subtree predicate; `AssetValuation` append-only by grant; the presence row is written by the auth role with INSERT only (proved by foreground acceptance 43/47; the role still cannot read the trail, check 66).
- **Tenant isolation:** product-event dedupe reads the user's own rows; fleet readers are identity-minimised (no email, username, userId, Space name in any response); per-user figures only in Customer Success.
- **Residual:** the presence inference and `username` in `REGISTER` metadata (§3); the anomaly digest is a 24-bit correlation handle, not a secret.

## 9. Owner-only actions

1. **C10 — contracted vendor pricing.** Confirm the Plaid plan and obtain the contracted price sheet; replace the invoice-derived rates in the cost census (today's rates are one invoice's quotients; no public sheet exists). Confirm the OpenAI account/project split per environment so the bill can be split and harness traffic separated at the source (today one account spans Dev/Preview/Production; the ledger separates by surface, the invoice does not).
2. **Thresholds and limits** are provisional ($10 fleet / $3 per user / $5 allowance / 10 Items) and configurable: thresholds via the validated admin setting path, limits via the entitlement catalogue (code). Review after the first beta week.
3. **`WEALTH_REGENERATION_ENABLED`** on Preview/Production decides whether automatic 30-day rebuilds include ledger-valued real assets on estimated rows; the consent path works regardless.
4. **DTO extensions** proposed by W3 (§3) and the `sec_auth_posture` label (§3) are owner calls.
5. **Production** (§10): every step needs explicit authorization.

## 10. Production readiness and deployment checklist

Production still serves the July build (`87e4df7` on `main`, 88 migrations, no RLS); the v2.6 cutover plan ([production-cutover-plan.md](../operations/production-cutover-plan.md)) is NO-GO until its §6 preflight gates and §8 issues are green. This program adds to that plan, in order, all owner-authorized:

1. Confirm GitHub CI green on the exact SHA to deploy and Preview verification (§7) complete.
2. Back up Production (`db:backup` against `DIRECT_URL`) and record the file.
3. Apply the pending migrations with `db:migrate:safe` (now 37 pending: the cutover plan's 35 + the two beta migrations, all additive; the two beta READMEs carry rollbacks).
4. Run `scripts/seed-platform-spaces.ts` once (idempotent) so `growth_product_analytics` reaches the Growth & Revenue Space.
5. Set/confirm env: `PLAID_ENV=production` (already), `PLATFORM_ALERTS_EMAIL` (absent on Production today), `WEALTH_REGENERATION_ENABLED` per the owner's choice, `NEXTAUTH_SECRET` / `CRON_SECRET` rotation per the cutover plan.
6. Deploy; read `/api/health` for the commit; verify the first `evaluate-alerts` run (the `ai-spend-high` rule is live by registry) and the two new daily jobs' first `JobRun` rows.
7. Verify with a real account: registration (email digest in audit), onboarding, Platform directory (grant-gated), Space authorization, an AI turn (allowance verdict), a Plaid link attempt beyond the cap (403), a manual asset with history (preview → consent), Growth & Revenue analytics and Customer Success roll-up.
8. Rollback: redeploy the previous build; the two beta migrations are additive and may stay or be dropped per their READMEs.

## 11. GO / NO-GO for the invite-only beta

**GO — for an invite-only beta on Preview-proven code, with the owner actions in §9 and the Production checklist in §10 still ahead.** Grounds: every approved workstream is merged, gated green on a clean copy of the exact pushed SHA, green on GitHub, built clean, deployed to Preview and exercised in a real session across navigation, authorization (granted path), Platform Ops, Security Ops, analytics, privacy, real-world assets, valuation history, the consent flow and the AI. Both beta migrations are on Dev and Preview with backups and rollbacks. Conditions: (1) the owner runs one invite registration end-to-end on Preview (the one flow this coordinator could not); (2) the owner rules on Finding F1 (accept with wording, or hold the offer); (3) Production stays untouched until the cutover plan's own gates are green and the §10 steps are explicitly authorized.

---
*Every result above was read from the run, the database or the browser by the coordinator unless marked AGENT-REPORTED or NOT VERIFIED.*
