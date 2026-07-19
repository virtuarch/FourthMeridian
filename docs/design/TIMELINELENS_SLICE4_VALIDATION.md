# TimelineLens — Slice 4 Validation Gate (Wealth)

Status: **validation complete**
Date: 2026-07-19
Recommendation: **PROMOTE** — with one open product decision and two documented coverage gaps.

Question this gate answers: *can TimelineLens be trusted as the replacement boundary for canonical time selection?*

---

## 1. Headline

**Yes.** The decisive evidence is a controlled A/B on the same URL with the flag flipped:

| | Flag ON (TimelineLens) | Flag OFF (legacy) |
|---|---|---|
| Net-worth delta | `↑ $23,068 · 353.0% vs Jan 1, 2026` | `↑ $23,068 · 353.0% vs Jan 1, 2026` |
| As-of line | `As of Jun 30, 2026` | `As of Jun 30, 2026` |
| Chart caption | `Jun 30, 2026 vs Jan 1, 2026` | `Jun 30, 2026 vs Jan 1, 2026` |
| Chart SVG area | `267168` | `267168` |
| Chart series path length | `2255` | `2255` |
| Series fingerprint | `M0.0,195.1 L5.6,173.5 L11.2,173.6 …` | *identical* |
| Series tail | `…L1012.0,68.9 L1012.0,238 L0.0,238 Z` | *identical* |
| Data points | 183 circles | 183 circles |
| Completeness / Evidence | `Reconstructed` / `365 snapshots` | `Reconstructed` / `365 snapshots` |
| URL after hydration | `preset=YTD` | `preset=YTD` |

The rendered chart geometry is **byte-identical**. A user cannot tell which control produced the state, because the state and everything downstream of it are the same objects.

One defect was found and fixed during this gate (§7).

---

## 2. Feature flag behavior

| Check | Result |
|---|---|
| Flag ON → lens only | ✅ lens present, legacy slicer/date-inputs/swap all absent |
| Flag OFF → legacy only | ✅ slicer + 1 As-of input + 1 Compare-to input + swap; lens absent |
| No duplicate controls | ✅ exactly one canonical selector in every case |
| No duplicate state ownership | ✅ both paths terminate in the same `shellTimeReducer` via the same shell callbacks |
| Flag switch requires data migration | ✅ none — no persistence exists to migrate (§6) |
| Rollback works cleanly | ✅ flipped OFF mid-session, verified legacy, flipped back ON, verified lens — no reload of anything but the page |

Pinned by a new **rendering** test (`timeline-lens-exclusivity.test.ts`, 22 checks): `wealth` → lens, `cashFlow` → legacy, `null` / unknown → legacy (fail-safe, never "no time control"), and **exactly one** selector in all cases. Source scanning cannot prove this — both selectors legitimately appear in the file, in exclusive branches. Only rendering distinguishes "present in source" from "present on screen".

---

## 3. Canonical parity matrix

### Presets — browser, live data

| Selected | `preset \| asOf \| compareTo` | Readout |
|---|---|---|
| This month | `MTD \| 2026-07-19 \| 2026-07-01` | This month · Jul 1 → Jul 19, 2026 |
| Last 30 days | `PAST_MONTH \| 2026-07-19 \| 2026-06-19` | Last 30 days · Jun 19 → Jul 19, 2026 |
| Last 90 days | `PAST_QUARTER \| 2026-07-19 \| 2026-04-19` | Last 90 days · Apr 19 → Jul 19, 2026 |
| This year | `YTD \| 2026-07-19 \| 2026-01-01` | This year · Jan 1 → Jul 19, 2026 |
| Last 12 months | `PAST_YEAR \| 2026-07-19 \| 2025-07-19` | Last 12 months · Jul 19, 2025 → Jul 19, 2026 |
| All history | `ALL \| 2026-07-19 \| 2025-07-20` | All history · Jul 20, 2025 → Jul 19, 2026 |

Backed by **50 unit parity assertions** (10 presets × 5 starting states) comparing lens-path and legacy-path canonical output through the real reducer — byte-identical in every combination.

### ALL / coverage — the critical case

New test: `timeline-lens-coverage.test.ts`, **68 checks**. Walks the async lifecycle through the real reducer and real derivations.

| Scenario | Result |
|---|---|
| Space **with** coverage | `compareTo = coverageFrom`; readout shows the real span; no caveat |
| Space with **no** coverage | `compareTo = null` — **never fabricated**; readout becomes `As of …` + "Point-in-time · no opening date"; boundary field **empty**, not a placeholder date |
| **Delayed** hydration (t0 → t1) | t0 honest and caveated; coverage lands; t1 resolves to the real span, caveat disappears, `asOf` never moved |
| Re-derive is scoped | a non-ALL preset is unaffected when coverage arrives |
| Deep link `?preset=ALL` before coverage | hydrates to ALL with null `compareTo`; reads as ALL, not as a custom range; honest at first paint |
| Leaving ALL by editing a boundary | → `CUSTOM`, no option active, `asOf` preserved |
| Empty Space, **all 10 presets** | `asOf` always real; each reads back as itself; only ALL may lack an opening boundary; range copy always matches whether a boundary exists |

