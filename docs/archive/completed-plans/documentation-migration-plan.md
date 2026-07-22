# DOC-1 — Documentation Architecture Migration Plan

**Status:** investigation / plan only — **no files moved, created, deleted, or edited**
**Date:** 2026-07-21
**Deliverable:** the migration plan below. Execution is a separate, approved slice.
**Goal:** turn the documentation tree from a *record of the build* into a *description of
the system* — preserve every important decision, remove development clutter.

---

## 0. The core decision this plan asks you to ratify

The current tree splits durable knowledge across **`doctrine/`** (rules) and
**`systems/`** (subsystem refs), with everything temporary piled into **`audits/`**
(69 files). The target structure the brief specifies **collapses `doctrine/` into
`architecture/`** and treats **`audits/` as non-permanent**. That is the right move
— but it is a real decision, so state it plainly:

> **`architecture/` becomes the single home for binding doctrine** (the "why + the
> rules"). **`systems/` becomes subsystem reference** (the "how each part works").
> **`decisions/` holds ADRs** (the "why *this* over the alternatives"). **`audits/`
> stops being a knowledge area** — every file in it is Promoted, Deleted, or
> Archived. **`operations/` holds runbooks + the living readiness doc.**

Three sub-decisions need your explicit sign-off before execution (§8):
1. **Delete `doctrine/` as a folder** (its six files are promoted/renamed into `architecture/` + `systems/`).
2. **Retain `design-system/` untouched** — it holds *current* Atlas design authority that is out of this migration's architecture/systems scope. The brief omits it; deleting it would lose live doctrine. (The nine `design/TIMELINELENS_*` docs are a different story — §5.)
3. **The four ADRs and the six new architecture docs are syntheses, not moves** — they extract and rewrite rationale from existing sources. This is writing work, not `git mv`.

---

## 1. Current inventory

139 markdown files across 13 directories (excluding images/assets), plus root `STATUS.md`.

| Directory | Files | Nature today | Migration verdict |
|---|---:|---|---|
| `doctrine/` | 6 | The crown jewels — binding rules | **Promote all** → `architecture/` + `systems/` (folder retired) |
| `systems/` | 10 | Subsystem references | Mostly keep; 2 merge, 1 reconcile |
| `architecture/` | 14 (+1 in `decisions/`) | Mixed: current doctrine + decision records + landed plans | Split: promote/rename · decisions · archive · delete |
| `operations/` | 8 | Runbooks + checklists | Keep; normalise names |
| `plans/` | 6 | Active roadmap + stale roadmaps | 3 keep · 3 archive |
| `audits/` | 69 | Point-in-time investigations | **13 promote-then-delete · ~40 delete · ~16 archive** |
| `design/` | 11 | 1 reference + 1 done + 9 TimelineLens promotion log | 1 keep · 10 delete |
| `design-system/` | 7 | 4 current Atlas doctrines + 2 proposals + assets | Retain (out of scope); 2 archive |
| `bugfixes/` | 3 | Closed bug writeups | Delete (git preserves; open items → ops) |
| `initiatives/ccpay/` | 2 | 1 decision record + 1 open ledger | 1 → decisions · 1 → plans |
| `initiatives/platops/` | 3 | Completion records + 1 investigation | Delete/archive |
| `releases/` | 3 | Version history | Keep as-is (permanent) |
| root | `STATUS.md` | Current-state authority | Keep at root |

**The imbalance the migration fixes:** 69 audit files vs 6 doctrine files. After
migration, `audits/` is empty (or holds only this plan during execution), and the
durable knowledge sits in ~20 permanent documents a newcomer can read top-to-bottom.

---

## 2. Target structure (proposed final tree)

```
docs/
├── README.md                          (rewritten — the map)
│
├── architecture/                      binding doctrine — "the rules & the why"
│   ├── README.md                      NEW — index + reading order
│   ├── FOURTH_MERIDIAN_DOCTRINE.md    KEEP (reader's guide; links rewritten)
│   ├── SPACE_ARCHITECTURE.md          NEW ← doctrine/spaces + systems/spaces + WORKSPACE_CONTRACT
│   ├── SECURITY_MODEL.md              NEW ← PLATFORM_SECURITY_BOUNDARY + doctrine/platform-and-security + visibility
│   ├── FINANCIAL_TRUTH_SPINE.md       NEW ← doctrine/financial-semantics + PHASE_2_DOCTRINE
│   ├── TIME_MODEL.md                  RENAME ← CANONICAL_TIME_DOCTRINE
│   └── UI_INTERACTION_MODEL.md        NEW ← UX1 interrogability audit + FMD §7 + GLASS_MODAL panels-vs-modals
│
├── systems/                           subsystem reference — "how each part works"
│   ├── transactions.md                KEEP (reconcile: queryTransactions authority + classifier v3)
│   ├── investments.md                 KEEP
│   ├── wealth.md                      KEEP
│   ├── cash-flow.md                   KEEP
│   ├── liquidity.md                   KEEP
│   ├── debt.md                        KEEP
│   ├── connections.md                 KEEP (reconcile: CONN lifecycle + removal doctrine)
│   ├── money-and-fx.md                MOVE ← doctrine/money-and-fx
│   ├── historical-data.md             MOVE ← doctrine/historical-data
│   ├── ai-foundation.md               NEW ← doctrine/intelligence + systems/ai
│   └── platform-operations.md         RENAME ← systems/platform-ops
│
├── operations/                        runbooks + the living readiness doc
│   ├── production-readiness.md        MOVE ← audits/production-readiness
│   ├── incident-response.md           RENAME ← INCIDENT_RESPONSE_RUNBOOK
│   ├── deployment.md                  RENAME ← DEPLOYMENT
│   ├── admin-operations.md            NEW ← admin console + TOTP + privileged-action audit
│   ├── background-jobs.md             RENAME ← BACKGROUND_JOBS_RUNBOOK
│   ├── key-rotation.md                RENAME ← KEY_ROTATION_RUNBOOK
│   ├── database-safety.md             MOVE+RENAME ← architecture/DATABASE_SAFETY_PROTOCOL
│   ├── hydration-rules.md             RENAME ← HYDRATION_RULES
│   ├── security-checklist.md          RENAME ← SECURITY_CHECKLIST
│   ├── release-checklist.md           RENAME ← RELEASE_CHECKLIST
│   └── production-readiness-checklist.md  RENAME ← OPS4_PRODUCTION_READINESS_CHECKLIST
│
├── decisions/                         ADRs — "why this, not the alternative"
│   ├── README.md                      NEW — ADR index + format note
│   ├── ADR-001-space-model.md         NEW (synthesis)
│   ├── ADR-002-financial-authority.md NEW (synthesis)
│   ├── ADR-003-visibility-model.md    NEW (synthesis)
│   ├── ADR-004-time-doctrine.md       NEW (synthesis)
│   ├── ADR-005-numeric-precision.md   RENAME ← architecture/decisions/DEC-0
│   ├── ADR-006-provider-abstraction-timing.md  MOVE ← initiatives/ccpay/CCPAY_2G_PROVIDER_EVOLUTION_REVIEW
│   └── PHASE_2_DECISION_MATRIX.md      MOVE ← architecture/ (the immutable D1–D14 record)
│
├── design-system/                     RETAIN — current Atlas design authority (out of scope)
│   ├── ATLAS_GLASS_MATERIAL_DOCTRINE.md      keep
│   ├── ATLAS_GLASS_MODAL_DOCTRINE.md         keep (feeds UI_INTERACTION_MODEL)
│   ├── ATLAS_LIQUID_PLATFORM_DOCTRINE.md     keep
│   ├── ATLAS_MATERIAL_CLASSIFICATION_REPORT.md keep
│   └── (product-language.md moves here from design/; 2 proposals → archive)
│
├── plans/                             active-only
│   ├── ROADMAP.md · parked-ideas.md · ai-5-advisor-intelligence.md   keep
│   └── ccpay-follow-ups.md            MOVE ← initiatives/ccpay/CCPAY_FOLLOW_UPS
│
├── releases/                          v2.0.1 · v2.4.5 · v2.5   keep (permanent)
│
├── images/                            keep
│
└── archive/
    └── completed-plans/               NEW — preserved decision context only (§4)
```

**Net:** `doctrine/`, `design/`, `bugfixes/`, `initiatives/`, and `audits/` (as a
permanent home) disappear. `architecture/` holds ~7 docs a newcomer reads first;
`decisions/` holds the ADRs + the immutable matrix; `archive/completed-plans/`
holds only documents with irreversible-decision or rejected-alternative context.

---

## 3. The mapping — every file, by destination

Legend: **KEEP** (stays, maybe reconciled) · **RENAME** (content unchanged, Title-Case/descriptive name) · **MOVE** (folder change) · **PROMOTE** (durable knowledge extracted into a permanent doc, then source removed) · **ARCHIVE** (→ `archive/completed-plans/`, decision context) · **DELETE** (served its purpose; git preserves).

### 3.1 → `architecture/` (binding doctrine)

| Source | Action | Destination |
|---|---|---|
| `architecture/FOURTH_MERIDIAN_DOCTRINE.md` | KEEP (rewrite internal links post-rename) | `architecture/FOURTH_MERIDIAN_DOCTRINE.md` |
| `doctrine/spaces.md` + `systems/spaces.md` + `architecture/WORKSPACE_CONTRACT_DOCTRINE.md` (§1–3,6–8) | PROMOTE/merge | `architecture/SPACE_ARCHITECTURE.md` |
| `architecture/PLATFORM_SECURITY_BOUNDARY.md` (primary, accurate 3-axis) + `doctrine/platform-and-security.md` + `financial-semantics.md §10` (visibility) | PROMOTE/merge | `architecture/SECURITY_MODEL.md` |
| `doctrine/financial-semantics.md` + `architecture/PHASE_2_DOCTRINE.md` | PROMOTE/merge | `architecture/FINANCIAL_TRUTH_SPINE.md` |
| `architecture/CANONICAL_TIME_DOCTRINE.md` | RENAME | `architecture/TIME_MODEL.md` |
| `audits/UX1_INTERROGABILITY_AUDIT.md` + `FOURTH_MERIDIAN_DOCTRINE §7` + `design-system/ATLAS_GLASS_MODAL_DOCTRINE §7` | PROMOTE | `architecture/UI_INTERACTION_MODEL.md` |
| — | CREATE | `architecture/README.md` |

*Note:* `WORKSPACE_CONTRACT_DOCTRINE.md`'s durable contract (six-question workspace
contract, SD-9 runtime §6, Experience Layer §7) folds into `SPACE_ARCHITECTURE.md`;
its §4/§5 gap tables are a stale 2026-07-18 snapshot and are **dropped** (git
preserves). If you prefer it to survive intact, keep it as
`architecture/WORKSPACE_CONTRACT.md` instead of merging — flag in §8.

