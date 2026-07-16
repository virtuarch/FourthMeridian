# Fourth Meridian — Documentation Invalidation & Knowledge Architecture Cleanup Audit

**Date:** 2026-07-16 · **Branch:** `feature/v2.5-spaces-completion` · **HEAD:** `da4b385`
**Posture:** Read-only investigation. No file was modified, moved, deleted, committed, or pushed. Counts are from `git ls-files` + `wc`; classifications from filename conventions, in-file banners, and spot-reads of representative documents in every category.

---

## Executive summary

The documentation corpus is **87,741 markdown lines across 440 tracked files** (docs/ = 83,686 lines / 414 files; repo root = 19 files / 4,232 lines; remainder in content/, lib/, vendor notices) for a codebase that is five weeks old, solo-maintained, and pre-user. Two directories — `initiatives/` (208 files, 35.5k lines) and `investigations/` (133 files, 30.7k lines) — hold **79% of all documentation** and are almost entirely *records of completed work*: closeouts, checklists, validations, parallelization studies, agent handoffs. 143 files carry explicit "immutable / point-in-time / superseded" banners — the corpus openly declares a third of itself to be history. Meanwhile the durable knowledge a newcomer actually needs is thin and scattered: FI0 lives loose in `docs/`, four "Space Dashboard Doctrine" documents live in `investigations/`, a UX doctrine lives at the repo root, and STATUS.md — the self-declared single truth — is 212KB, 88% of which is four append-only history sections, and was already 16 commits stale on the day of the SD wave.

The house convention that created this ("initiative history immutable; STATUS is the only current-state document; copy forward, never edit") was designed to prevent drift. It now *produces* drift: truth is maintained by hand in a 212KB file because everything else is frozen, and the frozen mass grows faster than anyone can index it. Git history already preserves every one of these documents; keeping them in the working tree preserves only their weight.

**Verdict:** a major cleanup is justified and largely safe to execute immediately. After extracting ~25–30 durable rationale documents, roughly **300–340 files and 55–65k markdown lines (65–75% of the corpus)** can be deleted or archived out of the tree. The end state is a ~35–50 file documentation set organized around doctrine / architecture / systems / operations / plans / audits, plus a STATUS.md under 15KB.

---

## 1. Corpus inventory

| Location | Files | LOC | Nature (sampled) |
|---|---|---|---|
| `docs/initiatives/` | 208 | 35,466 | 36 track dirs; dominated by d2 (65 files/10.3k: investigations/implementation/validation/closeout subdirs), d4 (8/3.9k), flowtype (15/3.8k), d2x (25/2.7k), mc1 (16/1.8k). Five dirs (d5,d7,d8,d10,d12) contain only `.gitkeep` — empty scaffolding. |
| `docs/investigations/` | 133 | 30,725 | Cross-cutting investigations, checklists, proposals, five "doctrine" docs, five V2.5 status-audit generations, two Merchant-Intelligence generations. |
| `docs/architecture/` | 11 | 4,341 | Mixed: 4 canonical/doctrinal + 7 explicitly point-in-time immutable records. |
| `docs/implementation-plans/` | 16 | 4,497 | Dated tab/perspective-redesign plans, nearly all shipped (their completion reports exist). |
| `docs/archive/` | 7 md + 3 png | 2,388 | v1-era snapshots (PROJECT_STATE, WORKSPACE_STATUS, PLAN_ORIGINAL, rename plan/spec, QA pass, widget meta analysis). |
| `docs/design-system/` | 10 md + assets | 1,813 | Atlas material doctrines, checklists, unification proposal, HTML design language. |
| `docs/audits/` | 4 | 663 | Dead-code ×2 (07-12, 07-13), repository audit, route reachability. |
| `docs/bugfixes/` | 3 | 525 | Closed point-in-time bug writeups. |
| `docs/operations/` | 5 | 573 | Jobs runbook, deployment, hydration rules, key rotation, OPS4 readiness checklist. |
| `docs/completions/` | 3 | 219 | 07-13 completion certificates. |
| `docs/releases/` | 1 | 145 | v2.0.1 only — no notes for v2.4/v2.4.5/v2.5 era. |
| `docs/` loose | 13 | ~2,900 | FI0 doctrine, 7 stray investigations (KD-7/10/11, brief/daily-report, modal), overlay family, roadmap revision proposal, test-runner investigation, README. |
| `docs/design/`, `docs/images/` | ~0 md | — | Empty design subdir; screenshots incl. one UUID-named personal-looking PNG. |
| Repo root | 19 | ~4,600 | STATUS.md (212KB/553 lines), checklists, runbook, 8 dated audit/completion reports, README, ROADMAP redirect stub, product language. Untracked: two 2026-07-16 review docs, two mockup PNGs. |

Context: total source is ~172.6k ts+tsx lines — documentation is >50% the size of the codebase, and `initiatives+investigations` alone equal ~38% of all source.

