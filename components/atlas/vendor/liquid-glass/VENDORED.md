# Vendored: Liquid Glass (Card only)

**Upstream:** `@ogtirth/liquid-glass-oss@0.1.0` (MIT) — https://gitlab.com/ogtirth/liquidglass-oss
**Vendored:** 2026-07-03, from the project's `liquid-glass-web/src/` source tree.
**Why:** remove the npm dependency and env flags for the approved Fourth Meridian
Daily Brief Liquid usage, keeping only the code the Card material needs.

## What was vendored (Card-required only)
- `LiquidGlassCard.tsx` — the component
- `core/LiquidGlassRenderer.ts` — WebGL renderer/engine
- `core/shaders.ts` — vertex/fragment shaders
- `core/types.ts` — settings, presets, variant/type definitions
- `card.css` — trimmed from upstream `src/styles.css`, only the `.lg-card*` rules

## Intentionally dropped
Every other component and its CSS: Slider, Button, IconButton, Checkbox,
RadioGroup, Dock, TabBar, Breadcrumb, DropdownMenu, PopoverOverlay, Tooltip,
Toast, CommandPalette, Input, Search.

## Coupling (verified)
`LiquidGlassCard` imports only `react`, `./core/LiquidGlassRenderer`, and
`./core/types`. `LiquidGlassRenderer` imports only `./shaders` and `./types`.
Nothing in Card/core imports any sibling component — the extraction is complete
and self-contained.

## Licensing / attribution
- `LICENSE` (MIT) — preserved verbatim from upstream.
- `THIRD_PARTY_NOTICES.md` — the WebGL physics/lighting model adapts
  `ybouane/liquidglass` commit `5ebda520bebdef7786566bc8cb151cac0e593314`
  (MIT). Preserved verbatim.

## Local modifications
The four source files are copied **as-is** (no edits). All Fourth Meridian
customization (geometry overrides, contrast scrim, interaction, WebGL fallback,
URL override) lives in the consumers `AtlasLiquidCard` / `AtlasLiquidCta`
outside this folder — the vendored source stays pristine for easy re-sync.

## Re-sync
To update: replace the four files from a newer upstream `src/`, re-trim
`.lg-card*` into `card.css`, and re-verify the coupling check above.
