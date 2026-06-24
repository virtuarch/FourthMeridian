# D0 — Documentation Information Architecture Review

**Status: investigation only. No files moved, renamed, or created (other than this report). No folders created. No links edited.**

Branch: `feature/phase-2-architecture`. Scope: `/docs` only — no application code, schema, or other root-level docs (`README.md`, `ROADMAP.md`, `fourth-meridian-product-language.md`) are touched, though three of them are flagged below as dependents.

---

## A. Current Inventory

`/docs` contains **50 filesystem entries**: **47 real files** and **3 `.DS_Store` junk files** (`docs/.DS_Store`, `docs/design-system/.DS_Store`, `docs/images/.DS_Store` — macOS metadata, not documentation; recommend deleting, see §F).

### A.1 Root of `/docs` (flat, 27 files)

| File | Lines | Last modified |
|---|---|---|
| `BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md` | 104 | Jun 22 |
| `D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md` | 220 | Jun 22 |
| `D2_CONNECTION_ARCHITECTURE_REVIEW.md` | 331 | Jun 22 |
| `D2_PROVIDER_CONNECTION_ARCHITECTURE.md` | 362 | Jun 23 |
| `D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` | 167 | Jun 24 |
| `D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md` | 146 | Jun 23 |
| `D2_STEP2A_PLAID_DUAL_WRITE_IMPLEMENTATION.md` | 64 | Jun 24 |
| `D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` | 138 | Jun 24 |
| `D3_LEGACY_RETIREMENT_AUDIT.md` | 97 | Jun 23 |
| `D3_SPACE_ACCOUNT_LINK_REVIEW.md` | 154 | Jun 22 |
| `D3_STABILIZATION_MANUAL_HOME_RACE_REPORT.md` | 85 | Jun 23 |
| `D3_STEP2_BACKFILL_REVIEW.md` | 257 | Jun 22 |
| `D3_STEP3_DUAL_WRITE_REVIEW.md` | 383 | Jun 23 |
| `D3_STEP3_HOME_SEMANTICS_CORRECTION.md` | 159 | Jun 23 |
| `D3_STEP4C_CORE_DASHBOARD_REVIEW.md` | 154 | Jun 23 |
| `D3_STEP4C_IMPLEMENTATION_REPORT.md` | 94 | Jun 23 |
| `D3_STEP4C_REGRESSION_ROOT_CAUSE.md` | 128 | Jun 23 |
| `D3_STEP4D_IMPLEMENTATION_REPORT.md` | 95 | Jun 23 |
| `D3_STEP4E_IMPLEMENTATION_REPORT.md` | 73 | Jun 23 |
| `D3_STEP4_READ_CUTOVER_REVIEW.md` | 79 | Jun 23 |
| `DATABASE_ARCHITECTURE_REVIEW.md` | 759 | Jun 22 |
| `DEPLOYMENT.md` | 214 | Jun 22 |
| `HYDRATION_RULES.md` | 167 | Jun 22 |
| `PHASE_2_ARCHITECTURE_FREEZE.md` | 484 | Jun 22 |
| `PHASE_2_DECISION_MATRIX.md` | 361 | Jun 22 |
| `PROJECT_STATE.md` | 265 | Jun 22 |
| `WORKSPACE_TO_SPACE_RENAME_PLAN.md` | 308 | Jun 22 |

### A.2 `docs/archive/` (8 files — already segregated)

`Daily Brief Dashboard Mock Up.png`, `Oval World Image Revamp.png`, `Oval World Image.png`, `PLAN_ORIGINAL.md`, `QA_PASS_2_REPORT.md`, `WIDGET_META_ANALYSIS.md`, `WORKSPACE_STATUS.md`, `WORKSPACE_TYPE_SPEC.md`.

### A.3 `docs/design-system/` (3 files)

`Fourth-Meridian-Design-Language-v1.html`, `assets/fm-mark-dark.png`, `assets/fm-mark-light.png`.

### A.4 `docs/images/` (8 files)

