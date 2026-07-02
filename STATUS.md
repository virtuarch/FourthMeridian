# Fourth Meridian — STATUS

**This is the only file allowed to describe the current state of the project.**
Every other document is either an immutable decision record or an operational reference.
If this file conflicts with any other document, this file wins. If it conflicts with the code, fix this file.

| | |
|---|---|
| Last verified | 2026-07-02, against commit `23a6387` |
| Maintenance rule | Any PR that changes system behavior updates this file, or states in the PR why not |
| Supersedes | `ROADMAP.md`, `docs/operations/PROJECT_STATE.md`, and the status tables in `docs/architecture/PHASE_2_CANONICAL_ROADMAP_AUDIT.md` |

---

## 1. Project overview

Fourth Meridian is a personal finance platform built on Next.js 16 / Prisma / PostgreSQL, deployed to Vercel (sin1) with Supabase Postgres.

What exists and works today:

- **Accounts & sync** — Plaid Link, cursor-based incremental transaction sync with retry and manual-refresh cooldown, automatic duplicate-account reconciliation that survives Plaid reissuing account/transaction IDs, crypto wallet tracking by address, CSV import (MVP), soft-delete lifecycle throughout.
- **Spaces** — multi-tenant financial contexts (personal / shared) with roles (OWNER/ADMIN/MEMBER/VIEWER), invites, goals (4 types), per-Space dashboards, and graduated account sharing (FULL / BALANCE_ONLY / SUMMARY_ONLY) with read-time redaction.
- **AI analyst** — Space-scoped chat: deterministic intent routing, dynamic transaction windows with follow-up carry-forward, deterministic monthly rollups / merchant normalization / spending trends, a deterministic financial assessment engine (data quality, cash flow, debt, liquidity, capital allocation, risk/opportunity), knowledge-gap capture, provenance-first prompting. LLM: OpenAI gpt-4o-mini behind a single provider boundary.
- **Security** — AES-256-GCM with HKDF per-purpose key derivation, hashed password-reset tokens, TOTP + recovery codes, session management with revocation cache, append-only audit log, SYSTEM_ADMIN role with a fully separate admin surface and redacted provider diagnostics.

What does **not** exist yet: automated background jobs beyond one daily bank-sync cron (scheduler entrypoint never invoked; AI advice job is a stub), *live* output validation on LLM replies (a shadow validator is landed but observational only — see AI-4), broad test coverage (4 test files: output validator, two privacy suites, intent classifier), rate limiting, billing, production Plaid credentials.

## 2. Current version

| | |
|---|---|
| Architecture phase | v2.4 — Architecture Foundation — **architecture-complete; only branch merge/closeout remains** (see §5) |
| package.json | `2.4.0` |
| Latest tag | `v2.4.0` |
| Active branch | `feature/phase-2-architecture` (working tree clean; all foundation work committed through `f565a7e`; not yet merged) |
| Baseline of record | `v2.3.0` (Workspace → Space rename merged) |

## 3. Initiative ledger

Statuses: **Complete · Active · Planned · Parked · Deprecated**

### Decision Matrix initiatives (D1–D14 — IDs frozen, defined only by `PHASE_2_DECISION_MATRIX.md`)

