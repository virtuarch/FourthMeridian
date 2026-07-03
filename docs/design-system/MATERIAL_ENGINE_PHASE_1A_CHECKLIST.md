# Material Engine — Phase 1A Implementation Checklist

**Thread:** Atlas Glass Material Engine — Track B
**Status:** PLANNING ONLY. Nothing implemented. Awaiting approval before any edit.
**Authoritative sources (treat as governing):**
`docs/design-system/ATLAS_GLASS_MATERIAL_DOCTRINE.md`,
`docs/investigations/ATLAS_GLASS_MATERIAL_ENGINE_INVESTIGATION.md`,
`docs/design-system/Fourth-Meridian-Design-Language-v1.html` (`.m-*` spec).

---

## 0. What Phase 1A is (and is not)

The doctrine's **Phase 1** bundles two independent changes: (a) *depth
reconciliation* — make blur/saturation scale with thickness — and (b) a
*full-perimeter Fresnel edge* utility. These have different risk profiles and
different surfaces of change. This plan splits them:

- **Phase 1A (this document) — Depth reconciliation only.** Add per-depth optical
  CSS variables (blur + saturation) sourced verbatim from the design language's
  own `.m-*` classes, plus one opt-in utility that consumes them. No edge work.
- **Phase 1B (later, separate approval) — Fresnel edge + the `floating` tier.**
  Deferred here because the `floating` tier's whole point is being the "most
  directional" glass, which only reads correctly *with* the Fresnel edge, and its
  fill values are not in the sourced `.m-*` spec (they would be a new design call).
  Bundling floating into 1A would expand scope and touch the theme fill blocks;
  keeping it in 1B keeps 1A fully sourced and fill-untouched.

**Prime constraint honoured:** the highest-leverage, lowest-risk change is making
depth physical. Phase 1A delivers exactly that and nothing else. It is purely
additive: **no existing surface renders one pixel differently** until a
separately-approved adoption step points a primitive at the new variables.

### The core fix being enabled

Today `GlassPanel` hardcodes `backdrop-filter: blur(30px) saturate(160%)` for
**every** depth (`GlassPanel.tsx` lines ~103–104), so `thin`/`regular`/`thick`
differ only by background alpha — depth is an opacity slider, not a thickness.
Phase 1A creates the vocabulary (variables) that a later step will use to fix
that, matching the design language's existing intent:

| Depth | `.m-*` source (design-language HTML) | Today in `GlassPanel` |
|---|---|---|
| ultrathin | `blur(16px) saturate(180%)` | 30px / 160% |
| thin | `blur(28px) saturate(165%)` | 30px / 160% |
| regular | `blur(40px) saturate(150%)` | 30px / 160% |
| thick | `blur(60px) saturate(140%)` | 30px / 160% |

Phase 1A adds these as tokens. It does **not** apply them to `GlassPanel`.

---

## 1. Exact files that would change

**One file. Additive only.**

1. `app/globals.css` — add a new token block in `:root` and one opt-in utility
   class family. No existing rule, token, or value is modified or removed.

**Explicitly NOT touched in 1A:**

- `components/atlas/GlassPanel.tsx` and every other primitive — untouched. The
  primitive re-point is a separate, later, approved step.