`081A593F-D45E-4F9E-B439-CD5D89D3C328.png`, `ai-advice.png`, `dashboard.png`, `mobile-dashboard.png`, `workspaces.png`, and `architecture/architecture-map.svg`, `architecture/data-flow-lifecycle.svg`, `architecture/provider-adapter-layer.svg`.

### A.5 `docs/releases/` (1 file)

`v2.0.1.md`.

### Category groupings (by content, read from each file's title/status line)

| Category | Count | Files |
|---|---|---|
| Phase 2 architecture canon | 6 | `DATABASE_ARCHITECTURE_REVIEW.md`, `D2_CONNECTION_ARCHITECTURE_REVIEW.md`, `D2_PROVIDER_CONNECTION_ARCHITECTURE.md`, `PHASE_2_ARCHITECTURE_FREEZE.md`, `PHASE_2_DECISION_MATRIX.md`, `WORKSPACE_TO_SPACE_RENAME_PLAN.md` |
| D1 initiative | 1 | `D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md` |
| D2 initiative (step-level) | 4 | `D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md`, `D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md`, `D2_STEP2A_PLAID_DUAL_WRITE_IMPLEMENTATION.md`, `D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` |
| D3 initiative (step-level) | 12 | all `D3_*` files |
| Operations | 3 | `DEPLOYMENT.md`, `HYDRATION_RULES.md`, `PROJECT_STATE.md` |
| Bugfix | 1 | `BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md` |
| Archive (already placed) | 8 | see A.2 |
| Design system (already placed) | 3 | see A.3 |
| Images (already placed) | 8 | see A.4 |
| Releases (already placed) | 1 | see A.5 |
| Junk | 3 | `.DS_Store` ×3 |
| **Total** | **50** | |

---

## B. Classification Table

| File | Target category | Confidence | Basis |
|---|---|---|---|
| `BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md` | `bugfixes/` | High | Title is literally "Bugfix investigation"; tracks a concrete blocker, not a Phase 2 step |
| `D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md` | `initiatives/d1/` | High | Self-titled D1, design-review status |
| `D2_CONNECTION_ARCHITECTURE_REVIEW.md` | `architecture/` | High | Named explicitly in your target tree; superseded-in-part by the doc below, kept as architecture canon, not a step log |
| `D2_PROVIDER_CONNECTION_ARCHITECTURE.md` | `architecture/` | High | Named explicitly in your target tree; current D2 architecture canon |
| `D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` | `initiatives/d2/investigations/` | High | "Status: read-only investigation" |
| `D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md` | `initiatives/d2/investigations/` | High | "Status: read-only investigation" |
| `D2_STEP2A_PLAID_DUAL_WRITE_IMPLEMENTATION.md` | `initiatives/d2/implementations/` | High | "Status: implemented per approved scope" |
| `D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` | `initiatives/d2/investigations/` | High | "Status: read-only investigation" |
| `D3_LEGACY_RETIREMENT_AUDIT.md` | `initiatives/d3/verification/` | Medium | Post-implementation audit confirming D3 cutover completeness, not pre-work research |
| `D3_SPACE_ACCOUNT_LINK_REVIEW.md` | `initiatives/d3/investigations/` | High | The D3 "Step 1" investigation; other D3 docs cite it as such |
| `D3_STABILIZATION_MANUAL_HOME_RACE_REPORT.md` | `initiatives/d3/implementations/` | High | "Implementation + Validation Report" |
| `D3_STEP2_BACKFILL_REVIEW.md` | `initiatives/d3/investigations/` | High | "Status: design only" |
| `D3_STEP3_DUAL_WRITE_REVIEW.md` | `initiatives/d3/investigations/` | High | "Status: design only" |
| `D3_STEP3_HOME_SEMANTICS_CORRECTION.md` | `initiatives/d3/investigations/` | High | "Read-only research" |
| `D3_STEP4C_CORE_DASHBOARD_REVIEW.md` | `initiatives/d3/investigations/` | High | "Read-only research" |
| `D3_STEP4C_IMPLEMENTATION_REPORT.md` | `initiatives/d3/implementations/` | High | "Implemented, validated" |
| `D3_STEP4C_REGRESSION_ROOT_CAUSE.md` | `initiatives/d3/verification/` | Medium | Post-implementation regression diagnosis, not pre-work research |
| `D3_STEP4D_IMPLEMENTATION_REPORT.md` | `initiatives/d3/implementations/` | High | "Implemented, validated" |
| `D3_STEP4E_IMPLEMENTATION_REPORT.md` | `initiatives/d3/implementations/` | High | "Implemented, validated" |
| `D3_STEP4_READ_CUTOVER_REVIEW.md` | `initiatives/d3/investigations/` | High | "Read-only research" |
| `DATABASE_ARCHITECTURE_REVIEW.md` | `architecture/` | High | Named explicitly in your target tree |
| `DEPLOYMENT.md` | `operations/` | High | Named explicitly in your target tree |
| `HYDRATION_RULES.md` | `operations/` | High | Named explicitly in your target tree |
| `PHASE_2_ARCHITECTURE_FREEZE.md` | `architecture/` | High | Named explicitly in your target tree |
| `PHASE_2_DECISION_MATRIX.md` | `architecture/` | High | Named explicitly in your target tree |
| `PROJECT_STATE.md` | `operations/` | High | Named explicitly in your target tree |
| `WORKSPACE_TO_SPACE_RENAME_PLAN.md` | `architecture/` | High | Named explicitly in your target tree (historical-context-only per project rules, but still architecture-canon location) |
| `archive/*` (8 files) | `archive/` (no move) | High | Already correctly placed; `WORKSPACE_TO_SPACE_RENAME_PLAN.md` itself instructs these stay as dated, unedited point-in-time records |
| `design-system/*` (3 files) | `design-system/` (no move) | High | Already correctly placed |
| `images/*` (8 files) | `images/` (no move) | High | Already correctly placed |
| `releases/v2.0.1.md` | `releases/` (no move) | High | Already correctly placed |
| `.DS_Store` ×3 | delete, not classified | High | Not documentation |

