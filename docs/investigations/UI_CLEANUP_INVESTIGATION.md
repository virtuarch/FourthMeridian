> **INVESTIGATION / CHECKLIST ONLY — no code.** Three approved UI cleanups: (1) one consistent Daily Brief backdrop, (2) dark-mode only, (3) Daily Brief reuses the app-wide top-right menu. No schema/routes/auth/FlowType/Spaces-redesign changes. Preserve all behavior except the approved decisions. Smallest plan only.

# Fourth Meridian UI Cleanup — Investigation & Checklist

**Headline finding:** the three items **interlock**. The Daily Brief's own menu (`components/brief/UserMenu.tsx`) is the *only* place that exposes both the **region override** (item 1's "location" switch) and the **light/system theme toggle** (item 2). So replacing it with the app-wide menu (item 3) removes both controls for free — and the remaining work is two tiny "pin the value" edits.

---

## Item 1 — Daily Brief backdrop switches by location

### Evidence
- `components/brief/BriefHero.tsx:219,232` — `const { effectiveRegion } = useHeroRegion();` → `<EarthBackground region={effectiveRegion} theme={resolvedTheme} />`.
- `effectiveRegion` is derived from the viewer's **IANA timezone** (`lib/hero-region.ts`, `heroSrcForRegion(region, theme)`), with a per-session **user override** set from `UserMenu`'s Region control (`HeroRegionProvider`).
- `EarthBackground.tsx:98,105` — `region?: HeroRegion | null` where **null/undefined = the default wide Earth crop** (a single canonical backdrop already exists).

### Decision + smallest fix
Stop passing `effectiveRegion`; pass a **fixed** region. Smallest: `region={null}` in `BriefHero.tsx` → the default wide Earth everywhere. (Combined with item 2, `theme` is also fixed → fully consistent.)
- **Product micro-decision:** which single crop is "the" backdrop — recommend the **default wide Earth (`region={null}`)**; alternatively pin a chosen named region constant.

### Files
- `components/brief/BriefHero.tsx` — pin `region`; drop the now-unused `useHeroRegion()` read (one call).
- *(Consequential dead code, optional later cleanup — not required):* `HeroRegionProvider.tsx`, `lib/hero-region.ts` region-resolution, and `UserMenu`'s Region control become unused once item 3 lands.

---

## Item 2 — Light mode

### Evidence
- `components/theme/ThemeProvider.tsx` — the whole theme axis: `mode` (`dark|light|system`, localStorage `fm-theme-mode`), `resolvedTheme` applied to `html[data-theme]`. **Default is already dark** (bare `html` selector in `globals.css` = dark; server + first paint are dark).
- **Only exposure of the toggle:** `components/brief/UserMenu.tsx:61-62,129,204-213` — the "Appearance — Midnight Glass / Light Glass / System" section calling `setMode(...)`. No other `setMode` caller exists (grep-confirmed).
- **Read-only** `resolvedTheme` consumers (safe, will just render dark): `AppLogo.tsx`, `AccountModal.tsx`, `BriefHero.tsx`, `BriefLogo.tsx`, `EarthBackground.tsx`, `AtlasField.tsx`.
- Light styling lives in `globals.css` (`html[data-theme="light"]` token block ~`:238-265`, `.atlas-globe-light`, `.is-balanced` light overrides) and `isLight` branches in a few components.

### Decision + smallest safe fix
**Pin `resolvedTheme = "dark"`** in `ThemeProvider.tsx` (one-line change to the resolved-theme computation), so `data-theme` is always dark and no consumer ever sees light. **Do not touch the light tokens/CSS or `isLight` branches** — they become dead but harmless; removing them is larger and risks breaking token references. The toggle UI is removed by **Item 3** (the only `setMode` caller is `UserMenu`).
- Keep the `ThemeProvider` API (`mode`/`setMode`) intact so existing imports don't break; only `resolvedTheme` is pinned.

### Files
- `components/theme/ThemeProvider.tsx` — pin `resolvedTheme` to `"dark"`.
- *(Toggle removal handled by Item 3. If Item 3 is deferred, instead remove the Appearance section from `UserMenu.tsx` so no dead toggle ships.)*
- **Not touched:** `app/globals.css` light tokens (left as safe dead code).

---

## Item 3 — Daily Brief top-right menu differs from the rest of the app

### Evidence
- **Brief menu:** `components/brief/UserMenu.tsx` (250 lines) — nav links (My Space, Analyze with AI, Settings), **Appearance** (theme toggle), **Region** control, Sign out. Mounted in `app/(brief)/dashboard/brief/layout.tsx:46`.
- **App-wide menu:** `components/ui/UserButton.tsx` (96 lines) — Connect Account / Add Wallet, Settings, Sign out. Mounted in `components/ui/DashboardChrome.tsx:101`. Self-contained (`useSession`, `signOut`, viewport-`fixed` dropdown) — **portable into the Brief header**, no `DashboardChrome` dependency.

