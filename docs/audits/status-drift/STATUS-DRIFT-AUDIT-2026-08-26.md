# STATUS.md drift audit — 2026-08-26

**Scope:** HEAD `88efc6e` (branch `v2.6`, 2026-08-26 20:04) vs STATUS.md as committed at `9ea50a5` (2026-08-17).
**Verdict: 9 new commits since the last audit, all landed today, all unmentioned. STATUS.md is now 9 days stale and unchanged — every item from 08-20 through 08-23 remains unremediated. One of today's items (W-M) is the closest structural repeat of the TI2 case yet.**

| Check | 2026-08-23 | 2026-08-26 |
|---|---|---|
| HEAD | `90af178` (08-22 21:26) | `88efc6e` (08-26 20:04) |
| STATUS.md last touched | `9ea50a5`, 08-17 | unchanged (9 days) |
| New commits since last audit | 2 | **9** (all 08-26; no commits 08-23→08-25) |
| New committed `.md` docs | 0 | **0** |
| Migration dirs | 100 | 100 (STATUS.md:7 still says 88) |
| New env keys | 0 | **1** (`AI_ASSESSMENT_GUARD_MODE`) |

Keyword check against STATUS.md — all **zero hits**: `A3`, `A4`, `A5`, `W-M`, `assetKey`, `CAIP`, `Ethereum`, `Solana`, `conformance`, `precedence`, `assessment-guard`, `netWorthParticipation`, plus every carry-over (`W1`–`W5`, `trajectory`, `scopeHint`, `INV-19`, `DEBT-1`, `KD-15`, `FAMILY`).

---

## New drift (this cycle)

**1. W-M — a multi-chain crypto wave shipped in one evening, entirely unrecorded. *(highest severity)***
`559c0fb` W-M0 (15 files, +1,123/−78), `e1e41be` W-M1a (13 files, +699/−280), `517c396` W-M1b (8 files, +939), `88efc6e` W-M1c (3 files, +952). Together: native asset resolved from the chain column instead of a hardcoded `"BTC"` literal (`lib/crypto/native-asset.ts`), canonical crypto identity moved off ticker onto **CAIP-19 `assetKey`** across all five alias sites (`lib/investments/crypto-instrument.ts`), and **two entirely new chain syncers** — Ethereum (`eth-rpc.ts`, `eth-sync.ts`) and Solana (`sol-rpc.ts`, `sol-sync.ts`) — writing through the existing `captureWalletPosition` spine.
→ This is ~3,700 LOC of new financial ingest across four commits, with tests, and **STATUS.md's only crypto text is the REVIEW-3-era "provider-bound history" clause and the line-41 lens limits.** Nothing anywhere says the product now reads two more chains. Same shape as TI2: shipped foundation, silent doc.
→ **Suggested correction:** add a *Recently landed* clause — "W-M0→W-M1c multi-chain crypto foundation: native asset is data not a literal (`559c0fb`), CAIP-19 `assetKey` replaces ticker as canonical identity (`e1e41be`), native ETH (`517c396`) and SOL (`88efc6e`) syncers on the shared observation spine" — and open a roadmap line for the wave.

**2. W-M1b states a NEW product limitation that contradicts STATUS's crypto claims.**
`517c396`: ETH positions write **no `balance` column by design** — `SpaceSnapshot.crypto` is `NOT NULL DEFAULT 0` and cannot express "withheld", so ETH/SOL holdings are visible to holdings/export/AI context at the dated close but **do not participate in net worth at all** (surfaced as `netWorthParticipation`). SOL inherits the same boundary.
→ STATUS.md:41 asserts the stock-lens model is "interrogable end to end … from nine canonical roots (net-worth, assets, … crypto)" and enumerates its known limits. **A whole asset class that is deliberately absent from net worth is not among them.** This is exactly the kind of omission that produced the stale Receipt-Intelligence assessment.
→ **Suggested correction:** add to the line-41 *Known limits* sentence — "non-BTC native crypto (ETH, SOL) is observed and priced but is withheld from net worth until the second valuation authority is removed; the refusal is stated in the sync result, not silently zeroed."

**3. A5 — first *runtime* AI enforcement landed, and it ships OFF in production.**
`25f6bfc` — `lib/ai/assessment-guard.ts` (+224) + `lib/ai/claim-detection.ts` (+110), wired into `app/api/ai/chat/route.ts` (+48). Deterministically catches a refused conclusion asserted as fact and a verdict re-attached to a domain that did not produce it. **New env key `AI_ASSESSMENT_GUARD_MODE` (`lib/env.ts:174`), unset ⇒ `shadow`** — detect and log only. `repair` must be set deliberately.
→ STATUS.md's Blockers section enumerates every production config key that must be flipped (Sentry DSN, `PLAID_ENV`, Turnstile, `INVESTMENT_OBSERVATIONS_ENABLED`). **`AI_ASSESSMENT_GUARD_MODE` is not there** — so the one measured contract hole (A4.2: model says "Yes, you are overspending" on a refused conclusion, 2/2 runs) stays open in production until someone knows the key exists.
→ **Suggested correction:** add a Blockers item — "Decide + set `AI_ASSESSMENT_GUARD_MODE` in Production (unset ⇒ shadow; `repair` is the enforcing mode)" — and a *Recently landed* clause for A5.