The two "Medium" confidence rows are judgment calls — see §E.1 footnote for the reasoning and an alternative if you'd rather keep audits with investigations.

---

## C. Dependency Risks

Two distinct risk types exist. They get conflated easily, so they're separated below.

### C.1 Real link breaks (rendering/navigation actually breaks)

Only **one file** contains true relative markdown links into another part of `/docs`:

| Source | Link text | Current relative path | Breaks on move? | Fix needed |
|---|---|---|---|---|
| `DATABASE_ARCHITECTURE_REVIEW.md` (moving to `architecture/`) | "Architecture Map" | `images/architecture/architecture-map.svg` | **Yes** | → `../images/architecture/architecture-map.svg` |
| `DATABASE_ARCHITECTURE_REVIEW.md` | "Data Flow Lifecycle" | `images/architecture/data-flow-lifecycle.svg` | **Yes** | → `../images/architecture/data-flow-lifecycle.svg` |
| `DATABASE_ARCHITECTURE_REVIEW.md` | "Provider Adapter Layer" | `images/architecture/provider-adapter-layer.svg` | **Yes** | → `../images/architecture/provider-adapter-layer.svg` |

These three are the only links in the entire `/docs` tree that resolve relative to a file's own location (every other cross-doc reference, see C.2, is plain inline-code text, not a clickable link). All three are in one file, all three need the same one-level `../` prefix added because the file is gaining one level of nesting (`docs/` → `docs/architecture/`) while the target image is not moving.

`DEPLOYMENT.md` has 3 markdown links but they're all external URLs (`supabase.com`, `vercel.com`, `dashboard.plaid.com`) — no risk.

No other `.md` file in `/docs`, including everything in `archive/`, contains a relative markdown link.

### C.2 Stale text references (won't break, will become inaccurate)

Every other "see `docs/X.md`" mention in this codebase is plain inline-code text, not a hyperlink — moving the file doesn't break anything functionally, but the path string becomes wrong. This is a large surface:

**Inside `/docs` itself** — files reference each other by hardcoded path in prose (e.g. `D3_STEP2_BACKFILL_REVIEW.md` cites `docs/D3_SPACE_ACCOUNT_LINK_REVIEW.md`; `PHASE_2_DECISION_MATRIX.md` cites `docs/PHASE_2_ARCHITECTURE_FREEZE.md`; `D3_LEGACY_RETIREMENT_AUDIT.md` alone names 18 other doc files inline). Reference counts per file (number of *other* tracked files that mention its filename):

