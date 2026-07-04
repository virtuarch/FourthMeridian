> **INVESTIGATION / CHECKLIST ONLY — no implementation.** Scope: the **central Spaces overview** (`/dashboard/spaces` → `SpacesClient`) only. No schema, routes, auth, FlowType, backend, new data, new interactions, changed handlers, or inside-Space dashboard work. Builds on `ATLAS_GLASS_MATERIAL_DOCTRINE.md`, `ATLAS_LIQUID_PLATFORM_DOCTRINE.md`.
>
> **Rev 4 (Liquid-card refinement).** Supersedes Rev 3's card model. **Shipped so far:** P1 (greeting removed; `.is-rich` atmosphere raised) and the **Liquid SpaceCard** override (`AtlasLiquidCard` + `useAtlasLiquid` gate, per-category identity tint overlay, Glass fallback). Rev 4 refines that Liquid card into a **premium, collectible object** per 10 product decisions below. It **partially reverses P1** (the globe is pulled *back* from behind the cards) and **replaces the last slice's border/overlay tint approach** with material-native hue.

# Central Spaces Overview — Redesign Checklist (Rev 4 · Premium Liquid Cards)

**Primary experience:** the *My Spaces* Liquid cards. Each should feel like a unique, collectible object in the Fourth Meridian identity — the card and its graphic reading as **one tinted object**, floating in a supportive (not competing) atmosphere.

---

## 1. Current state (what Rev 4 changes from)

| Element | Where (today) | Rev 4 change |
|---|---|---|
| Card material | `SpaceCard` → `AtlasLiquidCard` (Liquid) + Glass tile fallback | keep; deepen hue via the **material**, refine interior |
| Identity tint | overlay wash + **`inset 0 0 0 1px ${tint}33` ring** (last slice) | **drop the ring** (decision 2); move hue into the Liquid material (decisions 4/7) |
| Card texture | `AtlasLiquidCard` default `backgroundImage = "/oval-world.png"` — a **globe refracted inside every card** | replace with a **non-globe** texture (decisions 1/7) |
| Outer container | `<GlassPanel depth="thin" …>` wraps the whole My Spaces grid | **remove** (decision 3) |
| Internal divider | footer row `borderTop: 1px solid var(--border-hairline)` | **remove** (decision 6) |
| Graphic (icon) | `w-11 h-11` gradient tile, **left of** name; uses `categoryTile` token gradients | **shrink + tinted-glass**, move to a secondary row **under** the name; recolor to the identity hex (decisions 7/8/9) |
| Chart | `Sparkline` (80×28) in the **metric row**, right of the number; already on every card | **widen + move lower/centered**, integrated (decision 5) |
| Background | `AtlasField .is-rich` globe raised (P1) | **suppress the globe** behind the cards, keep atmosphere (decision 1) |
| Typography | name = `--text-primary`; labels/type/activity = `--text-muted` | **sharper white, stronger contrast** where hierarchy matters (decision 10) |

**Key material finding.** The vendored Liquid shader exposes `u_tintColor` (RGB) + `u_tintStrength` (`shaders.ts:195` `mix(color, color*u_tintColor, u_tintStrength)`) — so **hue can come from the material itself**, exactly as decisions 4/7 ask. `AtlasLiquidCard` does **not** expose these yet (its `SETTINGS` sets only refraction/chromaticAberration/radius). This is the crux of the implementation (see §3).

---

## 2. The 10 product decisions → concrete plan

