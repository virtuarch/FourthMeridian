> **REASSESSMENT ADDENDUM — investigation only.** No code, no schema, no migrations were made to produce this document. The original assessment (`docs/investigations/FINANCIAL_INTELLIGENCE_ARCHITECTURE_INVESTIGATION_2026-07-08.md`) is a point-in-time record per this repo's documentation convention and is **not edited** by this addendum; this document supersedes its §4.3 unpark reasoning without touching it.

# Receipt Intelligence — Unpark-Condition Reassessment

**Date:** 2026-07-13
**Status:** Reassessment complete — verdict only, no implementation.
**Trigger:** On 2026-07-13 it was discovered that the Transaction Intelligence build phase (TI1–TI4) had substantially shipped on 2026-07-07/08 with **zero record in STATUS.md** (the pre-correction ledger row stopped at "Phase 1 Complete (2026-07-06)", pre-correction `STATUS.md:182`). *(While this reassessment was being written, the broader 2026-07-13 STATUS drift-correction pass landed as commits `052f08e`→`c8f5097` (P1–P4, per `FOURTH_MERIDIAN_STATUS_DRIFT_INVESTIGATION_2026-07-13.md`), adding a TI2 ledger row; the companion TI slice-ledger amendment committed alongside this document completes it — slice mapping, TI3 apply-state, TI0/TI2A clarification.)* The original Receipt Intelligence assessment — written 2026-07-08, scoring it **5/10, postpone**, with unpark condition "**TI4 shipped + real user demand**" (`FINANCIAL_INTELLIGENCE_ARCHITECTURE_INVESTIGATION_2026-07-08.md:142–144`, ratings table line 206) — therefore reasoned from a stale baseline. This addendum re-evaluates the unpark condition against the actual shipped state.
**Prior art:** `docs/investigations/FINANCIAL_INTELLIGENCE_ARCHITECTURE_INVESTIGATION_2026-07-08.md` (§4.3, the assessment being reassessed) · `docs/investigations/TRANSACTION_INTELLIGENCE_FACT_LAYER_INVESTIGATION_2026-07-07.md` (TI0–TI5 slice plan §7, lines 197–215; 7A doctrine, lines 219–251) · `FOURTH_MERIDIAN_TI2_BUILDCONTEXT_WIRING_INVESTIGATION_2026-07-13.md` (current TI wiring state) · `FOURTH_MERIDIAN_REPOSITORY_AUDIT_2026-07-12.md` (§5 backfill audit, line 177).
**Sources:** `scripts/backfill-transaction-facts.ts` · `lib/transactions/{transaction-facts,RelationshipResolver,transfer-resolution,flow-predicates}.ts` · `lib/data/transactions.ts` · `prisma/migrations/20260707210625_ti2_transaction_facts/migration.sql` · `STATUS.md` · git history (commit hashes + dates cited inline).

---

## 0. Verdict up front

**Receipt Intelligence remains correctly parked — but the gate has changed shape.** The original unpark condition was two-legged: *TI4 shipped* + *real user demand*. The first leg is now **substantially satisfied** (§2); the second remains **unmet and structurally unmeetable pre-beta** (§3.4). What still genuinely gates a build is: the demand signal (blocked on the OPS-1 S10 beta gate), the `refundCandidate` relational fact (the receipt-relevant returns/refunds leg of TI4, deliberately unbuilt — §3.3), and Receipt Intelligence's own unchanged entry costs (document pipeline, OCR dependency, its own 7A-style PII review, per-receipt cost instrumentation — §3.5). The restated unpark condition is in §4.

---

## 1. What the original assessment said (2026-07-08)

§4.3 scored Receipt Intelligence **5/10, postpone** (`FINANCIAL_INTELLIGENCE_ARCHITECTURE_INVESTIGATION_2026-07-08.md:142–144`): a Tier 1–2 module over a *new* raw substrate (documents), consuming TI (`settlementState`, `paymentMethod`, amount) + MI (merchant identity) for matching; high difficulty (first document pipeline, first OCR dependency, PII surface needing "a 7A-doctrine review of its own", per-receipt processing cost); "high overlap risk if built before TI4"; unpark condition **"TI4 shipped + real user demand."** The fact-layer investigation had likewise deferred receipt-matching fields "with intent" to Receipt Intelligence as a TI consumer (`TRANSACTION_INTELLIGENCE_FACT_LAYER_INVESTIGATION_2026-07-07.md:213`).

At the time of writing, STATUS.md's TI row recorded only "Phase 1 Complete (2026-07-06) … Next milestone: Phase 2 (scope on the platform runway)" (pre-correction `STATUS.md:182`) — so the assessment could not see that TI2 had already landed the night before it was written, and could not anticipate TI4's landing that same day.

## 2. What has actually shipped since that baseline