| File | Referenced by N other files |
|---|---|
| `D3_STEP4_READ_CUTOVER_REVIEW.md` | 8 |
| `BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md` | 8 |
| `D3_STEP3_HOME_SEMANTICS_CORRECTION.md` | 7 |
| `PHASE_2_ARCHITECTURE_FREEZE.md` | 6 |
| `DATABASE_ARCHITECTURE_REVIEW.md` | 5 |
| `PHASE_2_DECISION_MATRIX.md` | 5 |
| `D3_STEP2_BACKFILL_REVIEW.md` | 4 |
| `D3_STEP3_DUAL_WRITE_REVIEW.md` | 4 |
| `D3_STEP4C_CORE_DASHBOARD_REVIEW.md` | 4 |
| `D3_STEP4C_REGRESSION_ROOT_CAUSE.md` | 4 |
| `D2_CONNECTION_ARCHITECTURE_REVIEW.md` | 3 |
| `D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` | 3 |
| `D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` | 3 |
| `D3_LEGACY_RETIREMENT_AUDIT.md` | 3 |
| `D3_SPACE_ACCOUNT_LINK_REVIEW.md` | 3 |
| `PROJECT_STATE.md` | 3 |
| `D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md`, `D2_PROVIDER_CONNECTION_ARCHITECTURE.md`, `D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md` | 2 each |
| `D3_STEP4C_IMPLEMENTATION_REPORT.md`, `D3_STEP4D_IMPLEMENTATION_REPORT.md`, `D3_STEP4E_IMPLEMENTATION_REPORT.md`, `DEPLOYMENT.md`, `WORKSPACE_TO_SPACE_RENAME_PLAN.md` | 1 each |
| `HYDRATION_RULES.md`, `D2_STEP2A_PLAID_DUAL_WRITE_IMPLEMENTATION.md`, `D3_STABILIZATION_MANUAL_HOME_RACE_REPORT.md` | 0 |

**Outside `/docs`, application code comments** reference doc paths — these are developer breadcrumbs ("see docs/X.md for the design"), not executed code, so moving the doc doesn't break the build, but the comment becomes wrong:

| Doc referenced | Referencing code files |
|---|---|
| `BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md` | `app/api/spaces/[id]/accounts/share/route.ts` (×2), `app/api/spaces/[id]/members/[userId]/route.ts`, `app/api/accounts/manual/route.ts`, `app/api/accounts/manual/[id]/restore/route.ts`, `app/api/accounts/wallet/route.ts` (×2), `app/api/accounts/[id]/route.ts`, `app/api/accounts/[id]/restore/route.ts` |
| `D3_STEP4_READ_CUTOVER_REVIEW.md` | `app/api/spaces/[id]/accounts/route.ts`, `app/api/accounts/manual/archived/route.ts`, `app/api/accounts/[id]/transactions/route.ts`, `app/api/brief/route.ts`, `lib/snapshots/regenerate.ts` |
| `D3_STEP3_DUAL_WRITE_REVIEW.md` | `app/api/accounts/manual/[id]/restore/route.ts`, `app/api/accounts/[id]/restore/route.ts`, `lib/accounts/space-account-link.ts` |
| `D3_STEP3_HOME_SEMANTICS_CORRECTION.md` | `app/api/plaid/exchange-token/route.ts`, `app/api/accounts/wallet/route.ts`, `lib/accounts/space-account-link.ts` (×3), `lib/data/accounts.ts` |
| `D3_LEGACY_RETIREMENT_AUDIT.md` | `app/(shell)/dashboard/settings/archived-assets/page.tsx`, `app/api/accounts/manual/route.ts` |
| `D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` | `app/api/plaid/exchange-token/route.ts`, `lib/accounts/provider-identity.ts` |
| `D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` | `lib/accounts/provider-identity.ts` |
| `D3_STEP4C_CORE_DASHBOARD_REVIEW.md` | `lib/data/accounts.ts`, `lib/data/transactions.ts` |
| `D3_STEP2_BACKFILL_REVIEW.md` | `scripts/backfill-space-account-link.ts`, `scripts/verify-space-account-link-backfill.ts` |
| `D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md` | `scripts/backfill-provider-account-identity.ts`, `scripts/verify-provider-account-identity-backfill.ts` |
| `D2_PROVIDER_CONNECTION_ARCHITECTURE.md` | `scripts/backfill-provider-account-identity.ts` |