- The `--glass-*` fill tokens and the `html[data-theme="…"]` theme blocks —
  untouched (blur/saturation are theme-independent, so the new vars live in
  `:root` and need no per-theme value; this satisfies doctrine Law 7 "ships in
  both themes" trivially — one value serves both).
- Any component, route, migration, Tailwind config, or `postcss.config`.
- The `floating` tier and any Fresnel/edge/bloom work — deferred to 1B+.

Optional (recommended, tiny): append a one-line status note to the Material
Doctrine (§8 Phase 1) marking "1A landed" once merged — a single added line, not a
regeneration. Listed as optional so it can be skipped to keep the diff to one file.

---

## 2. Implementation checklist (execute only after approval)

Additive token block, proposed for `:root` in `app/globals.css` (values sourced
verbatim from `.m-*`; comments abbreviated here):

```css
/* ---------- MATERIAL ENGINE 1A — per-depth optical scale (additive) ----------
   Blur + saturation scale with thickness so `depth` is physical, not alpha.
   Sourced from the design language's .m-* classes
   (docs/design-system/Fourth-Meridian-Design-Language-v1.html). Theme-independent
   (optics don't change with light/dark), so one value serves both themes.
   UNCONSUMED on introduction — no primitive references these yet. */
--glass-blur-ultrathin: 16px;
--glass-blur-thin:      28px;
--glass-blur-regular:   40px;
--glass-blur-thick:     60px;

--glass-saturate-ultrathin: 180%;
--glass-saturate-thin:      165%;
--glass-saturate-regular:   150%;
--glass-saturate-thick:     140%;
```

One opt-in utility family (self-contained so a sample surface is testable in
isolation; sets fill + filter only — no border/specular/edge, which is 1B):

```css
/* Opt-in physical-depth glass. New/sample surfaces only; existing surfaces
   keep their current recipe until a separate approved adoption step. */
.atlas-depth-ultrathin { background: var(--glass-ultrathin);
  -webkit-backdrop-filter: blur(var(--glass-blur-ultrathin)) saturate(var(--glass-saturate-ultrathin));
          backdrop-filter: blur(var(--glass-blur-ultrathin)) saturate(var(--glass-saturate-ultrathin)); }
.atlas-depth-thin     { background: var(--glass-thin);
  -webkit-backdrop-filter: blur(var(--glass-blur-thin)) saturate(var(--glass-saturate-thin));
          backdrop-filter: blur(var(--glass-blur-thin)) saturate(var(--glass-saturate-thin)); }
.atlas-depth-regular  { background: var(--glass-regular);
  -webkit-backdrop-filter: blur(var(--glass-blur-regular)) saturate(var(--glass-saturate-regular));
          backdrop-filter: blur(var(--glass-blur-regular)) saturate(var(--glass-saturate-regular)); }
.atlas-depth-thick    { background: var(--glass-thick);
  -webkit-backdrop-filter: blur(var(--glass-blur-thick)) saturate(var(--glass-saturate-thick));
          backdrop-filter: blur(var(--glass-blur-thick)) saturate(var(--glass-saturate-thick)); }
```

Steps:

1. Read `app/globals.css` in full before editing (already reviewed; re-read at
   implementation time per repo rules).
2. Insert the variable block additively — recommended location: immediately after
   the existing `--glass-*` fill tokens in the theme comment region, or in the
   `:root` token area near `--shadow-*`. It must not displace or reorder existing
   tokens.
3. Insert the four `.atlas-depth-*` utilities additively, near the other Atlas
   utility classes (e.g. after `.no-scrollbar` / before `.atlas-field`), so they
   sit with sibling utilities.
4. Do not modify `GlassPanel` or any consumer. Do not add a `floating` value.
5. Confirm the diff is additive-only (no `-` lines except whitespace/anchor).
6. Run the validation plan (§5). Stop.

**Decisions requiring sign-off before execution:**

- **D-1A.1 — Brightness axis.** The doctrine describes depth as "blur +
  saturation **+ brightness**," but the sourced `.m-*` spec has no brightness.
  *Recommendation: exclude brightness from 1A* (keep it fully sourced and minimal);
  introduce a per-depth `--glass-brightness-*` in a later phase if the reconciled
  blur/saturation alone doesn't read as enough tonal compression. Approve, or
  request brightness included.
- **D-1A.2 — `floating` tier.** *Recommendation: defer to 1B* (needs Fresnel edge
  + new fill values). Approve deferral, or request it folded into 1A (which then
  also touches both theme blocks to add `--glass-floating`).
- **D-1A.3 — Ship the opt-in utility, or variables only?** The utility makes 1A
  independently testable/usable; a stricter reading ("variables first, utilities
  in 1B") would ship only the vars. *Recommendation: ship both* — the utility is
  the additive vehicle the doctrine's Phase 1 calls for and is inert until used.

---

## 3. Impact map

| Layer | Change | Blast radius |
|---|---|---|
| `app/globals.css` `:root` | +8 CSS custom properties | None at runtime — unconsumed until referenced. CSS custom properties have no cost when unused. |
| `app/globals.css` utilities | +4 opt-in classes | None until a `className` uses one. No element currently references them. |
| `GlassPanel` / primitives | **none** | Byte-identical. Every card/modal/button renders exactly as today. |
| Consuming components | **none** | Zero. No import, prop, or class changes. |
| Theme blocks (dark/light) | **none** | Untouched (new vars are theme-independent, in `:root`). |
| Build / TS / lint | none of substance | CSS-only, additive; no TS surface, no new deps. |
| Bundle size | +~0.4 KB uncompressed CSS | Negligible. |
| Runtime performance | **unchanged** | No new `backdrop-filter` is *rendered* — the vars/utilities are inert until adopted. The perf-sensitive change (thick→60px blur on modals) happens at the *adoption* step, not here. |

**Downstream (not in 1A, noted for the roadmap):** when a later approved step
re-points `GlassPanel` to these vars, `thin` moves 30px→28px (cheaper, negligible
visual), `regular`→40px, `thick`→60px. Thick modals at 60px full-screen blur on
mid-tier mobile is the one perf watch-item — it will be measured at that step,
under the doctrine's blur budget and ≤2-layer cap. **Phase 1A itself carries none
of that risk** because nothing renders the new values.

---

## 4. Rollback plan

- **Revert = delete the added block.** Because the variables and utilities are
  unconsumed, removing them changes zero rendered surfaces. Rollback is inert.
- Single-file, additive diff → `git revert` of the one commit fully restores the
  prior `globals.css`. No migration, no data, no behaviour to unwind.
- No primitive or component references the new tokens, so there is no dangling
  reference to clean up on revert.
- Kill-switch not required at this phase (nothing renders); the doctrine's
  reduced-transparency fallback remains the global escape hatch for later phases.

---

## 5. Validation plan

CSS-only, additive, unconsumed — validation confirms *inertness* plus token
correctness, not visual change (there is none on existing surfaces).

1. **Build:** `npm run build` (or `next build`) succeeds — confirms the CSS parses
   under the Tailwind v4 `@import "tailwindcss"` pipeline.
2. **Types:** `npx tsc --noEmit` — expected clean (no TS touched; run per repo
   rule). `npx prisma generate` is N/A (no schema change).
3. **Lint:** `npm run lint` — clean (no JS/TS changes).
4. **Additive-diff proof:** `git diff --stat` shows only `app/globals.css`
   changed; `git diff` shows insertions only (no modified/removed existing lines).
5. **Inertness proof:** grep confirms nothing consumes the new names yet —
   `grep -rn "atlas-depth-\|glass-blur-\|glass-saturate-" app components` returns
   only the definitions in `globals.css`, no consumers.
6. **Opt-in smoke test (throwaway, not committed):** temporarily add
   `className="atlas-depth-regular"` to one sample element in a dev build, confirm
   in Chrome that it renders as physical-depth glass (visibly heavier blur than a
   `thin` sibling), then remove it. Optionally spot-check Safari/Firefox for the
   `-webkit-` prefix path. This validates the utility works without committing any
   surface adoption.
7. **Reduced-transparency/motion:** no-op for 1A (no motion, no new rendered
   blur), but confirm the smoke-test surface still respects the existing global
   `prefers-reduced-motion` rule (it will — no animation added).

Pass criteria: build/tsc/lint green, diff additive-only and single-file, zero
consumers, smoke-test surface renders correctly then is removed.

---

## 6. Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Any existing surface changes appearance | Very low | High | Vars/utilities are unconsumed; primitive untouched. Inertness proof (§5.5) gates merge. |
| Perf regression from deeper blur | None in 1A | — | Nothing renders the new blur; the thick→60px cost lands only at the later adoption step, measured then. |
| Scope creep into Fresnel/floating/primitive | Low | Medium | Explicit 1A/1B split (§0); D-1A.1–3 sign-offs bound scope before code. |
| Values drift from the design-language spec | Low | Low | Values copied verbatim from `.m-*`; source cited inline in the added comment. |
| Light-theme divergence | None | — | New vars are theme-independent (optics identical in both themes); no theme block touched. |
| Safari containing-block trap | None in 1A | — | No `filter`/`transform` added to any layout ancestor; utilities apply to the surface itself only, and none are yet applied. |
| Bloated/unreviewable diff | Very low | Low | Single file, ~12 additive lines + comments. |

---

## 7. Sequencing after 1A (context only — not in this scope)

1. **1A** — depth variables + opt-in utility (this doc).
2. **1B** — Fresnel full-perimeter edge utility + `floating` tier.
3. **Primitive re-point (approved separately)** — `GlassPanel` reads
   `--glass-blur-{depth}` / `--glass-saturate-{depth}`; the perf-sensitive step,
   measured on mobile under the blur budget.
4. **Doctrine Phase 2+** — light-angle model, interior bloom, motion, field.

Each remains additive, per-phase-revertible, and approval-gated. **Do not proceed
past 1A without explicit approval; execute only 1A, then stop.**

---

## 8. Summary

Phase 1A adds eight sourced optical variables and four opt-in utility classes to
`app/globals.css` — nothing else. It gives Atlas Glass the *vocabulary* to make
depth physical while leaving every shipping surface byte-identical, carrying no
perf or behaviour risk, and reverting inertly. It is the smallest change that
advances the material engine and unlocks the later primitive re-point where the
visible premium jump actually lands.

**Awaiting approval of this checklist (and decisions D-1A.1–3) before any edit.**