| ID | Name | Status | Description | Evidence | Next milestone |
|---|---|---|---|---|---|
| D1 | DuplicateAccountCandidate audit behavior | Complete | Repurposed as append-only ledger of automatic merges | `lib/accounts/reconcile.ts`; commit `94aa6e2` | — |
| D2 | Provider & Connection architecture | Active | Production hardening (7A–7G) complete; residuals open: import pipeline remainder (4D), adapter generalization (5), first sync-provider selection (6), stabilization incl. PLAID-fallback removal (7) | `docs/initiatives/d2/D2_STEP7G_...CLOSEOUT_AUDIT.md` | Apply 5 doc-only fixes from `V24_COMPLETION_PLANNING_INVESTIGATION.md` §1, then move residuals to this ledger and freeze `D2_ROADMAP.md` |
| D3 | WorkspaceAccountShare → SpaceAccountLink | Active | Dual-write live; SAL is already the AI assemblers' read path; WAS still primary elsewhere | `lib/accounts/space-account-link.ts`; `lib/ai/assemblers/*` | Full read-cutover + WAS retirement (v2.5); HOME partial-unique index (v2.4.5) |
| D4 | AI Context Builder enforcement + agentScope | Active | `agentScope` shipped and intersected in builder; runtime membership guard live; lint-rule enforcement of the no-decrypt boundary not verified | `lib/ai/context-builder.ts`; `AiAgent.agentScope` migration | Verify/add lint enforcement (v2.4.5) |
| D5 | Job scheduler entrypoint + missing jobs | Active (reopened) | Daily bank-sync Vercel cron works; `startScheduler()` never invoked; `run-ai-advice.ts` and `sync-crypto.ts` are stubs. Audit's "Complete" status was premature | `vercel.json`; `jobs/scheduler.ts` header; `jobs/run-ai-advice.ts` | Scheduler substrate + AiAdvice write path (v2.6 entry criteria) |
| D6 | ProviderCatalog field reconciliation | Active | Slice 1 static catalog module shipped; reconciliation decision not fully executed | `lib/providers/catalog.ts`; `docs/initiatives/d6/` | Resume when a second provider or launch UI needs it |
| D7 | ProviderCatalog admin CRUD | Planned | Minimal SYSTEM_ADMIN-gated CRUD | Decision Matrix §D7 | After D6 completes |
| D8 | Lifecycle consistency rule | Complete | Soft-delete by default; archive tier only where UX needs undo | Decision Matrix §D8; applied to all Phase 2 tables | Known deviation: Plaid `removed` hard-deletes (defect KD-9) |
| D9 | SpaceTemplate / marketplace foundation | Parked | See §8 | Decision Matrix §D9 | — |
| D10 | Deferred-scope ratification | Complete | Marketplace/billing/messaging/support ratified out of Phase 2 | Decision Matrix §D10 | Billing ban lifts at v3.0, nowhere earlier |
| D11 | Schema modernization | Complete | Holding→FinancialAccount FK, hashed reset tokens, `createdByUserId` | Migrations `20260622150000`, `20260622...`; `lib/password-reset-token.ts` | — |
| D12 | Internal-ops Spaces / `isInternal` | Parked | See §8 | Decision Matrix §D12 | — |
| D13 | Connection.credential nullability | Complete | Nullable as decided | `prisma/schema.prisma` Connection model | — |
| D14 | Encryption key derivation (HKDF) | Complete | Per-purpose subkeys, dual-format reads. Audit's "Not Started" status was wrong (implementation lives in `lib/plaid/encryption.ts`, not `lib/encryption.ts`) | `lib/plaid/encryption.ts` | v1→v2 ciphertext re-encryption (defect KD-6, v2.4.5/v2.5) |

### AI intelligence track (AI-x — see §4 for aliasing)

| ID | Name | Status | Description | Evidence | Next milestone |
|---|---|---|---|---|---|
| AI-1 | Context Builder + domain assemblers | Complete | `buildContext()`, assembler/signal registries, accounts/transactions/goals/snapshot/holdings assemblers | `lib/ai/context-builder.ts`, `lib/ai/assemblers/` | — |
| AI-2 | Deterministic assessment engine | Complete | Data quality, cash flow, debt, liquidity, allocation, debt strategy, spending, trends, goal alignment, readiness, risk/opportunity | `lib/ai/intelligence/annotations.ts` | — |
| AI-3 | Intelligence expansion (formerly "D6.3") | Complete (pending stabilization) | Dynamic windows, carry-forward, ambiguity guard, drilldown, monthly rollups, merchant/income rollups, trends, shadow planner | `app/api/ai/chat/route.ts`; `lib/ai/context-priority/` | Closes only when AI-4 items in v2.4.5 land |
| AI-4 | Verification layer | Active | Phase 0 **shadow** output validator landed (`f565a7e`): pure membership-based number reconciliation, wired into the chat route observationally — writes an AuditLog row on unreconciled figures, reply byte-for-byte unchanged (KD-2 remains Open; no live enforcement yet). Remaining: heuristics consolidated into tested modules; planner promoted from shadow to live budgeting | `lib/ai/output-validator.ts`; `docs/initiatives/ai4/AI-4_PHASE_0_INVESTIGATION.md`; PE review (2026-07-02) | v2.4.5 (promote validator to live enforcement + tests); v2.6 (planner live) |

