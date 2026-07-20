# V25-CLOSE-3A — Reporting Currency Failure Contract

**Status:** IMPLEMENTED + browser-verified. (Investigation + recommendation below; implementation record at the end.)
**Date:** 2026-07-20.
**Question:** what happens when a user selects a reporting currency the FX archive cannot satisfy, and what is the single canonical failure path?

> The investigation/recommendation sections are preserved as written. The **Implementation record** at the bottom documents what was built, why the touch set is what it is, tests, and UI verification.

---

## TL;DR

The bug is not in any perspective. It is one missing decision at one boundary:

> **Reporting-currency selection is validated against a static allowlist, never against actual FX-rate coverage. The context builder then computes exactly which conversions missed — and discards that verdict. Every surface improvises its own downstream reaction to the resulting all-miss context, which is why the behaviour is inconsistent.**

There is a **clean single choke** (`/api/money/view-context` → `serializeSpaceConversionContext`) that already assembles the precise inputs needed to decide coverage. The fix is a coverage verdict + revert **there**, surfaced as one banner at the composition root. No per-perspective changes. No FX math changes.

---

## 1. Where reporting currency is selected, validated, stored

There are **two mechanisms that must not be conflated**, plus a copy-once seed:

| Preference | Surface | Write path | Persisted |
|---|---|---|---|
| **Space reporting currency** (authoritative) | `components/space/manage/GeneralSettingsPanel.tsx:217` `<select>` | `PATCH /api/spaces/[id]` (`route.ts:100-140`) | `Space.reportingCurrency` (`schema.prisma:495`, `@default("USD")`) |
| **"View as" override** (ephemeral) | `components/dashboard/widgets/ViewCurrencyOverride.tsx:75` | `GET /api/money/view-context?target=…` — **read-only, never persisted** (route header `:11-18`) | none (client state; discarded on reload) |
| **User default** (copy-once seed) | `components/settings/PreferencesSettings.tsx:126` | `PATCH /api/user/profile` | `User.reportingCurrency` — seeds new Spaces only, denominates nothing |

All three offer the same value set: `[FX_BASE, ...SUPPORTED_QUOTES]` (`lib/fx/config.ts`).

### The validation gap (the root of everything)

Every write and the view-as GET validate through the **one** helper `parseReportingCurrencyInput` (`lib/spaces/reporting-currency.ts:34`), which is purely:

```
isSupportedCurrency(code)  →  code === FX_BASE || QUOTE_SET.has(code)
```

`isSupportedCurrency` (`lib/fx/config.ts:34`) is a **static membership test** against the `SUPPORTED_QUOTES` constant. It never touches the `FxRate` table, `lib/fx/archive`, or `lib/money`. So it answers *"is EUR a currency our provider can, in principle, supply?"* — **not** *"do we actually hold USD→EUR rows for this Space's dates?"*

Those diverge in practice: the fetch job (`jobs/fetch-fx-rates.ts:44`) populates quotes **only when it runs**, and the archive is forward-only. A fresh deploy, a missed Vercel-Hobby cron slot (documented in `server-context.ts:38-43`), or simply a historical date before a quote was first fetched all yield an **allowlist-valid, archive-uncovered** currency. That is the exact input that produces the reported symptoms.

---

## 2. Is FX availability known before state changes? — **No at write, Yes at build**

- **At selection/write:** No. `PATCH /api/spaces/[id]:100` and `GET /api/money/view-context:31` both accept any allowlisted string and never probe the archive.
- **At context build:** **Yes — and it is thrown away.** `buildConversionContext` (`lib/money/context.ts:152-165`) prefetches every `(nativeCurrency × date)` pair and stores each `Resolution` as a hit (`kind:"rate"`) or a miss (`kind:"miss"`). A fully-uncovered target is simply *a table of all-misses* — structurally complete information — but the returned context exposes only `resolve()` (`:167-177`); it never aggregates a `{ needed, missed }` / `targetSatisfiable` verdict. **The decision the product needs is already computed and then dropped one line before it could be returned.**

This is the crucial enabler: a coverage verdict requires **no new FX math** — only surfacing state the builder already has.

---

## 3. Which surfaces consume reporting currency

**Display path (the one the user sees), single-threaded:**

```
Space.reportingCurrency
  → DisplayCurrencyProvider (app/(shell)/dashboard/page.tsx:55)   [server, per navigation]
  → useSpaceData({ displayCurrency })  (lib/space/use-space-data.ts:105,200)
      → GET /api/money/view-context?target=…   → serializeSpaceConversionContext  → moneyCtx
  → SpaceDashboard rehydrateContext(moneyCtx)  (SpaceDashboard.tsx:444)
  → every workspace consumes the SAME rehydrated ctx
```

