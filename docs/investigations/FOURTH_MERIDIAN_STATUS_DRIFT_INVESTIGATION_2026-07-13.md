# Fourth Meridian — STATUS.md Drift Investigation (Full-Document Audit)

**Date:** 2026-07-13
**Type:** Investigation only — no STATUS.md edits, no code changes
**Auditor baseline:** working tree at `ac40700` (`feature/v2.5-spaces-completion`, HEAD at time of audit), full history (`git log --all`, 505 commits), all 40 Prisma migrations, root + `docs/` investigation corpus
**Trigger:** the 2026-07-13 spot-check that found TI2 (capture-at-write foundation) fully shipped with zero STATUS.md mention, which caused a downstream investigation to mis-assess Receipt Intelligence as blocked on already-landed work
**Scope:** every discrete status claim in STATUS.md (all 11 sections + header + Verification + Current focus), cross-referenced against git history, migrations, and current source — not against the document's own prose

---

## 1. Executive summary

**Headline: the drift is systemic, one-directional, and concentrated in the ledger/register sections.** STATUS.md's header says "Last verified 2026-07-06, against the working tree post-`f22de52`" (STATUS.md:9). **235 commits have landed since that checkpoint** (201 since 2026-07-07 alone — `git rev-list --count f22de52..HEAD` = 235). The document *was* amended piecemeal after 07-06 — but only its narrative sections (§Verification bullets, Current focus) were touched (`ef6227e` +20/−4 on 07-06, `e40be9b` +9 on 07-08, `33c927e`/`05488be` on 07-12, `db5665a`/`ce0594e`/`ff17833` +11/−1 on 07-13). **§1 (overview), §2 (current version), §3 (initiative ledger), §4 (track table), §6 (production readiness), and §7 (defects register) have not been re-verified since 2026-07-06/07** and now contradict both the codebase and, in several places, the document's own newer bullets.

Counts by category (each item detailed in §2–§5 below):

