# Space Dashboard Doctrine — Interaction & Motion

**Status:** Investigation only — no code, schema, migration, or UI changes. This document synthesizes five parallel investigations into a single governing record for how a Space dashboard behaves under the hand: hover, expansion, modals, animation, charts, scroll, loading, skeletons, empty states, and mobile gestures.
**Date:** 2026-07-03
**Constraint:** Keep Atlas Glass. Every rule below is expressed in tokens that already ship — no new motion system is proposed.
**Companion:** `SPACE_DASHBOARD_DOCTRINE.md` governs the *visual language* (weighting, hierarchy, whitespace — "premium is legible priority"). This document is its kinetic counterpart: how that surface moves. Where the two touch, this one defers to it on layout weight and extends it into time.
**Predecessors:** `SPACE_DASHBOARD_PHILOSOPHY_INVESTIGATION.md` (the ledger metaphor, the fused hero unit, the honesty ladder) and `SPACE_DASHBOARD_FUTURE_INVESTIGATION.md`. This document does not re-argue what those settled; it goes one layer more concrete — from *what the dashboard is* to *how it moves*.
**Evidence base:** `components/atlas/{GlassPanel,GlassButton,SegmentedControl,InlineFilter,tones}.tsx`; `components/dashboard/widgets/{GlassModal,KpiRow,SpaceTrendHero,SpaceTimelineWidget,SpaceMembersWidget,TimelineModal,SpaceComingSoonPanel}.tsx`; `components/dashboard/{DashboardClient,SpaceDashboard,AccountCard,AssetDrawer,RefreshButton,AddManualAssetModal,CreateSpaceModal,ManageSpaceModal,AccountModal}.tsx`; `components/charts/{NetWorthChart,NetWorthChartModal,CashChart,InvestmentsChart,AllocationChart,HoldingsDonutChart,PortfolioHistoryChart,TradingViewChart,ChartFirstDayPlaceholder}.tsx`; `components/brief/{BriefModal,DailyBriefClient,EarthBackground,BriefNewUser}.tsx`; `components/ui/{DashboardChrome,Sidebar,BottomNav}.tsx`; `app/globals.css:342–354` (reduced-motion kill-switch); `docs/design-system/Fourth-Meridian-Design-Language-v1.html` (motion tokens 99–114, reduced-motion 193 & 838, hover/pulseRing 272/284/321/429/437).

---

## 0. The one law behind all ten questions

Every dimension below resolves to the same sentence, which is worth stating before any rule:

> **Motion is permitted only to report a change in state — where a thing came from, where it went, or that it is alive. Motion is forbidden as decoration.**

This is the ledger metaphor made kinetic. The predecessor investigation argued that opening a Space should feel like *opening a ledger kept faithfully in your absence* — trustworthy, chronological, complete. A ledger does not perform. So the test for any interaction is not "is it delightful?" but "does it tell the user something true they would otherwise have to infer?" An animation that answers *this panel grew from that tile*, *this data is refreshing*, *this control responds to you* earns its place. An animation that says *look how nice this glass is* competes with the numbers and is cut.

Three corollaries carry the whole document:

- **Affordance is a contract.** A surface moves under the pointer *if and only if* it does something. Motion that promises interactivity the surface doesn't have is a lie, and inert stillness is the correct default for display data.
- **Numbers do not perform.** Financial figures never bounce, roll, spring, or pulse. Overshoot on a net-worth number is a slot machine; mid-roll it displays values that were never true. Headlines cross-fade or snap; they never animate their magnitude.
- **Reduced motion is a first-class rendering, not a fallback.** Everything here must be fully usable, and fully *readable*, with animation entirely absent. The affordance and the information must survive in the still frame.

The rest of this document is that law applied ten times.

---

## 1. The material fact that shapes everything: two card systems, one language

The single most important evidence finding, shared across all five investigations, is that the dashboard currently ships **two card materials side by side**, and they move differently.

The newer information architecture renders through **Atlas Glass** (`GlassPanel`): the KPI strip (`KpiRow`), every Brief card, Perspectives widgets, and the Space cards on the landing page. Its hover is defined once, in `GlassPanel.tsx`: `transition-[transform,box-shadow,background-color]` at `var(--dur-base)` / `var(--ease-standard)`, with a single `hover:-translate-y-[1px]`, a specular top-edge highlight, and an optional ambient `glow`. This is the quiet, correct end of the motion range.