**4. A3 — assessment precedence landed (was flagged in-flight last cycle).**
`8c7df81` — `AUTHORITY_PRECEDENCE` added to `lib/ai/prompts/doctrine.ts`; resolves three provably-disagreeing lead rules; pinned by `authority-precedence.test.ts` (+215). Last cycle's item 5 ("uncommitted AI-doctrine work — flagged so it doesn't become drift") **has now become drift.**
→ **Suggested correction:** fold into the same A-track *Recently landed* clause as A1/A2; note DATA_QUALITY no longer demotes a critical balance-derived finding.

**5. A4/A4.1/A4.2 — a new OPERATIONAL eval tier exists that STATUS doesn't know about.**
`5e5a70b` (+797), `fca9a63` (+140), `f8ac215` (+457). 12 adversarial fixtures + 12 multi-turn/cross-Space scenarios against the *real* production prompt and model; two new npm scripts (`ai:conformance`, `ai:conformance:scenarios`) registered in `scripts/audit-registry.ts`. **Deliberately never in CI** — paid stochastic model, ~$0.03–0.04 per run. A4.1 also re-baselined A4's own number (94.4% → 91.7% under the corrected scorer) before reaching 100%.
→ STATUS.md:45 still says of AI-5 only "deterministic substrate strong; conversational persistence is the major unbuilt AI layer." That sentence has been overtaken three cycles running.
→ **Suggested correction:** rewrite line 45, and record that a paid, non-CI conformance tier now exists (operators need to know it must be run manually and costs money).

**6. Suite figures moved again — third consecutive cycle.**
A4/A4.1 report **464/464 unit · 21/21 REQUIRED**. The REVIEW-3 report linked from STATUS.md:10 and :42 still carries "492/492 tests, 18/18 REQUIRED audits" (`def2292`).
→ **Suggested correction:** unchanged from last cycle — a "figures superseded, see `npm run test:unit`" marker at the REVIEW-3 link.

**7. `_to_delete/` — five more ungitted W-M records, plus the eval transcripts.**
New since last cycle: `_probe-wm0-ledger.ts`, `_probe-wm0-coverage-parity.ts`, `_probe-wm1-recon.ts`, `_probe-wm1-recon2.ts`, `_probe-wm1a-identity.ts`, and the A4 evidence itself — `a4-BEFORE-transcript.json`, `a4-conformance-gpt-4o-mini.json`, `a42-scenarios.json`. Still gitignored (`.gitignore:97`).
→ Fourth consecutive escalation (2 files on 08-21 → 8 → 11 → **19 records + 3 transcripts**). **The measured evidence for A4's conformance claims exists only in a folder named `_to_delete`.** Extract or `git add` the transcripts at minimum — the claim "36/36, 100%" is unreproducible without them.

**8. The drift audits themselves are untracked.**
`STATUS-DRIFT-AUDIT-2026-08-{20,21,22,23}.md` all show as `??` in `git status`. They survive only as working-tree files.
→ **Suggested correction:** `git add` the audit series, or move it under `docs/operations/`.

## Inverse drift (STATUS says open / not-started but git shows shipped)

**None newly found.** Items 1–7 are unrecorded rather than mis-recorded. Standing candidates re-checked:

- **KD-14** (`AiAdvice` has no production write path) — **re-verified accurate today**: zero `create`/`upsert` call sites across `app/`, `lib/`, `jobs/`, `scripts/`. Correctly open.
- **KD-16** (window re-derivation) — `ASSESSMENT_WINDOW_DAYS = 90` remains a single constant at `lib/ai/assemblers/transactions.ts:223`, explicitly "never keyed on the scope hint" (W4). With A1's determinism pin and A3's precedence contract, the window clause looks **closable**. Third cycle carried; worth a deliberate read.
- **KD-8** (master-mode unbounded prompt) — **not** closed by A5. A4.2 exercised `buildMasterSystemPrompt` for the first time, but bounding was not the subject. Correctly open.
- **KD-15** — standing 08-20 case, unchanged: `TRANSACTION_DETAIL_VISIBILITY` is enforced across read paths yet KD-15 appears in no STATUS ledger, open or closed.

## Carried from prior audits — still unremediated

Unchanged, because STATUS.md has not been touched since 08-17:

- **W2 Goals/Retirement retirement** — and the resulting **false line: STATUS.md:60 cites deleted `app/api/spaces/[id]/goals/route.ts:62` as live evidence.** That block is self-marked "kept for one cycle, then delete."
- **W1** transaction-identity/FAMILY wave, **W3/W3.1/W4** brief assessment authority, **W5** crypto current-value authority, **A1/A2** — no *Recently landed* clause for any.
- **STATUS.md:7 "88 migrations"** — actual directory count is **100**.
- `HOUSEHOLD` enum residue, **DEBT-1**, ops observability restore (`ce360b8`), W2 schema residue held for the migration train.

---

*Report-only. STATUS.md was not edited.*
