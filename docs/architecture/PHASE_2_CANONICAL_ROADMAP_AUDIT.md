# Phase 2 Canonical Roadmap Audit

**Audit only. No schema, migration, API, UI, or roadmap documentation was
modified to produce this document.**

**Conducted:** 2026-06-30  
**Scope:** Every Phase 2 initiative (D0–D14), every architecture doc that
defines or references the D-number scheme, current status of each initiative
grounded exclusively in commit history, schema evidence, and filed docs.

---

## 0. Method

Evidence consulted, in priority order:

1. **`docs/architecture/PHASE_2_DECISION_MATRIX.md`** — the only document that
   assigns D-numbers. Created 2026-06-22 (commit `dcb7c43`: "docs: freeze Phase
   2 architecture decisions"). **This document is the canonical source.**
2. **`docs/README.md`** — the documentation index, which explicitly names the
   d1–d12 folder-to-initiative mapping. Created 2026-06-24 (commit `b66d876`).
3. **`docs/initiatives/dN/`** folder contents and git commit history for every
   filed initiative doc.
4. **`prisma/schema.prisma`** — model/enum declarations and inline D-number
   citations in code comments.
5. **Application code** — file existence and code comments citing D-numbers
   (`lib/password-reset-token.ts`, `lib/accounts/reconcile.ts`, etc.).
6. **`git log --oneline`** — full commit timeline for all Phase 2 work.

The Freeze doc (`PHASE_2_ARCHITECTURE_FREEZE.md`), Database Architecture Review
(`DATABASE_ARCHITECTURE_REVIEW.md`), and D2 architecture docs were read in full
but do **not** assign D-numbers — they use section references (§N) or informal
shorthand. D-numbers exist only in the Decision Matrix and in documents written
after it. This distinction matters and is explained in §6.

---

## 1. Canonical Phase 2 Roadmap

The Decision Matrix defines D1–D14. D0 is an additional meta-initiative not in
the Decision Matrix. "PublishedAccountView" is a planned branch not assigned a
D-number in the Decision Matrix. Both are included here for completeness.

| ID | Initiative name | Status | Branch | Canonical source |
|---|---|---|---|---|
| D0 | Documentation IA restructure | **Complete** | None — standalone docs work | `docs/initiatives/d0/D0_DOCUMENTATION_IA_REVIEW.md`, `D0_STEP2_IMPLEMENTATION_REPORT.md`; commit `b66d876` 2026-06-24 |
| D1 | `DuplicateAccountCandidate` audit behavior | **Complete** | Small PR, before `feature/provider-adapter-layer` | Decision Matrix §D1; `docs/initiatives/d1/D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md`; `prisma/schema.prisma` DuplicateAccountCandidate model comment; commit `94aa6e2` 2026-06-22 |
| D2 | `AccountConnection` → `Connection` evolution (Provider & Connection initiative) | **In Progress — Closeout** | `feature/provider-adapter-layer` (branch 3) | Decision Matrix §D2; `docs/initiatives/d2/D2_ROADMAP.md`; `docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md`; `docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md`; `docs/initiatives/d2/D2_STEP7G_PRODUCTION_HARDENING_CLOSEOUT_AUDIT.md` |
| D3 | `WorkspaceAccountShare` → `SpaceAccountLink` migration | **In Progress — Legacy Retirement** | `feature/space-account-link-migration` (branch 4) | Decision Matrix §D3; `docs/initiatives/d3/D3_SPACE_ACCOUNT_LINK_REVIEW.md` through `D3_LEGACY_RETIREMENT_AUDIT.md`; commits 2026-06-23/24 |
| D4 | AI Context Builder: enforcement + `agentScope` | **Not Started** | `feature/ai-context-builder` (branch 6) | Decision Matrix §D4; `docs/initiatives/d4/` (empty — `.gitkeep` only) |
| D5 | Job scheduler: entrypoint + missing jobs | **Complete** | Standalone (outside the six-branch sequence) | Decision Matrix §D5; `docs/initiatives/d2/D2_STEP7C_SCHEDULER_WIRING_CHECKLIST.md`; commit `444cb6c` "fix(d2): add scheduled bank sync cron" |
| D6 | `ProviderCatalog` field set reconciliation | **Investigation filed; Not Implemented** | `feature/provider-catalog` (branch 2) | Decision Matrix §D6; `docs/initiatives/d6/D6_PROVIDER_DISCOVERY_INVESTIGATION.md` (2026-06-30) |
| D7 | `ProviderCatalog` ownership + admin UI | **Not Started** | `feature/provider-catalog` (branch 2) | Decision Matrix §D7; `docs/initiatives/d7/` (empty — `.gitkeep` only) |
| D8 | Archive/delete lifecycle consistency rule | **Complete** | Cross-cutting (stated in Decision Matrix; no separate branch) | Decision Matrix §D8; rule is: soft-delete by default, archive tier only when UX needs undo |
| D9 | `SpaceTemplate` & minimal marketplace foundation | **Not Started** | `feature/space-template-foundation` (new branch) | Decision Matrix §D9; `docs/initiatives/d9/` (empty — `.gitkeep` only) |
| D10 | Deferred scope ratification | **Complete** | None — explicit non-scope | Decision Matrix §D10; resolved in the Decision Matrix itself |
| D11 | `FinancialAccount.createdByUserId` + hash `passwordResetToken` | **Complete** | `feature/schema-modernization` (branch 1) | Decision Matrix §D11; `prisma/schema.prisma:666-675` (D11 comment inline); `lib/password-reset-token.ts` (D11 comment inline); commit `ba065ea` 2026-06-22 |
| D12 | Internal-ops Spaces / `isInternal` flag | **Intentionally Deferred** | Prerequisite of a future unnamed branch | Decision Matrix §D12 (B: add only when an internal-ops feature is scoped) |
| D13 | `Connection.credential` nullability | **Complete (baked in at foundation)** | `feature/provider-adapter-layer` (branch 3) | Decision Matrix §D13; `prisma/schema.prisma:532` — `credential String?` (nullable as decided); committed with Connection model foundation |
| D14 | Shared `ENCRYPTION_KEY` blast radius / per-purpose HKDF derivation | **Not Started** | `feature/encryption-key-derivation` (new branch, before branch 3) | Decision Matrix §D14; no `d14/` folder; no HKDF implementation in `lib/encryption.ts` |
| — | PublishedAccountView | **Not Started** | `feature/published-account-view` (branch 5) | Decision Matrix §3 revised sequence; no D-number assigned; no folder; no model in schema |

---

## 2. Completed initiatives

The following initiatives are fully complete. Evidence for each is cited.

**D0 — Documentation IA restructure**  
Filed: `docs/initiatives/d0/` (2 documents). `D0_DOCUMENTATION_IA_REVIEW.md`
(investigation) and `D0_STEP2_IMPLEMENTATION_REPORT.md` (implementation). The
`docs/` tree was reorganised into architecture/, initiatives/dN/, operations/,
bugfixes/, releases/, archive/ during commit `b66d876` on 2026-06-24. D0 is
not a Decision Matrix item — it is a meta-initiative to make the repo's own
documentation navigable before Phase 2 implementation work began.

**D1 — `DuplicateAccountCandidate` audit behavior**  
Decision: B — repurpose as audit log of automatic merges.  
Evidence: `prisma/schema.prisma` DuplicateAccountCandidate model comment states
"D1 (see `docs/initiatives/d1/D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md`)
repurposed this model from an unused human-review-queue design... into the audit
ledger described above." `lib/accounts/reconcile.ts`'s
`mergeArchivedDuplicateIntoCanonical` is the writer. Committed via `94aa6e2`
("feat: audit automatic duplicate account merges") on 2026-06-22 — the same
day the architecture docs were published.

**D5 — Job scheduler**  
Decision: C — independent infra fix, outside the six-branch sequence.  
Evidence: `docs/initiatives/d2/D2_STEP7C_SCHEDULER_WIRING_CHECKLIST.md` and
commit `444cb6c` ("fix(d2): add scheduled bank sync cron"). D5 was resolved as
a consequence of D2 Step 7C (Production Hardening sub-step) rather than a
standalone branch. The Decision Matrix explicitly placed it outside the
six-branch sequence; this is consistent with how it was delivered.

**D8 — Archive/delete lifecycle consistency rule**  
Decision: A — soft-delete (`deletedAt`) on canonical tables; archive tier only
where UX needs undo.  
Evidence: the rule is ratified in the Decision Matrix itself and applies
cross-cuttingly as new tables are built. No separate code deliverable was
required — every new model added during Phase 2 (`FinancialAccount`,
`Connection`, `ProviderAccountIdentity`, `SpaceAccountLink`, `ImportBatch`,
`ImportMappingProfile`, `DebtProfile`, `DuplicateAccountCandidate`) follows the
soft-delete-by-default pattern. D8 is a design rule, fully in force.

**D10 — Deferred scope ratification**  
Decision: A — ratify the full deferred list as out of scope.  
Evidence: Section 4 of the Decision Matrix formally ratifies the deferred list
(Marketplace/billing/payouts/messaging/full notifications/AI Ambient
Intelligence). No code change was needed; ratification is the deliverable.

**D11 — `FinancialAccount.createdByUserId` + hash `passwordResetToken`**  
Decision: A — add now.  
Evidence: (1) `prisma/schema.prisma:666-675` — `FinancialAccount.createdByUserId
String?` with comment "D11 (Phase 2 schema modernization): the human-accountable
party..."; (2) `lib/password-reset-token.ts` header comment: "D11 (Phase 2 schema
modernization) — hash passwordResetToken at rest."; (3) `app/api/auth/
reset-password/route.ts` and `forgot-password/route.ts` both call
`hashResetToken()`, storing SHA-256 hashes, not plaintext. Committed via
`ba065ea` ("feat: modernize schema foundation for holdings and reset tokens") on
2026-06-22. The `Holding` model received dual FKs (`accountId` optional /
`financialAccountId` optional) in the same commit, matching the project's
"additive before subtractive" standing rule.

**D13 — `Connection.credential` nullability**  
Decision: A — genuinely nullable.  
Evidence: `prisma/schema.prisma:532` — `credential String?` with comment
"encrypted; null for MANUAL; xpub/descriptor for WALLET watch-only." Correct
nullability was established when the Connection model was first added (as part of
D2 Step 1's Connection foundation commit). No separate migration was needed
because the field was declared correctly from the start.

---

## 3. Active initiative

**Two initiatives have outstanding open work: D2 and D3. Neither is formally
closed.**

### D2 — Provider & Connection (In Progress — Closeout)

The D2 initiative spans Steps 1–7, each with sub-steps. As of the most recent
commit (2026-06-30: "refactor(d2): add import provider capabilities"):

- Steps 1–4 and Step 7A–7G: complete. `D2_STEP7G_PRODUCTION_HARDENING_CLOSEOUT_AUDIT.md`
  represents a formal production-hardening closeout.
- Step 5 (Adapter Interface): Slice 1 (import provider capabilities /
  `lib/imports/provider-capabilities.ts`) landed in the most recent commit.
  Further slices are not yet closed.
- Step 6 (First real new provider — sync side): open. Two candidates (wallet
  watch-only, CSV) were closed as non-chosen; the sync-side second provider
  (Coinbase/Schwab/wallet-xpub) remains unselected.

D2 has active work as recently as today.

### D3 — SpaceAccountLink Migration (In Progress — Legacy Retirement)

The D3 initiative went through its full step sequence from foundation through
read-cutover in a concentrated burst on 2026-06-23 to 2026-06-24:

- Foundation + backfill + dual-write + most read-cutovers: complete.
- `D3_LEGACY_RETIREMENT_AUDIT.md` (2026-06-23) identifies **5 gating items**
  before `WorkspaceAccountShare` can stop being a write target: (1) fix one
  accidental remaining read in the archived-assets page; (2) migrate an
  authorization-load-bearing read in the account-delete handler; (3) confirm no
  data-completeness gaps via re-running the verify script; (4) fix the
  dual-write race in `accounts/manual/route.ts`; (5) harden silent-failure
  design in `lib/accounts/space-account-link.ts`. No D3 code has been committed
  since 2026-06-24.

### Which is the primary active initiative?

D3 is the primary active initiative by this project's own established sequencing
logic. The Decision Matrix's revised execution order places
`space-account-link-migration` (D3) *before* `provider-adapter-layer` (which
contains the remaining D2 items). The 5 gating items in D3's legacy retirement
audit represent a concrete, documented critical path to closing D3 before the
sequence can advance. D2's remaining open items (Steps 5 and 6) do not block D3
and are further in the adapter-layer branch sequence. Both have open work, but
D3's closure is the prerequisite for the next branch in the recommended sequence.

---

## 4. Remaining initiatives (in execution order)

The Decision Matrix's recommended revised order (§3 summary): `schema-
modernization → encryption-key-derivation → provider-catalog →
space-account-link-migration → provider-adapter-layer → published-account-view
→ ai-context-builder`, with `space-template-foundation` and standalone tasks
running in parallel.

Mapping to current state, the remaining work in sequence order is:

1. **D3 — `SpaceAccountLink` legacy retirement** *(in progress)*  
   5 gating items outstanding (D3_LEGACY_RETIREMENT_AUDIT.md §4). Must close
   before the sequence advances.

2. **D2 — Steps 5 and 6 remaining** *(in progress, parallel to D3)*  
   Step 5 Slice 2+ (full adapter interface shaping) and Step 6 (sync-side second
   provider selection and first native integration). The Decision Matrix places
   the full `feature/provider-adapter-layer` branch *after* D3, but D2's
   specific Step 5/6 work is its own sub-sequenced tail.

3. **D14 — Encryption key derivation** *(not started)*  
   The Decision Matrix recommends this land *before* `feature/provider-adapter-
   layer` (branch 3). It is the only prerequisite for branch 3 not yet done.
   No `feature/encryption-key-derivation` branch or `docs/initiatives/d14/`
   folder exists yet.

4. **D6/D7 — ProviderCatalog** *(investigation filed; implementation not started)*  
   `feature/provider-catalog` (branch 2). An architecture investigation
   (`D6_PROVIDER_DISCOVERY_INVESTIGATION.md`) was filed 2026-06-30. The Decision
   Matrix placed this branch earlier in the sequence (before `space-account-link-
   migration` and `provider-adapter-layer`) but the investigation's recommendations
   can feed implementation at any point.

5. **D2 / D13 — `feature/provider-adapter-layer`** *(the formal branch, not started)*  
   D13 is baked in (Connection.credential is already nullable). The formal
   `feature/provider-adapter-layer` branch work — wiring Connection to PLAID,
   dual-writing PlaidItem writes to Connection, read cutover, PlaidItem
   retirement — has not been formally opened.

6. **PublishedAccountView** *(not started; no D-number)*  
   `feature/published-account-view` (branch 5 in the Decision Matrix's revised
   six-branch sequence). No D-number was assigned. No folder, no model in
   schema, no commits.

7. **D4 — AI Context Builder** *(not started)*  
   `feature/ai-context-builder` (branch 6, last in the main sequence).
   `docs/initiatives/d4/` is empty.

8. **D9 — SpaceTemplate foundation** *(not started; parallel)*  
   `feature/space-template-foundation`. Decision Matrix notes this runs
   independently, not gated by the main sequence. `docs/initiatives/d9/` is
   empty; no `SpaceTemplate` model in schema.

9. **D12 — Internal-ops Spaces / `isInternal` flag** *(intentionally deferred)*  
   Decision Matrix: "B — add only when an internal-ops feature is scoped."
   Not gated to any branch in the current sequence. No target date.

---

## 5. Numbering inconsistencies

### 5a. Missing `d13/` and `d14/` initiative folders

**What:** The Decision Matrix defines 14 decisions (D1–D14). The
`docs/initiatives/` scaffold (committed 2026-06-24, commit `b66d876`) created
folders `d1/` through `d12/` only. `d13/` and `d14/` do not exist.

**Documents affected:** `docs/README.md` — its initiative index explicitly states
"`initiatives/d1/` … `initiatives/d12/`", never mentioning D13 or D14.

**Canonical mapping:** D13 = `Connection.credential` nullability; D14 = shared
`ENCRYPTION_KEY` blast radius / HKDF derivation.

**Why it happened:** D13 was baked into the Connection model foundation on the
same day the scaffold was created, so a folder for it was likely considered
unnecessary. D14 is a future, not-yet-started branch — no folder was needed yet.
The scaffold appears to have been generated for decisions that would require
filing work, skipping D13 (already resolved inline) and D14 (not yet started).

**Should it be updated?** `docs/README.md` should eventually say "D1–D14" and
`d14/` should be created when D14 work starts. D13 does not need a folder since
its implementation was a single, one-line, embedded decision during the
Connection model add.

---

### 5b. `prisma/schema.prisma` stale comments on `SpaceAccountLink`

**What:** Five locations in `prisma/schema.prisma` contain the comment
"SpaceAccountLink (D3) — additive, not yet read/written by application code":

- Line 335–337 (`User.addedSpaceAccountLinks`)
- Line 387–388 (`Space.accountLinks`)
- Line 726–727 (`FinancialAccount.spaceAccountLinks`)
- Lines 854–860 (`SpaceAccountLink` model header comment)

All four say the model is "not yet read or written by any [application code]."
This was accurate at the moment the model was first added (commit `5f3dfac`,
"feat: add space account link foundation," 2026-06-23). However, that same day
D3 proceeded through backfill, dual-write, and multiple read-cutovers. By the
time `D3_LEGACY_RETIREMENT_AUDIT.md` was filed (also 2026-06-23), dual-write
was live on all write paths and most read paths had been cut over.

**Canonical status:** SpaceAccountLink IS read and written by application code.
`lib/accounts/space-account-link.ts` is the dual-write shim, 12 write-path files
produce `SpaceAccountLink` rows, and multiple read paths (most API routes,
snapshot pipeline, brief route, spaces/accounts route) have been cut over per
`D3_LEGACY_RETIREMENT_AUDIT.md` §1.

**Documents affected:** `prisma/schema.prisma` (4 comment locations).

**Canonical mapping:** The D3 Legacy Retirement Audit is the authoritative
current-state source. The schema comments need updating to reflect the current
dual-write/partial-cutover state.

**Should it be updated?** Yes — these comments actively mislead anyone reading
the schema. Recommend updating schema comments when D3's formal closure work
(the 5 gating items) is done, so the final state can be described accurately in
one pass rather than incrementally.

---

### 5c. `D4 = ProviderCatalog` appears in conversational task briefs

**What:** In two separate conversational task briefs (the one that produced
`docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md`, and again in the
session that produced `docs/initiatives/d6/D6_PROVIDER_DISCOVERY_INVESTIGATION.md`),
the user referenced Provider Catalog work as "D4" and AI Context Builder as "D5"
— the opposite of the canonical Decision Matrix assignment.

**Documents affected:**  
- `docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md` §0 — explicitly
  catches and corrects the mismatch (created 2026-06-23). Its own §0 reads:
  "D4 | ProviderCatalog | D6/D7 | ... D5 | AI Context Builder | D4 | ..."  
- `docs/initiatives/d6/D6_PROVIDER_DISCOVERY_INVESTIGATION.md` §0 — also
  catches and corrects the same mismatch (created 2026-06-30, today).

**Canonical mapping:**
- D4 = AI Context Builder (enforcement mechanism + `agentScope` shape)
- D5 = Job scheduler: entrypoint + missing jobs  
- D6 = ProviderCatalog field set reconciliation  
- D7 = ProviderCatalog ownership + admin UI

**Documents that need eventual correction:** None currently filed in the repo use
the wrong numbering *without* also immediately correcting it. Both instances were
caught inline. No implementation doc was filed under the wrong D-number. The
work product is correct; only the incoming brief/prompt used the wrong labels.

**Should anything be updated?** The repo is clean on this. The session-level
project instructions (not a repo file) appear to use "D4 = ProviderCatalog"
framing — updating those would prevent this confusion from recurring.

---

### 5d. `docs/operations/PROJECT_STATE.md` and root `ROADMAP.md` are pre-Phase-2 and silent on D-numbers

**What:** Two docs are clearly pre-Phase-2 and contain no D-number references:

- `ROADMAP.md` (root) — lists "Next Milestones" as Milestone 1–6 (Active Space
  Experience, Background Sync Jobs, Historical Charts, FICO/Manual Entry, AI
  Advice Engine, Cloudflare Tunnel). Last stated update "June 2026 · v1.0." Does
  not mention any D1–D14 initiative, Connection model, SpaceAccountLink, or
  ProviderCatalog.
- `docs/operations/PROJECT_STATE.md` — last updated 2026-06-11 (pre-Phase-2).
  Lists models using pre-Phase-2 names (`Account`, `Holding`, `PlaidItem` only;
  no `FinancialAccount`, `Connection`, `SpaceAccountLink`, `ImportBatch`). Still
  describes codebase state before the Workspace→Space rename committed to the
  Prisma layer.

**Documents affected:** These two docs are stale relative to current codebase
state. They are neither incorrect about D-numbers (they simply predate the
D-numbering scheme) nor do they conflict with the canonical numbering.

**Should they be updated?** Yes — both should eventually be brought forward to
reflect Phase 2 progress. Neither is a source of confusion about initiative
numbering; they are just outdated snapshots.

---

### 5e. `D2_ROADMAP.md` uses "D3 SpaceAccountLink" as a future item but D3 is now in progress

**What:** `docs/initiatives/d2/D2_ROADMAP.md` (created 2026-06-24) includes a
note that "Provider Catalog polished UI remains a later v2.7 Provider Ecosystem
concern, not D2 foundation" and explicitly defers the Provider Catalog to D6/D7.
This D-numbering is correct. However, the D2_ROADMAP.md was written the same day
D3 work began, before D3 reached its current late-retirement state. Any language
in D2_ROADMAP.md framing D3 as "future" or "not yet built" is now stale.

**Canonical mapping:** D3 is in progress, not future. The D2_ROADMAP.md's
D-numbering references (D6/D7 = ProviderCatalog) are correct.

**Should it be updated?** The D-number references are fine. Any D3-status
characterizations should be refreshed when D3 closes.

---

## 6. Historical explanation: how "D4 = ProviderCatalog" entered the discourse

### What happened

The mislabeling appears **twice** in the conversational record — both times
corrected by repo documents before any wrong-numbered file was actually filed.

The first occurrence produced `docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md`
(2026-06-23). That document's §0 contains a correction table, which itself is
the primary repo evidence that the confusion existed:

> "The investigation brief's §6 asks about dependencies on 'D3 SpaceAccountLink,
> D4 ProviderCatalog, D5 AI Context Builder, D6 Space Templates, D7 Ownership &
> Sharing, D8 PublishedAccountView.' Those labels do not match
> PHASE_2_DECISION_MATRIX.md, which is this project's canonical D1–D14 numbering."

The second occurrence produced `docs/initiatives/d6/D6_PROVIDER_DISCOVERY_INVESTIGATION.md`
(2026-06-30, today), which also opens with a §0 numbering correction.

### What the repository evidence shows

**The D-number scheme was introduced on 2026-06-22** in a single commit
(`dcb7c43`: "docs: freeze Phase 2 architecture decisions") that created all
three governing architecture docs simultaneously:
`PHASE_2_ARCHITECTURE_FREEZE.md`, `PHASE_2_DECISION_MATRIX.md`, and
`DATABASE_ARCHITECTURE_REVIEW.md`. The Freeze doc does not assign D-numbers
anywhere — a grep for "D1" through "D14" across that file returns no matches.
D-numbers exist exclusively in the Decision Matrix and in documents written after
it.

**The Freeze doc uses section references, not D-numbers.** Its open-decisions
summary is §19.1–§19.9, which the Decision Matrix uses as its own source
references (e.g. "D6 | §14, §19.2"). These are not the same numbering — §19.2
in the Freeze doc corresponds to D6 (ProviderCatalog) in the Decision Matrix,
not D2. Anyone mapping Freeze §N directly to "Decision N" would produce the
wrong D-numbers. This is the most likely origin of the shift.

**The "D4 = ProviderCatalog" numbering is an off-by-one error.** The canonical
mapping:

| Decision Matrix (canonical) | Alternative (incorrect) | What it covers |
|---|---|---|
| D4 | D3 (skipped) | AI Context Builder |
| D5 | D4 | Job scheduler |
| D6 | D5 (as claimed in brief) | ProviderCatalog field set |
| D7 | D6 | ProviderCatalog admin UI |

The pattern suggests a one-step shift starting around D4, not random reassignment.
One plausible mechanism: an early informal mapping of "which branches are there"
went directly from D3 (SpaceAccountLink) to D4 (ProviderCatalog), skipping the
Decision Matrix's D4 (AI Context Builder) and D5 (Job scheduler) — both of which
were relatively minor decisions not associated with a major "branch" in the
six-branch sequence. Alternatively, the Freeze doc's §12 (AI Context Builder)
and §9.4 (SpaceTemplate) are less prominent than §9.3 (SpaceAccountLink), §14
(ProviderCatalog), and §16 (branch sequence), and may have been mentally
de-emphasized when someone was building their own numbering from the Freeze doc's
structure rather than from the Decision Matrix.

### What is NOT in the repo

No repository file uses "D4 = ProviderCatalog" as a settled, uncorrected claim.
Neither instance created a filed doc under the wrong D-number folder — both were
caught immediately. The confusion appears to live exclusively in external session
memory or notes, not in any committed doc, and resurfaces periodically because
the session-level project configuration (which is not a repo file and therefore
not visible in git history) uses the incorrect numbering.

### Conclusion

The D-number scheme originated in the Decision Matrix on 2026-06-22. The Freeze
doc (same date) does not use D-numbers at all, using §N notation instead. The
mismatch entered the discourse sometime between 2026-06-22 and 2026-06-23 (when
`D2_CONNECTION_ARCHITECTURE_REVIEW.md` first documented it), likely through
informal use of the Freeze doc's section structure as a proxy for initiative
numbers without consulting the Decision Matrix. It has appeared twice; both times
the repo caught it. The fix is to use the Decision Matrix's canonical table as
the source of truth rather than section-numbering the Freeze doc directly, and to
update the session-level project instructions that still use the incorrect mapping.

---

## Appendix: Summary table

| ID | Name | Status | Evidence location |
|---|---|---|---|
| D0 | Documentation IA | Complete | `docs/initiatives/d0/`; commit `b66d876` |
| D1 | `DuplicateAccountCandidate` audit | Complete | `prisma/schema.prisma` DuplicateAccountCandidate comment; commit `94aa6e2` |
| D2 | `AccountConnection` → `Connection` evolution | In Progress — Closeout | `docs/initiatives/d2/D2_ROADMAP.md`; `D2_STEP7G`; commit `18f0922` (today) |
| D3 | `SpaceAccountLink` migration | In Progress — Legacy Retirement | `docs/initiatives/d3/D3_LEGACY_RETIREMENT_AUDIT.md`; commits `5f3dfac`–`9f35809` |
| D4 | AI Context Builder | Not Started | `docs/initiatives/d4/` (.gitkeep only) |
| D5 | Job scheduler | Complete | `D2_STEP7C_SCHEDULER_WIRING_CHECKLIST.md`; commit `444cb6c` |
| D6 | `ProviderCatalog` field set | Investigation filed; Not Implemented | `docs/initiatives/d6/D6_PROVIDER_DISCOVERY_INVESTIGATION.md` (today) |
| D7 | `ProviderCatalog` admin UI | Not Started | `docs/initiatives/d7/` (.gitkeep only) |
| D8 | Archive/delete lifecycle rule | Complete | Ratified in Decision Matrix; applied cross-cuttingly |
| D9 | `SpaceTemplate` foundation | Not Started | `docs/initiatives/d9/` (.gitkeep only) |
| D10 | Deferred scope ratification | Complete | Decision Matrix §D10 |
| D11 | `FinancialAccount.createdByUserId` + `passwordResetToken` hash | Complete | `prisma/schema.prisma:666-675`; `lib/password-reset-token.ts`; commit `ba065ea` |
| D12 | `isInternal` flag | Intentionally Deferred | Decision Matrix §D12 (add only when scoped) |
| D13 | `Connection.credential` nullability | Complete (baked in) | `prisma/schema.prisma:532` |
| D14 | Encryption key derivation (HKDF) | Not Started | No `d14/` folder; no HKDF in `lib/encryption.ts` |
| — | PublishedAccountView | Not Started | No D-number; no folder; no model |
