# Atlas Liquid Material — Standardization & Vendoring Plan

**Status:** Plan only. No implementation. Governs the promotion of the approved Daily Brief LiquidGlass usage into a first-class, dependency-free Atlas material.
**Companions:** `ATLAS_GLASS_MATERIAL_DOCTRINE.md`, `ATLAS_GLASS_REAL_REFRACTION_GAP_ANALYSIS.md`.

> **One-line goal.** Turn the approved Daily Brief Liquid CTAs/cards into two internal Atlas primitives backed by *vendored* source (no npm dependency, no `.env` flags), while keeping Atlas Glass the default and Liquid a rare premium accent.

---

## 1. Current approved usage (the state we're standardizing)

**Approved surfaces (Daily Brief only):**
- **Hero CTAs** — "Continue to Spaces" (`/dashboard/spaces`) and "View AI Analysis" (`/dashboard/analyze`), via `components/brief/BriefLiquidCta.tsx`, wired in `BriefHero.tsx` (`HeroCTAs`), gated by `NEXT_PUBLIC_LIQUID_CTA`.
- **Visible cards** — "In the last hour" (`BriefSinceLastVisit`), "Today's Insight" (`BriefInsight`), "All clear"/attention (`BriefAttention`), via `components/brief/BriefLiquidCard.tsx`, gated by `NEXT_PUBLIC_LIQUID_CARD`.

