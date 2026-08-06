# Time Model

Status: **settled.** Enforced by tests, not convention.

This is the authoritative statement of how time works in Fourth Meridian. It supersedes inference from code comments.

> **New here? The one idea.** Time in Fourth Meridian is a single persistent
> **anchor** (`asOf`) plus a **window length** (`preset`) measured *backwards from the
> anchor* — not from the present. `asOf` decides *what is true* (which snapshot,
> price, FX rate); the preset decides only *how much history is shown*. There is one
> canonical time authority (`shellTimeReducer` / `usePerspectiveShellState`); the
> `TimelineLens` UI cannot read a clock or name a preset — it only *emits intents* —
> so it is structurally incapable of becoming a second authority. **Every financial
> Perspective participates in this one model** (§5); no workspace owns its own time.
>
> **The second idea (§8).** Selecting a window is one axis. *Which date a row
> carries* is a different one. A flow happened when it was **authorised**; a
> balance changed when it **posted**. Both are true, both are stored, and a
> measure must not mix them.

---

## 1. The invariant

> **`asOf` is a persistent temporal anchor.**
>
> It is the vantage point from which all financial truth is read, and it moves **only** by explicit user action — never as a side effect of choosing a window.
>
> **Relative presets are window lengths measured backwards from the anchor**, not from the present.

Concretely:

```
asOf = 2026-03-31 · preset = Month to date   →   2026-03-01 → 2026-03-31
                                                  NOT this month
```

This is intentional. `lib/perspectives/time-range.ts:26-27` states it as the resolver's own rule: *"Compare To = start of the period that CONTAINS As Of; As Of stays the endpoint."*

## 2. Why — the two axes are separate

`lib/wealth/wealth-time-machine.ts:13-16`:

> *The shared range only windows the historical chart; **it never redefines the point-in-time cards**.*

- **`asOf` determines what is true.** Which snapshot, which `PositionObservation`, which price, which FX rate.
- **The preset determines how much history is shown.** Nothing more.

A preset change is a range operation. It has no business moving the anchor. Cash Flow made this explicit when it replaced an implicit `new Date()` with `asOf` (`CashFlowWorkspace.tsx:132-135`) — resetting the anchor on preset selection would partially undo that fix.

## 3. Derived rules

| Concept | Rule |
|---|---|
| `compareTo` | Always derived from `preset` + `asOf`, except under `CUSTOM`. Invariant: `preset ≠ CUSTOM ⟺ compareTo === compareToForPreset(preset, asOf, coverage)` |
| `CUSTOM` | Not a choice — an **inference**. The state when a manual pair matches no preset. |
| `ALL` | All history **up to the anchor**, opening at `coverageFrom` when known, else `null`. **Never fabricated.** |
| Future dates | `clampAsOf` caps `asOf` at today. `compareTo` is *not* constrained to precede `asOf` — forward comparison is legitimate and Wealth depends on it. The strictly-earlier rule is a **derivation** (`historicalCompareTo`), not an invariant. |

## 4. Two obligations that follow

Because the anchor is persistent:

**4.1 — Every surface displaying a period must name the anchor, never imply the present.**

A label may not assert "this" of a window that does not contain today. To-date presets are therefore **"Month to date"**, not "This month". The lens names the vantage point in its eyebrow — *"As of Mar 31, 2026"* — including at the present (*"As of today"*), because `asOf`'s present-day value is not "unset", it is "anchored to now".

**4.2 — There must be exactly ONE explicit action returning to the present.**

An anchor you can enter but not leave is a trap, not a lens. That action is `returnToPresent` → `setAsOf(today)`.

**Exactly one** is load-bearing. An emptied As-of field is therefore **rejected with a message**, not silently coerced to today — even though the legacy control did coerce. Two paths to the present, one deliberate and one accidental, make the deliberate one noise: a user who cleared the field and landed on today would reasonably conclude that *is* the way back.

## 5. Where authority lives

```
TimelineLens          presentation + intent. Cannot read a clock, do calendar
                      arithmetic, or name a preset. Structurally incapable of
                      becoming a second authority.
      │ TimelineIntent
      ▼
PerspectiveTimeAdapter  ONE adapter, all five Perspectives. Intent → an
                        EXISTING ShellTimeAction. Owns no state.
      │ ShellTimeAction
      ▼
shellTimeReducer      THE authority. Pure. One owner
usePerspectiveShellState  (usePerspectiveShellState), one URL model.
```

No workspace owns canonical time. No per-Perspective time adapter exists or should — the differences between lenses live *downstream* of selection, never in how time is chosen.

## 6. Enforcement

This doctrine is enforced, not documented-and-hoped:

| Property | Test | Note |
|---|---|---|
| The anchor survives every preset | `time-range.test.ts` | Historical fixtures. **Mutation-verified: flipping the reducer to reset produces 27 failures** (previously 0 — the old fixtures were degenerate) |
| No label asserts the present | `perspective-time-adapter.test.ts` | `!/^This\b/` over every option |
| One sanctioned return to the present | `perspective-time-adapter.test.ts` | Empty As-of rejected; no other intent jumps to today |
| `ALL` never fabricates a start | `timeline-lens-coverage.test.ts` | Including delayed coverage hydration |
| The lens cannot become an authority | `TimelineLens.test.ts` | Import / date-API / vocabulary / token guards |
| No workspace owns time | `workspace-definition.test.ts` | Doctrine scan, mutation-verified |
| One selector on screen | `timeline-lens-exclusivity.test.ts` | Renders the shell rather than scanning it |

