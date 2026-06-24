# Phase 2 Decision Matrix — Spaces, Connections & Marketplace Foundation

**Status: Documentation only. No schema, migration, API, or application code was modified to produce this document.**

## 0. Document control

| | |
|---|---|
| Branch | `feature/phase-2-architecture` (off `fourth-meridian`) |
| Baseline tag | `v2.3.0` — Workspace → Space rename, merged into `fourth-meridian` |
| Primary source | `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` (485 lines, read in full — all 20 sections) |
| Purpose | Resolve the 9 open decisions in the freeze doc's §19, plus 9 named areas requiring extra scrutiny, into actionable recommendations |
| Out of scope this pass | Any change to `prisma/schema.prisma`, migrations, API routes, or UI. This document is the only deliverable. |

This document does not re-derive facts from the codebase — every "current state" below cites the freeze doc, which has already been reconciled against live code line-by-line. Where this document goes further than the freeze doc (e.g. naming a specific enforcement mechanism, or recommending a branch re-sequencing), that is flagged as **this document's own recommendation**, not as an existing freeze-doc conclusion.

Fourteen decisions are covered: the freeze doc's 9 numbered open decisions (§19.1–§19.9) plus 5 additional decisions raised by topics the freeze doc discusses but does not formally list in §19 (`AccountConnection` vs. `Connection`, archive/delete lifecycle consistency, and three others that turned out to fold into existing §19 items on inspection — noted inline). Every one of the 9 areas flagged for special attention is covered by exactly one decision below.

---

## 1. Summary matrix

| ID | Decision | Freeze doc ref | Recommended option | Blocks branch 1 (`schema-modernization`)? | Owning branch / phase |
|---|---|---|---|---|---|
| D1 | `DuplicateAccountCandidate` vs. silent auto-merge | §18.1, §19.1 | B — repurpose as audit log of auto-merges | No | New small PR, before `feature/provider-adapter-layer` |
| D2 | `AccountConnection`: evolve into `Connection` or replace | §18.5 | A — evolve in place (add `connectionId` FK, dual-write) | No | `feature/provider-adapter-layer` (branch 3) |
| D3 | `WorkspaceAccountShare`→`SpaceAccountLink`: same branch as schema modernization or later | §8, §16 | A — keep separate; also re-examine branch order | No | `feature/space-account-link-migration` (branch 4, re-sequencing flagged) |
| D4 | AI Context Builder: enforcement mechanism + `agentScope` shape | §12, §9.5 | C — lint rule **and** runtime guard; enum-shaped `agentScope` | No | `feature/ai-context-builder` (branch 6) |
| D5 | Job scheduler: entrypoint + missing jobs | §18.2, §19.8 | C — independent infra fix, not gated to any Phase 2 branch | No | Standalone, outside the six-branch sequence |
| D6 | `ProviderCatalog` field set reconciliation | §14, §19.2 | C — merge both lists (both flags, both health fields) | No | `feature/provider-catalog` (branch 2) |
| D7 | `ProviderCatalog` ownership + admin UI | §14 | B — minimal `SYSTEM_ADMIN`-gated CRUD route | No | `feature/provider-catalog` (branch 2) |
| D8 | Archive/delete lifecycle consistency for new tables | §11 | A — soft-delete by default; archive tier only where UX needs undo | No | Cross-cutting rule, stated once before branch 1 |
| D9 | `SpaceTemplate` & minimal marketplace foundation | §9.4, §16, §19.9 | B — build `SpaceTemplate` alone, early; defer the other four | No | New branch: `feature/space-template-foundation` |
| D10 | What must remain deferred | §10, §19.5 | A — ratify full deferred list as out of scope | No | No branch — explicitly out of scope |
| D11 | `FinancialAccount`/`Connection.createdByUserId` | §4, §19.3 | A — add now | No (bundles into it) | `feature/schema-modernization` (branch 1) |
| D12 | Internal-ops Spaces / `isInternal` flag | §4, §10, §19.4 | B — add only when an internal-ops feature is scoped | No | Prerequisite of a future, unnamed branch |
| D13 | `Connection.credential` nullability | §19.6 | A — genuinely nullable | No | `feature/provider-adapter-layer` (branch 3) |
| D14 | Shared `ENCRYPTION_KEY` blast radius | §7, §19.7 | A — per-purpose key derivation (HKDF), before branch 3 lands | No | New branch: `feature/encryption-key-derivation` |

