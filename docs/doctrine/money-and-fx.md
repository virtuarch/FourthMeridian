# Doctrine — Money & FX

*Governs how currency is stored, converted, and displayed. Origin: the MC1 multi-currency architecture initiative. These are binding rules, not a status report.*

Fourth Meridian is a first-class multi-currency system built so that new providers (brokerages, exchanges, wallets, CSV imports) can be added without a schema rewrite. The design separates three concepts that are routinely conflated: the **native currency** a fact was recorded in, the **reporting currency** a Space totals in, and the **display currency** a viewer is momentarily looking through.

## Reporting currency belongs to the Space

- `Space.reportingCurrency` is authoritative. Different Spaces may carry different reporting currencies.
- `User.reportingCurrency` is a **copy-once default** applied to *new* Spaces only. There is no retroactive inheritance — changing a user default never rewrites an existing Space.
- Reporting currency is the currency all **aggregates/totals** for a Space are computed in.

## Display currency is an ephemeral view override

- Display currency ("View as …") is an **in-memory, read-only** override. Writers never consult it; it never touches stored facts. It exists only to re-present already-computed values.
- Itemized rows stay in their **native** currency; only aggregate labels convert. There is **no symbol-only relabeling** — a value shown in another currency has actually been converted at a real rate, or it is flagged estimated.

## Facts are stored native; conversion happens at read time

- `Transaction`, `Holding`, and `SpaceSnapshot` amounts are stored in their **native** currency. There are **no converted/normalized columns** anywhere. (Option B write-time normalization was evaluated and rejected in favor of read-time conversion; conversion must never mutate a stored financial fact.)
- Currency exists at the **row level** (transactions, holdings, snapshots), not only on the account. A single brokerage account (IBKR-style) can hold assets in multiple currencies — an account-level currency model cannot represent that, so provenance is stamped per row.
- **Currency provenance must be captured before conversion** and can never be reconstructed later. This is why provenance stamping shipped during the USD-only era, additively and behavior-neutrally.

## Historical reporting uses historical FX

- Charts and historical totals convert each point at **that date's** rate, from the immutable dated `FxRate` archive (`prisma/schema.prisma` model `FxRate`). A historical chart **does not shift when today's rate moves**.
- Snapshots are **stamped** with their reporting currency and **never rewritten**. On a currency flip, each reconstructed day converts at its own rate; history is preserved, not restated (see [historical-data.md](./historical-data.md)).
- The AI context states converted totals **while citing the originals** — it never presents a converted figure as if it were the recorded one.

## Crypto is an asset, not a cash currency

Crypto is modeled as an **asset with a fiat valuation**, not as a simple cash currency. Its valuation and bucket rules live in [historical-data.md](./historical-data.md) (the crypto bucket split) and [../systems/investments.md](../systems/investments.md).

## Conversion mechanics (where the rules live in code)

- The aggregation chokepoint is `sumBalances()` / `classifyAccounts()` (`lib/account-classifier.ts`) — conversion isolates there rather than being sprayed across surfaces.
- Pure money core: `lib/money/` (`convertMoney` / `convertAndSum` / `identityContext`). **Structurally write-free.** A conversion **miss or null residue yields the native amount plus an `estimated` flag — never an exclusion, never a throw.** No rounding is applied in the core.
- FX resolution service: `lib/fx/` — identity fast path, USD cross-rate, ≤7-day walk-back, and `RateMiss` returned **as a value** (not an exception).
- Provider layer: OpenExchangeRates primary with a Frankfurter/ECB-subset failover, under a **no-forged-weekend-close** rule; a daily cron appends to the archive. The archive is append-only and immutable.
- A homogeneous all-reporting-currency Space is numerically **identity** — an all-USD Space behaves byte-for-byte as it did before multi-currency existed. This is the neutrality guarantee that made the cutover safe.

## Invariants

1. No converted or normalized monetary columns exist; stored facts are native.
2. Snapshots are stamped, never rewritten; historical FX is historical, not today's.
3. A conversion miss degrades to native + `estimated`; it never excludes a row or throws.
4. Display currency is read-only and in-memory; it never reaches a writer.
5. Aggregates convert; itemized rows stay native; nothing is relabeled without conversion.

## Known limitations

- Mixed-currency allocation precision (donut/concentration) and FX P&L (which needs a lot model) are deliberately future capabilities, not part of the read-time conversion contract.
- Cross-currency transfer pairing is currently unresolvable (see [financial-semantics.md](./financial-semantics.md)).
