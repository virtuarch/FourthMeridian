# V25-FINAL — Documentation & Doctrine Audit

**Status:** investigation complete — no code changed; two documentation deliverables produced
**Date:** 2026-07-20
**Scope:** the entire `docs/` corpus + `STATUS.md`, audited against the architecture that actually exists at v2.5 completion.
**Purpose:** before declaring *"v2.5 Architecture Complete,"* verify the documentation matches reality — hierarchy, doctrine coverage, obsolete cleanup, missing decisions, and the security / Space / permissions models.

---

## 0. Outcome in one paragraph

The documentation is **in good shape and already well-hierarchised** — `docs/README.md` defines a real lifecycle (Investigation → Decision → Knowledge → Deletion), and `doctrine/` + `systems/` already hold current authority for the financial, money/FX, historical, Spaces, security, and intelligence models. The v2.5 gaps were **three doctrines that lived only in audits** (the interrogation interaction language, template truthfulness, and the v2.5→v2.6 boundary) and **the absence of a single reader's-guide** answering "what is this and why." Both are now closed by the new [`architecture/FOURTH_MERIDIAN_DOCTRINE.md`](../../architecture/FOURTH_MERIDIAN_DOCTRINE.md). The remaining work is **cleanup, not construction**: 55 of 68 point-in-time audits are obsolete (their conclusions shipped into doctrine/systems), and three doctrine/systems files carry verified drift that should be reconciled. This audit lists every action; it executes none of them.

**Two deliverables produced (documentation only, not code):**
1. [`docs/architecture/FOURTH_MERIDIAN_DOCTRINE.md`](../../architecture/FOURTH_MERIDIAN_DOCTRINE.md) — the consolidating reader's guide (answers the five founder questions; points to canon; carries the three previously-missing doctrines).
2. **This audit** — inventory, obsolete set, gaps, and cleanup recommendations.

---

## 1. Documentation hierarchy — verified sound

The lifecycle in `docs/README.md` is real and mostly obeyed. Truth lives in the narrowest place that can own it, and `STATUS.md` correctly self-declares as the sole current-state authority ("if this file conflicts with the code, fix this file"). The layering:

