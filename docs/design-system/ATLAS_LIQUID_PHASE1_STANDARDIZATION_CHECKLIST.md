# Atlas Liquid — Phase 1 Standardization: Impact Map, Checklist, Rollback, Validation

**Type:** Pre-code implementation checklist (project working-style gate). **No code changed yet.**
**Date:** 2026-07-03 · **Branch:** `feature/v2.5-spaces-completion`
**Approved direction:** `ATLAS_MATERIAL_ENGINE_UNIFICATION_PROPOSAL.md`, with the adjustment below.
**Awaiting:** approval of this checklist before edits begin.

---

## 0. Scope lock (what Phase 1 is and is NOT)

**Phase 1 IS:** stand up one internal Liquid boundary, route the *already-approved* Daily Brief Liquid CTAs/cards through it, make Liquid **default-on for those Daily Brief surfaces only**, vendor the source behind the boundary, and remove the experiment scaffolding (env flags, dead spikes, the rejected library, inert wrappers). Glass remains the fallback.

**Phase 1 is explicitly NOT:**
- ❌ No `material="liquid"` on `GlassPanel` — **GlassPanel is untouched.**
- ❌ No public/broad material API.
- ❌ No Space **detail hero** work — that is Phase 2.
- ❌ No Spaces **overview** grid, dashboard, data cards, transaction rows, or modals — those stay Atlas Glass.

**Doctrine reaffirmed:** chrome carries material; data stays readable; Liquid is rare hero/brand chrome over the Earth field only.

---

## 1. Impact map

### 1.1 New file (the boundary — the only place the library is imported)
- **`components/atlas/AtlasLiquidRenderer.tsx`** (client). Sole importer of `@ogtirth/liquid-glass-oss`. Owns: the `LiquidGlassCard` call, the fed `backgroundImage` (`/oval-world.png` today — unchanged), the tokenized contrast scrim, geometry normalization (the `.lg-card`/`.lg-card__content` overrides), and **capability detection → Glass fallback** (WebGL absent / `prefers-reduced-transparency` / `prefers-reduced-motion` → render a Glass surface instead). Exposes an `active: "liquid" | "glass"` signal so callers can adjust coupled decoration (see 1.3). Interaction tokens (`--dur-*`, `--ease-*`, `--meridian-400` focus ring) stay as today.
  - *Optional thin selector* `AtlasMaterialRenderer` may wrap it if we want a single `material` switch internally — but it stays **internal**, not a GlassPanel prop. Recommend deferring it to Phase 3; Phase 1 needs only `AtlasLiquidRenderer`.

### 1.2 Refactor in place (keep call sites; delegate to the boundary)
- **`components/brief/BriefLiquidCta.tsx`** — stop importing the library directly; render through `AtlasLiquidRenderer`. Keep its href/aria/geometry contract. Remove the `STRONG`/flag reads; use the approved (conservative) settings as constants.
- **`components/brief/BriefLiquidCard.tsx`** — same treatment (href/onClick/keyboard/aria contract preserved; library call moves into the renderer; flag/`STRONG` removed).

### 1.3 Edit — make Liquid default-on for approved Daily Brief surfaces, remove flag branches
- **`components/brief/BriefHero.tsx`** — delete `SHOW_LIQUID_CTA` + the flag; `HeroCTAs()` always renders the Liquid CTAs (via `BriefLiquidCta`), with the previous GlassPanel CTA path retained **only** as the renderer's fallback (not a flag branch). Remove the `BriefHeroRefractionSpike` import + wrapper (inert passthrough → unwrap children; behavior-neutral). Keep `dynamic(..., { ssr:false })` for the Liquid chunk.
- **`components/brief/BriefInsight.tsx`** — remove `SHOW_LIQUID_CARD` flag; always use `BriefLiquidCard`. **Re-key `InsightDecoration` opacity** (`0.45` vs `0.14`) off the renderer's `active` material, not the deleted env flag, so the decoration still matches whichever material actually renders (Liquid vs Glass fallback).
- **`components/brief/BriefSinceLastVisit.tsx`** — remove flag; always use `BriefLiquidCard` (Glass fallback via renderer).
- **`components/brief/BriefAttention.tsx`** — remove flag; always use `BriefLiquidCard` (Glass fallback via renderer).

### 1.4 Delete (dead spikes + rejected-library users + inert wrappers)
- `components/brief/BriefHeroRefractionSpike.tsx` (inert; rejected lib) — after unwrapping in BriefHero.
- `components/dashboard/SpaceHeroRefractionSpike.tsx` (inert; rejected lib) — after unwrapping in `SpaceDashboard.tsx` (remove import at line 58 + wrapper at ~2401–2412; children render unchanged).
- `components/brief/BriefButtonRefraction.tsx` (rejected lib, spike).
- `components/brief/BriefGlassLens.tsx` (spike).
- `components/atlas/LiquidButton.tsx` (rejected lib, experimental).
- `components/brief/BriefOgtirthCard.tsx`, `components/brief/BriefOgtirthButton.tsx` (comparison spikes).
- `app/material-lab/` (`MaterialLab.tsx`, `page.tsx`) — dev comparison route (rejected lib).

