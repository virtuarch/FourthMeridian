# Atlas Glass Unification — Step B Migration Checklist

**Status:** Checklist / investigation only. **No implementation, no code edits, no card migrated.** Approval gate before any Step B work.
**Date:** 2026-07-03
**Scope (approved):** plan the surface-by-surface migration of legacy dashboard cards onto `DataCard` / Atlas Glass. Account-type accent decision; migration order; files per commit; ratchet burn-down; validation; rollback.
**Depends on:** Step A (complete) — `DataCard` exists, tokens `--text-faint`/`--surface-inset`/`--accent-{positive,negative,neutral,info}` exist in both themes, palette-ratchet baseline captured (35 files, 1338 violations).
**Evidence base (read for this checklist):** `components/ui/Card.tsx`, `components/atlas/DataCard.tsx`, and the actual card sources — `AccountCard.tsx`, `AccountGroupCard.tsx`, `NetWorthCard.tsx`, `InvestmentsCard.tsx`, `FicoCard.tsx`, `CashOnHandCard.tsx`, `DebtCard.tsx`, `SummaryStatCard.tsx` — plus `lib/atlas/palette-ratchet.baseline.json` and caller grep (`DashboardClient`, `DebtClient`, `app/(shell)/dashboard/accounts/page.tsx`).

**Difference from Step A, stated up front:** Step A was zero-pixel by design. **Step B intentionally changes rendered pixels** — the card *material* changes (gray → Atlas Glass) and the decorative *rainbow* is removed. What Step B must NOT change is *layout, spacing, composition, data, or behavior*. "No visual chaos" therefore does not mean "no visual change"; it means **every surface flips as a consistent whole, one material, verified per surface.**

---

## 0. Structural findings that drive the plan (from the code)

**F1 — There is a shared intermediate card.** `CashOnHandCard` and `DebtCard` do not use `Card` directly; both render through **`SummaryStatCard`**, which wraps `Card`. Migrating `SummaryStatCard` once migrates both consumers' material in lockstep. This is leverage: treat `SummaryStatCard` as a mini-primitive.

**F2 — The "rainbow" enters through three distinct channels**, and they carry different risk:

| Channel | Where | Examples | Coupling |
|---|---|---|---|
| **Card-internal map** | inside the card | `AccountCard.colors` (checking→blue…), `FicoCard.getScoreColor` (band ramp) | card-local — safe |
| **Caller-injected `color` prop** | parent passes a tailwind class | `AccountGroupCard color=` (from `DashboardClient`, accounts page) | reaches a host — riskier |
| **`valueClassName` / lib** | prop + `lib/summary-status.ts` returns classes | `DebtCard` state red/emerald, `CashOnHandCard` `text-violet-400`, `status.className` | reaches a lib — medium |

**F3 — Two separable concerns per card.** (a) **Material** — `Card`→`DataCard` + gray-scale classes → ink tokens; always **card-local**, low risk. (b) **Color-semantics** — the rainbow decision; **card-local** where the color map is internal (F2 row 1), **caller-coupled** where it is injected (F2 rows 2–3). *Rule: migrate material + card-local color together; defer caller-coupled color removal to explicit, named caller commits.* This is what keeps commits small and hosts untouched.

**F4 — Financial state vs. decorative type are different uses of color.** `emerald`/`red` on gains, losses, and debt-owed are *state* (meaningful, Law 7). `blue`/`violet`/`yellow` on "Liquid", "Brokerage Cash", "Stocks", "Crypto", account-type icons, and FICO "Good/Fair" bands are *decorative type/label* — arbitrary hue per category. The accent decision (§1) hinges entirely on this split.

**F5 — Leaf cards can migrate without touching the two hosts.** `DashboardClient`/`SpaceDashboard` render `<AccountCard/>`, `<NetWorthCard/>`, etc. Swapping a leaf card's internals does **not** require editing the host that renders it — *unless* the host injects a `color` prop (only `AccountGroupCard` does). So the constraint "don't touch DashboardClient/SpaceDashboard" is honorable for nearly every card, and the one exception (`AccountGroupCard`'s injected color) is deferred and isolated.

---

## 1. Account-type accent decision (Q3)

**Recommendation: account *types* become neutral (ink-first); only financial *state* uses color.** Adopt the user's proposed "mostly neutral" option — it is the safest and the most doctrine-aligned, and it dissolves both token collisions.

Final mapping:

| Legacy | Meaning | Step B treatment |
|---|---|---|
| checking → `blue` | type/label | **neutral** — `var(--text-primary)` value, ink icon (`--text-secondary`) |
| savings → `emerald` | type/label (NOT gain) | **neutral** — ink. (Reserve emerald for actual gain only.) |
| investment → `violet` | type/label | **neutral** — ink |
| crypto → `yellow` | type/label | **neutral** — ink |
| debt → `red` (as a *type* icon) | type/label | **neutral** — ink |
| other → `gray` | type/label | **neutral** — ink (already) |
| gain / positive delta | **state** | `var(--accent-positive)` (emerald-400) |
| loss / debt-owed / negative delta | **state** | `var(--accent-negative)` (coral-400) |
| interactive link / info | affordance | `var(--accent-info)` (meridian) — only where a real link/control exists |

Why this is the safest option:

- **It removes the two unresolved collisions outright.** Crypto→brass (would spend the AI/premium scarcity, Law 7) and checking→meridian (would muddy "meridian = interactive") simply disappear — crypto and checking become ink, no decision needed.
- **The type signal is not lost.** Type is already carried by the icon *shape* (`Building2`, `PiggyBank`, `Bitcoin`, `CreditCard`) and the label. The hue was redundant. Removing it makes the surface calmer and more ink-first (the ≥90%-Ink law), which is the premium direction.
- **Color becomes rare and meaningful.** After Step B, a spot of green or coral on the dashboard *always* means gain/loss — a real signal — instead of "this account happens to be crypto." That is the doctrine's "color is the exception, not the texture."

**Two deliberate sub-decisions (flagged, not silently resolved):**

- **FICO band ramp** (`getScoreColor`: excellent→emerald, good→blue, fair→yellow, poor→red, plus `bg-*` bar fills). This is a *status ramp*, not account type. Recommendation: collapse the 4-hue rainbow to a restrained **3-step** — excellent→`--accent-positive`, poor→`--accent-negative`, good/fair→**neutral ink** (the number + "Good"/"Fair" label already communicate the band). This keeps credit legible without importing blue/yellow. Alternative if product wants the 4-band feel: keep FICO as an **explicitly deferred special case** (its own later commit, its own token proposal). Either way, FICO is *not* migrated in the first wave. Note the ratchet does not currently catch `bg-emerald-400`-style *fills* (only `bg-gray-*`); FICO's bar fills must be migrated by grep/visual, and §7 optionally extends the regex.
- **`SummaryStatCard` API.** Today it takes `valueClassName`/`messageClassName` as raw tailwind strings. Recommendation: replace with a semantic `accent?: DataCardAccent`/`tone` enum so callers pass *meaning*, not a class — this is the structural guard against the rainbow re-entering via props, and it is the one place a card's prop *signature* changes (done with its two callers in the same commit, §6).

---

## 2. Migration unit (Q2) — argue for one

**Migrate by component (bottom-up through the shared-primitive graph); sequence and QA by dashboard surface.**

- **Not by page** — a page (`DashboardClient`, 88 violations of its own) pulls many cards *and* has its own host-level layout classes; migrating "a page" conflates card material with host layout and produces a huge, unreviewable diff — the chaos risk.
- **Not by Space type** — Space type is a composition concern, not a material one; a card looks the same in a Personal vs. Household Space. Irrelevant axis for material.
- **Not "pure surface, all at once"** — too coarse for small commits (Q7).
- **Component, bottom-up, is the smallest safe unit** — start at the shared leaves (`SummaryStatCard`, then leaf cards), because a leaf has one job and a tiny diff, and shared intermediates give leverage (F1). **But order the components so that every card co-appearing on a given surface migrates before that surface is QA-signed** — you may split a surface across 2–3 commits on a branch, but the *visual-QA gate and merge* for a surface happens only when that whole surface is one material. That reconciles "small reviewable commits" (component) with "never ship a half-glass screen" (surface).

One sentence: **commit by component, gate by surface.**

---

## 3. Migration order — what first (Q1)

Ordered by *leverage ÷ risk*. Wave 1 = smallest, most self-contained, highest-leverage, no host coupling.

**Wave 1 — the summary-stat family (highest leverage, card-local).**
`SummaryStatCard` (4) + `CashOnHandCard` (1) + `DebtCard` (4) + `lib/summary-status.ts` (state classes). One shared primitive + its two consumers + the lib that feeds their state color. Self-contained, tiny, exercises material + state-accent + the `valueClassName`→`accent` API change on the smallest surface. **This is what to migrate first.**