The legacy per-account cluster (`AccountCard`, `AccountGroupCard`, `InvestmentsCard`, `DebtCard`, `FicoCard`, `NetWorthCard`) renders through `components/ui/Card.tsx` — raw `bg-gray-900 border-gray-700`, raw palette colors, and **no hover motion at all**. `AssetDrawer` is the sharpest violation: named a drawer, laid out as a centered modal, built from hardcoded `bg-gray-900`/`text-gray-*` — the one surface in the app that could not survive an Atlas Glass token change.

This matters for a doctrine of motion because **material migration and motion are separable, and must be kept separate.** Moving `AccountCard` onto `GlassPanel` is correct and overdue; it must not smuggle in a hover lift. A card earns motion from *what it does*, never from *what it's made of*. The rule that follows (§2) is the enforcement mechanism.

---

## 2. Hover behavior

**Doctrine: hover motion is an affordance contract, priced in one of three tiers.**

Evidence: `KpiRow` already models the correct coupling — it passes `interactive` and switches its host tag to `button` *in the same condition* that an `onClick` exists. Hover feedback and click capability are wired together by construction, so a KPI tile that goes nowhere also doesn't move. The failure mode to refuse is the incumbent one: a hover lift on every card because the card component supports it.

Three tiers, and nothing between them:

1. **Inert (no hover motion).** Display data that leads nowhere — the per-account balance cards. Their current stillness is correct; migrating them to Atlas Glass must preserve it. A lift here promises a click that doesn't exist.
2. **Default lift (the primitive).** Anything that opens something: `GlassPanel interactive` — `hover:-translate-y-[1px]`, `transform/box-shadow/background-color` at `var(--dur-base)` / `var(--ease-standard)`, paired with `hover:bg-[var(--surface-hover)]`. `active:translate-y-0` gives the press its settle (as `GlassButton` already does). This is the workhorse; most interactive cards want exactly this and nothing more.
3. **Expressive lift (destinations only).** Reserved for cards that navigate to a *new context* — the `SpacesClient` Space cards ("pick a room"). Here a `-3px` lift plus the specular-edge brighten is defensible, because the brightening edge makes the raised geometry read as real. But drop the one-off `scale(1.014)` and the diagonal sheen-sweep this component currently ships: a light sweep on every card is precisely the performative motion the voice forbids inside a Space. Never exceed `-3px` on a dashboard card; the design language's `-6px .hover-card` is a spec demo, not a dashboard token.

**Where hover improves comprehension:** it answers "is this clickable?" truthfully, and the specular brighten reinforces the glass as a physical, light-catching material when a card actually lifts.

**Where it becomes noise:** any lift on inert data; ambient `glow` triggered by hover (glow is *identity* — AI, premium, investments — not pointer feedback; conflating them teaches the wrong association); sheen sweeps and scale on dashboard cards.

**Reduced motion:** the affordance must not live in `transform` alone. Because the global rule collapses transition *duration* to `0.01ms`, a reduced-motion user still needs the *background/opacity* change to register "this is interactive." Encode the signal redundantly.

---

## 3. Card expansion

**Doctrine: a card either lifts-to-navigate or unfolds-in-place — one metaphor per surface, never both — and it never teleports.**

Evidence: three expansion paths exist and none animate. A `KpiRow` tile opens a `GlassModal` that mounts instantly; a row opens `AssetDrawer` with no transition; `KnowledgeAcquisitionCard` swaps a one-line prompt for a full form with a hard content replace that jumps the surrounding layout.

- **Lift-to-navigate (tile → modal).** This is the one place entrance motion *is* comprehension, not garnish: a fade + `scale(0.98→1)` from the tile's origin tells the user the modal and the tile are the same fact at two zoom levels — number first, provenance on expansion, which is the product's core reading order. `--dur-base` / `--ease-enter` in, `--dur-fast` / `--ease-exit` out. Never `--ease-spring`: a financial sheet that bounces reads as playful/urgent.
- **Unfold-in-place (prompt → form).** A height/opacity transition at `var(--dur-base)` / `var(--ease-standard)`, so the form *unfolds* from the prompt rather than replacing it and jerking the layout. The prompt and form are the same task; continuity preserves the user's place.

