# Future Design Note — Transaction Fingerprinting as Confidence, Not Identity

**Status: not approved, not scheduled, not actionable.** This is a documentation-only capture of a design concern raised during D2 Step 4D-5b. No code, schema, or roadmap changes accompany this note. The current fingerprinting strategy (`lib/transactions/fingerprint.ts`, consumed by Plaid sync and by CSV/Excel import's `resolveFingerprintOutcome()` in `lib/imports/csv.ts`) is the correct, approved tradeoff for D2 and is unchanged.

## The concern

Today's duplicate-detection fingerprint is `financialAccountId + date + amount + normalized-merchant` (plus a `pending` constraint inside `findByFingerprint()`). It treats a fingerprint match as a definitive identity claim: a CSV/Excel row whose fingerprint matches an existing `Transaction` is classified `MATCH` (no write), and a fingerprint matching more than one existing row is `SKIP`ped as ambiguous — but a fingerprint matching exactly one row is never questioned.

That's a false-positive risk whenever a person has more than one *legitimately separate* transaction that happens to share all four fields. The canonical example: three actual $7.50 charges at "Amsterdam Bar" on the same day (three different rounds, three different friends covering a tab, whatever the real-world reason) will fingerprint-identically. Today's logic would treat the first as `CREATE`, then both repeats as `MATCH` against that first row — silently losing two real transactions, with no record that anything was skipped (a `MATCH` is not logged as a near-miss; it's logged as "this row already exists").

This is not a new bug introduced by 4D-5b — it's inherent to the fingerprint's field set, present since D2 Step 4C, and out of scope to fix as part of any column-mapping work.

## Proposed future direction (not designed in detail, not approved)

Reframe a fingerprint match as a *confidence signal* rather than a definitive identity claim:

- An exact `externalTransactionId` match (when a file/provider supplies one) stays high-confidence — provider-assigned IDs are unambiguous identity, not similarity.
- A fingerprint-only match (no `externalTransactionId`, or `externalTransactionId` absent on one or both sides) becomes "potential duplicate" — surfaced for review rather than auto-resolved to `MATCH` or silently merged.

## Future ideas raised (unordered, unevaluated, none committed)

- Richer fingerprints: incorporate reference/check number, memo/description text, currency, or posted-vs-authorized date to narrow the collision space before falling back to confidence scoring.
- Explicit confidence scoring rather than a binary match/no-match.
- A duplicate-review queue — a UI/workflow surface for a human to resolve "potential duplicate" rows, rather than the current auto-resolve-or-skip behavior.
- A `DuplicateTransactionCandidate` model, structurally analogous to D1's `DuplicateAccountCandidate` (audit-style: record the candidate pairing and a resolution, rather than mutating data inline).
- AI-assisted resolution — using merchant-text similarity, amount/date proximity heuristics, or an LLM call to suggest (not auto-apply) a resolution for ambiguous cases.
- Configurable per-source duplicate strategies — e.g. Plaid-sourced rows (which already carry a provider transaction ID) may warrant different confidence defaults than a CSV row from a bank export with no reference column at all.

## Why this is deferred, not designed now

D2's current scope (see `docs/initiatives/d2/D2_ROADMAP.md` and the Phase 2 decision matrix) is the ingestion/mapping pipeline itself — `ImportBatch`, CSV/Excel parsing, column mapping/profiles, rollback. A confidence-based duplicate model is a meaningfully larger change: new schema (at minimum a candidate table, likely a status/resolution enum), a review surface, and a decision about whether Plaid sync's own duplicate handling should move onto the same model or stay separate. None of that has been scoped, and per the Phase 2 working rules, no implementation step proceeds without its own impact map, rollback plan, and validation checklist — none of which exist for this yet.

This note exists so the concern isn't lost between now and whenever D2's ingestion engine is revisited (a later ingestion/ML phase, or a dedicated future D-step). Revisit this note at that time; do not treat its existence as approval to begin design or implementation work today.