### Other

| ID | Name | Status | Description | Evidence | Next milestone |
|---|---|---|---|---|---|
| L-1 | Launch readiness | Planned | Billing, onboarding, Plaid production approval, legal/compliance, ops readiness, support tooling | §5 v3.0 | Start Plaid production application during v2.6 |
| UI-1 | Design system ("glass" language) | Planned | Tokens + component library; chrome carries brand, data surfaces stay 0%-effect; distributed across v2.5–v3.0, no dedicated UI release | §5 | Tokens + new-surface adoption in v2.5 |
| PAV | PublishedAccountView | Parked | See §8 | Freeze doc §9.3 | — |

## 4. Initiative naming — alias table

The D-number collision is resolved by **freezing, not renumbering**. `PHASE_2_DECISION_MATRIX.md` is the sole authority for D1–D14, forever. Historical commits/docs are not edited.

| Historical label (commits, code comments, docs) | Canonical ID | Note |
|---|---|---|
| "D6", "D6.3", "D6.3A–D" in AI/intelligence contexts | **AI-3** | Collision victim: matrix D6 = ProviderCatalog. AI-3 investigations were filed in `docs/investigations/D6_3*.md` because `initiatives/d6/` was already owned by ProviderCatalog |
| "D4 Slice 1", "D4 chat", "D4 provider lifecycle", "D4 Balance Freshness" | **AI-1 / AI-2** (AI work) + D2 (provider lifecycle) | Code used "D4" as an era label broader than matrix D4 (enforcement + agentScope) |
| "D6/D7 Provider Catalog — Slice 1" (`lib/providers/catalog.ts`) | **D6/D7** | Correct usage — matrix meaning |
| "D6 Institution Catalog investigation" | **D6** | Correct usage |

**Namespace rule going forward:** new initiatives get a **track prefix + number**, allocated only in this file, with a `docs/initiatives/<id>/` folder created at allocation time so an ID can never be squatted twice. Track prefixes: `AI-x` (intelligence), `UI-x` (design system), `L-x` (launch/ops). This is recommended over a single flat namespace (`AI-x` alone or continuing D-numbers) because the flat D-namespace is exactly what collided: unrelated tracks competed for adjacent integers. Prefixes make the track self-evident in a commit message.

## 5. Roadmap

Phases are gated by **exit criteria**, not feature lists. The roadmap ends at launch; everything beyond it lives in §8.

### v2.4 — Architecture Foundation — **ARCHITECTURE-COMPLETE (merge/closeout pending)**
Shipped: provider lifecycle + Plaid sync/reconcile; AI-1..AI-3; D11/D13/D14; SAL dual-write; admin diagnostics; expand-history workflow. Both critical transaction-visibility leaks — KD-1 (AI context) and KD-15 (UI reads) — are fixed and committed; AI-4 shadow validator and KD-13 hygiene landed; KD-4 SAL write atomicity (Phases 1–3) fixed and committed.
Remaining exit action: all foundation work is committed (working tree clean through `f565a7e`); the only open step is merging `feature/phase-2-architecture` and cutting the closeout. No architectural work outstanding — remaining defects are gated to v2.4.5+ and are not v2.4 blockers.

