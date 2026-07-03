# Spaces Design Investigation — Templates, Discovery & Atlas Liquid

**Status:** Investigation only. No code touched. Re-evaluates the Spaces overview and Create Space / template experience now that Atlas Liquid is standardized (`AtlasLiquidCta`/`AtlasLiquidCard`, capability-gated via `useAtlasLiquid`, Glass fallback).
**Governing rule:** Atlas Glass stays the default material; Liquid is a **rare premium accent** (Material Doctrine).

---

## 1. Current-state map (from code)

| Surface | File | Material today |
|---|---|---|
| Overview header + primary CTA | `SpacesClient` | plain title/subtitle + one `GlassButton` (meridian) "Create Space"; intentionally no hero card |
| Invites strip | `SpacesClient` | collapsible `GlassPanel` (glow meridian) |
| **My Spaces grid** | `SpacesClient` → `SpaceCard` | ONE shared `GlassPanel` canvas; cards are **plain tinted tiles** (explicitly *not* nested glass — perf note in code for 20+ cards) |
| Explore public row | `SpacesClient` → `PublicSpaceCard` | compact tinted tiles, secondary, conditional |
| Public detail | `PublicSpaceDetailModal` | `GlassPanel` thick/e4 |
| Create Space flow | `CreateSpaceModal` | 4-step `OverlaySurface`; step 1 has a **category chip grid** |
| Space detail hero | `SpaceDashboard` → `SpaceTrendHero` | `GlassPanel`; refraction spike here was **evaluated and rejected** (backdrop mismatch — the Atlas globe is a shared page backdrop) |

**Key finding:** "templates" don't exist as a discoverable concept — they're the **category picker** in Create Space step 1, which seeds preset sections (`lib/space-presets.ts`). There is no gallery, no featured templates, no preview.

---

## 2. Answers to the questions

**1. Where should templates live?**
Not a separate top-level gallery route (yet) — the current template depth is just "category → preset sections," which doesn't justify its own nav surface or the maintenance/empty-state burden. Recommendation: **elevate templates inside Create Space** (turn the flat category chips into a proper "choose a starting point" step with richer preview cards), and add a **lightweight discovery hook on the overview** (a "Start from a template" affordance beside/under Create Space, and a template-forward empty state). Promote to a standalone gallery only if template richness and usage grow.

**2. Emphasize existing Spaces or template discovery first?**
**Existing Spaces first** for users who have any — the overview is primarily a management/return surface, and the current visionOS-style "no hero, straight to the grid" is correct for them. **Template discovery becomes primary only in the empty / near-empty state** (0–1 Spaces), where the page should sell templates instead of showing a lonely grid. Do not invert the populated overview into a template-first gallery.

**3. Spaces surfaces that are candidates for Liquid (rare accent):**
- **Create Space CTA** — a single, rare, high-intent primary button. Strongest candidate (mirrors the approved Daily Brief CTA exactly).
- **Featured/"recommended" template card** — one hero card in the Create Space picker (or the empty-state). A bounded, premium single card.
- **Current/selected Space card** — a *single* highlighted tile. Possible, but see risks (breaks grid uniformity + adds a WebGL context in a scroll area).

**4. Spaces surfaces that should NEVER be Liquid:**
- The **full My Spaces grid / all `SpaceCard`s** and the **public/explore card grid** — N WebGL contexts on a scrolling page is a perf/battery non-starter, and they're deliberately lightweight tiles.
- The **shared My Spaces `GlassPanel` canvas** — the default Atlas container; stays Glass.
- **Dense data** (sparklines, metric rows) and **modal chrome** (`OverlaySurface`) — Glass is the right material; modals rely on `backdrop-filter` (Liquid is a content lens, wrong tool).

