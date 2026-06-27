# D2 Step 2 — WALLET Dual-write Identities — Investigation

Status: **read-only investigation. No code, schema, or migration changes made.**

**Addendum:** the collision-handling framing in §C ("is wallet identity global or
owner-scoped — they disagree, pick one") turned out to be a false binary. The corrected model
(see `D2_STEP1D_PROVIDER_ACCOUNT_IDENTITY_MULTI_ACCOUNT_CORRECTION.md`) is: the wallet address
*value* is globally recognized, but each `FinancialAccount`'s association with it stays private
and unshared. That correction also found a real schema conflict in `ProviderAccountIdentity`'s
unique constraint, not identified here. The rest of this report (definitions, write-site
inventory, MANUAL/CSV exclusions) still holds.

Scope note on naming: the roadmap (`docs/initiatives/d2/D2_ROADMAP.md`) lists this as the unlettered "WALLET dual-write" row under Step 2, distinct from the lettered "2A" (PLAID). This report keeps that unlettered framing rather than inventing a "2B" designation the roadmap doesn't use — that's a roadmap-maintenance call, not this report's to make.

Context confirmed before writing this report (re-read fresh, not assumed from prior reports):
- `docs/initiatives/d2/D2_ROADMAP.md` — Step 2 is **🔶 in progress, PLAID only**. PLAID (2A) is ✅ shipped and validated. The WALLET row is explicitly **⛔ blocked** on the same identity-semantics question as Step 1C-C. This is the only open item left in Step 2.
- `docs/initiatives/d2/D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` and `..._IMPLEMENTATION.md` — re-read in full.
- `lib/accounts/provider-identity.ts` and `app/api/plaid/exchange-token/route.ts` — re-read directly. The implementation matches both 2A docs exactly: one helper, one call site (after the exact-match/fingerprint-repoint/create branches converge on `fa`), `connectionId` always `null`. Nothing has drifted since 2A shipped.
- `docs/initiatives/d2/D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` — re-read in full.
- `app/api/accounts/wallet/route.ts` and `lib/accounts/reconcile.ts` — re-read directly against 1C-C's findings. **Unchanged.** Duplicate detection is still owner-scoped (`{ ownerUserId, walletAddress }`) in both files; `walletAddress` still has no DB-level uniqueness; no ownership/signature verification exists. 1C-C's findings still hold — confirmed, not assumed.
- Repo-wide grep confirms: no `D2_STEP2B_*` or `*WALLET_DUAL_WRITE*` doc existed before this one. No WALLET branch exists in `scripts/backfill-provider-account-identity.ts` or `scripts/verify-provider-account-identity-backfill.ts`. `ProviderType` (`prisma/schema.prisma`) has six members (`PLAID, MANUAL, WALLET, CSV, EXCHANGE, BROKERAGE`); only `PLAID` has any application wiring to `Connection`/`ProviderAccountIdentity` today.
- `docs/initiatives/d2/D2_STEP4_CLOSURE_REVIEW.md` confirms CSV import (now-closed Step 4) never creates a `FinancialAccount` and was never wired to `ProviderType`/identity — that gap is explicitly assigned to Step 5/6 or Provider Catalog, not Step 2.

---

## A. What "Dual-write identities" means here — a framing mismatch worth naming

Two different definitions exist in the docs, and they describe different operations:

1. **Architecture doc framing** (`docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` §10, Phase 3): dual-write = the *first new provider adapter* (Coinbase/Kraken/xpub — still unselected) writes `Connection` + `AccountConnection.connectionId` + `ProviderAccountIdentity` for the first time. "Existing Plaid/manual/wallet paths are not modified in this phase."
2. **What actually shipped as 2A, and what the roadmap now means:** dual-write = an *existing* provider's existing write path (PLAID's `exchange-token/route.ts`) mirrors every `plaidAccountId` create/reassignment into `ProviderAccountIdentity`, **in addition to** the legacy column — preparing for a later read cutover. No new adapter, no new provider. Confirmed exactly this by re-reading the shipped code.

These aren't the same operation. The roadmap document explicitly states it supersedes the architecture doc's *sequencing* (not its design rationale), and 2A's actual implementation followed definition 2, not definition 1. So definition 2 is canon going forward. Flagging this because re-reading the architecture doc in isolation could lead someone to think "Step 2" is about onboarding Coinbase/xpub/etc. — it isn't, and never has been in this codebase. For WALLET, "dual-write" means the same thing it meant for PLAID: make the *existing* wallet-creation path also write `ProviderAccountIdentity`, alongside the legacy `walletAddress` field it already writes.

---

## B. Code paths requiring dual writes

