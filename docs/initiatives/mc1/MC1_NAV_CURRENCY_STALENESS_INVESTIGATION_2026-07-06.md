# MC1 Navigation Currency-Staleness Investigation — old Space's currency follows into the next Space

**Status:** Investigation only — no code, schema, or behavior changed by this document.
**Date:** 2026-07-06, against the working tree with MC1 QA Q1–Q6 + perf P0 applied.
**Issue (local/dev):** switching the active Space (e.g. "Pay It Off" in JPY/SGD → "Christian's Space") leaves some UI rendering the *previous* Space's currency until a manual browser refresh.
**Constraint:** read-only audit. No currency math, no schema, no writes beyond the existing switch route. Preserve Q1–Q6.

---

## 1. Root cause

**The display-currency source lives in a *shared layout segment* that App Router does not re-render on client-side navigation between the routes under it — and the Space switch is exactly such a navigation. So the provider keeps the previous Space's currency until something invalidates the Router Cache (a `router.refresh()` or a hard reload).**

The chain:

1. `app/(shell)/dashboard/layout.tsx` (server component) resolves the active Space once and mounts the ambient provider:
   ```
   const ctx = await getSpaceContext();          // reads ACTIVE_SPACE_COOKIE
   reportingCurrency = ctx.space.reportingCurrency;
   return <DisplayCurrencyProvider currency={reportingCurrency}>…</DisplayCurrencyProvider>;
   ```
   Every aggregate label reads this via `useDisplayCurrency()` (SpaceDashboard, DashboardClient's `effectiveDisplayCurrency`).

2. A Space switch is a **client navigation within the same `(shell)/dashboard` layout**: `POST /api/space/switch` (sets the cookie) → `router.push("/dashboard")`. **App Router preserves shared layouts across navigation between their child routes — it does not re-execute the layout server component.** So `getSpaceContext()` in the layout is *not* re-run, and `DisplayCurrencyProvider` keeps the old Space's `reportingCurrency`.

3. The **page** (`app/(shell)/dashboard/page.tsx`) *is* a distinct route segment, so it *does* re-run on navigation with the new cookie — it correctly resolves `ctx.space` and computes a fresh `moneyCtx` for the new Space. This produces the tell-tale split: **values/`moneyCtx` update (page re-ran) but the currency *label* stays stale (layout provider did not).** "Old currency follows the new Space."

Only a Router-Cache invalidation re-runs the layout. `router.refresh()` does exactly that; a manual browser refresh does it wholesale — which is why the symptom clears "on manual refresh."

## 2. Why it's intermittent — the two switch entry points disagree

There are two switchers, and only one invalidates the cache:

| Switcher | Flow | Invalidates layout? |
|---|---|---|
| **Sidebar** (`components/ui/Sidebar.tsx` `handleSwitch`, ~L151) | `switch` fetch → `setActiveId` → dispatch `SPACE_LIST_CHANGED` → **`router.refresh()`** → `router.push("/dashboard")` | **Yes** — `router.refresh()` re-runs the shared layout with the new cookie → provider updates. |
| **Spaces page** (`components/dashboard/SpacesClient.tsx` `handleSwitch`, ~L1041) | `switch` fetch → `setActiveId` → dispatch `SPACE_LIST_CHANGED` → `router.push("/dashboard")` | **No** — no `router.refresh()`; the shared layout is reused from the Router Cache → provider stays stale until a manual refresh. |

So switching **from the Spaces grid** reliably reproduces the bug; switching **from the sidebar** mostly does not (it refreshes) — matching "sometimes." Even the sidebar path has a residual **race**: `router.refresh()` is async and `router.push()` can paint the destination from cache before the refreshed RSC (new provider value) lands — a brief flash that self-corrects. The reproducible "stays until manual refresh" case is the Spaces-page path with no refresh at all.

## 3. The Q6 event gap (as suspected)

`SPACE_CURRENCY_CHANGED_EVENT` (Q6) is dispatched **only** by `ManageSpaceModal` when a Space's `reportingCurrency` is **edited in place** (`components/dashboard/ManageSpaceModal.tsx`, guarded by `currencyChanged`). It is **not** dispatched on an active-Space **switch**. SpaceDashboard's Q6 listener (which refetches snapshots/perspectives/transactions on a currency change) therefore never fires on a switch. A switch relies entirely on navigation + (inconsistent) refresh. **Q6 correctly handles "same Space, new currency" but there is no counterpart for "new Space" — this is the missing case.** Note, though, that even a switch event would not by itself fix the *label*, because the label's source is the server-mounted layout provider (see §5).

## 4. Client-state reuse / keying across a switch

Neither host is keyed by the active Space:
- `page.tsx` renders `<SpaceDashboard spaceId=… />` and `<DashboardClient spaceId=… />` **without a `key`**.
- **Same-type switch** (non-personal A → non-personal B, both `SpaceDashboard`): React reuses the one instance and only updates the `spaceId` prop. Its `useState` (`widgetMoneyCtx`, `spaceMoneyCtx`, `snapshots`, `lensResults`) **persists from Space A** until the `spaceId`-keyed effects refetch — a window of stale converted data. The label currency, meanwhile, stays whatever the stale layout provider holds.
- **Cross-type switch** (non-personal → personal): the component type changes (`SpaceDashboard` → `DashboardClient`), so React **remounts** and client state resets. The example ("Pay It Off" → "Christian's Space", the latter PERSONAL) is this case — so here the residual staleness is **purely the layout provider's currency**, not reused client state.

## 5. Does `viewOverride` / displayCurrency state survive incorrectly? — mostly no

- `DashboardClient.viewOverride` (the "view as" override, `useState`, ~L302) is **ephemeral client state** and resets on remount/reload. Across a switch **into** the personal host it starts `null` (fresh mount), so it does **not** carry the old currency. `SpaceDashboard` has **no** `viewOverride` at all — it reads `useDisplayCurrency()` directly. So the override is **not** the culprit for cross-type switches.
- The one theoretical persistence risk is a **same-type** switch where a host instance with a non-null `viewOverride` is reused — but `viewOverride` only exists on `DashboardClient` (personal), and there is a single personal Space, so a personal→personal reuse does not occur in practice. **Conclusion: the surviving state that matters is the server-mounted `displayCurrency` provider value, not `viewOverride`.**

## 6. Summary of root cause + contributing factors

1. **Primary:** `DisplayCurrencyProvider` is sourced in the **shared, cache-preserved layout**, which does not re-run on same-layout navigation — so a Space switch updates the page's values but not the ambient currency label. *(§1)*
2. **Trigger inconsistency:** `SpacesClient.handleSwitch` omits the `router.refresh()` that `Sidebar.handleSwitch` performs, so the Spaces-page switch never invalidates the stale layout. *(§2)*
3. **Race (secondary):** even with `router.refresh()`, `refresh`+`push` can briefly paint stale before the refreshed RSC arrives. *(§2)*
4. **No switch-time refetch/remount:** hosts are not keyed by `spaceId`, and no `SPACE_CHANGED`/switch event exists, so same-type switches reuse stale client state until effects catch up. *(§3, §4)*

---

## 7. Smallest fix plan (recommendation only — not implemented)

Ordered smallest-first; each preserves Q1–Q6, adds no currency math, no schema, and no writes beyond the existing switch route.

**Fix A — parity: `router.refresh()` on the Spaces-page switch (one line, directly matches the symptom).**
Make `SpacesClient.handleSwitch` call `router.refresh()` before `router.push("/dashboard")`, exactly as `Sidebar.handleSwitch` already does. `router.refresh()` invalidates the Router Cache → the shared layout re-runs `getSpaceContext()` with the new cookie → `DisplayCurrencyProvider` re-renders with the new Space's currency. This is precisely what a manual refresh does (minus the full reload), so it removes the "stays until manual refresh" symptom. Lowest risk; mirrors the working sidebar path. Residual: the same brief self-correcting flash the sidebar path already has (addressed by Fix B).

**Fix B — race-free source: let the page own the currency provider (robust, still small).**
The page (`app/(shell)/dashboard/page.tsx`) *does* re-run per navigation and already resolves `ctx.space.reportingCurrency`. Wrap its rendered subtree in `<DisplayCurrencyProvider currency={ctx.space.reportingCurrency}>` (a nested provider overrides the ambient one). Because the page is a fresh segment on every navigation, the currency then tracks the active Space **without depending on `router.refresh()` timing** — eliminating the flash. Keep or drop the layout-level provider as the outer default. This is the true root-cause fix (source the ambient currency where the active Space is resolved per-navigation, not in the cached layout).

**Fix C — key the host subtree by `spaceId` (complement; clears reused state).**
Add `key={ctx.spaceId}` to `<SpaceDashboard>` / `<DashboardClient>` in `page.tsx` so a same-type switch **remounts** the host, discarding stale `widgetMoneyCtx`/`spaceMoneyCtx`/`snapshots`/`viewOverride` instead of waiting for `spaceId`-keyed effects. Complements A/B; does not by itself fix the provider currency.

**Not recommended as the primary fix — a `SPACE_CHANGED` switch event.**
A switch-time event (analogous to Q6's `SPACE_CURRENCY_CHANGED`) could refetch host data, but the currency **label** comes from the server-mounted layout provider, which a client event cannot update without moving the currency source to a client store — a larger change than A/B. An event would address §4's reused *data* but not §1's stale *label*, so it is strictly larger and less targeted than Fix B.

**Recommended combination:** **Fix A** as the immediate minimal change (removes the reproducible symptom), plus **Fix B** for race-free correctness; add **Fix C** if same-type Space→Space switches show any residual stale client data. A alone is the smallest defensible fix; A+B is the smallest *robust* one.

## 8. Validation gates (for the eventual fix)

1. **Cross-type switch, from the Spaces grid:** active JPY/SGD Space → personal USD Space via the Spaces page renders **USD labels immediately**, no manual refresh, no flash of the old currency.
2. **Cross-type switch, from the sidebar:** same result, and the pre-existing brief flash is gone (Fix B) or acceptably absent.
3. **Same-type switch** (non-personal JPY → non-personal SGD): headline/aggregate labels and hero/panels show the **new** Space's currency; no stale converted values from the previous Space survive past first paint (Fix C).
4. **All-USD invariance:** switching between all-USD Spaces is visually unchanged (labels were USD before and after).
5. **Q1–Q6 intact:** in-place currency edit (Q6) still live-updates without reload; per-Space card currencies (Q5/Q5b), fxMiss guard (Q4b), and itemized-row currencies unchanged.
6. **No new writes:** only `/api/space/switch` writes (cookie + audit), unchanged; `router.refresh()` issues reads only.
7. `npx tsc --noEmit`, `npm run lint` (4-warning baseline), `npm test` (kd17 sandbox baseline) green.

---

*End of investigation. No code, schema, or data was modified. Root cause and fix plan only, per scope.*