**Wave 2 — the canonical leaf.**
`AccountCard` (11). Self-contained (internal `colors` map, F2 row 1 — card-local). Proves the icon-accent-neutral decision. No caller coupling. Represents the accounts surface.

**Wave 3 — the hero summary cards (card-local color).**
`NetWorthCard` (11), `InvestmentsCard` (11). State colors (emerald/red delta) → accent; decorative Liquid-blue / Stocks-violet / Crypto-yellow → ink. Card-local; no host edit.

**Wave 4 — the special ramp.**
`FicoCard` (25) — its own commit + the §1 band decision.

**Wave 5 — the caller-coupled card.**
`AccountGroupCard` (4) — material + ink tokens first (card-local); its `color` *prop removal* is a separate, named commit that touches callers (`DashboardClient`, `app/(shell)/dashboard/accounts/page.tsx`). This is the one card whose full migration reaches a host, so it is late and split.

**Wave 6 — the drawer (material only).**
`AssetDrawer` (26) — migrate *material* to Atlas Glass only. **Do not** fix its behavior (it is a centered modal masquerading as a drawer; the edge-anchored redesign is an Interaction-Doctrine item, out of Step B scope). Flag the behavior debt; migrate the surface.

**Wave 7 — Space widgets (the non-Personal surface).**
`components/space/widgets/*` (SummaryWidget 19, ProgressWidget 27, BreakdownWidget 16, AssetValueWidget 19, TimelineWidget 27) + `DebtPayoffSection` (87, material-only — Step C will revisit for the instrument). Their own commits, QA'd on the Space dashboard.

**Explicitly deferred past Step B (NOT card surfaces):**
`DashboardClient` (88), `SpaceDashboard` (197), and the big client pages `DebtClient` (146), `InvestmentsClient` (78), `BankingClient` (69), `AnalyzeClient` (71), `ArchivedAssetsClient` (78), `SettingsClient` (49), `TotpSection` (107), and the modals (`AccountModal` 27, `AddManualAssetModal` 3, `ManageSpaceModal` 1). These are **host/page/modal layout**, not cards — their raw palette is section headers, wrappers, and form chrome, a different (larger) migration. They remain baseline-tracked after Step B (see §7).

---

## 4. What `DataCard` replaces — class → token map (Q4)

Applied uniformly across every migrated card:

| Legacy class | Replacement |
|---|---|
| `Card` container `rounded-2xl border border-gray-700 bg-gray-900 p-4` | `<DataCard>` (defaults reproduce the box) |
| `Card className="!p-3"` (compact, `AccountGroupCard`) | `<DataCard padding="var(--space-3)">` |
| `Card className="col-span-2"` (`NetWorthCard`) | `<DataCard className="col-span-2">` (grid class is layout, preserved) |
| `CardTitle` (`text-xs uppercase tracking-widest text-gray-400`) | `<DataCard title>` / `DataCardTitle` |
| `text-white` | `var(--text-primary)` |
| `text-gray-400` (labels) | `var(--text-secondary)` |
| `text-gray-500` (row labels) | `var(--text-secondary)` (or `--text-muted` where quieter) |
| `text-gray-600` (Updated / 300–850 / min) | `var(--text-faint)` |
| `border-gray-700`, `border-gray-700/60` (dividers) | `var(--border-hairline)` |
| `bg-gray-700` (FICO progress track) | `var(--surface-inset)` |
| `bg-gray-800` (icon chip) | `var(--surface-inset)` |
| **state** `text-emerald-400` (gain) | `var(--accent-positive)` |
| **state** `text-red-400` (loss / debt-owed) | `var(--accent-negative)` |
| **decorative** `text-blue-400` / `text-violet-400` / `text-yellow-400` | `var(--text-primary)` (neutral — rainbow removal, §1) |
| **status ramp** FICO band `text-/bg-{blue,yellow}-400` | neutral ink (good/fair) — §1 sub-decision |
| icon glyph accent (`AccountCard.colors`) | `var(--text-secondary)` (ink) |

Notes: prefer inline `style={{ color: "var(--…)" }}` or a token-mapped class the codebase already uses; do **not** introduce a new raw hue. `DataCardTitle` already resolves to `--text-muted`, matching the legacy `CardTitle` intent.

---

## 5. What stays inert (Q5) / what becomes interactive (Q6)

**Audit rule:** a card becomes `interactive` **iff** it has a real click target on the *card itself* today (a `Card onClick=` on the container). Everything else stays inert (`DataCard` default `interactive={false}` — no hover lift).