**No fabricated `compareTo`, and no temporary incorrect range at any point in the lifecycle.**

### Custom boundaries — browser

| Case | Result |
|---|---|
| Valid `from < to` | `custom \| 2026-02-10 \| 2025-11-02` ✅ |
| **Forward comparison** `compareTo > asOf` | accepted and expressible ✅ (`2026-05-20` vs `2026-02-10`) |
| Empty `asOf` | URL **unchanged**, field-level message, reducer **not called** ✅ |
| Future `asOf` | URL **unchanged**, field-level message, reducer **not called** ✅ |
| Malformed (`not-a-date`, `2026-02-30`, `2026-13-01`, `26-01-01`) | all rejected with a message, no action produced ✅ |
| Empty `compareTo` | param dropped — identical to the old ✕ button ✅ |

A rejected intent yields **no action object at all**, so canonical time cannot move to a date the user did not choose.

---

## 4. Navigation

Sequence: `YTD → PAST_YEAR → ALL → Back → Back → Forward → Forward`

| Step | URL preset | Readout | Chart |
|---|---|---|---|
| select PAST_YEAR | `PAST_YEAR` | Last 12 months · Jun 30, 2025 → Jun 30, 2026 | — |
| select ALL | `ALL` | All history · Jul 20, 2025 → Jun 30, 2026 | Jun 30, 2026 vs Jul 20, 2025 |
| Back | `PAST_YEAR` | Last 12 months · Jun 30, 2025 → Jun 30, 2026 | — |
| Back ×2 | `YTD` | This year · Jan 1, 2026 → Jun 30, 2026 | Jun 30, 2026 vs Jan 1, 2026 |
| Forward | `PAST_YEAR` | Last 12 months · Jun 30, 2025 → Jun 30, 2026 | — |
| Forward ×2 | `ALL` | All history · Jul 20, 2025 → Jun 30, 2026 | Jun 30, 2026 vs Jul 20, 2025 |

**Deep link** `?asof=2026-05-15&compareto=2024-02-29&preset=custom` → readout `Custom range · Feb 29, 2024 → May 15, 2026`; panel shows **0 checked** options (correct for custom) while remaining keyboard-reachable (**1 tabbable**). A leap-day boundary hydrated correctly.

**Refresh / flicker.** The hook seeds `MTD` before hydrating from the URL, so a flash of the default was a genuine risk. Polled **every animation frame for 9 s** on a deep link to a non-default range, recording every distinct readout: **exactly one** value was ever rendered — the hydrated one. No flicker to default.

*Structural reason:* the URL-hydration effect runs at mount, while the shell only renders inside `activeTab === "OVERVIEW" && perspectiveEngaged`, which requires loaded data (seconds later). There is no window in which the shell is visible with un-hydrated state.

**No stale local selection anywhere** — the lens stores nothing; it re-derives from canonical state on every render.

---

## 5. Data integrity

TimelineLens changes only `asOf`, `compareTo`, and period intent. Verified unchanged by the flag A/B in §1: net-worth figure and delta, historical chart series (identical SVG path data), completeness tier, evidence count, and the section list.

Structurally guaranteed by the ownership guard (**299 checks**): the component cannot import `@/lib/{perspectives,snapshots,wealth,investments,liquidity,transactions,data}`, cannot read a clock or do calendar arithmetic, and cannot name a canonical preset. No snapshot, valuation, allocation, or reconstruction code was touched by Slices 1–4.

---

## 6. Edge spaces

| Case | Result |
|---|---|
| **Empty Space** (no accounts) | Covered by 40 unit checks: every preset keeps a real `asOf`, reads back as itself, and never claims a range it lacks. No crash path — the lens renders from `timeState` alone and needs no financial data. |
| **New Space / limited history** | ALL resolves from `coverageFrom` or stays null. No fabricated history. |
| **Shared Space / member leakage** | **Structurally impossible.** `usePerspectiveShellState` has **no persistence of any kind** — no `localStorage`, no `sessionStorage`, no cookie. Time state lives only in React state seeded from the URL, per tab, per session. There is no store in which one member's time state could reach another. |
| **Space switch** | Entering a Space resets time to the default (`MTD \| 2026-07-19 \| 2026-07-01`); the previous Space's `asof`/`compareto` did **not** carry over. |

> Incidental finding: `usePerspectiveShellState` declares a `spaceId` parameter that is **never used**. Harmless today (and the reason leakage is impossible), but it implies a scoping that does not exist. Worth deleting or honouring in a later cleanup — **not** in this slice.

---

## 7. Defect found and fixed in this gate

**Arrow keys committed a selection and dismissed the panel.**

The radiogroup used selection-follows-focus (arrow → move → `.click()`). Because choosing a period *applies immediately and closes the panel*, the very first arrow press committed a period and dismissed the UI — so a keyboard user could **never browse** the options. Verified: one `ArrowRight` → `panelStillOpenAfterOneArrow: false`, focus returned to trigger, preset changed.