**Self-disagreement, recorded:** the app ships zero animation libraries, and a CSS-only mount transition for a conditionally-*mounted* element is famously fiddly (render at `scale(0.98)`, transition on the next frame). `BriefModal` already solves this with a `requestAnimationFrame` `entered` flag — that pattern, not a library, is the reference. But if a given surface can't do it without stutter, **an instant, trustworthy modal beats a janky animated one.** Ship no motion before shipping jank. A true shared-element morph (the tile literally growing into the modal) is the most comprehension-rich and the most fragile; fade+scale from the tile's approximate origin captures ~80% of the spatial benefit at ~10% of the cost, and is the recommendation. Shared-element is a "later, if it earns it" item.

---

## 4. Modal philosophy

**Doctrine: rank surfaces by how far they remove the user from the ledger — inline < drawer < modal < routed page — and make each step be earned.**

Evidence: three-and-a-half modal families ship and they do **not** share a shell. `BriefModal` is the reference — portal, `role="dialog"` + `aria-modal`, scroll lock, ESC + backdrop close, and a real rAF entrance (backdrop opacity, panel `translateY(10px)→0` + `scale(0.97→1)` at `--dur-base` / `--ease-enter`). `GlassModal` is billed as the shared shell but is consumed only by `TimelineModal` and has no entrance, no ESC, no focus management, no `role`. Six more modals (`NetWorthChartModal`, `AccountModal`, `AddManualAssetModal`, `AddWalletModal`, `CreateSpaceModal`, `ManageSpaceModal`) hand-roll `fixed inset-0` + `GlassPanel` — visually one family, behaviorally six one-offs. So the surfaces converge on the *look* and diverge on the *behavior*, which is exactly backwards.

The placement rules:

- **Inline** is the default for *more of the same record*: a KPI revealing its delta, a timeline row expanding, an account row disclosing sub-balances. If the content is the ledger continuing, it must not leave the ledger.
- **A drawer** earns its place when the user inspects one entity *while the list stays visible* — drill into an asset with the dashboard still behind it. This is what `AssetDrawer` should be (edge-anchored, Atlas Glass, dashboard visible) and isn't (centered, non-glass). A drawer preserves "where am I"; a modal severs it.
- **A modal** earns its place only for a focused, self-contained *task* or a full-attention *read* that genuinely wants the world dimmed: create/manage a Space, add a wallet or manual asset, the full-attention chart or Timeline. The test: *does the user need to stop being in the Space to do this?*
- **A routed page** earns it when the work is sessional and deep — the "Perspectives explore" tier. Depth that survives a refresh, is linkable, and owns a back button belongs in the URL, not a modal.

**What must never be a modal on a finance dashboard:** the primary number/trend (the hero is the ledger's face and must never require a click); an *attention* item as a blocking interrupt (a broken connection is surfaced in place — a calm product does not throw a modal to perform urgency); confirmations of non-destructive reads; and anything the user will want to *compare against the dashboard* (comparison needs both visible, which is a drawer's job). Modals are for tasks and full-attention reads. **They are never for state.**

**The convergence to make:** fold `BriefModal`'s entrance + focus/ESC/aria into `GlassModal`'s layout API, and retire the hand-rolled six. Recorded counter-position: "don't touch working modals for no functional gain" is defensible — but the current split guarantees the next modal is a seventh one-off, so the seam is a real liability, not a cosmetic one.

---

## 5. Animations — the motion vocabulary

**Doctrine: one enter/exit grammar, keyed to Atlas Glass tokens, applied uniformly; ambient motion is near-zero by intent.**

The tokens already imply the grammar; the codebase simply hasn't applied it evenly. Per-class defaults:

| Surface class | Enter | Exit |
|---|---|---|
| Modal (task/read) | opacity + `translateY(8–10px)` + `scale(0.97→1)`, `--dur-base` (240ms) `--ease-enter` | `--dur-fast` (180ms) `--ease-exit` |
| Backdrop scrim | opacity 0→1, `--dur-base` `--ease-enter` | `--dur-fast` `--ease-exit` |
| Drawer | slide from edge, `--dur-moderate` (320ms) `--ease-enter` | `--dur-base` `--ease-exit` |
| Inline expand | height/opacity, `--dur-base` `--ease-standard` | same |
| Hover / micro-state | `--dur-fast` `--ease-standard` (already the norm) | same |
| Bottom-sheet snap-back | `--ease-spring` — the *one* sanctioned overshoot | — |
| Ambient (Earth, if ever) | `drift`, `--dur-ambient` (2400ms) / 30–40s loops, sub-perceptual | n/a |

**The ambient finding worth defending:** the design language specifies a `drift` animation for the hero Earth, and `EarthBackground.tsx` deliberately *doesn't move* — the sun position is computed once in `useMemo` and never re-runs. The shipped choice is the *more correct* one. A slowly drifting planet behind a net-worth figure is atmosphere that competes with content; the still, cinematic Earth reads as "faithfully kept," not "performing." Keep it still. Treat `drift` as a token available to other surfaces, not a mandate for the hero. Any `pulseRing`-style pulse on a finance figure is noise: a pulsing balance implies an urgency the number rarely warrants.

**Where animation improves comprehension:** modal/drawer enter-exit (spatial origin), inline expand (continuity), the 1px hover-lift (affordance), honest loaders during real waits (liveness). All of these *report state*.

