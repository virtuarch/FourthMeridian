# v2.4 Completion Planning Investigation

**Status: investigation only. No code, schema, migration, or documentation file was modified to produce this document.** Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`.

**Purpose.** Before opening a new lettered Phase 2 decision, determine whether the three initiatives with open trailing work (D2, D3, D14) can or should be formally closed first, and establish the cleanest completion sequence. Every finding below is grounded in direct repository evidence.

Source documents read for this investigation: `docs/initiatives/d2/D2_ROADMAP.md`, `docs/initiatives/d2/D2_STEP7G_PRODUCTION_HARDENING_CLOSEOUT_AUDIT.md`, `docs/initiatives/d2/D2_STEP6_CLOSURE_DECISION.md`, `docs/initiatives/d3/D3_LEGACY_RETIREMENT_AUDIT.md` (§§3–7), `docs/initiatives/d3/D3_STEP4C_REGRESSION_ROOT_CAUSE.md`, `docs/initiatives/d3/D3_STEP4E_IMPLEMENTATION_REPORT.md`, `lib/plaid/encryption.ts`, `lib/encryption.ts` (deprecated stub), `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` §7/§19.7, `docs/architecture/PHASE_2_DECISION_MATRIX.md` §D14 and §3.

---

## 1. D2 — Provider & Connection Architecture

### What D2_STEP7G says can close now vs. what cannot

The Step 7G closeout audit is explicit and unambiguous on this point (§Q8):

> "The 'D2 Step 7A–7G Production Hardening' initiative — yes, close it."
> "The full 'D2 Roadmap' (Steps 1–7 as defined in D2_ROADMAP.md) — no, not yet."

That distinction is the correct framing. The Production Hardening slice (connection health classification, manual refresh cooldown, scheduler/cron wiring, retry/backoff, reconnect flow, provider diagnostics) is fully implemented and verified against live code, all 6 commits confirmed, `tsc`/`lint` clean. Nothing here needs additional code.

### Three items genuinely open on the full D2 Roadmap

Confirmed by direct read of `D2_ROADMAP.md` and cross-checked against `D2_STEP7G`:

**Step 4D remainder** (not started, not approved): Excel and QuickBooks-export upload/parsing, rollback via `ImportBatch.status = ROLLED_BACK` + `Transaction.deletedAt` soft-delete, optional create-new-account-from-import, historical backfill, AuditLog for CSV imports. Step 4D-1 (CSV import MVP) is done; none of the rest is.

**Step 5 full scope** (slice #1 done, rest not started): `lib/imports/provider-capabilities.ts` (commit `18f0922`) is slice #1. The remaining three items — sync provider adapter, import provider adapter beyond the capability-lookup slice, wallet adapter abstraction, and shared normalized transaction format — are explicitly listed as `⏳ Not started` and the D2_ROADMAP.md Step 5 status line incorrectly reads "⏳ Planned. Not started" (noted as stale by Step 7G §Q2). The sync/wallet adapter generalization has never been approved or started.

**Step 6 sync-provider selection** (open decision): Selecting Coinbase, Schwab, or wallet xpub as the first real sync-side provider remains explicitly unresolved. `D2_ROADMAP.md:97` states: "Selecting the first real sync-side provider (Coinbase, Schwab, or wallet xpub) is still an open decision." This is a product/prioritization call, not a technical blocker, and it has carried unresolved since the original Step 6 investigation.

**Step 7 original stabilization bullets** (entirely untouched): PLAID fallback removal, verification-script generalization, cross-provider consistency checks, data-integrity audits, docs/runbooks, a second read-path audit, legacy cleanup planning — none were touched by Steps 7A–7G (a different, later-added body of work that claimed the same label). Step 7G §Q8 confirms these are "fully untouched."

### Are these genuinely incomplete or superseded?

**Step 5/6 (sync adapter + first sync provider):** Partially superseded in scope, not abandoned. The D2 Step 5 investigation (`D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md`) explicitly concluded that a formal `ProviderAdapter` interface typed against a generic shape was *not* a D2 deliverable — the Plaid adapter (`lib/providers/plaid/adapter.ts`) was deliberately left as a thin re-export, not typed against a generic interface, because the Architecture Freeze's full Provider Adapter Layer is owned by `feature/provider-adapter-layer` (branch 3 / D2/D13 scope). What's "remaining" in D2 Steps 5/6 is therefore ambiguous: the full sync adapter generalization properly belongs to branch 3, while the Step 6 provider-selection decision is still genuinely open as a product call. Neither item blocks anything currently in front of us.

**Step 7 stabilization:** Genuinely incomplete, but appropriately gated. PLAID fallback removal requires a production observation window (zero `[plaid][D2-3C/3D/3E/3F]` fallback-hit warnings). That gate hasn't been cleared. The rest of the bullets are explicitly later-phase cleanup. These are not "forgotten" — they are sequenced correctly behind production evidence.

**Step 4D remainder:** Not superseded. This is real, approved-in-concept but not-yet-approved-to-implement import pipeline work. It has a concrete dependency: each 4D sub-step needs its own checklist and explicit approval before starting, per the standing working style rule.

### Smallest path to formal D2 closure for v2.4

Formal D2 closure for v2.4 purposes means: completing the five documentation fixes already identified by `D2_STEP6_CLOSURE_DECISION.md` and `D2_STEP7G`, then explicitly deferring Steps 4D-remainder, 5-full, 6-sync, and 7-stabilization to a future v2.x initiative. All five fixes are `D2_ROADMAP.md`-only edits (plus one optional `.ts` comment), zero schema/migration/code changes:

1. `D2_ROADMAP.md:76` — Step 5 status: "⏳ Planned. Not started." → "🔶 In progress — slice #1 (`lib/imports/provider-capabilities.ts`, commit `18f0922`) shipped; sync/wallet adapter generalization not started."
2. `D2_ROADMAP.md:38` — Step 2 WALLET dual-write row: ⛔ → ✅.
3. `D2_ROADMAP.md:54,110` — Step 3 WALLET phrasing: "blocked, pending a decision" → "permanently excluded from read cutover by design (D2 Step 1D §5)."
4. `D2_ROADMAP.md:89–97` — Step 6 candidate list: split "Wallet/xpub" into closed (watch-only) / open (xpub, deferred v2.7+); remove "CSV Import" (validated by D2-5).
5. `D2_ROADMAP.md:98–108` — Step 7: add explicit disambiguation between "Step 7A–7G Production Hardening ✅" (6 commits) and "Step 7 Stabilization ⏳" (original bullets), mirroring the Step 3G precedent at line 56.
6. *(Optional, bundled)* `lib/accounts/provider-identity.ts:14–19` — fix stale "nothing calls it with provider=WALLET today" comment. Third flag of the same staleness; D2_STEP6_CLOSURE_DECISION.md §2 recommends fixing now rather than deferring a fourth time.

**Validation required:** `npx tsc --noEmit`, `npm run lint` (expected no-op; no logic changes). `git diff` review confirming all changed lines are markdown prose/table cells (plus the one optional comment line).

**D2 verdict:** Can formally close the Production Hardening slice immediately via documentation-only changes. Steps 4D-remainder, 5-full-scope, 6-sync-provider, and 7-stabilization should be explicitly deferred to a future initiative, not left as open D2 items. This is a clean, low-risk first step.

---

## 2. D3 — SpaceAccountLink Legacy Retirement

### Current state of the five gating items

The `D3_LEGACY_RETIREMENT_AUDIT.md` (§4) listed five gating items before `WorkspaceAccountShare` retirement could proceed. Here is their current status, cross-referenced against `D3_STEP4E_IMPLEMENTATION_REPORT.md` and `D3_STEP4C_REGRESSION_ROOT_CAUSE.md`:

**Gating item 1 — Stop all production reads:** ✅ **Done.** `D3_STEP4E_IMPLEMENTATION_REPORT.md` confirms the archived-assets page (`app/(shell)/dashboard/settings/archived-assets/page.tsx`) was the last known production read path and was cut over from `workspaceShares` to `spaceAccountLinks`. Repo-wide grep post-4E confirmed no `app/`, `lib/`, or `components/` code reads `WorkspaceAccountShare` for serving data. This was the last item blocking "no production read paths" being true.

**Gating item 2 — Resolve SpaceAccountLink data completeness gap:** ❌ **Open, and the highest-risk blocker.** `D3_STEP4C_REGRESSION_ROOT_CAUSE.md` identified that the 4C rewrite exposed a pre-existing data gap: accounts whose `SpaceAccountLink` row is missing simply disappear from the dashboard. The verification script (`scripts/verify-space-account-link-backfill.ts`) was last confirmed passing right after the Step 2 backfill — before the Step 3 HOME correction and before live traffic since. It has not been re-run. This gap must be confirmed resolved before writes can safely stop, because once `WorkspaceAccountShare` stops being written, there is no fallback for any account whose `SpaceAccountLink` row is missing or wrong-status. Critically: the diagnostic in §6 of the root-cause report (the scoped triage script) was listed as "must be run locally" — no evidence in the repo that it has been run.

**Gating item 3 — Fix `manual/route.ts` HOME-kind race condition:** ❌ **Open.** `D3_STEP4C_REGRESSION_ROOT_CAUSE.md` §Secondary Finding confirmed the race: `app/api/accounts/manual/route.ts` fans `dualWriteSpaceAccountLink()` via `Promise.all` across multiple spaces for one account, and `computeLinkKind()` can independently decide `HOME` for two concurrent calls, violating the "exactly one HOME" invariant. The report explicitly states "not fixed here." This is a `kind`-correctness bug that becomes uncorrectable once `WorkspaceAccountShare` is gone.

**Gating item 4 — Migrate `accounts/[id]/route.ts` authorization read:** ❌ **Open.** The Legacy Retirement Audit identified `app/api/accounts/[id]/route.ts`'s authorization check as still reading from `workspaceShares`. `D3_STEP4E_IMPLEMENTATION_REPORT.md` notes this was out of scope for Step 4E (archived-assets was the only target). Confirmed still open: this authorization read is functionally correct today because `WorkspaceAccountShare` is still the live write target, but it becomes a correctness risk once writes stop.

**Gating item 5 — Freeze amendment sign-off for table removal:** ❌ **Open (governance).** `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` §17 explicitly protects `WorkspaceAccountShare` from Phase 2 schema changes. The Legacy Retirement Audit §7 states table removal is "gated on an explicit freeze-amendment decision this audit can't make." This is a process gate, not a technical one, but it is real and must be resolved before any migration that drops the table.

### Can D3 formally close now?

**Read-cutover phase: yes.** All production reads on `WorkspaceAccountShare` are now on `SpaceAccountLink`. This is a meaningful, genuine milestone — the D3 read-cutover initiative is complete.

**Legacy retirement (stopping writes + table removal): no.** Gating items 2–5 are all open. Of these, item 2 (data completeness) is the hardest dependency: if the verify script reveals missing `SpaceAccountLink` rows, a targeted data fix is required before stopping writes. The exact scope of that fix is unknown until the script runs. This is the same gap that caused the $0 dashboard regression documented in Step 4C.

### Smallest path to formal D3 closure

The retirement sequence from `D3_LEGACY_RETIREMENT_AUDIT.md` §7 is the governing plan. The remaining steps, in order:

**Stage A (prerequisites — required before stopping writes):**
1. Run `scripts/verify-space-account-link-backfill.ts --verbose` locally (read-only, zero writes). If Check 1 or Check 3 fails, scope a targeted data-fix before proceeding. If it passes, confirm explicitly.
2. Fix `manual/route.ts` race condition (gating item 3) — small code change, one file, but own checklist + approval required.
3. Migrate `accounts/[id]/route.ts` authorization read off `workspaceShares` (gating item 4) — one file, own checklist.

**Stage B (stopping writes — the largest remaining D3 step):**
4. Flip the twelve write paths from dual-write to `SpaceAccountLink`-only, in batches per the "not all in one commit" rule.
5. Bake: run with `WorkspaceAccountShare` rows static (no new writes), observe for silent failures and for any admin/report path not caught by the grep audit.

**Stage C (retirement — process gate):**
6. Freeze amendment sign-off.
7. One migration to drop `WorkspaceAccountShare`. One schema edit to remove the model and its four back-relations.
8. Sweep 13 stale-comment code files (leave historical docs untouched).

Each stage is its own approval cycle and commit(s). Stage A alone is 3 separately-approved items. Stage B requires explicit review of all 12 write paths and their batching plan before implementation begins.

**D3 verdict:** Read-cutover is done. Formal closure (legacy table retirement) requires Stage A prerequisites first, then Stage B write-retirement as the most complex remaining D3 work. D3 cannot close in one session — the minimum path is 3 staged approval cycles. The data completeness question (Stage A item 1) must be answered before anything else in Stage A or B can start.

---

## 3. D14 — Encryption Key Derivation

### Current state confirmed by direct code read

`lib/encryption.ts` is a deprecated stub (`export {}`) pointing callers to `lib/plaid/encryption.ts`. The real implementation is at `lib/plaid/encryption.ts` — a clean, 58-line AES-256-GCM module. It derives its key directly from `process.env.ENCRYPTION_KEY` (a 32-byte / 64-hex-char root key) with zero per-purpose derivation.

Three call sites confirmed sharing this one root key today:
- `PlaidItem.encryptedToken` — encrypted at `app/api/plaid/exchange-token/route.ts`, decrypted at `lib/plaid/refresh.ts` and other Plaid routes
- `User.totpSecret` — encrypted at TOTP setup, decrypted at `lib/auth.ts:149` during login
- `User.dateOfBirthEncrypted` — schema at `prisma/schema.prisma:287`, comment confirms "AES-256-GCM (same key as Plaid tokens)"

`Connection.credential` (`prisma/schema.prisma:532`) is the fourth secret that will join this pool. Its schema comment says "encrypted; null for MANUAL; xpub/descriptor for WALLET watch-only." It exists in the schema but is null for every row today — confirmed by D2_STEP7G Q1: "zero `db.connection.`/`prisma.connection.` hits outside docs." No application code writes `Connection.credential` yet.

No HKDF or per-purpose key derivation exists anywhere in the codebase. `crypto.hkdfSync` (Node 15+) is available in the runtime (Next.js 16) but is not imported anywhere.

### Prerequisite check

Decision Matrix §D14 states D14 is "independent of branches 1–2" (D11/schema-modernization and D6/D7/provider-catalog) and should land "before `feature/provider-adapter-layer` (branch 3)." Branch 3 is the one that wires `Connection.credential` with real production data. That branch has not started. `Connection.credential` is not yet written by any application code. The window to implement D14 is open.

No Phase 2 initiative currently in progress blocks D14. D11 (its only explicitly-named predecessor in Freeze §19.7 framing) is complete.

### Implementation slices

The Decision Matrix recommendation is Option A: per-purpose HKDF derivation from one root key, one subkey per purpose, before `Connection.credential` is added. The natural implementation structure:

**Slice 1 — HKDF wrapper (`lib/encryption/hkdf.ts`):** Accept `(purpose: string, rootKey: Buffer)` → return a 32-byte derived key via `crypto.hkdfSync('sha-256', rootKey, salt, purpose, 32)`. Salt can be a fixed, well-known constant (not secret, not rotation-dependent) — the per-purpose `info`/context parameter is what provides isolation between purposes. Export a `derivePurposeKey(purpose: string): Buffer` helper that reads `ENCRYPTION_KEY` once and derives.

**Slice 2 — Purpose registry (`lib/encryption/purposes.ts`):** Define purpose string constants: `"plaid-access-token"`, `"totp-secret"`, `"date-of-birth"`, `"connection-credential"`. Typed as a discriminated union or `const` object to prevent typos creating a new, untracked purpose at call sites.

**Slice 3 — Upgrade `lib/plaid/encryption.ts`:** Accept an optional `purpose` parameter. For new writes, derive a purpose key and encrypt with it. For reads, support both format variants (see Key Risk below). The module's existing `iv:authTag:ciphertext` format can be extended to `purpose:iv:authTag:ciphertext` (4-part) to distinguish new-format from old-format (3-part) without a breaking change.

**Slice 4 — Update call sites:** Three affected modules (`exchange-token/route.ts`'s Plaid encrypt, `lib/auth.ts`'s TOTP decrypt, any DOB encrypt/decrypt path). Each passes its purpose constant to the updated module. No UI change required.

**Slice 5 — Data migration (optional, separately approved):** A script that iterates `PlaidItem`, `User.totpSecret`, and `User.dateOfBirthEncrypted` rows, decrypts each with the root key (old format), re-encrypts with the purpose-derived key (new format), and writes back. Requires a production window and careful rollback planning. This step is separable: Slices 1–4 can ship with backward-compatible dual-format reads (old format uses root key, new format uses derived key — distinguished by whether the ciphertext has 3 or 4 parts). The data migration script then upgrades existing rows on whatever timeline is safe.

### Architectural risks

**Risk 1 (Medium) — Data migration scope.** All three existing call sites have live encrypted data in production. A big-bang re-encryption (all rows at once) risks leaving the database in a partially-migrated state if interrupted. The recommended mitigation: dual-format reads (Slice 3 above) let Slices 1–4 ship as a behavior-preserving change, then the data migration runs as a separately-approved, separately-rollback-planned step. This mirrors the D2 dual-write → read-cutover → fallback-removal pattern already established in this codebase.

**Risk 2 (Low) — HKDF salt choice.** HKDF's salt is not secret, but choosing a different salt than expected during key rotation would produce different derived keys — making all encrypted data unreadable. Recommend a fixed, well-documented salt (e.g. `Buffer.alloc(32, 0)` or a literal hex constant committed to code), not an env-var, so the derivation is fully deterministic from `ENCRYPTION_KEY` + `purpose` alone. Document this constraint in the module header.

**Risk 3 (Low) — `totpSecret` decryption during login.** `lib/auth.ts:149` decrypts `user.totpSecret` on every TOTP-enabled login. If the dual-format detection logic has a defect, TOTP users can't log in. This call site is the highest-criticality of the three — recommend testing it explicitly before any format change goes to production.

**Risk 4 (Low) — `lib/encryption.ts` deprecated stub.** The stub (`export {}`) with a deprecation comment exists at `lib/encryption.ts`. The new `lib/encryption/` directory (Slices 1–2) would sit adjacent to it. The stub should be left as-is during D14; removing it is cosmetic cleanup that can wait for the eventual legacy cleanup pass.

### D14 verdict

Clean, standalone, no prerequisites unmet. The window is open (Connection.credential not yet written by application code). Implementing Slices 1–4 as a dual-format-read change has low risk. Separating the data migration (Slice 5) as its own approval cycle is the correct sequencing for this codebase's pattern. Estimated scope: 4–5 files touched for Slices 1–4 (one new directory, two new files, three updated call sites). The implementation is architecturally straightforward; the operational risk is concentrated in the data migration slice and is manageable with a rollback plan.

---

## 4. Recommended Execution Order

### Does the proposed order (Close D2 → Close D3 → D14 → D6/D7) make sense?

Mostly yes. Two refinements warranted by the evidence:

**Refinement 1: D14 before D3 write-retirement, not after.** The proposed order places D14 after D3 closes. But D3 closure (Stage B, stopping writes) is the most complex and time-consuming remaining step — multiple approval cycles, 12 write paths batched across commits, a bake period. D14 is small and self-contained, with zero dependency on D3's state. The canonical Decision Matrix sequence (§3) has `encryption-key-derivation` before `space-account-link-migration`, not after. Implementing D14 before D3's write-retirement keeps the sequence aligned with the approved architecture record and avoids deferring a security-posture improvement until after a multi-session migration. D3's Stage A prerequisites (verify script + two code fixes) can run in parallel with or before D14 — they are orthogonal.

**Refinement 2: D3 "closure" is two phases, not one.** "Close D3" as a single step is not achievable in v2.4 scope without splitting it. The read-cutover phase is already done (4E shipped). What remains is the write-retirement phase, which has concrete prerequisites (Stage A) and is itself a multi-session operation (Stage B). Treating these as one step understates the work.

### Recommended sequence

| Order | Initiative | Scope | Risk | Prerequisite |
|---|---|---|---|---|
| 1 | **Close D2** (docs only) | 5–6 line edits in `D2_ROADMAP.md`, one optional comment fix | Very low | None |
| 2 | **D3 Stage A** — verify data completeness + two code fixes | Run verify script; fix `manual/route.ts` race; migrate `accounts/[id]/route.ts` auth read | Low-Medium | Verify script result must pass (or gap must be scoped) before items 2–3 |
| 3 | **D14** — encryption key derivation | Slices 1–4: new `lib/encryption/` directory + 3 updated call sites | Low (dual-format read strategy) | None; independent |
| 4 | **D3 Stage B** — stop writes | 12 write paths cut over in batches; bake period | Medium-High | Stage A complete; D14 not a prerequisite |
| 5 | **D3 Stage C** — table removal | Freeze amendment + migration + cleanup | Medium (governance gate) | Stage B bake period clear |
| 6 | **Begin D6/D7** — ProviderCatalog | New branch; Decision Matrix §D6/D7 scope | Low | Independent; no D3/D14 dependency |

Notes:
- Steps 2 and 3 are independent of each other and can be ordered either way, or parallelized (different files, no shared dependencies).
- D14's data migration (Slice 5) is intentionally excluded from step 3 — it is a separately-approved follow-on, not part of the initial D14 implementation.
- D6/D7 is independent of D3 and D14 by explicit Architecture Freeze §16 statement. It can begin as soon as the D6 investigation work (already filed at `docs/initiatives/d6/D6_PROVIDER_DISCOVERY_INVESTIGATION.md`) is approved for implementation.
- D3 Stage C requires a freeze amendment decision that is independent of all technical steps — it can be raised early and resolved in parallel.

### What this order buys

Close D2 first: clears documentation debt in one low-risk session. Establishes a clean baseline for what D2 delivered vs. what it deferred.

D3 Stage A before D14: the verify script result is gating information — if it reveals a data gap, that gap affects the risk profile of everything else. Better to know early. The two code fixes are small but need to land before Stage B to avoid implementing write-retirement with known race conditions still live.

D14 before D3 Stage B: D14 is cheaper to implement while Connection.credential is still null. Once branch 3 starts writing real credentials, the data migration scope grows. Implementing D14 before write-retirement also means any future `SpaceAccountLink`-adjacent write paths are built against the already-HKDF-aware encryption module from the start.

D3 Stage B last (before D6/D7): stopping writes is irreversible from a data perspective (once `WorkspaceAccountShare` rows stop updating, rolling back means gap-filling). It should run after D14 is confirmed stable, not before.

---

## 5. Stop point

This document stops here. Per the governing instruction, no code, schema, migration, or documentation file has been modified, and no implementation has been performed. Every finding above is grounded in direct repository evidence cited by file/section. No speculation.

The deliverables this investigation was asked to produce:
- **D2 remaining work analysis** → §1: six documentation fixes to close; Steps 4D-remainder, 5-full-scope, 6-sync, 7-stabilization explicitly deferred.
- **D3 remaining work analysis** → §2: read-cutover done; five gating items audited; Stages A/B/C defined; smallest path identified.
- **D14 analysis** → §3: architecture confirmed ready; five implementation slices defined; risks assessed.
- **Recommended execution order** → §4: Close D2 → D3 Stage A + D14 (parallel) → D3 Stage B → D3 Stage C → D6/D7.