- **Code** → ultimate truth · **STATUS.md** → current state · **doctrine/** → binding rules · **systems/** → subsystem authority + contracts · **architecture/** → immutable decisions · **plans/audits/operations/releases** → active roadmap · point-in-time · runbooks · per-version.

No structural change to the hierarchy is warranted. The one addition — a top-level entry point tying it together — is the new `FOURTH_MERIDIAN_DOCTRINE.md`.

---

## 2. Documentation inventory & classification

### 2.1 `docs/doctrine/` — 6 files, all CURRENT AUTHORITY

| File | Covers | Verdict |
|---|---|---|
| `financial-semantics.md` | The 14 financial authorities, the canonical funnel, visibility tiers §10, CCPAY rules | **Current authority** — the master financial doctrine |
| `money-and-fx.md` | Native/reporting/display currency, read-time conversion, 5 FX invariants | **Current authority** |
| `historical-data.md` | Observed/derived/estimated provenance, snapshot immutability, A9/A10 | **Current authority** |
| `spaces.md` | SpaceShell/Workspace/Shared ownership, the universal Space/Workspace/Perspective model §15, the 5 Perspective laws §16 | **Current authority** |
| `platform-and-security.md` | The authorization planes, route guards, security boundaries, beta gate | **Current authority — but carries drift (§5.1)** |
| `intelligence.md` | Deterministic-knowledge-vs-AI-narration, the North-Star principles, "one authority per claim" | **Current authority** |

### 2.2 `docs/systems/` — 10 files, OPERATIONAL/current except two

All current and code-cited except:
- **`transactions.md` — STALE.** Predates TX-1→TX-4; still presents `getTransactions`/`getDebtTransactions` as the only canonical readers with no mention of the keyset `queryTransactions()` authority (`lib/data/transaction-query.ts`), and states `FLOW_CLASSIFIER_VERSION` "currently 2" though CCPAY landed **v3**. STATUS links it as the TX reference. **Recommend: reconcile (§5.2).**
- **`connections.md` — mildly stale.** Predates CONN-1→CONN-4A; the connection-lifecycle/disconnect layer isn't reflected. Core spine content accurate. **Recommend: append the lifecycle layer (§5.2).**

### 2.3 `docs/architecture/` — decision records + doctrine, two landed-plan closures

| File | Verdict |
|---|---|
| `PLATFORM_SECURITY_BOUNDARY.md` | **Current authority** — the accurate three-axis security statement (verified against code, §4.3); the doc to trust for authorization |
| `CANONICAL_TIME_DOCTRINE.md` | **Current authority** — matches shipped TimelineLens v4; supersedes older inline SD-0B time notes |
| `WORKSPACE_CONTRACT_DOCTRINE.md` | **Current authority** for the workspace runtime contract (§1–3, §6–8). Caveat: §4 Known-Gaps / §5 roadmap are a 2026-07-18 snapshot — re-verify before treating as open |
| `PHASE_2_DOCTRINE.md` | **Current authority / decision hybrid** — the ratified truth-spine contract; points to financial-semantics for the full map |
| `PHASE_2_DECISION_MATRIX.md` | **Decision record (immutable)** — the sole authority for D1–D14 definitions; keep as-is |
| `PHASE_2_ARCHITECTURE_FREEZE.md` | **Decision record (frozen, point-in-time)** — self-flagged; must not be read as current state; keep for provenance |
| `initiative-naming.md` · `decisions/DEC-0.md` | **Reference / decision record** — keep (DEC-0's DEC-1+ plan is a v2.6+ concern) |
| `SD9_WORKSPACE_RUNTIME_CONVERGENCE.md` | **Superseded — landed.** WORKSPACE_CONTRACT §6 marks SD-9 shipped; the hooks it proposed exist. Closed-plan → archive |
| `UI_CONVERGENCE_WAVE_1.md` | **Superseded — landed.** Connections/Settings utility workspaces shipped (`lib/{connections,settings}/workspaces.ts` + guards). Closed-plan → archive |
| `UI_CONVERGENCE_ROADMAP.md` · `UI_CONVERGENCE_WAVE_2.md` · `AI_EXPERIENCE_CONVERGENCE.md` | **Roadmaps, partially outdated** — Wave 1 landed; Wave 2 / AI reshell not yet built. Keep but re-scope; correct the "nothing implemented" framing |

### 2.4 `docs/audits/` — 68 files: 13 keep, 55 obsolete

Full classification below (§3). Keep set (13): `production-readiness.md`, `EXEC1_…`, `PO5_…`, `security-audit-2026-07-07`, the six `V25_*` records, `NW_VISUALIZATION_MODES_AUDIT`, `UX1_INTERROGABILITY_AUDIT`, and `CONN4_CONNECTION_REMOVAL_DOCTRINE_AUDIT` (a decision record).

### 2.5 plans / design / design-system / releases / bugfixes / initiatives

- **plans/ (6):** `ROADMAP.md`, `parked-ideas.md`, `ai-5-advisor-intelligence.md`, `connection-lifecycle-roadmap.md` active. `platform-ops-roadmap.md` **stale** (PO-1→5 shipped → mark-superseded to `systems/platform-ops.md`). `prov-provider-orchestration-refactor.md` **mostly stale** (PROV-2→5A landed; trim to the deferred PROV-5B/6 notes).
- **design/ (11):** `product-language.md` keep (reference). The **9 TimelineLens/Timeline-control docs are one staged-promotion log for a shipped v4 component** → collapse to at most one record (keep `TIMELINE_PERSPECTIVE_MIGRATION_COMPLETE.md` if any); `ATLAS_PRIMITIVE_HARDENING.md` done → archive.
- **design-system/ (7):** the four Atlas doctrines (`GLASS_MATERIAL`, `GLASS_MODAL`, `LIQUID_PLATFORM`, `MATERIAL_CLASSIFICATION`) are **current authority**; the two proposals (`MATERIAL_ENGINE_UNIFICATION_PROPOSAL`, `MATERIAL_LIBRARY_INVESTIGATION`) are stale/non-authoritative → mark-superseded/park. The v1 HTML + assets are reference.
- **releases/ (3):** all permanent history — keep (`v2.5.md` is the active note).
- **bugfixes/ (3):** `ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS` references retired architecture → archive after verifying fix status; the two Plaid ones → mark-superseded / keep-until-config-closed.
- **initiatives/:** `ccpay/CCPAY_2G_…` decision record and `ccpay/CCPAY_FOLLOW_UPS.md` (**FU-1 btc-sync flow-authority still open**) → keep; `platops/OPS5_WAVE_{A,B}` complete → archive; `platops/PLATOPS_OBSERVABILITY_INVESTIGATION` thin/still-relevant (gaps now in production-readiness); `ev1/` **empty dir → remove**.

---

## 3. The obsolete set — precise cleanup recommendations

**Nothing here is executed.** Actions follow `docs/README.md`: **delete** (git retains) for transient records fully rolled into a named successor; **archive** for implementation/verification records with no unique durable rationale; **mark-superseded** (leave in tree with a banner pointing to the authority) for audits whose *rationale* is durable and now lives in doctrine/systems. Decision history is preserved throughout.

### 3.1 Delete (3) — transient, fully consumed, named successor exists
- `audits/status-drift-audit-2026-07-17.md` → consumed by `V25_CLOSE_1`
- `audits/TX2_POST_IMPLEMENTATION_REVIEW.md` → consumed by TX-2A
- `audits/TX3_QUERY_CONTRACT_REVIEW.md` → consumed by TX-3.1b

### 3.2 Archive — high-confidence (10 dated one-off investigation logs)
`architecture-audit-2026-07-16`, `staff-architecture-review-2026-07-16` *(partially retracted)*, `review-self-audit-2026-07-16`, `COMPLEX0_…`, `INVEST1_…`, `DS0_…`, `TEST0_…`, `secops-architecture-review-2026-07-07`, `documentation-cleanup-audit-2026-07-16` *(its own recommendations became today's doctrine/systems layout)*, `SEC_SPACESECTIONS_DECOMPOSITION_…`.

### 3.3 Archive — implementation/verification records for shipped slices (~22)
The CONN-2/4A implementation audits, TX-2/2A/3.0/3.1b/3.5/4 records, TIME-1A migration/validation, TimelineLens v4 migration matrix + legacy-deletion readiness, PO-3A/3B/3C/4A/5A records, `PLATFORM_HQ_EXPERIENCE_CONVERGENCE`, `EXPERIENCE_CONVERGENCE_BRIEF_SPACES`, `LANDING_PAGE_CONVERGENCE`, `MOBILE_EXPERIENCE_AUDIT`, `SPACE_DASHBOARD_DECOMPOSITION_*` + `_REMAINING_OWNERSHIP`, `INVESTMENTS_GAIN_DISCONNECT`, `OPS5_WAVE_C_…`, plus `platops/OPS5_WAVE_{A,B}`, `design/ATLAS_PRIMITIVE_HARDENING`, and the TimelineLens design-doc log.

### 3.4 Mark-superseded — durable rationale now in doctrine/systems (~20)
`CONN1_…`, `CONN2_FINANCIAL_RECONSTRUCTION`, `CONN3_…`, `PROV1_…` → `systems/connections.md`; `A10_HISTORICAL_VALUATION_COVERAGE`, `A10_LONG_RANGE_RETURN_INTEGRITY`, `HIST2_…` → `doctrine/historical-data.md`; `TX1_…`, `TX3_TRANSACTION_EXPLORER` → `systems/transactions.md`; `TIME1_PRESET_ANCHOR_SEMANTICS` → `CANONICAL_TIME_DOCTRINE.md`; `CASH_FLOW_WORKSPACE_CONVERGENCE`, `LIQUIDITY_WORKSPACE_REDESIGN` → the respective systems doc; `PLATFORM_OPERATIONS_CONVERGENCE`, `PLATFORM_HQ_OPERATING_MODEL`, `PO4_…` → `systems/platform-ops.md`; plans `platform-ops-roadmap.md`, `prov-provider-orchestration-refactor.md`; design-system `MATERIAL_ENGINE_UNIFICATION_PROPOSAL`.

### 3.5 Do NOT touch — still-relevant / current (the keep set)
`production-readiness.md`, `EXEC1`, `PO5`, `security-audit-2026-07-07`, the six `V25_*`, `NW_VISUALIZATION_MODES_AUDIT`, `UX1_INTERROGABILITY_AUDIT`, `CONN4` (decision record); all release notes; the four Atlas doctrines; `product-language.md`; `ROADMAP.md`; `parked-ideas.md`; the active plans; `CCPAY_2G` + `CCPAY_FOLLOW_UPS`; every `doctrine/` file and (with the §5 reconciliations) the `systems/` files.

*Recommended sequencing:* do §3.1 (delete) + §3.2 (archive) first (highest confidence, zero risk), then the §5 doctrine reconciliations, then §3.3/§3.4 in a batch with the mark-superseded banners. This is a follow-up cleanup slice, explicitly **out of scope for this investigation**.

---

## 4. Doctrine coverage — verified against code

### 4.1 What was already canonical (no gap)
- **Financial authority doctrine** ("one model · one semantic layer · one aggregation path · many consumers") — `doctrine/financial-semantics.md` (the canonical funnel + 14 authorities + AI consumers §9 + sanctioned exceptions §12, incl. the **btc-sync second-classifier** and transitional-compat paths) reinforced by `intelligence.md` and `PHASE_2_DOCTRINE.md`. **Complete.**
- **Space / Perspective / Shell architecture** — `doctrine/spaces.md` (§15 universal model, §16 laws) + `systems/spaces.md` + `WORKSPACE_CONTRACT_DOCTRINE.md`. **Complete** (one minor gap: `PerspectiveShell` is named only in the architecture docs, not doctrine — acceptable).
- **Permissions/security** — `PLATFORM_SECURITY_BOUNDARY.md` (authorization axes) + `financial-semantics.md §10` (visibility tiers). **Complete and code-accurate** (§4.3).

### 4.2 The gaps — concepts in code lacking a canonical doc (now closed)
| Concept | Prior home | Now |
|---|---|---|
| **Preview → Browser → Detail interaction model + chart interrogability** | audits only (`UX1_INTERROGABILITY_AUDIT`, `NW_VISUALIZATION_MODES_AUDIT`) + WORKSPACE_CONTRACT §7 | **`FOURTH_MERIDIAN_DOCTRINE.md §7`** (canonical) |
| **Template doctrine** (entry points/presets, live vs coming-soon, Family+Custom) | audits only (`V25_CLOSE_4_TEMPLATE_TRUTHFULNESS`) + D9 (proposed) | **`FOURTH_MERIDIAN_DOCTRINE.md §8`** (canonical) |
| **v2.5 → v2.6 boundary** | scattered in `STATUS`/`ROADMAP` | **`FOURTH_MERIDIAN_DOCTRINE.md §9`** (canonical) |
| **Top-level "what is this / where is truth / who can do what / how does it fit / why"** | none | **`FOURTH_MERIDIAN_DOCTRINE.md §1–5, §10`** |

### 4.3 Security model — code-verified (three axes, not two)
The running code implements **three independent authorization axes** — the "two planes" framing is the older mental model:
1. **Customer tenancy** — `SpaceMember` + `requireSpaceRole`; `SpaceMemberRole ∈ {OWNER, ADMIN, MEMBER, VIEWER}` (ranked); per-account `VisibilityLevel ∈ {FULL, BALANCE_ONLY, SUMMARY_ONLY, PRIVATE, legacy SHARED}` gated by the sole predicate `TRANSACTION_DETAIL_VISIBILITY = [FULL]` (`lib/ai/visibility.ts`, read via `grantsTransactionDetail`/`grantsAccountDetail`). `WorkspaceAccountShare` **retired** in v2.5; `SpaceAccountLink` is the sole link path.
2. **Operator** — `PlatformGrant` (area × level) + `requirePlatformAccess`; orthogonal to `SpaceMember` by construction (mints no membership row). The four HQ Spaces are **real, seeded, built system-singletons** (`Space.platformArea @unique`) with **zero `SpaceMember` rows**, at `/dashboard/platform/[area]`, gated by grants alone.
3. **Emergency** — `UserRole ∈ {USER, SYSTEM_ADMIN}` (no `ADMIN` role); `requireSystemAdmin`/`requireFreshSystemAdmin`; gates `/admin/*`, mints grants, and holds an **unconditional break-glass bypass** over the operator plane (`decidePlatformAccess`). Mandatory admin TOTP (an un-enrolled admin's session is rejected by every guard); `DISABLE_SYSTEM_ADMIN` kill switch; append-only `AuditLog` with `performedByAdminId`.

`proxy.ts` (Next.js 16 — **not** `middleware.ts`) is only the *edge* session/redirect chokepoint; API authorization lives in `lib/session.ts`.

---

## 5. Doc-vs-code drift — recommended reconciliations (not executed)

These are **recommendations**; this investigation edits none of them (a follow-up slice, respecting "preserve decision history"). `FOURTH_MERIDIAN_DOCTRINE.md §3` already carries the corrected three-axis statement and points to `PLATFORM_SECURITY_BOUNDARY.md` as canonical, so no reader is misled in the interim.

**5.1 `doctrine/platform-and-security.md` — reconcile to three axes (priority: high).** It frames authorization as **two planes** and demotes `SYSTEM_ADMIN` to "a distinct account role," whereas the code (and `PLATFORM_SECURITY_BOUNDARY.md`) has **three axes** with SYSTEM_ADMIN as a first-class emergency axis holding an unconditional bypass. Two verified inaccuracies: (a) line ~12 says internal-ops Spaces "remain **parked** rather than built" — **false**, they are seeded, routed, and live; (b) line ~23 states platform write routes "write an `AuditLog` row" as current behavior — the gate (`requireFreshPlatformAccess`) exists but **no operator WRITE action has shipped** (PO-1). Recommend: align cardinality to three axes, delete "parked," and mark the write path as *provisioned, not yet exercised*.

**5.2 `systems/transactions.md` (high) and `systems/connections.md` (medium).** transactions.md: add the keyset `queryTransactions()` authority (`lib/data/transaction-query.ts`) alongside `getTransactions`/`getDebtTransactions`, and correct `FLOW_CLASSIFIER_VERSION` to **v3**. connections.md: append the CONN-1→CONN-4A lifecycle/disconnect layer (or link `plans/connection-lifecycle-roadmap.md`).

**5.3 `WORKSPACE_CONTRACT_DOCTRINE.md §4/§5, UI_CONVERGENCE_* framing (low).** The §4 Known-Gaps and §5 roadmap are a 2026-07-18 snapshot; some items (Wave-1 utility workspaces) have landed. Re-verify against current code; the contract portions (§1–3, §6–8) are current. Correct the "nothing implemented" headers on the UI_CONVERGENCE roadmaps.

None of these is an *architectural* problem — every one is documentation lagging shipped work, exactly the drift this audit exists to surface before closure.

---

## 6. Verdict on "v2.5 Architecture Complete"

**Documentation supports the declaration**, with the reservations above being *cleanup*, not *blockers*:

- The architecture that exists **is** documented — the financial-semantic layer, money/FX, historical model, Spaces/Shell/Workspaces/Perspectives, the three-axis security model, and intelligence doctrine all have current-authority homes.
- The previously **undocumented** v2.5 concepts (interrogation language, template truthfulness, v2.6 boundary) now have a canonical home.
- The remaining actions are a documentation-hygiene follow-up (obsolete-audit cleanup §3 + three doc reconciliations §5) and the **release** gate (config + ops) tracked in `production-readiness.md` — neither is an architectural gap.

A new engineer or founder can now open [`FOURTH_MERIDIAN_DOCTRINE.md`](../../architecture/FOURTH_MERIDIAN_DOCTRINE.md) and answer: what Fourth Meridian is, where truth lives, who may do what, how Spaces/Perspectives/Workspaces/dashboards/permissions fit, and why the architecture looks this way — each with a path to the canonical detail.

---

## 7. No-code-change confirmation

This was a **documentation-only** investigation. No source file, test, schema, or configuration was modified. Two files were **created**, both under `docs/`:

- `docs/architecture/FOURTH_MERIDIAN_DOCTRINE.md`
- `docs/audits/V25_FINAL_DOCUMENTATION_AUDIT.md` (this file)

No obsolete doc was deleted, archived, or edited — every cleanup action in §3 and every reconciliation in §5 is a **recommendation for a follow-up slice**, deliberately not executed, preserving decision history. Verified: `git status` shows only the two new `docs/` files among this task's changes; no tracked code file is modified by this work.