## 7. Changing this doctrine

If a future change makes the anchor reset on preset selection, it must also answer:

1. **Reducer/hydrate divergence.** `hydrateShellTimeState` re-derives `compareTo` from the URL's `asOf`. Under a reset model the same `{preset, asOf}` resolves differently by link than by click — or every historical deep link breaks, along with the round-trip identity test.
2. **Wealth's only historical-window workflow.** *"What did my net worth look like on D, and what was the trailing-quarter shape into D?"* has exactly one expression: anchor at D, pick 3M. The balance lenses have no `explicitPeriodRange` escape hatch the way Cash Flow does.

Both were weighed in the TIME-1 audit and neither has a cheap answer. That is why the doctrine is what it is.

---

## 8. The basis axis — economic vs posting

Status: **settled** (v2.6-CHRON-1). Enforced by `audit-chronology-basis`, REQUIRED in CI.

§1–§7 govern **which window** a surface reads. This section governs **which date a
row carries inside it**. The two are orthogonal: choosing `asOf = 2026-03-31 · 1M`
says nothing about whether a transaction dated near that boundary is inside it.

### 8.1 The invariant

> **A measure is computed on ONE basis, and names it.**
>
> **Flow** measures use the **economic** date — when the money moved.
> **Balance** measures use the **posting** date — when the account changed.
>
> A measure that mixes them is wrong even when every input is right.

```
Transaction.economicDate   authorisation, else posting   ← FLOW basis
Transaction.date           the provider's posting date   ← BALANCE basis
```

Both columns are persisted, both are true, and neither is a fallback for the
other. `economicDate` is NOT NULL for every live row (`audit:economic-date`).

### 8.2 Why both exist

They answer different questions, and the honest answer differs:

- *"How much did I spend in March?"* — a card charge authorised 31 Mar and posted
  2 Apr **is March spending**. The economic date is the truthful one.
- *"What was my balance on 31 March?"* — that same charge had **not yet moved the
  balance**. The bank's own statement agrees. The posting date is the truthful one.

On the live corpus **2,817 rows** carry an economic date different from their
posting date, and **147 cross a month boundary**. This is not an edge case; it is
one month's worth of rows every month.

`lib/snapshots/regenerate-history.ts` states the balance half in its own words —
a reconstruction anchored to a posted `FinancialAccount.balance` must use posted
deltas, *"same-basis invariant"*. That was already correct. What was missing was
anyone saying the other half out loud.

### 8.3 The rules

| # | Rule |
|---|---|
| B1 | A **flow** read (population = `bankingTransactionWhere`) filters, orders, groups and buckets on `economicDate`. Never `date`. |
| B2 | A **balance** read (anchored to a stored balance, snapshot or position) uses `date`. Never `economicDate`. |
| B3 | A surface serving **both** enumerates **both** — it does not pick one and hope. See §8.4. |
| B4 | The DTO's `date` **is** the economic date (`lib/transactions/serialize.ts`). `postingDate` rides beside it as provenance. A comment claiming otherwise is a defect, not a nuance. |
| B5 | Comparing a flow measure to a balance measure across a period boundary requires an explicit reconciliation, because the two periods are genuinely not the same set of rows. |

### 8.4 The worked example — one endpoint, both bases

`/api/money/view-context` prefetches the FX rates the client will need. It serves
two populations at once:

- **transaction rows**, converted by the flow folds at the DTO's `date` — economic
- **snapshot points**, converted at the snapshot's own date — posting

It enumerated `groupBy(["date"])` over the *flow* population: posting keys for
rows that would be converted at economic dates. Measured on the live corpus,
**31 economic dates had no prefetched rate and 163 rows landed on them** — they
would have converted as unavailable while every neighbouring row converted
cleanly. `FxRate` is empty today, so nothing was visibly wrong; the defect was
latent and would have surfaced as an unexplainable scatter of missing
conversions the first time a non-USD reporting currency was used.

It now enumerates economic dates for the flow rows and keeps snapshot dates for
the balance series. **That is rule B3: serve both, enumerate both.**

### 8.5 Enforcement

| Property | Check | Note |
|---|---|---|
| No flow aggregate keyed on posting | `audit-chronology-basis` INV-B1 | Source scan: a Prisma aggregate whose `where` is the banking population may not key on `date` |
| Every economic date is FX-reachable | `audit-chronology-basis` INV-B2 | Data: the 31→0 gap above, corpus-level |
| The DTO date seam documents itself | `audit-chronology-basis` INV-B3 | The `serialize.ts` comment asserted `date` was posting *twenty lines below the code setting it to economic* |
| Economic date is stored and derivable | `audit:economic-date` | 4,456/4,456 stored === derived |
| Reads are economic end to end | `audit:chronology` | Keyset, count/list parity, cursor agreement |

### 8.6 Known open

**The AI assembler mixes bases.** `lib/ai/assemblers/transactions.ts` filters its
window on `date` (posting) and buckets into months with `econOf` (economic), so a
row can be admitted by one basis and counted under the other. It is a different
*shape* from B1 — a `where` filter, not an aggregate key — so INV-B1 does not
reach it, and correcting it moves AI totals, which needs its own measured cutover.

Recorded here rather than silently excluded. It is one of four axes on which the
AI read boundary diverges from the UI, and it is fixed with them, not alone.