1. **Remove the world behind the cards (keep atmosphere).** Suppress the `.atlas-globe` (and heavy meridian) layers for `.is-rich` in `app/globals.css`, keeping the base radial gradient + brass horizon. This *reverses P1's globe-forward boost* — noted intentionally. Cards then float in atmosphere, not over a literal globe. *(File: `globals.css`, optionally `AtlasField.tsx`.)*
2. **Remove the colored border.** Delete the identity ring (`inset 0 0 0 1px ${tint}33`) added last slice. Keep a clean, crisp neutral edge — the Liquid material's own rim (and/or one subtle neutral hairline). Colour lives in the material, not the outline. *(File: `SpacesClient.tsx`.)*
3. **Remove the outer container.** Drop the `<GlassPanel depth="thin">` wrapping the grid; render the card grid directly in the page column (keep the existing `auto-fit,minmax` grid + gap). Move the "Show N more" control to sit under the bare grid. Cards become their own grouping. *(File: `SpacesClient.tsx`.)*
4. **Increase the Liquid hue.** Drive per-card colour through the material `tintColor` + a raised `tintStrength` (stronger than the current ~0.1 overlay), kept elegant/restrained. *(See §3 — this is the shared-component decision.)*
5. **Every card gets its own chart, moved lower.** Every card already renders `Sparkline`; relocate it out of the metric row into a **wider, horizontally-centered band in the lower half** of the card, visually integrated (not attached to the number). Widen `Sparkline` (it is hard-coded 80×28 — add a width/`full` option). *(File: `SpacesClient.tsx`, small `Sparkline` tweak.)*
6. **Remove the internal divider.** Delete the footer `borderTop`; separate members/activity from the rest with spacing + type weight only. *(File: `SpacesClient.tsx`.)*
7. **Card hue follows the graphic (one object).** Unify on a single identity colour per category (the product hex palette from the last slice) used for **both** the graphic and the card's Liquid `tintColor`, so card + graphic read as one. Retire the separate `categoryTile` token-gradient for the card path in favour of the identity hex. *(File: `SpacesClient.tsx`; material via §3.)*
8. **Refine the graphic → premium floating object.** Shrink (~`w-11`→`w-8/9`), render as a **heavily-tinted glass chip** (identity hue, specular highlight, soft inner light) so it reads as a floating premium object, not a flat icon. *Investigated:* making the chip its own **WebGL Liquid** element is rejected — it multiplies WebGL contexts (already 6+ per page); a **tinted-glass** chip achieves the "floating object" read at near-zero cost. Recommend tinted glass. *(File: `SpacesClient.tsx`.)*
9. **Logo/graphic placement.** Name becomes the top, strongest element (full width). The graphic + type label form a **secondary identity row beneath the name** (`[chip] Household`), not a left rail. *(File: `SpacesClient.tsx`.)*
10. **Typography.** Sharpen the name (slightly larger, `--text-primary`, tighter tracking); raise the type label and metric label off `--text-muted` toward a stronger token (`--text-secondary` / brighter) for scannability; keep truly secondary text (activity) muted. Verify contrast against the stronger Liquid hue. *(File: `SpacesClient.tsx`.)*

---

## 3. The one architectural decision to confirm — where the hue comes from (decisions 4 & 7)

"Colour from the Liquid material itself" (not an overlay, not the outline) means feeding the shader's `tintColor`/`tintStrength`. Two paths:

- **Path A — extend `AtlasLiquidCard` (recommended).** Add **optional, backward-compatible** props `tint?: [r,g,b]` and `tintStrength?: number` that pass into `LiquidGlassCard` settings. Daily Brief usage omits them → its look is unchanged (defaults preserved). SpaceCard passes the identity hue (from the hex palette) + a raised strength. This is the truest "hue from the material" and the cleanest per-card control. **Cost:** touches one shared Atlas component, additive only.
- **Path B — `SpacesClient`-only, no shared change.** Keep `AtlasLiquidCard` as-is and pass a per-category **identity-tinted `backgroundImage`** (a small gradient texture per hue) so the refracted texture *is* the hue. Needs ~8 tiny gradient assets (or a generated data-URI). No shared-component edit, but adds assets/among-cards texture management.

**Recommendation: Path A.** It is smaller in net code, keeps colour truly in the material, avoids per-hue asset sprawl, and is backward-compatible. Either path also resolves decision 1's "world inside the card": set the card's `backgroundImage` to a **neutral, non-globe** texture (a subtle dark gradient) so the refraction bends a hue field, not a globe. Confirm Path A vs B before implementation — it is the only decision that reaches outside `SpacesClient.tsx`.

---

## 4. Exact files affected

| File | Decisions | Change type | Shared? |
|---|---|---|---|
| `components/dashboard/SpacesClient.tsx` | 2,3,5,6,7,8,9,10 (+4/1 wiring) | primary — card interior, grid, remove container/ring/divider, typography | overview-only |
| `app/globals.css` (± `components/atlas/AtlasField.tsx`) | 1 | suppress `.is-rich` globe, keep atmosphere (reverses P1) | overview-only (`.is-rich` scope) |
| `components/atlas/AtlasLiquidCard.tsx` | 4,7 (Path A) | **additive optional `tint`/`tintStrength`** props | **shared** (Daily Brief) — additive, defaults preserved |
| `public/` neutral texture (± per-hue) | 1,7 | one small non-globe texture asset (Path A) or ~8 (Path B) | asset |

No `page.tsx`, no data loader, no routes, no schema, no inside-Space files, no handler changes.

## 5. Current props (unchanged — presentation only)