### v2.4.5 — Stabilization / Verification — **NEXT** (production-readiness gate)
Scope: fix BALANCE_ONLY transaction leak (KD-1) ✅ → LLM output validator (AI-4) → test suites (merchant normalization, window/rollup math, privacy sanitizers, follow-up heuristics) → `db.$transaction` around merges/route write-groups (KD-4) ✅ → HOME partial-unique index (KD-5) → observability counters (fallback hits, sync stats, LLM tokens) → rate limiting (auth + chat) → repo hygiene.
**Exit criteria:** privacy regression tests green · a reply quoting a number absent from context is detectably flagged · zero non-transactional multi-write flows · D2 fallback counters observable · rate limits live.
**Hard rule: v2.5 does not open until every criterion is met. Fourth Meridian is not production-ready before this release.**

### v2.5 — Spaces Completion + Design Foundation
Scope: SAL read-cutover everywhere; WorkspaceAccountShare retirement; legacy `Account` out of all read paths; members/roles polish; visibility tiers enforced in every assembler; production shared-Spaces UX; Space-level AI surfaces; UI-1 tokens + component library, with all **new** surfaces built in the new design language (monolith component decomposition rides along). Stretch (cut first): Timeline/Activity, Documents.
**Exit criteria:** zero reads of `WorkspaceAccountShare` · zero legacy-`Account` queries in AI/read paths · BALANCE_ONLY guarantee proven by tests in a two-user shared Space, end to end · new surfaces ship in the new design system.

### v2.6 — Ambient Intelligence
Scope: scheduler substrate (D5 closure); AiAdvice write path; Daily Brief generation; signals → notifications; AI Inbox; context-priority planner live (prompt budgeting); advisory modes. Start Plaid production application (longest external lead time).
**Entry criteria:** v2.5 seams closed; AI-4 validator live — the system may not speak unprompted until it cannot misquote a number.
**Exit criteria:** one week of scheduled briefs with zero validator failures · notification opt-in/out · audit-log growth bounded (fix 2-rows-per-chat-per-Space amplification).

### v3.0 — Launch (L-1)
Scope: billing/subscription (D10 ban lifts here only); onboarding funnel; Plaid production credentials live; legal/compliance posture (ToS, privacy policy, remove "financial advisor" framing, LLM data-processing disclosure — external counsel); tested backups + incident response + alerting; support tooling; UI-1 consistency/perf/accessibility polish pass. **Zero new product surface.**
**Exit criteria:** a stranger can pay, connect a bank, share a Space with a partner, and be supported and recovered.

## 6. Production readiness

**Strengths (real, verified):** deterministic-first AI architecture (pre-computed assessments, complete-months math, confidence gating, provenance doctrine); Plaid identity-instability handling with a convergent, never-hard-deleting merge engine; boundary discipline (single auth chokepoint, single LLM import site, single decrypt module, HKDF purposes, tenancy with no admin bypass); disciplined additive-first migration execution.

**Blockers (must fix before any external user):**

1. BALANCE_ONLY transaction leak: **both paths fixed and committed** — AI context (KD-1) and UI reads (KD-15), 2026-07-02, via the shared canonical predicate `lib/ai/visibility.ts`
2. No *live* LLM output validation — a shadow validator is landed (AI-4, `f565a7e`) but observational only; numeric fidelity still rests on prompt obedience of gpt-4o-mini until enforcement is promoted (KD-2)
3. No rate limiting on auth or chat (KD-3)
4. Non-atomic `SpaceAccountLink` writes: **fixed and committed** (KD-4, 2026-07-02, Phases 1–3 — helper `tx` threading, merge atomicity, route-level `db.$transaction`). Unenforced HOME uniqueness under concurrency (KD-5) **remains open** — KD-4 provides the transaction seam but does not solve the `computeLinkKind` count-then-write race.
5. Thin test coverage (4 files: output validator, two privacy suites, intent classifier) — merchant-normalization, window/rollup math, and follow-up-heuristic suites still absent
6. LLM data-processing posture undefined (retention terms, user disclosure)