**Where it becomes noise:** `--ease-spring` on finance numbers; animated count-ups (the design language's odometer is charming but on a ledger a rolling number performs, and mid-roll it lies); ambient drift behind the hero; decorative pulses.

---

## 6. Chart interaction

**Doctrine: interaction serves the fused unit — number + delta + trend — by tying the pixel back to the number and the date, and does nothing else. The chart must be fully readable with zero motion.**

Evidence: charting splits cleanly. **Recharts** drives every first-party series (`NetWorthChart`, `CashChart`, `InvestmentsChart`, `BankingChart`, `PortfolioHistoryChart`, `SpaceTrendHero`, `NetWorthChartModal`); **two hand-built SVG donuts** (`AllocationChart`, `HoldingsDonutChart`) own their hover; **TradingView** embeds a full third-party toolbar for a single security's price — a different grammar, never used for the Space's own trend. Today the charts expose hover tooltips and an `activeDot`, discrete interval pills (7D/1M/3M/6M/YTD/1Y), and series toggles — but **no vertical crosshair, no scrubbing, no brush, no zoom.** And critically, no chart sets `isAnimationActive={false}`, so every line inherits Recharts' default ~1.5s draw-in *on every mount and every interval change*, on a curve that isn't one of our `--ease-*` tokens.

- **Improves comprehension:** a real **crosshair** — a thin vertical rule at the pointer plus a readout that drives the hero's headline to that date's value — is the single highest-value addition. It makes "how did I get here?" legible without reading an axis; it *is* the fused unit made interactive (`--dur-fast` / `--ease-standard` on the readout). **Scrubbing** is the mobile-correct form of the same idea: mobile *inverts the ratio, not the order* — the hero is number+sparkline, the full chart is one tap deep, and tap-to-inspect with a persistent readout beats hover (which doesn't exist on touch). Desktop keeps hover; both drive the *same* readout. A single **honest draw-in** (left-to-right reveal at `--dur-slow` / `--ease-standard`) is defensible on *first mount only*.
- **Becomes noise (refuse):** the default Recharts animation as shipped — un-tokenized, and re-firing on every interval toggle so switching 1M→3M re-animates a line the user is trying to read; it *delays* comprehension. Replace with a tokened, once-only draw-in or disable it. Animated count-ups on the headline (keep `tabular-nums` static). Easing that misrepresents data: `type="monotone"` already invents curvature between sparse snapshots, and spring/overshoot on the draw would compound the lie — `SpaceTrendHero`'s use of `stepAfter` for manually-updated series is the honesty to extend. Zoom/brush nobody needs: interval pills already answer "what window?"; leave zoom to `TradingViewChart` where a security's price warrants it.

**Reduced motion:** no draw-in (chart renders complete on mount), crosshair snaps without transition, every value/axis/delta/readout reachable by tap or hover with animation absent. The two hand-built donuts currently use inline `transition: … 0.15s` in raw milliseconds outside any reduced-motion guard — that drift should be reconciled to tokens.

**Self-disagreement, recorded:** if scrubbing rewrites the hero number, "where am I *today*" briefly stops being visible. Likely resolution — the *delta chip* updates on scrub, the *headline* snaps back to latest on release — but that needs a design call, especially where the delta framing is inverted (debt: down-good). And `PortfolioHistoryChart` uses `trigger="click"` where every other chart uses `hover`; someone may have made a deliberate touch-legibility bet that actually argues *for* tap-to-lock over scrub. Reconcile before standardizing.

---

## 7. Scrolling behavior

**Doctrine: the dashboard is a document. Free scroll, sticky chrome only, no scroll-triggered reveals, contained nested scroll.**

Evidence: the shell (`DashboardChrome`) is one ordinary scrolling `<main>` under a sticky glass header, with a fixed mobile `BottomNav` and a sidebar that pins its brand row. There is **no scroll-snap, no `scroll-behavior`, no `IntersectionObserver`, no scroll-triggered reveal anywhere**, and tab changes use `router.replace(…, { scroll: false })` to hold position. Nested scroll exists only inside modals, whose bodies are `overflow-y-auto` with pinned header/footer — but with **no `overscroll-behavior: contain`**, so a flick past the end chains to the page behind.

- **Do not sticky the hero.** The hero is the Space's identity, but the page is a ledger read top-to-bottom, and the slot order (hero → attention → change → modules → doorways) is a *reading order*, not a set of pinned panels. Pinning the hero steals vertical space on mobile from the very rows it summarizes. The already-sticky *chrome* is the right amount of persistence — orientation without motion.
- **No scroll-triggered reveals on the ledger.** Fade-up-on-scroll turns a record into a slideshow, delays numbers the user came to read, and re-fires on scroll-back — the opposite of "kept faithfully in your absence." The one defensible use is deferring off-screen chart *work* for cost (mount/animate on enter-view), which is a performance decision invisible to the user, never a decorative reveal.
- **Contain nested scroll.** Add `overscroll-behavior: contain` to every modal and drawer body. Trust native momentum; do not script it. Honor iOS safe-area under the fixed `BottomNav` (the existing `pb-24` reserves the space).

---

## 8. Loading states

**Doctrine: distinguish cold load from background refresh from mutation, and never let a "loading" costume hide a true number or fabricate freshness.**

Evidence: there is no shared skeleton primitive; the dashboard is overwhelmingly spinner-based (a `Loader2` census across `SpaceDashboard`, `SpaceTrendHero`, the widgets, and every mutation button). The lone real skeleton is `BriefSkeleton` in `DailyBriefClient.tsx`, hand-rolled and unexported. The genuine strength is the *honesty* plumbing: `ChartFirstDayPlaceholder` (real number, "history starts today," with a `height` prop so layout doesn't jump), and freshness stamps (`dataUpdatedAgo` / "Updated {date}") computed with a null server snapshot so SSR renders nothing and the client fills in at hydration.

Three regimes, three rules:

- **Cold load (nothing on screen).** The weakest spot today (a bare centered spinner). A finance cold load benefits from a **skeleton of the known shell** — the section order is deterministic from the registry before any account data arrives — but skeleton only the *deterministic chrome* (hero frame, KPI strip, panel stack), and let data regions that might be empty resolve to their honest empty state rather than to phantom rows. Keep the bare spinner only for sub-second single-widget fetches (members, timeline).
- **Background refresh (data already on screen).** The honesty-critical case. **Never replace true, already-rendered numbers with a spinner or skeleton** — that hides real data behind a loading costume and implies the shown figure is untrustworthy. Keep the numbers; mark the *refresh* on the button; update the freshness stamp. A refresh must resolve to one of *fresh* / *unchanged* / *on cooldown, still as-of {old date}* — **never a green check that implies new data landed when none did** (the Plaid investigation flags a live cooldown bug that mislabels a *skipped* refresh as "Synced"; loading UI built on top inherits that lie until the response body is actually read).
- **Mutation (user added an account / asset / goal).** Buttons already do the right thing: disable, icon→spinner, verb label ("Adding asset…"). **Optimistic UI is dangerous here** — an optimistically-inserted balance is a fabricated number until the provider confirms it. Optimistic updates are acceptable only for provably-local, non-numeric mutations (reorder, rename, toggle a section). Nothing numeric is asserted before it can be defended.

The three-way distinction to encode explicitly: **loading ≠ stale ≠ empty.** The code separates loading from empty from first-day well; "stale" is the one still under-served (only passive "Updated 2 hr ago" text). Stale is a *truth* state, not a loading state, and must never be shimmered — a nine-day-old last point needs to be visible *at the chart*, not just in the header.

---

## 9. Skeletons

**Doctrine: skeleton only what you know will be non-empty and whose dimensions you know; match final height exactly; static-fill by default, shimmer as a slow ambient exception.**

**Skeletons help** when the final layout's dimensions are knowable ahead of data (the registry-derived hero, KPI strip, and panel stack), when they buy layout stability, and on a genuine multi-second cold load. `BriefSkeleton` matching `BriefHero`'s `clamp()`, and `ChartFirstDayPlaceholder`'s `height` prop, are the two precedents to codify as an invariant: **skeleton height = final content height, no exceptions.**

**Skeletons deceive** in four cases that violate the house rule and are therefore banned: (1) skeleton of data that may be *empty* — three shimmering transaction rows before you know the account has transactions fabricates the shape of a populated ledger; on a new Space, go straight to the honest empty state; (2) shimmer as decoration (the pulsing dot in `AdviceBanner`, "urgent" red pulses — the performative register the voice rejects); (3) skeleton on instant local data (KpiRow deltas, tab switches derived synchronously from loaded props — this flashes a fake load on data that's already true); (4) skeleton during background refresh (covered in §8 — it demotes true numbers to placeholders).

**In Atlas Glass tokens:** skeletons render *as* glass — muted fills via `var(--glass-thin)` / `var(--glass-ultrathin)` / `var(--ink-800)` inside a `GlassPanel depth="thin"`, so the placeholder is a calm member of the card system, not a bare rectangle. Any shimmer runs at `--dur-ambient` (2400ms) with `--ease-standard` — the same slow tempo as `pulseRing`, calm not strobe. **Under `prefers-reduced-motion: reduce`, a skeleton is a static muted fill — no shimmer at all**, not a stopped frame of one (the current `animate-pulse` usages do not honor this and would keep pulsing).

**Self-disagreement, recorded:** for a ledger product, a static muted fill with the layout scaffold may be *more* on-brand than any shimmer — arguable that **static-fill should be the default and shimmer the opt-in**, inverting the usual convention. And skeleton-vs-spinner for cold load is genuinely contested: a spinner is honestly "I have nothing yet," while a skeleton *implies a shape* before data confirms it. The hybrid (skeleton the deterministic chrome, spinner-or-empty the data regions) is the working recommendation but risks looking unfinished. Finally, `DashboardClient` and `SpaceDashboard` have divergent loading code; any shared skeleton must be built once and mounted in both, or the doctrine forks on contact.

---

## 10. Empty states

**Doctrine: an empty state must say *why* it is empty, never fabricate content to fill the void, and never use urgency or guilt. Motion or illustration is permitted only to signal a *beginning*.**

Empty states are already a first-class, well-developed concern — the codebase's real strength. `ChartFirstDayPlaceholder` refuses to draw a near-empty chart and shows the real number instead; `SpaceTrendHero`'s honesty ladder is spelled out in its header (`loading → spinner`; `0 points → render nothing`; `1 point → headline + "history starts today"`; `2+ → headline + honest delta + trend`, and "no baseline → no delta at all"); `OverviewSetupCard` shows *one calm setup card* instead of a column of identical "share accounts to see X" cards, with copy that explains rather than exhorts ("sections appear as their data exists").

The taxonomy the app half-practices and should generalize into five distinct states:

1. **New / day-one** — the shipped pattern: real number if one exists, "history starts today," one calm setup CTA. This is the *one* place a gentle entrance fade (`--dur-base` / `--ease-enter`) or a single small illustrated icon *improves comprehension* — it signals "a beginning, not a failure."
2. **Filtered-empty** (data exists, the filter/tab/range excludes it) — must be visually and verbally distinct from #1: "Nothing matches this filter" + a one-tap "Clear filter," never a setup CTA (which would gaslight a user who has plenty of data). No illustration; minimal opacity cross-fade only, because the user is toggling filters rapidly and bouncing illustrations become noise.
3. **Permissioned-empty** (data exists but the viewer's role hides it) — already seeded ("Once an Owner or Admin shares accounts…"). Explain the boundary, name the scope, never show an action the viewer can't perform. No guilt, no illustration.
4. **Error-empty** (the fetch failed) — **the real gap.** `GoalsCard` swallows non-ok responses (`.then(r => r.ok ? r.json() : [])`), so a 500 renders as "No goals yet" — a dishonesty bug that fakes emptiness. Treatment: a calm "Couldn't load this right now" + Retry, visually separated from true emptiness. Never an illustration (it would celebrate a failure), never "⚠️ act now."
5. **Loading / not-yet** — already correct: a quiet, height-matched spinner so nothing jumps when data lands.

**The honesty rule for empties** is the through-line: distinguish new from filtered from permissioned from error; fabricate nothing; and refuse urgency — "⚠️ act now" is explicitly banned by the voice ("calm, not urgent; explain then suggest, never demand"). Empty surfaces are always `GlassPanel depth="thin"` so an empty reads as a calm member of the card system, not a broken hole; migrate the remaining raw `text-gray-*` empties to tokens.

---

## 11. Mobile gestures

**Doctrine: every gesture is net-new, so each must clear a high bar — accelerate a visible control, never be the sole path, and never be destructive without confirmation.**

Evidence: the app ships **zero custom gesture handling** — no touch/pointer handlers, no drag libraries, no framer-motion. It relies entirely on native scroll and tap. Refresh is a button, not a pull. `AssetDrawer` renders a grabber pill that *looks* draggable but has no drag handler — it dismisses only via X, backdrop tap, or Escape. Navigation is four `<Link>`s with no edge-swipe. The only "touch" code is the passive `touch-manipulation` CSS utility.

**Gestures that earn their place:**

- **Pull-to-refresh → manual sync.** The highest-value add: it maps a universally-understood gesture onto an action that already exists (`RefreshButton`), non-destructive and idempotent, with a self-documenting native affordance. Keep the button too, for discoverability, desktop parity, and reduced-motion. Ship it *with* an honest "Updated {date}" stamp so the gesture doesn't promise freshness the backend can't always deliver instantly.
- **Bottom-sheet drag-to-dismiss.** `AssetDrawer`/`TrashDrawer` already render the grabber pill — the affordance is a promise the code doesn't keep, which is itself an honesty violation. Wire real drag with a snap threshold (settle on `--ease-spring`, the one sanctioned overshoot). Non-destructive: dismissing a read-only inspector loses nothing. (The alternative honest fix — *remove* the pill — is inferior; leaving it inert is the one clearly-wrong option.)
- **Tap-to-inspect the chart.** The full chart is "one tap deep" per the mobile hero philosophy; a deliberate tap from the number+sparkline hero to the full chart, with a persistent readout, is legible and safe.

**Gestures that are noise or hazard — do not add:** swipe-to-delete an account or goal (a mistaken swipe destroys the very data the product protects; keep destructive actions behind the explicit `⋯` menu, behind the existing soft-delete trash); hidden edge-swipe tab navigation (undiscoverable, collides with the browser back-gesture and horizontal chart panning); long-press as the *only* path to an action (acceptable only as an accelerator duplicating a visible control).

**Three governing rules:** *No destructive gesture without confirmation* — anything that hides, deletes, unshares, or moves money must be non-destructive or route through confirm/undo, never fire on release alone. *Discoverability* — a gesture may only accelerate an action that also has a visible, tappable control. *Reversibility* — prefer gestures whose worst outcome is a re-tap (dismiss, refresh, inspect) over ones whose worst outcome is data loss.

**Touch targets:** establish a **44×44px minimum** for every interactive control (currently undefined; `--space-9: 48px` is the natural token). Today's 12px icon buttons in `GoalMenu`/`TrashDrawer` violate this and should get padded hit areas without growing their glyph.

---

## 12. The motion budget, on one page

| Dimension | Motion earns its place when… | Motion is noise when… |
|---|---|---|
| Hover | it signals a real click affordance (`-1px`; `-3px` for destinations) | it lifts inert display data, or sweeps/scales/glows for decoration |
| Card expansion | it shows the modal grew from the tile (fade+`scale(0.98→1)`) | it teleports, bounces (`--ease-spring`), or hard-swaps and jumps layout |
| Modals | a task or full-attention read genuinely wants the world dimmed | it blocks to perform urgency, or holds *state* that belongs inline/drawer |
| Animation | it reports where a thing came/went or that it's alive | it's ambient drift behind the hero, or a spring/roll on a number |
| Charts | a crosshair ties the pixel to the number and date | count-ups, re-firing draw-ins on every toggle, zoom nobody needs |
| Scrolling | chrome stays oriented; native momentum | sticky hero, fade-up reveals, uncontained overscroll |
| Loading | it marks a *refresh* without hiding true numbers | a spinner/skeleton replaces already-true data, or fakes "Synced" |
| Skeletons | dimensions are known and content is known non-empty | it implies a shape that may be empty, or shimmers as decoration |
| Empty states | it signals a *beginning* (day-one only) | it illustrates a filter/error/permission gap as deficiency or guilt |
| Mobile gestures | it accelerates a visible, non-destructive control | it is the sole path, hidden, or destructive-on-release |

---

## 13. Cross-cutting laws

1. **Affordance is a contract.** Move under the pointer if and only if there is a click. Never encode the affordance in `transform` alone — it must survive the reduced-motion still frame as an opacity/background change.
2. **Numbers do not perform.** No spring, roll, bounce, or pulse on any financial figure. `tabular-nums`, cross-fade or snap.
3. **Never fake freshness or fullness.** A refresh resolves to fresh / unchanged / on-cooldown-as-of-old-date — never a green check for a skipped sync. A skeleton is never rendered for data that might be empty. An error is never rendered as an empty.
4. **Reduced motion is a first-class rendering.** The global rule (`app/globals.css:342`) collapses durations to `0.01ms` for `*`, but it is *blunt* — it kills duration while leaving the starting `transform` in place, so a reduced-motion user can glimpse the pre-transition state snapping. The disciplined pattern is a reduced-motion branch that drops to **opacity-only, no transform**, rather than trusting the clamp to hide the seam. Ambient loops stop; shimmer becomes static fill; `--ease-spring` overshoot is removed; charts render complete; gestures still function but their settle is a 1-frame cross-fade.
5. **One primitive per pattern.** The current split — surfaces that share a *look* but hand-roll their *behavior* — is the standing liability across modals, skeletons, and loading. Fold behavior into the shared primitive (`GlassModal` gets `BriefModal`'s entrance; one skeleton primitive mounted in both dashboard hosts) or the doctrine forks on every new surface.

---

## 14. Open questions carried forward

- **Does the app add a mount-transition mechanism at all?** Recommendation: the `BriefModal` `requestAnimationFrame` pattern, not a library — but where it can't be done without stutter, ship instant. Trust beats motion.
- **Crosshair vs. the fused hero.** If scrubbing rewrites the headline, "where am I today" briefly disappears. Working answer: delta chip updates on scrub, headline snaps back on release — needs a design call, especially for inverted (debt) framing.
- **Tooltip trigger inconsistency.** `PortfolioHistoryChart`'s `trigger="click"` may be a deliberate touch-legibility bet that argues *for* tap-to-lock over scrub. Reconcile before standardizing.
- **Should the Earth ever move?** Design language says `drift`; shipped code says still; the voice says still. This doctrine says still — recorded as a judgment call, not a proof.
- **Static-fill vs. shimmer as the skeleton default.** For a ledger, static may be the more honest default with shimmer as opt-in — an inversion of convention worth a deliberate decision.
- **Error-empty coverage.** The `GoalsCard` swallowed-error case is confirmed; a full sweep of `.then(r => r.ok ? … : [])` sites is needed to size the gap.
- **Two unconverged hosts.** `DashboardClient` and `SpaceDashboard` diverge on loading/freshness plumbing; any shared primitive must land in both at once.

---

*End of doctrine. Investigation only — no implementation. Every rule above is grounded in a shipped file and expressed in an existing Atlas Glass token; nothing here proposes a new motion system, only the disciplined, uniform application of the one already in the repo.*
