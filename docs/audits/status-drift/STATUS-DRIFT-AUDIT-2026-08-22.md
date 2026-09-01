# STATUS.md drift audit — 2026-08-22

**Scope:** HEAD `fca5e01` (branch `v2.6`, 2026-08-22) vs STATUS.md as committed at `9ea50a5` (2026-08-17).
**Verdict: substantial new drift — 9 commits landed since the last audit, including a `feat(spaces)!` breaking retirement of two product surfaces. STATUS.md is unchanged and now contains one dangling code reference.**

| Check | 2026-08-21 | 2026-08-22 |
|---|---|---|
| HEAD | `1c6b8a9` (08-18) | `fca5e01` (08-22) |
| STATUS.md last touched | `9ea50a5`, 08-17 | unchanged |
| New commits since last audit | 0 | **9** |
| New committed `.md` completion docs | 0 | **0** (7 exist, all in gitignored `_to_delete/`) |

Keyword check against STATUS.md — all **zero hits**: `Retirement`, `W2`, `W4`, `W5`, `scopeHint`, `ASSESSMENT_WINDOW_DAYS`, `assessment-complete`, plus the still-zero carry-overs `W1`, `INV-19`, `DEBT-1`, `KD-15`, `FAMILY`, `schema-drift`.

---

## New drift (this cycle)

**1. W2 — Goals and Retirement retired. Breaking, unmentioned, and STATUS now cites a deleted file.**
`9352e41` (86 files, +810/−4,932), `70bbe10`. Deleted: the 3 goal API routes, `lib/goals/`, `lib/ai/assemblers/goals.ts`, `GoalsCard`/`AddGoalModal`/`RoutedWorkspaceModal`, `SectionRegistry`/`SectionCard`, `virtual-sections`, `widget-registry`, `section-quantity`, the whole AI goals domain (assembler, detector, `GOAL_COMPLETED` signal, `GOAL_ALIGNMENT` intent, manifest rows), goal seeding, and the retirement + goal templates. Retirement was retired *completely* — the `comingSoon` template is gone, not parked.
Verified on disk: `app/api/spaces/[id]/goals/`, `lib/goals/`, `lib/ai/assemblers/goals.ts` all absent.
→ **STATUS.md:60 is now false.** The KD-21 closed entry cites `app/api/spaces/[id]/goals/route.ts:62` as live evidence. That block was flagged "kept here for one cycle… then delete" — delete it now rather than repair the path.
→ **Suggested correction:** add W2 to *Recently landed*; delete the KD-21/KD-22 closed block; note the deliberate residue — `SpaceGoal`/`GoalCheckIn`/`GoalContribution` and their enums stay in `prisma/schema.prisma` until the migration train (code-only wave, zero migrations). *This residue currently lives only in a commit message — the same failure mode as the `HOUSEHOLD` enum from 08-20 item 2.*

**2. W3 / W3.1 / W4 — Brief assessment authority converged.**
`f3562e8` (assessment-complete debt context: withholding may never change a grade), `bc67662` (parity-audit ACCOUNTS registration repair + behavioural pin), `f03b4bc` (one `ASSESSMENT_WINDOW_DAYS` = 90 rolling days at *every* `scopeHint`; the hint-keyed `resolveWindow` seam that produced brief-vs-full divergence — `incomeTransactionCount` 3 vs 8, `deficitCause` `NOT_APPLICABLE` vs a deficit verdict — is gone).
→ This is the same subject matter as **KD-16** (window derivation) and the AI honesty arc STATUS tracks under KD-8. Neither ledger row moved.
→ **Suggested correction:** add a *Recently landed* clause for the Brief Assessment Window Authority; re-read KD-8/KD-16 against the post-W4 code before the next cycle — at least KD-16's window clause may now be fully closable.

**3. W5 — Crypto Current-Value Authority.**
`fca5e01`. One dated valuation path; `lib/investments/legacy-crypto-holdings.ts` and the crypto arm of `canonical-precedence.core.ts` deleted (−236 LOC); holdings/export/btc-sync repointed; new REQUIRED audit `scripts/audit-crypto-holding-tombstone.ts` registered.
→ STATUS.md:41's v2.6 crypto narrative predates this and still describes the provider-bound-history era only.
→ **Suggested correction:** one clause in *Recently landed* naming W5 and the new tombstone audit.

**4. Test-suite consolidation wave (2026-08-19) — suite figures stale.**
`c00a912` (5 ceremony files deleted, census verdict MARGINAL), `50be184` (30 same-SUT files → 23 targets), `d86b431` (ratchet now fails closed; two stale headers corrected). Separately, `70bbe10` and `fca5e01` each registered a new REQUIRED audit.
→ STATUS.md:42 already says the authoritative number is "whatever `npm run test:unit` prints" — that stands. But the *linked* REVIEW-3 report's "492/492 tests, 18/18 REQUIRED audits" (`def2292`) is now stale in both terms.
→ **Suggested correction:** none to STATUS body; consider a one-line "figures superseded 08-19/08-22" note where REVIEW-3 is linked.

**5. Wave execution records are outside git entirely.**
`_to_delete/` (gitignored, `.gitignore:97`) holds `W2-EXECUTION-REPORT.md`, `W3-EXECUTION-REPORT.md`, `W3-ACCEPTANCE-REPAIR.md`, `W4-DECISION-MEMO.md`, `W4-EXECUTION-REPORT.md`, `W5-DECISION-MEMO.md`, `W5-PRECONDITION-REPORT.md`, `W5-EXECUTION-REPORT.md` — all dated 2026-08-22, none reachable from any committed doc. Zero `.md` files were committed in the last 9 commits.
→ This is an escalation of the 08-21 note (then 2 files, now 8). **The entire W1–W5 program's reasoning will vanish when that folder is deleted.** Highest-leverage act in this report: extract or `git add` these before anything else.

## Inverse drift (STATUS says open / not-started but git shows shipped)

None newly found beyond items 1–3 above, which are *unrecorded* rather than mis-recorded. **KD-15** remains the standing inverse case from 08-20 (checklist says "awaiting approval, no application code changes"; `TRANSACTION_DETAIL_VISIBILITY` is enforced across read paths today, and KD-15 appears in no STATUS ledger, open or closed).

## Carried from prior audits — still unremediated

All six items from [`STATUS-DRIFT-AUDIT-2026-08-20.md`](STATUS-DRIFT-AUDIT-2026-08-20.md), unchanged: W1 transaction-identity wave (now 4 days old), FAMILY/shared-space riders + `HOUSEHOLD` enum residue, DEBT-1 semantic convergence, ops observability restore (`ce360b8`), KD-15, and the stale "88 migrations" figure on STATUS.md:7 (directory count is **100**, unchanged this cycle — W2–W5 added no migrations).

---

*Report-only. STATUS.md was not edited.*