No open decision blocks `feature/schema-modernization`. That branch can open as soon as D11 (its only directly-bundled item) is confirmed.

---

## 2. Detailed decisions

### D1 — `DuplicateAccountCandidate` vs. silent auto-merge

*Special-attention item 1. Freeze doc §18.1, §19.1.*

**Current state.** The schema's own model comment and the `DuplicateStatus` enum comment describe a human-reviewed queue ("NEVER auto-merged — user must confirm"). The review doc twice describes it as a working safety net. None of this matches the running code: `lib/accounts/reconcile.ts`'s fingerprint engine auto-merges silently, with no review step, and zero application code anywhere reads or writes `DuplicateAccountCandidate`. Two mutually exclusive designs exist — one in the schema/docs, a different one actually running.

**Risk if unresolved.** Anyone building Phase 2's `DiscoveredAccount` staging (§9.1) will reasonably assume `DuplicateAccountCandidate` is the live duplicate-resolution mechanism — because that's what the schema, its comments, and the review doc all say — and either wire new code to a queue nobody reads, or build a review UI that always shows zero pending items while merges keep happening invisibly underneath it. Separately, today's silent auto-merge has no human-in-the-loop check at all: a false-positive fingerprint match would silently merge two real accounts' histories with nothing catching it.

**Options.**
- **A.** Wire it up for real — fingerprint matches insert a `PENDING` row instead of auto-merging; merge proceeds only after `CONFIRMED_DUPLICATE`. Matches the schema's stated intent exactly, but is a behavior change to a currently invisible, friction-free mechanism with no reported incident.
- **B.** Repurpose as a post-hoc audit log — every automatic merge writes a `CONFIRMED_DUPLICATE` row for transparency, no blocking step added. Keeps current UX, finally gives the table a real writer.
- **C.** Deprecate and drop it — pure unused surface area if nobody needs visibility into past auto-merges.

**Recommendation: B.** Lowest-risk option that resolves the schema/code contradiction without changing user-facing behavior that already works, and gives the "evidence-backed safety net" framing a real basis in fact — valuable if a user ever disputes why their account history changed. A adds unjustified friction with no stated product reason; C throws away a free audit opportunity for what is a small, additive change to `mergeArchivedDuplicateIntoCanonical`.

**Blocks schema modernization?** No — pure application-code change, independent of branch 1.

**Owning branch/phase.** Its own small PR (e.g. `feature/duplicate-candidate-audit-trail`), sequenced before `feature/provider-adapter-layer` so `DiscoveredAccount`'s eventual dedup-on-import logic is built against the corrected behavior, not the dead-table assumption.

---

### D2 — `AccountConnection`: evolve into `Connection`, or replace

*Special-attention item 2. Freeze doc §18.5.*

**Current state.** `AccountConnection` already generalizes the link between a credential and a `FinancialAccount` today: one row per `(account, source)`, an `isCanonical` flag for the authoritative balance source, and support for multiple connections to one account (e.g. two spouses both holding Plaid access to a joint account). The freeze doc's proposed `Connection` model (§9.1) generalizes a different axis — the credential itself, one row per institution login, replacing `PlaidItem`. §18.5 calls these complementary, not duplicative, but does not settle how `AccountConnection`'s `plaidItemDbId` FK gets retargeted.

**Risk if unresolved.** Without an explicit decision, `feature/provider-adapter-layer` risks either two parallel, overlapping "connection" concepts with no stated relationship, or an undocumented assumption baked in by whoever writes that branch that the next engineer doesn't share.

**Options.**
- **A.** Evolve in place — add a nullable `connectionId` FK to `AccountConnection` pointing at the new `Connection` table, dual-write alongside the existing `plaidItemDbId` FK, drop `plaidItemDbId` once `PlaidItem` retires. `AccountConnection`'s name, shape, and role stay exactly as they are.
- **B.** Replace `AccountConnection` entirely — merge its responsibilities into `Connection` directly (e.g. `Connection` gains `financialAccountId` and `isCanonical`).
- **C.** Leave `AccountConnection` untouched permanently; `Connection` stays purely a credential-layer concept with no direct link to it.