**Outside `/docs`, other root-level markdown:**

| File | What it references |
|---|---|
| `ROADMAP.md:141` | `` `docs/PROJECT_STATE.md` `` — moving to `operations/` |
| `fourth-meridian-product-language.md:64,154` | `` `docs/DATABASE_ARCHITECTURE_REVIEW.md` `` (×2) — moving to `architecture/` |
| `components/atlas/GlassPanel.tsx:10` | `` docs/design-system/Fourth-Meridian-Design-Language-v1.html `` — **not moving**, no risk |

None of these are functional breakage — they're comments and prose, not imports or hyperlinks — but every one becomes a stale path the moment its target moves. Recommend a follow-up pass (separate from this investigation) that updates these strings to the new paths once the move actually happens; not in scope for D0 itself.

### C.3 Pre-existing dangling reference (unrelated to this move — flagging so it isn't conflated with move-caused breakage)

`lib/plaid/syncTransactions.ts:46` references `docs/TRANSACTION_DUPLICATION_INVESTIGATION.md`. **This file does not exist** anywhere in the working tree or git history. It's already broken today, independent of any reorganization. Worth a separate ticket; not something this move plan creates or fixes.

### C.4 Assets confirmed *not* at risk

`docs/design-system/assets/fm-mark-dark.png` / `fm-mark-light.png` are referenced only by `docs/design-system/Fourth-Meridian-Design-Language-v1.html` (same folder, not moving). The live app's logo components (`components/ui/AppLogo.tsx`, `components/brief/BriefLogo.tsx`) load `/fm-mark-dark.png` / `/fm-mark-light.png` from `public/` — a separate, unrelated pair of files. No app-code dependency on anything under `docs/`.

### C.5 Git-tracking note (operational, not a blocker)

`docs/archive/` is gitignored (`.gitignore` lines for `Daily Brief Dashboard Mock Up.png`, `Oval World Image*.png`, `QA_PASS_*.md`, `WIDGET_META_ANALYSIS.md`, `WORKSPACE_STATUS.md`, `WORKSPACE_TYPE_SPEC.md`, and `docs/archive/` itself) — everything in it is untracked except `PLAN_ORIGINAL.md`, which is tracked as an exception. This doesn't affect the move plan below (archive/ isn't moving), but matters for whoever executes future moves: tracked files need `git mv` to preserve history; everything else in archive/ is a plain filesystem `mv`.

---

## D. Proposed Folder Hierarchy

Using your target structure as given, populated with what actually exists today (folders shown only where ≥1 file lands in them; `initiatives/d4`–`d12` are stubs for future work, not created by this investigation):

