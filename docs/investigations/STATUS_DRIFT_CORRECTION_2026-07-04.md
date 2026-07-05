# STATUS.md Drift-Correction Note

**Date:** 2026-07-04
**Type:** Investigation only. No code changes. STATUS.md was **not** edited.
**Purpose:** Record specific claims in STATUS.md that no longer match the codebase at HEAD `2db97ef`, so a maintainer can true-up STATUS.md in a deliberate, reviewed pass.
**Companion:** `V2.5_ARCHITECTURE_STATUS_AUDIT_2026-07-04.md`.

STATUS.md's own rule (§ header): *"If this file conflicts with the code, fix this file."* This note is the input to that fix. It does not perform it.

---

## 0. Root cause — STATUS verified against an old commit

STATUS.md header states: *"Last verified 2026-07-03, against commit `37f96f3`."*

- HEAD is `2db97ef` (Timeline T-2).
- `37f96f3..HEAD` = **41 commits**.
- Those 41 commits include the entire EV-1 track (Slices 0–5B), the SP-2b batches, Timeline T-1/T-2, several Daily Brief changes, and the committed Liquid card redesign.

Every drift below flows from STATUS not having been re-verified across those 41 commits. This is the single correction that matters most: **re-verify STATUS against HEAD, not `37f96f3`.**

---

## 1. KD-6 / SEC-1 — stale "Open" state

**STATUS says (§7 register, line 191):** `KD-6 | v1 (root-key) ciphertexts not re-encrypted; D14 Slice 5 pending | Medium | v2.5 | **Open**`. Also §3 (D14 row) and §5 (v2.5.5) still describe KD-6 re-encryption as pending / "rides here if it misses v2.5."

**Code / investigation reality:**
- `docs/investigations/SEC-1_KD-6_INVALID_TOKENS_INVESTIGATION.md` concludes **v1 ciphertext count is 0** — "there is nothing to re-encrypt … KD-6 (SEC-1) can be closed as *no re-encryption required*."
- `docs/investigations/V2.5_LATERAL_ARCHITECTURE_AUDIT_2026-07-03.md` records SEC-1/KD-6 as **code-complete**: Slice 5a version classifier `detectCiphertextVersion` shipped; Slice 5c removed the deprecated root-key `encrypt()`/`decrypt()` after confirming zero v1 rows. Only the **v1 read-branch removal gate** remains (subtractive, gated on 0 v1 rows across all environments + backup-retention window).

**Correction needed:** KD-6 should be reclassified from **Open** to **Resolved / code-complete**, with the only residual being the v1 read-branch removal gate (a subtractive cleanup, not open re-encryption work). Remove or update the §3 D14 "next milestone," §5 v2.5.5 "rides here," and §7 "Open" entries accordingly.

## 2. SP-2 — completed initiative absent from the ledger

**STATUS says:** nothing. `grep "SP-2" STATUS.md` returns **zero matches**. SP-2 appears in neither §3 (initiative ledger) nor §5 (roadmap).

**Code reality:** SP-2 (Spaces authorization centralization) is shipped and committed — git history shows `feat(spaces): add centralized policy predicate`, `SP-2b Batch 1: centralize Spaces authorization`, `SP-2b Batch 2: centralize active-member route authorization`, `SP-2b Batch 3: document public-read authorization exception`. Tests exist (`lib/spaces/policy.test.ts`, `lib/spaces/authorize.test.ts`). The lateral audit lists SP-2 as **resolved**.

**Correction needed:** add SP-2 to the §3 ledger as **Complete**, with evidence (`lib/spaces/policy.ts`, the SP-2b commits, the two test files). An entire completed initiative is currently invisible in the canonical status doc.

## 3. EV-1 — completed initiative absent from the ledger

**STATUS says:** nothing. `grep "EV-1" STATUS.md` returns **zero matches**.

**Code reality:** EV-1 (typed domain event seam) is shipped across Slices 0–5B — `lib/events/emit.ts`, `lib/events/types.ts`, `lib/events/handlers/snapshot.ts`, and commits `EV-1 Slice 0-1 … 5B`. It is the substrate the Timeline work builds on.

**Correction needed:** add EV-1 to the §3 ledger. Recommend recording it as **Complete (seam laid) — expansion deferred to v2.6b consumers**, and noting the current shape (one active handler, several audit-only event types) so it isn't later mistaken for a finished event bus.

## 4. Liquid material — status mismatch (rejected/parked vs. shipped)

**STATUS says (§3 UI-1; §8 parked table, line 220; §5 design-foundation note, line 132):** the Liquid / real-refraction material direction was *"evaluated and rejected"*, is *"parked"*, and its *"experimental components + two npm deps remain uncommitted in the working tree pending prune."*

**Code reality:**
- `components/atlas/AtlasLiquidCard.tsx` and `AtlasLiquidCta.tsx` are **committed** (git-tracked) and **in active use** by `components/dashboard/SpacesClient.tsx` and four Brief components (`BriefHero`, `BriefInsight`, `BriefSinceLastVisit`, `BriefAttention`).
- Commits `Redesign Spaces overview with Atlas Liquid cards` (`f907f5b`, `57da0b8`) shipped the direction.
- There are **no Liquid npm deps** in `package.json`. The material was instead **vendored** into `components/atlas/vendor/liquid-glass/` (`LiquidGlassCard.tsx`, `core/`, `card.css`, license + `VENDORED.md`).

