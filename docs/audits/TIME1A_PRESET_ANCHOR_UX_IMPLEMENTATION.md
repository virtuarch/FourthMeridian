# TIME-1A/B/C — Preset Anchor Truth + Present Escape

Status: **implemented.** Legacy controls retained.
Date: 2026-07-19
Doctrine: `TIME1_PRESET_ANCHOR_SEMANTICS_AUDIT.md`

---

## 1. Doctrine preserved — proven, not asserted

The reducer is **unchanged**. `lib/perspectives/time-range.ts` has zero diff. `asOf` remains a persistent anchor; presets remain windows measured back from it.

Previously this was enforced by nothing. Every existing `selectPreset` assertion used a fixture where `asOf === today`, so it passed identically under both models — reversing the reducer broke **zero tests**.

Mutation-tested after TIME-1C. Changing `clampAsOf(state.asOf, today)` → `clampAsOf(today, today)`:

```
=== with reset-on-preset, how many checks fail? ===
27
  ✗ historical YTD keeps the anchor — 2026-07-12
  ✗ historical PAST_YEAR opens one year BEFORE THE ANCHOR — 2025-07-12
  ✗ historical ALL never falls back to today
```

**0 → 27.** The doctrine is now frozen.

---

## 2. Files changed

| File | Slice | Change |
|---|---|---|
| `lib/perspectives/time-range.test.ts` | 1C | +31 non-degenerate anchor assertions |
| `components/atlas/TimelineLens/types.ts` | 1A/1B | `returnToPresent` intent; `anchorLabel` + `anchoredToPresent` on the summary |
| `components/atlas/TimelineLens/TimelineLens.tsx` | 1B | Eyebrow names the anchor instead of "Viewing" |
| `components/atlas/TimelineLens/TimelineLensPanel.tsx` | 1A | Anchor section + "Return to today" |
| `components/space/shell/perspective-time-adapter.ts` | 1A/1B | Intent → `setAsOf(today)`; anchor derivation; anchor-neutral labels |
| `components/space/shell/PerspectiveShell.tsx` | — | `summarize(timeState, today)` |
| 4 test files | 1A/1B/1C | +58 assertions |

**`lib/perspectives/time-range.ts` — unchanged.** No loader, snapshot, calculation, or TransactionQuery file touched.

---

## 3. UX decisions

### 3.1 Anchor presentation — Option A, adapted

Option B ("Window: … / Anchor: …") was rejected: explicit `Window:`/`Anchor:` field labels read like a debug panel, not Fourth Meridian's editorial register.

Option A was adopted with one change — rather than adding a fourth line, **the existing eyebrow carries the anchor**. It previously said "VIEWING", a generic verb doing no work:

```
Before                          After (historical)         After (present)
─────────────────               ────────────────────       ──────────────────
VIEWING                         AS OF MAR 31, 2026         AS OF TODAY
This month                      Month to date              Month to date
Mar 1, 2026 → Mar 31, 2026      Mar 1 → Mar 31, 2026       Jul 1 → Jul 19, 2026
```

Three properties this buys:

1. **The anchor is named, not merely visible.** A bare range shows both dates without saying which one you are standing on.
2. **No new line.** Same three-line instrument; the eyebrow just earns its place.
3. **The anchor is named at the present too** — "As of today", not blank. Doctrine: `asOf`'s present-day value is not "unset", it is "anchored to now".

When historical, the eyebrow renders in `--meridian-400` rather than `--text-faint` — the one state a user can otherwise forget they are in.

### 3.2 Preset labels — targeted change, not a blanket rename

The brief asked for a recommendation before broad changes. Investigated per group:

| Group | Verdict | Action |
|---|---|---|
| **To-date** (WTD/MTD/QTD/YTD) | "This month" **asserts the present** and is categorically false at a historical anchor. At a 2025 anchor, YTD yields 2025's year-to-date labeled "This year." | **Changed** → "Month to date", "Year to date", … Anchor-neutral and exactly `compareToForPreset`'s rule: *from the start of the containing period, up to the anchor*. |
| **Rolling** (PAST_*) | "Last 30 days" reads as relative to the anchor — which is what it is. No falsehood. | **Kept.** "Trailing 30 days" is more precise but colder; renaming would be churn with nothing to fix. |
| **ALL** | "All history" — now unambiguous once the anchor is named ("all history *up to Mar 31*"). | **Kept.** |

