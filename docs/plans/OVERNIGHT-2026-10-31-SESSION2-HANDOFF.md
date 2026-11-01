# Overnight 2026-10-31: Session 2 handoff (for the consolidated morning report)

Owner: Claude 2 (Session 2). Scope: §2 beta security + cost controls, the CS Communications Center UI, the §3 Production schema REVOKE, the §3b Production `fm_diag_ro` investigation, and Preview migrations 1–2.
State as of ~12:30Z on 2026-10-31. Develop HEAD is `685bb9e`: CI success (run 41200183088), Trusted deployment health success (41200183157).

## 1. Status by workstream

| Workstream | Status | One line |
|---|---|---|
| §2.1 #162 lifecycle (L1) | **PASS** | merged `50db402`; independent re-review: no material findings |
| §2.2 #169 Cost Freeze enforcement (L2) + all review blockers | **PASS** | merged `bc2e8ae`; independent re-review verdict MERGE |
| §2.3 Owner rulings (Frankfurter only if free / Plaid repairs refused while frozen / audited CONTROL toggle) | **PASS** | all in `bc2e8ae` |
| §2.4 Stale-import recovery fairness | **PASS** | `bc2e8ae`; the regression test puts 6 refused items ahead of 1 allowed item |
| §2.5 Shared-Space billing owner + price-access edges | **PASS** | `bc2e8ae`; decided by the billed owner, fails closed |
| §2.6 Blocked jobs reported as skipped, not successful | **PASS** | #169 + #174 `2fe9e38` |
| §2.7 Lifecycle/resume messaging | **PASS** | "Sync paused …" copy (`planRestrictedDeferralMessage`) |
| §2.8 No paid-provider calls when prohibited | **PASS** | two independent traces + trapped-provider suites (§4) |
| §2.9 #159 read-only diagnostic helper hardening + independent review | **PASS** | merged `61ba9a5` after 4 independent reviews |
| §2.10 CS Communications Center UI (Library, Automations, Delivery, Preferences) | **PASS** | #171 `022de22`, #179 `14dbb9b`, #182 `df89ab7`; Preview-verified |
| §2.10b CS content editor on B1 (#184) | **PASS** | PR #186 merged `2f08499` after 3 independent review rounds (final: MERGEABLE, no security findings); Preview-verified: draft → publish → restore code default, 390 px with no overflow and 25/25 targets ≥44 px |
| §2.11 Regression / security / lifecycle / billing tests | **PASS** | develop CI green at `685bb9e` |
| §3 Production REVOKE CREATE A+B | **PASS** | executed + verified; no rollback needed |
| §3b Production `fm_diag_ro` masked investigation | **PASS** | created, verified, used, **retired** |
| §4 Preview migrations 1 (#161) and 2 (#162) | **PASS** | both through `db:migrate:safe` with verified backups |
| Cross-session: #183 freeze conditions | **PASS** | post-merge check of `eec9b3f`: all 3 conditions + the freeze→unfreeze test present; 72/40/all tests pass locally |

## 2. PRs merged to develop (Session 2)

| PR | Merge SHA | What |
|---|---|---|
| #159 | `61ba9a5` | Read-only diagnostic helper hardening + beta risk/parity docs (incl. the masked Production investigation results) |
| #161 | `ea64e0b` | Beta-request risk backend: advisory signals + operator review |
| #162 | `50db402` | Beta lifecycle L1: lifecycle + cost-freeze evaluator, billable gate API, CONTROL write path |
| #167 | `7e8c6c3` | De-flake the policy-group editor refusal-privacy test |
| #169 | `bc2e8ae` | Beta lifecycle L2: Cost Freeze enforcement on every paid path, global freeze, ≤30 s propagation |
| #171 | `022de22` | Comms Center UI: Customer Success › Communications |
| #174 | `2fe9e38` | Cost-freeze follow-ups: skipped job status, atomic re-add window, FX catch-up per-day freeze + cap |
| #175 | `5d1cd27` | Fix develop-red comms test after #170 made catalogDetail async |
| #176 | `f1c0c97` | Prove the frozen FX exemption persists its quotes (test-only) |
| #179 | `14dbb9b` | Comms UI v1.0.3: server types, storm-limit labels, legacy anomaly keys |
| #182 | `df89ab7` | Comms status-chip checks no longer pin BUILD |

| #186 | `2f08499` | CS content editor on B1: draft → preview → publish, version history/restore, AI polish, unsaved-text protections |

## 3. Preview migrations run by Session 2 (serialized with Session 1)

| # | Migration | Evidence |
|---|---|---|
| 1 | `20261031120000_beta_request_risk_review` (#161) | `npm run db:migrate:safe` from a clean worktree at origin/develop. The 10.6 MB pg_dump backup was verified row-for-row against live counts before deploy. `migrate status` up to date. RLS ENABLE+FORCE. fm_system SELECT/INSERT only. `GET …/risk-review` → 200 on Preview. |
| 2 | `20261031130000_policy_group_lifecycle` (#162) | Same guarded path. The first attempt was **refused by the backup check** (a 1-row RateLimit race from app traffic) and nothing was applied; the retry in a quiet window verified the backup and applied the migration. `migrate status` up to date. `PolicyGroupTransition` RLS forced. Lifecycle route 200 (`BETA_FULL_ACCESS_V1` ACTIVE, `costFrozen=false`) on `50db402`. There was a ~9 min fail-closed gap before the migration (code deployed first), by design. |

The backup verification was never bypassed. Preview writes were held during Session 1's migrations 3 (#170) and 4 (B1, `20261031210000_comms_template_versions`).

## 4. Security and billing enforcement evidence (Cost Freeze)

**Rule implemented (owner rulings).** The global Cost Freeze stops every platform-wide paid operation. Cached data stays readable. A free operation continues only where it is proven non-billable. Wallets without a billing owner get no paid background work. Plaid repairs are refused while frozen. **Nothing is ever disconnected.**

- **Global flag.** The platform setting `platform_cost_frozen` is read by `readGlobalCostFreeze()`. Verdicts are ON / OFF / MISSING / INVALID / UNAVAILABLE. **Unreadable or invalid ⇒ frozen** (fail closed). The verdict is folded into every group's `costFrozen`. A 20 s TTL keeps propagation under 30 s.
- **Toggle.** Operational controls `COST_FREEZE`: fresh CONTROL, mandatory reason, audit row in the same transaction, read-back after write, plus a UI card.
- **Coverage.**
  - Plaid: token exchange, webhook-triggered sync, and all repair paths are gated before any Plaid call. Two independent reviews traced **all 22 Plaid call sites** and every vendor host.
  - Crons: sync-banks, sync-crypto, sol-history-backfill, resume-stale-imports. Wallet re-add (atomic `UPDATE … RETURNING` claim). Operator routes. build-intelligence. FX and security-price jobs.
  - FX: Frankfurter is the only allowed provider while frozen (proven free), with at most 1 atomic claim per day, newest-first catch-up capped at 3.
- **No paid calls when prohibited.** 114 request-path checks plus the jobs suite run with **trapped providers**: any provider call fails the test. Result: **zero calls** when frozen or when the lifecycle state is unknown.
- **Skipped, not successful.** Blocked jobs record outcome `SKIPPED` with a reason label (`lib/jobs/skip-label.ts`). The ops Overview shows **DEGRADED** with a Skipped fact, never "success". Real-Postgres RLS foreground checks 72 and 73 pin the claim SQL.
- **Plaid billing finding** (docs/plans/PLAID-BILLING-MODEL-AND-COST-FREEZE-IMPLICATIONS-2026-10-31.md). Plaid bills a **monthly subscription per Item per product**, so pausing syncs saves ~$0. Only the paths that *start* a subscription (new link/exchange, product add) cost money, and those are gated. **No disconnection is proposed.**
- **#183 cross-check** (Session 1's revaluation stamp under freeze). It is a status-only write; values are preserved; it is reversed by the rebuild after unfreeze; scope is exactly the owed rows. The freeze test shows SKIPPED, stamped, and no step/price fetch/revaluation/usage.

## 5. Production changes: verification and rollback status

### 5a. Schema REVOKE A+B: EXECUTED, VERIFIED, NO ROLLBACK NEEDED
- Owner approval (Session 2) covered exactly these two statements. They were executed around 05:50Z through the owner's authenticated Supabase SQL editor (Chrome):
  ```sql
  BEGIN; SET LOCAL lock_timeout = '3s';
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  REVOKE CREATE ON SCHEMA public FROM anon, authenticated, service_role;
  COMMIT;
  ```
- Verified: the PUBLIC ACL on `public` is now `=U` (was `=UC`, a search_path hijack risk); CREATE is held only by postgres and supabase_admin; `/api/health` 200 with db ok; a signed-in app page loaded.
- Documented rollback, **not needed**: `GRANT CREATE ON SCHEMA public TO PUBLIC; GRANT CREATE ON SCHEMA public TO anon, authenticated, service_role;`
- Record: `docs/operations/sql/prod-revoke-schema-create.md` (@`08f856f`).

### 5b. `fm_diag_ro` masked investigation: CREATED, USED, RETIRED
- **Authorization.** The owner directly approved it in Session 2 ("You have my explicit authorization to create the restricted Production diagnostic role fm_diag_ro … Proceed autonomously once the hardened read-only helper passes independent security review"). This is separate from the overnight directive, which did not cover it.
- **Gate.** The helper (#159) passed its independent review: the 3rd review rated it SAFE for the planned run, and a 4th closed the remaining CR-comment bypass before merge.
- **Precheck.** 18/18 rows as expected, plus no dblink/FDW/user mappings and no non-allowlisted SECURITY DEFINER functions.
- **Role.**
  - Password: SCRAM-SHA-256 verifier only (no plaintext reached Production), `VALID UNTIL` now + 24 h, `CONNECTION LIMIT 2`.
  - Grants: SELECT on 17 columns across BetaAccessRequest, BetaAccessRequestEvent, AuditLog and RateLimit, plus 4 `FOR SELECT` RLS policies.
  - Verified: 0 memberships, no CREATE, no write.
- **Run.** Read-only transaction (`SET TRANSACTION READ ONLY` … ROLLBACK), via the Supavisor session pooler (the direct host is IPv6-only), with masked output only.
- **Retired** per §6: sessions terminated, 4 policies dropped, grants revoked, role dropped. Verified 0 roles / 0 policies / 0 sessions, the schema ACL unchanged and health ok. The local secret files were securely deleted.
- **Findings** (docs/plans/BETA-REQUEST-PROD-INVESTIGATION-RESULTS-2026-10-31.md, on develop via #159):
  - **20 PENDING** requests; none decided, none redeemed.
  - **13 of them form one probable single-actor cluster:**
    - dotted Gmail local parts;
    - unique long notes;
    - no user-agent/network evidence (pre-telemetry era);
    - steady cadence, one every 3–5 days from 2026-09-06 to 2026-10-22.
  - The owner's estimate was ~15/20.
  - **~7 look plausibly genuine**, including the 4 recent requests with full browser telemetry.
- No customer records, settings or request statuses were modified. No invitations were sent.

## 6. Tests and independent reviews

- Develop CI **success** at `685bb9e`. Trusted deployment health success.
- The "Post-deploy smoke" workflow reports failure on every Preview deploy because **Vercel Deployment Protection answers 401** (no bypass header configured), so the app is never reached. This is a structural CI-config gap, not an app failure. Trusted deployment health covers health.
- Independent reviews:
  - #159: 4 rounds (NUL, bare END, dollar-quote tag, CR comment, query_to_xml, dblink, localhost URL, xtrace leak; all fixed and test-pinned; 124 container checks on PG17).
  - #161, #162: re-reviews found no material findings.
  - #169: blockers fixed → MERGE.
  - #171: MERGE AFTER FIXES → all fixed.
  - #174: MERGE AFTER FIXES → fixed.
  - #183: post-merge condition check PASS.
- Suites: cost-freeze route + jobs, lifecycle-enforcement, risk-review, RLS foreground 72/73, comms-center 104, comms client 59, content-editor 102 (local, branch), B1 content/ai/store pass.

## 7. Genuine blockers

None blocking Session 2's merged work. Open items:

1. **Content editor follow-ups (P3, tracked):** browser Back/Forward inside a Platform Space doesn't ask before discarding unsaved editor text. Session 1 has queued the B1 contract follow-ups (export `CODE_DEFAULT_VERSION_ID`, extra limits, `canRollback` split).
2. **Shared node_modules hazard.** About 30 worktrees share one Prisma client, which caused a mid-run regression for Session 1. Mitigated by the agreed rule: regenerate only from a worktree current with develop, and announce it first. FM-migrate1 now has its own install. I regenerated the shared client from `685bb9e` at ~12:20Z (B1 models present).
3. **Two docs remain uncommitted** in the main checkout: `BETA-COST-FREEZE-ENFORCEMENT-AUDIT-2026-10-31.md` and `PLAID-BILLING-MODEL-AND-COST-FREEZE-IMPLICATIONS-2026-10-31.md`. Proposed: a docs-only PR.

## 8. Next priorities (Session 2)

1. Review Session 1's B2 (automations) when it is ready, and wire the editor's test-send once B2 exists.
2. The docs-only PR for the cost-freeze audit + Plaid billing analysis.
3. #169 P3 follow-ups (N1–N6), and the general-purpose hardening items for the helper beyond the planned run, as tracked follow-ups.
4. Configure a Vercel protection-bypass secret for the post-deploy smoke so Preview smoke is verifiable (needs an owner OK: it is a deployment-protection setting).

## 9. Owner decisions still needed

1. **Beta requests.** What to do with the 13-request single-actor cluster (hold, reject, or verify individually) versus the ~7 plausible requests. No invitations have been sent.
2. **Post-deploy smoke bypass.** Whether to add a Vercel Deployment Protection bypass secret for CI smoke on Preview.
3. **Production promotion.** Lifecycle/cost-freeze (#162/#169/#174) and the comms migrations exist only on Preview. Production migrations and a release need the owner's separate approval. Lifecycle migrations must precede the code that depends on them.
4. **Plaid.** No action is recommended: the freeze already blocks every subscription-starting path, and disconnecting would save nothing this month and break users.