So on the client, **all** perspectives receive one shared `moneyCtx` derived from **one** endpoint. Workspaces do **not** each build their own — this is what makes a single-choke fix possible.

**Server/write path (must NOT be reverted — see §6):** snapshot writers (`lib/snapshots/regenerate*.ts`, `backfill.ts`), lenses (`lib/perspective-engine/lenses/{debt,liquidity}.ts`), and AI assemblers each call `buildSpaceConversionContext*` directly. These *stamp forward-only history* in the intended currency by doctrine; they are not the failure surface.

---

## 4. The inconsistency, explained by one root cause

The user observed: **Wealth shows "No wealth history yet"; other perspectives just change the currency symbol.** Both are downstream reactions to the *same* all-miss context, and neither discloses the failure:

**Two triggers reach the same `fxMiss` machinery** — the canonical path must cover both:

- **T1 — ephemeral "view as" override** (Personal Spaces only). `snapshotCurrency` = the persisted reporting currency; with no override, `widgetCtx.target` equals it and `convertWealthSnapshots` (`lib/wealth/display-conversion.ts:79`) takes its identity short-circuit → no `fxMiss`. The empty state appears **only** once a `ViewCurrencyOverride` selects a supported-but-uncovered currency (client-side `fxMiss` in `display-conversion.ts:61`). Shared (non-Personal) Spaces have **no** override control, so they cannot hit T1.
- **T2 — persisted reporting currency PATCHed to an uncovered value** (any Space). `getRecentSnapshots` converts off-stamp rows and stamps `fxMiss` at `lib/data/snapshots.ts:102` when a snapshot's stored stamp ≠ the Space's current `reportingCurrency` and the rate is missing. Here the *stored* preference is the uncovered one, so the revert target cannot be "the persisted currency" — it must be USD.

Both funnel into the same per-perspective drop below.

### (a) Charted historical perspectives → false "No history"

A converted point in the target currency cannot be plotted on the same axis as an unconverted native point (mixed magnitude). So Wealth/Debt/Liquidity all **drop** fx-missed points:

- `fxMiss` is stamped per snapshot in `lib/wealth/display-conversion.ts:61` (and `lib/data/snapshots.ts:102`) when its conversion misses.
- `lib/wealth/wealth-time-machine.ts:242` — `series = input.snapshots.filter((s) => !s.fxMiss)`.
- `:246` — `hasHistory = series.length > 0`.
- `components/space/widgets/wealth/WealthWorkspace.tsx:166` — `if (!result.hasHistory)` → **"No wealth history yet."**

When the target is *fully* uncovered, **every** point is `fxMiss` → the series filters to empty → `hasHistory=false` → the empty state fires. **This is a false absence: the data exists; only its conversion failed.** Debt (`lib/debt-space-data.ts:98`) and Liquidity (`lib/liquidity/cash-history.ts:65`) apply the identical `fxMiss`-drop and will exhibit the same false-empty.

### (b) Scalar / current perspectives → native pass-through, symbol swapped

Cash Flow totals and headline values run through `convertMoney`, which on a miss returns the **native amount labelled as the target** with `estimated/unavailable` (`lib/money/convert.ts:76`). The number is native units under a foreign symbol, marked only by the quiet `est.`/`FxUnavailableNote` signal (V25-CLOSE-3).

**Two surfaces, two behaviours, one cause — and in neither can the user tell whether conversion succeeded.** That is exactly the contract gap to close.

---

## 5. Can the preference be reverted centrally? — **Yes**

The client display path is single-threaded through **one composition root**: `app/(shell)/dashboard/page.tsx` mounts `DisplayCurrencyProvider currency={ctx.space.reportingCurrency}`; the client authority is `components/dashboard/PersonalDashboard.tsx`, which owns the ephemeral `viewOverride` (`:54`), computes `effectiveDisplayCurrency = viewOverride?.currency ?? displayCurrency` (`:60`), and re-mounts the provider around the whole `SpaceDashboard` (`:62`). From there it is one-way: `effectiveDisplayCurrency` → `useSpaceData({ displayCurrency })` → the `/view-context` fetch → `widgetCtx` → `renderCtx` → every workspace. The serialized context enters at exactly two `rehydrateContext` sites (`use-space-data.ts:112`, `SpaceDashboard.tsx:444`). **No workspace builds its own display context.**