### 3.2 → `systems/`

| Source | Action | Destination |
|---|---|---|
| `systems/{transactions,investments,wealth,cash-flow,liquidity,debt}.md` | KEEP | same (transactions reconciled) |
| `systems/connections.md` | KEEP + reconcile (fold in the removal doctrine + CONN lifecycle) | `systems/connections.md` |
| `systems/platform-ops.md` | RENAME | `systems/platform-operations.md` |
| `doctrine/money-and-fx.md` | MOVE | `systems/money-and-fx.md` |
| `doctrine/historical-data.md` | MOVE | `systems/historical-data.md` |
| `doctrine/intelligence.md` + `systems/ai.md` | PROMOTE/merge | `systems/ai-foundation.md` |

### 3.3 → `operations/`

| Source | Action | Destination |
|---|---|---|
| `audits/production-readiness.md` | MOVE | `operations/production-readiness.md` |
| `operations/INCIDENT_RESPONSE_RUNBOOK.md` | RENAME | `operations/incident-response.md` |
| `operations/DEPLOYMENT.md` | RENAME | `operations/deployment.md` |
| `operations/BACKGROUND_JOBS_RUNBOOK.md` | RENAME | `operations/background-jobs.md` |
| `operations/KEY_ROTATION_RUNBOOK.md` | RENAME | `operations/key-rotation.md` |
| `operations/{SECURITY,RELEASE}_CHECKLIST.md` | RENAME | `operations/{security,release}-checklist.md` |
| `operations/OPS4_PRODUCTION_READINESS_CHECKLIST.md` | RENAME (drop OPS4) | `operations/production-readiness-checklist.md` |
| `operations/HYDRATION_RULES.md` | RENAME | `operations/hydration-rules.md` |
| `architecture/DATABASE_SAFETY_PROTOCOL.md` | MOVE+RENAME | `operations/database-safety.md` |
| — | CREATE | `operations/admin-operations.md` (admin console, TOTP enrolment model, privileged-action audit) |

