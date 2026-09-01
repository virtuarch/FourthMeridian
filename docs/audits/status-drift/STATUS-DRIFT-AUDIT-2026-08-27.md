# STATUS.md drift audit — 2026-08-27

**Scope:** HEAD `93b46c0` (branch `v2.6`, 2026-08-27 20:06 — CF-6 landed *during* this audit) vs STATUS.md as committed at `9ea50a5` (2026-08-17).
**Verdict: 28 new commits in ~24 hours, all unmentioned. Includes a real schema migration — the exact TI2 signature. STATUS.md is now 10 days stale and untouched; every carried item from 08-20 onward remains unremediated.**

| Check | 2026-08-26 | 2026-08-27 |
|---|---|---|
| HEAD | `88efc6e` (08-26 20:04) | `93b46c0` (08-27 20:06) |
| STATUS.md last touched | `9ea50a5`, 08-17 | unchanged (10 days) |
| New commits since last audit | 9 | **28** |
| New schema migrations | 0 | **1** (`20260826232626_position_coverage_licence`) |
| Migration dirs | 100 | **101** (STATUS.md:7 still says 88) |
| New committed `.md` docs | 0 | **1** (`docs/systems/crypto-networks.md`) |
| New env keys | 1 | **5** (`ALCHEMY_API_KEY`, `ETH_RPC_URL`, `SOL_RPC_URL`, + retained `ETHERSCAN_API_KEY`/`HELIUS_API_KEY`) |
| New npm audit scripts | 2 | **6** |

Keyword check against STATUS.md — all **zero hits**: `CF-1`…`CF-6`, `W6`, `ETH-H`, `UI-C`, `PRODUCT-C`, `A6`, `HISTORY_SUPPORTED`, `PositionCoverage`, `coverage licence`, `Ethereum`, `Solana`, `wallet`, `Alchemy`, `denominator`, `temporal`, `conversation-scope`, `evidence-awareness`, plus every carry-over from prior cycles.

---

## New drift (this cycle)

**1. A real schema migration shipped with zero STATUS mention. *(highest severity — this is the TI2 shape exactly)***
`20260826232626_position_coverage_licence` creates table `PositionCoverage` (`financialAccountId`, `instrumentId`, `kind`, `coveredFrom/ToDate`, `caveats[]`, `source`), FKs to `FinancialAccount` (cascade) and `Instrument` (restrict), unique on (account, instrument). Landed inside the W-M2/W6 wave; consumed by CF-5's coverage envelope as the persisted licence behind per-chain date ranges.
→ TI2 was discovered because a migration + tests + commits existed and STATUS knew none of it. **Same three ingredients are present here.** STATUS.md:7 still says "88 migrations, 0 failed" against an actual **101** directories.
→ **Suggested correction:** update the migration count on line 7, and add a *Recently landed* clause naming `PositionCoverage` as the persisted position-coverage licence. Note the production deploy implication: this is an unapplied migration against prod.

**2. The crypto wave doubled again — SOL and ETH now earn `HISTORY_SUPPORTED`; three chains are history-supported.**
`0afb05a` W-M2 (+1,818), `3a389d0` W-M2a, `d6a8627`/`d0ebf4f` W-M2b, `c160500` W-M2c, `edcfc63` W-M3 (one EVM adapter, four networks), `bf724f2` W-M3a, `2125749`→`d404692` W6→W6f, `462f2bc` ETH-H1 (+1,368), `3ed4062`/`67f5b1e` ETH-H2. `lib/crypto/wallet-sync-dispatch.ts` is now the registry; BTC, SOL and ETH all read `HISTORY_SUPPORTED`, two further EVM networks sit at `CURRENT_POSITION_SUPPORTED`.
→ STATUS.md's only crypto text remains the REVIEW-3-era "provider-bound history" clause and the line-41 lens limits. **Nothing says the product now reconstructs history on three chains.**
→ **Suggested correction:** replace last cycle's suggested crypto clause (see item 3 — it is already stale) with: "W-M2→W6f/ETH-H2 — the wallet chain registry is the single support authority; BTC, SOL and ETH are `HISTORY_SUPPORTED`, further EVM networks are current-position only; `lib/crypto/wallet-current-value.ts` is the one current-value authority for chains that write no balance column."