**Recommendation: A.** `AccountConnection` already correctly models "an account can have multiple connections, one canonical" — a working invariant that option B would have to rebuild inside `Connection` from scratch. Merging also conflates two genuinely different cardinalities: one credential per institution login vs. potentially many account-links per credential. Option C reproduces exactly the dual-model ambiguity in the risk above. A is the minimal, additive change consistent with §15's "additive before subtractive" rule.

**Blocks schema modernization?** No.

**Owning branch/phase.** `feature/provider-adapter-layer` (branch 3) — its design doc should state explicitly: "`AccountConnection.connectionId` added, dual-write, `plaidItemDbId` retained until `PlaidItem` retires."

---

### D3 — `WorkspaceAccountShare`→`SpaceAccountLink`: same branch as schema modernization, or later

*Special-attention item 3. Freeze doc §8, §16.*

**Current state.** §16 already sequences `SpaceAccountLink` as its own branch (4, `feature/space-account-link-migration`), after `feature/schema-modernization` (1) and `feature/provider-adapter-layer` (3) — not bundled into branch 1.

**Risk if unresolved (i.e., if bundled into branch 1 anyway).** The review doc's "don't run three dual-model migrations at once" guidance was specifically about not running `Account`→`FinancialAccount`, `PlaidItem`→`Connection`, and `WorkspaceAccountShare`→`SpaceAccountLink` simultaneously. Folding `SpaceAccountLink` into branch 1 would put two unrelated, both-substantial migrations in the one branch every later branch depends on being clean, doubling its review surface and rollback complexity.

**Options.**
- **A.** Keep separate, as currently sequenced (branch 1 = schema-modernization only; branch 4 = `SpaceAccountLink`, later).
- **B.** Bundle into branch 1, on the theory that both touch "how accounts relate to their owner" and benefit from one combined review.
- **C.** Move `SpaceAccountLink` earlier than branch 4 — second, immediately after schema modernization, before `provider-catalog`/`provider-adapter-layer`.

**Recommendation: A, with a sequencing refinement worth flagging separately.** A is correct for the reason in the risk section — don't combine two independent, substantial migrations into one branch for convenience. But §9.1 already states `DiscoveredAccount` staging "needs to know which Space a newly imported account defaults into," which depends on `SpaceAccountLink` — yet §16's current order runs `provider-catalog` (2) and `provider-adapter-layer` (3) *before* `space-account-link-migration` (4). That means branch 3's staging work would be built against the old `WorkspaceAccountShare`/`ownerSpaceId` model and need re-pointing once branch 4 lands. Recommend amending §16 to swap branches 3 and 4 — `SpaceAccountLink` before the provider adapter layer — while keeping branch 1 untouched and separate either way.

**Blocks schema modernization?** No. `SpaceAccountLink` operates on `FinancialAccount`-side ownership fields that already exist regardless of whether branch 1's `Holding`→`FinancialAccount` FK migration has completed; there is no hard technical dependency in either direction between branch 1 and branch 4. The "don't combine them" guidance is about review load and rollback blast radius, not a technical blocker.

**Owning branch/phase.** Branch 4 (`feature/space-account-link-migration`) as named in §16, with the 3-vs-4 re-sequencing flagged above for confirmation alongside this decision.

---

### D4 — AI Context Builder: enforcement mechanism + `agentScope` shape

*Special-attention item 4. Freeze doc §12, §9.5.*

**Current state.** The access *rules* are already settled and binding per §12: AI never queries the DB directly, scope is owned-or-linked accounts only, secrets are categorically excluded, every build is audited. What is **not** settled: §12 point 5 only "recommend[s] a lint rule" — a recommendation, not a committed design — and §9.5 leaves `AiAgent.agentScope`'s shape explicitly open ("JSON or a small enum set").

**Risk if unresolved.** If `lib/ai/context-builder.ts` is built without a concrete enforcement mechanism decided in advance, "only this module may decrypt + call an LLM" becomes a convention enforced by code-review discipline alone — exactly the kind of soft rule that erodes a few PRs after its original author stops reviewing every change. §18.3 confirms there is currently zero `AiAdvice` generation code to retrofit, which makes this the one place in the whole document where getting it wrong costs nothing today and a lot once real advice has shipped from improperly-scoped context.

**Options.**
- **A.** Lint rule only — blocks co-import of `lib/plaid/encryption` and any LLM SDK outside `context-builder.ts`. Cheap, CI-time only; a disabled lint rule defeats it.
- **B.** Runtime guard only — `context-builder.ts` is the sole caller of a gated decrypt function, enforced in production.
- **C.** Both — lint rule for fast developer feedback, runtime guard as the actual security boundary.