---

## 2. Verdict against the target model

The proposed `doctrine / architecture / systems / operations / releases / plans / design / audits` model fits this repo well, with two adjustments:

1. **`systems/` is the missing layer that matters most.** The repo has doctrine (good) and history (too much) but almost no per-system "what it is / why it is this way / what rules bind it" documents. Everything in §4 below currently lives inside dated initiative reports.
2. **Keep decision records, kill status records.** `docs/architecture/` already distinguishes "DECISION RECORD — immutable" (keep: Decision Matrix) from "POINT-IN-TIME RECORD — superseded for status" (mostly archive). The target `architecture/` should hold ADR-style decision records and boundary maps only — no document that contains a status table.

---

## 3. Initiatives — is the concept still useful?

**As a work-tracking unit: yes. As a permanent documentation home: no.** The current model gives every initiative a permanent folder of investigations → plan → checklists → validation → closeout, all immutable. That is a *project-management archive*, not documentation. d2 alone is 65 files; five step-closure reviews under `d2/closeout/` restate the same convergence rules the Phase 2 Doctrine already canonized in 79 lines.

Classification of the 208 initiative files (by category; file-level dispositions in §18 are directory-granular where content is homogeneous):

| Class | Approx. share | Examples | Disposition |
|---|---|---|---|
| DOCTRINE / DURABLE_ARCHITECTURE | ~10 files | `flowtype/` foundation + transfer-evidence design, `mc1/` roadmap+charter (decision content), `dec/DEC-0`, `kd15/` visibility ruling, `db1/` rename record, `spaces-decomposition/SD4 contract priming` (rationale sections) | EXTRACT → doctrine/systems, then archive originals |
| ACTIVE_PLAN | ~3 files | `platops/` (untracked investigation is today's), open residual ledgers | KEEP → `plans/` |
| COMPLETION_ARTIFACT | ~90 files | every `*_CLOSEOUT*`, `*_COMPLETION*`, `closeout/`, `validation/`, checklists | DELETE (git history retains) |
| INVESTIGATION_ARTIFACT | ~70 files | `d2/investigations/`, `d2x/`, per-slice studies | DELETE after §4 extraction where flagged |
| STALE / DUPLICATE / DELETE_CANDIDATE | ~30 files | superseded roadmaps (`D2_ROADMAP` frozen-with-corrections), INDEX files, parallelization/sequencing studies, 5 empty dirs | DELETE |

**Recommendation: dissolve `initiatives/` as a permanent home.** An initiative gets (a) one *active* plan in `plans/` while open, (b) durable conclusions merged into `doctrine/`/`systems/` at close, (c) everything else deleted at close. The alias table and D-number authority survive as one page in `architecture/`.

---

## 4. "Why the code is this way" — durable reasoning to extract

These conclusions exist today only inside dated artifacts and must survive the cleanup. Proposed extraction map:

| Durable truth | Current burial site(s) | Target |
|---|---|---|
| Why Investments *current* = `getCurrentPositions` and *historical* = A10; why the composed `InvestmentsSpaceData` envelope exists | A10 investigation (07-12), SD4 canonical-data audit (07-16), post-SD3 contract investigation, code headers | `systems/investments.md` |
| Why `WealthResult` is the Wealth boundary and no `WealthSpaceData` exists | SD-4 contract-priming wave doc §, SD-5 commit message | `systems/wealth.md` |
| Why Liquidity history is a **splice** (live anchor + reconstructed past) | LIQ-H1 commit, `historical-splice.ts` header, SD-6B | `systems/liquidity.md` |
| Why crypto is **excluded** from the snapshot `totalInvestments` bucket but **included** in A10's investments view (ratified taxonomy split) | `valuation.investment-bucket.test.ts`, A-track docs, 07-16 self-audit item G | `doctrine/historical-data.md` (must be stated as doctrine, not left in a test) |
| Transfer **rail ≠ purpose**; evidence axes persisted, pairing resolved at read; why cross-currency pairs are unresolvable today | flowtype/transfer-evidence foundation docs | `doctrine/financial-semantics.md` |
| FlowType precedence, `UNKNOWN` honesty, classifier/predicate write/read split, versioned backfill | `flowtype/` (15 files) + FI0 §§ | `doctrine/financial-semantics.md` (FSA already covers ~70% — merge into it) |
| KD-15: a row's transfer disposition is a *(row, viewer)* fact — visibility gating inside semantics | `kd15/` (332 lines) | `doctrine/financial-semantics.md` |
| MC1 rulings: read-time conversion (not stored normalized), reporting currency on the Space, historical FX never today's rate, crypto = asset not currency | `mc1/` roadmap + charter + STATUS rows | `doctrine/money-and-fx.md` |
| Why Perspectives are domain-neutral; workspace/lens separation | `PERSPECTIVE_WORKSPACE_DOCTRINE_2026-07-09` + A5 shared-engine investigation (both in `investigations/`) | fold into `SPACE_CONTRACT_DOCTRINE` or `systems/spaces.md` |
| Why SpaceShell owns URL/time/FX/display-currency capabilities; workspace dataNeeds contract | `SPACE_CONTRACT_DOCTRINE` (already canonical — keep; append SD-0A…SD-7 "as built" addendum) | `doctrine/spaces.md` |
| Snapshot immutability vs amendment consent boundary; estimated vs observed rows; A9 re-derivation rules | d2x slices, A-track investigations, snapshot module headers | `doctrine/historical-data.md` |
| DEC-0: Float debt, epsilon inventory, Decimal migration plan | `dec/DEC-0` (363 lines — already durable) | move to `architecture/decisions/DEC-0.md`, keep verbatim |
| Provider/connection identity model (Connection vs PlaidItem, provider identity, import provenance) | `d2/` architecture docs + `D2_PROVIDER_CONNECTION_ARCHITECTURE` | `systems/connections.md` |
| Why platform Spaces share the shell frame but not customer authz | PO1.0 docs, `platform-surface` comments | `systems/platform-ops.md` |

Estimated extraction effort: 25–30 target documents, mostly assembled from existing prose.

---

## 5. Doctrine audit

| Document | Location | Class | Notes |
|---|---|---|---|
| `FI0_FINANCIAL_INTELLIGENCE_DOCTRINE` (460) | `docs/` loose | **CANONICAL** | The north star. Wrong location only. |
| `FINANCIAL_SEMANTIC_AUTHORITIES` (403) | architecture/ | **CANONICAL** | "Current through P2-7D" — needs a currency check post-SD, else best-in-corpus. |
| `SPACE_CONTRACT_DOCTRINE` (628) | architecture/ | **CANONICAL, PARTIAL** | Ratified 2026-07-16; §15 phase plan is now *history* (SD-0A…SD-7 built same day) — needs an "as-built" amendment, not a rewrite. |
| `PHASE_2_DOCTRINE` (79) | architecture/ | **CANONICAL** | Permanent truth-spine contract; exemplary size. |
| `PHASE_2_DECISION_MATRIX` (363) | architecture/ | **CANONICAL (decision record)** | Sole D-number authority. Keep immutable. |
| `PERSPECTIVE_WORKSPACE_DOCTRINE` (193) | investigations/ | **OVERLAPPING** | Mislocated; merge into Space doctrine. |
| `SPACE_DASHBOARD_DOCTRINE` + `_COMPOSITION_` + `_EXPERIENCE_` + `_INTERACTION_` (4 docs, ~1,300) | investigations/ | **SUPERSEDED / OVERLAPPING** | Pre-SD dashboard-era design language; the contract doctrine + shipped code supersede the architectural content; UX-feel content belongs to design if kept at all. |
| `FOURTH_MERIDIAN_PROVIDER_CONNECTION_UX_DOCTRINE` (101) | repo root | **PARTIAL** | Real rules, wrong place — merge into `systems/connections.md`. |
| `ATLAS_GLASS_MATERIAL_DOCTRINE`, `ATLAS_GLASS_MODAL_DOCTRINE`, `ATLAS_LIQUID_PLATFORM_DOCTRINE` | design-system/ | **CANONICAL (design)** | Keep; consolidate the three + checklists into one Atlas doctrine when convenient. |
| `PERSPECTIVE_INFORMATION_ARCHITECTURE_BLUEPRINT`, `UNIFIED_SPACE_WIDGET_LAYOUT_ARCHITECTURE`, `DASHBOARD_DOCTRINE_PRINCIPAL_REVIEW`, `OVERLAY_CONVERGENCE_FAMILY` | investigations/ + docs/ | **STALE→SUPERSEDED** | Era documents; extract any surviving rule into Space doctrine, then archive. |

**Conflicts found:** no direct rule contradictions between canonical docs; the conflicts are *freshness* conflicts (SPACE_CONTRACT_DOCTRINE §15 plan vs built reality; FSA "current through P2-7D" vs A-track/SD additions) and *authority ambiguity* (four dashboard doctrines nobody marked superseded). Old terminology ("Workspace" for Space) persists in archive-era docs only — acceptable there, but the four dashboard doctrines still speak the pre-perspective vocabulary.

**Recommended canonical doctrine set (6 docs):** `financial-semantics.md` (FSA + FlowType + transfer evidence + KD-15), `money-and-fx.md` (MC1 rulings), `historical-data.md` (snapshot/amendment/estimated-observed/A9/A10 rules + crypto bucket split), `spaces.md` (Space Contract Doctrine + perspective doctrine + as-built addendum), `platform-and-security.md` (grants, authz families, platform separation), `intelligence.md` (FI0, trimmed of its process sections). Everything else is architecture, system, or history.

---

## 6. Completion reports

`docs/completions/` (3 files, 219 lines) plus ~8 root-level `*_COMPLETION_*.md` plus ~90 closeout/validation artifacts inside `initiatives/`. Spot-reads: they record scope, commits, and verification steps — information Git history and the (proposed, smaller) release notes already carry. None of the three in `docs/completions/` contains architectural rationale absent from doctrine; the root-level SHELL_NAV and TRANSACTIONS_TAB completions contain small "why" fragments that their corresponding implementation-plan/investigation docs already state.

**Recommendation:** default **DELETE** for all completion certificates once §4 extraction lands. Exceptions: `PO1_0_COMPLETION` (contains the platform-grant capability matrix as-shipped — EXTRACT_REASONING_THEN_DELETE), and any completion younger than the current release cycle (KEEP_TEMPORARILY until v2.5 ships, then delete).

---

## 7. Archives

`docs/archive/` = 7 markdown (2,388 lines) + 3 mockup PNGs, all v1/June-era: PROJECT_STATE (local-first Docker era), WORKSPACE_STATUS, PLAN_ORIGINAL, WORKSPACE_TO_SPACE_RENAME_PLAN, WORKSPACE_TYPE_SPEC, QA_PASS_2_REPORT, WIDGET_META_ANALYSIS. Checked for: unique architectural reasoning — none that survived the rename and Phase 2 (the rename plan's outcome is fully embodied in `db1/` + schema `@@map`s); migration evidence — Git history covers it; legal/security value — none.

**Recommendation: DELETE the directory's markdown entirely** (P0). The user's hypothesis is confirmed. Keep nothing for sentiment; Git history is the archive. The three PNGs: delete or move to `docs/design/assets` if any mockup is still referenced (none found).

---

## 8. Investigations

133 files / 30.7k lines, plus 7 strays in `docs/` and 23 more under `d2/investigations/`. Classified by spot-read + outcome tracing:

- **ACTIVE_DECISION_INPUT (~8):** `POST_SD3_WORKSPACE_CONTRACT_INVESTIGATION` and `SD4_CANONICAL_DATA_AUDIT` (feed the next wave), `INVESTMENTS_DATA_CAPABILITY`/`REMAINING_VISUALS_FEASIBILITY` (open product decisions), `CLOSURE_STRATEGY`, `LEGACY_CONVERGENCE` (open seams: Holding retirement), `TEST_RUNNER_CI`, `RECEIPT_INTELLIGENCE_UNPARK`. **KEEP** → `plans/` or `investigations/active/`.
- **RESOLVED_AND_ABSORBED (~85):** the A1–A10 series (shipped), FlowType/transfer/classification series (shipped + doctrine exists), MC1 (closed), perspective/UX-PER/UX-CUST series (shipped), shell-nav/tab-redesign series (shipped, have completion reports), SEC-1/KD-4/5/6 (closed), STATUS drift/reconciliation series (era artifacts). **DELETE** after the §4 extraction list is satisfied — for most, the durable conclusion already exists in doctrine or code headers.
- **UNRESOLVED (~10):** brokerage transfer semantics inputs, `INVESTIGATION_AIADVICE_WRITER_SURFACING_LOOP` (the never-built writer — decision still open), `SPACE_CLUSTERING_FINANCIAL_TOPOLOGY`, `MERIDIAN_ANALYST_*` (parked product ideas). **KEEP** as one-line entries in a parked-ideas ledger; the full documents can go.
- **SUPERSEDED/DUPLICATE (~30):** five generations of V2.5 status audits, two STATUS-drift docs, `V2.5_LATERAL/ROADMAP_ORDERING` audits, duplicate Merchant-Intelligence generations (6 docs where the persisted-tier plan superseded the rest), Atlas step-checklists (A/B/C) after the material engine landed. **DELETE.**

**The five "doctrine" documents filed under investigations are the directory's real cost:** canonical-sounding truth that readers cannot distinguish from the 85 resolved artifacts around it.

---

## 9. Audits

Current inventory: 4 in `docs/audits/` + 5 root-level (07-06/07-07 era) + 2 untracked 07-16 reviews + the 07-16 code audit (saved to `docs/initiatives/architecture/` — itself misfiled; it belongs here in `docs/audits/`).

| Audit | Class | Disposition |
|---|---|---|
| Post-SD8 code invalidation audit (07-16) | CURRENT_RISK_AUDIT | KEEP — the current architecture audit; **move to `docs/audits/`** |
| STAFF review + self-audit (07-16, untracked) | CURRENT_RISK_AUDIT (pre-SD baseline) | KEEP one merged copy in `docs/audits/`; the self-audit's corrections should be folded in rather than kept as a pair |
| `REPOSITORY_AUDIT_2026-07-12` | SUPERSEDED_AUDIT (by 07-16 audits) | DELETE_AFTER_RELEASE — or now; every live finding is restated in the 07-16 audit |
| Dead-code audits 07-12 + 07-13 | HISTORICAL_ONLY (cleanups executed, completion certs exist) | DELETE |
| `ROUTE_REACHABILITY_AUDIT_2026-07-13` | HISTORICAL_ONLY | DELETE |
| `PRELAUNCH_AUDIT_2026-07-06`, `ARCHITECTURE_AUDIT_2026-07-07`, `SECURITY_AUDIT_2026-07-07`, `SECOPS_ARCHITECTURE_REVIEW_2026-07-07` (root) | SUPERSEDED for architecture; security ones remain the *only* security audits | Architecture/prelaunch: DELETE_AFTER_RELEASE. Security pair: **KEEP** as the current security audit until re-run; move to `docs/audits/`. |

**Target steady state (user's preference honored):** exactly three living audits until public release — one architecture (07-16), one security (07-07 pair merged), one production-readiness (regenerate from `OPS4_PRODUCTION_READINESS_CHECKLIST` + STATUS §6). Everything else deleted; audits as a category expire at first production release.

---

## 10. Operations

Five docs, all legitimate: `BACKGROUND_JOBS_RUNBOOK`, `DEPLOYMENT`, `KEY_ROTATION_RUNBOOK`, `HYDRATION_RULES` (really an engineering convention — belongs in `architecture/` or a CONTRIBUTING doc, not operations), `OPS4_PRODUCTION_READINESS_CHECKLIST` (input to the production-readiness audit). Root-level `INCIDENT_RESPONSE_RUNBOOK` (555), `SECURITY_CHECKLIST` (561), `RELEASE_CHECKLIST` (489) belong here too. No meaningful duplication found. **KEEP all; MOVE the three root files into `docs/operations/`; reclassify HYDRATION_RULES.**

---

## 11. Releases

`docs/releases/` contains only `v2.0.1.md` — releases stopped being recorded three versions ago, while release *truth* migrated into STATUS §2/§5 and completion certificates. That is the honesty gap: v2.4.5 shipped "with carry-forward verification debt" (STATUS's own words) and has no release note saying so.

**Recommendation:** adopt the five-field format (version · what actually shipped · known gaps · migration requirements · production readiness) and backfill exactly two notes: `v2.4.5` and `v2.5` (when it ships), sourced from STATUS §5's exit-criteria bullets. Move roadmap content *out* of releases and STATUS into `plans/ROADMAP.md`. Do not backfill further.

---

## 12. Implementation plans

16 files / 4.5k lines. Classification: **COMPLETED (13)** — all the 07-11→07-13 tab/perspective-redesign and shell-nav plans shipped (their completion reports and/or code exist); **SUPERSEDED (1)** — `CASHFLOW_AND_MOBILE_AUTH` (cash-flow half shipped differently under SD-6C; mobile-auth half never scheduled — extract the mobile-auth intent to parked ideas); **ACTIVE/APPROVED_NEXT (2)** — none strictly active in this dir today (the live plan, platops, sits untracked in `initiatives/platops/`); PO1.0 plan is completed. **Recommendation: DELETE the 13 completed plans** (their durable design content is the *investigation* docs already covered in §8, and the shipped code), keep the directory as `plans/` for genuinely active work.

---

## 13. Design / design-system

Keep. `Fourth-Meridian-Design-Language-v1.html` + the three Atlas doctrines + assets are the durable core. Consolidation candidates only: the two liquid-standardization checklists and `MATERIAL_ENGINE_PHASE_1A_CHECKLIST` are completed work-tracking (DELETE); `ATLAS_MATERIAL_CLASSIFICATION_REPORT` + `ATLAS_MATERIAL_ENGINE_UNIFICATION_PROPOSAL` + `ATLAS_MATERIAL_LIBRARY_INVESTIGATION` collapse into one "Atlas materials" doc; `SPACES_OVERVIEW_REDESIGN_CHECKLIST` is completed (DELETE). `docs/design/transactions-redesign/` is empty — remove. `docs/images/` includes a UUID-named PNG that looks personal — **REVIEW_MANUALLY** (STATUS §10 itself flagged personal photos once already).

---

## 14. STATUS.md — dedicated audit

553 lines, 212,696 bytes. Byte distribution: **Initiative ledger §3 = 69.5KB (33%) · Roadmap §5 = 43.7KB (21%) · Known defects §7 = 30.1KB (14%) · Verification = 22.7KB (11%) · Current focus = 20.6KB (10%)** — five sections are 88% of the file. Individual table rows exceed 4,000 characters (the MC1 row is a small essay with 12 embedded links). It was last updated 02:31 on 2026-07-16 and does not contain the SD-1…SD-7 wave — the "only document allowed to describe current state" is structurally unable to keep up with commit velocity, which the repo's own `STATUS_DRIFT_INVESTIGATION` already proved once.

Answers to the brief's questions:

1. **What should it contain?** Exactly: current version + branch; the active initiative (one paragraph); blockers; next 3–5 steps; production-readiness snapshot (the §6 table, which is already good); pointers.
2. **What moves elsewhere?** §3 ledger → per-initiative one-pagers (or dies with the initiatives structure, §3 of this report); §5 roadmap → `plans/ROADMAP.md`; §7 defects → `DEFECTS.md` or the issue tracker (it is an issue tracker in a table); Verification section → CI / RELEASE_CHECKLIST; §4 alias table → `architecture/initiative-naming.md` (immutable, done); §§8–11 → parked-ideas file, docs README, delete, delete.
3. **Can it reduce to version/active/blockers/next/readiness?** Yes — those five sections currently total under 10KB of its 212KB.
4. **Generated ledger?** Yes, if a ledger survives at all: the honest options are (a) generate the table from per-initiative front-matter, or (b) stop maintaining a ledger and let `git log` + release notes carry completion history. Given solo capacity, (b) is recommended; (a) only if the ledger provably drives decisions.
5. **Historical duplication sections:** §3 and §5 duplicate each other for every completed initiative (same initiative described in both, at essay length); both duplicate the initiative folders and the completion certificates. §7's closed defects duplicate bugfix docs. The Verification header duplicates RELEASE_CHECKLIST.

**Proposed durable format: ≤150 lines / ≤15KB**, hard rule: no completed work is ever *described* in STATUS — only linked.

---

## 15. Root-level markdown

| File | Disposition |
|---|---|
| `README.md` | KEEP — but rewrite: still describes the local-first Docker/Cloudflare product (falsified by Vercel/Supabase reality; flagged in two prior audits) |
| `STATUS.md` | KEEP, shrink per §14 |
| `ROADMAP.md` (7-line redirect stub) | DELETE once roadmap lands in `plans/` |
| `SECURITY_CHECKLIST`, `INCIDENT_RESPONSE_RUNBOOK`, `RELEASE_CHECKLIST` | MOVE → `docs/operations/` |
| `fourth-meridian-product-language.md` | MOVE → `docs/design/` |
| `FOURTH_MERIDIAN_PROVIDER_CONNECTION_UX_DOCTRINE.md` | EXTRACT into `systems/connections.md`, then delete |
| `ROADMAP_ARCHITECTURAL_PRIORITIZATION.md` | SUPERSEDED (portfolio master plan + STATUS §5 era) — DELETE |
| 8 dated audit/completion reports (`*_2026-07-*.md`) | Per §9: security pair MOVE → `docs/audits/`; the rest DELETE (completions) or DELETE_AFTER_RELEASE (prelaunch/architecture audits) |
| Untracked: 2 review docs, 2 mockup PNGs, `_to_delete/` (414MB tarballs) | Reviews → `docs/audits/` (tracked, merged); PNGs → design assets or delete; tarballs delete |

The root steady state: `README.md`, `STATUS.md`, nothing else.

---

## 16. Duplication graph — canonical owners

| Repeated truth | Copies found | Canonical owner (proposed) |
|---|---|---|
| Space/Workspace architecture | SPACE_CONTRACT_DOCTRINE · 4 dashboard doctrines · perspective doctrine/blueprint · UNIFIED_SPACE_WIDGET_LAYOUT · SD-4 wave doc · post-SD3 investigation · STATUS rows · 2 root reviews | `doctrine/spaces.md` (= contract doctrine + as-built addendum) |
| Financial semantic authorities | FSA · FI0 §§ · flowtype folder (15) · classification investigations · oracle test prose | `doctrine/financial-semantics.md` |
| Phase-2 truth-spine convergence | PHASE_2_DOCTRINE · FREEZE · ROADMAP_AUDIT · d2 closeouts ×5 · STATUS §3 | `PHASE_2_DOCTRINE` (79 lines — already ideal) |
| Multi-currency rules | MC1 charter · roadmap · investigation · 2 STATUS essay-rows | `doctrine/money-and-fx.md` |
| Initiative status/history | STATUS §3 · STATUS §5 · initiative folders · completion certs · closeouts | Git history + release notes (no prose owner) |
| Production readiness | STATUS §6 · OPS4 checklist · PRELAUNCH_AUDIT · RELEASE_CHECKLIST | one `audits/production-readiness.md` + RELEASE_CHECKLIST |
| Dead-code findings | 2 dead-code audits · repository audit · route audit · 07-16 audit §3/§21 | the 07-16 audit |
| Doc-cleanup recommendations | STATUS §10 · repository audit § · this report | this report |

---

## 17. Proposed future taxonomy

```
README.md                  ← what it is, how to run it (rewritten, truthful)
STATUS.md                  ← ≤150 lines: version · active work · blockers · next · readiness
docs/
├─ doctrine/               ← 6 files (§5): financial-semantics, money-and-fx,
│                             historical-data, spaces, platform-and-security, intelligence
├─ architecture/           ← decision records only: PHASE_2_DOCTRINE, PHASE_2_DECISION_MATRIX,
│                             DEC-0, initiative-naming (alias table), future ADRs
├─ systems/                ← investments, wealth, cash-flow, liquidity, debt, transactions,
│                             spaces, connections/providers, platform-ops, ai   (~10 files, §4)
├─ operations/             ← runbooks (jobs, keys, incident), deployment, security checklist,
│                             release checklist
├─ releases/               ← v2.4.5.md, v2.5.md … (5-field honest format)
├─ plans/                  ← ROADMAP.md, the active initiative plan(s), parked-ideas.md
├─ design/                 ← design language, Atlas doctrine (consolidated), product language, assets
└─ audits/                 ← architecture (07-16) · security · production-readiness
                              (category expires at first production release)
```

~35–50 files total. Explicitly dissolved: `initiatives/`, `investigations/`, `completions/`, `archive/`, `bugfixes/` (closed bugfixes = git history; open ones = defects ledger), `implementation-plans/` (renamed `plans/`, active-only).

---

## 18. Cleanup ledger

P0 = obvious deletion/duplicate · P1 = high-confidence consolidation · P2 = manual review · P3 = keep. (Directory-level where content is homogeneous; unique-value column reflects spot-reads.)

| P | Path | Purpose today | Unique value? | Canonical elsewhere? | Class | Recommendation | Risk |
|---|---|---|---|---|---|---|---|
| P0 | `docs/archive/*` (7 md, 3 png) | v1-era snapshots | No | Git history | STALE | **DELETE** | None |
| P0 | `docs/initiatives/d{5,7,8,10,12}/` (.gitkeep only) | empty scaffolding | No | — | NOISE | **DELETE** | None |
| P0 | `docs/completions/*` + root `*_COMPLETION_*.md` (≈11 files) | completion certificates | No (PO1.0: small extract) | Git history, plans, investigations | COMPLETION_ARTIFACT | **DELETE** (PO1.0: EXTRACT_THEN_DELETE) | None |
| P0 | `docs/initiatives/d2/{closeout,validation}/` (20 files) | step closure/validation records | No | PHASE_2_DOCTRINE | COMPLETION_ARTIFACT | **DELETE** | None |
| P0 | 5 generations of V2.5 status audits + 2 STATUS-drift docs + `V2.5_ROADMAP_ORDERING` (investigations/) | superseded status archaeology | No | STATUS itself | SUPERSEDED | **DELETE** | None |
| P0 | `docs/audits/` dead-code ×2 + route audit | executed cleanups | No | 07-16 audit | HISTORICAL_ONLY | **DELETE** | None |
| P0 | Root `ROADMAP.md` stub, `ROADMAP_ARCHITECTURAL_PRIORITIZATION.md` | redirect + superseded sequencing | No | STATUS §5 → plans/ | STALE | **DELETE** (stub after roadmap lands in plans/) | None |
| P0 | `docs/design/transactions-redesign/` (empty), completed design-system checklists (4) | done work-tracking | No | shipped code | COMPLETION_ARTIFACT | **DELETE** | None |
| P1 | `docs/initiatives/flowtype/`, `mc1/`, `kd15/`, `dec/`, `db1/` | durable rulings inside initiative wrappers | **Yes** | Partially (FSA) | DOCTRINE | **EXTRACT_THEN_DELETE** → doctrine/ + architecture/ (DEC-0 moves verbatim) | Low — extraction list in §4 |
| P1 | `docs/investigations/` RESOLVED_AND_ABSORBED set (~85 files) | shipped-work reasoning | Mostly absorbed | doctrine/systems after §4 | INVESTIGATION_ARTIFACT | **EXTRACT_THEN_DELETE** (extraction needed for ~12 of them, §4 table) | Low-Med |
| P1 | `docs/implementation-plans/` completed 13 | shipped plans | No | code + investigations | COMPLETED | **DELETE** | Low |
| P1 | 4 SPACE_DASHBOARD_*_DOCTRINE + perspective doctrine/blueprint + UNIFIED_LAYOUT (investigations/) | pre-SD design doctrine | Partial | SPACE_CONTRACT_DOCTRINE | SUPERSEDED/OVERLAPPING | **MERGE** surviving rules into doctrine/spaces.md, then delete | Med — needs the as-built addendum first |
| P1 | `docs/initiatives/d2/{investigations,implementation}/` (43) + `d2x/` (25) + `d4/` (8) + remaining tracks | initiative history | Absorbed into D2 architecture docs / doctrine | systems/connections.md after extraction | INVESTIGATION_ARTIFACT | **EXTRACT_THEN_DELETE** | Med |
| P1 | Root security audit pair + prelaunch/architecture audits (07-06/07) | era audits | Security pair: yes (only security audits) | — | see §9 | **MOVE** security pair → docs/audits; others DELETE_AFTER_RELEASE | Low |
| P1 | STATUS.md §§3,5,7,Verification,§§8–11 | history-in-truth-file | §6 table yes; rest no | git, plans/, defects ledger, checklists | DUPLICATE | **MOVE/DELETE** per §14 | Low |
| P1 | `docs/` loose strays (7 investigations, overlay family, roadmap-revision proposal) | misfiled artifacts | KD-7 cap rationale worth one paragraph | doctrine after extraction | INVESTIGATION_ARTIFACT | **EXTRACT_THEN_DELETE** | Low |
| P1 | 07-16 code audit at `docs/initiatives/architecture/` | current architecture audit | Yes | — | AUDIT | **MOVE** → docs/audits/ | None |
| P2 | ACTIVE/UNRESOLVED investigations (~18, §8) | open decision inputs | Yes | — | ACTIVE_PLAN | **KEEP** → plans/ or audits; review each at next planning pass | — |
| P2 | `docs/architecture/` point-in-time records (D2 reviews, DB review, FREEZE, ROADMAP_AUDIT, PORTFOLIO_MASTER_PLAN, V24 planning) | decision-era records | FREEZE/matrix yes; audits partial | Matrix + doctrine | AUDIT/STALE mix | **REVIEW_MANUALLY** — keep Matrix, PHASE_2_DOCTRINE, FREEZE (as ADR); archive/delete the status-bearing rest | Med |
| P2 | `docs/images/` UUID PNG + personal-looking assets | unknown | ? | — | — | **REVIEW_MANUALLY** (possible personal content) | Privacy |
| P2 | `docs/bugfixes/` (3) | closed bug forensics | Plaid orphan-item one has operational value | runbooks | HISTORICAL | **MERGE** the Plaid lessons into BACKGROUND_JOBS_RUNBOOK, delete rest | Low |
| P3 | Canonical doctrine set (§5), operations docs, design language + Atlas doctrines, RELEASE/SECURITY checklists, DEC-0, Decision Matrix, PHASE_2_DOCTRINE, SPACE_CONTRACT_DOCTRINE, FSA, FI0 | durable truth | Yes | — | CANONICAL | **KEEP** (relocate per §17) | — |

---

## 19. Estimated cleanup impact (deliberately conservative)

| Metric | Estimate |
|---|---|
| Markdown files removable (P0+P1 DELETE/EXTRACT_THEN_DELETE) | **~300–340 of 440** |
| Markdown LOC removable | **~55,000–65,000 of 87,741** (63–74%) |
| Files to merge/consolidate | ~25 sources → ~10 targets (doctrine + Atlas + runbook merges) |
| New/promoted canonical docs | ~16 (6 doctrine + ~10 systems) + 3 audits + 2 release notes |
| Initiative artifacts reduction | 208 → ~5 active-plan files |
| Investigation artifacts reduction | 140 (incl. strays) → ~18 active |
| Completion/archive/bugfix reduction | 24 → 0–2 |
| STATUS.md | 212KB → ≤15KB |
| End-state corpus | ~35–50 files, ~15–20k LOC |

---

## 20. What documentation would we create today?

If the current architecture existed from day one, the honest answer is ~20 documents: the six doctrine files; ten system briefs (a page or two each: purpose, authority, contracts, invariants, known gaps); DEC-0 and the Decision Matrix as the first two ADRs; the four operations runbooks + deployment; one roadmap; one honest release note per shipped version; and a README that tells the truth. Everything else in the current corpus is the *process* of arriving at those twenty documents — valuable while it was happening, preserved forever by Git, and not documentation.

---

## 21. Final verdicts

```text
Documentation corpus materially bloated?        YES  (79% is history-shaped; docs > 50% of source LOC)
Old investigations safely removable?            YES  (after the §4 extraction list — ~12 docs feed it)
Completion reports still justified?             NO → PARTIAL (keep only current-cycle certs until v2.5 ships)
Archives still justified?                       NO
Initiative structure still appropriate?         NO  (dissolve into plans/ + doctrine/systems at close)
Doctrine set coherent?                          PARTIAL (canonical core is strong; 9+ doctrine docs misfiled
                                                or superseded; freshness drift on the two biggest)
STATUS.md maintainable?                         NO  (212KB, 88% history, drifts within hours by design)
Major documentation cleanup justified?          YES
Safe to begin high-confidence cleanup immediately?  YES — all P0 rows now; P1 after the §4 extraction
                                                pass; P2 items (architecture point-in-time records,
                                                images privacy check) need the manual review noted.
```

*Read-only audit. This report is the only file created; nothing was modified, moved, deleted, committed, or pushed.*