```
docs/
├── architecture/
│   ├── DATABASE_ARCHITECTURE_REVIEW.md
│   ├── D2_CONNECTION_ARCHITECTURE_REVIEW.md
│   ├── D2_PROVIDER_CONNECTION_ARCHITECTURE.md
│   ├── PHASE_2_ARCHITECTURE_FREEZE.md
│   ├── PHASE_2_DECISION_MATRIX.md
│   └── WORKSPACE_TO_SPACE_RENAME_PLAN.md
├── initiatives/
│   ├── d1/
│   │   └── D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md
│   ├── d2/
│   │   ├── investigations/
│   │   │   ├── D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md
│   │   │   ├── D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md
│   │   │   └── D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md
│   │   └── implementations/
│   │       └── D2_STEP2A_PLAID_DUAL_WRITE_IMPLEMENTATION.md
│   ├── d3/
│   │   ├── investigations/
│   │   │   ├── D3_SPACE_ACCOUNT_LINK_REVIEW.md
│   │   │   ├── D3_STEP2_BACKFILL_REVIEW.md
│   │   │   ├── D3_STEP3_DUAL_WRITE_REVIEW.md
│   │   │   ├── D3_STEP3_HOME_SEMANTICS_CORRECTION.md
│   │   │   ├── D3_STEP4C_CORE_DASHBOARD_REVIEW.md
│   │   │   └── D3_STEP4_READ_CUTOVER_REVIEW.md
│   │   ├── implementations/
│   │   │   ├── D3_STABILIZATION_MANUAL_HOME_RACE_REPORT.md
│   │   │   ├── D3_STEP4C_IMPLEMENTATION_REPORT.md
│   │   │   ├── D3_STEP4D_IMPLEMENTATION_REPORT.md
│   │   │   └── D3_STEP4E_IMPLEMENTATION_REPORT.md
│   │   └── verification/
│   │       ├── D3_LEGACY_RETIREMENT_AUDIT.md
│   │       └── D3_STEP4C_REGRESSION_ROOT_CAUSE.md
│   ├── d4/ … d12/        (empty stubs, not created yet)
├── operations/
│   ├── DEPLOYMENT.md
│   ├── PROJECT_STATE.md
│   └── HYDRATION_RULES.md
├── design-system/         (unchanged)
│   ├── Fourth-Meridian-Design-Language-v1.html
│   └── assets/
├── releases/               (unchanged)
│   └── v2.0.1.md
├── bugfixes/
│   └── BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md
├── images/                 (unchanged)
│   ├── architecture/
│   └── *.png
└── archive/                 (unchanged)
    └── *.md, *.png
```

D2 gets `investigations/` + `implementations/` only (no `verification/` yet — no D2 doc is a post-implementation audit today; add the subfolder when one shows up). D3 gets the full four-part split your example offered, minus `reports/`, which D3's actual docs don't need as a separate bucket — every "report" is either an implementation-bundled validation (→ `implementations/`) or a standalone post-hoc audit (→ `verification/`). D1 stays flat — one file doesn't justify subfolders yet.

---

## E. Exact Move Plan

27 files move. 20 stay in place (already correctly located). 3 `.DS_Store` files are recommended for deletion (not a "move").

### E.1 Files that move