- **Fallback target exists:** `DEFAULT_DISPLAY_CURRENCY = "USD"` (`lib/currency.ts:14`), already the defensive identity fallback in `server-context.ts:140`.
- **A "last valid" currency already exists for T1** without any new field: the persisted `Space.reportingCurrency` — the override's "off" position — is always convertible because snapshots are stamped in it (identity path, zero misses). Reverting T1 is literally `setViewOverride(null)`.
- **T2 has no such fallback:** the persisted value itself is the uncovered one, so its revert target must be **USD**. There is no `nativeCurrency`/`lastValidCurrency` field anywhere (native is per-account only).

So the honest, universal revert target is **USD**, which also matches the desired copy ("returned to USD"). T1 could revert to the persisted currency specifically, but USD is correct for both and keeps one rule.

---

## 6. Recommendation — one canonical failure path

**Principle:** the decision belongs at the **display context-build boundary**, where coverage is already computed, not at selection (can't know) and not per-perspective (too late, N places).

### The four required behaviours, mapped to the single choke

1. **Do not display converted-looking values.** Compute a coverage verdict from the built table; if unsatisfiable, build the **identity/native (USD) context** instead of the all-miss target context. With an identity context, no value is a mislabeled pass-through and no snapshot is `fxMiss` — so Wealth/Debt/Liquidity render their **full history in USD** (the false "No history" disappears) and scalar perspectives show honest USD.
2. **Revert to the last valid/native currency.** The substituted context's target is USD (§5). Recommend a **display-time, non-destructive** revert: do **not** overwrite the stored `Space.reportingCurrency`. A cold archive or a missed cron slot is transient (the SWR refresh in `server-context.ts:56` may fill it minutes later); persisting the revert would permanently reset a user's deliberate EUR choice on a temporary gap. The stored preference stays EUR; the *display* resolves to USD until coverage returns.
3. **One non-blocking banner** at the composition root, driven by a `reverted` flag returned alongside `moneyCtx`: *"We couldn't convert this Space into EUR because exchange-rate data is unavailable. We've returned to USD. Contact support if this continues."*
4. **Preserve all calculations.** Guaranteed — the substitution changes only the *conversion target*, never the stored facts or the arithmetic. USD identity conversion is the existing no-op path.

### Concrete shape (design only — no implementation here)

- **Surface the verdict, not new math.** Add a pure coverage summary derived from the resolution table `buildConversionContext` already builds — e.g. `{ needed, missed, satisfiable }` where `satisfiable = needed === 0 || missed < needed` (a target is unsatisfiable only when conversions are needed **and every one** missed). Pure, deterministic, zero FX-math change.
- **One canonical resolver** (pure): `resolveDisplayContext(requested, coverage) → { effectiveCurrency, context, reverted, requested }`. Unsatisfiable ⇒ `effectiveCurrency = DEFAULT_DISPLAY_CURRENCY`, `context = identityContext(USD)`, `reverted = true`.
- **Decide server-side, disclose client-side** — this split is what makes it cover *both* triggers:
  - **Decision at the shared server builder** (`serializeSpaceConversionContext` / `/api/money/view-context`), because that is where the resolution table exists and it is the one place both T1 (override fetch) and T2 (persisted currency page load) pass through. The endpoint returns `{ requested, effective, reverted, moneyCtx }`, substituting the USD identity context when `reverted`.
  - **Disclosure at the client composition root** (`PersonalDashboard`): read `reverted`/`effective`, drive `DisplayCurrencyProvider` to `effective`, render the one banner. For T1 this is equivalent to `setViewOverride(null)`; for T2 it forces USD where the persisted currency was uncovered.
  - *A client-only variant* (coverage check on the `/view-context` payload inside `PersonalDashboard`, per the consumer map) is simpler but handles **T1 only** — shared Spaces and PATCHed-to-uncovered Spaces (T2) would stay broken. Prefer the server-decision form.
- **Writers unchanged** (§3): snapshot regeneration keeps stamping the intended currency (forward-only doctrine); the server `fxMiss` stamp in `getRecentSnapshots` stays. The revert is a **display** contract, not a storage one — a reverted display never rewrites a snapshot.

### What must NOT change (per the brief)

- **No FX math.** The verdict reads existing resolutions; conversion stays byte-identical.
- **No per-perspective fixes.** The `fxMiss`-drop in Wealth/Debt/Liquidity is *correct* for chart integrity and stays — it simply never fires under the reverted identity context, because nothing misses.
- **No new FX authority.** `buildConversionContext` remains the sole builder; the verdict is a projection of its output.

### Guards to add when implemented (regression contract)

1. **Coverage verdict (pure, unit):** all-miss table ⇒ `satisfiable=false`; any hit ⇒ `true`; empty/all-USD ⇒ `true` (no conversion needed, never a false revert).
2. **Resolver (pure, unit):** unsatisfiable ⇒ effective USD + `reverted=true` + `requested` preserved; satisfiable ⇒ pass-through, `reverted=false`.
3. **Non-destructive invariant:** the failure path performs **no** write to `Space.reportingCurrency` (source-scan / behavioural).
4. **Single-choke guard:** the revert decision exists in exactly one module; a source-scan that no perspective re-implements a currency-fallback (prevents the per-perspective drift this contract removes).
5. **Banner-on-revert:** the composition root renders the disclosure iff `reverted` (mirrors the V25-CLOSE-3 `fx-disclosure-surface` guard).

---

## Answers to the posed questions

- **Where is selection validated?** `parseReportingCurrencyInput` (`lib/spaces/reporting-currency.ts:34`), an allowlist test, at `PATCH /api/spaces/[id]`, `PATCH /api/user/profile`, and `GET /api/money/view-context`.
- **Is FX availability known before changing state?** No at write time (allowlist only); **yes at build time** but discarded (`lib/money/context.ts:152`).
- **Which surfaces consume it?** All display perspectives via one shared `moneyCtx` from `/api/money/view-context`; server writers/assemblers build directly (and correctly stay on the intended currency).
- **Can it be reverted centrally?** Yes — at `serializeSpaceConversionContext` / `/api/money/view-context`, with the banner at the composition root. Revert target USD; recommend display-time (non-destructive), leaving the stored preference intact.

**One canonical path, no per-perspective fixes, no FX math change — feasible and located.**

---

# Implementation record (V25-CLOSE-3A)

**Verification:** 323/323 tests, `npm run lint` exit 0, `tsc --noEmit` exit 0, plus browser verification (below). No FX math, no providers, no snapshot writers, no per-perspective FX handling.

## The one canonical decision

Two pure additions carry the whole contract — no new FX resolution:

- `fxCoverageOf(SerializedConversionContext) → { needed, missed, satisfiable }` (`lib/money/convert.ts`) — reads the resolution table the builder already produced. `satisfiable` is false only when conversions are needed AND every one missed (the "€100,000 that is really $100,000" case). Partial coverage stays satisfiable (existing per-value `estimated` disclosure handles it).
- `decideEffectiveCurrency(requested, coverage, fallback)` (`lib/money/convert.ts`) — pure: unsatisfiable ⇒ `{ effective: USD, reverted: true }`; requested-already-USD-but-unsatisfiable ⇒ not a revert (no better floor).

The server resolver `resolveEffectiveSpaceConversion[Serialized]` (`lib/money/server-context.ts`) wraps `buildSpaceConversionContext` + the two pure functions, rebuilding against USD only on revert. **Writers keep calling `buildSpaceConversionContext` directly and stay on the intended currency — only DISPLAY reads resolve the effective one.**

## Why the touch set is what it is

The investigation assumed a client-side context flip would suffice. It does not: `getRecentSnapshots` **pre-converts** snapshots to `Space.reportingCurrency` server-side and stamps `fxMiss` (`lib/data/snapshots.ts:102`); Wealth/Debt/Liquidity then drop `fxMiss` points, so an all-miss currency collapses the series to a false "No history." Flipping only the client context cannot un-break server-pre-converted rows. So the resolver is adopted by the **shared server display readers** — the actual conversion boundary — not the perspectives:

| File | Change |
|---|---|
| `lib/money/convert.ts` | `fxCoverageOf`, `decideEffectiveCurrency` (pure) |
| `lib/money/server-context.ts` | `resolveEffectiveSpaceConversion[Serialized]` — the one resolver |
| `lib/data/snapshots.ts` | `resolveStampContext` resolves effective ⇒ reverted Spaces read history in USD (no false `fxMiss`) — the fix for the "No history" symptom |
| `app/api/money/view-context/route.ts` | returns `{ requested, effective, reverted, moneyCtx }` (primary display context) |
| `app/api/spaces/[id]/transactions/route.ts` | Spend/In summary context reverts too |
| `lib/space/use-space-data.ts` | exposes `currencyReverted / requestedCurrency / effectiveCurrency` from `/view-context` |
| `components/dashboard/SpaceDashboard.tsx` | composition root: nested `DisplayCurrencyProvider(effective)` + effective snapshot currency + the one banner |
| `components/dashboard/CurrencyRevertedBanner.tsx` | the non-blocking disclosure |

Perspectives (Wealth/Cash Flow/Debt/Liquidity/Investments) were **not** touched — the `fxMiss`-drop stays (correct for chart integrity) and simply never fires under the reverted identity context.

## Persistence

Nothing writes `Space.reportingCurrency` on the failure path — verified in code (guard) and in the browser (DB still `EUR` after display + refresh). The stored preference is untouched; only the DISPLAY resolves to USD.

## Tests added

- `lib/money/fx-coverage.test.ts` — coverage (all-miss ⇒ unsatisfiable; any hit ⇒ satisfiable; identity ⇒ valid) and the resolver decision (unavailable ⇒ requested preserved / effective USD / reverted true; valid ⇒ requested==effective / reverted false).
- `lib/money/reporting-currency-failure-contract.test.ts` — persistence (no display reader writes `reportingCurrency`; the PATCH route is the sole writer), one canonical resolver, **no perspective implements its own fallback**, and the banner renders gated on `reverted` with the four required meanings. Mutation-tested (unconditional banner ⇒ fail; a perspective referencing the failure path ⇒ fail).

## UI verification (localhost, Chris' Space — 11 accounts, 730 snapshots; local archive has 0 FX rows, so any non-USD is unavailable)

- **Scenario A** — persisted `reportingCurrency = EUR`, reload: display returned to **USD** ($26,716, identical to the USD baseline — no fabricated €26,716); the banner appeared verbatim ("EUR conversion is temporarily unavailable … We've returned to USD to keep your balances accurate. Your EUR preference is saved and will resume automatically when rates are available."); **Balance History rendered its full Jul 1→Jul 20 series** (the "No wealth history yet" symptom is gone); Wealth composition and all totals showed accurate USD.
- **Scenario B** — refresh: banner + USD display persisted; DB `reportingCurrency` still `EUR` (fallback non-destructive).
- **Control** — restored to USD: no banner, values unchanged.

## Remaining uncertainty

- The **ephemeral "view as" override (T1)** shares the same canonical mechanism (an override target flows through `/view-context` → the same revert), so the main display reverts identically — but I browser-verified the **persisted (T2)** path (the ticket's Scenario A/B, which survives refresh); T1 was not driven end-to-end because its native `<select>` doesn't render in screenshots. A minor known residual under an *active* override: the override control still shows the requested currency as selected and `perspectiveTargetCurrency` still carries it to the lens metrics, while the main display reverts. Not the ticket's scenario; recorded rather than silently accepted.
- The verdict's inputs differ slightly between `/view-context` (accounts+tx+snapshot legs) and `getRecentSnapshots` (snapshot stamp legs); they agree for a genuinely all-miss currency (the failure case). Partial-coverage currencies stay satisfiable in both and keep per-value disclosure.

---

# Follow-up fix (V25-CLOSE-3A-FIX) — selector-path disclosure

Follow-up verification found the fallback worked but **no banner appeared when a
user picked an unavailable currency from the "view as" selector** (the T1
residual noted above). Root cause: `ViewCurrencyOverride` stored
`currency: d.target`, and the response `target` is the **effective** currency
(USD on revert). So the control silently snapped to USD, `useSpaceData` then
re-requested USD, saw `reverted: false`, and the composition-root banner never
fired — the user was not told why the currency changed.

**Fix (disclosure layer only — resolver/FX untouched):** the selector now stores
`currency: d.requested`. An unsatisfiable pick keeps the requested currency as the
display target, so it routes back through the shared `/view-context` verdict and
lights the **same** composition-root `CurrencyRevertedBanner` the persisted path
uses. `moneyCtx` is already the effective (USD) context, so values stay accurate.
No new banner, no per-perspective notification, no second signal.

Guard added: `reporting-currency-failure-contract.test.ts` pins that the selector
stores `d.requested` (regressing to `d.target`/`d.effective` fails).

**Browser-verified (both paths):**
- **Selector (T1):** picking EUR → banner appears verbatim, selector shows "EUR · PREVIEW", values USD $26,716; refresh clears the ephemeral override → no banner (correct).
- **Persisted (T2):** `reportingCurrency = EUR` → banner appears (selector "EUR", no PREVIEW — it is saved), values USD; refresh → banner persists, DB still `EUR`.
- **Control:** USD → no banner.

323/323 tests, lint 0, tsc clean.