`id, name, description, type, category, isPublic, createdAt, members[], myRole, accountCount, netWorth, trend[], lastUpdated`. Identity hue derives from `category` (existing hex palette). Chart from `trend[]`. **No new data.**

---

## 6. Smallest implementation slices

- **Slice R4-a — Layout & structure (no material change):** remove outer container (3), remove ring border (2), remove divider (6), re-flow header to name-over-[graphic+type] (9), shrink graphic to tinted-glass chip (8), move chart to a lower centered band + widen `Sparkline` (5), typography pass (10). All in `SpacesClient.tsx`. Ships independently; cards still use the current tint.
- **Slice R4-b — Material hue (decisions 4 & 7):** Path A — add optional `tint`/`tintStrength` to `AtlasLiquidCard`; SpaceCard passes identity hue + neutral non-globe `backgroundImage`; unify graphic + card on one hex. Confirm Path A/B first.
- **Slice R4-c — Atmosphere (decision 1):** suppress `.is-rich` globe in `globals.css`, keep gradient/brass; verify cards read as the focus.

Sequence R4-a → R4-c → R4-b (material last, after the shared-component path is approved). Each is independently revertible.

## 7. Validation plan

- [ ] `npx tsc --noEmit`, `npm run lint` — clean.
- [ ] `next build` (real machine; sandbox `prisma generate` is network-gated).
- [ ] Cross-browser + mobile visual: cards are the focus; atmosphere supports; hue is elegant-but-stronger and unique per Space; graphic+card read as one object.
- [ ] **Reduced-transparency / no-WebGL (`?atlasLiquid=0`)**: Glass fallback still complete; identity hue still legible without the material tint.
- [ ] **WebGL cost check:** with the container/globe removed, re-confirm ≤6 canvases at `CARD_LIMIT=6` behave; watch context limits on "Show more".
- [ ] **Path A regression:** Daily Brief `AtlasLiquidCard` usages visually unchanged (props omitted → defaults).
- [ ] Behaviour regression: open/switch, Manage, default Crown, active state, member stack, activity — identical.
- [ ] Exclusion proof: `git diff --name-only` = only the §4 files; `/dashboard` (inside a Space) pixel-unchanged; no schema/route/`page.tsx`/inside-Space edits.

## 8. Rollback plan

Per-slice `git checkout`. R4-a is pure markup/classes in `SpacesClient.tsx`. R4-b: revert `AtlasLiquidCard` (additive props → safe delete) + SpaceCard wiring + texture asset. R4-c: revert the `globals.css` `.is-rich` block (restores P1). No data/state/handler unwinding.

## 9. Tradeoffs, risks & conflicts

- **Reverses P1 atmosphere.** P1 raised the globe; decision 1 pulls it back. Intentional — cards now lead. Net: `.is-rich` keeps gradient/brass, drops the literal globe.
- **Path A touches a shared component.** Additive and backward-compatible, but flag it: `AtlasLiquidCard` also serves the Daily Brief. Defaults must be preserved; validate the Brief. Path B avoids this at the cost of per-hue assets.
- **Doctrine (still overridden).** Liquid on a repeated card grid remains against `ATLAS_LIQUID_PLATFORM_DOCTRINE §3.2` (N WebGL canvases) — carried forward from the approved override. Removing the outer container + globe slightly *raises* per-card GPU visibility; keep `CARD_LIMIT=6` and re-check "Show more".
- **Stronger hue vs restraint (Law 7).** Decision 4 pushes hue up; the risk is "everything shimmers." Mitigate by tinting the **material** (one controlled `tintStrength`), not adding glows/borders, and keeping text contrast high (decision 10) so hue never fights legibility.
- **Chart lower + wider** must not collide with the footer actions on short cards; verify with long names + 0–1 members.
- **Graphic-as-Liquid rejected** (per-chip WebGL) — tinted glass chosen for cost; note if the "floating object" read needs more, a static specular/refraction *image* is the next step, not a canvas.

## 10. Recommendation

Proceed **R4-a first** (structure/typography — all in `SpacesClient.tsx`, zero shared-component risk), then **R4-c** (atmosphere), then **R4-b** (material hue via **Path A**, pending your confirmation of the shared-component change). This delivers the premium, collectible, one-object card feel while keeping every change presentation-only and reversible.

**Confirm before code:** (1) Path A (extend `AtlasLiquidCard`) vs Path B (per-hue textures); (2) that reversing P1's globe (decision 1) is intended. **Stop point:** this checklist — no implementation until approved.