### 3.4 → `decisions/` (ADRs)

| Source | Action | Destination |
|---|---|---|
| `architecture/PHASE_2_DECISION_MATRIX.md` | MOVE (immutable D1–D14 record) | `decisions/PHASE_2_DECISION_MATRIX.md` |
| `architecture/decisions/DEC-0.md` | RENAME | `decisions/ADR-005-numeric-precision.md` |
| `initiatives/ccpay/CCPAY_2G_PROVIDER_EVOLUTION_REVIEW.md` | MOVE/rename (still-cited decision: abstract from the 2nd provider) | `decisions/ADR-006-provider-abstraction-timing.md` |
| synthesis (from SPACE_ARCHITECTURE + D-decisions) | CREATE | `decisions/ADR-001-space-model.md` |
| synthesis (from FINANCIAL_TRUTH_SPINE) | CREATE | `decisions/ADR-002-financial-authority.md` |
| synthesis (from SECURITY_MODEL §visibility) | CREATE | `decisions/ADR-003-visibility-model.md` |
| synthesis (from TIME_MODEL) | CREATE | `decisions/ADR-004-time-doctrine.md` |
| — | CREATE | `decisions/README.md` |

### 3.5 → `archive/completed-plans/` (preserve decision context only)

Rejected alternatives · security reviews · major-migration rationale · irreversible design context:

| Source | Why preserved |
|---|---|
| `architecture/PHASE_2_ARCHITECTURE_FREEZE.md` | The frozen Phase-2 baseline + decision context; self-flagged immutable |
| `architecture/{UI_CONVERGENCE_ROADMAP,UI_CONVERGENCE_WAVE_2,AI_EXPERIENCE_CONVERGENCE}.md` | Forward migration plans not yet built — rationale for the remaining waves |
| `audits/EXEC1_EXECUTIVE_ARCHITECTURE_REVIEW_2026-07-17.md` | Principal-engineer launch-risk review; open findings = decision context |
| `audits/security-audit-2026-07-07.md` · `audits/secops-architecture-review-2026-07-07.md` | Security reviews — preserve per "security reviews" rule |
| `audits/PO5_BETA_READINESS_AUDIT.md` | Detailed beta-readiness rationale behind production-readiness |
| `audits/V25_ARCHITECTURE_CLOSURE_INVESTIGATION.md` | The "v2.5 complete" decision record |
| `design-system/ATLAS_MATERIAL_ENGINE_UNIFICATION_PROPOSAL.md` · `ATLAS_MATERIAL_LIBRARY_INVESTIGATION.md` | Rejected/parked design proposals |
| `architecture/initiative-naming.md` | Historical alias table — meaningful once sprint names are gone; provenance |