**Nuance worth preserving in the fix:** what was genuinely rejected was *backdrop* refraction via `backdrop-filter: url(#svg)` (Chromium-only). The *content-lens* Liquid card components were kept, vendored, and shipped for chrome surfaces. STATUS collapses these two into a single "rejected."

**Correction needed:** reclassify Liquid from "rejected/parked, uncommitted, npm deps" to **shipped (committed, vendored, in use on chrome surfaces)**; separately note that only the browser-wide backdrop-refraction primitive was rejected. Remove the "two npm deps pending prune" claim (false — vendored, not npm).

## 5. Merchant-normalization test — "absent" claim mismatch

**STATUS says (§5 v2.4.5 carry-forward debt, line 127; §6 blocker 6, line 177):** the named test suites *"do not exist in the tree"* / *"merchant-normalization … suites still absent."*

**Code reality:** `lib/transactions/merchant.test.ts` **exists**. (Several other flow/transaction suites also now exist: `flow-classifier.test.ts`, `flow-row-input.test.ts`, `plaid-flow-write.test.ts`, `plaid-flow-input.test.ts`.)

**Correction needed:** strike merchant normalization from the "absent test suites" carry-forward debt. Re-audit the remaining named suites (window/rollup math, follow-up/drilldown heuristics) individually rather than as a block — the block claim is now partly false.

> Caveat that belongs in the same fix: the test *files* exist but there is **no test runner** (no `npm test`, no jest/vitest, no runner binary). So "the suite exists" is true; "the suite is enforced/green in CI" is not. STATUS's repeated "suite green" language should be qualified accordingly.

## 6. Working-tree cleanliness — stale "not clean" claim

**STATUS says (§2, line 35):** active branch *"working tree **not** clean — design-foundation WIP + concluded Liquid experiment uncommitted."* KD-13 (line 198) says *"the v2.5 design-foundation working tree is uncommitted (WIP + rejected Liquid experiment + ~45 untracked docs)."*

**Code reality:** `git status --short` shows **4 untracked files**, all docs (`docs/INVESTIGATION_SINCE_LAST_VISIT_MODAL_DATA_TABS.md` and three EV-1/Timeline docs under `docs/initiatives/ev1/`). No uncommitted design/Liquid source. The Liquid experiment is committed (see §4). The "~45 untracked docs" figure is stale.

**Correction needed:** update §2 to "working tree effectively clean (4 untracked docs)" and update KD-13's working-tree clause. Also update the `package.json` version note if desired: STATUS §2 says `package.json = 2.4.5` while describing the project as v2.5 in progress — the file still reads `2.4.5` (accurate as stated, but worth a version bump decision).

## 7. Ghost `" 2"` directories — count and location drift

**STATUS says (KD-13, line 198):** *"six `" 2"` Finder-duplicate dirs present in the working tree"* — `lib/ai/{assemblers,context-priority,intelligence,intent,signals} 2/` and `lib/providers/plaid 2/`.

**Code reality:** there are now **19** empty `" 2"` directories, and they have spread beyond `lib/` into tracked source areas and the build cache: `app/api/spaces/[id] 2`, `app/api/spaces/invites 2`, `components/space/widgets 2`, `components/space/sections 2`, the six original `lib/` ones, four `.next/dev/...` cache ones, and four `docs/initiatives/d2/*` ones. All are empty and untracked (`git ls-files` shows 0 tracked files inside them).

**Correction needed:** update KD-13's count/scope (six → nineteen, `lib`-only → app/components/docs/.next as well). Root cause is almost certainly cloud-sync (iCloud/Dropbox) on the `Documents` folder duplicating directories — worth a one-line note so the fix (add to `.gitignore` / stop syncing, then delete) targets the cause, not just the symptom.

## 8. Legacy `Account` in read paths — exit criterion not met

**STATUS says (§5 v2.5 exit criteria, line 134):** *"zero legacy-`Account` queries in AI/read paths."* Listed as a v2.5 target; §3 D3 row treats legacy `Account` retention as intentional but "out of all read paths."

**Code reality:** legacy `Account` is still queried at runtime in three places: `lib/imports/authorize.ts` (`db.account.findFirst`), `app/api/admin/overview/route.ts` (`db.account.count`), and `app/api/accounts/[id]/transactions/route.ts` (`db.account.findFirst`).

**Correction needed:** this is not a doc typo but a genuine open item — flag the v2.5 "zero legacy-`Account` reads" exit criterion as **not yet met**, listing the three residual read sites, rather than implying read-path removal is complete.

---

## Summary of corrections needed (priority order)

1. **Re-verify STATUS against HEAD `2db97ef`, not `37f96f3`** (root cause of all drift below).
2. **Add SP-2 and EV-1 to the §3 ledger** — two completed initiatives are entirely missing.
3. **Reclassify KD-6/SEC-1 from Open → Resolved (code-complete)**; only the v1 read-branch removal gate remains.
4. **Fix the Liquid status** — shipped/committed/vendored/in-use, not rejected/uncommitted/npm-deps; preserve the nuance that only backdrop-refraction was rejected.
5. **Correct the test claims** — merchant-normalization suite exists; and qualify all "suite green" language, because there is no test runner enforcing any suite.
6. **Update working-tree and ghost-dir claims** — tree is effectively clean (4 untracked docs); ghost `" 2"` dirs are 19 and have spread beyond `lib/`.
7. **Flag the legacy-`Account` read-path exit criterion as unmet**, naming the three residual sites.

None of the above were applied. STATUS.md is unchanged.