**Known risks:** five migration seams open concurrently; verification debt (invariants asserted in comments, not checked in code); solo-maintainer bus factor; `Float` for money; documentation weight exceeding maintenance capacity (this file is the countermeasure).

## 7. Known defects register

| ID | Issue | Severity | Owner milestone | Status |
|---|---|---|---|---|
| KD-1 | Transactions-summary assembler ignores `visibilityLevel`; BALANCE_ONLY accounts' merchants/amounts enter AI prompts (`lib/ai/assemblers/transactions.ts` SAL filter) | **Critical** | v2.4.5 | **Fixed & committed** 2026-07-02 (`cea8220`) — canonical predicate `lib/ai/visibility.ts` (FULL-only; ad-hoc SHARED audit clean in dev+prod) applied to summary + drilldown; tests: `lib/ai/assemblers/transactions.privacy.test.ts`, `scripts/test-visibility-two-user-space.ts` |
| KD-2 | No deterministic validation of LLM output figures against context | High | v2.4.5 (AI-4) | Open — shadow validator landed (`f565a7e`, observational only); closes when promoted to live enforcement |
| KD-3 | No rate limiting (auth endpoints, `/api/ai/chat`) | High | v2.4.5 | Open |
| KD-4 | Multi-table `SpaceAccountLink`-related writes (create/restore/archive/revoke/merge/permanent) not atomic; a partial failure could leave orphaned/half-applied state | High | v2.4.5 | **Fixed & committed** 2026-07-02 (`a732986`, `55e0abb`, `23a6387`) — Phase 1 transaction-aware SAL helpers (optional `DbClient`/`tx` threading) complete; Phase 2 merge pipeline atomicity complete; Phase 3 route-level `db.$transaction` wrapping across 9 files complete. No nested interactive transactions; external calls (Plaid `itemRemove`), snapshot regen, and provider-identity mirror all kept outside transactions. Validation passed locally: `prisma generate`, `tsc --noEmit`, `lint`. **Caveat:** `exchangeToken` keeps `FinancialAccount` resolution outside the connection+SAL transaction (forced by the self-transactional fingerprint resolver) — residual orphan window is low severity and retry/self-healing. Note the earlier "WAS↔SAL mirror desync" framing was obsolete: WAS runtime writes were already retired, so KD-4 was multi-table SAL atomicity. KD-5 (HOME uniqueness under concurrency) is **not** solved by KD-4 and remains open. |
| KD-5 | "One HOME per account" unenforced; `computeLinkKind` count-then-write race | High | v2.4.5 | Open |
| KD-6 | v1 (root-key) ciphertexts not re-encrypted; D14 Slice 5 pending | Medium | v2.5 | Open |
| KD-7 | 5,000-row desc-ordered fetch cap silently truncates oldest months of long windows while prompt asserts rollups are complete | High | v2.4.5 | Open |
| KD-8 | Master-mode chat: unbounded prompt size; failed Spaces silently omitted (`Promise.allSettled`) with no disclosure | Medium | v2.5–v2.6 | Open |
| KD-9 | Plaid `removed` hard-deletes transactions, contradicting D8 soft-delete rule | Low | v2.6 | Open |
| KD-10 | Two competing "monthly expense" figures in one prompt (assessment block vs context block) | Medium | v2.4.5 | Open |
| KD-11 | Duplicated, drifting keyword heuristics between chat route and intent classifier; only classifier is tested | Medium | v2.4.5 | Open |
| KD-12 | Audit-log write amplification: 2 rows per chat message per Space (shadow plans in metadata) | Low | v2.6 | Open |
| KD-13 | Repo hygiene: personal photos at root, committed `" 2"` Finder-duplicate dirs, uncommitted branch changes, `.env` docs name `ANTHROPIC_API_KEY` while code requires `OPENAI_API_KEY` | Low | v2.4.5 | **Effectively resolved** (`5aba9cb`, plus clean tree at `f565a7e`) — personal jpegs removed, `.env.example` uses `OPENAI_API_KEY`, stray `signal-registry.ts` deleted, branch committed. Only residue is gitignored `.next` build-cache `* 2` files (not tracked) |
| KD-14 | Scheduler entrypoint never invoked; `run-ai-advice`/`sync-crypto` stubs; `AiAdvice` has never had a write path | High (blocks v2.6) | v2.6 entry | Open |
| KD-15 | UI transaction read paths ignore `visibilityLevel`: `lib/data/transactions.ts` (`getTransactions`/`getDebtTransactions`/`getInvestmentTransactions`) filter SAL on `status: ACTIVE` only, so BALANCE_ONLY/SUMMARY_ONLY accounts' rows reach dashboard pages and `app/api/accounts/[id]/transactions` — same defect class as KD-1, discovered during the KD-1 impact map (2026-07-02). Violates the `VisibilityLevel` enum contract ("BALANCE_ONLY — … no transactions"). Fix reuses `lib/ai/visibility.ts` | **Critical** | v2.4.5 | **Fixed & committed** 2026-07-02 (`98e3ab0`) — `getTransactions`/`getDebtTransactions`/`getInvestmentTransactions` and `app/api/accounts/[id]/transactions` now filter the SAL path on `TRANSACTION_DETAIL_VISIBILITY` (same predicate as KD-1); tests: `lib/data/transactions.privacy.test.ts` |