- **Inert (default `DataCard`, no lift):** `AccountCard`, `NetWorthCard`, `InvestmentsCard`, `CashOnHandCard`, `DebtCard`, `FicoCard`, `AccountGroupCard`, `SummaryStatCard`, and all Space widgets. These are display data. **Do not add hover motion** — a lift here promises a click that does not exist (Interaction Doctrine §2). This is the single most important anti-chaos rule of Step B.
- **Interactive (`interactive` + `onClick`/`as="a"`):** only cards that today pass `onClick` to `Card`. From the read set, **none of the leaf cards do** — inner controls (`AccountCard`'s `ReconnectAccountButton`, `FicoCard`'s "Add score" `<a>`) are *children*, not the card. So **Wave 1–4 add zero interactive cards.** Before flipping any card to `interactive` in later waves, grep its callers for `Card onClick=`; only then set `interactive` + a keyboard-focusable host (`as="button"`/`role`).
- **The inner links** (FICO "Add score" `<a href>`, Reconnect button) keep working unchanged; their `hover:text-blue-300` → `--accent-info` hover, but the *card* stays inert.

---

## 6. Commit plan (Q7) + files per commit (Q8)

Small, reviewable, one wave (often one card) per commit. Each migration commit also carries its **lowered ratchet baseline** (§7).

| Commit | Scope | Files likely touched |
|---|---|---|
| **B0** | Ratchet tooling: add `--update` (ratchet-down) mode; optionally extend regex to `bg-{accent}` fills | `lib/atlas/palette-ratchet.test.ts` |
| **B1** | Wave 1 — summary-stat family (material + state-accent + `valueClassName`→`accent` API) | `SummaryStatCard.tsx`, `CashOnHandCard.tsx`, `DebtCard.tsx`, `lib/summary-status.ts`, baseline |
| **B2** | Wave 2 — `AccountCard` (material + icon→ink) | `AccountCard.tsx`, baseline |
| **B3** | Wave 3a — `NetWorthCard` | `NetWorthCard.tsx`, baseline |
| **B4** | Wave 3b — `InvestmentsCard` | `InvestmentsCard.tsx`, baseline |
| **B5** | Wave 4 — `FicoCard` (+ band decision) | `FicoCard.tsx`, baseline |
| **B6** | Wave 5a — `AccountGroupCard` material only (keep `color` prop working) | `AccountGroupCard.tsx`, baseline |
| **B7** | Wave 5b — remove `color` prop, callers pass neutral/accent | `AccountGroupCard.tsx`, `DashboardClient.tsx`, `app/(shell)/dashboard/accounts/page.tsx`, baseline — **first host touch; isolated, justified** |
| **B8** | Wave 6 — `AssetDrawer` material only (behavior untouched) | `AssetDrawer.tsx`, baseline |
| **B9…** | Wave 7 — Space widgets, one per commit | each `components/space/widgets/*.tsx`, baseline |
| **B-final** | Retire `Card`/`CardTitle` once no consumer remains; flip ratchet card-scope to strict-zero (hosts/pages remain baseline) | delete/retire `components/ui/Card.tsx`, `lib/atlas/palette-ratchet.test.ts`, baseline |

`DashboardClient`/`SpaceDashboard` are touched **only** at B7, and only for the `AccountGroupCard` `color`-prop removal — the checklist "proves necessary" gate the task set. If B7's caller change turns out larger than a prop swap, split it further; do not bulk-migrate host layout classes in Step B.

---

## 7. Palette-ratchet burn-down (Q9)

- **Mechanism:** add an `--update` mode to the guard (B0). Workflow per migration commit: (1) run the guard in check mode — it must PASS (nothing increased); (2) run `--update`, which rewrites the baseline to `min(current, baseline)` per file and **drops files that reached 0**, but refuses to write if any file increased; (3) commit the migrated card **and** the lowered baseline together. The baseline only ever ratchets *down*.
- **Never strict-zero in one pass.** The baseline shrinks commit by commit. Files leave it as they hit 0 (e.g., after B1, `CashOnHandCard`/`DebtCard`/`SummaryStatCard` drop out).
- **Strict-zero is a *scoped* endgame, not Step B's end.** After all *card* files are at 0, the baseline still legitimately contains **host/page/modal** entries (`DashboardClient` 88, `SpaceDashboard` 197, `DebtClient` 146, …) which are *not* Step B's job. So the B-final flip to strict-zero applies to the **card set only**; hosts/pages stay baseline-tracked for a future step. Do not delete the baseline while host/page entries remain.
- **Coverage caveat:** the regex catches the common cases (`bg-gray-*`, `border-gray-*`, `text-gray-*`, `text-<hue>-*`) but not `bg-<accent>-*` fills (e.g. FICO bars). Either extend the regex in B0 or verify those by grep in QA; do not assume a green ratchet means a file is fully token-pure.