**Recommendation: C.** §12 already leans this direction ("not just a convention") without committing. Given financial PII is the asset and there is no existing code to migrate (zero cost to get this right from the start), the marginal cost of a runtime guard alongside the lint rule is low, and the downside of skipping it — a future PR silently bypassing a disabled lint rule — is exactly the failure mode this contract exists to prevent. For `agentScope`, recommend a small fixed enum array (e.g. `OWN_ACCOUNTS`, `LINKED_SPACE_ACCOUNTS`) over freeform JSON, since an enum can be statically validated by the same lint/runtime checks without first being parsed.

**Blocks schema modernization?** No.

**Owning branch/phase.** `feature/ai-context-builder` (branch 6) — its design doc should commit to option C and the enum-shaped `agentScope` explicitly before implementation starts.

---

### D5 — Job scheduler: entrypoint + missing jobs

*Special-attention item 5. Freeze doc §18.2, §19.8.*

**Current state.** Two layers of gap, confirmed: `startScheduler()` is never invoked anywhere (no `instrumentation.ts` hook), and even if it were, only `purgeTrash` and `syncBanks` are wired up — `take-snapshot` and `run-ai-advice` are named in the file's own header comment but have no implementation files at all.

**Risk if unresolved.** Two distinct risks ride on this. First, `syncBanks` never runs on its documented 4-hour cadence in production until the entrypoint is wired — a real product gap today, independent of any Phase 2 work. Second, §10's deferred internal-ops metrics and §12's eventual `AiAdvice` generation both implicitly assume a working scheduled-job entrypoint exists by the time they're built; left unstated, this becomes a silent blocker discovered late, during whichever branch first tries to schedule a job.

**Options.**
- **A.** Fix the entrypoint now, inside `feature/schema-modernization` — lowest-risk branch, convenient place for overdue-but-unrelated infra work.
- **B.** Fix it later, scoped as a prerequisite of whichever branch first needs `run-ai-advice` on a schedule.
- **C.** Treat it as wholly separate infrastructure work, tracked outside the six-branch sequence entirely, with no dependency relationship to any of them.

**Recommendation: C, with one caveat.** The entrypoint gap and the missing production sync cadence predate and are unrelated to the Spaces/Connection/Marketplace work this freeze doc governs — fixing it doesn't unblock, and isn't blocked by, any of the six branches, with one exception: whichever future branch eventually builds `run-ai-advice` as a real scheduled job (not currently scoped anywhere — `feature/ai-context-builder` only builds the context-builder module, not an advice-generation job that consumes it). Recommend fixing the entrypoint as its own small, independent PR soon, given it's already overdue per the file's own comment, but not gating any Phase 2 branch on it.

**Blocks schema modernization?** No.

**Owning branch/phase.** Independent infrastructure fix, outside the six-branch sequence — flag to product/eng as "should happen soon, unrelated to the Phase 2 timeline."

---

### D6 — `ProviderCatalog` field set reconciliation

*Freeze doc §14, §19.2.*

**Current state.** Two near-identical field lists (governing instruction vs. review doc) disagree on three points: `supportsHoldings` vs. `supportsCrypto`, `isFeatured` (governing instruction only), and `lastHealthCheck` timestamp vs. `reliabilityStatus` enum.

**Risk if unresolved.** `feature/provider-catalog` cannot start implementation against an ambiguous spec without risking the same kind of "schema says one thing, build assumes another" problem already found and flagged for `DuplicateAccountCandidate` (D1) — except here it's preventable before any code exists, which is the cheap moment to resolve it.

**Options.**
- **A.** Adopt the governing-instruction list as-is.
- **B.** Adopt the review-doc list as-is.
- **C.** Merge both — separate `supportsHoldings` and `supportsCrypto` flags, both `lastHealthCheck` (raw timestamp) and `reliabilityStatus` (derived enum computed from health-check history), and include `isFeatured`.

**Recommendation: C.** §14 already leans this way ("likely both are needed" for each disputed pair). Merging captures real product value from both lists at the cost of a few extra columns — trivially additive, no architectural downside.

**Blocks schema modernization?** No.

**Owning branch/phase.** `feature/provider-catalog` (branch 2).

---

### D7 — `ProviderCatalog` ownership + admin UI