Supporting labels for the to-date group were repurposed to state the boundary rule: "From the start of the month", "From January 1".

The old to-date labels are now the *primary* labels — this is the restoration of what the legacy control already had. Legacy showed `WTD`/`MTD`/`1M`/`1Y`, which asserted nothing. The present-tense labels were introduced in Slice 2 and were the regression.

### 3.3 "Today" is an anchor action, not a period

Per the brief, no `Today` entry was added to `PERIOD_OPTIONS`. It is a fifth **intent**:

```
{ type: "returnToPresent" }  →  adapter  →  setAsOf(today)  →  existing reducer
```

An intent rather than the component computing the date, because **the component must not decide what "the present" means**. It has `maxDate` and could have used it — that would have been the component holding a notion of today. The adapter resolves it, consistent with every other intent.

The affordance renders in the panel's **Anchor** section, placed **first**, above the presets — the anchor frames the windows measured from it, so showing presets first would teach the wrong model. It is **not capability-gated**: shell time is shared, so a lens that cannot edit dates can still inherit a historical anchor from another. An exit that is conditionally absent is not an exit.

When historical, the section also states the rule plainly:

> *Every period below is measured back from this date, not from today.*

That sentence is the whole audit, rendered where the confusion happens.

---

## 4. Tests added

| File | Added | Pins |
|---|---|---|
| `time-range.test.ts` | 31 | Anchor survives every preset from a historical `asOf`; each derived boundary is the **anchor-implied** one and **differs from the today-anchored result**; ALL resolves from coverage with no fallback and no fabrication; `setAsOf(today)` returns to the present while preserving the preset |
| `perspective-time-adapter.test.ts` | 21 | Anchor naming both states; **no label matches `/^This\b/`**; `returnToPresent` → existing `setAsOf`; returning preserves the preset and re-derives; **a preset does NOT free you** |
| `timeline-lens-exclusivity.test.ts` | 20 | All five Perspectives name the anchor, present and historical; still state the resolved window; no present-tense claim over a historical window |
| `TimelineLens.test.ts` | 6 | Escape hatch present and ungated; "today" never a period option; readout renders the anchor label |

Totals: `time-range` all passing · adapter **139** · exclusivity **45** · TimelineLens guard **305**.

---

## 5. Verification status — one gap, stated plainly

**Verified:** SSR rendering across all five Perspectives (anchor named in both states, window still stated, no present-tense claim); every semantic path unit-tested through the real reducer; mutation test proving the invariant is enforced; `tsc` and `eslint` clean.

**⚠️ NOT verified: interactive browser testing.** Partway through this slice the browser session became a `SYSTEM_ADMIN` account, and mandatory admin MFA hard-redirects `/dashboard` → `/admin/security?setup2fa=true`. I did not modify the auth state to work around it.

So the following from the brief's verification list were **not** exercised live:

- clicking "Return to today" in a real session
- deep-link → historical anchor → preset, end to end in the browser
- the five-Perspective sweep interactively
- mobile rendering of the new Anchor section

All are covered by SSR/unit tests at the markup and semantic level, but **not** by real interaction. Worth 10 minutes on a customer-account session before this is considered done.

---

## 6. Migration readiness

| Gate | Status |
|---|---|
| Reducer doctrine unchanged | ✅ zero diff, now mutation-proven |
| Anchor explicitly named | ✅ all five, both states |
| Escape hatch exists | ✅ ungated, maps to an existing action |
| Labels make no false claims | ✅ pinned by regex |
| Legacy controls retained | ✅ untouched |
| Suite | 306/307 |

The two failures are outside this work: the pre-existing `MarketingNav`/`Reveal` marketing-boundary check, and `lib/audit.test.ts`, which **passes standalone** and is flaky under the parallel runner — none of the files in §2 touch it.

### Legacy deletion is now unblocked — with one caveat

TIME-1 flagged that legacy's `e.target.value || today` was the de facto escape hatch and deleting it would strand users. **TIME-1A replaces it with a deliberate one**, so that objection is resolved.

The remaining prerequisite is unchanged: **the as-of empty-field decision** (open since Slice 4). It is now lower-stakes — an emptied field no longer traps anyone, because "Return to today" exists — but it should still be settled so all five Perspectives inherit one answer.

**Recommended next:** the live-session verification in §5, then the legacy-control deletion slice.