### 1.5 Dependency + flag removal
- **`package.json`** — remove `liquid-glass-web-react` (`^0.1.1`). **Keep** `@ogtirth/liquid-glass-oss` (`0.1.0`) — now imported only by `AtlasLiquidRenderer`. Update `package-lock.json` via install.
- **Env flags removed entirely:** `NEXT_PUBLIC_LIQUID_CTA`, `NEXT_PUBLIC_LIQUID_CARD`, `NEXT_PUBLIC_LIQUID_BUTTON` (dev-only, not in `.env.example`; nothing to edit there — just delete the code reads).

### 1.6 Untouched (guardrail)
`GlassPanel.tsx`, `DataCard.tsx`, `OverlaySurface.tsx`/`Dialog`/`FormModal`/`ConfirmDialog`, `GlassButton.tsx`, `globals.css` material tokens, all dashboard/data/modal surfaces, the Space detail hero, the Spaces overview grid. No schema, no API, no lib/ changes.

---

## 2. Behavior-preservation argument

- The approved visual = "Liquid flag on, conservative." Phase 1 makes exactly that config the default for the four Daily Brief surfaces (hero CTAs + Insight/SinceLastVisit/Attention cards). So the **intended rendered result equals the approved prototype**.
- The **previous default (Glass)** is not lost — it becomes the renderer's fallback for no-WebGL / reduced-transparency / reduced-motion, so those users see exactly today's Glass.
- `strong` mode was a tuning aid; dropping it changes nothing in the approved (conservative) look.
- Deleting the two inert `RefractionSpike` wrappers is behavior-neutral (they already render children unchanged).
- The single behavioral *change of record*: Daily Brief now ships Liquid by default instead of behind a dev flag — which is the approval.

---

## 3. Rollback plan

- **Boundary revert:** `AtlasLiquidRenderer` can force `active:"glass"` (one constant) to instantly return all four surfaces to Glass without touching call sites.
- **Commit granularity:** land as separate revert-safe commits — (a) add renderer, (b) route BriefLiquidCta/Card through it (still flagged), (c) flip defaults on + remove flags, (d) delete spikes + rejected dep. Reverting (c) alone restores flag-gated behavior; reverting (d) is pure deletion and can be cherry-reverted.
- **Dependency:** removing `liquid-glass-web-react` is safe (only dead spikes used it); if a revert is needed it's a one-line re-add.
- **Deferred hard-delete option:** if desired, move the spikes to a throwaway commit rather than delete, so restoration is a cherry-pick for one release.

---

## 4. Validation checklist (run after each commit; all must pass before Phase 1 closes)

- [ ] `npx tsc --noEmit` clean (no orphaned imports from deleted files).
- [ ] `npm run lint` clean.
- [ ] `npm run build` succeeds (Next build; confirms no remaining reference to removed flags/lib and no SSR break from `ssr:false` renderer).
- [ ] `grep -rn "NEXT_PUBLIC_LIQUID" components/ app/` → **zero** results.
- [ ] `grep -rln "liquid-glass-web-react" .` (excluding node_modules) → **zero**; `grep -rln "@ogtirth/liquid-glass-oss" components/ app/` → **only** `AtlasLiquidRenderer.tsx`.
- [ ] `grep -rn "RefractionSpike\|BriefOgtirth\|BriefGlassLens\|LiquidButton\|material-lab" components/ app/` → **zero** references.
- [ ] Manual visual parity: Daily Brief hero CTAs + the three cards render the approved Liquid material (dev), labels crisp, contrast floor holds.
- [ ] Fallback proof: force no-WebGL / `prefers-reduced-transparency` / `prefers-reduced-motion` → all four surfaces render Glass, readable, no console errors.
- [ ] Focus/keyboard preserved on CTAs and clickable cards (Enter/Space, focus ring, tab order).
- [ ] `BriefInsight` decoration opacity tracks the *actual* rendered material (Liquid 0.45 / Glass 0.14), verified in both the Liquid and forced-fallback states.
- [ ] KD-13 residue check: confirm the deleted spikes/`material-lab` are gone and no new `" 2"` dirs introduced.

*Note:* no Prisma/migration steps — Phase 1 is presentation-only.

---

## 5. Open decisions (confirm before or during execution)

1. **`AtlasLiquidRenderer` location** — `components/atlas/` (recommended, sits with the primitives) vs `lib/atlas/`. Default: `components/atlas/`.
2. **Fed backdrop image** — keep `/oval-world.png` as today (recommended for Phase 1; the live-field registration upgrade is a later concern), or switch to the branded `fourth-meridian-dark.png`. Default: unchanged (`/oval-world.png`).
3. **Keep `BriefLiquidCta`/`BriefLiquidCard` as Brief-scoped wrappers** (recommended — least churn, clear call sites) vs inline the renderer at each site. Default: keep as thin wrappers over the renderer.
4. **Spike removal style** — hard-delete now (recommended; closes KD-13) vs park one release. Default: hard-delete.

---

## 6. Ready-to-execute summary

New: 1 file (`AtlasLiquidRenderer`). Refactor: 2 (`BriefLiquidCta`, `BriefLiquidCard`). Edit: 5 (`BriefHero`, `BriefInsight`, `BriefSinceLastVisit`, `BriefAttention`, `SpaceDashboard`). Delete: 8 files + 1 route dir. Deps: −1 (`liquid-glass-web-react`). Flags: −3. Primitives touched: **0**. Rendered change of record: Daily Brief ships approved Liquid by default with Glass fallback.

**Standing by for approval to execute Phase 1 in the commit order in §3. No code has been changed.**