**3. Last cycle's own suggested correction is already obsolete — a withheld value is no longer a zero.**
The 08-26 audit (item 2) recommended documenting that "non-BTC native crypto is observed and priced but withheld from net worth." `bf724f2` W-M3a fixed the underlying false zero (a provider-confirmed 0.7516 SOL rendering `$0.00` on every account surface, because `FinancialAccount.balance` is `NOT NULL DEFAULT 0`), and `af70699`/`0ee6a64` W6d/W6e converged current value onto one authority with a tri-state (`VALUED` / `NO_PRICE` / `NO_OBSERVATION`). `2125749` W6 did the same for history (`QUANTITY_UNKNOWN` / `NOT_APPLICABLE` added, replacing `nativeBalance ?? 0`).
→ **Do not apply the 08-26 wording.** The drift is now the opposite: STATUS understates capability. This is the closest thing to an *inverse* case this cycle.

**4. CF-1→CF-6 — an entire AI conversational-fidelity wave, ~5,600 LOC in one day, unrecorded.**
`127333c` CF-1 (bounded lists carry a denominator), `b895d94` CF-2 (asked-for vs actually-loaded), `73f6836` CF-3 (a temporal claim is never "no period"), `0ddfcab` CF-4 (scope inheritance across turns — SET/CLEAR/UNRESOLVED/INHERIT/DEFAULT in `lib/ai/chat/conversation-scope.ts`), `ed2dd93` CF-5 (coverage envelope: AVAILABLE vs LOADED vs RETRIEVABLE vs UNAVAILABLE), `93b46c0` CF-6 (Space category supplies defaults, not a veto, over domain availability).
Six new npm scripts registered in `scripts/audit-registry.ts`: `ai:bounded-superlatives`, `ai:temporal-conformance`, `ai:conversation-scope`, `ai:evidence-awareness`, `audit:bounded-disclosure`, `audit:temporal-framing`.
→ STATUS.md:45 still reads, in full: *"AI-5: deterministic substrate strong; conversational persistence (`conversationId`) is the major unbuilt AI layer."* **That sentence has now been overtaken four cycles running** and is the single most misleading line in the file — CF-4 shipped multi-turn scope persistence.
→ **Suggested correction:** rewrite line 45 around the CF track, and record that the operational (paid, non-CI) eval tier has grown from 2 scripts to 6.

**5. CF-6 records a live double-count with no ledger entry.**
CF-6's own commit body: *"`holdings.totalPortfolioValue + accounts.totalDigitalAssets` double-counts by $19k. The disjoint pair is `accounts.totalInvestments + accounts.totalDigitalAssets`."* It is recorded in the resolver for "the next slice" — and nowhere else.
→ A known figure-level correctness trap in AI context assembly, sitting in a code comment. **This is exactly what the KD ledger is for.**
→ **Suggested correction:** open a KD item (severity Medium, milestone v2.6a) citing `93b46c0` and the resolver comment.

**6. User-visible product changes shipped — first UI drift of this wave.**
`d1a1f66` UI-C1 (one wallet = one connection = one card; `ConnectionCard.tsx`, `lib/accounts/wallet-connection.ts`), `555c9dc` UI-C2 (a confirmed zero balance is not history), `385a1e1` PRODUCT-C1 (**the wallet picker is now restricted to BTC, ETH and SOL** — `lib/crypto/product-chains.ts`).
→ Prior cycles' drift was all engine-side. This is a change to what a user can select in the product; nothing in STATUS describes the wallet-connection surface at all.
→ **Suggested correction:** one *Recently landed* clause; the supported-chain list is the kind of fact a downstream assessment will get wrong.

**7. Five new provider env keys, none in the Blockers config list — and absence means chains go DARK.**
`.env.example`: `ALCHEMY_API_KEY` (preferred multi-chain, serves SOL + ETH JSON-RPC), `ETH_RPC_URL`, `SOL_RPC_URL` overrides, plus retained `ETHERSCAN_API_KEY` / `HELIUS_API_KEY`. Comment is explicit: *"Absent ⇒ those chains are DARK and refuse honestly."*
→ STATUS's Blockers section enumerates every production key that must be flipped (Sentry DSN, `PLAID_ENV`, Turnstile, `INVESTMENT_OBSERVATIONS_ENABLED`). `AI_ASSESSMENT_GUARD_MODE` was already missing (flagged 08-26, still missing); **now five more.**
→ **Suggested correction:** add a Blockers item — "Crypto acquisition credentials in Production: `ALCHEMY_API_KEY` (or per-chain `ETH_RPC_URL`/`SOL_RPC_URL`). Absent ⇒ ETH/SOL are DARK."