**5. Test Liquid on…?**
- **Create Space CTA → YES** (the natural pilot).
- **Selected/current Space card → DEFER** (risky; grid uniformity + per-card WebGL).
- **Space detail hero → NO / high-risk** — this is exactly where the refraction spike was rejected: the hero sits over the *live, shared* Atlas globe backdrop, and a Liquid card refracts a *supplied* texture, not that backdrop — the same mismatch. Don't pilot here.
- **Featured template card → YES, as pilot #2** (one bounded premium card).

**6. Smallest UI pilot (avoids the whole grid):**
Swap **only the single Create Space primary button** (`GlassButton` → `AtlasLiquidCta`). One element, one WebGL context, high-intent, zero impact on the grid/cards/canvas, and the Glass fallback + `?atlasLiquid=0/1` override already exist. This is the minimal, reversible pilot.

---

## 3. Design recommendation (summary)

- Keep the **overview management-first** for populated users; make the **empty state template-first**.
- **Elevate templates inside Create Space** (richer picker with one featured card), plus a discovery hook on the overview — no new gallery route yet.
- Apply **Liquid as a singular accent**: the Create Space CTA first, then one featured template card. Everything grid/data/modal/hero stays **Atlas Glass**.
- Treat the Space detail hero and the card grid as **Liquid-exclusion zones** (documented reasons).

---

## 4. Impact map

| Change | Files touched (future) | Blast radius | Material |
|---|---|---|---|
| Create Space CTA → Liquid (pilot) | `SpacesClient` (one button) | tiny, reversible | Liquid + Glass fallback |
| Featured template card | `CreateSpaceModal` (+ maybe `space-presets` metadata) | small (one card in the modal) | Liquid (one) / Glass (rest) |
| Template picker elevation | `CreateSpaceModal` step 1; possibly `space-presets` (preview copy/icons) | medium (modal step redesign) | Glass |
| Overview discovery hook + empty state | `SpacesClient` | medium (layout/empty-state) | Glass |
| Current-Space highlight (optional Liquid) | `SpaceCard` selection state | medium (grid card variant) | mostly Glass; ≤1 Liquid |

Untouched: `GlassPanel`, `DataCard`, `OverlaySurface`, `SpaceDashboard` hero, the tile grid, public grid.

---

## 5. Implementation phases (when approved)

1. **Pilot — Create Space CTA on Liquid.** One-button swap in `SpacesClient`; validate visuals + Safari/mobile + fallback. Decide keep/revert.
2. **Featured template card.** Add a single Liquid "recommended" card to the Create Space picker (needs light template metadata: title, blurb, icon).
3. **Template picker elevation + overview discovery hook.** Turn category chips into preview cards; add "Start from a template" entry + template-forward empty state. (Glass.)
4. **(Optional) Current-Space accent.** Evaluate a single Liquid highlight for the active card — only if it reads premium without breaking the grid.
5. **Docs.** Fold the Spaces Liquid-exclusion zones into the Material Doctrine.

Each phase is independently shippable and reversible; none touches the grid en masse.

---

## 6. Risks

- **Perf / WebGL contexts:** the overriding constraint. Liquid must stay to *singular* elements; never the grid or public row. Even the "current Space" accent adds a context to a scroll surface — measure on mobile.
- **Backdrop mismatch (Spaces-specific):** Liquid refracts a *supplied* texture, but Spaces already paints the live Atlas globe backdrop — a Liquid surface refracting a different texture will visibly clash. This is why the Space detail hero is excluded and why any Spaces Liquid use should refract the *same* Atlas asset (or accept a purely specular read).
- **Grid uniformity:** one Liquid card among tinted tiles risks looking like a bug rather than emphasis; needs deliberate framing (e.g., a distinct "current" slot) or skip it.
- **Scope creep into a gallery:** a separate templates route adds nav + empty-state + maintenance for shallow current depth; resist until usage justifies it.
- **New-material novelty:** upstream is v0.1.0; keep the Glass fallback authoritative and the Liquid footprint tiny until proven in production on the Daily Brief.

---

*Investigation only. No files changed. Recommended first move when approved: Phase 1 — the single Create Space CTA on `AtlasLiquidCta`, nothing else.*