### Decision + smallest fix
In the Brief layout, **replace `<UserMenu />` with `<UserButton />`** (swap the import + the one JSX usage). This makes the Brief inherit the standard menu and, as a bonus, deletes the region + theme controls (items 1 & 2 synergy).

### Files
- `app/(brief)/dashboard/brief/layout.tsx` — import `UserButton` instead of `UserMenu`; render `<UserButton />`. Optionally drop the now-unused `HeroRegionProvider` wrapper *only if* item 1 has pinned the region (else keep it so `BriefHero` still resolves).
- *(Dead after swap, optional deletion later):* `components/brief/UserMenu.tsx`.

### Behavior deltas to accept (call out for product)
- Brief menu **gains** Connect Account / Add Wallet; **loses** the My Space / Analyze quick links, Appearance toggle, and Region control.
- `UserButton`'s visual style is the **legacy gray palette** (gray-900/700), not Atlas glass — matching "the rest of the app," which is the stated goal. If a later pass restyles `UserButton` to Atlas glass, it upgrades everywhere at once (out of scope here).
- Dropdown is viewport-`fixed` (`top-[58px] right-3`); verify it sits sensibly under the Brief's taller header.

---

## Recommended implementation slices (smallest, independently revertible)

| Slice | Change | Files |
|---|---|---|
| **U1 — Consistent backdrop** | pin `region={null}` in `BriefHero`; drop `useHeroRegion()` read | `components/brief/BriefHero.tsx` |
| **U2 — Dark only** | pin `resolvedTheme="dark"` in `ThemeProvider` | `components/theme/ThemeProvider.tsx` |
| **U3 — Shared menu** | swap `UserMenu` → `UserButton` in the Brief layout | `app/(brief)/dashboard/brief/layout.tsx` |

**Sequencing:** U3 should ship **with or before** U2 so no dead theme toggle is visible (U2 alone would leave `UserMenu`'s Appearance control clickable-but-inert). U1 is independent. Recommended order: **U3 → U2 → U1**, or all three together (they touch disjoint files). Each is one small, isolated edit.

**Deliberately deferred (not required for the decisions):** deleting `UserMenu.tsx`, `HeroRegionProvider.tsx`, `lib/hero-region.ts` region logic, and the light-mode CSS/tokens. All become dead but safe; removing them is a separate, larger cleanup with its own risk surface.

---

## Risks & rollback

| Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|
| A `resolvedTheme` consumer relied on light branch rendering | Low (all read dark cleanly) | pin-only; leave light CSS/branches intact | revert `ThemeProvider` one-liner |
| `UserButton` looks/positions wrong in Brief header | Medium (different style/header height) | visual check; dropdown is viewport-fixed | revert layout import swap → `UserMenu` returns |
| Losing Brief's My Space/Analyze quick links surprises users | Medium (behavior delta) | confirm with product; those nav paths still exist elsewhere | revert layout swap |
| Pinned backdrop is the "wrong" crop | Low | product picks the single crop (default wide Earth recommended) | change the one constant |
| Dead code left (`UserMenu`, region provider) | None (inert) | intentional; flagged for later cleanup | n/a |

Every slice is a **single-file, few-line edit** → rollback is `git checkout <file>` per slice. No schema, data, routes, or shared tokens touched.

---

## Validation plan

- [ ] `npx tsc --noEmit` + `npm run lint` — clean after each slice.
- [ ] **U1:** load Daily Brief in several timezones (or with a region override attempt) → backdrop identical every time; the default wide Earth renders; no console errors from an unused `useHeroRegion`.
- [ ] **U2:** `data-theme` on `<html>` is always `dark`; set `localStorage.fm-theme-mode="light"` and reload → still dark; no light tokens ever apply; `AppLogo`/`BriefLogo`/`AccountModal`/`AtlasField` all render dark.
- [ ] **U3:** Brief top-right opens the same menu as the rest of the app (Connect/Wallet/Settings/Sign out); Settings link + Sign out work; dropdown positions correctly; the Appearance + Region controls are gone.
- [ ] **Regression:** rest of app (`DashboardChrome` `UserButton`) unchanged; Spaces overview + inside-Space untouched; sign-out flow intact.
- [ ] **Exclusion proof:** `git diff --name-only` shows only the three files above (plus optional deletions if approved).

---

## Recommendation
Ship all three as one small PR (disjoint files, ~a dozen lines total): pin the Brief backdrop to the default wide Earth (`BriefHero`), pin `resolvedTheme` to dark (`ThemeProvider`), and swap the Brief menu to `UserButton` (brief layout). Leave light-mode CSS and the now-dead region/menu code in place as safe dead code for a separate cleanup. **Stop point:** this checklist — confirm the one product micro-decision (which backdrop crop) and the accepted Brief-menu behavior deltas before code.