---

## 8. Visual QA (Q10)

Per migrated surface, **before/after screenshot comparison**, asserting *material changed, layout/spacing/data did not*:

- **Personal dashboard** (`DashboardClient` host) — AccountCard, NetWorth, Investments, CashOnHand, Debt, FICO render as one Atlas Glass material; no inert card lifts on hover; deltas still green/coral; the removed rainbow reads calmer, not broken.
- **Space dashboard** (`SpaceDashboard` host) — Space widgets consistent (Wave 7).
- **Accounts surface** (`accounts/page.tsx` / `BankingClient`) — AccountCard, AccountGroupCard; grouping/totals unchanged.
- **Debt surface** (`DebtClient`, `DebtCard`) — state colors correct; debt-owed = coral, credit balance = positive.
- **Investment surface** (`InvestmentsClient`, `InvestmentsCard`) — value + breakdown; Stocks/Crypto now ink, delta still state-colored.
- **Mobile** — card padding/legibility at narrow width; **no hover state triggered on touch**; compact variants (`AccountGroupCard compact`, `FicoCard compact`) preserved.
- **Light theme** — the Step A tokens (`--text-faint`, `--surface-inset`, accents) meet contrast on light glass; state colors still legible (bump accents to -500 already done for light — confirm); no white-on-white surfaces.
- **Reduced motion** — no new motion introduced (cards inert); confirm still frame is complete.
- **Per-commit gate:** `tsc` clean, `npm run lint` clean, ratchet green + ratcheted down, and the surface QA above signed before merging that surface's final card.

---

## 9. Rollback plans per commit (Q11)

- **Every migration commit is `git revert`-safe in isolation.** `DataCard` and the tokens already ship (Step A) and `Card.tsx` stays present until B-final, so reverting any B1–B9 commit restores that card's legacy `Card` usage and raw classes exactly, and the paired baseline revert restores the higher count in the same operation. No data, schema, or behavior is involved.
- **B7 (host touch)** reverts to `AccountGroupCard` still accepting the `color` prop and the callers still passing it — self-contained.
- **B-final** (retire `Card.tsx`, strict-zero flip) is the only commit whose revert restores a deleted file; because it lands *after* all consumers migrated, reverting it simply brings `Card.tsx` back unused. Keep it last and separate so it is trivially reversible.
- **Runtime degradation:** none needed — there is no flag; a bad card is reverted, not toggled. Because migrations are per-card, a problem on one surface never blocks another.

---

## 10. What must explicitly NOT change in Step B (Q12)

- **No layout, spacing, grid, or composition change.** Material swap only. `DataCard` defaults reproduce the `Card` box; `!p-3`→`padding` and `col-span-2`→`className` preserve geometry exactly. If a migration would move anything, stop and re-scope.
- **No data or behavior change.** Same props semantics, same computed values, same rows. The single sanctioned *signature* change is `SummaryStatCard`'s `valueClassName`→`accent` (B1), done with its callers, rendering the same state colors via token.
- **No `DashboardClient`/`SpaceDashboard` edits except B7's isolated `color`-prop removal** — and never their host layout classes (those are a later, separate migration; their baseline entries persist).
- **No new interactive/hover on inert cards** — the cardinal anti-chaos rule (§5).
- **No Liquid Glass** — no refraction, displacement, chromatic aberration, curvature, or draggable anything.
- **No Debt living instrument** — `DebtPayoffSection` is material-only in Wave 7; no slider, no `simulatePayoff` wiring (Step C).
- **No `AssetDrawer` behavior change** — material only; it stays a centered modal (behavior debt flagged, deferred to the Interaction-Doctrine work).
- **No brass/`glow`** borrowing — `DataCard` does not expose it; keep the AI/premium accent scarce.
- **No schema, no migrations, no new dependency.**
- **No strict-zero ratchet flip while host/page entries remain** (§7).
- **No modal-family migration in the card waves** (AccountModal/AddManualAssetModal/ManageSpaceModal are a separate surface class; defer).

---

*End of checklist. Investigation/planning only — no implementation performed, no card migrated, no code edited. Awaiting approval to begin Step B, starting at commit B0 (ratchet `--update` tooling) then B1 (the summary-stat family). Each commit is small, surface-gated, ratchet-down, and revert-safe. Stop here per brief.*