| # | Source | Destination |
|---|---|---|
| 1 | `docs/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md` | `docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md` |
| 2 | `docs/D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md` | `docs/initiatives/d1/D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md` |
| 3 | `docs/D2_CONNECTION_ARCHITECTURE_REVIEW.md` | `docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md` |
| 4 | `docs/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` | `docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` |
| 5 | `docs/D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` | `docs/initiatives/d2/investigations/D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` |
| 6 | `docs/D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md` | `docs/initiatives/d2/investigations/D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md` |
| 7 | `docs/D2_STEP2A_PLAID_DUAL_WRITE_IMPLEMENTATION.md` | `docs/initiatives/d2/implementations/D2_STEP2A_PLAID_DUAL_WRITE_IMPLEMENTATION.md` |
| 8 | `docs/D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` | `docs/initiatives/d2/investigations/D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` |
| 9 | `docs/D3_LEGACY_RETIREMENT_AUDIT.md` | `docs/initiatives/d3/verification/D3_LEGACY_RETIREMENT_AUDIT.md` |
| 10 | `docs/D3_SPACE_ACCOUNT_LINK_REVIEW.md` | `docs/initiatives/d3/investigations/D3_SPACE_ACCOUNT_LINK_REVIEW.md` |
| 11 | `docs/D3_STABILIZATION_MANUAL_HOME_RACE_REPORT.md` | `docs/initiatives/d3/implementations/D3_STABILIZATION_MANUAL_HOME_RACE_REPORT.md` |
| 12 | `docs/D3_STEP2_BACKFILL_REVIEW.md` | `docs/initiatives/d3/investigations/D3_STEP2_BACKFILL_REVIEW.md` |
| 13 | `docs/D3_STEP3_DUAL_WRITE_REVIEW.md` | `docs/initiatives/d3/investigations/D3_STEP3_DUAL_WRITE_REVIEW.md` |
| 14 | `docs/D3_STEP3_HOME_SEMANTICS_CORRECTION.md` | `docs/initiatives/d3/investigations/D3_STEP3_HOME_SEMANTICS_CORRECTION.md` |
| 15 | `docs/D3_STEP4C_CORE_DASHBOARD_REVIEW.md` | `docs/initiatives/d3/investigations/D3_STEP4C_CORE_DASHBOARD_REVIEW.md` |
| 16 | `docs/D3_STEP4C_IMPLEMENTATION_REPORT.md` | `docs/initiatives/d3/implementations/D3_STEP4C_IMPLEMENTATION_REPORT.md` |
| 17 | `docs/D3_STEP4C_REGRESSION_ROOT_CAUSE.md` | `docs/initiatives/d3/verification/D3_STEP4C_REGRESSION_ROOT_CAUSE.md` |
| 18 | `docs/D3_STEP4D_IMPLEMENTATION_REPORT.md` | `docs/initiatives/d3/implementations/D3_STEP4D_IMPLEMENTATION_REPORT.md` |
| 19 | `docs/D3_STEP4E_IMPLEMENTATION_REPORT.md` | `docs/initiatives/d3/implementations/D3_STEP4E_IMPLEMENTATION_REPORT.md` |
| 20 | `docs/D3_STEP4_READ_CUTOVER_REVIEW.md` | `docs/initiatives/d3/investigations/D3_STEP4_READ_CUTOVER_REVIEW.md` |
| 21 | `docs/DATABASE_ARCHITECTURE_REVIEW.md` | `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` |
| 22 | `docs/DEPLOYMENT.md` | `docs/operations/DEPLOYMENT.md` |
| 23 | `docs/HYDRATION_RULES.md` | `docs/operations/HYDRATION_RULES.md` |
| 24 | `docs/PHASE_2_ARCHITECTURE_FREEZE.md` | `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` |
| 25 | `docs/PHASE_2_DECISION_MATRIX.md` | `docs/architecture/PHASE_2_DECISION_MATRIX.md` |
| 26 | `docs/PROJECT_STATE.md` | `docs/operations/PROJECT_STATE.md` |
| 27 | `docs/WORKSPACE_TO_SPACE_RENAME_PLAN.md` | `docs/architecture/WORKSPACE_TO_SPACE_RENAME_PLAN.md` |