| Provider | Status | Write site(s) |
|---|---|---|
| **PLAID** | ✅ Done (2A) | One file, one call site: `app/api/plaid/exchange-token/route.ts`, after the exact-match/fingerprint-repoint/create branches resolve `fa`. Nothing further needed for PLAID itself. |
| **WALLET** | ⛔ Blocked, not started | One creation route, `app/api/accounts/wallet/route.ts` — three branches, structurally mirroring PLAID's shape: (1) active match → re-share silently, (2) archived match → reactivate, (3) no match → `financialAccount.create`. A second hook point: `mergeArchivedDuplicateIntoCanonical()` in `lib/accounts/reconcile.ts` (shared by the wallet route, the generic restore route, and Plaid's route) — relevant for repointing `ProviderAccountIdentity.financialAccountId` on an archive-into-canonical merge, separate from the create-path hook. |
| **MANUAL** | Not a candidate | `providerIdentityOf()` (`reconcile.ts`) returns `null` when both `plaidAccountId` and `walletAddress` are absent — manual assets have no external account to identify, by definition. `app/api/accounts/manual/route.ts` confirmed never sets either field. Structurally exempt, not deferred. |
| **CSV / EXCHANGE / BROKERAGE** | Not Step 2's concern | Enum members exist (`schema.prisma`) with zero application wiring — no `Connection` writer, no `ProviderAccountIdentity` writer anywhere (repo-wide grep). CSV import (Step 4, closed) never creates a `FinancialAccount` and was deliberately never wired to identity; `ProviderType.QUICKBOOKS`/`EXCEL` and any provider-model wiring are explicitly assigned to Step 5/6 or Provider Catalog by the Step 4 closure review. Noted here only to confirm WALLET work doesn't quietly need to cover these too — it doesn't. |

---

## C. The actual blocker, and whether "begin" is the right verb

WALLET dual-write wasn't deferred for lack of time. 1C-C found a real, confirmed schema/app mismatch: `ProviderAccountIdentity.@@unique([provider, externalAccountId])` is **global**; the app's own duplicate detection (`wallet/route.ts`, `reconcile.ts`) is **owner-scoped**. Two different users adding the identical `walletAddress` today produce two independent, permanently active rows — re-confirmed true by re-reading the current route just now, not assumed from the old report.