*(`connection-lifecycle-roadmap.md` and `platform-ops-roadmap.md`: fold the durable
model into `systems/connections.md` / `systems/platform-operations.md`, then archive
the roadmap shell. `prov-provider-orchestration-refactor.md`: deferred PROV-5B/6
notes → `parked-ideas.md`, then archive.)*

### 3.6 DELETE — served their purpose (git preserves history)

These contain only implementation progress / "what changed" / test counts / commit
summaries / temporary findings already incorporated. **Delete after confirming the
durable knowledge (if any) is captured in a permanent doc — never before.**

- **V25-CLOSE implementation records:** `V25_CLOSE_1_LEDGER_RECONCILIATION`, `V25_CLOSE_2_GUARD_HARDENING`, `V25_CLOSE_3_HONESTY_POLISH`, `V25_CLOSE_3A_REPORTING_CURRENCY_FAILURE_CONTRACT`, `V25_CLOSE_4_TEMPLATE_TRUTHFULNESS` *(its doctrine already promoted to FMD §8)*, `V25_FINAL_DOCUMENTATION_AUDIT` *(superseded by this plan)*.
- **TX arc:** `TX1_TRANSACTION_READ_AUTHORITY_AUDIT`, `TX2_TRANSACTION_BOUNDARY_HARDENING`, `TX2_POST_IMPLEMENTATION_REVIEW`, `TX2A_TRANSACTION_COMPLETENESS_AWARENESS`, `TX3_TRANSACTION_EXPLORER_AUDIT`, `TX3_QUERY_CONTRACT_IMPLEMENTATION`, `TX3_QUERY_CONTRACT_REVIEW`, `TX3_1B_CONTRACT_HARDENING`, `TX3_5_EXPLORER_PARITY_MATRIX`, `TX4_TRANSACTION_ANALYTICS_CLEANUP`, `TRANSACTIONS_WORKSPACE_CONVERGENCE_ROADMAP` *(durable read-path knowledge → `systems/transactions.md` reconcile first)*.
- **CONN/PROV impl:** `CONN1_…`, `CONN2_FINANCIAL_RECONSTRUCTION`, `CONN2_PROVIDER_NEUTRALITY`, `CONN2_RECONSTRUCTION_IMPLEMENTATION`, `CONN3_FRESHNESS_PIPELINE`, `CONN4A_DISCONNECT_IMPLEMENTATION`, `RECONSTRUCTION_EXPERIENCE_AUDIT`, `PROV1_…` *(durable → `systems/connections.md`)*. **`CONN4_CONNECTION_REMOVAL_DOCTRINE_AUDIT` is PROMOTE, not delete** — its Disconnect-vs-Delete doctrine → `systems/connections.md`, then remove.
- **Investments/historical/time impl:** `A10_HISTORICAL_VALUATION_COVERAGE`, `A10_LONG_RANGE_RETURN_INTEGRITY`, `HIST2_…`, `INVESTMENTS_GAIN_DISCONNECT`, `INVEST1_…`, `TIME1_PRESET_ANCHOR_SEMANTICS` *(→ `TIME_MODEL.md`)*, `TIME1A_PRESET_ANCHOR_UX_IMPLEMENTATION`, `TIMELINELENS_V4_MIGRATION_MATRIX`, `TIMELENS_LEGACY_DELETION_READINESS`.
- **Platform/beta impl:** `PLATFORM_HQ_EXPERIENCE_CONVERGENCE`, `PLATFORM_HQ_READ_SURFACE_PO3A`, `PLATFORM_HQ_OPERATING_MODEL_AUDIT`, `PLATFORM_OPERATIONS_CONVERGENCE_AUDIT`, `PO3B_…`, `PO3C_…`, `PO4_…`, `PO4A_…`, `PO5A_…`, `OPS5_WAVE_C_…`, plus `initiatives/platops/OPS5_WAVE_A_…`, `OPS5_WAVE_B_…`, `PLATOPS_OBSERVABILITY_INVESTIGATION` *(open ops gaps already in production-readiness)*.
- **Workspace redesign / UI impl:** `CASH_FLOW_WORKSPACE_CONVERGENCE`, `LIQUIDITY_WORKSPACE_REDESIGN`, `NW_VISUALIZATION_MODES_AUDIT` *(decision shipped; the "historical per-entity composition is impossible" fact → `historical-data.md`)*, `MOBILE_EXPERIENCE_AUDIT`, `SPACE_DASHBOARD_DECOMPOSITION_AUDIT_2026-07-18`, `SPACE_DASHBOARD_REMAINING_OWNERSHIP_AUDIT`, `SEC_SPACESECTIONS_DECOMPOSITION_…`, `EXPERIENCE_CONVERGENCE_BRIEF_SPACES`, `LANDING_PAGE_CONVERGENCE`, `DS0_GLOBAL_SPACE_UI_UX_INVENTORY_…`.
- **Dated one-off investigation logs:** `architecture-audit-2026-07-16`, `staff-architecture-review-2026-07-16` *(partially retracted)*, `review-self-audit-2026-07-16`, `COMPLEX0_…`, `TEST0_…`, `status-drift-audit-2026-07-17`, `documentation-cleanup-audit-2026-07-16`.
- **Landed architecture plans:** `architecture/SD9_WORKSPACE_RUNTIME_CONVERGENCE.md`, `architecture/UI_CONVERGENCE_WAVE_1.md`.
- **Design promotion log (10):** `design/ATLAS_PRIMITIVE_HARDENING.md` + the nine `design/TIMELINE*` / `TIMELINELENS_*` docs — one staged-promotion log for a component shipped as v4; `TIME_MODEL.md` is the doctrine. *(If you want exactly one historical record, keep `TIMELINE_PERSPECTIVE_MIGRATION_COMPLETE.md`; otherwise delete all ten.)*
- **Bugfixes (3):** `BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS` *(describes retired architecture)*, `BUGFIX_PLAID_REFRESH_ORPHANED_PLAID_ITEMS`, `BUGFIX_PLAID_PREVIEW_LINK_TOKEN_AND_REFRESH_FAILURES` — delete; the one open deploy-config item (`PLAID_REDIRECT_URI` Preview) → `production-readiness.md`.
- **Empty scaffold:** `initiatives/ev1/` directory — remove.