## 8. Parked ideas

The roadmap ends at launch. These are deliberately parked, not forgotten. Each lists its unpark condition.

| Idea | Why parked | Unpark condition |
|---|---|---|
| Marketplace / SpaceTemplate (matrix D9) | Zero users; no demand signal; distracts from launch | Real users requesting templates post-launch |
| Internal-ops Spaces (matrix D12) | Internal team doesn't exist; putting privileged ops data inside customer tenancy would weaken the codebase's strongest boundary. True dogfooding = run company finances in a normal BUSINESS Space (costs nothing, start now) | Internal headcount whose workflows demonstrably outgrow the Admin Console; then implement via `isInternal` + separate authz gate per matrix D12 |
| ProviderAdapter abstraction | D2 Step 5 investigation correctly concluded a generic interface before a second provider is speculation | A second sync provider committed (this also unparks the `Connection` cutover) |
| PublishedAccountView | Public trust boundary over financial data; private boundary not yet hardened (KD-1 exists) | External security review of the private sharing boundary passed |
| Second sync provider / investment transactions / wallet providers | Launch does not require them; Plaid-only launch is fine | Post-launch, ranked by usage evidence |
| Agents / automation workflows | An assistant must first never misstate a number when asked before it acts unprompted or autonomously | Post-launch + validator track record |
| Billing/payouts/messaging/support tables (D10 list) | Ratified out of Phase 2 | Billing only: lifts at v3.0 |
| Decimal/int-cents money migration | High-churn schema period; migration is large | Plan during v2.5; execute post-v2.6 |

## 9. Documentation map

| Looking for… | Read | Nature |
|---|---|---|
| Current state, roadmap, defects, initiative status | **`STATUS.md`** (this file) | Living — the only current-state authority |
| What was decided and why (D1–D14) | `docs/architecture/PHASE_2_DECISION_MATRIX.md` | Immutable decision record |
| Architecture baseline at Phase 2 start | `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` | Immutable; schema line refs are dated |
| Deep-dives behind decisions | `docs/initiatives/dN/`, `docs/investigations/` | Immutable point-in-time investigations |
| What shipped in an initiative | Closeout/implementation reports inside `docs/initiatives/dN/` | Immutable |
| How to deploy / operate | `docs/operations/DEPLOYMENT.md`, `HYDRATION_RULES.md` | Living operational references |
| Historical status snapshots | `docs/architecture/PHASE_2_CANONICAL_ROADMAP_AUDIT.md`, `docs/operations/PROJECT_STATE.md`, `ROADMAP.md` | Superseded — historical only, do not trust for status |
| Bug post-mortems | `docs/bugfixes/` | Immutable |
| Release notes | `docs/releases/` | Immutable per version |