If WALLET dual-write were wired today using PLAID's exact pattern (find-by-`{financialAccountId, provider}`, create-if-missing), a second user's identical address would either silently fail to write (unique-constraint violation, caught and swallowed by the helper's try/catch — exactly the failure mode 1C-C predicted for `createMany({skipDuplicates: true})`) or require new collision-handling logic that doesn't exist anywhere in this codebase yet.

1C-C's own recommendation (**Option C**) was explicit: don't backfill WALLET now; wait until "the dual-write phase" to close the gap *at the source* — add real cross-owner collision handling to `wallet/route.ts`'s create path **at the same time** dual-write is added, not as a follow-up. That phase is now. Which means: collision-handling design is in scope for whatever checklist follows this report — it's the precondition the deferral was waiting on, not optional polish.

Two items 1C-C left open are direct **preconditions**, not parallel work:

1. **Is wallet identity global (matches the schema as shipped) or owner-scoped (matches the app as built)?** They disagree today. Dual-write can't proceed correctly into a column whose semantics aren't decided — picking one unilaterally during implementation would be re-litigating an architecture decision mid-build, which runs against the project's standing rule against re-litigating approved decisions without it being flagged as a concrete blocker first. This **is** that flag.
2. **Should real ownership verification (signed-message challenge) be added to `wallet/route.ts` at the same time?** 1C-C raised it, didn't decide it.

Given that, **"Begin D2 Step 2: Dual-write identities" is ambiguous in a specific, checkable way:** per the roadmap, Step 2 is not unstarted — it's 🔶 in progress, with PLAID shipped and live. The only remaining item is the WALLET row, and the roadmap marks it ⛔ blocked, not merely "not started." Treating this as a from-scratch "Step 2 begin" risks either redoing/re-validating already-shipped, already-approved PLAID work, or jumping into WALLET implementation without registering that its blocking decision (global vs. owner-scoped) still hasn't been made.

---

## D. How long should the dual-write period last?

No precedent exists for a *defined* end date. PLAID's dual-write (2A) has no end condition anywhere in the docs — it's designed as a permanent self-healing mirror, not a temporary bridge with a removal date. The thing that *does* have an end condition is the legacy-field **read fallback** added in Step 3, scheduled for removal in Step 7, gated on "zero fallback-hit warnings... over a production observation period" — no specific duration attached even there.

So, based on the only precedent this project has: expect WALLET's dual-write to run **indefinitely**, until some future cleanup step (mirroring Step 7) removes legacy `walletAddress`-based read paths — not a sprint-scoped temporary state. If a fixed sunset is wanted for WALLET specifically, that's a deliberate deviation from the PLAID precedent and should be decided explicitly, not assumed by carryover.

One sequencing detail worth naming: for PLAID, read cutover (Step 3) began immediately after dual-write (2A) shipped, with no soak period between them. If WALLET follows that same compressed cadence, "how long before Step 3 Read Cutover" may functionally mean "as long as it takes to re-run a verification script once" rather than a calendar duration. Worth deciding on purpose, since WALLET carries a real collision risk PLAID never had — `plaidAccountId` is provider-issued and already effectively unique; `walletAddress` is user-typed, unverified, and known (not hypothesized) to collide silently across owners today.

---

## E. Rollback strategy

PLAID's rollback (2A) is clean and narrow: delete the new file, remove the import and one call site, no migration, no behavior change to `FinancialAccount` writes themselves — the dual-write was purely additive alongside existing behavior.

WALLET's rollback is **not symmetric with that**, *if* the collision-handling logic C calls for gets bundled into `wallet/route.ts`'s create path (which 1C-C's own recommendation requires). That logic changes user-facing account-creation behavior (e.g., rejecting or warning on a cross-owner collision that's silently allowed today) — rolling back "the dual-write" would also mean rolling back a behavioral change to account creation, not just removing a mirror-table write. That's a materially bigger, harder-to-isolate revert than PLAID's. Whatever checklist follows should plan for this explicitly — e.g., keep "write `ProviderAccountIdentity`" and "add collision handling" as separately revertible commits — rather than assuming PLAID's rollback plan transfers as-is.

The data-side rollback is unchanged in shape: `DELETE FROM "ProviderAccountIdentity" WHERE provider = 'WALLET';` stays safe and reversible, since nothing reads the table for WALLET yet — Step 3's WALLET read cutover hasn't started and is blocked on this same semantics question.

---

## F. Validating success before Step 3 (WALLET Read Cutover)

PLAID's bar was: `tsc`/lint clean, the existing verify-backfill script re-run clean (no drift), one manual functional check against a live Plaid sandbox. That bar doesn't transfer cleanly, because "no drift" presumes a well-defined invariant — and for WALLET, the invariant itself (global vs. owner-scoped) isn't decided yet.

What "success" needs before WALLET can responsibly move to Step 3:

- **The 1C-C §B collision pre-check query has never actually been run** against a real database. Nobody currently knows whether cross-owner `walletAddress` collisions exist in production today. That's not a detail to discover mid-implementation — a clean result changes the urgency of collision-handling; a dirty result changes the shape of the work entirely (the global unique constraint starts throwing on day one). This is information a checklist should be written *with*, not discovered *during*.
- **A WALLET-specific extension of `scripts/verify-provider-account-identity-backfill.ts`** (the 7 checks 1C-C §E specified) doesn't exist yet and would need to, for any automated signal at all.
- "Success" can't just mean "rows got written" — it has to mean "rows got written under a decided identity model." Validating against an undecided invariant isn't validation; it's just another data point in the same unresolved disagreement.

---

## G. Risks, edge cases, sequencing — summary

- **Precondition, not edge case:** the global-vs-owner-scoped decision blocks correct design, it isn't a detail to handle inside implementation.
- **Unknown real-world collision rate** — the one query that would de-risk this has never been run against live data.
- **No ownership verification today** — any user can claim any address. 1C-C raised whether to fix this alongside dual-write; still undecided. Resolving it silently in either direction during implementation would be a real security/product behavior change made without sign-off.
- **Asymmetric rollback risk** if collision-handling logic ships bundled with the identity-table write (see E) — plan commit boundaries accordingly.
- **`connectionId` stays `null` for WALLET too**, same reasoning as PLAID — not a new gap, just confirming it doesn't get silently "resolved" as a side effect of this work.
- **Framing risk:** treating this as "begin Step 2" rather than "resume the one remaining blocked Step 2 item" risks re-treading PLAID ground that already shipped and was already approved.

---

## Open questions — not guessed at

1. **Scope:** should the next implementation checklist cover WALLET dual-write specifically (the only remaining open Step 2 item per the roadmap), or was something broader intended by "begin Step 2"?
2. **Identity model:** should the global-vs-owner-scoped decision be made explicitly before a checklist is drafted, or folded into the checklist as its first line item?
3. **Collision data:** should the 1C-C pre-check query be run against the real database before a checklist is drafted, so the checklist reflects actual risk rather than a hypothetical — or proceed without that data?
4. **Ownership verification:** bundle a signed-message ownership check into this step, explicitly defer it as a separate future decision, or explicitly reject it for now?

**No implementation performed. No schema, migration, route, UI, or data changes made in this step.**