No filename changes anywhere in this plan — only directory changes. (If you later want the `D2_`/`D3_` prefixes dropped since the folder already encodes the initiative, that's a separate, optional rename pass — flag it as a follow-up rather than bundling renames with moves, since a combined move+rename is harder to verify and harder to `git mv` cleanly in one step.)

**Footnote on the two Medium-confidence rows (#9, #17):** if you'd rather keep "audit"/"root-cause" docs grouped with the investigation phase instead of carving out a separate `verification/` bucket, both `D3_LEGACY_RETIREMENT_AUDIT.md` and `D3_STEP4C_REGRESSION_ROOT_CAUSE.md` would move to `docs/initiatives/d3/investigations/` instead, and `verification/` would not be created for D3 at all. Either is defensible; this report defaults to the four-way split since you explicitly offered it as the example structure.

### E.2 Files that do NOT move (already correctly placed)

| Source | Why no move |
|---|---|
| `docs/archive/*` (8 files) | Already in `archive/`, matches target exactly |
| `docs/design-system/*` (3 files) | Already in `design-system/`, matches target exactly |
| `docs/images/*` (8 files, including the 3 under `images/architecture/`) | Already in `images/`, matches target exactly |
| `docs/releases/v2.0.1.md` | Already in `releases/`, matches target exactly |

### E.3 Recommended deletions (separate from the move — confirm before doing)

| File | Why |
|---|---|
| `docs/.DS_Store` | macOS metadata, not documentation |
| `docs/design-system/.DS_Store` | macOS metadata, not documentation |
| `docs/images/.DS_Store` | macOS metadata, not documentation |

### E.4 Link/text fixes required after the move (separate change, listed for completeness — not performed here)

1. `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` — update its 3 image links to `../images/architecture/*.svg` (currently `images/architecture/*.svg`).
2. The ~50 stale textual path references catalogued in §C.2 (inside `/docs`, in `app/`/`lib`/`scripts/` comments, and in `ROADMAP.md`/`fourth-meridian-product-language.md`) — recommend a single follow-up find/replace pass once the move ships, not bundled with the move itself.

---

## F. Documentation Governance Rules (recommended, for D4–D12 and beyond)

1. **Every initiative gets `docs/initiatives/dN/`.** Created at the same time the initiative's first investigation doc is written — not retroactively.
2. **Initiatives default to flat; add `investigations/` / `implementations/` / `verification/` only once a second doc of a different type lands.** A one-doc initiative (like D1 today) doesn't need subfolders; forcing structure on a single file adds navigation overhead with no payoff.
3. **`verification/` is for post-implementation audits, regression root-causes, and retirement audits — not for pre-work design review.** Pre-work goes in `investigations/`, even if its filename says "review."
4. **Architecture canon (`docs/architecture/`) is for current accepted state, not step logs.** A doc moves from an initiative folder to `architecture/` only when it stops being "investigation in progress" and starts being "this is how the system works now" — the same bar `D2_PROVIDER_CONNECTION_ARCHITECTURE.md` and `D2_CONNECTION_ARCHITECTURE_REVIEW.md` already clear today.
5. **Operational runbooks (`docs/operations/`) never carry an initiative prefix.** `DEPLOYMENT.md`, `PROJECT_STATE.md`, `HYDRATION_RULES.md` and anything like them stay initiative-agnostic by name and location.
6. **Bugfixes get `docs/bugfixes/`, named `BUGFIX_<short-description>.md`** — never mixed into an initiative folder, even if the bug was discovered during that initiative's work (cross-reference it from the initiative doc instead).
7. **Releases get `docs/releases/v<semver>.md`** — one file per tagged release, never edited after the tag ships.
8. **Archived docs are point-in-time and frozen.** Once a doc moves to `docs/archive/`, it is never edited to reflect later renames or decisions (this rule is already explicitly stated in `WORKSPACE_TO_SPACE_RENAME_PLAN.md` for the existing archive set — formalize it repo-wide).
9. **Cross-doc references use the filename only, not the full path, when feasible** (e.g. "see `D3_STEP3_DUAL_WRITE_REVIEW.md`" rather than "see `docs/D3_STEP3_DUAL_WRITE_REVIEW.md`"). This is the single biggest lever for reducing future move-pain — path-free references never go stale on a reorg, only on a rename.
10. **No `.DS_Store` (or other OS metadata) ever committed** — add `**/.DS_Store` enforcement at the repo root if not already global (it's already in `.gitignore`; the 3 files found here predate that rule or were force-added).
11. **A new initiative's docs are never split across two unrelated PRs without an index.** If D4+ work spans multiple sessions, the initiative folder's first doc should briefly list what's expected to follow, so a reader mid-stream can tell what's missing versus not-yet-written.
12. **Superseding relationships get a one-line pointer, not a deletion.** When a newer doc supersedes part of an older one (as `D2_PROVIDER_CONNECTION_ARCHITECTURE.md` does to §4–§8 of `D2_CONNECTION_ARCHITECTURE_REVIEW.md`), add a one-line "superseded by X, §Y still authoritative" note at the top of the older doc rather than archiving or deleting it.

---

## Summary

47 real files inventoried. 27 move (all into category subfolders; zero renames). 20 already sit in the right place. 3 `.DS_Store` files are junk, recommended for deletion. One file (`DATABASE_ARCHITECTURE_REVIEW.md`) has 3 real links that need a one-level path fix after moving. Roughly 50 textual (non-link) path references across docs, app/lib/scripts comments, and two root markdown files will go stale on move — cosmetic, not functional, and addressable in one follow-up pass. One pre-existing dangling reference (`docs/TRANSACTION_DUPLICATION_INVESTIGATION.md`, a file that doesn't exist) was found and flagged as unrelated to this reorganization.

No files were moved, renamed, or deleted. No folders were created. This document is the only file written.