### 3.7 KEEP where they are (permanent, no move needed)
`releases/{v2.0.1,v2.4.5,v2.5}.md`; `plans/{ROADMAP,parked-ideas,ai-5-advisor-intelligence}.md`; `design-system/` Atlas doctrines + assets; `images/`; root `STATUS.md`. `design/product-language.md` → **MOVE → `design-system/product-language.md`** (design language belongs together).

---

## 4. Promote / Delete / Archive — the decision rules applied

- **Promote (13 audits + 6 doctrine + 2 architecture time/security docs):** anything answering *why the architecture is this way* — the financial authority, the visibility model, the time doctrine, the Space model, the interrogation language, the connection-removal doctrine, the provider-abstraction-timing decision. Each is extracted/rewritten into a permanent `architecture/`, `systems/`, or `decisions/` document, and only then is the source removed.
- **Delete (~40 audits + 10 design + 3 bugfix + 3 platops):** implementation progress, "what changed," test counts, commit summaries, temporary findings already folded in. Git history is the record of *how it was built*; the working tree keeps only *what it is*. These are **not** archived — archiving clutter defeats the purpose.
- **Archive (~16):** only documents with **irreversible-decision or rejected-alternative context** — security reviews, the Phase-2 freeze, the not-yet-built forward plans, the parked design proposals, the closure decision, the alias history. These go to `archive/completed-plans/` with a one-line banner.

**The invariant:** *preserve every important decision; remove every development
artifact.* A file is deleted only when its durable content is either (a) nil, or (b)
already living in a permanent doc — never on convenience.