## 10. Documentation cleanup recommendations

No documents were edited or deleted. Recommended dispositions:

| Document | Disposition | Rationale |
|---|---|---|
| `ROADMAP.md` (root) | **Redirect** | Frozen at v1.0; milestones already shipped/superseded. Replace body with a pointer to STATUS.md; move run instructions to README |
| `docs/operations/PROJECT_STATE.md` | **Archive** | Dated 2026-06-11; contradicts live system (calls AI chat "mock"). Move to `docs/archive/` with superseded header |
| `PHASE_2_CANONICAL_ROADMAP_AUDIT.md` | **Supersede** (keep in place) | Status table stale within days (D14 "Not Started" is wrong; D4 status wrong). Add point-in-time header; method section remains valuable |
| `PHASE_2_DECISION_MATRIX.md` | **Keep** (immutable) | Sole D-number authority. Add header: decisions only, not status |
| `PHASE_2_ARCHITECTURE_FREEZE.md` | **Keep** (immutable) | Add point-in-time header; line-number citations and some model claims (e.g., Holding FK) predate D11 |
| `docs/initiatives/d2/D2_ROADMAP.md` | **Supersede after fix** | Apply the 5 doc-only corrections from `V24_COMPLETION_PLANNING_INVESTIGATION.md` §1, then freeze; residuals tracked here |
| `docs/investigations/D6_3*.md` | **Keep** (do not move/rename) | Alias table (§4) maps them to AI-3 |
| `docs/README.md` | **Keep, trim** | Folder index only; remove status language; point here |
| `docs/archive/` gitignore status | **Decide** | An untracked archive isn't an archive. Recommend tracking (excluding images with personal content) |
| Stale code comments (`context-builder.ts` "Slice 1 has none / no detectors exist"; `visibility.ts` citing uncommitted `scripts/audit-visibility-levels.ts`; `transactions.ts` citing missing `docs/initiatives/kd15/…`) | **Done** | Superseded 2026-07-02 in the status/comment truth-up — comments now reflect reality; `space-account-link.ts` "nothing reads SAL yet" comment already gone |
| Root-level personal photos, `" 2"` duplicate dirs | **Archive/remove** | KD-13, v2.4.5 hygiene |

## 11. Executive summary

**Architecture maturity: high for its stage.** The expensive-to-retrofit boundaries — tenancy, encryption, auth chokepoints, the LLM provider seam — are correct and consistently enforced. The AI layer's deterministic-first design (the model narrates pre-computed, provenance-carrying facts; it never calculates) is a genuine differentiator executed above industry norm.

**Launch readiness: not yet, by design.** The gap is not features — it is verification. Thin test coverage (4 files), only shadow (not live) output validation, invariants still asserted in comments, and five migration seams open at once. The critical privacy defects (KD-1, KD-15) are now closed, but the enforcement discipline behind them is not yet systematized. v2.4.5 exists precisely to convert prose guarantees into checked ones, and the roadmap gates every subsequent phase on it.

**Largest strengths:** deterministic AI assessment pipeline; Plaid failure-mode resilience; migration discipline; security architecture fundamentals.

**Largest weaknesses:** verification debt; concurrent seam count; solo bus factor; no operational substrate for scheduled intelligence yet.

**Biggest risks:** ambient features speaking unprompted before *live* output validation exists (shadow validator is not enforcement); documentation reverting to fragmentation if this file is not maintained. (Two items previously headlining this list are now closed — the BALANCE_ONLY leak via KD-1/KD-15, and the non-atomic SAL writes via KD-4, all fixed and committed. HOME uniqueness under concurrency (KD-5) is still open but is a `kind`-correctness concern, not a visibility or read-cutover corruption risk.)

**Recommendation:** close v2.4 now; execute v2.4.5 without scope additions; define v2.5 as seam-closure plus design foundation; let v2.6 earn ambient behavior behind the validator; launch at v3.0 with zero new surface. Everything else stays in §8 until the market says otherwise.
