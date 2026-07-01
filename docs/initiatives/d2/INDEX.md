# D2 — Provider & Connection Architecture: Document Index

Navigational index for the D2 initiative record (64 documents). All documents here are immutable implementation history. Current D2 status — including residual open scope — lives in `STATUS.md` §3 (D2 row) at the repository root.

## Layout

| Folder | Contents | Count |
|---|---|---|
| `./D2_ROADMAP.md` | Frozen step-sequencing roadmap (the historical index-and-forward-plan) | 1 |
| `investigations/` | Pre-implementation investigations, design notes, reviews, sequencing proposals | 23 |
| `implementation/` | Implementation checklists, plans, reports, corrections | 20 |
| `validation/` | Per-step implementation validations and verification-gate reports | 15 |
| `closeout/` | Closure reviews, cutover audits, closeout decisions | 5 |

## Step map

| Step | Scope | Key documents |
|---|---|---|
| 1A–1B | `Connection` + `ProviderAccountIdentity` schema (additive) | roadmap §1 |
| 1C | PLAID identity backfill + verification; WALLET collision investigation (backfill permanently excluded) | `investigations/D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md`, `investigations/D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` |
| 1D | Multi-account identity correction (unique-constraint relaxation) | `implementation/D2_STEP1D_...CORRECTION.md`, `validation/D2_STEP1D_IMPLEMENTATION_VALIDATION.md` |
| 2 | Dual-write (PLAID + WALLET) | `investigations/` + `implementation/` + `validation/` `D2_STEP2*` files |
| 3A–3F | PLAID read cutover (fallback-first) | `investigations/D2_STEP3A_...INVESTIGATION.md`, `validation/D2_STEP3B_VERIFICATION_GATE_REPORT.md`, `implementation/D2_STEP3C–3F_*.md`, `closeout/D2_STEP3G_READ_CUTOVER_AUDIT.md`, `closeout/D2_STEP3_CLOSURE_REVIEW.md` |
| 4A–4C | Import foundation: ImportBatch schema, shared fingerprint helper | `D2_STEP4A/4B/4C` investigations + validations |
| 4D | Import pipeline: CSV MVP, Excel, rollback, QuickBooks, mapping profiles (4D-5a/5b/5c), read-path audit (4DR) | `D2_STEP4D*` files across all four folders; `closeout/D2_STEP4_CLOSURE_REVIEW.md` |
| 5 | Adapter interface — slice #1 (import capabilities) shipped; generalization deferred | `investigations/D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md` |
| 6 | First real provider — wallet + CSV closed; sync-provider selection deferred | `investigations/D2_STEP6_FIRST_PROVIDER_INVESTIGATION.md`, `closeout/D2_STEP6_CLOSURE_DECISION.md` |
| 7A–7G | Production hardening (health, cooldown, scheduler, retry, reconnect, diagnostics) — complete | `implementation/D2_STEP7A–7F_*.md`, `investigations/D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md`, `closeout/D2_STEP7G_PRODUCTION_HARDENING_CLOSEOUT_AUDIT.md` |
| 7 (original stabilization) | PLAID fallback removal, verification generalization, integrity audits — deferred | roadmap §Step 7; tracked in `STATUS.md` |

Cross-initiative design rationale lives in `docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` and `docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md`.