Fixed to **selection does not follow focus** — arrows move focus only; Space/Enter commits via native `<button>` activation. This is ARIA's prescribed variant when moving selection would trigger an action.

Re-verified after the fix:

| | Result |
|---|---|
| Focus moves `0 → 1 → 2`, `End → 9`, `Home → 0` | ✅ |
| Panel survives arrow browsing | ✅ |
| Preset unchanged while browsing | ✅ |
| Commit applies and closes | ✅ (`WTD`) |
| Focus returns to trigger | ✅ |

Pinned by a guard assertion (arrows must call `.focus()` and must not call `.click()`).

---

## 8. Accessibility

| Check | Result |
|---|---|
| Keyboard can reach and open the lens | ✅ focusable trigger, `aria-haspopup="dialog"`, `aria-expanded` toggles |
| Visible readout available to AT | ✅ `aria-describedby` → the full period + range text |
| Dialog semantics | ✅ `role="dialog"`, `aria-modal="true"`, labelled |
| Focus moves into the panel on open | ✅ |
| Arrow / Home / End navigation | ✅ (after the §7 fix) |
| Selected option announced | ✅ one radiogroup named "Time period", `role="radio"` + `aria-checked`, exactly one checked, exactly one tabbable |
| No option checked under a custom range | ✅ and still keyboard-reachable via the tabindex fallback |
| Errors associate with the correct field | ✅ as-of rejection under *As of*, compare-to rejection under *Compare to* (fixed in Slice 3) |
| Focus returns after close | ✅ |

---

## 9. Mobile

Verified at **500 px** (below the `sm:` 640 px breakpoint, so mobile styles apply):

bottom sheet full-width and bottom-anchored · height-capped · grab handle · footer visible with safe-area padding · content scrolls · minimum touch target **52 px** · options in a 2-up grid over 5 rows · **no horizontal overflow, sheet open or closed** · workspace layout and bottom navigation unaffected.

> ⚠️ **Coverage gap.** Chrome in this environment clamps the window to a **500 px minimum**; requests for 360 × 800 and 390 × 844 both resolved to 500 px. The two target widths in the brief were therefore **not** directly verified. Layout is width-fluid (`w-full max-w-[340px]`, `grid-cols-2`, `truncate` on option labels) and nothing is fixed-width, so no overflow is expected — but this should be confirmed on a real device before broad rollout.

---

## 10. Regression guards added

Doctrine tests, not implementation tests:

| Test | Checks | Protects |
|---|---|---|
| `timeline-lens-exclusivity.test.ts` **(new)** | 22 | Wealth cannot render two time selectors; the lens is the only canonical selector when enabled; unknown/null fails safe to legacy; trust chips survive both paths; the rollout has not silently expanded past Wealth |
| `timeline-lens-coverage.test.ts` **(new)** | 68 | ALL never fabricates a start date, at any point in the async coverage lifecycle |
| `workspace-definition.test.ts` (Slice 3) | 661 | No workspace owns canonical time; the shell selector is never capability-gated; rollback path intact |
| `TimelineLens.test.ts` | 299 | Import/date/vocabulary/token boundaries; the three prior-iteration regressions; arrows do not auto-commit |
| `perspective-time-adapter.test.ts` | 117 | Intent → action → canonical parity |

Suite: **304/305**. The single failure is the pre-existing `MarketingNav`/`Reveal` marketing-boundary check, untouched by this work.

---

## 11. Decisions and open items

1. **OPEN — the one intentional behavior deviation.** Today, emptying the As-of field silently becomes *today*. The lens rejects it with a field-level message instead, per the "no silent fabricated dates" instruction. This is the only known behavioral difference between the two controls. **Needs a product call**; reversible in one line.
2. **Accepted** — arrows no longer carry selection (§7). Deliberate, ARIA-prescribed, and a strict improvement over both the old control and the pre-fix lens.
3. **Deferred** — `usePerspectiveShellState`'s unused `spaceId` parameter.
4. **Deferred** — "Done" button 42 px and `PanelHeader` close 32 × 32, both from shared Atlas primitives; changing them moves every button in the app.
5. **Not verified** — 360/390 px viewports; multi-member shared Space (only one Space exists in this account).

---

## 12. Recommendation

### PROMOTE

The replacement boundary holds. Canonical time authority is unchanged and unchallenged: one reducer, one owner, one selector on screen, and a component that is structurally incapable of becoming a second authority. The flag A/B produced byte-identical financial output, which is the strongest available evidence that this is a presentation swap and nothing more.

Two things temper an unqualified "ship":

- The **as-of coercion decision** (§11.1) should be made before expanding adoption, so all five Perspectives inherit one answer rather than being migrated under an unresolved one.
- The **mobile viewport gap** (§9) should be closed on a real device. It is a verification gap, not a known defect.

Neither blocks promotion of Wealth. Both should be settled before Slice 5 widens the allowlist.

**Next:** hold at Wealth. Cash Flow, Investments, Debt, and Liquidity remain on the legacy control and are separate adoption slices.