**TI1 — flow-authority consolidation: done.** `ece6cae` (2026-07-07 22:44 +0300) "refactor(ti): consolidate flow predicates into shared module" — `lib/transactions/flow-predicates.ts` is the ratified single spend-membership authority, confirmed settled and out of scope by the 2026-07-13 wiring investigation (its header's "Out of scope (already settled)" block).

**TI2 — capture-at-write foundation: done, shipped 2026-07-07/08.** Migration `20260707210625_ti2_transaction_facts` (commit `18174d3`, 2026-07-08 00:08 +0300; folder timestamp = 2026-07-07 21:06 UTC) adds the eight nullable TI columns — `paymentChannel`, `paymentMethod`, `settlementState`, `authorizedAt`, `counterpartyType`, `fxApplied`, `pendingTransactionRef`, `tiFactsVersion` (`migration.sql:13–21`) — plus the four enums (lines 1–11). The commit train: `334bcdc` (7A doctrine ratified) → `aee6870` (metadata capture) → `4270e29` (pure facts builder, `lib/transactions/transaction-facts.ts`) → `64b0b9d` (persist on Plaid sync) → `3165d8b` (persist on import) → `4563f9c` (facts exposed in the detail read model, 2026-07-08 14:38 +0300). Every transaction synced or imported since capture-at-write landed is stamped with the full fact set at `TI_FACTS_VERSION = 1` (`transaction-facts.ts:38`).

**TI4 — relationship resolution: shipped, in a ratified read-time posture.** The fact-layer plan's §5/§7 prescribed *persisted* relational facts via a reconciliation pass (`TRANSACTION_INTelligence…2026-07-07.md:209` — TI4 slice); the ratified TI4 decision superseded that: relationships are **not persisted** — they are explanation/navigation context, resolved at read time (`lib/transactions/RelationshipResolver.ts:4–9`; the supersession is recorded point-by-point in the 2026-07-13 wiring investigation §7.2). What is live: pending↔posted matching (exact provider match on `plaidTransactionId ↔ pendingTransactionRef`, `RelationshipResolver.ts:174–195`), exact-fingerprint duplicate detection (lines 197–219), and **TI4 Slice 1** deterministic owned-account cross-account transfer matching (`matchTransferCandidate`, lines 242–285; ambiguity refused, never guessed). Wired into the detail read (`lib/data/transactions.ts:408–448`, KD-15 visibility gate at 450–464) and, via `lib/transactions/transfer-resolution.ts`, into the list reads. **`refundCandidate` is genuinely unbuilt** — reserved `null` in the output contract pending "a ratified fuzzy heuristic — proposed, not built" (`RelationshipResolver.ts:37–39, 114, 305`).

**TI3 / TI5 — partial, see §3.1–§3.2.** The backfill script is built and tested (`c967661`; `lib/transactions/transaction-facts-backfill.test.ts`); TI5 read cutover reaches the detail DTO and (via CF-1/CF-2B) the list DTO. The AI path (`buildContext()`) was unwired when the 2026-07-13 wiring investigation was written (zero imports of either TI facet under `lib/ai/`, grep-verified at its §0); its recommended **W1 slice shipped the same day** (`02e22e1`, 2026-07-13 16:04 +0300 — needs-classification aggregates in the AI transactions assembler, disclosure-only, with §3.3 counterparty parity via `resolveOwnedTransferCounterparties`); W2 (Brief/annotations consumption) and W3 (gated pending-disclosure dedup) remain per that investigation's §8.

**Net:** the "TI4 shipped" leg of the unpark condition is substantially met — with two honest caveats: it shipped read-time rather than persisted (architecturally fine for Receipt Intelligence, which would *consume* resolution the same way the detail view does), and its receipt-relevant fact (`refundCandidate`) is the one slice deliberately not built.

## 3. What is still genuinely missing

### 3.1 `paymentMethod` coverage gap on historical rows — permanent by design

The TI3 backfill reconstructs **only** the facts derivable from stored data: `settlementState`, `fxApplied`, `tiFactsVersion`. Provider-only facts — `paymentChannel`/`paymentMethod`/`authorizedAt`/`counterpartyType`/`pendingTransactionRef` — "are NEVER written and stay NULL, since historical rows never captured that metadata" (`scripts/backfill-transaction-facts.ts:9–12`, doc comment re-verified 2026-07-13; enforced structurally — the backfill's return type excludes them, `transaction-facts.ts:237–242`, and the apply write is a parameterized raw UPDATE of exactly those three columns, `backfill-transaction-facts.ts:99–110`).

So even a fully applied backfill leaves `paymentMethod` populated only on rows synced/imported after capture-at-write landed. **Cutoff verified:** `64b0b9d` (Plaid sync) and `3165d8b` (import) landed 2026-07-08 00:32–00:36 **+0300** = 2026-07-07 21:32–21:36 **UTC** — the "since 2026-07-07" framing is accurate in UTC; in this repo's local commit timezone the capture epoch is the first minutes of **2026-07-08**. For Receipt Intelligence specifically this gap *decays*: receipts are overwhelmingly matched against recent transactions, and every day of forward capture widens the matchable window — but any launch-day matching corpus older than the epoch has `paymentMethod = NULL` and would have to match on amount/date/merchant alone.

### 3.2 TI3 apply-state — UNVERIFIED (this session could not execute the dry-run)

No repository artifact records that `--apply` was ever run: the script leaves no marker file, no migration, no log in-tree, and the 2026-07-12 repository audit's backfill table answers its own "Run?" column with "**Per TI ledger**" (`FOURTH_MERIDIAN_REPOSITORY_AUDIT_2026-07-12.md:177`) — deferring to a STATUS.md TI ledger that, at that time, contained no TI2/TI3 entry at all. The reference was circular; apply-state was genuinely unrecorded anywhere.

The definitive check is the script's own default dry-run (read-only, no `--apply`): `npx tsx scripts/backfill-transaction-facts.ts`, whose version gate selects `tiFactsVersion IS NULL OR tiFactsVersion < 1` (`backfill-transaction-facts.ts:50–56`; `TI_FACTS_VERSION = 1`, `transaction-facts.ts:38`). **Near-zero eligible rows ⇒ the backfill (or full-corpus capture-at-write turnover) is complete; a large eligible count ⇒ it has not run.** This session could not execute it: the run requires the local Postgres (`localhost:5432`) and the repo's darwin-arm64 node binaries, neither reachable from the sandboxed session environment. The apply-state is therefore recorded as **unverified** in the corrected STATUS.md ledger, with the verification command named — not guessed in either direction. Note the consequence is bounded either way: the only unstamped facts at risk are `settlementState`/`fxApplied` on pre-epoch rows; new rows are stamped at write regardless.

### 3.3 `refundCandidate` — the receipt-relevant TI4 slice, deliberately unbuilt

Returns/refund matching (opposite-amount + merchant + window) is reserved-null pending a ratified fuzzy heuristic (`RelationshipResolver.ts:37–39, 114`). Of everything TI4 covers, this is the fact a receipts product leans on hardest (returns, warranties, refund reconciliation against a receipt's line items). If Receipt Intelligence's scope includes returns — §4.3 named "returns, warranties" in its user-value case — this slice is a build prerequisite, and it needs its own ratification because it is the first *fuzzy* relational fact (the honesty-valve discussion in the fact-layer doc §8 applies).

### 3.4 The demand-side condition — unmet and unmeetable pre-beta

"Real user demand" cannot be observed with no external users. OPS-1 (Platform Operations Foundation) remains **Active** with the beta-facing slices still ahead: its next milestone is "S9 legal pages / S10 beta access gate" (`STATUS.md` §3, Platform operations track, OPS-1 row), and the platform lane runs OPS-1 S9/S10 → PO1 → Platform Facts → Platform Rollups → Platform Operations → **Private Beta** (`STATUS.md` §Current focus, "Upcoming (execution order)"). Until S10 ships and beta users exist, the demand leg is structurally unsatisfiable — this leg alone keeps Receipt Intelligence parked regardless of TI state.

### 3.5 Receipt Intelligence's own entry costs — unchanged

Nothing since 2026-07-08 reduces the module's intrinsic difficulty: first document pipeline, first OCR dependency, receipt storage + PII surface requiring its own 7A-doctrine review (receipts carry addresses, partial PANs, names — `FINANCIAL_INTELLIGENCE…2026-07-08.md:144`), and per-receipt processing cost that must be "born instrumented" per PO1 — and PO1 itself has not started (investigations + implementation plan exist at root, zero code — `STATUS.md` §Current focus, platform lane). These were half the 5/10 score and they all still stand.

## 4. Restated unpark condition

The original condition "TI4 shipped + real demand" is **half-consumed**. Restated precisely, Receipt Intelligence unparks when **all** of the following hold:

1. **Demand:** a real post-beta user-demand signal — gated on OPS-1 S10 (beta access gate) shipping and beta users existing (`STATUS.md` §3, OPS-1 row). *This is now the binding constraint.*
2. **`refundCandidate` ratified + built**, if (and only if) returns/refund matching is in the module's launch scope (`RelationshipResolver.ts:37–39`).
3. **TI3 apply-state verified** (one read-only dry-run; §3.2) — cheap, and should happen well before this module regardless.
4. **Its own 7A-style PII review and PO1-grade cost instrumentation at entry** — unchanged from the original assessment (§3.5); PO1's existence is therefore a practical (if not strictly logical) prerequisite.

**Plain verdict: still correctly parked.** The park decision was right on 2026-07-08 and remains right on 2026-07-13 — but the module is materially *closer to buildable* than the original document could know: the TI-side technical gate it named has substantially cleared, `paymentMethod`/`settlementState` are now captured at write on every new row (and the historical gap decays daily), and read-time relationship resolution provides the consumption pattern a matcher would use. What blocks it today is demand (structurally, until beta) plus one named TI slice — not the TI roadmap wholesale.

---

**End of reassessment. No code changes for Receipt Intelligence were made or are recommended at this time. STATUS.md's TI ledger is corrected in the same commit as this document.**
