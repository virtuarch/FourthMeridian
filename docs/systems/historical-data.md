# Doctrine — Historical Data

*Governs how the past is represented: what is observed vs. derived vs. estimated, when history may be reconstructed, and when it must never be rewritten. Origin: the D2.x historical pipeline, the A-series investment/wealth reconstruction, and the SnapshotAmendment system.*

The platform reports on dates in the past that predate a user's first connection. The core tension is between **usefulness** (show a net-worth trend from before day one) and **honesty** (never present a reconstruction as a recorded fact). These rules resolve that tension.

## Observed vs. derived vs. estimated

Every historical value has a provenance class:

- **Observed** — a value that was actually recorded at the time (a synced balance, a posted transaction).
- **Derived** — computed deterministically from observed facts (e.g. a day's net worth folded from that day's balances).
- **Estimated** — reconstructed for a date with no direct observation (e.g. backfilled pre-connection history). Estimated rows carry an explicit marker (`SpaceSnapshot.isEstimated`) and surface a chart badge. Estimated is never silently promoted to observed.

## Snapshot immutability

- `SpaceSnapshot` rows are **frozen computed totals**. Once written for a date, a snapshot is not rewritten.
- History is **never restated** — not on a currency flip (each reconstructed day converts at its own historical rate; see [money-and-fx.md](./money-and-fx.md)), not on a later resync.
- Snapshots persist **class-level totals only** (cash / investments / crypto / debt). There is **no per-account or per-institution history** for any past date. This is a hard data ceiling, not a missing feature: composition views that slice by account/institution/concentration must therefore carry an explicit **"Current classification"** label for past dates rather than silently implying history exists. Only the By-class view is genuinely time-sliced.

## Amendment consent boundary

- The `SnapshotAmendment` / `SnapshotAmendmentDay` system is the **only** sanctioned path to change a persisted historical value, and it is a consented, provenance-bearing act — an amendment, not an in-place edit. The underlying snapshot immutability rule still holds; an amendment is recorded alongside, never a destructive overwrite.

## Reconstruction paths

- **A9 — snapshot reconstruction.** Re-derives a Space's daily class-level snapshots from observed facts. When A9 regenerates snapshots it excludes digital-asset accounts from the investment bucket (see the crypto split below), because the crypto total is tracked in its own bucket.
- **A10 — strict historical investment path.** The single authority for *past* investment portfolio values (`getInvestmentsTimeMachine`). The current portfolio is a **separate** path (`getCurrentPositions`). These two never cross-derive — see [../systems/investments.md](../systems/investments.md).
- **`getAccountsAsOf` / `getInvestmentValueAsOf`** — per-account historical anchors used by the Liquidity **splice** engine: the live per-account balance is the anchor, the reconstructed past is spliced in per account, and no second valuation authority or classifier is introduced (see [../systems/liquidity.md](../systems/liquidity.md)).

## Regeneration membership guard

**IMPLEMENTED** — PR #124 (per revoked link), PR #143 (fail-closed exits); `membershipExitLinks` / `loadRevokedLinkWindows` in `lib/snapshots/regenerate-history.ts`, the decision in `lib/snapshots/regenerate-history.core.ts` ("MEMBERSHIP GUARD, PER REVOKED LINK"), and the `skip-membership-changed` regeneration action.

Automatic (non-amendment) regeneration sees only the Space's **currently active** links. It must therefore never rewrite a day whose stored row may carry the contribution of an account that has since left the Space, or it would silently drop that contribution.

- **The rule.** Day *d* is blocked iff some membership exit's account **could have contributed** to *d*'s stored row, i.e. *d* lies in `[contributesFrom, exitDay)`. The exit day itself is not blocked.
- **What counts as an exit.** A REVOKED link exits at the UTC day of `revokedAt`; a REVOKED link with a null `revokedAt` exits **today** (every earlier day stays blocked); an ACTIVE link to a trashed account exits at the account's `deletedAt`. A link present in both sets keeps the earlier exit.
- **What bounds a contribution.** A floor is usable only when every writer that could ever have produced the stored row respected it. Only **manual real assets with a valuation ledger** have one: the earliest of the first valuation anchor, the link `createdAt`, the account `createdAt`, the earliest transaction, the earliest valuation row in any currency, and the acquisition date. Banks, cards, loans, investments, crypto wallets, legacy balance-only assets, unknown kinds and any failed read are **unbounded** — they block every earlier day, because earlier writers walked cash back from today's balance and held investments and crypto flat at today's quantity. The guard fails closed: only a positively established floor unblocks a day.
- **Floor premise.** `ManualAssetProfile` is never mutated by code (pinned by a source-scan test); an edit path for its acquisition date would invalidate the floor. `AssetValuation` is append-only for tenants.
- **Amendments are exempt by construction.** A consented `SnapshotAmendment` rebuild is the sanctioned way to revise a membership-changed day (see the consent boundary above).
- **Operator view.** `scripts/regenerate-wealth-history.ts` prints each blocking link, its blocked range and the number of days left untouched.

Residual risks (current behaviour): a Space that revokes a bank, investment or crypto account still needs the amendment system to rewrite earlier days; a hard permanent delete removes the link row, so neither guard protects that account's history. A **merge-aware** guard (treat a duplicate-merge loser as "merged into the winner" rather than "left the Space", so those days could be regenerated) is **PROPOSED**; today such days stay blocked, which is never wrong but can shorten history.

## Crypto bucket split (ratified taxonomy)

Crypto occupies a **single** bucket and is counted **once**. The ratified split:

- Crypto is **excluded** from the snapshot `totalInvestments` (stocks/securities) bucket and tracked separately as `totalCrypto`.
- Crypto **is included** in A10's investments *view* (the time machine surfaces holdings including digital assets by default; only A9 snapshot regeneration passes the exclude flag).

This split is why a naive reconstruction once double-counted a crypto spine position as both an investment and a digital asset. The rule (crypto excluded from the securities bucket, counted once in its own) is pinned by `valuation.investment-bucket.test.ts` and must be treated as doctrine, not left implicit in a test.

## Intentionally-unresolved as-of distinctions

Some as-of behavior is **deliberately** left unresolved and must not be "fixed" without a decision:

- **Held-flat** valuation for dates between observations is intentional; the Liquidity as-of machinery is kept kill-switched and unconsumed pending the held-flat reconciliation. Reconstructed past ≠ live anchor, and the code keeps them distinguishable rather than blending them.

## Invariants

1. Estimated rows are marked and badged; estimated is never presented as observed.
2. Snapshots are immutable and class-level only; no per-account/institution history for past dates.
3. History is never rewritten (currency flips and resyncs convert/re-derive, they do not restate).
4. Crypto is counted once — excluded from the securities bucket, tracked in its own.
5. Current and historical valuation paths never cross-derive.

## Known limitations

- History depth is bounded by the backfill window (a 30-day `SpaceSnapshot` backfill on first connection; deeper history is a separate initiative).
- No per-account historical composition exists, by design (class-level snapshots only).