**Final approved state to preserve exactly (the primitives must encode this):**
- **Material:** `LiquidGlassCard`, `variant="frosted"` (`"prism"` was the dev "strong" diagnostic — drop from production), `settings.refraction 0.5`, `chromaticAberration 0.12`. `backgroundImage="/oval-world.png"` (the Brief's default Earth).
- **Geometry — CTA:** `settings.radius 10`; content as `LiquidGlassCard` children; a **whisper top-rim** (`inset 0 1px 0 rgba(255,255,255,.14)`), no border, no bevel; `px-5`-class horizontal padding removed (library 24px content padding + label owns it); interaction below.
- **Geometry — Card:** `settings.radius 20`; scoped geometry override `.lg-card { width:100%; min-height:0 }` + `.lg-card__content { padding:0 }` (each card owns its padding); a **contrast scrim** `rgba(6,9,17,0.32)` above the glass / below content; content as crisp DOM children.
- **Interaction (both):** `transition-transform` on `--dur-base`/`--ease-standard`; hover `-translate-y-[1px]`; press `scale 0.97` (CTA) / `0.99` (card); focus-visible meridian ring; all movement `motion-safe`-gated (reduced motion → no movement). Click targets: CTA = `Link`; cards = `Link` (Insight) or `role="button"` opening their modal (SinceLastVisit/Attention) — **modals preserved**.
- **Insight chart legibility:** `InsightDecoration` SVG opacity lifted `0.14 → 0.45` on the Liquid path only.
- **Hero composition:** height `clamp(380px, 54vh, 640px)` (+ matching skeleton `clamp(350px,50vh,590px)`) — orthogonal to this plan; noted so a clean install reproduces it.

**Target end-state:** the above renders with **no env flag** and **no external package** — Liquid is a normal, always-available Atlas material on these surfaces (see §5 for the on/off decision).

---

## 2. Vendoring

**Upstream to record (in a `VENDORED.md` beside the code):**
- Package: `@ogtirth/liquid-glass-oss@0.1.0` (MIT). Source repo: `github.com/ogtirth/LiquidGlass-OSS` (mirror of `gitlab.com/ogtirth/liquidglass-oss`).
- Transitive attribution: WebGL physics/lighting adapted from `ybouane/liquidglass` commit `5ebda520bebdef7786566bc8cb151cac0e593314` (MIT) — per the package's `THIRD_PARTY_NOTICES.md`.
- Record: package name, version `0.1.0`, source commit/date pulled, and exactly which modules were extracted.

**Reality check that shapes the approach:** the **npm tarball ships only a bundled `dist/`** (one `index.js` with all ~16 components) — there is **no source** in the package. `LiquidGlassCard` is the only component we use; `Button, IconButton, Slider, Checkbox, RadioGroup, Dock, TabBar, Breadcrumb, Dropdown, Popover, Tooltip, Toast, CommandPalette, Input, Search` are all unused.

**Two vendoring options:**

- **Option A — extract from source (recommended; matches "vendor only required source").** Pull the repo at a pinned commit and copy into `components/atlas/vendor/liquid-glass/` only: the **Card** component, the shared **engine** (displacement-map computation, shader/WebGL renderer, options/settings), and the **Card CSS** (`.lg-card*` rules). Drop every other component's source and CSS. Result: a truly minimal, auditable surface with no dock/checkbox/slider/toast code. Cost: must read the source module graph to sever Card from the shared barrel.

- **Option B — vendor the bundled dist, then trim (faster fallback).** Copy `dist/index.js` (ESM) + `dist/index.d.ts` into the repo and import only `LiquidGlassCard`. Because the package is ESM with `sideEffects:["**/*.css"]`, Next/webpack **tree-shakes the unused component functions out of the app bundle** already — so runtime bloat is limited. But the vendored *file* still contains all components' code (not "only required source"), and `styles.css` (38 KB) carries every component's classes. Mitigate by trimming `styles.css` to `.lg-card*` only. Cost: lower effort, but not truly minimal source.

**Recommendation:** Option A. If source extraction proves fragile (tightly-coupled barrel), fall back to Option B with a trimmed `.lg-card`-only stylesheet.

**License/attribution handling (either option):**
- Copy `LICENSE` (MIT) and `THIRD_PARTY_NOTICES.md` (ybouane attribution) into `components/atlas/vendor/liquid-glass/`.
- Add `VENDORED.md` with the provenance record above.
- Keep the MIT copyright headers intact in extracted files.

**Dependency removal:**
1. Repoint `AtlasLiquidCard`/`AtlasLiquidCta` imports from `@ogtirth/liquid-glass-oss` → the vendored path (e.g. `@/components/atlas/vendor/liquid-glass`), and the CSS import → the vendored (trimmed) stylesheet.
2. Remove **both** `@ogtirth/liquid-glass-oss` **and** `liquid-glass-web-react` from `package.json` `dependencies` (the latter is only used by dead spikes — see §4).
3. `npm install` to regenerate `package-lock.json` cleanly (drops both packages + any transitive entries); commit the lockfile.
4. Confirm `node_modules/@ogtirth` and `node_modules/liquid-glass-web-react` are gone after a clean install.

---

## 3. Atlas primitive design

Promote the two approved components into `components/atlas/`, renamed to the Atlas namespace:

- **`AtlasLiquidCard`** (from `BriefLiquidCard`): props `href?` | `onClick?` (link vs `role="button"`), `ariaLabel`, `children`. Owns: vendored `LiquidGlassCard` material (frosted preset), the geometry override CSS, the contrast scrim, interaction + focus, and the WebGL fallback (§5). Content stays crisp DOM children.
- **`AtlasLiquidCta`** (from `BriefLiquidCta`): props `href`, `ariaLabel`, `children`. Owns: CTA-sized geometry (`radius 10`, whisper rim), interaction, focus.

Naming: prefer `AtlasLiquidCard` + `AtlasLiquidCta` (parallels `GlassPanel`/`GlassButton`; "Cta" reads as the button-shaped one). `AtlasLiquidButton` is an acceptable alias if a non-navigational button variant is later needed.

**Governing rules (from the Material Doctrine):**
- **Do not** replace `GlassPanel` globally. **Do not** replace `DataCard` globally. **Do not** touch `OverlaySurface`.
- **Atlas Glass remains the default material.** Liquid is a **rare premium accent** — Daily Brief flagship surfaces only. No blanket adoption; no lists/tables; no dashboard/data cards.
- The Daily Brief card/CTA call-sites switch from `BriefLiquid*` to `AtlasLiquid*`; the Brief components keep their Glass path as the fallback branch (now the WebGL-unsupported fallback rather than the flag-off branch).
- Consumes existing Atlas tokens (`--dur-*`, `--ease-*`, `--meridian-400`), no new global tokens required.

---

## 4. Cleanup (exact removals)

**Delete (dead spikes / superseded experiments):**
- `components/brief/BriefButtonRefraction.tsx` — orphan (button-overlay spike).
- `components/brief/BriefGlassLens.tsx` — retired stub (`export {}`).
- `components/brief/BriefOgtirthButton.tsx` — superseded (toggle-button spike).
- `components/brief/BriefOgtirthCard.tsx` — superseded (demo card).
- `components/atlas/LiquidButton.tsx` — rejected `liquid-glass-web-react` button experiment.
- `components/brief/BriefHeroRefractionSpike.tsx` — inert passthrough. **Also unwrap** `<EarthBackground>` in `BriefHero.tsx` (remove the `<BriefHeroRefractionSpike>` wrapper).
- `components/dashboard/SpaceHeroRefractionSpike.tsx` — rejected Space spike. **Also unwrap** `<SpaceTrendHero>` in `SpaceDashboard.tsx` (remove the wrapper + import).
- `app/material-lab/` (`page.tsx`, `MaterialLab.tsx`) — see §5 note; default **remove** (dev tool that depends on `liquid-glass-web-react`).

**Remove dead flags** (all reads + comments):
- `NEXT_PUBLIC_LIQUID_BUTTON` (button-overlay spike).
- `NEXT_PUBLIC_REFRACTION_BRIEF` (inert hero spike).
- `NEXT_PUBLIC_REFRACTION_SPIKE` (Space spike).
- `NEXT_PUBLIC_LIQUID_CTA` / `NEXT_PUBLIC_LIQUID_CARD` → replaced per §5 (removed if always-on).

**Remove dependencies:** `liquid-glass-web-react` (only referenced by the deleted spikes) and `@ogtirth/liquid-glass-oss` (replaced by vendored source).

**Keep as documented rejected evidence (optional):** the Space refraction rejection is already captured in `ATLAS_GLASS_REAL_REFRACTION_GAP_ANALYSIS.md`; the `SpaceHeroRefractionSpike` code itself can be deleted (its lesson is documented). If you want living evidence, keep only the doc, not the spike.

**Order of operations:** delete spikes & unwrap their host wrappers → promote `AtlasLiquid*` → repoint Brief call-sites → vendor + repoint imports → drop deps → regenerate lockfile.

---

## 5. Feature behavior

**Decision: always-on for the approved Daily Brief surfaces, with a robust runtime fallback — no `.env`.**
- The two primitives render Liquid by default on the Brief CTAs/cards. No `NEXT_PUBLIC_*` gate; normal local dev shows Liquid with zero setup (this is the core ask).
- **WebGL/support fallback (required now that it's always-on):** the primitive must feature-detect WebGL (and honor `prefers-reduced-transparency`) and, when unsupported, **fall back to the existing Atlas Glass path** (`GlassPanel`). This reuses the Glass branch already in each Brief component — it stops being a flag branch and becomes the capability fallback. This is what makes "always-on" safe on Safari/iOS/no-WebGL.
- **Optional dev toggle (not required):** if an A/B disable is wanted, use a **URL param** (`?atlasLiquid=0`) or `localStorage` (`atlas:liquid=off`) read at runtime — **never** `NEXT_PUBLIC_*`. Default = on. Keep this out of scope unless requested.

Net: no env file for normal dev; Liquid where supported, Glass where not; an optional non-env dev switch.

---

## 6. Validation & rollback

**Validation checklist (post-implementation):**
- **Clean install from scratch:** `rm -rf node_modules package-lock.json && npm install` (or `npm ci` against the regenerated lock) — succeeds with **no** `@ogtirth/*` or `liquid-glass-web-react`.
- `npx tsc --noEmit` clean; `npm run lint` clean.
- **Daily Brief CTAs:** "Continue to Spaces" navigates; "View AI Analysis" navigates; hover/press/focus intact.
- **Daily Brief cards:** "In the last hour" and "All clear" open their modals; "Today's Insight" links; chart legible; content crisp.
- **Safari + mobile Safari + Firefox:** Liquid renders where WebGL is available; **fallback to Glass** verified where it isn't (or reduced-transparency on); check WebGL context count/FPS on the Brief.
- **No regressions elsewhere:** Spaces/Dashboard/Settings unaffected (spikes removed cleanly); `GlassPanel`/`DataCard`/`OverlaySurface` untouched.
- Grep proof: no remaining `NEXT_PUBLIC_LIQUID_*` / `NEXT_PUBLIC_REFRACTION_*` reads; no imports of the removed packages.

**Rollback plan:**
- Land the whole standardization as **one revertible commit** (or a short stacked series: cleanup → vendor → promote → drop-deps). `git revert` restores the prior flagged state.
- Because the vendored code lives in an isolated `components/atlas/vendor/liquid-glass/` folder and the primitives are additive, a partial rollback = point `AtlasLiquid*` back at the npm package (re-add the dep) without touching call-sites.
- The Glass fallback path remains in the Brief components throughout, so a "kill switch" (force the fallback) disables Liquid instantly without a deploy if needed.

---

## Open decisions for you
1. **Vendoring depth:** Option A (extract Card-only source — recommended) vs Option B (vendor+trim the bundled dist).
2. **Material Lab:** delete, or keep as a dev-only tool (would require keeping/porting `liquid-glass-web-react` or rebuilding it on the vendored Card)?
3. **Dev toggle:** ship the optional `?atlasLiquid=0` / localStorage switch, or omit entirely (pure always-on + WebGL fallback)?
4. **Primitive names:** `AtlasLiquidCard` + `AtlasLiquidCta` (recommended) vs `AtlasLiquidButton`.

*Plan only — nothing implemented. Awaiting your calls on the open decisions before any vendoring/standardization work.*
