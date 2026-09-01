# STATUS.md drift audit — 2026-08-20

**Scope:** `git log` @ `1c6b8a9` (HEAD, `v2.6`) vs STATUS.md as committed at `9ea50a5` / merge `a0c187d` (2026-08-17/18).
**Verdict: material drift found — 6 items.** STATUS.md's "Recently landed" stops at REVIEW-3; **13 commits have landed since**, including a schema migration, and none are mentioned. Report only — no files edited.

Keyword check against STATUS.md (all zero hits): `W1`, `INV-19`, `DEBT-1`, `KD-15`, `FAMILY`, `HOUSEHOLD`, `TransactionEvent`, `event identity`, `linkBasis`, `db:drift`.

---

## 1. W1 Transaction Identity wave — shipped, unmentioned (TI2-class)

The exact pattern the 2026-07-13 TI2 discovery was about: 6 commits + a real schema migration, zero STATUS text.

- `8b7c4fd` fix(identity): event identity authoritative at read surfaces — `duplicate` → `similarity`, DF-4 raw-descriptor key, "Possible duplicate" copy retired
- `afdcb65` fix(identity): EVENT-2 guard generalized to provider-ref comparison; CSV ambiguity key aligned to DF-4
- `f59853d` feat(identity): **migration `20260818_w1_observation_link_evidence`** — `TransactionObservation.linkBasis` / `linkRefusal`; replay healing of dangling splits
- `7f8493b` test(identity): new REQUIRED audit `scripts/audit-read-identity-consumers.ts` (INV-19) — **REQUIRED tier 18 → 19**
- Also `c18840d` fix(events): projection integrity + fingerprint adoption (`event-write.ts`, `event-projection.ts`, new repair script)
- Untracked completion doc exists: `_to_delete/W1-EXECUTION-REPORT.md` (44 files, +2,017/−139)

> **Suggested correction:** add a "Recently landed" clause — *W1 Transaction Identity completion (`ce360b8..1c6b8a9`): TransactionEvent is the sole read-side identity authority (INV-19), link basis/refusal persisted (migration `20260818_w1_observation_link_evidence`), dangling splits heal on replay; REQUIRED audit tier 18 → 19.* Note the migration as riding the pending deploy train.

## 2. FAMILY / shared-space security riders — shipped, unmentioned

`b449513` closes three real security gaps: invite-role OWNER-minting (any `SpaceMemberRole` persisted via `role as never`), public-Space roster leaking member **emails** to non-members, and an un-tiered snapshot population read (now throws on non-disclosing tier). `1c6b8a9` retires HOUSEHOLD as a concept — FAMILY is canonical.

> **Suggested correction:** add these to "Recently landed", and add the one deliberate residue to a ledger line: *`SpaceCategory.HOUSEHOLD` remains in the Prisma enum pending the enum-retirement program (Postgres cannot DROP an enum value in place).* Right now that pending item exists only in a commit message.

## 3. DEBT-1 semantic convergence — shipped, unmentioned

`32294cf` adds `lib/debt/aggregates.ts` (+ tests) and a 611-line record at `docs/plans/v2.6-DEBT-1-SEMANTIC-CONVERGENCE.md`. STATUS only knows the older V25-SIDE-1 `lib/debt/balance-semantics.ts` authority. The doc states it closes the unfinished remainder of ROADMAP item 1 — which STATUS lists as the **active initiative**.

> **Suggested correction:** record DEBT-1 under "Recently landed" and reflect that ROADMAP item 1 (Semantic Authority Convergence) is now closed for the debt aggregates.

## 4. Ops observability restore — shipped, unmentioned

`ce360b8` adds `captureLedgerWriteFailure` (write-dead ledgers now report themselves — born of the 2026-07-26 ten-hour silent `P2022` incident) and `check-schema-drift` / `npm run db:drift` as the pre-deploy half, registered OPERATIONAL.

> **Suggested correction:** one line under "Recently landed"; consider referencing `npm run db:drift` in the production-readiness / deploy blockers, since it directly mitigates a blocker-class failure that already happened once.

## 5. KD-15 — code says shipped, doc says "awaiting approval" (inverse drift)

`docs/initiatives/kd15/KD-15_IMPLEMENTATION_CHECKLIST.md` (added 2026-08-18 via `d8aba09`) is headed **"Checklist only — awaiting approval. No … route, UI, or application code changes."** But `TRANSACTION_DETAIL_VISIBILITY` is enforced across the UI read paths today: `lib/transactions/detail-query.ts:82`, `transfer-resolution.ts:167`, `lib/accounts/space-account-link.ts:122`, `lib/transactions/counterparty-visibility.ts` (which cites "the KD-15 predicate" by name). KD-15 appears in no STATUS ledger — neither open nor closed.

> **Suggested correction:** verify, then either mark KD-15 closed in the "Closed since last reconciliation" block with the enforcing call sites as evidence, or state precisely which read path remains unfixed. Do not leave it invisible.

## 6. Migration count stale

STATUS line 7 cites "88 migrations, 0 failed" as production-verified. The repo now carries **101** migration directories; `ce360b8` reports 99/99 in step locally as of 2026-08-18.

> **Suggested correction:** either date-stamp the 88 figure as the v2.5.0 production verification (which it was) or refresh it — as written it reads as current state.

---

## Checked, no drift

- Beta blockers 1 (LLM disclosure), 4 (published support address), 9 (Turnstile) — all still genuinely open; `content/marketing/legal-ai.md` still names no provider/retention and still carries the contradicted "not a chat window" line; zero `support@` occurrences in `app/`, `components/`, `content/`.
- KD-14 (`AiAdvice` no production write path) — confirmed still open; `app/api/brief/route.ts:428` says the branch "never fires TODAY".
- KD-8 / KD-12 / KD-16 — no shipped work found beyond the partial closures STATUS already records.

## Note, not drift

`_to_delete/TSWAVE-REPORT.md` describes a test-suite cleanup wave (`c00a912`, `50be184`, `d86b431`, −963 LOC) delivered as a **bundle that has not been pulled** — those commits are absent from HEAD. Correctly unmentioned in STATUS; flagging only so it isn't mistaken for shipped work later. `_to_delete/` is entirely untracked.