*Special-attention item 6. Freeze doc §14.*

**Current state.** §14 commits to the data-ownership rule — platform-owned, mutations require internal admin permissions, gated the same way `PlatformSetting` already is — but does not commit to how catalog edits actually happen on day one. No Admin Console, Platform Operations surface, or Institution Health UI exists yet anywhere in the codebase.

**Risk if unresolved.** `feature/provider-catalog` could ship a table with no write path at all — the catalog stays empty or requires direct DB access to seed/edit, defeating the purpose of building it — or, worse, someone bolts on an ad hoc unguarded mutation endpoint "just for now," repeating the same kind of missing-permission-gate gap §4 already flags for Space creation, on a new table.

**Options.**
- **A.** Ship with no admin UI at all — seed via a one-off script only; editable solely through future Admin Console work. Catalog is effectively static until that lands.
- **B.** Ship a minimal internal-only admin route (e.g. `/admin/provider-catalog`) gated by the existing `SYSTEM_ADMIN` role-check pattern already used for `/admin/security`'s `PlatformSetting` management, as part of `feature/provider-catalog` itself.
- **C.** Defer the entire `ProviderCatalog` table until Admin Console work is scoped, so the table and its only access path ship together.

**Recommendation: B.** The existing `SYSTEM_ADMIN` + `/admin/security` precedent for `PlatformSetting` is a direct, already-proven pattern to copy. A small parallel admin route is low-risk and avoids both A's "table nobody can edit" dead end and C's unnecessary delay of useful catalog work behind a much larger, unscoped Admin Console initiative.

**Blocks schema modernization?** No.

**Owning branch/phase.** `feature/provider-catalog` (branch 2) — recommend explicitly scoping "a minimal `SYSTEM_ADMIN`-gated CRUD route" into that branch's deliverables rather than leaving it implicit.

---

### D8 — Archive/delete lifecycle consistency for new tables

*Special-attention item 7. Freeze doc §11.*

**Current state.** §11 establishes four lifecycle categories (Canonical/Published/Derived/Event-Audit) and cites existing patterns — `Space`/`SpaceGoal`'s archive+trash+7-day-purge pattern, `FinancialAccount`/`Account`'s soft-delete-only pattern, `AuditLog`'s `SetNull` retention. None of §9's schema sketches (`Connection`, `SpaceAccountLink`, `PublishedAccountView`, `DiscoveredAccount`, the four connection-detail tables, the Marketplace tables) show a `deletedAt`/`archivedAt` field at all — none have a stated deletion policy yet.

**Risk if unresolved.** Each new table risks inventing its own deletion semantics independently during implementation — one engineer adds `deletedAt`, another hard-deletes, a third copies `Space`'s full archive+trash+purge pattern unnecessarily — recreating, per-table, the inconsistency that `purgeTrash` already had to be written once to handle uniformly for goals/Spaces.

**Options.**
- **A.** Mandate `deletedAt` soft-delete on every new Canonical-category table (`Connection`, `DiscoveredAccount`, `SpaceAccountLink`), matching `FinancialAccount`; reserve a full archive tier only for tables with a clear "hide without losing, restore later" UX need.
- **B.** Mandate the fuller archive+trash+purge pattern uniformly on every new table, regardless of whether its UX calls for it.
- **C.** No blanket rule — decide per-table, with each branch's design doc justifying its own choice.

**Recommendation: A, with B reserved for tables that have an actual undo requirement.** `Connection` and `SpaceAccountLink` both look like `FinancialAccount`-style soft-delete cases — revoking a connection or a Space-account link is naturally reversed by reconnecting/re-linking, not by an "unarchive" action — and the review doc's own lifecycle tagging (§7.1, cited in §11) does not apply an archive tag to either. `PublishedAccountView` already has its own `ACTIVE`/`REVOKED` status enum proposed in §9.3, which is functionally equivalent to soft-delete with naming specific to its revocation semantics — keep that as-is rather than forcing a redundant `deletedAt` onto it too. C is rejected because it's the status quo that created this gap.

**Blocks schema modernization?** No.

**Owning branch/phase.** Cross-cutting — recommend stating this rule once, either in branch 1's design doc or as a short addendum to the freeze doc itself, rather than re-deciding it independently inside branches 2–6.

---

### D9 — `SpaceTemplate` & minimal marketplace foundation