| Category | Count | Severity read |
|---|---|---|
| **False negatives** (says Open / Planned / deferred / doesn't exist — actually shipped) | **8** | Highest risk — includes an active *recommendation to start work that already landed* (MI2 S1) |
| **Stale citations** (right conclusion, outdated evidence/paths/dates) | **8** | Low individually; collectively erode trust in the file's citations |
| **False positives** (says Fixed & committed — fix absent/reverted) | **0** | None found across a 16-item spread of spot-checks, oldest (D1, 2026-06-22) to newest (shell-nav, 2026-07-13) |
| **Missing entries** (shipped initiatives with no ledger row at all — the TI2 class) | **12** | Includes TI2 itself, two entire OPS initiatives (OPS-2, OPS-3), and an entire un-allocated initiative track (A1–A10) with 5 migrations |

**Overall severity: systemic, not contained — but asymmetric in a specific, important way.** Every drift item runs in the same direction: *reality is ahead of the document*. Not one sampled "Fixed & committed" claim was false; every cited commit hash (75/75) exists in history with a subject matching its claim. So the file does not create false confidence in unshipped work — its failure mode is exactly the TI2/Receipt-Intelligence class: **wasted rediscovery and mis-prioritization from a stale baseline**. The single most dangerous live instance is the Current-focus recommendation to begin MI2 S1 (STATUS.md:64), which shipped five days before this audit.

---

## 2. False negatives (most dangerous class)

### FN-1 · MI2 is recommended as the next workstream — it shipped 2026-07-08 ⚠️ *highest severity*

- **STATUS.md claims:** §3 Other, STATUS.md:184 — "MI2 | Merchant Merge Review | **Planned** … S1 (Merge Core & CLI) — awaits its own ratification". And Current focus, STATUS.md:64: "**Recommended next workstream (product lane): MI2 S1 — Merchant Merge Core & CLI.** … the next product-lane step is to turn the one-off `scripts/merge-wgu-merchants.ts` into a reusable merge core (`lib/transactions/merchant-merge.ts`) plus a dry-run-default `merge-merchants` CLI … The next implementation prompt should be **MI2 S1 investigation / implementation planning**".
- **Actually true:** MI2 S1 **and** the S2 foundation landed on 2026-07-08, all ancestors of HEAD:
  - `15e71fd` "Add merchant merge utility" and `aac6435` "Add merchant merge core and CLI" — `lib/transactions/merchant-merge.ts` and `scripts/merge-merchants.ts` exist in current source (verified present).
  - `ab04607` "feat(mi2): add merchant merge review queue foundation and ratify FI0 doctrine" — `lib/transactions/merchant-merge-suggest.ts`, `merchant-merge-review.ts`, `merchant-merge-decisions.ts` (+ test files for each) exist in current source.
  - Ratification/investigation docs exist: `docs/initiatives/mi2/MI2_S1_MERCHANT_MERGE_CORE_CLI_INVESTIGATION_2026-07-08.md`, `MI2_S2_MERCHANT_MERGE_REVIEW_QUEUE_INVESTIGATION_2026-07-08.md`, `MI2_S2_OPS_SPACES_OWNERSHIP_REFINEMENT_2026-07-08.md`.
- **Risk realized if followed:** an implementation prompt would re-plan and potentially re-build a landed subsystem — the exact failure mode this investigation exists to catch.

### FN-2 · Drag/drop section reorder is called "deferred, not next" in three places — it shipped 2026-07-08

- **STATUS.md claims:** Current focus, STATUS.md:66 — "**drag/drop section customization** — now *enabled* by the standardized materialized-section model but intentionally not next"; §3 SP-x row, STATUS.md:159 next-milestone cell — "Drag/drop section customization (enabled by the section model, deferred)"; §5 v2.5, STATUS.md:223 — "drag/drop is now *enabled* … — deferred, not next".
- **Actually true:** `f0979ab` "Add drag and drop section reorder" (2026-07-08, ancestor of HEAD). Current source: `components/dashboard/SpaceDashboard.tsx:1883` ("Visible-surface reorder (UX-CUST-1A)" — drag handles on section cards) and `app/api/spaces/[id]/sections/reorder/route.ts` (+ its test) exist.

### FN-3 · KD-9 listed Open — Plaid `removed[]` soft-delete shipped, and STATUS's own D2.x block says so

- **STATUS.md claims:** §7, STATUS.md:318 — "KD-9 | Plaid `removed` hard-deletes transactions, contradicting D8 soft-delete rule | Low | v2.6b | **Open**"; §3 D8 row (STATUS.md:97 table) — "Known deviation: Plaid `removed` hard-deletes (defect KD-9)".
- **Actually true:** `lib/plaid/syncTransactions.ts:452–465` — "Integrity hardening: SOFT-delete (tombstone) instead of physical delete" via `updateMany({ …, data: { deletedAt: new Date() } })`, with resurrection at line 396–401 and a `REMOVED_TOMBSTONE` SyncIssue record. This is the D2.x "transaction-sync integrity hardening" that STATUS.md's own D2.x closeout block (§3/§5) records — an **internal contradiction**: the ledger row for D2.x says shipped, the defect register never closed KD-9.

### FN-4 · Rate limiting described as "off by default" in §1, §6, and §7 — production has been limited-by-default since OPS-1 S4 (2026-07-07)

- **STATUS.md claims:** §1, STATUS.md:81 — "rate limiting is implemented but off by default — see KD-3"; §6 blocker 3, STATUS.md:298 — "**off by default**. Must be enabled in production"; §7 KD-3, STATUS.md:312 — "limiter is **off by default** — `RATE_LIMIT_ENABLED` must be `true` in production … TOTP `setup`/`disable`/`recovery-codes` remain intentionally unlimited".
- **Actually true:** `lib/rate-limit.ts:73` — in production `return process.env.RATE_LIMIT_ENABLED !== "false"` (limited unless explicitly opted out); `lib/env.ts:122–124` — "RATE_LIMIT_ENABLED (OPS-1 S4 polarity): production is limited by default" with a validateEnv warning on the opt-out. The formerly-unlimited TOTP endpoints were closed by the same slice. STATUS.md's **own OPS-1 row (STATUS.md:190) records all of this correctly** — §1/§6/§7 were never reconciled. Another internal contradiction.

### FN-5 · KD-14 listed Open with a description that is now three-ways stale

- **STATUS.md claims:** §7, STATUS.md:323 — "KD-14 | Scheduler entrypoint never invoked; `run-ai-advice`/`sync-crypto` stubs; `AiAdvice` has never had a write path | High (blocks v2.6b) | v2.6b entry | Open".
- **Actually true:** `jobs/scheduler.ts` is deleted (OPS-4 S2 — STATUS's own OPS-4 row says "KD-14's 'entrypoint never invoked' limbo closed"); `jobs/run-ai-advice.ts` no longer exists on disk; `jobs/sync-crypto.ts` is no longer a stub — it is the working BTC wallet-sync body (header: "BTC wallet balance sync v1 — batch job body", invoked run-on-add and via manual re-sync, deliberately unregistered per `lib/jobs/registry.ts:43`). The only part of KD-14 still genuinely open is the `AiAdvice` write path. The row needs re-scoping, not just a status flip.

### FN-6 · §1 "What does not exist yet" denies the entire OPS-4 job platform

- **STATUS.md claims:** §1, STATUS.md:81 — "What does **not** exist yet: automated background jobs beyond one daily bank-sync cron (scheduler entrypoint never invoked; AI advice job is a stub)".
- **Actually true:** OPS-4 S0–S6 (complete 2026-07-07 per STATUS's own OPS-4 row) delivered a typed job registry + dispatcher + JobRun ledger + dead-job detection; `jobs/` now contains `fetch-fx-rates`, `fetch-security-prices`, `process-deletions`, `purge-trash`, `retry-notifications`, `sweep-rate-limits`, `sync-banks`, `sync-crypto`; `vercel.json` fires one dispatch cron. §1 was never updated after its own ledger recorded the initiative complete.

### FN-7 · PE1's "next milestone" — "Additional lenses + UI surfacing (v2.5)" — happened, at scale

- **STATUS.md claims:** §3, STATUS.md:148 — PE1 "Functionally complete … Debt + liquidity lenses shipped; API wired | Additional lenses + UI surfacing (v2.5)".
- **Actually true:** the full Perspective *workspace* UI shipped 2026-07-09 (`55599c6` virtual Perspective workspace renderer; `16f7032` Wealth, `b326a6f` Liquidity, `4562cc1` Cash Flow, `e637449` Debt, `d45d5a9` Goals; `118afe8` free-form tabs), followed by the recorded 07-12 redesigns and the A5/P1–P3 as-of "time machine" extensions of the lens layer (`8cef352`, `002063f`, `d8271e6`, `8ed072f`; `lib/perspective-engine/lenses/asof-completeness.ts` exists). The row understates current state by two generations of work.

### FN-8 · OPS-1 email substrate: "zero production callers" — false since 2026-07-06

- **STATUS.md claims:** §3 OPS-1 row, STATUS.md:190 — "S0/S1 (email substrate): additive, behavior-neutral, **zero production callers**".
- **Actually true:** `63bd1a9` (2026-07-06) "OPS-1: Add transactional email infrastructure, password reset, and email verification" plus migration `20260706120000_ops1_s2b_email_verification`; `sendEmail` is called today from `app/api/auth/{forgot-password,reset-password,register}`, `app/api/user/{deactivate,export,delete,email/request,password}` and the OPS-3 notification channel. The row also omits `585adc7` "OPS-1: Complete security hardening" (07-07) and the S2b slice entirely — OPS-1's slice inventory in the ledger (S0/S1 + S4/S5/S6) no longer matches what shipped.

---

## 3. Missing entries (the TI2 class — shipped initiatives with no ledger row)

### ME-1 · TI2 — capture-at-write transaction-facts foundation ⚠️ *the confirmed trigger case*

- **STATUS.md coverage:** zero. `grep -ci 'TI2\|TI-2\|transaction.fact\|capture-at-write' STATUS.md` = **0**. The TI row (§3, STATUS.md:182) is frozen at "**Phase 1 Complete** (2026-07-06) … Next milestone: Phase 2 (scope on the platform runway)".
- **Actually shipped** (evening 2026-07-07 UTC; commit timestamps 2026-07-08 00:08–00:43 +03, all ancestors of HEAD):
  - Migration **`20260707210625_ti2_transaction_facts`** (applied; introduced in `18174d3`).
  - `18174d3` schema foundation · `334bcdc` doctrine ratification · `aee6870` metadata capture · `4270e29` facts builder · `64b0b9d` persist during Plaid sync · `3165d8b` persist during imports · `c967661` facts backfill.
  - Current source: `lib/transactions/transaction-facts.ts` (+ backfill + tests), `lib/plaid/transaction-facts-wiring.test.ts`, `lib/imports/transaction-facts-import.test.ts`.
- **Further unrecorded TI work beyond TI2:** `ece6cae` shared flow predicates (07-07); `340c9ce` relationship resolver (`lib/transactions/RelationshipResolver.ts`); `4563f9c`/`a019c7c` facts + relationships in the detail read model; `05602d3`/`3333ee1` transaction detail drawer (`components/**/TransactionDetailDrawer.tsx`); `7719498` drawer reuse across surfaces. The "Phase 2 (scope on the platform runway)" next-milestone cell describes work that is substantially done.

### ME-2 · OPS-2 — Account lifecycle (security center, email change, deactivation, export, deletion) — no ledger row

- **Evidence:** commits `09f82b8` (security center + email account lifecycle, 07-06), `3c54e61` (account lifecycle, export, and deletion pipeline, 07-07), `77e5f27` (lifecycle UX polish, 07-07) — all ancestors of HEAD. **Four applied migrations:** `20260706130000_ops2_s3a_email_change`, `20260706150000_ops2_s4_deactivation`, `20260706170000_ops2_s5_cascade_corrections`, `20260706180000_ops2_s7a_deletion_foundations`. Current source: `app/api/user/{deactivate,export,delete,email}/`. Seven docs in `docs/initiatives/ops2/`.
- **STATUS.md §3 OPS-x table lists only OPS-1 and OPS-4.** An entire schema-owning initiative with user-facing surfaces is absent.

### ME-3 · OPS-3 — Notifications platform — no ledger row

- **Evidence:** commits `6bd764e`, `0fff735`, `5c3d067`, `a36b8b1`, `577719e`, `88421c5`, `2486b5f` (07-07). Migrations `20260707190000_ops3_s1_notifications`, `20260707210000_ops3_s3_notification_preferences`. Current source: `lib/notifications/` (create/preferences/read/registry/channels/cleanup + tests), `app/api/notifications/` (route, `[id]`, read-all, unread-count). Five docs in `docs/initiatives/ops3/`.
- **STATUS.md coverage:** referenced only *obliquely inside the OPS-4 row* (the "OPS-3 cleanup tail", the "F16 outbox"). A reader scanning the ledger for what exists would never learn a notification center shipped.

### ME-4 · The entire A-track (A1–A10, investment/wealth intelligence) — no ledger rows, no §4 track allocation ⚠️ *largest single gap by volume*

§4's namespace rule says new initiatives get a track prefix "allocated only in this file" — the A-x prefix appears nowhere in §4's track list, yet ~8 A-initiatives shipped 2026-07-11/12 with **five applied migrations**. STATUS.md's only nod is the parenthetical "over the shared A9/A10 time machine" (Current focus, STATUS.md:50). Per root investigation docs (e.g. `FOURTH_MERIDIAN_A3_INVESTMENT_EVENT_FOUNDATION_INVESTIGATION_2026-07-11.md`, which states "A1 … is complete and wired"):

| Initiative | Shipped evidence (all ancestors of HEAD) |
|---|---|
| A1 Investment Observation Foundation | migration `20260711210000_investment_observation_foundation`; `752b07a`; `lib/investments/position-capture.ts` |
| A2 Holding Writer Modernization | `f935b89` "stable per-holding sync replacing destructive Holding rewrite" |
| A3 Investment Event Foundation | migration `20260711223000_add_investment_event`; `402a1f5`, `49b90bb`, `a824c35`, `f0dc9e1` |
| A4 Position Reconstruction | migration `20260712000000_add_position_reconstruction`; `fec9816`, `8597bdb`, `922448e`, `4b6af85` |
| A5 Shared Perspective Engine (as-of/completeness) | `8cef352`, `002063f`; `lenses/asof-completeness.ts` |
| A6 Historical price infrastructure | migration `20260712140000_add_price_observation`; `89ed59e`, `19a8ba8`, `2ef1151`; `jobs/fetch-security-prices.ts` |
| A7 Historical Investment Import | migration `20260712120000_a7_import_provenance`; `27316a6`, `5737afc`, `e885da4`, `990be3b`, `fa12f4d`, `67a9e98`, `9689ca1`, `daba53e` |
| A9 / A10 Wealth regeneration + Investments Time Machine | `b0c15be`, `bbe5a8f`; `ea94638`, `9edf165`, `b23bbe6`, `1d67e30` |

### ME-5 · BTC/self-custody wallet expansion (xpub) — beyond §1's description, no row

- **Evidence:** migration `20260709231500_v4_xpub_drop_provider_identity_account_unique`; commits `58a09d8` (xpub wallet support), `cf7d965` (import BTC wallet transactions), `11c5b5d`, `be999fb`, `237151f` (manual sync control), `3f54e8a` (provider-spine alignment), `60bb19c`, `126b218` (resumable xpub discovery + Ledger normalization). §1 still describes only "crypto wallet tracking by address".

### ME-6 · Cash Flow intelligence work (2026-07-10) — no rows

- **Evidence:** migration `20260710101154_add_transfer_evidence`; `176dc05` owned-account transfer resolution, `6b79f21` liquidity axis + drilldowns, `e4dc8f5` context breakdown, `06137f8` canonical projections convergence, `7ef8a95` projections + debt-payment insights.

### ME-7 · Perspective workspaces v1 (2026-07-09) — the precursor generation to the recorded redesigns, unrecorded

- **Evidence:** `55599c6`, `16f7032`, `b326a6f`, `4562cc1`, `e637449`, `d45d5a9`, `118afe8`, `aac52c8` (URL tab state), `78564c7`, `b20ca18`. The §Verification bullets describe the 07-12 *redesigns* of these workspaces without the ledger ever recording their creation.

### ME-8 · UX-CUST-1 — Personal Overview section-backed widgets + visible-surface reorder

- **Evidence:** `3678eac` "UX-CUST-1: Convert Personal Overview to section-backed widgets" (07-09); UX-CUST-1A reorder (see FN-2). No row, no track allocation for UX-CUST-x.

### ME-9 · UX-1 — Settings information-architecture refactor

- **Evidence:** `25c3871` (07-07). No mention. (Note: §3's UI-1 is the design system; this "UX-1" label is a separate, unallocated use — a §4 namespace-rule violation in commit vocabulary worth recording either way.)

### ME-10 · Forced-TOTP enforcement across API guards — security posture change, unrecorded

- **Evidence:** `7be64f3` "fix(security): enforce forced TOTP across API guards" (07-07); `lib/session.ts:66–75` (`requireTotpSetup`, forced-enrolment gate). §1's security paragraph and §6 make no mention.

### ME-11 · FI0 — Financial Intelligence doctrine ratified — unrecorded

- **Evidence:** `2286968` + `ab04607` (07-08); `docs/FI0_FINANCIAL_INTELLIGENCE_DOCTRINE.md`. Directly relevant to the v2.5.5 "Financial Intelligence" milestone (§5), which still says its scope is "unchanged".

### ME-12 · 2026-07-13 route retargets + dead-route cleanup — landed after the last STATUS edit, unrecorded

- **Evidence:** banking retarget `45c24c4`→`e144d7a` (deletes `/dashboard/banking`, 637 LOC), accounts retarget `ca15c99`→`ac40700` (deletes `/dashboard/accounts`), dead-route deletes `9a5b02d` (history), `4e513dd` (holdings), `3e89933` (investments, 1,155 LOC). Completion docs at root: `FOURTH_MERIDIAN_BANKING_ACCOUNTS_RETARGET_COMPLETION_2026-07-13.md`, `FOURTH_MERIDIAN_DEAD_ROUTE_CLEANUP_COMPLETION_2026-07-13.md`. **Fairness note:** these are hours old — this is lag, not neglect — but they invalidate live claims elsewhere in the file (see SC-6).

---

## 4. Stale citations (right conclusion, outdated evidence)

| # | STATUS.md claim (location) | Actual state |
|---|---|---|
| SC-1 | "Last verified 2026-07-06 … post-`f22de52`" (STATUS.md:9, :15–19) | 235 commits since; the header no longer describes what any given section was verified against, because sections were amended at different dates without re-stamping |
| SC-2 | "Latest tag: `v2.4.5`" (§2, STATUS.md:89) | Latest tags by creation date: `v2.5-flowtype-p5`, `v2.5-mc1-phase0`…`phase3`, **`v2.5-mc1-complete`** (verified `git tag --sort=creatordate`). The `v2.4.5`→`6b517fa` mapping itself is correct |
| SC-3 | "working tree clean as of the FlowType P5 closeout commit" (§2, STATUS.md:90) | Working tree has ~15+ untracked root docs and the KD-13 `" 2"` dirs; 13 local commits not yet pushed (origin at `ce0594e`, local at `ac40700`) |
| SC-4 | OPS-4 S2: "`vercel.json` 3 → 1 entry (`0,30 6-7 * * *`)" (§3, STATUS.md:191) | Current `vercel.json`: single cron at `"0 6 * * *"` — changed by `490e2bc` "improve hobby-tier scheduling and FX freshness" (07-10), itself unrecorded |
| SC-5 | Timeline Foundation row: "`lib/timeline-placeholder.ts` still supplies `isPreview: true` demo events" + cited as evidence (§3, STATUS.md:158); Activity Tab bullet references the same file (STATUS.md:35) | File deleted 2026-07-13 (`cf8cee7`, the dead timeline-preview chain — recorded in Current focus, contradicting §3's row) |
| SC-6 | Accounts Tab bullet: View transactions "(`/dashboard/banking?account=` — the real deep-link)" (STATUS.md:36); KD-19 narrative names dashboard pages `accounts`/`banking`/`investments`/`holdings` (§7) | `/dashboard/banking` (and accounts/investments/holdings/history) deleted 2026-07-13; the live link is `/dashboard?tab=transactions&account=` (`components/space/widgets/accounts/AccountsPerspective.tsx:266`, which itself documents the retarget) |
| SC-7 | §9 doc map + Supersedes header point at `docs/operations/PROJECT_STATE.md`; §10 lists ROADMAP.md "Redirect" and PROJECT_STATE.md "Archive" as *pending recommendations* (STATUS.md:11, :356, :367) | Both already executed: `ROADMAP.md` is a redirect stub ("This document has been superseded"); `PROJECT_STATE.md` now lives at `docs/archive/PROJECT_STATE.md` |
| SC-8 | MC1 "Phase 2/3/4 delivered 2026-07-05" (§5 MC1 block) | Commits are dated 2026-07-06 (`030dc07`, `257f63f`, `ce51382`, `901aebd`, `38f213c`). One-day drift, cosmetic; hashes and content all check out |

Also in this class: Current focus's "**Current initiative:** OPS-1" / "Upcoming: OPS-1 S0/S1 → PO1" (STATUS.md:58, :60) — S0/S1 landed 07-06 per the file's own OPS-1 row, PO1 investigations + implementation plan now exist at root (`FOURTH_MERIDIAN_PO1_0_IMPLEMENTATION_PLAN_2026-07-13.md`; no PO1 code commits yet, so "PO1 not started" holds), and the actual product-lane activity of 07-09→07-13 (perspectives, wallets, A-track, retargets) is nothing the Current-focus section predicted or records.

---

## 5. False positives — none found

Sampled "Fixed & committed" / "Complete" claims across the file's full age range, verified against **current source** (not just commit existence):

| Claim (age) | Verified in current source |
|---|---|
| D1 append-only merge ledger, `94aa6e2` (2026-06-22 — oldest citation) | `lib/accounts/reconcile.ts` present; commit exists with matching subject |
| KD-1 / KD-15 visibility predicate (07-02) | `lib/ai/visibility.ts` present; `TRANSACTION_DETAIL_VISIBILITY` used in both `lib/data/transactions.ts` and `lib/ai/assemblers/transactions.ts` |
| KD-2 live enforcement (07-02) | `applyEnforcement` in `lib/ai/output-validator.ts`; `AI_OUTPUT_VALIDATION_MODE` read 3× in `app/api/ai/chat/route.ts` |
| KD-3 limiter implementation (07-02) | `lib/rate-limit.ts` + migration `20260702120000_kd3_add_rate_limit` (status text stale — see FN-4 — but the implementation claim holds) |
| KD-5 HOME partial-unique (07-02) | Migration `20260702170000_kd5_home_partial_unique_index` present; `P2002` recompute-retry in `lib/accounts/space-account-link.ts` |
| KD-7 fetch-cap sentinel (07-02) | `TRANSACTION_FETCH_LIMIT + 1` at `lib/ai/assemblers/transactions.ts:286` and `:1110` |
| KD-10 single monthly-expense figure (07-02) | `computeAverageMonthlySpending` in `lib/ai/intelligence/annotations.ts` |
| KD-11 keyword consolidation (07-02) | `lib/ai/intent/keywords.ts` + `lib/ai/intent/gap-intent.ts` present |
| KD-17 checked invariant (07-02) | `checkSpendingCategoryInvariant` in chat route (3×) + assembler |
| KD-18 guardrail + capability (07-02/05) | `ATTRIBUTION` doctrine in chat route (5×); `totalDebtPaid` per-liability rollup in `lib/debt.ts` |
| KD-19 metadata sanitization (07-03) | `sanitizeForBalanceOnly` in `lib/data/accounts.ts` (3×); `grantsAccountDetail` in `lib/ai/visibility.ts` |
| KD-6/SEC-1 (07-05) | `detectCiphertextVersion` in `lib/plaid/encryption.ts`; HKDF present (6 refs) — also validates D14 |
| D3 WAS retirement (07-03) | `WorkspaceAccountShare` appears in `prisma/schema.prisma` only in comments (8 comment refs, 0 model); migration present |
| DB1 zero `@map`/`@@map` (07-05) | Only 3 comment-line matches in schema; 0 live annotations |
| D-TEST runner (07-05) | `scripts/run-tests.ts` + `.github/workflows/ci.yml` present |
| TI-1 canonical serializer (07-06) | `lib/transactions/serialize.ts` + `serialize.golden.test.ts` present |
| MC1 core (07-05/06) | `lib/money/`, `lib/fx/` (archive/providers/registry), all 5 MC1 migrations present |
| v2.4.5 tag identity | `git rev-parse v2.4.5^{commit}` = `6b517fa` — exactly as claimed |

**Hash integrity:** all **75** distinct commit hashes cited in STATUS.md exist in history, and every one's subject line matches the claim citing it. No fabricated or dangling citations.

---

## 6. Checked and clean (calibration — what the document gets right)

- **KD-13 "Reopened — partially resolved" is accurate**, including the specific `" 2"` duplicate-dir inventory: `lib/ai/assemblers 2`, `intent 2`, `intelligence 2`, `signals 2` etc. are still on disk in the working tree today.
- **§5 v2.5 exit-criteria honesty holds precisely:** the claim "zero legacy-`Account` queries — **not yet met:** three runtime read sites remain" is exactly right — `lib/imports/authorize.ts:74`, `app/api/admin/overview/route.ts:73`, `app/api/accounts/[id]/transactions/route.ts:38` all still query `db.account`.
- **§2 `package.json` = `2.4.5`** ✓; **active branch `feature/v2.5-spaces-completion`** ✓.
- **§1 AI provider claim** ✓ — `lib/ai/provider.ts:45` `CHAT_MODEL = 'gpt-4o-mini'`, single provider boundary.
- **§1 "billing does not exist"** ✓ — no billing/stripe surface in `app/`/`lib/` (only incidental word matches in unrelated files).
- **OPS-1 S9/S10 (legal pages, beta gate) still pending** ✓ — no terms/privacy routes exist; consistent with the row's next-milestone cell.
- **PO1 "Planned"** ✓ — investigation + implementation-plan docs exist (07-07 and 07-13) but zero PO1 code commits.
- The entire 2026-07-12→13 **design-system push narrative** (Current focus + §Verification bullets) checks out commit-for-commit: all 30+ cited hashes (`4265033`/`85a7539`, `7984b37`/`386820f`, `36d4af5`/`b87ba7c`, `467d953`/`c008fad`, `cda3cec`→`bd8b2a5`, `74e1f45`, `4414606`, `b27c418`→`f9f6f04`, `52c9d1d`, `920dc69`/`0fc971f`, dead-code `707b94b`/`cf8cee7`/`68a4fb2`/`ed24d21`/`9bcca99`, shell-nav `aa9803c`…`ce0594e`, merge `e0a4f92`) exist with matching subjects, and the named components (`CashFlowPerspective.tsx`, `LiquidityPerspective.tsx`, `AccountsPerspective.tsx`, `FloatingNavWrapper.tsx`, `useScrollShrink.ts`, `lib/space-nav-icons.ts`, `lib/perspective-icons.ts`) are all present in source.
- **Not verified** (out of scope for a filesystem audit, noted for calibration): live test-suite counts ("200/200 green"), database-applied state of migrations beyond their presence in `prisma/migrations/`, and Vercel-side cron behavior.

---

## 7. Root-cause pattern

The maintenance rule in the header — "Any PR that changes system behavior updates this file, or states in the PR why not" (STATUS.md:11) — **held for one lane and failed for everything else**. The design-system push (07-12/13) updated STATUS.md in-slice (`33c927e`, `05488be`, `db5665a`, `ce0594e`, `ff17833`), and those sections audit clean. But the 07-06→07-11 platform and intelligence lanes (OPS-2, OPS-3, TI2, MI2, A-track, wallets, cash-flow) shipped ~150 commits with **zero** ledger updates, and the sections that aggregate across lanes (§1, §2, §6, §7) were last reconciled 2026-07-06. The result is a document whose *newest* paragraphs are trustworthy and whose *structural* sections — the ones a planner would consult — are six days and ~235 commits stale, with three places where STATUS.md now contradicts itself (FN-3, FN-4, FN-5/FN-6).

---

## 8. Recommendation

**A full re-verification pass is warranted — targeted corrections are not sufficient.** The TI ledger fix already in progress addresses 1 of 28 items; the drift spans four independent lanes and six sections, and several errors are cross-referential (fixing KD-9 requires touching D8; fixing rate-limit language touches §1, §6, §7; recording the A-track requires a §4 namespace allocation). Suggested shape of the correction pass, in priority order:

1. **Kill the active misdirections first** (same day): MI2 row + the Current-focus "recommended next workstream" paragraph (FN-1); the three rate-limit contradictions (FN-4); KD-9 (FN-3); KD-14 re-scope (FN-5); §1's "what does not exist" paragraph (FN-6).
2. **Add the missing ledger rows** (one sitting, from this report's evidence tables): TI2 (+ the post-TI2 TI work), OPS-2, OPS-3, and an A-x track allocation in §4 with rows A1–A10; then the smaller entries (wallets/xpub, cash-flow 07-10, UX-CUST-1, forced TOTP, FI0, 07-13 retargets).
3. **Re-stamp verification honestly:** update the header to the commit the pass is run against, and consider a per-section "verified through `<sha>`" stamp — this audit shows section-level staleness varies by six days, which a single file-level stamp hides.
4. **Process fix, worth a decision:** the failure mode was lane-local discipline. Options: (a) make the STATUS.md update a named slice in every initiative's plan (the design push did this and stayed clean); (b) a lightweight CI tripwire — flag any PR adding a `prisma/migrations/` folder or `docs/initiatives/**` closeout without a STATUS.md diff; (c) a scheduled drift audit like this one at each phase boundary. (a)+(b) together would have caught every item in this report except the cosmetic date drifts.

**Severity restated:** contained in *direction* (no false "done" claims — the codebase is strictly ahead of the paper), systemic in *breadth* (28 items across 6 sections, including one entire unrecorded initiative track). The document's §9 self-description — "the only file allowed to describe current state" — is currently aspirational for anything that shipped between 2026-07-06 and 2026-07-11.

---

*Method note: this audit read STATUS.md in full (135,734 bytes, 390 lines), enumerated its claims section-by-section, and verified against (1) full git history — `git log --all` with numstat, 505 commits, plus targeted ancestry checks (`git merge-base --is-ancestor`) confirming every "shipped" finding is reachable from HEAD `ac40700`; (2) the 40 `prisma/migrations/` folders; (3) current file contents for every claimed fix (exact symbols, not file existence alone); and (4) the root and `docs/` investigation corpus. All 75 cited hashes were existence- and subject-verified. No STATUS.md or code edits were made.*