**8. A6 — the guard is now measured under enforcement, but the key is still unset by default.**
`3b030bb`: 12 scenarios × 2 runs × 3 modes, live calls (~$0.12). `guard=off` 33/38 clean (86.8%); `guard=repair` **38/38 (100%)**, 4 repairs. The A4.2 failure ("Yes, your expenses significantly exceed your recorded income" on a refused conclusion) reproduces in both off-mode runs and does not reach the user under `repair`.
→ The 08-26 suggested Blockers item for `AI_ASSESSMENT_GUARD_MODE` was never applied. It now has a measured 13-point conformance delta behind it, which changes it from a config nicety to a defensible flip.
→ **Suggested correction:** add the Blockers item, citing A6's measurement rather than A5's report.

**9. `docs/systems/crypto-networks.md` is not in the documentation map.**
Added `0afb05a`, amended in three later commits (`3a6652a`, `0ee6a64`, `67f5b1e`) — it is the live truth-model doc for chain support and is cited from `.env.example`. STATUS.md:72 enumerates the `docs/systems/` contents by name and does not include it.
→ **Suggested correction:** add `crypto-networks` to the line-72 list.

**10. Improvement, recorded so the trend is visible: `_to_delete/` collapsed from 22 records to 1.**
Only `a42-scenarios.json` remains. Four consecutive cycles of escalation reversed. The A4 conformance transcripts flagged on 08-26 are gone — **verify they were extracted somewhere durable and not simply deleted**, since A4's "36/36, 100%" claim depends on them.

## Inverse drift (STATUS says open / not-started but git shows shipped)

**One partial (item 3 above): STATUS's line-41 "known limits" now understates crypto capability.** Otherwise nothing newly mis-recorded. Standing candidates re-checked at HEAD:

- **KD-14** (`AiAdvice` has no production write path) — **re-verified accurate**: zero `create`/`upsert` call sites across `app/`, `lib/`, `jobs/`, `scripts/`. Correctly open.
- **KD-16** (window re-derivation) — `ASSESSMENT_WINDOW_DAYS = 90` remains one constant at `lib/ai/assemblers/transactions.ts:228`, still "never keyed on the scope hint". **CF-4 changes the calculus**: conversation scope is now an explicit authority with provenance reaching the prompt, so the window's fixedness is a deliberate contract rather than an unexamined default. Fourth cycle carried — read it deliberately and close or restate.
- **KD-8** (master-mode unbounded prompt) — not closed by A6. Correctly open. CF-5 measures the prompt at 21.4k tokens, which is the first hard number STATUS could cite against this item.
- **KD-15** — standing 08-20 case, unchanged: `TRANSACTION_DETAIL_VISIBILITY` is enforced across read paths yet KD-15 appears in no STATUS ledger, open or closed.

## Carried from prior audits — still unremediated

Unchanged, because STATUS.md has not been touched since 08-17:

- **STATUS.md:60 cites `app/api/spaces/[id]/goals/route.ts:62` as live evidence — the file does not exist** (deleted by W2, `9352e41`). Re-verified today. That whole block is self-marked "kept for one cycle, then delete"; it has now been kept for five.
- **STATUS.md:7 "88 migrations"** → actual **101**.
- **W1** transaction-identity/FAMILY wave, **W2** Goals/Retirement retirement, **W3/W3.1/W4** brief assessment authority, **W5** crypto current-value authority, **A1–A5**, **W-M0→W-M1d** — no *Recently landed* clause for any.
- **Suite figures** — REVIEW-3's "492/492 tests, 18/18 REQUIRED audits" (linked from STATUS.md:10 and :42) superseded again; `audit-registry.ts` now carries 29 REQUIRED entries. Add a "figures superseded, see `npm run test:unit`" marker.
- `HOUSEHOLD` enum residue, **DEBT-1**, ops observability restore (`ce360b8`), W2 schema residue held for the migration train.
- **The drift audit series is still untracked** — `STATUS-DRIFT-AUDIT-2026-08-{20,21,22,23,26}.md` all show `??`. This file makes six.

---

*Report-only. STATUS.md was not edited. Note: HEAD advanced from `ed2dd93` to `93b46c0` mid-audit; CF-6 is included above. Working tree at time of writing also carried uncommitted modifications to `app/api/ai/chat/route.ts`, `lib/ai/context-builder.ts`, `lib/ai/prompts/assessment-serializer.ts` and `scripts/check-evidence-awareness.ts`.*