---

## 5. Missing permanent documents (to create)

Ten documents the mature structure needs that do not exist today. Each is a
**synthesis** of named sources — writing, not moving:

| New document | Extracts / requires |
|---|---|
| `architecture/README.md` | Index + reading order for the architecture folder |
| `architecture/SPACE_ARCHITECTURE.md` | **What a Space is** (universal container primitive; not a DB authority, not an authz layer, not a command centre) · ownership/membership/templates · **internal vs customer Spaces** · **Perspectives** (definition, Workspace relationship, temporal behavior) · **Shell hierarchy** (SpaceShell → PerspectiveShell → Workspace) · **Dashboard composition responsibilities** (orchestration root; not a controller, no domain math) |
| `architecture/SECURITY_MODEL.md` | **The three trust axes** — Customer (`SpaceMember` · `VisibilityLevel` · account access) · Operator (`PlatformGrant` · internal operational Spaces) · Emergency (`SYSTEM_ADMIN` · break-glass · mandatory TOTP). *Source of record: the accurate `PLATFORM_SECURITY_BOUNDARY.md`; supersede the "two planes" framing in `doctrine/platform-and-security.md`.* |
| `architecture/FINANCIAL_TRUTH_SPINE.md` | **One authoritative model · one semantic layer · one aggregation path · many consumers** — the canonical funnel, the 14 authorities, transaction/investment/FX/historical authorities, projection consumers, sanctioned exceptions |
| `architecture/TIME_MODEL.md` | asOf-as-anchor, presets as window-lengths, the TimelineLens→adapter→reducer intent chain |
| `architecture/UI_INTERACTION_MODEL.md` | **Preview → Browser → Detail** · **charts are interrogable** (a segment ≡ a ledger row) · **panels over modals** for detail workflows · **selections must invalidate correctly** (capability, not constant; historical drill-downs don't exist) |
| `systems/ai-foundation.md` | Deterministic-knowledge-vs-AI-narration doctrine + the chat/context/provider-seam implementation |
| `systems/money-and-fx.md` · `systems/historical-data.md` | Moved from `doctrine/` verbatim (then reconciled if needed) |
| `operations/admin-operations.md` | Admin console responsibilities, TOTP enrolment model, privileged-action audit requirements |
| `decisions/{ADR-001…004}.md` + `decisions/README.md` | The four ADRs (space-model · financial-authority · visibility-model · time-doctrine) — each: context, decision, **rejected alternatives**, consequences |

**Content already verified for these** (from the V25-FINAL audit): the three-axis
security model, the visibility predicate, the financial funnel, the time chain, and
the interrogation language are all confirmed against code — the syntheses are
assembly, not new investigation.

---

## 6. Documents that are RENAME-only (content unchanged)

No knowledge change — just Title-Case/descriptive names, dropping sprint/version
artifacts: `CANONICAL_TIME_DOCTRINE → TIME_MODEL`; `systems/platform-ops →
platform-operations`; the eight `operations/*_RUNBOOK`/`*_CHECKLIST` files →
lower-case descriptive; `DEC-0 → ADR-005-numeric-precision`;
`OPS4_PRODUCTION_READINESS_CHECKLIST → production-readiness-checklist`. Names to
eliminate everywhere: `UX-CLOSE`, `V25-CLOSE`, `TX-3`, `PO-*`, `OPS-5`,
`POST_IMPLEMENTATION_REVIEW`, trailing `AUDIT`, `_2026-07-17` date stamps.

---

## 7. Documents SAFE TO REMOVE ENTIRELY

The highest-confidence deletions (zero durable content, or fully superseded by a
named successor; git retains them): `status-drift-audit-2026-07-17`,
`TX2_POST_IMPLEMENTATION_REVIEW` (→ TX-2A), `TX3_QUERY_CONTRACT_REVIEW` (→ TX-3.1b),
`documentation-cleanup-audit-2026-07-16` (its recs became the current layout),
`V25_FINAL_DOCUMENTATION_AUDIT` (→ this plan), `architecture-audit-2026-07-16`,
`review-self-audit-2026-07-16`, `COMPLEX0_…`, `TEST0_…`, all `V25_CLOSE_*`
implementation records, and the full `TX*`/`PO*`/`CONN[123]`/`A10`/`HIST2` impl set
in §3.6. The nine `TIMELINELENS_*`/`TIMELINE_*` design docs and
`ATLAS_PRIMITIVE_HARDENING` are safe to remove once `TIME_MODEL.md` exists.

---

## 8. Risks & confirmations needed before execution

1. **Retire `doctrine/`?** (§0.1) — yes, its six files promote into `architecture/`+`systems/`. Confirm the folder disappears.
2. **`money-and-fx` / `historical-data` under `systems/` not `architecture/`?** They are doctrine-grade rules; the brief places money-and-fx under `systems/`. Recommend following the brief (subsystem refs), with `FINANCIAL_TRUTH_SPINE.md` owning the *cross-cutting* rule and these owning the *mechanism*. Confirm.
3. **`WORKSPACE_CONTRACT_DOCTRINE`: merge into `SPACE_ARCHITECTURE` or keep standalone?** (§3.1 note). It is substantial and current; merging risks a very large doc. Recommend merge with the stale §4/§5 dropped; confirm.
4. **`design-system/` retained untouched?** (§0.2) — it is current design authority the brief omits. Recommend retain. Confirm we are not expected to fold Atlas doctrines into `architecture/`.
5. **ADRs are new writing.** The four ADRs + six architecture docs are ~10 authored documents. This is the bulk of the execution effort — it is not a `git mv` job. Budget accordingly.
6. **Link integrity.** `FOURTH_MERIDIAN_DOCTRINE.md`, `STATUS.md`, `docs/README.md`, and every cross-doc reference point at old paths. Execution must rewrite all internal links (a mechanical sweep) or the tree breaks on day one.
7. **Promotion-before-deletion ordering is load-bearing.** No source is deleted until its durable knowledge is confirmed present in the permanent doc. The execution slice runs **promote → verify → delete**, never the reverse.

---

## 9. Recommended execution sequencing (for the follow-up slice)

1. **Scaffold:** create `decisions/` and `archive/completed-plans/`; add the three `README.md` files.
2. **Rename-only moves** (§6) — zero-risk, do first; fix links as you go.
3. **Promote doctrine → architecture/systems** (§3.1–3.2): author the six new architecture docs + `ai-foundation` + move money-and-fx/historical-data; **reconcile the three drift items** (SECURITY_MODEL to three axes, transactions to queryTransactions+v3, connections to the lifecycle+removal doctrine).
4. **Author the ADRs** (§5) from the now-settled architecture docs.
5. **Archive** the decision-context set (§3.5).
6. **Verify then delete** the §3.6 set — for each, confirm its knowledge lives in a permanent doc (or is nil), then remove.
7. **Rewrite `docs/README.md`** to the new map and re-point `STATUS.md`'s documentation table.
8. **Guard:** a link-check pass (no dangling relative links) + a scan that no permanent doc name contains a sprint/version artifact.

---

## 10. No-change confirmation

This is a **plan only**. No file under `docs/` was moved, renamed, created (other than
this plan), deleted, or edited. No code, test, schema, or config was touched. Every
Promote/Delete/Archive/Rename above is a **recommendation for an approved execution
slice**, sequenced in §9, gated on the confirmations in §8. Decision history is
preserved: nothing with rejected-alternative, security-review, or
irreversible-design context is deleted — only development artifacts already captured
in git or in a permanent doc.

**Outcome when executed:** a newcomer opens `docs/architecture/` and reads seven
documents — the doctrine, the Space model, the security model, the financial truth
spine, the time model, the UI interaction model — and understands *what Fourth
Meridian is and why it looks this way*, without reading a single sprint report.