*Special-attention item 8. Freeze doc §9.4, §16, §19.9.*

**Current state.** §9.4 sketches all five Marketplace-v1 tables (`CreatorProfile`, `Framework`, `FrameworkInstall`, `Follow`, `SpaceTemplate`) together. §16 declines to assign Marketplace its own branch number, deferring that until "a concrete Marketplace feature is being built." §19.9 leaves timing fully open.

**Risk if unresolved.** Two opposite failure modes are both plausible without a decision. Scoping all five tables too early repeats — at the whole-feature level — the exact "premature table" mistake the review doc already declined to make for `SpaceRating`/`CreatorPayout` (no creator/install-volume signal exists yet to justify any of the four creator-economy tables). Conversely, never defining even a minimal foundation means the first time a "Family Space template" is needed, there's no data-driven format to extend — and this project's own standing Spaces-redesign instructions explicitly require the new Spaces UI to let "future templates fit naturally into this system," a requirement `SpaceTemplate` was designed to satisfy.

**Options.**
- **A.** No Marketplace work in Phase 2 at all, not even `SpaceTemplate` — fully deferred until a creator/install feature is greenlit.
- **B.** Build `SpaceTemplate` alone, early and small, decoupled from the other four tables — seed it with Fourth Meridian's own built-in category presets (replacing `lib/space-presets.ts`'s hardcoded mapping with data-driven rows), with no `Framework`/`CreatorProfile`/marketplace UI attached.
- **C.** Build all five v1 tables together as scoped in §9.4, on the theory that they're cheap and additive.

**Recommendation: B.** It directly serves a concrete, already-stated near-term need (the Spaces-redesign instructions' template-scalability requirement) without speculatively building four creator-economy tables that have no near-term feature attached. A under-serves that stated need; C repeats the premature-table pattern the review doc twice declined to make elsewhere, now at a larger scope.

**Blocks schema modernization?** No.

**Owning branch/phase.** New, named branch — `feature/space-template-foundation`, scoped to `SpaceTemplate` only, sequenced independently of the six branches in §16 (no dependency either direction), explicitly separated from a future `feature/marketplace-v1` branch that would add the other four tables once a creator feature is actually greenlit.

---

### D10 — What must remain deferred

*Special-attention item 9. Freeze doc §10, §19.5.*

**Current state.** §10 lists explicit deferrals (`CreatorPayout`, billing/subscription tables, messaging tables, support tickets, a full notification system unless required) plus deferred-by-omission items not named in the governing instruction's §9 list: `MerchantSpendingSummary`, `SpaceCollection`/`SpaceCollectionItem`, and the Platform-Ops metrics tables (`PlatformDataSource`, `PlatformMetricDefinition`, `PlatformMetricSnapshot`) plus internal-ops gating.

**Risk if unresolved.** The deferred-by-omission items are the real risk, not the explicit deferrals (already clearly settled). An omitted item can be silently built by accident during a later branch if nobody re-confirms it's still out of scope — e.g. someone implementing `feature/provider-adapter-layer` might reasonably assume `MerchantSpendingSummary` belongs there since it's adjacent to transaction data, when no branch in §16 actually owns it.

**Options.**
- **A.** Formally ratify the full deferred list (explicit and by-omission) as out of scope for all six §16 branches, with a stated re-review trigger ("re-open if a concrete feature requires it").
- **B.** Pull one or more deferred-by-omission items forward now, on the theory that some are cheap enough to build speculatively.
- **C.** Leave the list exactly as ambiguous as it currently is; let each branch's implementer decide in the moment.

**Recommendation: A.** None of the deferred-by-omission items have a concrete feature attached yet — no billing integration for `CreatorPayout`, no Stripe/AWS integration for Platform-Ops metrics, no nested/grouped-Space UI requirement stated anywhere in current product instructions for `SpaceCollection`. B would repeat the premature-table pattern the review doc already rejected twice; "cheap" was never its bar, a concrete feature was. C is rejected for the reason it's rejected throughout this document: ambiguity left to individual implementers is how scope creep happens one branch at a time.

**Blocks schema modernization?** No.

**Owning branch/phase.** No branch — explicitly out of scope for the entire six-branch sequence, re-reviewed only if a concrete feature is proposed that needs one of these.

---

### D11 — `FinancialAccount`/`Connection.createdByUserId`

*Freeze doc §4, §19.3.*

**Current state.** Confirmed gap: `SPACE`-owned accounts have no required human-accountable party independent of `ownerUserId`/`ownerSpaceId`, which are null/non-null by visibility, not accountability.

**Risk if unresolved.** A support, audit, or billing-lineage gap for business-owned accounts — if a dispute or audit ever needs "who connected this account on behalf of the business," there is no required field that answers it; only the nullable `ownerUserId`, which is null exactly when it would be needed.

**Options.**
- **A.** Add now, in `feature/schema-modernization` — additive, backfillable from `ownerUserId` where present.
- **B.** Add later, bundled into `feature/provider-adapter-layer`'s `Connection` model only — new rows get it, old `FinancialAccount` rows don't.
- **C.** Don't add it; rely on `AuditLog`'s existing connect-action trail instead.

**Recommendation: A.** Already characterized in §16 as low-priority, low-risk, and purely additive — no reason to leave a known gap open through several more branches when it can be folded into the branch already touching `FinancialAccount`-adjacent cleanup at no extra cost.

**Blocks schema modernization?** No — doesn't block branch 1, but is a natural, low-cost addition to bundle into it (as §16 already proposes).

**Owning branch/phase.** `feature/schema-modernization` (branch 1).

---

### D12 — Internal-ops Spaces / `isInternal` flag

*Freeze doc §4, §10, §19.4.*

**Current state.** No `SYSTEM_ADMIN` gate exists on Space creation by category; no `isInternal` flag or internal-ops `SpaceCategory` value exists. Any authenticated user can create a Space of any category today.

**Risk if unresolved.** Low and theoretical until an actual internal-ops Space feature (Platform Operations dashboards, §10) is built — at that point, without this gate, an internal Stripe/AWS dashboard Space would be reachable through the exact same Space-switcher path any customer uses. Today the risk is moot because no internal-ops Space content exists yet.

**Options.**
- **A.** Add the gate now, speculatively, ahead of any internal-ops feature.
- **B.** Add it only when the first internal-ops feature is actually scoped, as that feature's own prerequisite.
- **C.** Skip the dedicated flag/category; build a separate, fully non-Space internal admin surface for ops dashboards instead.

**Recommendation: B.** Matches the review doc's own "low priority / later" assessment and this document's consistent stance elsewhere (D9, D10): don't build ahead of a concrete feature. The cost of adding the gate later is low (one additive enum value plus one role check); the risk during the gap is zero because nothing exists yet to exploit the missing gate.

**Blocks schema modernization?** No.

**Owning branch/phase.** Not scoped to any of the six branches — becomes a prerequisite task attached to whichever future branch first builds an internal-ops Space feature.

---

### D13 — `Connection.credential` nullability

*Freeze doc §19.6.*

**Current state.** Open: a uniform encrypted blob (possibly empty) for every provider, vs. a genuinely nullable field. §9.1's current sketch already shows `credential String?`.

**Risk if unresolved.** Affects how generic `Connection` can stay (§13's binding rule). Getting it wrong means either every CSV/manual/wallet connection carries a meaningless "encrypted nothing" placeholder — confusing, and a false signal that something is encrypted when nothing is — or downstream code has to null-check `credential` everywhere it's read, which is more error-prone than modeling the real-world absence directly.

**Options.**
- **A.** Genuinely nullable (`credential String?`), as already sketched.
- **B.** Uniform non-null encrypted blob, even for providers with nothing to encrypt.
- **C.** Move `credential` off `Connection` onto a separate 1:1 detail table that only exists for credentialed providers.

**Recommendation: A.** The most honest representation of reality — CSV/manual/wallet genuinely have no credential — and it's already the freeze doc's own sketch. B manufactures fake ciphertext for no security benefit and risks a future reader mistaking the dummy value for a real secret. C is over-engineered for what's a one-column distinction.

**Blocks schema modernization?** No.

**Owning branch/phase.** `feature/provider-adapter-layer` (branch 3) — confirm A explicitly in that branch's design doc before implementation.

---

### D14 — Shared `ENCRYPTION_KEY` blast radius

*Freeze doc §7, §19.7.*

**Current state.** Confirmed real and live: `PlaidItem.encryptedToken`, `User.totpSecret`, and `User.dateOfBirthEncrypted` all share one root key today. Rotating it for any one purpose currently invalidates all three.

**Risk if unresolved.** The blast radius grows with every new secret added to the same pool. `Connection.credential` (§9.1) is about to become a fourth secret sharing the same key — and if any future secret (a Marketplace creator-payout credential, or anything else) reuses `lib/plaid/encryption.ts` without revisiting this, the radius keeps growing silently. The encryption itself (AES-256-GCM) is not weak; the risk is the cross-system coupling — "rotate the Plaid key" as an incident-response action would unexpectedly also break TOTP and DOB decryption for every user, turning a contained incident into a much larger one.

**Options.**
- **A.** Per-purpose key derivation now (HKDF from one root key, distinct subkeys per purpose), before `Connection.credential` is added — so the new secret starts isolated from day one.
- **B.** Accurate documentation only — leave the shared key as-is, but update `.env.example` and the encryption module's comments to state the real blast radius explicitly.
- **C.** Defer entirely; revisit only if/when a key rotation is actually being planned in production.

**Recommendation: A, sequenced before `feature/provider-adapter-layer` lands `Connection.credential`.** Not because the existing three fields are at elevated risk today, but because it's meaningfully cheaper to add HKDF derivation once, before a fourth secret joins the pool, than to retrofit it across four call sites later. If timeline pressure rules that out, B is the acceptable fallback — matches §7's own "either fix it or document the blast radius accurately" framing — but C is not recommended given `Connection.credential`'s imminent arrival in branch 3 makes this no longer a hypothetical-future problem.

**Blocks schema modernization?** No — orthogonal to branch 1 entirely.

**Owning branch/phase.** A small, standalone `feature/encryption-key-derivation` branch, sequenced before `feature/provider-adapter-layer` (branch 3), independent of branches 1–2.

---

## 3. Net effect on §16 sequencing

None of the fourteen decisions above block `feature/schema-modernization` (branch 1) from opening once D11 is confirmed. Their cumulative effect on the rest of §16's sequencing, if all recommendations are accepted:

- **Branch 1** (`feature/schema-modernization`) gains one confirmed scope item (D11, `createdByUserId`) — already proposed there in §16, now affirmed rather than added.
- **Branch 2** (`feature/provider-catalog`) gains two confirmed scope items: the merged field set (D6) and a minimal `SYSTEM_ADMIN`-gated admin route (D7) — neither changes the branch's dependency position, both narrow what "done" means for it.
- **A new branch, `feature/encryption-key-derivation` (D14)**, is recommended to land before branch 3, independent of branches 1–2.
- **Branch 3** (`feature/provider-adapter-layer`) gains two confirmed design points already implicit in §9.1/§18.5 but now explicit: `AccountConnection` evolves via an additive `connectionId` FK rather than being replaced (D2), and `Connection.credential` is genuinely nullable (D13).
- **Branches 3 and 4 are recommended to swap order** (D3) — `feature/space-account-link-migration` before `feature/provider-adapter-layer` — so `DiscoveredAccount` staging is built against the consolidated Space/account link model instead of the legacy one it would otherwise need to re-point later.
- **A new branch, `feature/space-template-foundation` (D9)**, is recommended as a small, independently-sequenced addition — not part of the original six, not blocking or blocked by any of them, and explicitly separate from a future `feature/marketplace-v1` that would cover the other four Marketplace tables once warranted.
- **Branch 6** (`feature/ai-context-builder`) gains one confirmed design commitment: enforcement is lint rule **and** runtime guard (D4), not lint rule alone.
- **D1, D5, D8, D10, D12** resolve to small independent PRs, a cross-cutting rule statement, or explicit non-scope — none change §16's branch list or dependencies.

Recommended revised order: `schema-modernization` → `encryption-key-derivation` → `provider-catalog` → `space-account-link-migration` → `provider-adapter-layer` → `published-account-view` → `ai-context-builder`, with `space-template-foundation` and the standalone `duplicate-candidate-audit-trail` / scheduler-entrypoint PRs running in parallel wherever convenient, since none of the three carry a dependency on the main sequence.

---

## 4. Sign-off & next steps

This document makes no code changes. Per the governing instruction, work stops here.

Recommended next step: product/eng review and accept, amend, or reject each of the 14 recommendations above (in particular the two sequencing changes — D3's branch 3/4 swap and D14's new pre-branch-3 branch — since those affect §16's plan, not just an individual decision). Once resolved, `feature/schema-modernization` can open with D11 already confirmed as in scope.
